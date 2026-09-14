import { DurableObject } from "cloudflare:workers";
import { SCHEMA_V1 } from "./schema";

export interface Env {
  PARLIAMENTARY_DISCLOSURES: DurableObjectNamespace<ParliamentaryDisclosures>;
  MUSE_API_KEY?: string;
  ADMIN_SECRET?: string;
}

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
  }

  async status() {
    const disclosures = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) as n FROM disclosures")
      .one().n;
    const sources = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) as n FROM sources")
      .one().n;
    const jobs = this.ctx.storage.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) as n FROM ingestion_jobs WHERE status = 'pending'",
      )
      .one().n;
    return {
      ok: true,
      singleton: "global",
      disclosures,
      sources,
      pending_jobs: jobs,
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

  async enqueueDiscovery(): Promise<{ queued: boolean }> {
    this.ctx.storage.sql.exec(
      `INSERT INTO ingestion_jobs (job_type, status) VALUES ('discover_house', 'pending')`,
    );
    await this.ctx.storage.setAlarm(Date.now() + 1000);
    return { queued: true };
  }

  async alarm(): Promise<void> {
    const jobs = this.ctx.storage.sql
      .exec<{ id: number; job_type: string }>(
        `SELECT id, job_type FROM ingestion_jobs
         WHERE status = 'pending'
         ORDER BY id ASC LIMIT 5`,
      )
      .toArray();
    for (const job of jobs) {
      this.ctx.storage.sql.exec(
        `UPDATE ingestion_jobs SET status = 'running', started_at = datetime('now'), attempts = attempts + 1 WHERE id = ?`,
        job.id,
      );
      // Discovery/parse implemented in follow-up; mark placeholder complete without inventing records.
      this.ctx.storage.sql.exec(
        `UPDATE ingestion_jobs SET status = 'needs_implementation', completed_at = datetime('now'), last_error = 'parser/discovery not yet implemented' WHERE id = ?`,
        job.id,
      );
    }
    const remaining = this.ctx.storage.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) as n FROM ingestion_jobs WHERE status = 'pending'`,
      )
      .one().n;
    if (remaining > 0) await this.ctx.storage.setAlarm(Date.now() + 15_000);
  }
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
