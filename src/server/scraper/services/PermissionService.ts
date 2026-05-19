import { ScraperError } from "../types/errors.js";
import { isLikelyBlockPage } from "../extractors/utils.js";

const robotsCache = new Map<string, { expiresAt: number; text: string }>();

export function assertAllowedUrl(urlValue: string | undefined, allowedDomains?: string[]) {
  if (!urlValue) throw new ScraperError("INVALID_URL", "URL is required.");
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new ScraperError("INVALID_URL", "URL is invalid.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new ScraperError("INVALID_URL", "Only HTTP and HTTPS URLs are supported.");
  }
  const allowed = allowedDomains?.filter(Boolean).map((domain) => domain.toLowerCase());
  if (allowed?.length && !allowed.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
    throw new ScraperError("PERMISSION_REQUIRED", "URL domain is not in the allowed domain list.", {
      domain: url.hostname,
      allowedDomains,
    });
  }
  return url;
}

async function fetchRobots(origin: string) {
  const cached = robotsCache.get(origin);
  if (cached && cached.expiresAt > Date.now()) return cached.text;
  const response = await fetch(`${origin}/robots.txt`, {
    headers: { "User-Agent": "SynclyProductExtractionEngine/1.0" },
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  const text = response?.ok ? await response.text() : "";
  robotsCache.set(origin, { text, expiresAt: Date.now() + 60 * 60 * 1000 });
  return text;
}

function robotsDisallows(robots: string, path: string) {
  if (!robots.trim()) return false;
  const lines = robots.split(/\r?\n/).map((line) => line.replace(/#.*/, "").trim());
  let applies = false;
  for (const line of lines) {
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey?.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") applies = value === "*" || /syncly|productextraction/i.test(value);
    if (applies && key === "disallow" && value && path.startsWith(value)) return true;
  }
  return false;
}

export async function assertRobotsAllowed(url: URL) {
  const robots = await fetchRobots(url.origin);
  if (robotsDisallows(robots, url.pathname || "/")) {
    throw new ScraperError("ROBOTS_DISALLOWED", "robots.txt disallows crawling this URL.", { robotsUrl: `${url.origin}/robots.txt` });
  }
}

export function assertPageIsAccessible(html: string) {
  if (isLikelyBlockPage(html)) {
    throw new ScraperError("SOURCE_RESTRICTED", "Source returned a block, login, CAPTCHA, or permission page. Extraction stopped safely.");
  }
}
