/**
 * Deterministic House of Representatives interests-form extractor.
 *
 * Muse Spark 1.3 Contributor currently echoes the prompt header and returns
 * disclosures:[]. The 48th Parliament House form is a stable 14-item layout,
 * so we copy exact source wording from unpdf text instead of inventing it.
 * Muse remains the fallback for documents that do not match this form.
 */

import type {
  EventType,
  HouseCategory,
  ParsedAviation,
  ParsedDisclosure,
  ParsedDocument,
} from "./disclosure-parse";

const SECTION_CATEGORY: { match: RegExp; category: HouseCategory }[] = [
  { match: /^1\.\s+Shareholdings/i, category: "shareholdings" },
  { match: /^2\.\s+Family and business trusts/i, category: "trusts_and_nominee_companies" },
  { match: /^3\.\s+Real estate/i, category: "real_estate" },
  { match: /^4\.\s+Directorships/i, category: "directorships" },
  { match: /^5\.\s+Partnerships/i, category: "partnerships" },
  { match: /^6\.\s+Indicate the nature of the liability/i, category: "liabilities" },
  { match: /^7\.\s+The nature of any bonds/i, category: "bonds_and_debentures" },
  { match: /^8\.\s+Saving or investment accounts/i, category: "savings_and_investment_accounts" },
  { match: /^9\.\s+The nature of any other assets/i, category: "other_assets" },
  { match: /^10\.\s+The nature of any other substantial sources of income/i, category: "other_income" },
  { match: /^11\.\s+Gifts/i, category: "gifts" },
  { match: /^12\.\s+Any sponsored travel or hospitality/i, category: "sponsored_travel_or_hospitality" },
  { match: /^13\.\s+Membership of any organisation/i, category: "memberships" },
  { match: /^14\.\s+List any other interest/i, category: "other_interests" },
];

const ALTERATION_ITEM_CATEGORY: { match: RegExp; category: HouseCategory }[] = [
  { match: /^1\b/, category: "shareholdings" },
  { match: /^2\b/, category: "trusts_and_nominee_companies" },
  { match: /^3\b/, category: "real_estate" },
  { match: /^4\b/, category: "directorships" },
  { match: /^5\b/, category: "partnerships" },
  { match: /^6\b/, category: "liabilities" },
  { match: /^7\b/, category: "bonds_and_debentures" },
  { match: /^8\b/, category: "savings_and_investment_accounts" },
  { match: /^9\b/, category: "other_assets" },
  { match: /^10\b/, category: "other_income" },
  { match: /^11\b/, category: "gifts" },
  { match: /^12\b/, category: "sponsored_travel_or_hospitality" },
  { match: /^13\b/, category: "memberships" },
  { match: /^14\b/, category: "other_interests" },
];

const SKIP_LINE =
  /^(REGISTER OF MEMBERS|Statement of Registrable|NOTIFICATION OF ALTERATION|Notification of alteration|since dissolution|\d{1,2}(?:TH|ST|ND|RD)?\s+Parliament|FAMILY\b|NAME$|GIVEN\b|NAMES\b|please print|ELECTORAL|DIVISION\b|STATE\b|Notes$|\d+\.\s+It is suggested|\d+\.\s+The information which you are required|\d+\.\s+If there is insufficient space|House of Representatives|I wish to notify an alteration|Processed by Registrar|\(please print\)|\(i\)\s|\(ii\)\s|in which a beneficial interest|in which the Member|Member for support|held by the Member|nature of its operation and the beneficiary|Name of company|Name of trust|Name of organisation|Location\b|Purpose for which owned|Nature of (?:its )?operation|Beneficial interests|Beneficiary of the trust|Activities of (?:company|partnership)|Nature of interest$|Nature of liability|Creditor$|Type of investment|Body in which investment|Nature of account|Name of bank|Nature of any other assets|Nature of income|Detail of gifts|Details of travel|Item Details$)/i;

function dmyToIso(s: string): string | null {
  const m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (!m) return null;
  const d = m[1].padStart(2, "0");
  const mo = m[2].padStart(2, "0");
  return `${m[3]}-${mo}-${d}`;
}

function normalizeFormText(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/Spouse\/\s*Partner/gi, "Spouse/Partner")
    .replace(/Dependent\s+Children/gi, "Dependent Children")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function classifyAviation(raw: string): { tags: string[]; aviation: ParsedAviation } | null {
  if (
    !/\b(qantas|virgin australia|virgin\b|chairman'?s lounge|airline|airport lounge|flight upgrade|upgraded?\b)/i.test(
      raw,
    )
  ) {
    return null;
  }
  const airline = /\bqantas\b/i.test(raw)
    ? "Qantas"
    : /\bvirgin\b/i.test(raw)
      ? "Virgin Australia"
      : null;
  const lounge = /chairman'?s lounge/i.test(raw)
    ? "Chairman's Lounge"
    : /\bbeyond\b/i.test(raw)
      ? "Beyond"
      : null;
  return {
    tags: ["aviation"],
    aviation: {
      relevant: true,
      type: lounge ? "lounge" : /upgrade/i.test(raw) ? "upgrade" : "airline_status",
      airline,
      lounge_name: lounge,
      status_name: null,
      requested: null,
      complimentary: null,
      sponsored: null,
    },
  };
}

function looksLikeContent(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 2) return false;
  if (/^item details$/i.test(t)) return false;
  return /[A-Za-z]/.test(t);
}

