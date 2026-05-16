import axios from "axios";
import { scraperLogger } from "../logger.js";
import type {
  CapabilityWarningCode,
  ExtractionSignals,
  SourceCapabilityReport,
} from "../types/capability.js";
import { getBrandLimitProfile } from "../types/brandLimits.js";
import { BrandDetector } from "./BrandDetector.js";
import { ExtractionSignalsDetector } from "./ExtractionSignalsDetector.js";
import { RestrictionDetector } from "./RestrictionDetector.js";
import { RobotsParser, type ParsedRobotsResult } from "./RobotsParser.js";
import {
  SitemapDiscovery,
  type DiscoveredSitemapInfo,
} from "./SitemapDiscovery.js";

const SCANNER_USER_AGENT =
  "Mozilla/5.0 (compatible; SynclySourceCapabilityScanner/1.0; +https://example.com/scanner)";

type ScannerDependencies = {
  robotsParser?: RobotsParser;
  sitemapDiscovery?: SitemapDiscovery;
  restrictionDetector?: RestrictionDetector;
  extractionDetector?: ExtractionSignalsDetector;
  brandDetector?: BrandDetector;
};

type HttpPageSnapshot = {
  html: string;
  statusCode: number;
};

export class SourceCapabilityScanner {
  private robotsParser: RobotsParser;
  private sitemapDiscovery: SitemapDiscovery;
  private restrictionDetector: RestrictionDetector;
  private extractionDetector: ExtractionSignalsDetector;
  private brandDetector: BrandDetector;

  constructor(deps: ScannerDependencies = {}) {
    this.robotsParser = deps.robotsParser ?? new RobotsParser();
    this.sitemapDiscovery = deps.sitemapDiscovery ?? new SitemapDiscovery();
    this.restrictionDetector = deps.restrictionDetector ?? new RestrictionDetector();
    this.extractionDetector = deps.extractionDetector ?? new ExtractionSignalsDetector();
    this.brandDetector = deps.brandDetector ?? new BrandDetector();
  }

  async scanSourceCapabilities(inputUrl: string): Promise<SourceCapabilityReport> {
    const normalizedUrl = this.normalizeUrl(inputUrl);
    const domain = new URL(normalizedUrl).hostname;

    const robotsInfo = await this.robotsParser.parseRobotsTxt(domain);
    const sitemapInfo = await this.sitemapDiscovery.discoverSitemaps(domain, {
      robotsSitemaps: robotsInfo.sitemapUrls,
      isPathAllowed: (path) => this.robotsParser.isPathAllowed(path, robotsInfo),
    });

    const testUrl =
      sitemapInfo.sampleProductUrl ||
      sitemapInfo.sampleCategoryUrl ||
      normalizedUrl;

    const snapshot = await this.fetchPublicPage(testUrl);
    const restrictionSignals = this.restrictionDetector.detectRestrictionSignals(
      snapshot.html,
      snapshot.statusCode,
    );

    const extractionSignals = snapshot.html
      ? this.extractionDetector.detectExtractionSignals(snapshot.html)
      : this.emptyExtractionSignals();

    const brandInfo = this.brandDetector.detectBrand(normalizedUrl, snapshot.html);

    const recommendedStrategy = this.recommendStrategy({
      brandKey: brandInfo.brandKey,
      robotsInfo,
      sitemapInfo,
      extractionSignals,
      restrictionSignals,
    });

    const report: SourceCapabilityReport = {
      sourceUrl: normalizedUrl,
      domain,
      brandKey: brandInfo.brandKey,
      brandName: brandInfo.brandName,
      region: brandInfo.region,
      access: {
        robotsTxtUrl: robotsInfo.robotsTxtUrl,
        robotsStatus: robotsInfo.robotsStatus,
        productPathAllowed: robotsInfo.productPathAllowed,
        categoryPathAllowed: robotsInfo.categoryPathAllowed,
        reason: robotsInfo.reason,
      },
      discovery: {
        sitemapUrls: sitemapInfo.sitemapUrls,
        productUrlsFound: sitemapInfo.productUrlsFound,
        categoryUrlsFound: sitemapInfo.categoryUrlsFound,
        canUseSitemap: sitemapInfo.canUseSitemap,
        canUseCategoryCrawl:
          sitemapInfo.canUseCategoryCrawl && Boolean(robotsInfo.categoryPathAllowed ?? true),
        canUseSingleProductUrl:
          Boolean(sitemapInfo.sampleProductUrl || normalizedUrl) &&
          Boolean(robotsInfo.productPathAllowed ?? true),
      },
      extractionSignals,
      restrictionSignals,
      recommendedStrategy,
      freeSafeLimits: this.recommendFreeSafeLimitsFromSignals(
        recommendedStrategy.mode,
        robotsInfo,
        extractionSignals,
      ),
      warnings: this.buildWarnings({
        robotsInfo,
        restrictionSignals,
        extractionSignals,
        recommendedStrategy,
        sitemapInfo,
      }),
    };

    scraperLogger.info({
      event: "source_capability_scan",
      sourceUrl: report.sourceUrl,
      brandDetected: report.brandKey ?? "unknown",
      robotsStatus: report.access.robotsStatus,
      sitemapCount: report.discovery.sitemapUrls.length,
      productUrlCount: report.discovery.productUrlsFound,
      extractionSignals: report.extractionSignals,
      restrictionSignals: report.restrictionSignals,
      recommendedStrategy: report.recommendedStrategy,
      safeLimits: report.freeSafeLimits,
    });

    return report;
  }

