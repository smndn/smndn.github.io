/**
 * Muse Spark 1.3 Contributor parser client.
 *
 * OpenAI-compatible API at https://api.meta.ai/v1, Bearer auth from the
 * MUSE_API_KEY Worker secret. This module never logs the key and never
 * hardcodes it. If the key is missing, callers must leave jobs pending
 * with a clear error — never fake a parse.
 *
 * NOTE: owned by task t_e4a513a1. src/index.ts wiring is owned by the
 * quarterback to avoid overlapping edits; this module is import-ready.
 */

export const MUSE_API_URL = "https://api.meta.ai/v1";
export const MUSE_MODEL = "muse-spark-1.3-contributor";
export const PARSER_VERSION = "pd-parser-v1";
export const SCHEMA_VERSION = "pd-schema-v1";

export type ExtractionMethod =
  | "direct_pdf_model"
  | "embedded_pdf_text"
  | "ocr"
  | "manual";

export interface MuseParseInput {
  /** Deterministic embedded PDF text (preferred fallback path). */
  text?: string;
  /**
   * Raw PDF bytes for direct multimodal parsing. Only set when the
   * deployment has a working PDF-to-model path; otherwise pass `text`.
   */
  pdfBytes?: ArrayBuffer;
  pdfFilename?: string;
  extractionMethod: ExtractionMethod;
}

export interface MuseParseMeta {
  politicianName: string;
  chamber: string;
  parliament: number;
  sourceUrl: string;
}

export class MuseParseError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = "MuseParseError";
    this.retryable = retryable;
  }
}

const SYSTEM_PROMPT = `You extract Australian federal parliamentary disclosure records into strict JSON.
Rules:
- Extract EVERY disclosure item, including NIL / Not Applicable / blank entries. Never omit boring records.
- Preserve the EXACT original wording in raw_text. Do not summarise, editorialise, or invent details.
- Preserve additions, deletions, amendments and corrections as separate events with event_type initial|addition|deletion|alteration|amendment|correction|unknown.
- Preserve the person/relationship (subject), relevant dates, source page, named entities, and categories.
- Classify aviation-related records with tags and the aviation object. Aviation is classification, not a filter: parse everything.
- Never infer motives, corruption, solicitation, taxpayer funding, market value, or whether an upgrade was requested unless the source wording states it.
- Never merge ambiguous additions and deletions. Prefer unknown over unjustified inference.
- confidence is 0..1 per disclosure. Use low confidence rather than guessing.
Return ONLY a JSON object matching the caller's schema. No markdown, no commentary.`;

export function buildUserPrompt(
  input: MuseParseInput,
  meta: MuseParseMeta,
): string {
  const header = [
    `Politician: ${meta.politicianName}`,
    `Chamber: ${meta.chamber}`,
    `Parliament: ${meta.parliament}`,
    `Source: ${meta.sourceUrl}`,
    `Extraction method: ${input.extractionMethod}`,
  ].join("\n");
  if (input.text && input.text.length > 0) {
    return `${header}\n\nDocument text:\n${input.text}`;
  }
  return `${header}\n\nDocument is attached as PDF (${input.pdfFilename || "source.pdf"}). Extract all disclosures.`;
}

interface ChatMessage {
  role: "system" | "user";
  content: string | Array<{ type: string; [k: string]: unknown }>;
}

/** Call Muse once. Returns the raw response text (expected to be strict JSON). */
export async function callMuse(
  apiKey: string,
  input: MuseParseInput,
  meta: MuseParseMeta,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 120_000,
): Promise<{ rawText: string; modelVersion: string | null }> {
  if (!apiKey) {
    throw new MuseParseError("MUSE_API_KEY is not configured", false);
  }

  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];

  if (input.pdfBytes && !input.text) {
    // Direct PDF path: base64 data URL part (OpenAI-compatible file input).
    const bytes = new Uint8Array(input.pdfBytes);
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    const b64 = btoa(binary);
    messages.push({
      role: "user",
      content: [
        { type: "text", text: buildUserPrompt(input, meta) },
        {
          type: "file",
          file: {
            filename: input.pdfFilename || "source.pdf",
            file_data: `data:application/pdf;base64,${b64}`,
          },
        },
      ],
    });
  } else if (input.text) {
    messages.push({
      role: "user",
      content: buildUserPrompt(input, meta),
    });
  } else {
    throw new MuseParseError("parse input has neither text nor PDF bytes", false);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(`${MUSE_API_URL}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: MUSE_MODEL,
        messages,
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    });
  } catch (err) {
    throw new MuseParseError(
      `muse request failed: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429 || res.status >= 500) {
    throw new MuseParseError(`muse HTTP ${res.status}`, true);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new MuseParseError(
      `muse HTTP ${res.status}: ${body.slice(0, 300)}`,
      false,
    );
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new MuseParseError("muse returned non-JSON response", true);
  }
  const choice = (data as { choices?: Array<{ message?: { content?: unknown } }> })
    .choices?.[0]?.message?.content;
  const rawText = Array.isArray(choice)
    ? choice
        .filter((p) => typeof p === "object" && p !== null && "text" in p)
        .map((p) => String((p as { text: unknown }).text))
        .join("")
    : typeof choice === "string"
      ? choice
      : "";
  if (!rawText.trim()) {
    throw new MuseParseError("muse returned empty content", true);
  }
  const modelVersion =
    (data as { model?: unknown }).model &&
    typeof (data as { model: unknown }).model === "string"
      ? ((data as { model: string }).model as string)
      : null;
  return { rawText, modelVersion };
}

/**
 * Parse with one retry on retryable failure or malformed JSON (the retry
 * uses a stricter reminder). Callers decide what counts as malformed via
 * `isValid`; this keeps the Muse client decoupled from the schema module.
 */
export async function callMuseWithRetry(
  apiKey: string,
  input: MuseParseInput,
  meta: MuseParseMeta,
  isValid: (rawText: string) => boolean,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 45_000,
): Promise<{ rawText: string; modelVersion: string | null; attempts: number }> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const out = await callMuse(apiKey, input, meta, fetchImpl, timeoutMs);
      if (isValid(out.rawText)) return { ...out, attempts: attempt };
      lastError = new MuseParseError(
        `muse output failed validation (attempt ${attempt})`,
        attempt === 1,
      );
    } catch (err) {
      lastError = err;
      if (err instanceof MuseParseError && !err.retryable) throw err;
    }
    if (attempt === 1) {
      // Stricter second attempt: nudge toward exact wording + strict JSON.
      input = {
        ...input,
        text: input.text
          ? `${input.text}\n\nREMINDER: return ONLY strict JSON. raw_text must be the exact source wording, character for character.`
          : undefined,
      };
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new MuseParseError("muse parse failed after retry", false);
}
