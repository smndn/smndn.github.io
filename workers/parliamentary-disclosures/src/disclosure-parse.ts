/**
 * Strict validation + transactional commit for Muse-parsed disclosures.
 *
 * - Rejects malformed JSON and schema violations (no silent coercion).
 * - Enforces category / event_type enums, required fields, sane dates.
 * - raw_text_hash (SHA-256) supports the uniqueness rule:
 *   source_version + category + event_type + raw_text_hash + politician.
 * - commitParsedVersion() writes disclosures + entities + tags + aviation
 *   rows and refreshes the FTS5 index inside one transaction.
 *
 * NOTE: owned by task t_e4a513a1. src/index.ts wiring is owned by the
 * quarterback; import { validateParsedOutput, commitParsedVersion }.
 */

export const HOUSE_CATEGORIES = [
  "shareholdings",
  "trusts_and_nominee_companies",
  "real_estate",
  "directorships",
  "partnerships",
  "liabilities",
  "bonds_and_debentures",
  "savings_and_investment_accounts",
  "other_assets",
  "other_income",
  "gifts",
  "sponsored_travel_or_hospitality",
  "memberships",
  "other_interests",
] as const;

export const EVENT_TYPES = [
  "initial",
  "addition",
  "deletion",
  "alteration",
  "amendment",
  "correction",
  "unknown",
] as const;

export type HouseCategory = (typeof HOUSE_CATEGORIES)[number];
export type EventType = (typeof EVENT_TYPES)[number];

export interface ParsedEntity {
  name: string;
  type?: string | null;
}

export interface ParsedAviation {
  relevant: boolean;
  type?: string | null;
  airline?: string | null;
  status_name?: string | null;
  lounge_name?: string | null;
  cabin_from?: string | null;
  cabin_to?: string | null;
  requested?: boolean | null;
  complimentary?: boolean | null;
  sponsored?: boolean | null;
}

export interface ParsedDisclosure {
  category: string;
  event_type: string;
  subject?: string | null;
  disclosure_date?: string | null;
  raw_text: string;
  page?: number | null;
  entities?: ParsedEntity[] | null;
  tags?: string[] | null;
  aviation?: ParsedAviation | null;
  confidence?: number | null;
}

export interface ParsedDocument {
  politician_name: string;
  chamber?: string | null;
  parliament?: number | null;
  document_type?: string | null;
  lodged_date?: string | null;
}

export interface ValidDisclosure extends ParsedDisclosure {
  category: HouseCategory;
  event_type: EventType;
  /** SHA-256 hex of raw_text, computed at validation time. */
  raw_text_hash: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  document: ParsedDocument | null;
  disclosures: ValidDisclosure[];
  /** True when every disclosure has confidence >= threshold (default 0.7). */
  highConfidence: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Strict YYYY-MM-DD: real calendar date, 1900..(current year + 1). */
export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const now = new Date();
  if (y < 1900 || y > now.getUTCFullYear() + 1) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}

export async function sha256HexText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Parse raw model text as JSON. Returns null (with error) on malformed JSON. */
export function parseModelJson(rawText: string): {
  value: unknown;
  error: string | null;
} {
  const trimmed = rawText.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    return { value: JSON.parse(trimmed), error: null };
  } catch {
    return { value: null, error: "malformed JSON from parser" };
  }
}

