import { z } from "zod";

export const SourceCapabilityReportSchema = z.object({
  sourceUrl: z.string().url(),
  domain: z.string(),
  brandKey: z.string().optional(),
  brandName: z.string().optional(),
  region: z.string().optional(),

  access: z.object({
    robotsTxtUrl: z.string().url().optional(),
    robotsStatus: z.enum([
      "allowed",
      "disallowed",
      "missing",
      "unreachable",
      "unknown",
    ]),
    productPathAllowed: z.boolean().optional(),
    categoryPathAllowed: z.boolean().optional(),
    reason: z.string().optional(),
  }),

  discovery: z.object({
    sitemapUrls: z.array(z.string().url()),
    productUrlsFound: z.number().int().nonnegative(),
    categoryUrlsFound: z.number().int().nonnegative(),
    canUseSitemap: z.boolean(),
    canUseCategoryCrawl: z.boolean(),
    canUseSingleProductUrl: z.boolean(),
  }),

  extractionSignals: z.object({
    hasJsonLdProduct: z.boolean(),
    hasJsonLdProductGroup: z.boolean(),
    hasOpenGraph: z.boolean(),
    hasProductPriceMeta: z.boolean(),
    hasEmbeddedState: z.boolean(),
    embeddedStateTypes: z.array(z.string()),
    hasStaticProductHtml: z.boolean(),
    needsBrowserRendering: z.boolean(),
    hasVariantSignals: z.boolean(),
    hasImageSignals: z.boolean(),
  }),

  restrictionSignals: z.object({
    captchaDetected: z.boolean(),
    loginRequired: z.boolean(),
    accessDenied: z.boolean(),
    botProtectionPage: z.boolean(),
    geoBlocked: z.boolean(),
    rateLimited: z.boolean(),
    httpStatus: z.number().int().optional(),
  }),

  recommendedStrategy: z.object({
    mode: z.enum([
      "static_html",
      "browser_rendered",
      "sitemap_plus_static",
      "sitemap_plus_browser",
      "feed_only",
      "manual_review",
      "restricted",
    ]),
    reason: z.string(),
    confidence: z.number().min(0).max(100),
  }),

  freeSafeLimits: z.object({
    maxConcurrency: z.number().int().nonnegative(),
    minDelayMs: z.number().int().nonnegative(),
    maxRequestsPerMinute: z.number().int().nonnegative(),
    maxProductsPerRun: z.number().int().nonnegative(),
    maxPagesPerRun: z.number().int().nonnegative(),
    retryCount: z.number().int().nonnegative(),
    timeoutMs: z.number().int().positive(),
  }),

  warnings: z.array(
    z.object({
      code: z.enum([
        "ROBOTS_DISALLOWED",
        "CAPTCHA_DETECTED",
        "LOGIN_REQUIRED",
        "ACCESS_DENIED",
        "BOT_PROTECTION",
        "GEO_BLOCKED",
        "NO_SITEMAP_FOUND",
        "NO_PRODUCT_SIGNALS",
        "LOW_CONFIDENCE",
        "BROWSER_RENDER_REQUIRED",
        "MANUAL_REVIEW_REQUIRED",
      ]),
      message: z.string(),
    }),
  ),
});

export type SourceCapabilityReport = z.infer<
  typeof SourceCapabilityReportSchema
>;

export type CapabilityWarningCode =
  SourceCapabilityReport["warnings"][number]["code"];

export type RestrictionSignals = {
  captchaDetected: boolean;
  loginRequired: boolean;
  accessDenied: boolean;
  botProtectionPage: boolean;
  geoBlocked: boolean;
  rateLimited: boolean;
  httpStatus?: number;
};

export type ExtractionSignals = {
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

export type RobotsInfo = {
  robotsTxtUrl?: string;
  robotsStatus:
    | "allowed"
    | "disallowed"
    | "missing"
    | "unreachable"
    | "unknown";
  productPathAllowed?: boolean;
  categoryPathAllowed?: boolean;
  reason?: string;
};

export type SitemapInfo = {
  sitemapUrls: string[];
  productUrlsFound: number;
  categoryUrlsFound: number;
  canUseSitemap: boolean;
  canUseCategoryCrawl: boolean;
  canUseSingleProductUrl: boolean;
};

export type BrandInfo = {
  brandKey?: string;
  brandName?: string;
  region?: string;
};

export type UrlClassification = {
  type: "product" | "category" | "page" | "asset" | "ignored";
  confidence: number;
  reason: string;
};

export const SUPPORTED_BRANDS = {
  "next.co.uk": {
    key: "next",
    name: "Next",
    regions: ["UK", "EU", "US", "ME"],
  },
  "next.ae": { key: "next", name: "Next", regions: ["ME"] },
  "maxfashion.com": { key: "max", name: "Max Fashion", regions: ["ME", "IN"] },
  "shein.com": { key: "shein", name: "SHEIN", regions: ["Global"] },
  "ar.shein.com": { key: "shein", name: "SHEIN", regions: ["ME"] },
  "hm.com": { key: "hm", name: "H&M", regions: ["Global"] },
  "eg.hm.com": { key: "hm", name: "H&M", regions: ["ME"] },
  "lefties.com": { key: "lefties", name: "Lefties", regions: ["ES", "EU"] },
  "centrepointstores.com": {
    key: "centrepoint",
    name: "Centrepoint",
    regions: ["ME"],
  },
  "gap.com": { key: "gap", name: "Gap", regions: ["US", "Global"] },
  "zara.com": { key: "zara", name: "Zara", regions: ["Global"] },
  "marksandspencer.com": {
    key: "marks_and_spencer",
    name: "Marks & Spencer",
    regions: ["UK", "EU"],
  },
  "marksandspencerme.com": {
    key: "marks_and_spencer",
    name: "Marks & Spencer",
    regions: ["ME"],
  },
  "primark.com": {
    key: "primark",
    name: "Primark",
    regions: ["UK", "EU", "US"],
  },
  "mothercare.com": {
    key: "mothercare",
    name: "Mothercare",
    regions: ["UK", "ME"],
  },
  "mothercare.ae": {
    key: "mothercare",
    name: "Mothercare",
    regions: ["ME"],
  },
} as const;

export type SupportedBrandKey = keyof typeof SUPPORTED_BRANDS;
