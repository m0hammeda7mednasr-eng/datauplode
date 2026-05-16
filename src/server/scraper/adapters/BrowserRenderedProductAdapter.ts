import { PlaywrightCrawler, type PlaywrightCrawlingContext } from "crawlee";
import type { ExtractionResult, SourceAdapter, SourceInput, SourceTestResult } from "../types/source.js";
import { ScraperError } from "../types/errors.js";
import { assertAllowedUrl, assertPageIsAccessible, assertRobotsAllowed } from "../services/PermissionService.js";
import { extractProductFromHtml } from "../services/ExtractionPipeline.js";
import { scraperLogger } from "../logger.js";

export class BrowserRenderedProductAdapter implements SourceAdapter {
  name = "browser_rendered";

  async canHandle(input: SourceInput) {
    return input.sourceType === "product_url" && (input.mode === "auto" || input.mode === "browser_rendered");
  }

  async test(input: SourceInput): Promise<SourceTestResult> {
    try {
      const result = await this.extract(input);
      return result.products[0]?.confidence.overall >= 50
        ? { ok: true, status: "READY", recommendedMode: "browser_rendered" }
        : { ok: false, status: "NO_PRODUCT_DATA_FOUND", reason: "Rendered page did not expose product data." };
    } catch (error: any) {
      if (error instanceof ScraperError) return { ok: false, status: error.code as any, reason: error.message };
      return { ok: false, status: "NETWORK_ERROR", reason: error.message };
    }
  }

  async extract(input: SourceInput): Promise<ExtractionResult> {
    const url = assertAllowedUrl(input.url, input.allowedDomains);
    await assertRobotsAllowed(url);
    let html = "";
    const crawler = new PlaywrightCrawler({
      maxRequestsPerCrawl: 1,
      headless: true,
      requestHandlerTimeoutSecs: 30,
      async requestHandler({ page }: PlaywrightCrawlingContext) {
        await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 25000 });
        await page
          .waitForSelector("h1, [itemprop='price'], [class*='price'], script[type='application/ld+json']", { timeout: 6000 })
          .catch(() => undefined);
        html = await page.content();
      },
      failedRequestHandler() {
        throw new ScraperError("NETWORK_ERROR", "Browser rendering failed.");
      },
    });
    await crawler.run([url.toString()]);
    assertPageIsAccessible(html);
    const product = extractProductFromHtml({ html, url: url.toString(), adapter: this.name, selectors: input.customSelectors });
    scraperLogger.info({
      sourceUrl: url.toString(),
      adapter: this.name,
      jsonLdFound: Boolean(product.raw?.jsonLd),
      openGraphFound: Boolean(product.raw?.meta),
      browserRenderingRequired: true,
      imagesFound: product.media.images.length,
      variantsFound: product.variants.length,
      confidence: product.confidence.overall,
      warnings: product.warnings,
      finalStatus: product.confidence.overall >= 70 ? "READY" : "NEEDS_REVIEW",
    });
    return { ok: true, status: "EXTRACTED", products: [product], warnings: product.warnings.map((warning) => warning.message), logs: [] };
  }
}
