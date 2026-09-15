import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractText } from "unpdf";
import { extractHouseFormDisclosures, isHouseInterestsForm } from "../src/house-form.ts";
import { validateParsedOutput } from "../src/disclosure-parse.ts";

test("Buchholz House form extracts Qantas, NIL gifts, and Suncorp addition", async () => {
  let bytes;
  try {
    bytes = readFileSync("/tmp/pd-sample/buchholz.pdf");
  } catch {
    console.log("skip: buchholz sample PDF not present");
    return;
  }
  const extracted = await extractText(new Uint8Array(bytes));
  const raw = extracted.text;
  const text = Array.isArray(raw) ? raw.join("\n") : String(raw ?? "");
  assert.equal(isHouseInterestsForm(text), true);
  const { document, disclosures } = extractHouseFormDisclosures(text, {
    politicianName: "Buchholz, Hon Scott, Member for Wright QLD",
    chamber: "house",
    parliament: 48,
  });
  assert.equal(document.politician_name.includes("Buchholz"), true);
  assert.ok(disclosures.length >= 14, `expected many rows, got ${disclosures.length}`);
  const cats = new Set(disclosures.map((d) => d.category));
  assert.ok(cats.has("shareholdings"));
  assert.ok(cats.has("gifts"));
  assert.ok(cats.has("memberships"));
  assert.ok(cats.has("sponsored_travel_or_hospitality"));
  const qantas = disclosures.filter((d) => /qantas/i.test(d.raw_text));
  assert.ok(qantas.length >= 2, `qantas rows: ${qantas.length}`);
  const nilGifts = disclosures.filter((d) => d.category === "gifts" && /not applicable/i.test(d.raw_text));
  assert.ok(nilGifts.length >= 1, "gifts NIL missing");
  const suncorp = disclosures.find((d) => /suncorp/i.test(d.raw_text));
  assert.ok(suncorp, "suncorp alteration missing");
  assert.equal(suncorp.event_type, "addition");
  assert.equal(suncorp.category, "sponsored_travel_or_hospitality");
  const validated = await validateParsedOutput(JSON.stringify({ document, disclosures }));
  assert.equal(validated.ok, true, validated.errors.join("; "));
  assert.ok(validated.disclosures.length >= 14);
});

test("tiny House form fixture extracts NIL gifts and memberships", async () => {
  const text = `REGISTER OF MEMBERS' INTERESTS
1. Shareholdings in public and private companies (including holding companies) indicating the
name of the company or companies
Self Telstra
Spouse/Partner Not Applicable
Dependent Children Not Applicable
11. Gifts
Self NIL
Spouse/Partner Not Applicable
Dependent Children Not Applicable
12. Any sponsored travel or hospitality received where the value of the sponsored travel or
hospitality exceeds $300
Self Not Applicable
Spouse/Partner Not Applicable
Dependent Children Not Applicable
13. Membership of any organisation where a conflict of interest with a Member's public duties could
foreseeably arise or be seen to arise
Self Qantas Chairman's Lounge
Spouse/Partner Not Applicable
Dependent Children Not Applicable
14. List any other interest which, in the opinion of the Member, holds the potential for a real or
apparent conflict of interest with a Member's public duties to arise
Self Not Applicable
Spouse/Partner Not Applicable
Dependent Children Not Applicable
Submitted Date: 19/08/2025
`;
  assert.equal(isHouseInterestsForm(text), true);
  const { disclosures } = extractHouseFormDisclosures(text, {
    politicianName: "Example",
    chamber: "house",
    parliament: 48,
  });
  assert.ok(disclosures.some((d) => d.category === "gifts" && /NIL/i.test(d.raw_text)));
  assert.ok(disclosures.some((d) => /qantas/i.test(d.raw_text)));
  const validated = await validateParsedOutput(
    JSON.stringify({
      document: { politician_name: "Example", chamber: "house", parliament: 48 },
      disclosures,
    }),
  );
  assert.equal(validated.ok, true, validated.errors.join("; "));
});
