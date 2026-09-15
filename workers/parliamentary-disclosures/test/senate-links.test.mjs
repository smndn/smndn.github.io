import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractSenateVolumeLinks,
  senatePdfCandidateUrls,
  volumeTooLarge,
} from "../src/senate-discover.ts";

const HTML = `
<a href="-/media/F6A654659B104C0A8D90A6DBD0F6C2DB.ashx"><strong>lodged between 1 January 2026 and 30 June 2026</strong>&nbsp; (PDF 5MB)</a>
<a href="-/media/FB79802AD0754CB3AC0564B082B5C10A.ashx"><strong>lodged between 20 August 2025 and 31 December 2025</strong> (PDF 5MB)</a>
<a href="~/media/5506647FCC8749E2834D986706181604.ashx"><strong>lodged between 1 July 2025 and 19 August 2025 - Volume 1</strong> (PDF 2MB)</a>
<a href="-/media/61032957A58E4D38B0F2E84FCA328699.ashx"><strong>lodged between 1 July 2024 and 31 December 2024</strong> (PDF 22MB)</a>
`;

test("skips volumes over 8MB and keeps 2025/2026 Sitecore media hrefs", () => {
  assert.equal(volumeTooLarge("lodged (PDF 22MB)"), true);
  assert.equal(volumeTooLarge("lodged (PDF 5MB)"), false);
  const links = extractSenateVolumeLinks(HTML);
  const urls = links.map((l) => l.url);
  assert.ok(urls.every((u) => !u.includes("https://media/")));
  assert.ok(urls.some((u) => u.includes("FB79802AD0754CB3AC0564B082B5C10A")));
  assert.ok(!urls.some((u) => u.includes("61032957A58E4D38B0F2E84FCA328699")));
});

test("candidate URLs always include origin /-/media/GUID.ashx", () => {
  const c = senatePdfCandidateUrls("-/media/5506647FCC8749E2834D986706181604.ashx");
  assert.equal(c[0], "https://www.aph.gov.au/-/media/5506647FCC8749E2834D986706181604.ashx");
  assert.ok(!c.some((u) => /^https:\/\/media\//i.test(u)));
});