  recommendFreeSafeLimits(report: SourceCapabilityReport) {
    const limits = this.recommendFreeSafeLimitsFromSignals(
      report.recommendedStrategy.mode,
      {
        robotsStatus: report.access.robotsStatus,
      },
      report.extractionSignals,
    );

    if (
      report.recommendedStrategy.mode === "restricted" ||
      report.access.robotsStatus === "disallowed"
    ) {
      return {
        ...limits,
        maxConcurrency: 0,
        maxRequestsPerMinute: 0,
        maxProductsPerRun: 0,
        maxPagesPerRun: 0,
        retryCount: 0,
      };
    }

    return limits;
  }

  private recommendFreeSafeLimitsFromSignals(
    mode: SourceCapabilityReport["recommendedStrategy"]["mode"],
    robotsInfo: Pick<ParsedRobotsResult, "robotsStatus">,
    extractionSignals: ExtractionSignals,
  ) {
    if (mode === "restricted" || robotsInfo.robotsStatus === "disallowed") {
      return {
        maxConcurrency: 0,
        minDelayMs: 0,
        maxRequestsPerMinute: 0,
        maxProductsPerRun: 0,
        maxPagesPerRun: 0,
        retryCount: 0,
        timeoutMs: 15000,
      };
    }

    if (mode === "sitemap_plus_static") {
      return {
        maxConcurrency: 1,
        minDelayMs: 2000,
        maxRequestsPerMinute: 20,
        maxProductsPerRun: 200,
        maxPagesPerRun: 10,
        retryCount: 2,
        timeoutMs: 15000,
      };
    }

    if (mode === "browser_rendered" || mode === "sitemap_plus_browser") {
      return {
        maxConcurrency: 1,
        minDelayMs: 6000,
        maxRequestsPerMinute: 6,
        maxProductsPerRun: 40,
        maxPagesPerRun: 15,
        retryCount: 2,
        timeoutMs: 30000,
      };
    }

    if (mode === "feed_only") {
      return {
        maxConcurrency: 1,
        minDelayMs: 2000,
        maxRequestsPerMinute: 20,
        maxProductsPerRun: 200,
        maxPagesPerRun: 10,
        retryCount: 2,
        timeoutMs: 15000,
      };
    }

    if (extractionSignals.hasJsonLdProduct || extractionSignals.hasStaticProductHtml) {
      return {
        maxConcurrency: 1,
        minDelayMs: 3000,
        maxRequestsPerMinute: 15,
        maxProductsPerRun: 100,
        maxPagesPerRun: 30,
        retryCount: 2,
        timeoutMs: 15000,
      };
    }

    return {
      maxConcurrency: 1,
      minDelayMs: 5000,
      maxRequestsPerMinute: 10,
      maxProductsPerRun: 50,
      maxPagesPerRun: 20,
      retryCount: 2,
      timeoutMs: 15000,
    };
  }

  private recommendStrategy(input: {
    brandKey?: string;
    robotsInfo: ParsedRobotsResult;
    sitemapInfo: DiscoveredSitemapInfo;
    extractionSignals: ExtractionSignals;
    restrictionSignals: SourceCapabilityReport["restrictionSignals"];
  }): SourceCapabilityReport["recommendedStrategy"] {
    const { brandKey, robotsInfo, sitemapInfo, extractionSignals, restrictionSignals } = input;

    if (!this.restrictionDetector.isSafeToExtract(restrictionSignals)) {
      return {
        mode: "restricted",
        reason:
          this.restrictionDetector.getRestrictionReason(restrictionSignals) ||
          "Restricted source detected.",
        confidence: 96,
      };
    }

    if (robotsInfo.robotsStatus === "disallowed") {
      return {
        mode: "restricted",
        reason: "robots.txt disallows crawling for this source.",
        confidence: 99,
      };
    }

    const brandProfile = brandKey
      ? getBrandLimitProfile(brandKey)
      : undefined;

    if (brandProfile?.defaultMode === "manual_review_or_feed") {
      return {
        mode: "feed_only",
        reason:
          "Brand profile recommends feed/manual import unless public pages are clearly permitted and stable.",
        confidence: 70,
      };
    }

    const confidence = this.extractionDetector.calculateExtractionConfidence(
      extractionSignals,
    );

    if (
      extractionSignals.needsBrowserRendering ||
      brandProfile?.defaultMode === "browser_rendered"
    ) {
      return {
        mode: sitemapInfo.canUseSitemap ? "sitemap_plus_browser" : "browser_rendered",
        reason: sitemapInfo.canUseSitemap
          ? "Public sitemap discovered, but product pages look JavaScript-rendered."
          : "Public product data appears to require browser rendering.",
        confidence: Math.max(confidence, 65),
      };
    }

    const hasStrongStaticSignals =
      extractionSignals.hasJsonLdProduct ||
      extractionSignals.hasOpenGraph ||
      extractionSignals.hasStaticProductHtml;

    if (sitemapInfo.canUseSitemap && hasStrongStaticSignals) {
      return {
        mode: "sitemap_plus_static",
        reason: "Sitemap + static product signals available.",
        confidence: Math.max(confidence, 82),
      };
    }

    if (hasStrongStaticSignals) {
      return {
        mode: "static_html",
        reason: "Public static product signals detected.",
        confidence: Math.max(confidence, 75),
      };
    }

    if (sitemapInfo.canUseSitemap && sitemapInfo.productUrlsFound > 0) {
      return {
        mode: "sitemap_plus_static",
        reason: "Sitemap contains product URLs, but extraction signals are weak.",
        confidence: Math.max(55, confidence),
      };
    }

    return {
      mode: "manual_review",
      reason:
        "No reliable public product signals found. Use feed, API permission, or manual import.",
      confidence: Math.min(confidence, 45),
    };
  }

