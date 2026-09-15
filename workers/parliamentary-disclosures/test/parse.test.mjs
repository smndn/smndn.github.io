// Unit tests for disclosure-parse.ts (no live Muse, no network).
// Run: node --experimental-strip-types --test test/parse.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateParsedOutput,
  isValidDate,
  parseModelJson,
} from "../src/disclosure-parse.ts";
import { SCHEMA_V1 } from "../src/schema.ts";
import { commitParsedVersion } from "../src/disclosure-parse.ts";

const VALID_DOC = JSON.stringify({
  document: {
    politician_name: "Catherine King",
    chamber: "house",
    parliament: 48,
    document_type: "alteration",
    lodged_date: "2026-09-10",
  },
  disclosures: [
    {
      category: "gifts",
      event_type: "addition",
      subject: "self",
      disclosure_date: "2026-09-10",
      raw_text: "Lifetime Platinum membership of Qantas Chairman's Lounge.",
      page: 3,
      entities: [{ name: "Qantas", type: "airline" }],
      tags: ["aviation", "airline_status", "lifetime_status"],
      aviation: {
        relevant: true,
        type: "airline_status",
        airline: "Qantas",
        status_name: "Lifetime Platinum",
        requested: null,
        cabin_from: null,
        cabin_to: null,
      },
      confidence: 0.98,
    },
    {
      category: "memberships",
      event_type: "initial",
      subject: "self",
      disclosure_date: null,
      raw_text: "NIL",
      page: 1,
      entities: [],
      tags: [],
      aviation: { relevant: false },
      confidence: 0.99,
    },
  ],
});

test("valid doc: ok, exact raw_text, hashes, NIL preserved", async () => {
  const r = await validateParsedOutput(VALID_DOC);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.equal(r.disclosures.length, 2);
  assert.equal(
    r.disclosures[0].raw_text,
    "Lifetime Platinum membership of Qantas Chairman's Lounge.",
  );
  assert.match(r.disclosures[0].raw_text_hash, /^[0-9a-f]{64}$/);
  assert.equal(r.disclosures[1].raw_text, "NIL");
  assert.equal(r.highConfidence, true);
});

test("malformed JSON rejected", async () => {
  const r = await validateParsedOutput("{not json");
  assert.equal(r.ok, false);
  assert.match(r.errors.join(";"), /malformed JSON/);
});

test("unknown category coerced to other_interests", async () => {
  const doc = JSON.parse(VALID_DOC);
  doc.disclosures[0].category = "freebies";
  const r = await validateParsedOutput(JSON.stringify(doc));
  assert.equal(r.ok, true);
  assert.equal(r.disclosures[0].category, "other_interests");
});

test("unknown event_type coerced to unknown", async () => {
  const doc = JSON.parse(VALID_DOC);
  doc.disclosures[0].event_type = "maybe_added";
  const r = await validateParsedOutput(JSON.stringify(doc));
  assert.equal(r.ok, true);
  assert.equal(r.disclosures[0].event_type, "unknown");
});

test("impossible + out-of-range dates rejected", async () => {
  assert.equal(isValidDate("2026-02-30"), false);
  assert.equal(isValidDate("1899-01-01"), false);
  assert.equal(isValidDate("2026-13-01"), false);
  assert.equal(isValidDate("2026-09-10"), true);
  const doc = JSON.parse(VALID_DOC);
  doc.disclosures[0].disclosure_date = "2026-02-30";
  const r = await validateParsedOutput(JSON.stringify(doc));
  assert.equal(r.ok, false);
});

test("empty raw_text rejected when no wording aliases exist", async () => {
  const r = await validateParsedOutput(JSON.stringify({
    document: { politician_name: "X" },
    disclosures: [{ category: "gifts", event_type: "initial", raw_text: "   " }],
  }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(";"), /raw_text/);
});

test("missing politician rejected", async () => {
  const doc = JSON.parse(VALID_DOC);
  delete doc.document.politician_name;
  const r = await validateParsedOutput(JSON.stringify(doc));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(";"), /politician_name/);
});

