import { DurableObject } from "cloudflare:workers";
import { extractText } from "unpdf";
import { SCHEMA_V1 } from "./schema";
import { callMuseWithRetry, PARSER_VERSION, SCHEMA_VERSION } from "./muse";
import { commitParsedVersion, validateParsedOutput } from "./disclosure-parse";

export interface Env {
  PARLIAMENTARY_DISCLOSURES: DurableObjectNamespace<ParliamentaryDisclosures>;
  MUSE_API_KEY?: string;
  ADMIN_SECRET?: string;
}

const HOUSE_INDEX_URL =
  "https://www.aph.gov.au/Senators_and_Members/Members/Register";
const APH_ORIGIN = "https://www.aph.gov.au";
const ALLOWED_SOURCE_HOSTS = new Set([
  "www.aph.gov.au",
  "aph.gov.au",
  "static.aph.gov.au",
  "interests-register-api-public.aph.gov.au",
]);
const CURRENT_PARLIAMENT = 48;
const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 1;
const FETCH_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function json(data: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=30",
      ...extra,
    },
  });
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function cleanText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

interface DiscoveredLink {
  url: string;
  title: string;
}

function isMemberStatementUrl(url: string): boolean {
  const u = url.toLowerCase();
  if (u.includes("explanatory") || u.includes("resolutions") || u.includes("9oct1984")) return false;
  return (
    u.includes("interests-register-api-public.aph.gov.au/api/members/") ||
    (u.includes("static.aph.gov.au") && u.includes("/register/") && u.includes(".pdf"))
  );
}

/** House register table: unquoted href= plus static.aph / public statement API. */
export function extractHouseLinks(html: string, base = APH_ORIGIN): DiscoveredLink[] {
  const out: DiscoveredLink[] = [];
  const seen = new Set<string>();
  const rowRe =
    /<td>\s*([^<]+?)\s*<\/td>\s*<td class="format">\s*<a\s+href=([^\s>]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const title = cleanText(m[1] || "").slice(0, 200);
    let href = (m[2] || "").trim().replace(/^['"]|['"]$/g, "");
    if (!href) continue;
    let absolute: string;
    try {
      absolute = new URL(href, base).toString();
    } catch {
      continue;
    }
    let host: string;
    try {
      host = new URL(absolute).host;
    } catch {
      continue;
    }
    if (!ALLOWED_SOURCE_HOSTS.has(host)) continue;
    if (!isMemberStatementUrl(absolute)) continue;
    const key = absolute.split("?")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: absolute, title: title || key });
  }
  return out;
}

