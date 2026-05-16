import axios from "axios";
import * as cheerio from "cheerio";
import type { SitemapInfo, UrlClassification } from "../types/capability.js";

const SCANNER_USER_AGENT =
  "Mozilla/5.0 (compatible; SynclySourceCapabilityScanner/1.0; +https://example.com/scanner)";

export type DiscoveredSitemapInfo = SitemapInfo & {
  sampleProductUrl?: string;
  sampleCategoryUrl?: string;
  discoveredPageUrls: number;
};

export type SitemapDiscoveryOptions = {
  robotsSitemaps?: string[];
  isPathAllowed?: (path: string) => boolean;
  maxSitemaps?: number;
  maxUrls?: number;
};

export type SitemapUrlClassificationSummary = {
  classifications: Array<UrlClassification & { url: string }>;
  productUrls: string[];
  categoryUrls: string[];
  pageUrls: string[];
  assetUrls: string[];
  ignoredUrls: string[];
};

export class SitemapDiscovery {
  private static readonly TIMEOUT_MS = 12000;
  private static readonly MAX_URLS_TO_ANALYZE = 4000;
  private static readonly MAX_SITEMAPS_TO_PARSE = 30;

  async discoverSitemaps(
    domain: string,
    options: SitemapDiscoveryOptions = {},
  ): Promise<DiscoveredSitemapInfo> {
    const maxUrls = options.maxUrls ?? SitemapDiscovery.MAX_URLS_TO_ANALYZE;
    const maxSitemaps = options.maxSitemaps ?? SitemapDiscovery.MAX_SITEMAPS_TO_PARSE;
    const sitemapUrls = new Set<string>(options.robotsSitemaps ?? []);

    const commonPaths = [
      "/sitemap.xml",
      "/sitemap_index.xml",
      "/sitemap-index.xml",
      "/product-sitemap.xml",
      "/products-sitemap.xml",
      "/sitemaps/sitemap.xml",
      "/sitemap/sitemap.xml",
    ];

    for (const path of commonPaths) {
      const candidate = `https://${domain}${path}`;
      if (await this.checkSitemapExists(candidate)) {
        sitemapUrls.add(candidate);
      }
    }

    const allDiscoveredUrls: string[] = [];
    const queue = Array.from(sitemapUrls).slice(0, maxSitemaps);
    const visited = new Set<string>();

    while (queue.length > 0 && visited.size < maxSitemaps && allDiscoveredUrls.length < maxUrls) {
      const sitemapUrl = queue.shift()!;
      if (visited.has(sitemapUrl)) continue;
      visited.add(sitemapUrl);

      try {
        const parsed = await this.parseSingleSitemap(sitemapUrl);

        for (const nested of parsed.nestedSitemaps) {
          if (!visited.has(nested) && queue.length < maxSitemaps) {
            queue.push(nested);
            sitemapUrls.add(nested);
          }
        }

        allDiscoveredUrls.push(...parsed.pageUrls);
      } catch {
        // Ignore broken sitemap and continue with others.
      }
    }

    const filteredUrls = allDiscoveredUrls.filter((url) => {
      if (!options.isPathAllowed) return true;
      try {
        return options.isPathAllowed(new URL(url).pathname);
      } catch {
        return false;
      }
    });

    const classified = this.classifyUrlsFromSitemap(filteredUrls.slice(0, maxUrls));

    return {
      sitemapUrls: Array.from(sitemapUrls),
      productUrlsFound: classified.productUrls.length,
      categoryUrlsFound: classified.categoryUrls.length,
      canUseSitemap: sitemapUrls.size > 0 && filteredUrls.length > 0,
      canUseCategoryCrawl: classified.categoryUrls.length > 0,
      canUseSingleProductUrl: classified.productUrls.length > 0,
      sampleProductUrl: classified.productUrls[0],
      sampleCategoryUrl: classified.categoryUrls[0],
      discoveredPageUrls: classified.pageUrls.length,
    };
  }

  classifyUrlsFromSitemap(urls: string[]): SitemapUrlClassificationSummary {
    const classifications = urls.map((url) => ({ url, ...this.classifyUrl(url) }));

    return {
      classifications,
      productUrls: classifications
        .filter((item) => item.type === "product")
        .map((item) => item.url),
      categoryUrls: classifications
        .filter((item) => item.type === "category")
        .map((item) => item.url),
      pageUrls: classifications
        .filter((item) => item.type === "page")
        .map((item) => item.url),
      assetUrls: classifications
        .filter((item) => item.type === "asset")
        .map((item) => item.url),
      ignoredUrls: classifications
        .filter((item) => item.type === "ignored")
        .map((item) => item.url),
    };
  }

