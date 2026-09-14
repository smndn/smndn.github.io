import { DurableObject } from "cloudflare:workers";
import { SCHEMA_V1 } from "./schema";
import { callMuseWithRetry, PARSER_VERSION, SCHEMA_VERSION } from "./muse";
import { commitParsedVersion, validateParsedOutput } from "./disclosure-parse";

export interface Env {
  PARLIAMENTARY_DISCLOSURES: DurableObjectNamespace<ParliamentaryDisclosures>;
  MUSE_API_KEY?: string;
  ADMIN_SECRET?: string;
}

const HOUSE_INDEX_URL = "https://www.aph.gov.au/register";
const APH_ORIGIN = "https://www.aph.gov.au";
const CURRENT_PARLIAMENT = 48;
const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 5;
const FETCH_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 simondean.xyz-parliamentary-disclosures/1.0";

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

/** Extract official APH document links from register index HTML. */
export function extractHouseLinks(html: string, base = APH_ORIGIN): DiscoveredLink[] {
  const out: DiscoveredLink[] = [];
  const seen = new Set<string>();
  const re = /<a\s+[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let href = (m[1] || "").trim();
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("javascript:")) continue;
    let absolute: string;
    try {
      absolute = new URL(href, base).toString();
    } catch {
      continue;
    }
    if (!absolute.startsWith(APH_ORIGIN)) continue;
    const lower = absolute.toLowerCase();
    const looksOfficial =
      lower.endsWith(".pdf") ||
      lower.includes("register") ||
      lower.includes("interest") ||
      lower.includes("statement") ||
      lower.includes("declaration") ||
      lower.includes("members-interest") ||
      lower.includes("members_interests");
    if (!looksOfficial) continue;
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    const title = cleanText(m[2] || "").slice(0, 200);
    out.push({ url: absolute, title });
  }
  return out;
}

