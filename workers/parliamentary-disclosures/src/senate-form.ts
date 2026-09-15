/**
 * Deterministic Senate tabled-volume extractor.
 *
 * Tabled volumes are multi-senator PDFs (Form A statements + alterations).
 * Split on Surname/Other names, then copy exact wording from numbered items.
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
  { match: /^2\.\s+Trusts and nominee companies/i, category: "trusts_and_nominee_companies" },
  { match: /^3\.\s+Real estate/i, category: "real_estate" },
  { match: /^4\.\s+Registered directorships/i, category: "directorships" },
  { match: /^5\.\s+Partnerships/i, category: "partnerships" },
  { match: /^6\.\s+Indicate the nature of the liability/i, category: "liabilities" },
  { match: /^7\.\s+The nature of any bonds/i, category: "bonds_and_debentures" },
  { match: /^8\.\s+Savings? or Investment accounts/i, category: "savings_and_investment_accounts" },
  { match: /^9\.\s+The nature of any other assets/i, category: "other_assets" },
  { match: /^10\.\s+The nature of any other substantial sources of income/i, category: "other_income" },
  { match: /^11\.\s+Gifts valued/i, category: "gifts" },
  { match: /^12\.\s+Any sponsored travel or hospitality/i, category: "sponsored_travel_or_hospitality" },
  { match: /^13\.\s+Office holder/i, category: "memberships" },
  { match: /^13\.\s+Membership/i, category: "memberships" },
  { match: /^14\.\s+List any other interest/i, category: "other_interests" },
  { match: /^14\.\s+Any other interest/i, category: "other_interests" },
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
  /^(Form A|Committee of Senators|Register of Senators|Statements of Registrable|VOLUME\b|September |lodged between|I wish to alter my statement|Item number|Name of company|Name of trust|Name of organisation|Location\b|Purpose for which owned|Nature of (?:its )?operation|Beneficial interests|Beneficiary of the trust|Activities of (?:company|partnership)|Nature of interest$|Nature of liability|Creditor$|Type of investment|Body in which investment|Nature of account|Name of bank|Nature of any other assets|Nature of income|Detail of gifts|Details of travel|Details of travel\/hospitality|Surname:|Other names:|State\/Territory:|Date:|Addition$|Deletion$|indicating the name|in which a beneficial interest|in which the Senator|Member for support|please print|Processed by Registrar)/i;

function dmyToIso(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

function normalize(text: string): string {
  return text
    .replace(/\r/g, "")
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
  return /[A-Za-z]/.test(t);
}

export interface SenateStatement {
  politicianName: string;
  date: string | null;
  kind: "statement" | "alteration";
  text: string;
}

export function isSenateInterestsForm(text: string): boolean {
  const t = normalize(text);
  return (
    (/Register of Senators/i.test(t) || /Form A/i.test(t) || /Surname:/i.test(t)) &&
    /Shareholdings/i.test(t) &&
    /Surname:/i.test(t)
  );
}

export function splitSenateStatements(text: string): SenateStatement[] {
  const t = normalize(text);
  const re =
    /(?:^|\n)Surname:\s*(.+)\nOther names:\s*(.+)\n(?:State\/Territory:\s*.+\n)?(?:Date:\s*([^\n]+)\n)?/gi;
  const matches = [...t.matchAll(re)];
  const out: SenateStatement[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const idx = m.index ?? 0;
    const start = idx;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? t.length) : t.length;
    const surname = (m[1] || "").trim();
    const other = (m[2] || "").trim();
    if (!surname) continue;
    const politicianName = other ? `${surname}, ${other}` : surname;
    const before = t.slice(Math.max(0, idx - 80), idx);
    const body = t.slice(start, end);
    const kind =
      /Form A\s*[–-]\s*Alteration/i.test(before) || /I wish to alter my statement/i.test(body)
        ? "alteration"
        : "statement";
    out.push({
      politicianName,
      date: dmyToIso(m[3] || "") || dmyToIso(body.slice(0, 400)),
      kind,
      text: body,
    });
  }
  return out;
}

function parseAlterationItem(raw: string): { category: HouseCategory; raw_text: string } {
  const t = raw.replace(/\s+/g, " ").trim();
  const m = t.match(/^(\d{1,2})\.\s+(.+)$/);
  if (m) {
    const cat =
      ALTERATION_ITEM_CATEGORY.find((c) => c.match.test(m[1]))?.category ?? "other_interests";
    const rest = m[2]
      .replace(
        /^(Gifts? valued at[^.]*|Any sponsored travel[^.]*|Shareholdings[^.]*|Office holder[^.]*)\s+/i,
        "",
      )
      .trim();
    return { category: cat, raw_text: rest || t };
  }
  return { category: "other_interests", raw_text: t };
}

function pushDisclosure(
  out: ParsedDisclosure[],
  category: HouseCategory,
  eventType: EventType,
  raw_text: string,
  date: string | null,
) {
  const compact = raw_text.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  if (!looksLikeContent(compact)) return;
  const av = classifyAviation(compact);
  out.push({
    category,
    event_type: eventType,
    subject: "self",
    disclosure_date: date,
    raw_text: compact,
    page: null,
    entities: av?.aviation.airline ? [{ name: av.aviation.airline, type: "airline" }] : [],
    tags: av?.tags ?? [],
    aviation: av?.aviation ?? { relevant: false },
    confidence: 0.84,
  });
}

export function extractSenateFormDisclosures(
  statement: SenateStatement,
  meta: { parliament: number },
): { document: ParsedDocument; disclosures: ParsedDisclosure[] } {
  const lines = statement.text.split("\n");
  const disclosures: ParsedDisclosure[] = [];
  let category: HouseCategory | null = null;
  let eventType: EventType = statement.kind === "alteration" ? "alteration" : "initial";
  let buf: string[] = [];
  let lodgedDate = statement.date;

  const flush = () => {
    if (!category) {
      buf = [];
      return;
    }
    pushDisclosure(disclosures, category, eventType, buf.join("\n"), lodgedDate);
    buf = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const iso = dmyToIso(line);
    if (iso && /^\d{1,2}\s+\w+\s+\d{4}$/.test(line) === false && /^[\d/]+$/.test(line)) {
      lodgedDate = lodgedDate || iso;
    }

    if (/^ADDITION$/i.test(line)) {
      flush();
      eventType = "addition";
      category = null;
      continue;
    }
    if (/^DELETION$/i.test(line)) {
      flush();
      eventType = "deletion";
      category = null;
      continue;
    }

    const section = SECTION_CATEGORY.find((s) => s.match.test(line));
    if (section) {
      flush();
      category = section.category;
      if (eventType !== "addition" && eventType !== "deletion") eventType = "initial";
      continue;
    }

    if (statement.kind === "alteration" && (eventType === "addition" || eventType === "deletion")) {
      const item = line.match(/^(\d{1,2})\.\s+/);
      if (item) {
        flush();
        const parsed = parseAlterationItem(line);
        category = parsed.category;
        buf = parsed.raw_text && parsed.raw_text !== line ? [parsed.raw_text] : [];
        continue;
      }
    }

    if (SKIP_LINE.test(line)) continue;
    if (/^Surname:/i.test(line) || /^Other names:/i.test(line)) continue;
    if (/^State\/Territory:/i.test(line) || /^Date:/i.test(line)) continue;
    if (/^I wish to alter/i.test(line)) continue;

    if (category) buf.push(line);
  }
  flush();

  const seen = new Set<string>();
  const unique = disclosures.filter((d) => {
    const key = `${d.category}|${d.event_type}|${d.raw_text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    document: {
      politician_name: statement.politicianName,
      chamber: "senate",
      parliament: meta.parliament,
      document_type: statement.kind,
      lodged_date: lodgedDate,
    },
    disclosures: unique,
  };
}

export function extractAllSenateDisclosures(
  text: string,
  meta: { parliament: number },
): Array<{ document: ParsedDocument; disclosures: ParsedDisclosure[]; politicianName: string }> {
  return splitSenateStatements(text).map((st) => {
    const extracted = extractSenateFormDisclosures(st, meta);
    return { ...extracted, politicianName: st.politicianName };
  });
}
