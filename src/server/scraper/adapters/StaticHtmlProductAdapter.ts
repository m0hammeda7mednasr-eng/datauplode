import type { ExtractionResult, SourceAdapter, SourceInput, SourceTestResult } from "../types/source.js";
import { ScraperError } from "../types/errors.js";
import { assertAllowedUrl, assertPageIsAccessible, assertRobotsAllowed } from "../services/PermissionService.js";
import { extractProductFromHtml } from "../services/ExtractionPipeline.js";
import { scraperLogger } from "../logger.js";

export class StaticHtmlProductAdapter implements SourceAdapter {
  name = "static_html";

  async canHandle(input: SourceInput) {
    return input.sourceType === "product_url" && (!input.mode || input.mode === "auto" || input.mode === "static_html");
  }

  async test(input: SourceInput): Promise<SourceTestResult> {
    try {
      const url = assertAllowedUrl(input.url, input.allowedDomains);
      await assertRobotsAllowed(url);
      const html = await this.fetchHtml(url.toString());
      assertPageIsAccessible(html);
      const product = extractProductFromHtml({ html, url: url.toString(), adapter: this.name, selectors: input.customSelectors });
      if (product.confidence.overall < 50) return { ok: false, status: "NO_PRODUCT_DATA_FOUND", recommendedMode: "browser_rendered" };
      return { ok: true, status: "READY", recommendedMode: "static_html" };
    } catch (error: any) {
      return this.toTestResult(error);
    }
  }

  async extract(input: SourceInput): Promise<ExtractionResult> {
    const url = assertAllowedUrl(input.url, input.allowedDomains);
    await assertRobotsAllowed(url);
    const html = await this.fetchHtml(url.toString());
    assertPageIsAccessible(html);
    const product = extractProductFromHtml({ html, url: url.toString(), adapter: this.name, selectors: input.customSelectors });
    scraperLogger.info({
      sourceUrl: url.toString(),
      adapter: this.name,
      jsonLdFound: Boolean(product.raw?.jsonLd),
      openGraphFound: Boolean(product.raw?.meta),
      browserRenderingRequired: false,
      imagesFound: product.media.images.length,
      variantsFound: product.variants.length,
      confidence: product.confidence.overall,
      warnings: product.warnings,
      finalStatus: product.confidence.overall >= 70 ? "READY" : "NEEDS_REVIEW",
    });
    return { ok: true, status: "EXTRACTED", products: [product], warnings: product.warnings.map((warning) => warning.message), logs: [] };
  }

  private async fetchHtml(url: string) {
    const response = await fetch(url, {
      headers: { "User-Agent": "SynclyProductExtractionEngine/1.0", Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(20000),
    }).catch((error) => {
      throw new ScraperError("NETWORK_ERROR", error.message);
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new ScraperError("PERMISSION_REQUIRED", `Source returned HTTP ${response.status}.`);
      throw new ScraperError("NETWORK_ERROR", `Source returned HTTP ${response.status}.`);
    }
    return response.text();
  }

  private toTestResult(error: any): SourceTestResult {
    if (error instanceof ScraperError) return { ok: false, status: error.code as any, reason: error.message };
    return { ok: false, status: "NETWORK_ERROR", reason: error.message || "Source test failed." };
  }
}
