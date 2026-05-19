import type { BrandInfo } from "../types/capability.js";
import { SUPPORTED_BRANDS } from "../types/capability.js";

const REGION_BY_TLD: Record<string, string> = {
  "co.uk": "UK",
  "com.ae": "ME",
  "ae": "ME",
  "sa": "ME",
  "eg": "ME",
  "in": "IN",
  "es": "ES",
  "de": "EU",
  "fr": "EU",
  "it": "EU",
  "com": "US",
};

const REGION_BY_CURRENCY: Record<string, string> = {
  usd: "US",
  gbp: "UK",
  eur: "EU",
  aed: "ME",
  sar: "ME",
  egp: "ME",
  inr: "IN",
};

const BRAND_ALIASES: Record<string, string> = {
  "max-fashion": "max",
  maxfashions: "max",
  sheinside: "shein",
  "h-m": "hm",
  marksandspencer: "marks_and_spencer",
  marksandspencerme: "marks_and_spencer",
  "marks-spencer": "marks_and_spencer",
  mandsspencer: "marks_and_spencer",
  penneys: "primark",
};

export class BrandDetector {
  detectBrand(url: string, html?: string): BrandInfo {
    try {
      const parsed = new URL(url);
      const domain = parsed.hostname.toLowerCase();
      const pathname = parsed.pathname.toLowerCase();

      const matchedEntry = this.matchBrandFromDomain(domain);
      if (!matchedEntry) {
        return {
          region: this.detectRegion(url, html),
        };
      }

      const [brandDomain, brand] = matchedEntry;
      return {
        brandKey: brand.key,
        brandName: brand.name,
        region: this.detectRegion(url, html, brand.regions),
      };
    } catch {
      return {};
    }
  }

  detectRegion(
    url: string,
    html?: string,
    supportedRegions?: readonly string[],
  ): string | undefined {
    let region =
      this.detectRegionFromDomain(url) ||
      this.detectRegionFromPath(url) ||
      this.detectRegionFromHreflang(html) ||
      this.detectRegionFromCurrency(html) ||
      this.detectRegionFromMetadata(html);

    if (!region) {
      return supportedRegions?.[0];
    }

    region = this.normalizeRegion(region);

    if (supportedRegions?.length && !supportedRegions.includes(region)) {
      return supportedRegions[0];
    }

    return region;
  }

  private matchBrandFromDomain(domain: string) {
    const directMatch = Object.entries(SUPPORTED_BRANDS).find(([brandDomain]) =>
      domain === brandDomain || domain.endsWith(`.${brandDomain}`),
    );
    if (directMatch) return directMatch;

    const aliasMatch = Object.entries(BRAND_ALIASES).find(([alias]) =>
      domain.includes(alias),
    );

    if (!aliasMatch) return undefined;

    const brandKey = aliasMatch[1];
    const brandEntry = Object.entries(SUPPORTED_BRANDS).find(
      ([, value]) => value.key === brandKey,
    );

    return brandEntry;
  }

  private detectRegionFromDomain(url: string): string | undefined {
    const hostname = new URL(url).hostname.toLowerCase();
    const segments = hostname.split(".");

    const joinedLastThree = segments.slice(-3).join(".");
    const joinedLastTwo = segments.slice(-2).join(".");
    const last = segments.slice(-1)[0];

    if (REGION_BY_TLD[joinedLastThree]) return REGION_BY_TLD[joinedLastThree];
    if (REGION_BY_TLD[joinedLastTwo]) return REGION_BY_TLD[joinedLastTwo];
    if (REGION_BY_TLD[last]) return REGION_BY_TLD[last];

    const subdomain = segments[0];
    if (["uk", "gb"].includes(subdomain)) return "UK";
    if (["ae", "sa", "eg", "mena", "me"].includes(subdomain)) return "ME";
    if (["us"].includes(subdomain)) return "US";

    return undefined;
  }

  private detectRegionFromPath(url: string): string | undefined {
    const pathname = new URL(url).pathname.toLowerCase();
    const match = pathname.match(/^\/(?:[a-z]{2}-)?([a-z]{2})(?:\/|$)/i);
    if (!match) return undefined;

    const code = match[1].toUpperCase();
    if (["US"].includes(code)) return "US";
    if (["UK", "GB"].includes(code)) return "UK";
    if (["AE", "SA", "EG"].includes(code)) return "ME";
    if (["IN"].includes(code)) return "IN";
    if (["ES"].includes(code)) return "ES";
    if (["DE", "FR", "IT", "NL", "BE"].includes(code)) return "EU";

    return undefined;
  }

  private detectRegionFromHreflang(html?: string): string | undefined {
    if (!html) return undefined;
    const hreflangMatch = html.match(/hreflang=["']([^"']+)["']/i);
    if (!hreflangMatch?.[1]) return undefined;

    const value = hreflangMatch[1].toLowerCase();
    if (value.includes("en-us")) return "US";
    if (value.includes("en-gb") || value.includes("en-uk")) return "UK";
    if (["en-ae", "ar-ae", "en-sa", "ar-sa", "en-eg", "ar-eg"].some((k) => value.includes(k))) {
      return "ME";
    }
    if (value.includes("en-in")) return "IN";
    if (value.includes("es-es")) return "ES";
    if (["de-de", "fr-fr", "it-it"].some((k) => value.includes(k))) return "EU";

    return undefined;
  }

  private detectRegionFromCurrency(html?: string): string | undefined {
    if (!html) return undefined;

    const currencyMatch = html.match(/\b(USD|GBP|EUR|AED|SAR|EGP|INR)\b/i);
    if (!currencyMatch?.[1]) return undefined;
    return REGION_BY_CURRENCY[currencyMatch[1].toLowerCase()];
  }

  private detectRegionFromMetadata(html?: string): string | undefined {
    if (!html) return undefined;

    const countryMeta = html.match(
      /<meta[^>]+(?:name|property)=["'](?:og:locale|geo\.country|country|region)["'][^>]+content=["']([^"']+)["']/i,
    );

    if (!countryMeta?.[1]) return undefined;

    const value = countryMeta[1].toLowerCase();
    if (value.includes("us")) return "US";
    if (value.includes("uk") || value.includes("gb")) return "UK";
    if (["ae", "sa", "eg", "middle-east", "mena"].some((k) => value.includes(k))) {
      return "ME";
    }
    if (value.includes("in")) return "IN";
    if (value.includes("es")) return "ES";
    if (["de", "fr", "it", "eu"].some((k) => value.includes(k))) return "EU";

    return undefined;
  }

  private normalizeRegion(region: string): string {
    const value = region.toUpperCase();
    if (["GB", "EN_GB", "EN_UK"].includes(value)) return "UK";
    if (["AE", "SA", "EG", "MENA", "MIDDLE_EAST"].includes(value)) return "ME";
    return value;
  }
}