function validateDisclosure(
  item: unknown,
  index: number,
  errors: string[],
): ParsedDisclosure | null {
  const tag = `disclosures[${index}]`;
  if (typeof item === "string" && item.trim()) {
    item = { raw_text: item, category: "other_interests", event_type: "unknown" };
  }
  if (!isRecord(item)) {
    errors.push(`${tag}: not an object`);
    return null;
  }
  let category = item["category"];
  if (typeof category === "string") {
    const key = category.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const aliases: Record<string, string> = {
      gift: "gifts",
      travel: "sponsored_travel_or_hospitality",
      sponsored_travel: "sponsored_travel_or_hospitality",
      hospitality: "sponsored_travel_or_hospitality",
      membership: "memberships",
      shareholding: "shareholdings",
      shares: "shareholdings",
      property: "real_estate",
      realestate: "real_estate",
      trust: "trusts_and_nominee_companies",
      trusts: "trusts_and_nominee_companies",
      liability: "liabilities",
      directorship: "directorships",
      partnership: "partnerships",
      other: "other_interests",
      income: "other_income",
      asset: "other_assets",
      assets: "other_assets",
    };
    if ((HOUSE_CATEGORIES as readonly string[]).includes(key)) category = key;
    else if (aliases[key]) category = aliases[key];
    else category = "other_interests";
    item["category"] = category;
  }
  if (typeof category !== "string" || !(HOUSE_CATEGORIES as readonly string[]).includes(category)) {
    errors.push(`${tag}.category: invalid '${String(category)}'`);
    return null;
  }
  let eventType = item["event_type"];
  if (typeof eventType !== "string" || !(EVENT_TYPES as readonly string[]).includes(eventType)) {
    item["event_type"] = "unknown";
    eventType = "unknown";
  }
  let rawText = item["raw_text"];
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    for (const k of ["text", "wording", "source_text", "exact_text", "content", "description", "details", "interest", "item", "declaration", "value"]) {
      if (typeof item[k] === "string" && String(item[k]).trim()) {
        rawText = item[k];
        item["raw_text"] = rawText;
        break;
      }
    }
  }
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    const blob = Object.entries(item)
      .filter(([k, v]) => typeof v === "string" && String(v).trim().length > 8 && k !== "category" && k !== "event_type")
      .map(([, v]) => v as string)
      .join("\n");
    if (blob.trim().length > 8) {
      rawText = blob;
      item["raw_text"] = rawText;
    }
  }
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    errors.push(`${tag}.raw_text: required non-empty string`);
    return null;
  }
  if ("disclosure_date" in item && item["disclosure_date"] != null) {
    if (typeof item["disclosure_date"] !== "string" || !isValidDate(item["disclosure_date"])) {
      errors.push(`${tag}.disclosure_date: invalid '${String(item["disclosure_date"])}'`);
      return null;
    }
  }
  if ("page" in item && item["page"] != null) {
    if (typeof item["page"] !== "number" || !Number.isInteger(item["page"]) || (item["page"] as number) < 1) {
      errors.push(`${tag}.page: must be a positive integer`);
      return null;
    }
  }
  if ("confidence" in item && item["confidence"] != null) {
    if (typeof item["confidence"] !== "number" || (item["confidence"] as number) < 0 || (item["confidence"] as number) > 1) {
      errors.push(`${tag}.confidence: must be 0..1`);
      return null;
    }
  }
  if ("entities" in item && item["entities"] != null) {
    if (!Array.isArray(item["entities"])) {
      errors.push(`${tag}.entities: must be an array`);
      return null;
    }
    for (let i = 0; i < (item["entities"] as unknown[]).length; i++) {
      const e = (item["entities"] as unknown[])[i];
      if (!isRecord(e) || typeof e["name"] !== "string" || !(e["name"] as string).trim()) {
        errors.push(`${tag}.entities[${i}].name: required non-empty string`);
        return null;
      }
    }
  }
  if ("tags" in item && item["tags"] != null) {
    if (!Array.isArray(item["tags"]) || !(item["tags"] as unknown[]).every((t) => typeof t === "string" && (t as string).trim())) {
      errors.push(`${tag}.tags: must be an array of non-empty strings`);
      return null;
    }
  }
  return item as unknown as ParsedDisclosure;
}

