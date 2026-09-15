/** Senate tabled-volume discovery: Sitecore media hrefs → working PDF URLs. */

export const APH_ORIGIN = "https://www.aph.gov.au";
export const SENATE_VOLUMES_URL =
  "https://www.aph.gov.au/Parliamentary_Business/Committees/Senate/Senators_Interests/Tabled_volumes";
export const ALLOWED_SOURCE_HOSTS = new Set([
  "www.aph.gov.au",
  "aph.gov.au",
  "static.aph.gov.au",
  "interests-register-api-public.aph.gov.au",
]);

export interface DiscoveredLink {
  url: string;
  title: string;
  chamber: "house" | "senate";
}

function cleanText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function volumeTooLarge(title: string): boolean {
  const m = title.match(/PDF\s+([\d.]+)\s*(MB|Kb|KB)/i);
  if (!m) return false;
  let n = Number(m[1]);
  if (/kb/i.test(m[2]) && n > 20) n = n / 1024;
  return n > 8;
}

export function senatePdfCandidateUrls(href: string, base = APH_ORIGIN): string[] {
  const urls: string[] = [];
  const add = (u: string) => {
    try {
      const abs = new URL(u, base).toString();
      const host = new URL(abs).host;
      if (!ALLOWED_SOURCE_HOSTS.has(host)) return;
      if (/^https:\/\/media\//i.test(abs)) return;
      if (!urls.includes(abs)) urls.push(abs);
    } catch {
      /* ignore */
    }
  };
  const guid = href.match(/([0-9A-Fa-f]{32})/i)?.[1]?.toUpperCase();
  if (guid) {
    add(`${APH_ORIGIN}/-/media/${guid}.ashx`);
    add(`${APH_ORIGIN}/~/media/${guid}.ashx`);
    add(`${SENATE_VOLUMES_URL}/-/media/${guid}.ashx`);
  }
  let h = href.trim().replace(/^~\/?/, "");
  if (h.startsWith("-/")) h = "/" + h;
  if (h && !h.startsWith("http") && !h.startsWith("/")) h = "/" + h;
  if (h) add(h);
  return urls;
}

export function extractSenateVolumeLinks(html: string, base = APH_ORIGIN): DiscoveredLink[] {
  const out: DiscoveredLink[] = [];
  const seen = new Set<string>();
  const re = /<a[^>]+href=["']?([^"'> \s]*media\/[^"'> \s]+)["']?[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const title = cleanText(m[2] || "").replace(/&nbsp;/g, " ");
    if (!/2025|2026/.test(title)) continue;
    if (volumeTooLarge(title)) continue;
    const href = (m[1] || "").trim();
    const candidates = senatePdfCandidateUrls(href, base);
    if (candidates.length === 0) continue;
    const url = candidates[0];
    const key = url.split("?")[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, title: title || key, chamber: "senate" });
  }
  return out;
}

export async function resolveSenatePdfUrl(
  hrefOrUrl: string,
  fetchImpl: typeof fetch = fetch,
  ua: string,
): Promise<string | null> {
  for (const url of senatePdfCandidateUrls(hrefOrUrl)) {
    try {
      const res = await fetchImpl(url, {
        method: "GET",
        headers: {
          "user-agent": ua,
          accept: "application/pdf,*/*",
          referer: SENATE_VOLUMES_URL,
          range: "bytes=0-7",
        },
        redirect: "follow",
      });
      if (!(res.ok || res.status === 206)) continue;
      const ctype = (res.headers.get("content-type") || "").toLowerCase();
      const lenHdr = res.headers.get("content-range") || res.headers.get("content-length") || "0";
      const len = Number((lenHdr.match(/\/(\d+)/) || lenHdr.match(/^(\d+)/) || [])[1] || "0");
      if (len > 8_000_000) continue;
      if (!ctype.includes("pdf") && !ctype.includes("octet-stream") && !ctype.includes("octet")) continue;
      return res.url || url;
    } catch {
      continue;
    }
  }
  return null;
}
