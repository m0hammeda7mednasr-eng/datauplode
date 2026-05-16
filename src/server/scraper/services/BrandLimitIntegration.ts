/**
 * Brand Limit Integration Guide
 *
 * This file demonstrates how to integrate the BrandLimitManager
 * with the existing scraper pipeline.
 */

import { brandLimitManager } from "./BrandLimitManager.js";
import type { RestrictionSignals } from "../types/capability.js";

/**
 * Example 1: Using brand limits before making a request
 * Call this before fetching a product page
 */
export async function waitForBrandRateLimit(brandKey: string): Promise<void> {
  const delayMs = brandLimitManager.getDelayMs(brandKey);

  if (delayMs === Number.POSITIVE_INFINITY) {
    throw new Error(
      `Brand ${brandKey} is completely restricted. Cannot proceed with extraction.`,
    );
  }

  if (delayMs > 0) {
    console.log(
      `Rate limiting ${brandKey}: waiting ${delayMs}ms before next request`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  // Record this request
  brandLimitManager.recordRequest(brandKey);
}

/**
 * Example 2: Update limits based on restriction signals
 * Call this after receiving a response that might have restriction signals
 */
export function handleRestrictionSignals(
  brandKey: string,
  signals: RestrictionSignals,
): void {
  if (
    signals.captchaDetected ||
    signals.loginRequired ||
    signals.accessDenied ||
    signals.botProtectionPage ||
    signals.rateLimited
  ) {
    console.warn(`Restriction signals detected for ${brandKey}:`, {
      captcha: signals.captchaDetected,
      login: signals.loginRequired,
      accessDenied: signals.accessDenied,
      botProtection: signals.botProtectionPage,
      rateLimited: signals.rateLimited,
      httpStatus: signals.httpStatus,
    });

    brandLimitManager.updateProfileFromSignals(brandKey, signals);

    const newProfile = brandLimitManager.getProfile(brandKey);
    console.warn(`Updated brand limits for ${brandKey}:`, {
      mode: newProfile.defaultMode,
      maxConcurrency: newProfile.maxConcurrency,
      minDelayMs: newProfile.minDelayMs,
      maxRequestsPerMinute: newProfile.maxRequestsPerMinute,
    });
  }
}

/**
 * Example 3: Check extraction limits during a run
 * Call this to ensure we're within product and page limits
 */
export function checkExtractionLimits(
  brandKey: string,
  productCount: number,
  pageCount: number,
): { canContinue: boolean; reason: string } {
  const canExtractMore = brandLimitManager.canExtractMore(
    brandKey,
    productCount,
  );
  const canProcessMore = brandLimitManager.canProcessMorePages(
    brandKey,
    pageCount,
  );

  if (!canExtractMore) {
    return {
      canContinue: false,
      reason: `Product extraction limit reached for ${brandKey} (${productCount} products)`,
    };
  }

  if (!canProcessMore) {
    return {
      canContinue: false,
      reason: `Page processing limit reached for ${brandKey} (${pageCount} pages)`,
    };
  }

  return {
    canContinue: true,
    reason: "Limits not reached",
  };
}

/**
 * Example 4: Get recommended extraction strategy
 * Call this to determine how to extract products for a brand
 */
export function getExtractionStrategy(brandKey: string): {
  mode: string;
  concurrency: number;
  delayMs: number;
} {
  const profile = brandLimitManager.getProfile(brandKey);

  return {
    mode: profile.defaultMode,
    concurrency: profile.maxConcurrency,
    delayMs: profile.minDelayMs,
  };
}

/**
 * Example 5: Logging and debugging
 * Call this to get detailed information about a brand's limits
 */
export function getBrandLimitInfo(brandKey: string): Record<string, any> {
  const profile = brandLimitManager.getProfile(brandKey);

  return {
    brandKey: profile.brandKey,
    mode: profile.defaultMode,
    maxConcurrency: profile.maxConcurrency,
    minDelayMs: profile.minDelayMs,
    maxRequestsPerMinute: profile.maxRequestsPerMinute,
    maxProductsPerRun: profile.maxProductsPerRun,
    maxPagesPerRun: profile.maxPagesPerRun,
    notes: profile.notes,
    summary: brandLimitManager.getProfileSummary(brandKey),
  };
}

/**
 * Example 6: Complete extraction flow with rate limiting
 * This shows how to integrate all the utilities together
 */
export async function extractProductsWithBrandLimits(
  brandKey: string,
  productUrls: string[],
  extractFunction: (url: string) => Promise<any>,
): Promise<any[]> {
  const results = [];
  let pageCount = 0;

  console.log(`Starting extraction for ${brandKey}...`);
  console.log(`Profile: ${brandLimitManager.getProfileSummary(brandKey)}`);

  for (const url of productUrls) {
    // Check if we can continue
    const limitCheck = checkExtractionLimits(
      brandKey,
      results.length,
      pageCount,
    );
    if (!limitCheck.canContinue) {
      console.warn(limitCheck.reason);
      break;
    }

    // Wait for rate limit
    try {
      await waitForBrandRateLimit(brandKey);
    } catch (error) {
      console.error(`Brand ${brandKey} is restricted:`, error);
      break;
    }

    // Extract product
    try {
      console.log(
        `Extracting product ${results.length + 1} for ${brandKey}...`,
      );
      const product = await extractFunction(url);
      results.push(product);
      pageCount++;
    } catch (error) {
      console.error(`Failed to extract ${url}:`, error);
    }
  }

  console.log(
    `Extraction complete for ${brandKey}: ${results.length} products from ${pageCount} pages`,
  );
  return results;
}
