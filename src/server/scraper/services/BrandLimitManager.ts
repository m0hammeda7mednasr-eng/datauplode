import type { RestrictionSignals } from "../types/capability.js";
import type { BrandLimitProfile } from "../types/brandLimits.js";
import {
  getBrandLimitProfile,
  applyRestrictedLimits,
} from "../types/brandLimits.js";

/**
 * Brand Limit Manager
 * Manages per-brand rate limiting, concurrency, and request thresholds
 * Dynamically adjusts limits based on restriction signals detected during scraping
 */
export class BrandLimitManager {
  private profiles: Map<string, BrandLimitProfile> = new Map();
  private requestCounts: Map<string, number[]> = new Map();
  private lastRestrictionUpdate: Map<string, number> = new Map();

  /**
   * Get or load the limit profile for a brand
   */
  getProfile(brandKey: string): BrandLimitProfile {
    if (!this.profiles.has(brandKey)) {
      const profile = getBrandLimitProfile(brandKey);
      this.profiles.set(brandKey, profile);
    }
    return this.profiles.get(brandKey)!;
  }

  /**
   * Update profile based on detected restriction signals
   * Applies stricter limits if concerning signals are detected
   */
  updateProfileFromSignals(
    brandKey: string,
    signals: RestrictionSignals,
  ): void {
    const hasRestrictiveSignals =
      signals.captchaDetected ||
      signals.loginRequired ||
      signals.accessDenied ||
      signals.botProtectionPage ||
      signals.rateLimited ||
      signals.httpStatus === 403 ||
      signals.httpStatus === 429;

    if (hasRestrictiveSignals) {
      const currentProfile = this.getProfile(brandKey);
      const restrictedProfile = applyRestrictedLimits(currentProfile);
      this.profiles.set(brandKey, restrictedProfile);
      this.lastRestrictionUpdate.set(brandKey, Date.now());
    }
  }

  /**
   * Check if we've hit the rate limit for a brand
   */
  isRateLimited(brandKey: string): boolean {
    const profile = this.getProfile(brandKey);
    if (profile.maxRequestsPerMinute === 0) {
      return true; // Brand is completely restricted
    }

    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    if (!this.requestCounts.has(brandKey)) {
      return false;
    }

    const requests = this.requestCounts.get(brandKey)!;
    const recentRequests = requests.filter((t) => t > oneMinuteAgo);

    return recentRequests.length >= profile.maxRequestsPerMinute;
  }

  /**
   * Record a request for the brand (for rate limiting tracking)
   */
  recordRequest(brandKey: string): void {
    if (!this.requestCounts.has(brandKey)) {
      this.requestCounts.set(brandKey, []);
    }

    this.requestCounts.get(brandKey)!.push(Date.now());

    // Cleanup old requests (older than 2 minutes)
    const twoMinutesAgo = Date.now() - 120000;
    const requests = this.requestCounts.get(brandKey)!;
    const filtered = requests.filter((t) => t > twoMinutesAgo);
    this.requestCounts.set(brandKey, filtered);
  }

  /**
   * Get remaining delay before the next request can be made
   * Returns 0 if a request can be made immediately
   */
  getDelayMs(brandKey: string): number {
    const profile = this.getProfile(brandKey);

    if (profile.maxConcurrency === 0) {
      return Number.POSITIVE_INFINITY; // Brand completely restricted
    }

    // Check rate limit
    if (this.isRateLimited(brandKey)) {
      // Calculate how long to wait
      const now = Date.now();
      const oneMinuteAgo = now - 60000;

      if (!this.requestCounts.has(brandKey)) {
        return 0;
      }

      const requests = this.requestCounts.get(brandKey)!;
      const recentRequests = requests.filter((t) => t > oneMinuteAgo);

      if (recentRequests.length === 0) {
        return 0;
      }

      const oldestRecentRequest = Math.min(...recentRequests);
      const timeUntilExpiry = oldestRecentRequest + 60000 - now;
      return Math.max(0, timeUntilExpiry + profile.minDelayMs);
    }

    return profile.minDelayMs;
  }

  /**
   * Check if we've hit the product limit for a run
   */
  canExtractMore(brandKey: string, currentProductCount: number): boolean {
    const profile = this.getProfile(brandKey);
    return currentProductCount < profile.maxProductsPerRun;
  }

  /**
   * Check if we've hit the page limit for a run
   */
  canProcessMorePages(brandKey: string, currentPageCount: number): boolean {
    const profile = this.getProfile(brandKey);
    return currentPageCount < profile.maxPagesPerRun;
  }

  /**
   * Get the recommended extraction mode for a brand
   */
  getRecommendedMode(
    brandKey: string,
  ):
    | "static_html"
    | "browser_rendered"
    | "auto"
    | "restricted"
    | "manual_review_or_feed" {
    const profile = this.getProfile(brandKey);
    return profile.defaultMode;
  }

  /**
   * Get profile summary for logging/debugging
   */
  getProfileSummary(brandKey: string): string {
    const profile = this.getProfile(brandKey);
    return (
      `[${brandKey}] Mode: ${profile.defaultMode}, ` +
      `Concurrency: ${profile.maxConcurrency}, ` +
      `Delay: ${profile.minDelayMs}ms, ` +
      `RateLimit: ${profile.maxRequestsPerMinute}/min, ` +
      `Products: ${profile.maxProductsPerRun}, ` +
      `Pages: ${profile.maxPagesPerRun}`
    );
  }

  /**
   * Reset all profiles (useful for testing or recalibration)
   */
  resetProfiles(): void {
    this.profiles.clear();
    this.requestCounts.clear();
    this.lastRestrictionUpdate.clear();
  }

  /**
   * Get all active profiles
   */
  getAllProfiles(): BrandLimitProfile[] {
    return Array.from(this.profiles.values());
  }
}

// Singleton instance for use throughout the application
export const brandLimitManager = new BrandLimitManager();
