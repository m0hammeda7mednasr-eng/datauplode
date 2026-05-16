import assert from "node:assert/strict";
import { BrandDetector } from "./src/server/scraper/services/BrandDetector.js";
import {
  detectExtractionSignals,
  ExtractionSignalsDetector,
} from "./src/server/scraper/services/ExtractionSignalsDetector.js";
import {
  detectRestrictionSignals,
  RestrictionDetector,
} from "./src/server/scraper/services/RestrictionDetector.js";
import {
  classifyUrlsFromSitemap,
  SitemapDiscovery,
} from "./src/server/scraper/services/SitemapDiscovery.js";
import { RobotsParser } from "./src/server/scraper/services/RobotsParser.js";
import { SourceCapabilityScanner } from "./src/server/scraper/services/SourceCapabilityScanner.js";
import type { SourceCapabilityReport } from "./src/types/sourceScan";

function testBrandDetection() {
  const detector = new BrandDetector();

  const next = detector.detectBrand("https://www.next.ae/en/style/abc");
  assert.equal(next.brandKey, "next");
  assert.equal(next.region, "ME");

  const mands = detector.detectBrand("https://www.marksandspencer.com/p/item");
  assert.equal(mands.brandKey, "marks_and_spencer");
}

function testRestrictionDetection() {
  const signals = detectRestrictionSignals(
    "<html><body>Verify you are human. Cloudflare. Too many requests.</body></html>",
    429,
  );

  assert.equal(signals.captchaDetected, true);
  assert.equal(signals.botProtectionPage, true);
  assert.equal(signals.rateLimited, true);

  const detector = new RestrictionDetector();
  assert.equal(detector.isSafeToExtract(signals), false);
}

function testExtractionSignalDetection() {
  const html = `
    <html>
      <head>
        <meta property="og:title" content="Blue Dress" />
        <meta property="product:price:amount" content="99.99" />
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"Product","name":"Blue Dress"}
        </script>
      </head>
      <body>
        <h1 class="product-title">Blue Dress</h1>
        <div class="price">USD 99.99</div>
        <div class="product-gallery"><img src="/a.jpg" /></div>
        <select name="size"><option>S</option><option>M</option></select>
      </body>
    </html>
  `;

  const signals = detectExtractionSignals(html);
  assert.equal(signals.hasJsonLdProduct, true);
  assert.equal(signals.hasOpenGraph, true);
  assert.equal(signals.hasStaticProductHtml, true);
  assert.equal(signals.hasVariantSignals, true);

  const confidence = new ExtractionSignalsDetector().calculateExtractionConfidence(signals);
  assert.ok(confidence >= 70);
}

function testRobotsParsing() {
  const robots = `
    User-agent: *
    Disallow: /checkout
    Disallow: /cart
    Allow: /products
    Sitemap: https://example.com/sitemap.xml
  `;

  const parser = new RobotsParser() as any;
  const parsed = parser.parseRobotsContent(robots);

  assert.ok(parsed.disallowRules.includes("/checkout"));
  assert.ok(parsed.allowRules.includes("/products"));
  assert.equal(parsed.sitemapUrls[0], "https://example.com/sitemap.xml");
}

function testSitemapClassification() {
  const summary = classifyUrlsFromSitemap([
    "https://store.example.com/products/blue-dress-12345",
    "https://store.example.com/category/girls",
    "https://store.example.com/cart",
    "https://store.example.com/assets/logo.svg",
    "https://store.example.com/about",
  ]);

  assert.equal(summary.productUrls.length, 1);
  assert.equal(summary.categoryUrls.length, 1);
  assert.equal(summary.ignoredUrls.length, 1);
  assert.equal(summary.assetUrls.length, 1);
  assert.equal(summary.pageUrls.length, 1);
}

async function testSitemapDiscoveryWithoutNetwork() {
  const discovery = new SitemapDiscovery() as any;

  discovery.checkSitemapExists = async (url: string) =>
    ["https://demo.com/sitemap.xml", "https://demo.com/sitemap_index.xml"].includes(url);

  discovery.parseSingleSitemap = async (url: string) => {
    if (url.endsWith("sitemap_index.xml")) {
      return {
        nestedSitemaps: ["https://demo.com/product-sitemap.xml"],
        pageUrls: [],
      };
    }

    if (url.endsWith("product-sitemap.xml")) {
      return {
        nestedSitemaps: [],
        pageUrls: ["https://demo.com/product/sku-10001"],
      };
    }

    return {
      nestedSitemaps: [],
      pageUrls: ["https://demo.com/category/new-in"],
    };
  };

  const result = await discovery.discoverSitemaps("demo.com");
  assert.equal(result.canUseSitemap, true);
  assert.ok(result.productUrlsFound >= 1);
}

function testSafeLimitRecommendation() {
  const scanner = new SourceCapabilityScanner();

  const restrictedReport = {
    sourceUrl: "https://example.com/p/1",
    domain: "example.com",
    access: { robotsStatus: "disallowed" },
    discovery: {
      sitemapUrls: [],
      productUrlsFound: 0,
      categoryUrlsFound: 0,
      canUseSitemap: false,
      canUseCategoryCrawl: false,
      canUseSingleProductUrl: false,
    },
    extractionSignals: {
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
    },
    restrictionSignals: {
      captchaDetected: false,
      loginRequired: false,
      accessDenied: false,
      botProtectionPage: false,
      geoBlocked: false,
      rateLimited: false,
    },
    recommendedStrategy: {
      mode: "restricted",
      reason: "blocked",
      confidence: 99,
    },
    freeSafeLimits: {
      maxConcurrency: 0,
      minDelayMs: 0,
      maxRequestsPerMinute: 0,
      maxProductsPerRun: 0,
      maxPagesPerRun: 0,
      retryCount: 0,
      timeoutMs: 15000,
    },
    warnings: [],
  } as SourceCapabilityReport;

  const limits = scanner.recommendFreeSafeLimits(restrictedReport as any);
  assert.equal(limits.maxConcurrency, 0);
  assert.equal(limits.maxRequestsPerMinute, 0);
}

async function main() {
  testBrandDetection();
  testRestrictionDetection();
  testExtractionSignalDetection();
  testRobotsParsing();
  testSitemapClassification();
  await testSitemapDiscoveryWithoutNetwork();
  testSafeLimitRecommendation();

  console.log("Source capability scanner tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
