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

export class StaticHtmlProductAdapter implements SourceAdapter {
  name = "static_html";
  private brandDetector = new BrandDetector();
  private restrictionDetector = new RestrictionDetector();

  async canHandle(input: SourceInput) {
    return (
      input.sourceType === "product_url" &&
      (!input.mode || input.mode === "auto" || input.mode === "static_html")
    );
  }

  async test(input: SourceInput): Promise<SourceTestResult> {
    try {
      const url = assertAllowedUrl(input.url, input.allowedDomains);
      await assertRobotsAllowed(url);
      const html = await this.fetchHtmlWithRateLimit(url.toString());
      assertPageIsAccessible(html);
      const product = extractProductFromHtml({
        html,
        url: url.toString(),
        adapter: this.name,
        selectors: input.customSelectors,
      });
      if (product.confidence.overall < 50)
        return {
          ok: false,
          status: "NO_PRODUCT_DATA_FOUND",
          recommendedMode: "browser_rendered",
        };
      return { ok: true, status: "READY", recommendedMode: "static_html" };
    } catch (error: any) {
      return this.toTestResult(error);
    }
  }

  async extract(input: SourceInput): Promise<ExtractionResult> {
    const url = assertAllowedUrl(input.url, input.allowedDomains);
    await assertRobotsAllowed(url);
    const html = await this.fetchHtmlWithRateLimit(url.toString());
    assertPageIsAccessible(html);
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
      browserRenderingRequired: false,
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

  private async fetchHtmlWithRateLimit(
    url: string,
    retryCount = 0,
  ): Promise<string> {
    const brandInfo = this.brandDetector.detectBrand(url);
    const brandKey = brandInfo.brandKey || "unknown";

    // Apply rate limiting with exponential backoff
    const delay = brandLimitManager.getDelayMs(brandKey);
    if (delay > 0 && delay !== Number.POSITIVE_INFINITY) {
      scraperLogger.info({
        message: `Rate limiting ${brandKey}`,
        delayMs: delay,
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "SynclyProductExtractionEngine/1.0",
          Accept: "text/html,application/xhtml+xml",
        },
        signal: AbortSignal.timeout(20000),
      }).catch((error) => {
        throw new ScraperError("NETWORK_ERROR", error.message);
      });

      // Record this request
      brandLimitManager.recordRequest(brandKey);

      // Handle rate limiting (429)
      if (response.status === 429) {
        if (retryCount < 3) {
          const backoffDelay = Math.pow(2, retryCount) * 5000; // 5s, 10s, 20s
          scraperLogger.warn({
            message: `Rate limited (429) for ${brandKey}, retrying in ${backoffDelay}ms`,
            attempt: retryCount + 1,
            maxAttempts: 3,
          });
          await new Promise((resolve) => setTimeout(resolve, backoffDelay));
          return this.fetchHtmlWithRateLimit(url, retryCount + 1);
        }
        throw new ScraperError(
          "RATE_LIMITED",
          `Too many requests (429) after ${retryCount} retries`,
        );
      }

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new ScraperError(
            "PERMISSION_REQUIRED",
            `Source returned HTTP ${response.status}.`,
          );
        }
        throw new ScraperError(
          "NETWORK_ERROR",
          `Source returned HTTP ${response.status}.`,
        );
      }

      const html = await response.text();

      // Detect restriction signals
      const signals = this.restrictionDetector.detectRestrictionSignals(
        html,
        response.status,
      );
      if (
        signals.captchaDetected ||
        signals.loginRequired ||
        signals.accessDenied ||
        signals.botProtectionPage
      ) {
        brandLimitManager.updateProfileFromSignals(brandKey, signals);
        scraperLogger.warn({
          message: `Restriction signals detected for ${brandKey}`,
          signals,
          updatedProfile: brandLimitManager.getProfileSummary(brandKey),
        });
      }

      return html;
    } catch (error) {
      // On network errors, retry with exponential backoff
      if (
        error instanceof ScraperError &&
        error.code === "NETWORK_ERROR" &&
        retryCount < 2
      ) {
        const backoffDelay = Math.pow(2, retryCount) * 2000; // 2s, 4s
        scraperLogger.warn({
          message: `Network error for ${brandKey}, retrying in ${backoffDelay}ms`,
          error: error.message,
          attempt: retryCount + 1,
        });
        await new Promise((resolve) => setTimeout(resolve, backoffDelay));
        return this.fetchHtmlWithRateLimit(url, retryCount + 1);
      }
      throw error;
    }
  }

  private toTestResult(error: any): SourceTestResult {
    if (error instanceof ScraperError)
      return { ok: false, status: error.code as any, reason: error.message };
    return {
      ok: false,
      status: "NETWORK_ERROR",
      reason: error.message || "Source test failed.",
    };
  }
}
