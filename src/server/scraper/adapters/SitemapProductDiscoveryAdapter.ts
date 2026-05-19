import type { ExtractionResult, SourceAdapter, SourceInput, SourceTestResult } from "../types/source.js";
import { assertAllowedUrl, assertRobotsAllowed } from "../services/PermissionService.js";

export class SitemapProductDiscoveryAdapter implements SourceAdapter {
  name = "sitemap_discovery";

  async canHandle(input: SourceInput) {
    return input.sourceType === "sitemap";
  }

  async test(input: SourceInput): Promise<SourceTestResult> {
    try {
      const url = assertAllowedUrl(input.url, input.allowedDomains);
      await assertRobotsAllowed(url);
      return { ok: true, status: "READY", recommendedMode: "static_html" };
    } catch (error: any) {
      return { ok: false, status: error.code || "NETWORK_ERROR", reason: error.message };
    }
  }

  async extract(input: SourceInput): Promise<ExtractionResult> {
    const url = assertAllowedUrl(input.url, input.allowedDomains);
    await assertRobotsAllowed(url);
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const xml = await response.text();
    const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/gi)]
      .map((match) => match[1].trim())
      .filter((item) => /product|products|p\/|item|sku/i.test(item));
    return {
      ok: true,
      status: "EXTRACTED",
      products: [],
      warnings: [],
      logs: [`Discovered ${new Set(urls).size} product-like URL(s) from sitemap.`],
    };
  }
}
