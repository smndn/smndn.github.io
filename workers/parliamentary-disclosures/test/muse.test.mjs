// Tests for muse.ts retry behavior with stub fetch (no network, no key).
// Run: node --experimental-strip-types --test test/muse.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { callMuseWithRetry, callMuse, MuseParseError } from "../src/muse.ts";

const META = { politicianName: "X", chamber: "house", parliament: 48, sourceUrl: "https://example/x" };
const INPUT = { text: "some disclosure text", extractionMethod: "embedded_pdf_text" };

function stubFetch(responses) {
  let calls = 0;
  const fn = async () => {
    const body = responses[Math.min(calls++, responses.length - 1)];
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  fn.calls = () => calls;
  return fn;
}

const VALID_BODY = { model: "muse-spark-1.3-contributor", choices: [{ message: { content: '{"ok":true}' } }] };

test("missing key throws without fetching", async () => {
  let fetched = false;
  await assert.rejects(
    () => callMuse("", INPUT, META, (async () => { fetched = true; })),
    (e) => e instanceof MuseParseError && /not configured/.test(e.message),
  );
  assert.equal(fetched, false);
});

test("retry once: invalid first output, valid second", async () => {
  const fetch = stubFetch([
    { model: "m", choices: [{ message: { content: "not json at all" } }] },
    VALID_BODY,
  ]);
  const out = await callMuseWithRetry("k", { ...INPUT }, META, (t) => t.includes('"ok"'), fetch);
  assert.equal(out.attempts, 2);
  assert.match(out.rawText, /"ok"/);
  assert.equal(fetch.calls(), 2);
});

test("fails after retry when still invalid", async () => {
  const fetch = stubFetch([{ model: "m", choices: [{ message: { content: "junk" } }] }]);
  await assert.rejects(
    () => callMuseWithRetry("k", { ...INPUT }, META, () => false, fetch),
    (e) => e instanceof MuseParseError,
  );
  assert.equal(fetch.calls(), 2);
});

test("retryable HTTP 500 retried, then throws", async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    return { ok: false, status: 500, text: async () => "boom" };
  };
  await assert.rejects(() => callMuse("k", { ...INPUT }, META, fetch, 5000), /HTTP 500/);
  assert.equal(calls, 1);
});