  private buildWarnings(input: {
    robotsInfo: ParsedRobotsResult;
    restrictionSignals: SourceCapabilityReport["restrictionSignals"];
    extractionSignals: ExtractionSignals;
    recommendedStrategy: SourceCapabilityReport["recommendedStrategy"];
    sitemapInfo: DiscoveredSitemapInfo;
  }) {
    const warnings: Array<{ code: CapabilityWarningCode; message: string }> = [];
    const {
      robotsInfo,
      restrictionSignals,
      extractionSignals,
      recommendedStrategy,
      sitemapInfo,
    } = input;

    if (robotsInfo.robotsStatus === "disallowed") {
      warnings.push({
        code: "ROBOTS_DISALLOWED",
        message: "robots.txt disallows crawling this source.",
      });
    }

    const restrictionCode = this.restrictionDetector.getWarningCode(restrictionSignals);
    const restrictionReason = this.restrictionDetector.getRestrictionReason(restrictionSignals);
    if (restrictionCode && restrictionReason) {
      warnings.push({
        code: restrictionCode,
        message: restrictionReason,
      });
    }

    if (!sitemapInfo.canUseSitemap) {
      warnings.push({
        code: "NO_SITEMAP_FOUND",
        message: "No public sitemap discovered from robots or common sitemap paths.",
      });
    }

    if (
      !extractionSignals.hasJsonLdProduct &&
      !extractionSignals.hasOpenGraph &&
      !extractionSignals.hasStaticProductHtml
    ) {
      warnings.push({
        code: "NO_PRODUCT_SIGNALS",
        message: "Product signals are weak in static HTML.",
      });
    }

    if (extractionSignals.needsBrowserRendering) {
      warnings.push({
        code: "BROWSER_RENDER_REQUIRED",
        message: "Static HTML looks like an app shell; browser rendering is likely required.",
      });
    }

    if (recommendedStrategy.confidence < 55) {
      warnings.push({
        code: "LOW_CONFIDENCE",
        message: `Low extraction confidence (${recommendedStrategy.confidence}%).`,
      });
    }

    if (recommendedStrategy.mode === "manual_review") {
      warnings.push({
        code: "MANUAL_REVIEW_REQUIRED",
        message:
          "Extraction needs manual review, supplier feed, or explicit permission/API.",
      });
    }

    return warnings;
  }

  private normalizeUrl(inputUrl: string): string {
    const raw = String(inputUrl || "").trim();
    if (!raw) throw new Error("Source URL is required.");

    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(withProtocol);

    url.hash = "";
    return url.toString();
  }

  private async fetchPublicPage(url: string): Promise<HttpPageSnapshot> {
    try {
      const response = await axios.get<string>(url, {
        timeout: 20000,
        responseType: "text",
        maxRedirects: 5,
        validateStatus: () => true,
        headers: {
          "User-Agent": SCANNER_USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9,ar;q=0.8",
          "Cache-Control": "no-cache",
        },
      });

      return {
        html: String(response.data || ""),
        statusCode: response.status,
      };
    } catch {
      return {
        html: "",
        statusCode: 0,
      };
    }
  }

  private emptyExtractionSignals(): ExtractionSignals {
    return {
      hasJsonLdProduct: false,
      hasJsonLdProductGroup: false,
      hasOpenGraph: false,
      hasProductPriceMeta: false,
      hasEmbeddedState: false,
      embeddedStateTypes: [],
      hasStaticProductHtml: false,
      needsBrowserRendering: false,
      hasVariantSignals: false,
      hasImageSignals: false,
    };
  }
}

export async function scanSourceCapabilities(inputUrl: string) {
  return new SourceCapabilityScanner().scanSourceCapabilities(inputUrl);
}

export function recommendFreeSafeLimits(report: SourceCapabilityReport) {
  return new SourceCapabilityScanner().recommendFreeSafeLimits(report);
}