function parseAlterationDetails(raw: string): { category: HouseCategory; raw_text: string } {
  const t = raw.replace(/\s+/g, " ").trim();
  const m = t.match(/^(\d{1,2})\.\s+(.+)$/);
  if (m) {
    const cat =
      ALTERATION_ITEM_CATEGORY.find((c) => c.match.test(m[1]))?.category ?? "other_interests";
    const rest = m[2].replace(
      /^(Shareholdings|Trusts?|Real Estate|Directorships|Partnerships|Liabilit(?:y|ies)|Bonds?|Accounts?|Assets?|Income|Gifts?|Travel Or Hospitality|Travel|Hospitality|Memberships?|Other Interests?)\s+/i,
      "",
    );
    return { category: cat, raw_text: rest.trim() || t };
  }
  return { category: "other_interests", raw_text: t };
}

interface OpenRow {
  category: HouseCategory;
  event_type: EventType;
  subject: string;
  lines: string[];
}

function flushRow(row: OpenRow | null, out: ParsedDisclosure[], date: string | null) {
  if (!row) return;
  const raw_text = row.lines.join("\n").replace(/\s+\n/g, "\n").trim();
  if (!looksLikeContent(raw_text)) return;
  const av = classifyAviation(raw_text);
  out.push({
    category: row.category,
    event_type: row.event_type,
    subject: row.subject,
    disclosure_date: date,
    raw_text,
    page: null,
    entities: av?.aviation.airline ? [{ name: av.aviation.airline, type: "airline" }] : [],
    tags: av?.tags ?? [],
    aviation: av?.aviation ?? { relevant: false },
    confidence: 0.86,
  });
}

export function isHouseInterestsForm(text: string): boolean {
  const t = normalizeFormText(text);
  return (
    /REGISTER OF MEMBERS/i.test(t) &&
    /Shareholdings/i.test(t) &&
    /Any sponsored travel or hospitality/i.test(t)
  );
}

export function extractHouseFormDisclosures(
  text: string,
  meta: { politicianName: string; chamber: string; parliament: number },
): { document: ParsedDocument; disclosures: ParsedDisclosure[] } {
  const lines = normalizeFormText(text).split("\n");
  const disclosures: ParsedDisclosure[] = [];
  let category: HouseCategory | null = null;
  let eventType: EventType = "initial";
  const state: { row: OpenRow | null } = { row: null };
  let lodgedDate: string | null = null;
  let documentType = "statement";

  const startSubject = (subject: string, rest: string) => {
    flushRow(state.row, disclosures, lodgedDate);
    if (!category) {
      state.row = null;
      return;
    }
    state.row = { category, event_type: eventType, subject, lines: rest ? [rest] : [] };
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^Submitted Date:/i.test(line)) {
      lodgedDate = dmyToIso(line) ?? lodgedDate;
      continue;
    }
    if (/^\d{1,2}$/.test(line)) continue;

    const section = SECTION_CATEGORY.find((s) => s.match.test(line));
    if (section) {
      flushRow(state.row, disclosures, lodgedDate);
      state.row = null;
      category = section.category;
      if (eventType !== "addition" && eventType !== "deletion") eventType = "initial";
      continue;
    }

    if (/^ADDITION$/i.test(line)) {
      flushRow(state.row, disclosures, lodgedDate);
      state.row = null;
      eventType = "addition";
      documentType = "alteration";
      continue;
    }
    if (/^DELETION$/i.test(line)) {
      flushRow(state.row, disclosures, lodgedDate);
      state.row = null;
      eventType = "deletion";
      documentType = "alteration";
      continue;
    }

    if (SKIP_LINE.test(line)) continue;

    const self = line.match(/^Self(?:\s+(.*))?$/i);
    if (self && !/^Self[a-z]/i.test(line)) {
      startSubject("self", (self[1] || "").trim());
      continue;
    }
    const spouse = line.match(/^Spouse\/Partner(?:\s+(.*))?$/i);
    if (spouse) {
      startSubject("spouse", (spouse[1] || "").trim());
      continue;
    }
    const dep = line.match(/^Dependent Children(?:\s+(.*))?$/i);
    if (dep) {
      startSubject("dependent_children", (dep[1] || "").trim());
      continue;
    }

    if (state.row !== null) {
      const current = state.row;
      if (eventType === "addition" || eventType === "deletion") {
        const parsed = parseAlterationDetails(current.lines.concat(line).join(" "));
        current.category = parsed.category;
        current.lines = [parsed.raw_text];
      } else {
        current.lines.push(line);
      }
    }
  }
  flushRow(state.row, disclosures, lodgedDate);

  // Alteration-only pages can leave a subject with no category; drop empties already handled.
  const seen = new Set<string>();
  const unique = disclosures.filter((d) => {
    const compact = d.raw_text.replace(/\s+/g, " ").trim();
    if (
      (d.event_type === "addition" || d.event_type === "deletion") &&
      compact.length < 24 &&
      !/not applicable|^nil$/i.test(compact)
    ) {
      return false;
    }
    const key = `${d.category}|${d.event_type}|${d.subject}|${d.raw_text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    document: {
      politician_name: meta.politicianName,
      chamber: meta.chamber,
      parliament: meta.parliament,
      document_type: documentType,
      lodged_date: lodgedDate,
    },
    disclosures: unique,
  };
}
