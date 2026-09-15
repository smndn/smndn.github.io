import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractAllSenateDisclosures,
  isSenateInterestsForm,
  splitSenateStatements,
} from "../src/senate-form.ts";
import { validateParsedOutput } from "../src/disclosure-parse.ts";

const SAMPLE = `Committee of Senators’ Interests
Register of Senators’ Interests
Statements of Registrable Interests and notifications of alterations
lodged between 1 July 2025 and 19 August 2025
VOLUME 1
Form A – Alteration
Surname: Allman-Payne
Other names: Penny
State/Territory: Queensland
Date: 08/07/2025
I wish to alter my statement of interests as follows:
Addition
Item number Details
11. Gifts valued at
$300 or more
where received
from other than
official sources
Paperback book titled “Voice for the Voiceless” by the Dalai Lama which was received
on 6 July 2025 from the Tibetan Community Queensland Inc.
Deletion
Item number Details
8 July 2025
Form A
Surname: Blyth
Other names: Leah
State/Territory: South Australia
Date: 25/07/2025
1. Shareholdings in public and private companies (including holding companies)
indicating the name of the company or companies
Name of company
Liberal Club
2. Trusts and nominee companies
(i) in which a beneficial interest is held
Name of trust/nominee company Nature of its operation Beneficial interests
Not Applicable Not Applicable Not Applicable
11. Gifts valued at more than $750 received from official sources
Detail of gifts
Not Applicable
12. Any sponsored travel or hospitality received where the value of the sponsored travel or
hospitality exceeds $300
Details of travel/hospitality
Lounge memberships for Qantas and Virgin Australia
13. Office holder / donating, being an office holder of or financial contributor donating $300
or more per annum
Not Applicable
`;

test("splits a tabled volume into senators", () => {
  assert.equal(isSenateInterestsForm(SAMPLE), true);
  const parts = splitSenateStatements(SAMPLE);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].politicianName, "Allman-Payne, Penny");
  assert.equal(parts[1].politicianName, "Blyth, Leah");
  assert.equal(parts[0].kind, "alteration");
  assert.equal(parts[1].kind, "statement");
});

test("extracts alteration gift and Qantas lounge onto the right senator", async () => {
  const groups = extractAllSenateDisclosures(SAMPLE, { parliament: 48 });
  assert.equal(groups.length, 2);
  const penny = groups[0];
  assert.ok(
    penny.disclosures.some((d) => /Dalai Lama/i.test(d.raw_text) && d.category === "gifts"),
    JSON.stringify(penny.disclosures.map((d) => d.raw_text)),
  );
  const leah = groups[1];
  const qantas = leah.disclosures.filter((d) => /qantas/i.test(d.raw_text));
  assert.ok(qantas.length >= 1, `qantas rows: ${qantas.length}`);
  assert.equal(qantas[0].category, "sponsored_travel_or_hospitality");
  const validated = await validateParsedOutput(
    JSON.stringify({ document: leah.document, disclosures: leah.disclosures }),
  );
  assert.equal(validated.ok, true, validated.errors.join("; "));
  assert.equal(validated.document?.politician_name, "Blyth, Leah");
});
