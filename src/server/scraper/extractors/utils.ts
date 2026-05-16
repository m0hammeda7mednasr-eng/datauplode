import * as cheerio from "cheerio";

export function cleanText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function unique<T>(values: T[]) {
  return [...new Set(values.filter(Boolean))];
}

export function toAbsoluteUrl(value: unknown, baseUrl: string) {
  const text = cleanText(value);
  if (!text || text.startsWith("data:") || text.startsWith("blob:")) return undefined;
  try {
    const url = new URL(text, baseUrl);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|_branch|irclickid)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

export function bestFromSrcset(srcset: string | undefined, baseUrl: string) {
  if (!srcset) return undefined;
  const candidates = srcset
    .split(",")
    .map((part) => {
      const [url, size] = part.trim().split(/\s+/);
      const score = Number(size?.replace(/[^\d.]/g, "")) || 0;
      return { url: toAbsoluteUrl(url, baseUrl), score };
    })
    .filter((item) => item.url);
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.url;
}

export function getMeta($: cheerio.CheerioAPI, name: string) {
  return (
    $(`meta[property="${name}"]`).attr("content") ||
    $(`meta[name="${name}"]`).attr("content") ||
    ""
  ).trim();
}

export function flattenJsonLd(value: unknown): any[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [record, ...flattenJsonLd(record["@graph"])];
}

export function parseJsonText(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    const recovered = text
      .replace(/^\s*<!--/, "")
      .replace(/-->\s*$/, "")
      .replace(/,\s*([}\]])/g, "$1")
      .trim();
    try {
      return JSON.parse(recovered);
    } catch {
      return undefined;
    }
  }
}

export function isLikelyBlockPage(html: string) {
  return /captcha|access denied|forbidden|security check|verify you are human|login required|sign in to continue|cloudflare|cf-chl/i.test(
    html,
  );
}
