export type SourceCapabilityReport = {
  sourceUrl: string;
  domain: string;
  brandKey?: string;
  brandName?: string;
  region?: string;
  access: {
    robotsTxtUrl?: string;
    robotsStatus: "allowed" | "disallowed" | "missing" | "unreachable" | "unknown";
    productPathAllowed?: boolean;
    categoryPathAllowed?: boolean;
    reason?: string;
  };
  discovery: {
    sitemapUrls: string[];
    productUrlsFound: number;
    categoryUrlsFound: number;
    canUseSitemap: boolean;
    canUseCategoryCrawl: boolean;
    canUseSingleProductUrl: boolean;
  };
  extractionSignals: {
    hasJsonLdProduct: boolean;
    hasJsonLdProductGroup: boolean;
    hasOpenGraph: boolean;
    hasProductPriceMeta: boolean;
    hasEmbeddedState: boolean;
    embeddedStateTypes: string[];
    hasStaticProductHtml: boolean;
    needsBrowserRendering: boolean;
    hasVariantSignals: boolean;
    hasImageSignals: boolean;
  };
  restrictionSignals: {
    captchaDetected: boolean;
    loginRequired: boolean;
    accessDenied: boolean;
    botProtectionPage: boolean;
    geoBlocked: boolean;
    rateLimited: boolean;
    httpStatus?: number;
  };
  recommendedStrategy: {
    mode:
      | "static_html"
      | "browser_rendered"
      | "sitemap_plus_static"
      | "sitemap_plus_browser"
      | "feed_only"
      | "manual_review"
      | "restricted";
    reason: string;
    confidence: number;
  };
  freeSafeLimits: {
    maxConcurrency: number;
    minDelayMs: number;
    maxRequestsPerMinute: number;
    maxProductsPerRun: number;
    maxPagesPerRun: number;
    retryCount: number;
    timeoutMs: number;
  };
  warnings: Array<{
    code:
      | "ROBOTS_DISALLOWED"
      | "CAPTCHA_DETECTED"
      | "LOGIN_REQUIRED"
      | "ACCESS_DENIED"
      | "BOT_PROTECTION"
      | "GEO_BLOCKED"
      | "NO_SITEMAP_FOUND"
      | "NO_PRODUCT_SIGNALS"
      | "LOW_CONFIDENCE"
      | "BROWSER_RENDER_REQUIRED"
      | "MANUAL_REVIEW_REQUIRED";
    message: string;
  }>;
};

export type SourceScanResponse = {
  success: boolean;
  scanId: string;
  report: SourceCapabilityReport;
  humanReadableReport: string;
  shortSummary: string;
  extractionReadiness: {
    ready: boolean;
    status: "ready" | "warning" | "restricted";
    message: string;
  };
  cached: boolean;
};