test("duplicate model outputs deduplicated", async () => {
  const doc = JSON.parse(VALID_DOC);
  doc.disclosures.push(JSON.parse(JSON.stringify(doc.disclosures[0])));
  const r = await validateParsedOutput(JSON.stringify(doc));
  assert.equal(r.ok, true);
  assert.equal(r.disclosures.length, 2);
});

test("low confidence flagged, not failed", async () => {
  const doc = JSON.parse(VALID_DOC);
  doc.disclosures[0].confidence = 0.4;
  const r = await validateParsedOutput(JSON.stringify(doc));
  assert.equal(r.ok, true);
  assert.equal(r.highConfidence, false);
});

test("parseModelJson tolerates code fences", () => {
  const { value, error } = parseModelJson("```json\n" + VALID_DOC + "\n```");
  assert.equal(error, null);
  assert.equal(typeof value, "object");
});

test("commit: transactional insert + FTS + idempotent rerun", async () => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    console.log("skip commit test: node:sqlite unavailable");
    return;
  }
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_V1);
  // Mirror DO SqlStorage.exec semantics: statements execute EAGERLY on exec()
  // (the DO cursor's toArray() only materializes rows), so run everything now
  // and cache the rows. (node:sqlite prepare().all() on BEGIN leaves the
  // handle busy, so route non-row-returning statements through run()/exec().)
  const exec = (sql, ...params) => {
    const head = sql.trim().split(/\s+/)[0].toUpperCase();
    let rows = [];
    if (head === "BEGIN" || head === "COMMIT" || head === "ROLLBACK") {
      db.exec(sql);
    } else if (head === "SELECT" || head === "WITH" || head === "PRAGMA") {
      rows = db.prepare(sql).all(...params);
    } else {
      db.prepare(sql).run(...params);
    }
    return { toArray: () => rows };
  };
  // Seed minimal source chain.
  db.prepare(
    "INSERT INTO politicians (slug, full_name, chamber, first_seen_at, last_seen_at, active) VALUES ('catherine-king','Catherine King','house','2026-09-15','2026-09-15',1)",
  ).run();
  const polId = db.prepare("SELECT last_insert_rowid() as id").get().id;
  db.prepare(
    "INSERT INTO sources (politician_id, parliament, chamber, source_url, first_seen_at, last_seen_at) VALUES (?,48,'house','https://www.aph.gov.au/x.pdf','2026-09-15','2026-09-15')",
  ).run(polId);
  const srcId = db.prepare("SELECT last_insert_rowid() as id").get().id;
  db.prepare(
    "INSERT INTO source_versions (source_id, fetched_at, sha256, parse_status) VALUES (?, '2026-09-15', 'abc', 'parsing')",
  ).run(srcId);
  const svId = db.prepare("SELECT last_insert_rowid() as id").get().id;

  const r = await validateParsedOutput(VALID_DOC);
  assert.equal(r.ok, true);
  const c1 = commitParsedVersion(exec, {
    sourceVersionId: svId,
    politicianId: polId,
    parliament: 48,
    chamber: "house",
    lodgedDate: "2026-09-10",
    disclosures: r.disclosures,
  });
  assert.equal(c1.inserted, 2);
  assert.equal(
    db.prepare("SELECT COUNT(*) as n FROM disclosures").get().n,
    2,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) as n FROM aviation_details").get().n,
    1,
  );
  // FTS search works.
  const fts = db
    .prepare(
      "SELECT COUNT(*) as n FROM disclosures_fts WHERE disclosures_fts MATCH 'Qantas'",
    )
    .get().n;
  assert.equal(fts, 1);

  // Rerun is idempotent: no new rows.
  const c2 = commitParsedVersion(exec, {
    sourceVersionId: svId,
    politicianId: polId,
    parliament: 48,
    chamber: "house",
    lodgedDate: "2026-09-10",
    disclosures: r.disclosures,
  });
  assert.equal(c2.inserted, 0);
  assert.equal(c2.skipped, 2);
  assert.equal(
    db.prepare("SELECT COUNT(*) as n FROM disclosures").get().n,
    2,
  );
  db.close();
});
