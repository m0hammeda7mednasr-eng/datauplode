import { PlaywrightCrawler, type PlaywrightCrawlingContext } from "crawlee";
import type {
  ExtractionResult,
  SourceAdapter,
  SourceInput,
  SourceTestResult,
} from "../types/source.js";
import { ScraperError } from "../types/errors.js";
import {
  assertAllowedUrl,
  assertPageIsAccessible,
  assertRobotsAllowed,
} from "../services/PermissionService.js";
import { extractProductFromHtml } from "../services/ExtractionPipeline.js";
import { scraperLogger } from "../logger.js";
import { BrandDetector } from "../services/BrandDetector.js";
import { RestrictionDetector } from "../services/RestrictionDetector.js";
import { brandLimitManager } from "../services/BrandLimitManager.js";

export class BrowserRenderedProductAdapter implements SourceAdapter {
  name = "browser_rendered";
  private brandDetector = new BrandDetector();
  private restrictionDetector = new RestrictionDetector();

  async canHandle(input: SourceInput) {
    return (
      input.sourceType === "product_url" &&
      (input.mode === "auto" || input.mode === "browser_rendered")
    );
  }

  async test(input: SourceInput): Promise<SourceTestResult> {
    try {
      const result = await this.extract(input);
      return result.products[0]?.confidence.overall >= 50
        ? { ok: true, status: "READY", recommendedMode: "browser_rendered" }
        : {
            ok: false,
            status: "NO_PRODUCT_DATA_FOUND",
            reason: "Rendered page did not expose product data.",
          };
    } catch (error: any) {
      if (error instanceof ScraperError)
        return { ok: false, status: error.code as any, reason: error.message };
      return { ok: false, status: "NETWORK_ERROR", reason: error.message };
    }
  }

  async extract(input: SourceInput): Promise<ExtractionResult> {
    const url = assertAllowedUrl(input.url, input.allowedDomains);
    await assertRobotsAllowed(url);

    const brandInfo = this.brandDetector.detectBrand(url.toString());
    const brandKey = brandInfo.brandKey || "unknown";

    // Check if brand is restricted
    const profile = brandLimitManager.getProfile(brandKey);
    if (profile.maxConcurrency === 0) {
      throw new ScraperError(
        "SOURCE_RESTRICTED",
        `Brand ${brandKey} is restricted. Browser rendering disabled.`,
      );
    }

    // Apply rate limiting
    const delay = brandLimitManager.getDelayMs(brandKey);
    if (delay > 0 && delay !== Number.POSITIVE_INFINITY) {
      scraperLogger.info({
        message: `Rate limiting ${brandKey}`,
        delayMs: delay,
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    let html = "";
    const crawler = new PlaywrightCrawler({
      maxRequestsPerCrawl: 1,
      headless: true,
      requestHandlerTimeoutSecs: 30,
      async requestHandler({ page }: PlaywrightCrawlingContext) {
        try {
          const response = await page.goto(url.toString(), {
            waitUntil: "domcontentloaded",
            timeout: 25000,
          });

          // Check for rate limiting
          if (response?.status() === 429) {
            scraperLogger.warn({
              message: `Rate limited (429) during browser rendering for ${brandKey}`,
            });
            brandLimitManager.updateProfileFromSignals(brandKey, {
              captchaDetected: false,
              loginRequired: false,
              accessDenied: false,
              botProtectionPage: false,
              geoBlocked: false,
              rateLimited: true,
              httpStatus: 429,
            });
            throw new ScraperError("RATE_LIMITED", "Too many requests (429)");
          }

          await page
            .waitForSelector(
              "h1, [itemprop='price'], [class*='price'], script[type='application/ld+json']",
              { timeout: 6000 },
            )
            .catch(() => undefined);
          html = await page.content();

          // Record successful request
          brandLimitManager.recordRequest(brandKey);
        } catch (error) {
          if (error instanceof ScraperError) throw error;
          throw new ScraperError(
            "NETWORK_ERROR",
            error instanceof Error
              ? error.message
              : "Browser rendering failed.",
          );
        }
      },
      failedRequestHandler() {
        throw new ScraperError("NETWORK_ERROR", "Browser rendering failed.");
      },
    });

    await crawler.run([url.toString()]);
    assertPageIsAccessible(html);

    // Detect restriction signals
    const signals = this.restrictionDetector.detectRestrictionSignals(
      html,
      200,
    );
    if (
      signals.captchaDetected ||
      signals.loginRequired ||
      signals.accessDenied ||
      signals.botProtectionPage
    ) {
      brandLimitManager.updateProfileFromSignals(brandKey, signals);
      scraperLogger.warn({
        message: `Restriction signals detected for ${brandKey} during browser rendering`,
        signals,
        updatedProfile: brandLimitManager.getProfileSummary(brandKey),
      });
    }

    const product = extractProductFromHtml({
      html,
      url: url.toString(),
      adapter: this.name,
      selectors: input.customSelectors,
    });
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
    return {
      ok: true,
      status: "EXTRACTED",
      products: [product],
      warnings: product.warnings.map((warning) => warning.message),
      logs: [],
    };
  }
}