  private async checkSitemapExists(url: string): Promise<boolean> {
    try {
      const response = await axios.head(url, {
        timeout: 5000,
        headers: { "User-Agent": SCANNER_USER_AGENT },
        validateStatus: () => true,
      });

      if (response.status < 200 || response.status >= 400) return false;

      const contentType = String(response.headers["content-type"] || "").toLowerCase();
      return (
        contentType.includes("xml") ||
        contentType.includes("text") ||
        contentType.includes("application/octet-stream")
      );
    } catch {
      return false;
    }
  }

  private async parseSingleSitemap(sitemapUrl: string) {
    const response = await axios.get<string>(sitemapUrl, {
      timeout: SitemapDiscovery.TIMEOUT_MS,
      headers: { "User-Agent": SCANNER_USER_AGENT, Accept: "application/xml,text/xml,*/*" },
      responseType: "text",
      validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 400) {
      throw new Error(`Sitemap HTTP ${response.status}`);
    }

    const xml = response.data || "";
    const $ = cheerio.load(xml, { xmlMode: true });

    const nestedSitemaps: string[] = [];
    $("sitemapindex > sitemap > loc").each((_, node) => {
      const value = $(node).text().trim();
      if (value && this.isAbsoluteHttpUrl(value)) nestedSitemaps.push(value);
    });

    const pageUrls: string[] = [];
    $("urlset > url > loc").each((_, node) => {
      const value = $(node).text().trim();
      if (value && this.isAbsoluteHttpUrl(value)) pageUrls.push(value);
    });

    return {
      nestedSitemaps,
      pageUrls,
    };
  }

  private classifyUrl(url: string): UrlClassification {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname.toLowerCase();
      const full = `${path}${parsed.search}`;

      if (this.matchesAny(path, [
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        ".webp",
        ".svg",
        ".css",
        ".js",
        ".pdf",
        ".ico",
      ])) {
        return {
          type: "asset",
          confidence: 100,
          reason: "Asset extension pattern",
        };
      }

      if (this.matchesAny(path, [
        "/cart",
        "/checkout",
        "/account",
        "/login",
        "/wishlist",
        "/search",
        "/privacy",
        "/terms",
        "/help",
        "/track",
        "/payment",
      ])) {
        return {
          type: "ignored",
          confidence: 95,
          reason: "Ignored utility/legal path",
        };
      }

      const productPatterns = [
        "/product/",
        "/products/",
        "/p/",
        "/shop/",
        "-p-",
        "/item/",
        "/sku/",
      ];

      if (this.matchesAny(path, productPatterns)) {
        return {
          type: "product",
          confidence: 90,
          reason: "Product URL pattern",
        };
      }

      if (
        /\/(?:[a-z0-9-]{4,}-)?(?:\d{5,}|[a-z0-9]{8,})(?:\.html)?$/i.test(path)
      ) {
        return {
          type: "product",
          confidence: 78,
          reason: "Product id/slug pattern",
        };
      }

      if (
        this.matchesAny(path, [
          "/category/",
          "/categories/",
          "/collection/",
          "/collections/",
          "/department/",
          "/departments/",
          "/c/",
          "/shop-by/",
          "/browse/",
        ])
      ) {
        return {
          type: "category",
          confidence: 85,
          reason: "Category URL pattern",
        };
      }

      return {
        type: "page",
        confidence: 60,
        reason: "Generic page URL",
      };
    } catch {
      return {
        type: "ignored",
        confidence: 100,
        reason: "Invalid URL",
      };
    }
  }

  private matchesAny(path: string, patterns: string[]) {
    return patterns.some((pattern) => path.includes(pattern));
  }

  private isAbsoluteHttpUrl(value: string) {
    try {
      const parsed = new URL(value);
      return ["http:", "https:"].includes(parsed.protocol);
    } catch {
      return false;
    }
  }
}

export function classifyUrlsFromSitemap(urls: string[]) {
  return new SitemapDiscovery().classifyUrlsFromSitemap(urls);
}

export async function discoverSitemaps(domain: string) {
  return new SitemapDiscovery().discoverSitemaps(domain);
}