function backoffMs(attempts: number): number {
  return Math.min(15_000, 5_000 * Math.pow(2, Math.max(0, attempts - 1)));
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class ParliamentaryDisclosures extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    const current = this.ctx.storage.sql
      .exec<{ version: number }>(
        "SELECT COALESCE(MAX(id), 0) as version FROM _sql_schema_migrations",
      )
      .one().version;
    if (current < 1) {
      this.ctx.storage.sql.exec(SCHEMA_V1);
      this.ctx.storage.sql.exec(
        "INSERT INTO _sql_schema_migrations (id) VALUES (1)",
      );
    }
    if (current < 2) {
      this.ctx.storage.sql.exec(
        `CREATE INDEX IF NOT EXISTS idx_jobs_status_retry ON ingestion_jobs(status, next_retry_at)`,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO _sql_schema_migrations (id) VALUES (2)",
      );
    }
  }

  async status() {
    const q = (sql: string, ...params: unknown[]): number =>
      this.ctx.storage.sql.exec<{ n: number }>(sql, ...(params as never[])).one().n;
    const jobsByStatus = this.ctx.storage.sql
      .exec<{ status: string; n: number }>(
        `SELECT status, COUNT(*) as n FROM ingestion_jobs GROUP BY status`,
      )
      .toArray();
    const recentErrors = this.ctx.storage.sql
      .exec<{ job_type: string; last_error: string | null; status: string }>(
        `SELECT job_type, last_error, status FROM ingestion_jobs WHERE last_error IS NOT NULL ORDER BY id DESC LIMIT 8`,
      )
      .toArray();
    return {
      ok: true,
      singleton: "global",
      disclosures: q("SELECT COUNT(*) as n FROM disclosures"),
      sources: q("SELECT COUNT(*) as n FROM sources"),
      source_versions: q("SELECT COUNT(*) as n FROM source_versions"),
      pending_jobs: q("SELECT COUNT(*) as n FROM ingestion_jobs WHERE status = 'pending'"),
      jobs_by_status: jobsByStatus,
      recent_errors: recentErrors,
      muse_configured: Boolean(this.env.MUSE_API_KEY),
    };
  }

  async search(q: string, limit = 25) {
    const query = q.trim();
    if (!query) return { query, results: [] };
    const rows = this.ctx.storage.sql
      .exec<{
        id: number;
        raw_text: string;
        category: string | null;
        politician_id: number | null;
      }>(
        `SELECT d.id, d.raw_text, d.category, d.politician_id
         FROM disclosures d
         JOIN disclosures_fts fts ON fts.rowid = d.id
         WHERE disclosures_fts MATCH ?
         LIMIT ?`,
        query,
        limit,
      )
      .toArray();
    return { query, results: rows };
  }

  async requeueUnknownParseJobs(): Promise<number> {
    this.ctx.storage.sql.exec(
      `UPDATE ingestion_jobs SET status = 'pending', next_retry_at = NULL
       WHERE status = 'running'`,
    );
    this.ctx.storage.sql.exec(
      `UPDATE ingestion_jobs SET status = 'pending', next_retry_at = NULL
       WHERE job_type = 'parse_version' AND status IN ('failed','pending')`,
    );
    await this.ctx.storage.setAlarm(Date.now() + 500);
    return 1;
  }

  async kickAlarm(): Promise<{ ok: true }> {
    await this.ctx.storage.setAlarm(Date.now() + 300);
    return { ok: true };
  }

  async latest(limit = 20) {
    const lim = Math.min(100, Math.max(1, Number(limit) || 20));
    const rows = this.ctx.storage.sql
      .exec<{
        id: number;
        raw_text: string;
        category: string | null;
        event_type: string | null;
        disclosure_date: string | null;
        politician_id: number | null;
        politician_name: string | null;
        politician_slug: string | null;
        created_at: string;
      }>(
        `SELECT d.id, d.raw_text, d.category, d.event_type, d.disclosure_date,
                d.politician_id, p.full_name as politician_name, p.slug as politician_slug,
                d.created_at
         FROM disclosures d LEFT JOIN politicians p ON p.id = d.politician_id
         ORDER BY d.created_at DESC, d.id DESC LIMIT ?`,
        lim,
      )
      .toArray();
    return { results: rows };
  }

  async aviation(limit = 50) {
    const lim = Math.min(100, Math.max(1, Number(limit) || 50));
    const rows = this.ctx.storage.sql
      .exec<{
        id: number;
        raw_text: string;
        category: string | null;
        event_type: string | null;
        disclosure_date: string | null;
        politician_id: number | null;
        politician_name: string | null;
        politician_slug: string | null;
      }>(
        `SELECT DISTINCT d.id, d.raw_text, d.category, d.event_type, d.disclosure_date,
                d.politician_id, p.full_name as politician_name, p.slug as politician_slug
         FROM disclosures d
         LEFT JOIN politicians p ON p.id = d.politician_id
         LEFT JOIN aviation_details ad ON ad.disclosure_id = d.id
         LEFT JOIN disclosure_tags dt ON dt.disclosure_id = d.id
         LEFT JOIN tags t ON t.id = dt.tag_id
         WHERE d.category = 'aviation' OR ad.disclosure_id IS NOT NULL
            OR t.slug LIKE 'aviat%' OR t.name LIKE '%aviat%'
            OR d.raw_text LIKE '%Qantas%' OR d.raw_text LIKE '%Virgin%'
            OR d.raw_text LIKE '%Chairman%Lounge%' OR d.raw_text LIKE '%upgrade%'
         ORDER BY d.disclosure_date DESC NULLS LAST, d.id DESC LIMIT ?`,
        lim,
      )
      .toArray();
    return { results: rows };
  }

  async getPolitician(slug: string) {
    const pols = this.ctx.storage.sql
      .exec<{
        id: number; slug: string; full_name: string; chamber: string;
        electorate: string | null; state: string | null; party: string | null;
      }>(
        `SELECT id, slug, full_name, chamber, electorate, state, party
         FROM politicians WHERE slug = ? LIMIT 1`,
        slug,
      )
      .toArray();
    if (pols.length === 0) return null;
    const pol = pols[0];
    const disclosures = this.ctx.storage.sql
      .exec<{
        id: number; raw_text: string; category: string | null; event_type: string | null;
        disclosure_date: string | null; lodged_date: string | null; source_page: number | null;
      }>(
        `SELECT id, raw_text, category, event_type, disclosure_date, lodged_date, source_page
         FROM disclosures WHERE politician_id = ?
         ORDER BY disclosure_date DESC NULLS LAST, id DESC LIMIT 200`,
        pol.id,
      )
      .toArray();
    const sources = this.ctx.storage.sql
      .exec<{ source_url: string; source_title: string | null; parliament: number | null; chamber: string; last_seen_at: string }>(
        `SELECT s.source_url, s.source_title, s.parliament, s.chamber, s.last_seen_at
         FROM sources s WHERE s.politician_id = ? ORDER BY s.parliament DESC NULLS LAST LIMIT 20`,
        pol.id,
      )
      .toArray();
    return { politician: pol, disclosures, sources };
  }

  async getEntity(slug: string) {
    const ents = this.ctx.storage.sql
      .exec<{ id: number; canonical_name: string; entity_type: string | null; slug: string }>(
        `SELECT id, canonical_name, entity_type, slug FROM entities WHERE slug = ? LIMIT 1`,
        slug,
      )
      .toArray();
    if (ents.length === 0) return null;
    const ent = ents[0];
    const disclosures = this.ctx.storage.sql
      .exec<{
        id: number; raw_text: string; category: string | null; event_type: string | null;
        disclosure_date: string | null; politician_name: string | null; politician_slug: string | null; role: string | null;
      }>(
        `SELECT d.id, d.raw_text, d.category, d.event_type, d.disclosure_date,
                p.full_name as politician_name, p.slug as politician_slug, de.role
         FROM disclosure_entities de
         JOIN disclosures d ON d.id = de.disclosure_id
         LEFT JOIN politicians p ON p.id = d.politician_id
         WHERE de.entity_id = ? ORDER BY d.disclosure_date DESC NULLS LAST, d.id DESC LIMIT 200`,
        ent.id,
      )
      .toArray();
    const politicians = this.ctx.storage.sql
      .exec<{ politician_name: string | null; politician_slug: string | null; n: number }>(
        `SELECT p.full_name as politician_name, p.slug as politician_slug, COUNT(*) as n
         FROM disclosure_entities de
         JOIN disclosures d ON d.id = de.disclosure_id
         LEFT JOIN politicians p ON p.id = d.politician_id
         WHERE de.entity_id = ? GROUP BY p.id ORDER BY n DESC LIMIT 50`,
        ent.id,
      )
      .toArray();
    return { entity: ent, disclosures, politicians, total: disclosures.length };
  }

  async homeStats() {
    const q = (sql: string, ...params: unknown[]): number =>
      this.ctx.storage.sql.exec<{ n: number }>(sql, ...(params as never[])).one().n;
    return {
      disclosures: q("SELECT COUNT(*) as n FROM disclosures"),
      politicians: q("SELECT COUNT(*) as n FROM politicians"),
      entities: q("SELECT COUNT(*) as n FROM entities"),
      sources: q("SELECT COUNT(*) as n FROM sources"),
    };
  }

  async adminOverview() {
    const recentJobs = this.ctx.storage.sql
      .exec<{ id: number; job_type: string; status: string; attempts: number; last_error: string | null; created_at: string }>(
        `SELECT id, job_type, status, attempts, last_error, created_at
         FROM ingestion_jobs ORDER BY id DESC LIMIT 30`,
      )
      .toArray();
    const failedJobs = this.ctx.storage.sql
      .exec<{ id: number; job_type: string; source_url: string | null; attempts: number; last_error: string | null }>(
        `SELECT id, job_type, source_url, attempts, last_error
         FROM ingestion_jobs WHERE status = 'failed' ORDER BY id DESC LIMIT 30`,
      )
      .toArray();
    const lowConfidence = this.ctx.storage.sql
      .exec<{ id: number; raw_text: string; parser_confidence: number | null; politician_id: number | null }>(
        `SELECT id, substr(raw_text,1,200) as raw_text, parser_confidence, politician_id
         FROM disclosures WHERE parser_confidence IS NOT NULL AND parser_confidence < 0.7
         ORDER BY id DESC LIMIT 30`,
      )
      .toArray();
    const needsReview = this.ctx.storage.sql
      .exec<{ disclosure_id: number; editorial_note: string | null }>(
        `SELECT disclosure_id, editorial_note FROM editorial WHERE needs_review = 1 LIMIT 30`,
      )
      .toArray();
    const status = await this.status();
    return { status, recentJobs, failedJobs, lowConfidence, needsReview };
  }

  async enqueueDiscovery(): Promise<{ queued: boolean; job_id?: number }> {
    const existing = this.ctx.storage.sql
      .exec<{ id: number }>(
        `SELECT id FROM ingestion_jobs WHERE job_type = 'discover_house' AND status IN ('pending','running') ORDER BY id DESC LIMIT 1`,
      )
      .toArray();
    if (existing.length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return { queued: false, job_id: existing[0].id };
    }
    const rows = this.ctx.storage.sql
      .exec<{ id: number }>(
        `INSERT INTO ingestion_jobs (job_type, source_url, status) VALUES ('discover_house', ?, 'pending')`,
        HOUSE_INDEX_URL,
      )
      .toArray();
    void rows;
    const id = this.ctx.storage.sql
      .exec<{ id: number }>(`SELECT last_insert_rowid() as id`)
      .one().id;
    await this.ctx.storage.setAlarm(Date.now() + 1000);
    return { queued: true, job_id: id };
  }

  private upsertSource(link: DiscoveredLink): { sourceId: number; isNew: boolean } {
    const now = new Date().toISOString();
    const name = link.title || link.url;
    const slug = slugify(name) || `member-${Math.abs(hashStr(link.url))}`;
    const existingPol = this.ctx.storage.sql
      .exec<{ id: number }>(`SELECT id FROM politicians WHERE slug = ?`, slug)
      .toArray();
    let politicianId: number;
    if (existingPol.length > 0) {
      politicianId = existingPol[0].id;
      this.ctx.storage.sql.exec(`UPDATE politicians SET last_seen_at = ?, active = 1 WHERE id = ?`, now, politicianId);
    } else {
      this.ctx.storage.sql.exec(
        `INSERT INTO politicians (slug, full_name, chamber, first_seen_at, last_seen_at, active)
         VALUES (?, ?, 'house', ?, ?, 1)`,
        slug, name.slice(0, 200), now, now,
      );
      politicianId = this.ctx.storage.sql.exec<{ id: number }>(`SELECT last_insert_rowid() as id`).one().id;
    }
    const existingSrc = this.ctx.storage.sql
      .exec<{ id: number }>(
        `SELECT id FROM sources WHERE source_url = ? AND parliament = ? AND chamber = 'house'`,
        link.url, CURRENT_PARLIAMENT,
      )
      .toArray();
    if (existingSrc.length > 0) {
      const sourceId = existingSrc[0].id;
      this.ctx.storage.sql.exec(
        `UPDATE sources SET last_seen_at = ?, source_title = COALESCE(?, source_title), politician_id = COALESCE(politician_id, ?) WHERE id = ?`,
        now, link.title || null, politicianId, sourceId,
      );
      return { sourceId, isNew: false };
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO sources (politician_id, parliament, chamber, source_url, source_title, first_seen_at, last_seen_at)
       VALUES (?, ?, 'house', ?, ?, ?, ?)`,
      politicianId, CURRENT_PARLIAMENT, link.url, link.title || null, now, now,
    );
    const sourceId = this.ctx.storage.sql.exec<{ id: number }>(`SELECT last_insert_rowid() as id`).one().id;
    return { sourceId, isNew: true };
  }

  private enqueueFetch(sourceId: number, sourceUrl: string): boolean {
    const existing = this.ctx.storage.sql
      .exec<{ id: number }>(
        `SELECT id FROM ingestion_jobs WHERE job_type = 'fetch_source' AND source_id = ? AND status IN ('pending','running') LIMIT 1`,
        sourceId,
      )
      .toArray();
    if (existing.length > 0) return false;
    this.ctx.storage.sql.exec(
      `INSERT INTO ingestion_jobs (job_type, source_id, source_url, status) VALUES ('fetch_source', ?, ?, 'pending')`,
      sourceId, sourceUrl,
    );
    return true;
  }

  async discoverHouse(): Promise<{ sources_seen: number; sources_new: number; jobs_queued: number }> {
    const res = await fetch(HOUSE_INDEX_URL, {
      headers: { "user-agent": FETCH_UA, accept: "text/html,application/xhtml+xml" },
    });
    if (!res.ok) throw new Error(`house index HTTP ${res.status}`);
    const html = await res.text();
    const links = extractHouseLinks(html, APH_ORIGIN);
    if (links.length === 0) throw new Error("house index parsed 0 official links");
    let sourcesNew = 0;
    let jobsQueued = 0;
    for (const link of links) {
      const { sourceId, isNew } = this.upsertSource(link);
      if (isNew) sourcesNew++;
      if (this.enqueueFetch(sourceId, link.url)) jobsQueued++;
    }
    return { sources_seen: links.length, sources_new: sourcesNew, jobs_queued: jobsQueued };
  }

  async fetchSource(sourceId: number, sourceUrl: string): Promise<{ sha256: string; skipped: boolean }> {
    const res = await fetch(sourceUrl, {
      headers: { "user-agent": FETCH_UA, accept: "application/pdf,*/*" },
    });
    if (!res.ok) throw new Error(`source fetch HTTP ${res.status} for ${sourceUrl}`);
    const etag = res.headers.get("etag");
    const lastModified = res.headers.get("last-modified");
    const bytes = await res.arrayBuffer();
    const head = new Uint8Array(bytes.slice(0, 5));
    const isPdf = String.fromCharCode(...head) === "%PDF-";
    const sha256 = await sha256Hex(bytes);
    const length = bytes.byteLength;
    const fetchedAt = new Date().toISOString();
    const known = this.ctx.storage.sql
      .exec<{ id: number }>(
        `SELECT id FROM source_versions WHERE source_id = ? AND sha256 = ?`,
        sourceId, sha256,
      )
      .toArray();
    this.ctx.storage.sql.exec(`UPDATE sources SET last_seen_at = ? WHERE id = ?`, fetchedAt, sourceId);
    if (known.length > 0) return { sha256, skipped: true };
    this.ctx.storage.sql.exec(
      `INSERT INTO source_versions (source_id, fetched_at, sha256, content_length, http_etag, http_last_modified, parse_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      sourceId, fetchedAt, sha256, length, etag, lastModified, isPdf ? "pending_parse" : "skipped_not_pdf",
    );
    const versionId = this.ctx.storage.sql.exec<{ id: number }>(`SELECT last_insert_rowid() as id`).one().id;
    if (isPdf) {
      this.ctx.storage.sql.exec(
        `INSERT INTO ingestion_jobs (job_type, source_id, source_url, status) VALUES ('parse_version', ?, ?, 'pending')`,
        sourceId, `${sourceUrl}#v=${versionId}`,
      );
    }
    return { sha256, skipped: !isPdf };
  }

  async parseVersion(sourceId: number, sourceUrl: string): Promise<{ status: string; count: number }> {
    const key = this.env.MUSE_API_KEY;
    if (!key) throw new Error("MUSE_API_KEY missing");
    const versionMatch = sourceUrl.match(/#v=(\d+)/);
    const versionId = versionMatch ? Number(versionMatch[1]) : this.ctx.storage.sql
      .exec<{ id: number }>(`SELECT id FROM source_versions WHERE source_id = ? ORDER BY id DESC LIMIT 1`, sourceId)
      .one().id;
    const src = this.ctx.storage.sql
      .exec<{ source_url: string; politician_id: number | null; parliament: number | null; chamber: string | null }>(
        `SELECT source_url, politician_id, parliament, chamber FROM sources WHERE id = ?`,
        sourceId,
      )
      .one();
    const pol = src.politician_id
      ? this.ctx.storage.sql.exec<{ full_name: string }>(`SELECT full_name FROM politicians WHERE id = ?`, src.politician_id).one()
      : { full_name: "unknown" };
    const existing = this.ctx.storage.sql
      .exec<{ parse_status: string }>(`SELECT parse_status FROM source_versions WHERE id = ?`, versionId)
      .one();
    if (existing.parse_status === "success" || existing.parse_status === "success_needs_review") {
      return { status: existing.parse_status, count: 0 };
    }
    if (!isMemberStatementUrl(src.source_url)) {
      this.ctx.storage.sql.exec(
        `UPDATE source_versions SET parse_status = 'skipped_not_pdf' WHERE id = ?`,
        versionId,
      );
      return { status: "skipped_not_pdf", count: 0 };
    }
    const res = await fetch(src.source_url, {
      headers: { "user-agent": FETCH_UA, accept: "application/pdf,*/*" },
    });
    if (!res.ok) throw new Error(`parse refetch HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    const started = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO parser_runs (source_version_id, model, parser_version, schema_version, started_at, status, input_kind)
       VALUES (?, 'muse-spark-1.3-contributor', ?, ?, ?, 'parsing', 'direct_pdf_model')`,
      versionId, PARSER_VERSION, SCHEMA_VERSION, started,
    );
    const runId = this.ctx.storage.sql.exec<{ id: number }>(`SELECT last_insert_rowid() as id`).one().id;
    const meta = {
      politicianName: pol.full_name,
      chamber: src.chamber || "house",
      parliament: src.parliament || CURRENT_PARLIAMENT,
      sourceUrl: src.source_url,
    };
    const isJsonish = (raw: string) => {
      try {
        const v = JSON.parse(raw);
        return v && typeof v === "object" && Array.isArray(v.disclosures);
      } catch {
        return false;
      }
    };
    let museOut;
    let extractionMethod: "direct_pdf_model" | "embedded_pdf_text" = "embedded_pdf_text";
    let text = "";
    try {
      const extracted = await extractText(new Uint8Array(bytes));
      const raw = (extracted as { text?: unknown }).text;
      text = Array.isArray(raw) ? raw.join("\n") : String(raw ?? "");
    } catch {
      text = extractEmbeddedPdfText(bytes);
    }
    text = text.replace(/\u0000/g, " ").replace(/[ \t]+\n/g, "\n").trim();
    if (text.length < 80) {
      throw new Error(`embedded PDF text too short (${text.length} chars)`);
    }
    text = text.slice(0, 80_000);
    museOut = await callMuseWithRetry(key, { text, extractionMethod }, meta, isJsonish);
    let rawForValidate = museOut.rawText;
    try {
      const obj = JSON.parse(rawForValidate) as Record<string, unknown>;
      const doc =
        obj.document && typeof obj.document === "object"
          ? { ...(obj.document as Record<string, unknown>) }
          : {};
      if (!doc.politician_name || String(doc.politician_name).trim() === "") {
        doc.politician_name = pol.full_name;
      }
      obj.document = doc;
      rawForValidate = JSON.stringify(obj);
    } catch {
      /* validateParsedOutput will reject */
    }
    const validated = await validateParsedOutput(rawForValidate);
    if (!validated.ok || !validated.document) {
      throw new Error(`validation failed: ${validated.errors.join("; ")}`);
    }
    if (validated.disclosures.length === 0) {
      throw new Error(`validation failed: no disclosure items :: ${rawForValidate.slice(0, 400)}`);
    }
    const exec = (sql: string, ...params: unknown[]) => this.ctx.storage.sql.exec(sql, ...params);
    const committed = this.ctx.storage.transactionSync(() =>
      commitParsedVersion(exec, {
        sourceVersionId: versionId,
        politicianId: src.politician_id,
        parliament: src.parliament,
        chamber: src.chamber,
        lodgedDate: validated.document.lodged_date ?? null,
        disclosures: validated.disclosures,
      }),
    );
    const parseStatus = committed.needsReview || !validated.highConfidence ? "success_needs_review" : "success";
    this.ctx.storage.sql.exec(
      `UPDATE parser_runs SET completed_at = datetime('now'), status = ? WHERE id = ?`,
      parseStatus, runId,
    );
    this.ctx.storage.sql.exec(
      `UPDATE source_versions SET parse_status = ?, parse_confidence = ?, disclosure_count = ?, extraction_method = ?,
        model = ?, model_version = ?, parser_version = ?, schema_version = ?, error_summary = NULL WHERE id = ?`,
      parseStatus, validated.highConfidence ? 0.9 : 0.5, committed.inserted, extractionMethod, museOut.modelVersion, museOut.modelVersion, PARSER_VERSION, SCHEMA_VERSION, versionId,
    );
    return { status: parseStatus, count: committed.inserted };
  }

  private failOrRetry(jobId: number, attempts: number, err: string) {
    if (attempts >= MAX_ATTEMPTS) {
      this.ctx.storage.sql.exec(
        `UPDATE ingestion_jobs SET status = 'failed', completed_at = datetime('now'), last_error = ? WHERE id = ?`,
        String(err).slice(0, 1000), jobId,
      );
    } else {
      const next = new Date(Date.now() + backoffMs(attempts)).toISOString();
      this.ctx.storage.sql.exec(
        `UPDATE ingestion_jobs SET status = 'pending', next_retry_at = ?, last_error = ? WHERE id = ?`,
        next, String(err).slice(0, 1000), jobId,
      );
    }
  }

  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE ingestion_jobs SET status = 'pending', next_retry_at = NULL
       WHERE status = 'running' AND (started_at IS NULL OR started_at < datetime('now', '-90 seconds'))`,
    );
    const now = new Date().toISOString();
    const jobs = this.ctx.storage.sql
      .exec<{ id: number; job_type: string; source_id: number | null; source_url: string | null; attempts: number }>(
        `SELECT id, job_type, source_id, source_url, attempts FROM ingestion_jobs
         WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY CASE job_type WHEN 'parse_version' THEN 0 WHEN 'fetch_source' THEN 1 ELSE 2 END, id ASC
         LIMIT ?`,
        now, BATCH_SIZE,
      )
      .toArray();
    for (const job of jobs) {
      this.ctx.storage.sql.exec(
        `UPDATE ingestion_jobs SET status = 'running', started_at = datetime('now'), attempts = attempts + 1 WHERE id = ?`,
        job.id,
      );
      const attempts = job.attempts + 1;
      try {
        if (job.job_type === "discover_house") {
          const r = await this.discoverHouse();
          this.ctx.storage.sql.exec(
            `UPDATE ingestion_jobs SET status = 'completed', completed_at = datetime('now'), last_error = NULL WHERE id = ?`,
            job.id,
          );
          void r;
        } else if (job.job_type === "fetch_source" && job.source_id && job.source_url) {
          const r = await this.fetchSource(job.source_id, job.source_url);
          this.ctx.storage.sql.exec(
            `UPDATE ingestion_jobs SET status = 'completed', completed_at = datetime('now'), last_error = ? WHERE id = ?`,
            r.skipped ? "skipped_duplicate_version" : null, job.id,
          );
        } else if (job.job_type === "parse_version" && job.source_id && job.source_url) {
          const r = await this.parseVersion(job.source_id, job.source_url);
          this.ctx.storage.sql.exec(
            `UPDATE ingestion_jobs SET status = 'completed', completed_at = datetime('now'), last_error = ? WHERE id = ?`,
            `${r.status}:${r.count}`, job.id,
          );
        } else {
          this.ctx.storage.sql.exec(
            `UPDATE ingestion_jobs SET status = 'failed', completed_at = datetime('now'), last_error = ? WHERE id = ?`,
            `unknown job_type ${job.job_type}`, job.id,
          );
        }
      } catch (err) {
        this.failOrRetry(job.id, attempts, err instanceof Error ? err.message : String(err));
      }
    }
    const remaining = this.ctx.storage.sql
      .exec<{ n: number; next_at: string | null }>(
        `SELECT COUNT(*) as n, MIN(next_retry_at) as next_at FROM ingestion_jobs WHERE status = 'pending'`,
      )
      .one();
    if (remaining.n > 0) {
      const delay = remaining.next_at
        ? Math.max(1000, Math.min(15 * 60 * 1000, new Date(remaining.next_at).getTime() - Date.now()))
        : 15_000;
      await this.ctx.storage.setAlarm(Date.now() + (Number.isFinite(delay) ? delay : 15_000));
    }
  }
}

function extractEmbeddedPdfText(bytes: ArrayBuffer): string {
  const raw = new TextDecoder("latin1").decode(bytes);
  const out: string[] = [];
  const re = /\((?:\\.|[^\\)]){2,}\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const t = m[0]
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "")
      .replace(/\\\(/g, "(")
      .replace(/\\\)/g, ")")
      .replace(/\\\\/g, "\\");
    if (/[A-Za-z]{3}/.test(t)) out.push(t);
  }
  return out.join("\n").slice(0, 180_000);
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

function adminOk(request: Request, env: Env, url?: URL): boolean {
  const secret = env.ADMIN_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") || "";
  if (header === `Bearer ${secret}`) return true;
  if (url && url.searchParams.get("key") === secret) return true;
  return false;
}

function esc(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const BASE_CSS =
  "body{font-family:-apple-system,system-ui,Georgia,serif;max-width:44rem;margin:0 auto;padding:2rem 1rem;color:#1a1a1a;background:#fafaf8;line-height:1.55}" +
  "a{color:#1a3a6b}header nav a{margin-right:1rem;font-size:.9rem}" +
  ".disc{border-top:1px solid #ddd;padding:.9rem 0}blockquote{margin:.4rem 0;padding:.2rem .8rem;border-left:3px solid #999;color:#222}" +
  ".meta{font-size:.82rem;color:#555}.tag{display:inline-block;font-size:.75rem;background:#eee;border-radius:3px;padding:0 .4rem;margin-right:.3rem}" +
  "form.search{margin:1.2rem 0}input[type=search]{width:70%;padding:.5rem;font-size:1rem}button{padding:.5rem .9rem}" +
  "footer{margin-top:3rem;font-size:.8rem;color:#666;border-top:1px solid #ddd;padding-top:1rem}";

function layout(title: string, body: string, desc?: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)} · Parliamentary disclosures</title>` +
    (desc ? `<meta name="description" content="${esc(desc)}">` : "") +
    `<style>${BASE_CSS}</style></head><body>` +
    `<header><nav><a href="/parliamentary-disclosures">Home</a><a href="/parliamentary-disclosures/aviation">Aviation</a><a href="/parliamentary-disclosures/methodology">Methodology</a></nav></header>` +
    body +
    `<footer><p>A searchable index of Australian federal parliamentary disclosures. Parliament of Australia remains the authoritative source. Classifications are derived and may contain errors — always check the original source.</p></footer>` +
    `</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });
}

interface DiscRow {
  id: number;
  raw_text: string;
  category?: string | null;
  event_type?: string | null;
  disclosure_date?: string | null;
  politician_name?: string | null;
  politician_slug?: string | null;
}

function discCard(d: DiscRow): string {
  const who = d.politician_slug
    ? `<a href="/parliamentary-disclosures/${esc(d.politician_slug)}">${esc(d.politician_name || d.politician_slug)}</a>`
    : esc(d.politician_name || "");
  return `<div class="disc"><div class="meta">${who}${d.disclosure_date ? ` · declared ${esc(d.disclosure_date)}` : ""}` +
    `${d.category ? ` · <span class="tag">${esc(d.category)}</span>` : ""}${d.event_type ? ` <span class="tag">${esc(d.event_type)}</span>` : ""}</div>` +
    `<blockquote>${esc(d.raw_text)}</blockquote></div>`;
}

const METHODOLOGY_BODY = `<h1>Methodology</h1>
<p>This site is a searchable index of Australian federal parliamentary disclosures. Parliament of Australia remains the authoritative source.</p>
<ul>
<li>Records are derived from official Parliament of Australia disclosure documents.</li>
<li>Source files are fetched and parsed but not archived by this site.</li>
<li>Exact disclosure wording is retained in structured records.</li>
<li>AI is used to structure and classify records; classifications are separate from official source wording.</li>
<li>Errors are possible — consult the original Parliamentary source via the “View original source” link.</li>
<li>Additions and deletions are preserved as events; derived current-state views may contain interpretation.</li>
<li>Blank, NIL, Not Applicable and unknown are treated differently.</li>
</ul>`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/parliamentary-disclosures/, "") || "/";
    const stub = env.PARLIAMENTARY_DISCLOSURES.getByName("global");

    if (path === "/api/health" || path === "/api/parliamentary-disclosures/health") {
      const st = await stub.status();
      if (st.sources < 50 && st.pending_jobs === 0) {
        await stub.enqueueDiscovery();
      }
      await stub.kickAlarm();
      return json(await stub.status());
    }
    if (path === "/api/parliamentary-disclosures/search" || path === "/api/search") {
      const q = url.searchParams.get("q") || "";
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 25));
      return json(await stub.search(q, limit));
    }
    if (path === "/api/parliamentary-disclosures/latest" || path === "/api/latest") {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 20));
      return json(await stub.latest(limit));
    }
    if (path === "/api/parliamentary-disclosures/aviation" || path === "/api/aviation") {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      return json(await stub.aviation(limit));
    }
    {
      const m = path.match(/^\/api\/(?:parliamentary-disclosures\/)?politicians\/([a-z0-9-]+)\/?$/);
      if (m) {
        const data = await stub.getPolitician(m[1]);
        if (!data) return json({ error: "not_found" }, 404);
        return json(data);
      }
    }
    {
      const m = path.match(/^\/api\/(?:parliamentary-disclosures\/)?entities\/([a-z0-9-]+)\/?$/);
      if (m) {
        const data = await stub.getEntity(m[1]);
        if (!data) return json({ error: "not_found" }, 404);
        return json(data);
      }
    }
    if (path.startsWith("/api/admin/")) {
      if (!adminOk(request, env, url)) return json({ error: "unauthorized" }, 401);
      if (path.endsWith("/discover") && request.method === "POST") {
        return json(await stub.enqueueDiscovery());
      }
      if (path.endsWith("/overview")) {
        return json(await stub.adminOverview());
      }
      return json({ error: "not_found" }, 404);
    }
    // ---- Public HTML ----
    if (path === "/methodology" || path === "/methodology/") {
      return layout("Methodology", METHODOLOGY_BODY,
        "How this searchable index of Australian federal parliamentary disclosures is built.");
    }
    if (path === "/aviation" || path === "/aviation/") {
      const { results } = await stub.aviation(50);
      const cards = results.length > 0
        ? results.map(discCard).join("")
        : "<p>No aviation disclosures recorded yet. Parliament of Australia remains the authoritative source.</p>";
      return layout("Aviation", `<h1>Aviation disclosures</h1>` +
        `<p>Flight upgrades, lounge memberships, airline status and sponsored travel as listed in official disclosures. Wording below is the exact disclosure text.</p>${cards}`,
        "Aviation-related disclosures listed by Australian federal parliamentarians.");
    }
    if (path === "/search" || url.searchParams.has("q")) {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) {
        return layout("Search", `<h1>Search disclosures</h1>` +
          `<form class="search" action="/parliamentary-disclosures/search" method="get"><input type="search" name="q" placeholder="Qantas, upgrade, lounge…" aria-label="Search disclosures"><button type="submit">Search</button></form>`);
      }
      const { results } = await stub.search(q, 50);
      const cards = results.length > 0 ? results.map(discCard).join("") : `<p>No results recorded for “${esc(q)}”.</p>`;
      return layout(`Search: ${q}`, `<h1>Disclosures matching “${esc(q)}”</h1>` +
        `<form class="search" action="/parliamentary-disclosures/search" method="get"><input type="search" name="q" value="${esc(q)}" aria-label="Search disclosures"><button type="submit">Search</button></form>${cards}`);
    }
    {
      const m = path.match(/^\/entities\/([a-z0-9-]+)\/?$/);
      if (m) {
        const data = await stub.getEntity(m[1]);
        if (!data) return layout("Not found", `<h1>Not found</h1><p>No entity recorded under “${esc(m[1])}”.</p>`);
        const cards = data.disclosures.length > 0
          ? data.disclosures.map(discCard).join("")
          : "<p>No disclosures recorded for this entity yet.</p>";
        const people = data.politicians.map((p: { politician_name: string | null; politician_slug: string | null; n: number }) =>
          p.politician_slug ? `<li><a href="/parliamentary-disclosures/${esc(p.politician_slug)}">${esc(p.politician_name || p.politician_slug)}</a> (${p.n})</li>` : "").join("");
        return layout(data.entity.canonical_name, `<h1>${esc(data.entity.canonical_name)}</h1>` +
          `<p class="meta">${esc(data.entity.entity_type || "entity")} · disclosed in ${data.total} record${data.total === 1 ? "" : "s"}</p>` +
          (people ? `<h2>Politicians involved</h2><ul>${people}</ul>` : "") +
          `<h2>Disclosures</h2>${cards}`);
      }
    }
    if (path === "/admin" || path === "/admin/") {
      if (!env.ADMIN_SECRET) return layout("Not found", `<h1>Not found</h1>`, undefined);
      if (!adminOk(request, env, url)) return new Response("unauthorized", { status: 401 });
      const ov = await stub.adminOverview();
      const s = ov.status as { disclosures: number; sources: number; pending_jobs: number; muse_configured: boolean };
      const jobRows = (ov.recentJobs as { id: number; job_type: string; status: string; attempts: number; last_error: string | null }[])
        .map((j) => `<li>#${j.id} ${esc(j.job_type)} · ${esc(j.status)} · attempts ${j.attempts}${j.last_error ? ` · ${esc(j.last_error)}` : ""}</li>`).join("");
      const lowRows = (ov.lowConfidence as { id: number; raw_text: string; parser_confidence: number | null }[])
        .map((d) => `<li>#${d.id} (${d.parser_confidence}) ${esc(d.raw_text)}</li>`).join("");
      return layout("Admin", `<h1>Admin</h1>` +
        `<p class="meta">${s.disclosures} disclosures · ${s.sources} sources · ${s.pending_jobs} pending jobs · parser ${s.muse_configured ? "configured" : "not configured"}</p>` +
        `<form action="/parliamentary-disclosures/api/admin/discover?key=${esc(url.searchParams.get("key") || "")}" method="post"><button type="submit">Queue House discovery</button></form>` +
        `<h2>Recent jobs</h2><ul>${jobRows || "<li>None</li>"}</ul>` +
        `<h2>Failed jobs</h2><ul>${(ov.failedJobs as { id: number; job_type: string; last_error: string | null }[]).map((j) => `<li>#${j.id} ${esc(j.job_type)} · ${esc(j.last_error || "")}</li>`).join("") || "<li>None</li>"}</ul>` +
        `<h2>Low confidence</h2><ul>${lowRows || "<li>None</li>"}</ul>`);
    }
    {
      // Politician page: /:slug (single path segment). Must come after specific routes.
      const m = path.match(/^\/([a-z0-9-]{2,80})\/?$/);
      if (m && !["api", "admin", "search", "aviation", "methodology", "entities", "favicon.ico"].includes(m[1])) {
        const data = await stub.getPolitician(m[1]);
        if (!data) return layout("Not found", `<h1>Not found</h1><p>No disclosures recorded for “${esc(m[1])}”.</p>`);
        const p = data.politician as { full_name: string; chamber: string; electorate: string | null; state: string | null; party: string | null };
        const cards = (data.disclosures as DiscRow[]).length > 0
          ? (data.disclosures as DiscRow[]).map((d) => discCard({ ...d, politician_name: p.full_name, politician_slug: m[1] })).join("")
          : "<p>No disclosures recorded yet.</p>";
        const srcLinks = (data.sources as { source_url: string; source_title: string | null; last_seen_at: string }[])
          .map((s) => `<li><a href="${esc(s.source_url)}">View original source</a>${s.source_title ? ` — ${esc(s.source_title)}` : ""} <span class="meta">(accessed ${esc(s.last_seen_at)})</span></li>`).join("");
        return layout(p.full_name, `<h1>${esc(p.full_name)}</h1>` +
          `<p class="meta">${esc(p.chamber)}${p.electorate ? ` · ${esc(p.electorate)}` : ""}${p.state ? ` · ${esc(p.state)}` : ""}${p.party ? ` · ${esc(p.party)}` : ""}</p>` +
          `<h2>Disclosures</h2>${cards}` +
          (srcLinks ? `<h2>Sources</h2><ul>${srcLinks}</ul><p class="meta">Parliament of Australia remains the authoritative source.</p>` : ""));
      }
    }
    if (path === "/" || path === "") {
      const [stats, latest] = await Promise.all([stub.homeStats(), stub.latest(10)]);
      const s = stats as { disclosures: number; politicians: number; entities: number; sources: number };
      const cards = (latest.results as DiscRow[]).map(discCard).join("");
      return layout("Parliamentary disclosures",
        `<h1>Parliamentary disclosures</h1>` +
        `<p>A searchable index of Australian federal parliamentary disclosures. Parliament of Australia remains the authoritative source.</p>` +
        `<form class="search" action="/parliamentary-disclosures/search" method="get"><input type="search" name="q" placeholder="Qantas, upgrade, lounge…" aria-label="Search disclosures"><button type="submit">Search</button></form>` +
        `<p class="meta">${s.disclosures} disclosures · ${s.politicians} politicians · ${s.entities} entities · ${s.sources} sources</p>` +
        `<p><a href="/parliamentary-disclosures/aviation">Aviation disclosures</a> · <a href="/parliamentary-disclosures/methodology">Methodology</a></p>` +
        `<h2>Latest disclosures</h2>${cards || "<p>No disclosures recorded yet.</p>"}`,
        "A searchable index of Australian federal parliamentary disclosures.");
    }
    return json({ error: "not_found" }, 404);
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const stub = env.PARLIAMENTARY_DISCLOSURES.getByName("global");
    await stub.enqueueDiscovery();
  },
};
