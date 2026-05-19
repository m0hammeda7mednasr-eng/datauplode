import * as cheerio from "cheerio";
import type { CategoryCrawlConfig } from "../types/source.js";
import { assertAllowedUrl, assertPageIsAccessible, assertRobotsAllowed } from "./PermissionService.js";
import { toAbsoluteUrl } from "../extractors/utils.js";

function allowedPath(url: string, include?: string[], exclude?: string[]) {
  if (exclude?.some((pattern) => new RegExp(pattern, "i").test(url))) return false;
  if (include?.length) return include.some((pattern) => new RegExp(pattern, "i").test(url));
  return /\/products?\/|\/p\/|\/product-|\/item\/|sku|style/i.test(url);
}

export class CategoryDiscoveryService {
  async discover(config: CategoryCrawlConfig) {
    const start = assertAllowedUrl(config.startUrl, [new URL(config.startUrl).hostname]);
    const queue = [start.toString()];
    const seenPages = new Set<string>();
    const products = new Set<string>();

    while (queue.length && seenPages.size < config.maxPages && products.size < config.maxProducts) {
      const pageUrl = queue.shift()!;
      if (seenPages.has(pageUrl)) continue;
      seenPages.add(pageUrl);
      const url = new URL(pageUrl);
      await assertRobotsAllowed(url);
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) continue;
      const html = await response.text();
      assertPageIsAccessible(html);
      const $ = cheerio.load(html);

      $("script[type='application/ld+json']").each((_, element) => {
        const text = $(element).text();
        for (const match of text.matchAll(/"url"\s*:\s*"([^"]+)"/g)) {
          const absolute = toAbsoluteUrl(match[1], pageUrl);
          if (absolute && new URL(absolute).hostname === start.hostname && allowedPath(absolute, config.includePatterns, config.excludePatterns)) {
            products.add(absolute);
          }
        }
      });

      $("a[href]").each((_, element) => {
        const absolute = toAbsoluteUrl($(element).attr("href"), pageUrl);
        if (!absolute) return;
        const target = new URL(absolute);
        if (target.hostname !== start.hostname) return;
        if (/cart|checkout|account|login|signin|search/i.test(target.pathname)) return;
        if (allowedPath(absolute, config.includePatterns, config.excludePatterns)) products.add(absolute);
        if (/page=|\/page\/|\?p=|pagination|next/i.test(absolute) && seenPages.size + queue.length < config.maxPages) queue.push(absolute);
      });
    }

    return {
      pagesVisited: seenPages.size,
      productUrls: [...products].slice(0, config.maxProducts),
    };
  }
}