function backoffMs(attempts: number): number {
  return Math.min(60 * 60 * 1000, 30_000 * Math.pow(2, Math.max(0, attempts - 1)));
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
    return {
      ok: true,
      singleton: "global",
      disclosures: q("SELECT COUNT(*) as n FROM disclosures"),
      sources: q("SELECT COUNT(*) as n FROM sources"),
      source_versions: q("SELECT COUNT(*) as n FROM source_versions"),
      pending_jobs: q("SELECT COUNT(*) as n FROM ingestion_jobs WHERE status = 'pending'"),
      jobs_by_status: jobsByStatus,
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
    // Bytes intentionally discarded after hashing; parse happens in a later job.
    this.ctx.storage.sql.exec(
      `INSERT INTO source_versions (source_id, fetched_at, sha256, content_length, http_etag, http_last_modified, parse_status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending_parse')`,
      sourceId, fetchedAt, sha256, length, etag, lastModified,
    );
    const versionId = this.ctx.storage.sql.exec<{ id: number }>(`SELECT last_insert_rowid() as id`).one().id;
    this.ctx.storage.sql.exec(
      `INSERT INTO ingestion_jobs (job_type, source_id, source_url, status) VALUES ('parse_version', ?, ?, 'pending')`,
      sourceId, `${sourceUrl}#v=${versionId}`,
    );
    return { sha256, skipped: false };
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
    const museOut = await callMuseWithRetry(
      key,
      { pdfBytes: bytes, pdfFilename: "source.pdf", extractionMethod: "direct_pdf_model" },
      {
        politicianName: pol.full_name,
        chamber: src.chamber || "house",
        parliament: src.parliament || CURRENT_PARLIAMENT,
        sourceUrl: src.source_url,
      },
      (raw) => {
        // sync pre-check: must be JSON object; full validation happens after
        try {
          const v = JSON.parse(raw);
          return v && typeof v === "object" && Array.isArray(v.disclosures);
        } catch {
          return false;
        }
      },
    );
    const validated = await validateParsedOutput(museOut.rawText);
    if (!validated.ok || !validated.document) {
      this.ctx.storage.sql.exec(
        `UPDATE parser_runs SET completed_at = datetime('now'), status = 'failed_validation', error_summary = ? WHERE id = ?`,
        validated.errors.join("; ").slice(0, 1000), runId,
      );
      this.ctx.storage.sql.exec(
        `UPDATE source_versions SET parse_status = 'failed_validation', error_summary = ?, model = ?, parser_version = ?, schema_version = ? WHERE id = ?`,
        validated.errors.join("; ").slice(0, 1000), museOut.modelVersion, PARSER_VERSION, SCHEMA_VERSION, versionId,
      );
      throw new Error(`validation failed: ${validated.errors.join("; ")}`);
    }
    const exec = (sql: string, ...params: unknown[]) => this.ctx.storage.sql.exec(sql, ...params);
    const committed = commitParsedVersion(exec, {
      sourceVersionId: versionId,
      politicianId: src.politician_id,
      parliament: src.parliament,
      chamber: src.chamber,
      lodgedDate: validated.document.lodged_date ?? null,
      disclosures: validated.disclosures,
    });
    const parseStatus = committed.needsReview || !validated.highConfidence ? "success_needs_review" : "success";
    this.ctx.storage.sql.exec(
      `UPDATE parser_runs SET completed_at = datetime('now'), status = ? WHERE id = ?`,
      parseStatus, runId,
    );
    this.ctx.storage.sql.exec(
      `UPDATE source_versions SET parse_status = ?, parse_confidence = ?, disclosure_count = ?, extraction_method = 'direct_pdf_model',
        model = ?, model_version = ?, parser_version = ?, schema_version = ?, error_summary = NULL WHERE id = ?`,
      parseStatus, validated.highConfidence ? 0.9 : 0.5, committed.inserted, museOut.modelVersion, museOut.modelVersion, PARSER_VERSION, SCHEMA_VERSION, versionId,
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
    const now = new Date().toISOString();
    const jobs = this.ctx.storage.sql
      .exec<{ id: number; job_type: string; source_id: number | null; source_url: string | null; attempts: number }>(
        `SELECT id, job_type, source_id, source_url, attempts FROM ingestion_jobs
         WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY id ASC LIMIT ?`,
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

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

function adminOk(request: Request, env: Env): boolean {
  const secret = env.ADMIN_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") || "";
  return header === `Bearer ${secret}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/parliamentary-disclosures/, "") || "/";
    const stub = env.PARLIAMENTARY_DISCLOSURES.getByName("global");

    if (path === "/api/health" || path === "/api/parliamentary-disclosures/health") {
      const st = await stub.status();
      if (st.sources === 0 && st.pending_jobs === 0) {
        await stub.enqueueDiscovery();
      }
      return json(await stub.status());
    }
    if (path === "/api/parliamentary-disclosures/search" || path === "/api/search") {
      const q = url.searchParams.get("q") || "";
      return json(await stub.search(q));
    }
    if (path.startsWith("/api/admin/")) {
      if (!adminOk(request, env)) return json({ error: "unauthorized" }, 401);
      if (path.endsWith("/discover") && request.method === "POST") {
        return json(await stub.enqueueDiscovery());
      }
      return json({ error: "not_found" }, 404);
    }
    if (path === "/" || path === "") {
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>Parliamentary disclosures</title>
<style>body{font-family:system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#111;background:#fafafa}a{color:#111}</style>
<h1>Parliamentary disclosures</h1>
<p>Searchable index of Australian federal parliamentary disclosures. Parliament of Australia remains the authoritative source.</p>
<p><a href="/parliamentary-disclosures/methodology">Methodology</a></p>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    return json({ error: "not_found" }, 404);
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const stub = env.PARLIAMENTARY_DISCLOSURES.getByName("global");
    await stub.enqueueDiscovery();
  },
};