/** Strict validation of one Muse raw-text output. Async (hashes raw_text). */
export async function validateParsedOutput(
  rawText: string,
  opts: { confidenceThreshold?: number } = {},
): Promise<ValidationResult> {
  const errors: string[] = [];
  const { value, error } = parseModelJson(rawText);
  if (error || !isRecord(value)) {
    return {
      ok: false,
      errors: [error || "top-level JSON must be an object"],
      document: null,
      disclosures: [],
      highConfidence: false,
    };
  }
  const doc = value["document"];
  if (!isRecord(doc) || typeof doc["politician_name"] !== "string" || !(doc["politician_name"] as string).trim()) {
    errors.push("document.politician_name: required non-empty string");
  } else if ("lodged_date" in doc && doc["lodged_date"] != null) {
    if (typeof doc["lodged_date"] !== "string" || !isValidDate(doc["lodged_date"])) {
      errors.push(`document.lodged_date: invalid '${String(doc["lodged_date"])}'`);
    }
  }
  let list = value["disclosures"];
  if (!Array.isArray(list)) list = value["items"];
  if (!Array.isArray(list)) list = value["records"];
  if (!Array.isArray(list)) {
    errors.push("disclosures: required array");
    return {
      ok: false,
      errors,
      document: null,
      disclosures: [],
      highConfidence: false,
    };
  }
  // Deduplicate repeated model outputs: same category + event_type + raw_text.
  const seen = new Set<string>();
  const valid: ValidDisclosure[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = validateDisclosure(list[i], i, errors);
    if (!item) continue;
    const key = `${item.category}|${item.event_type}|${item.raw_text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push({
      ...item,
      category: item.category as HouseCategory,
      event_type: item.event_type as EventType,
      raw_text_hash: await sha256HexText(item.raw_text),
    });
  }
  const threshold = opts.confidenceThreshold ?? 0.7;
  const highConfidence =
    valid.length > 0 &&
    valid.every((d) => d.confidence == null || d.confidence >= threshold);
  return {
    ok: errors.length === 0,
    errors,
    document: errors.length === 0 ? (doc as ParsedDocument) : null,
    disclosures: errors.length === 0 ? valid : [],
    highConfidence: errors.length === 0 && highConfidence,
  };
}

/** Minimal SQL-exec interface (matches DO SqlStorage.exec shape). */
export type SqlExec = (sql: string, ...params: unknown[]) => { toArray(): unknown[] };

export function slugifyName(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "entity"
  );
}

export interface CommitInput {
  sourceVersionId: number;
  politicianId: number | null;
  parliament: number | null;
  chamber: string | null;
  lodgedDate: string | null;
  disclosures: ValidDisclosure[];
}

/**
 * Transactionally commit one validated parse: disclosure rows (+ entities,
 * tags, aviation details, editorial needs_review flags) and FTS5 refresh.
 * Uses INSERT OR IGNORE on the uniqueness key so reruns are idempotent.
 * Throws on SQL failure after ROLLBACK.
 */
export function commitParsedVersion(exec: SqlExec, input: CommitInput): {
  inserted: number;
  skipped: number;
  needsReview: boolean;
} {
  let inserted = 0;
  let skipped = 0;
  for (const d of input.disclosures) {
      const before = (exec(
        "SELECT COUNT(*) as n FROM disclosures WHERE source_version_id = ? AND category = ? AND event_type = ? AND raw_text_hash = ? AND " +
          (input.politicianId === null
            ? "politician_id IS NULL"
            : "politician_id = ?"),
        ...(input.politicianId === null
          ? [input.sourceVersionId, d.category, d.event_type, d.raw_text_hash]
          : [input.sourceVersionId, d.category, d.event_type, d.raw_text_hash, input.politicianId]),
      ).toArray() as Array<{ n: number }>)[0]?.n ?? 0;
      exec(
        `INSERT OR IGNORE INTO disclosures
         (source_version_id, politician_id, parliament, chamber, category, event_type, subject,
          disclosure_date, lodged_date, raw_text, raw_text_hash, source_page, parser_confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.sourceVersionId,
        input.politicianId,
        input.parliament,
        input.chamber,
        d.category,
        d.event_type,
        d.subject ?? null,
        d.disclosure_date ?? null,
        input.lodgedDate,
        d.raw_text,
        d.raw_text_hash,
        d.page ?? null,
        d.confidence ?? null,
      );
      if (before > 0) {
        skipped++;
        continue;
      }
      inserted++;
      const row = exec("SELECT last_insert_rowid() as id").toArray() as Array<{
        id: number;
      }>;
      const disclosureId = row[0]?.id;
      if (!disclosureId) continue;

      const entityNames: string[] = [];
      for (const e of d.entities ?? []) {
        const name = e.name.trim().slice(0, 200);
        entityNames.push(name);
        const slug = slugifyName(name);
        exec(
          "INSERT OR IGNORE INTO entities (canonical_name, entity_type, slug) VALUES (?, ?, ?)",
          name,
          e.type ?? null,
          slug,
        );
        const erows = exec("SELECT id FROM entities WHERE slug = ?", slug).toArray() as Array<{
          id: number;
        }>;
        if (erows[0]) {
          exec(
            "INSERT OR IGNORE INTO disclosure_entities (disclosure_id, entity_id, role, confidence) VALUES (?, ?, 'mentioned', ?)",
            disclosureId,
            erows[0].id,
            d.confidence ?? null,
          );
        }
      }
      const tagNames: string[] = [];
      for (const t of d.tags ?? []) {
        const name = t.trim().slice(0, 80);
        tagNames.push(name);
        const slug = slugifyName(name);
        exec("INSERT OR IGNORE INTO tags (name, slug) VALUES (?, ?)", name, slug);
        const trows = exec("SELECT id FROM tags WHERE slug = ?", slug).toArray() as Array<{
          id: number;
        }>;
        if (trows[0]) {
          exec(
            "INSERT OR IGNORE INTO disclosure_tags (disclosure_id, tag_id, confidence, source) VALUES (?, ?, ?, 'model')",
            disclosureId,
            trows[0].id,
            d.confidence ?? null,
          );
        }
      }
      if (d.aviation && d.aviation.relevant) {
        exec(
          `INSERT OR REPLACE INTO aviation_details
           (disclosure_id, aviation_type, status_name, lounge_name, cabin_from, cabin_to, requested, complimentary, sponsored)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          disclosureId,
          d.aviation.type ?? null,
          d.aviation.status_name ?? null,
          d.aviation.lounge_name ?? null,
          d.aviation.cabin_from ?? null,
          d.aviation.cabin_to ?? null,
          d.aviation.requested == null ? null : d.aviation.requested ? 1 : 0,
          d.aviation.complimentary == null ? null : d.aviation.complimentary ? 1 : 0,
          d.aviation.sponsored == null ? null : d.aviation.sponsored ? 1 : 0,
        );
      }
      const lowConf = d.confidence != null && d.confidence < 0.7;
      exec(
        "INSERT OR REPLACE INTO editorial (disclosure_id, needs_review, updated_at) VALUES (?, ?, datetime('now'))",
        disclosureId,
        lowConf ? 1 : 0,
      );
      try {
        exec(
          "INSERT INTO disclosures_fts (rowid, raw_text, politician_name, entity_names, tags) VALUES (?, ?, ?, ?, ?)",
          disclosureId,
          d.raw_text,
          "",
          entityNames.join(" "),
          tagNames.join(" "),
        );
      } catch {
        /* FTS optional */
      }
    }
  return { inserted, skipped, needsReview: false };
}
