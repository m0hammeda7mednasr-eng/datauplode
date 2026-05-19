/**
 * Brand Limit & Rate Limiting Test Script
 * يختبر النظام على جميع المواقع المختلفة مع إظهار الـ Rate Limiting والـ Brand Limits
 */

import type { NormalizedProduct } from "./src/server/services/scraper";
import { productExtractionEngine } from "./src/server/scraper/services/ScraperService.js";
import { BrandDetector } from "./src/server/scraper/services/BrandDetector.js";
import { brandLimitManager } from "./src/server/scraper/services/BrandLimitManager.js";
import type { SourceInput } from "./src/server/scraper/types/source.js";

// ألوان للـ console output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
};

function log(message: string, color: string = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logSection(title: string) {
  console.log("\n" + "=".repeat(80));
  log(title, colors.bright + colors.cyan);
  console.log("=".repeat(80) + "\n");
}

function logSuccess(message: string) {
  log(`✓ ${message}`, colors.green);
}

function logError(message: string) {
  log(`✗ ${message}`, colors.red);
}

function logInfo(message: string) {
  log(`ℹ ${message}`, colors.blue);
}

function logWarning(message: string) {
  log(`⚠ ${message}`, colors.yellow);
}

function logDebug(message: string) {
  log(`  ${message}`, colors.gray);
}

// Test URLs from various brands
const TEST_URLS = [
  {
    name: "Max Fashion - Dungaree",
    url: "https://www.maxfashion.com/ae/en/buy-stitch-embroidered-denim-dungaree-with-tshirt/p/B26KIBFEDTRDUNG147MULTICOLORMEDIUM",
    expected: "max",
  },
  {
    name: "Next - Style 1",
    url: "https://www.next.ae/en/style/su759706/w59264#w59264",
    expected: "next",
  },
  {
    name: "Mothercare - Bibs",
    url: "https://www.mothercare.ae/en/buy-3-pack-mothercare-newborn-bibs-4",
    expected: "mothercare",
  },
  {
    name: "Marks & Spencer - Bibshort",
    url: "https://www.marksandspencerme.com/en-ae/l/denim-striped-bibshort-with-t-shirt-0-3-yrs-/p/T784681D",
    expected: "marks_and_spencer",
  },
  {
    name: "Next - Style 2",
    url: "https://www.next.ae/en/style/sv124809/g44412#g44412",
    expected: "next",
  },
  {
    name: "Next - Style 3",
    url: "https://www.next.ae/en/style/su741308/h44364#h44364",
    expected: "next",
  },
  {
    name: "Max Fashion - Minnie Mouse",
    url: "https://www.maxfashion.com/ae/en/buy-minnie-mouse-print-tshirt-and-short-leggings-set/p/B26KIGFECHAR324AEEXWHITELIGHT",
    expected: "max",
  },
  {
    name: "Marks & Spencer - Romper",
    url: "https://www.marksandspencerme.com/en-ae/l/pure-cotton-romper-with-bib-0-3-yrs-/p/T784671D",
    expected: "marks_and_spencer",
  },
  {
    name: "Primark - Top & Shorts",
    url: "https://www.primark.com/en-us/p/0-36mths-shirred-top-and-shorts-set-blue-991167715505",
    expected: "primark",
  },
  {
    name: "Carter's - Baby Dress",
    url: "https://ae.carters.com/purelysoft-baby-girls-flamingo-print-dress-ivory-1u662210/",
    expected: "unknown", // Not in default profiles
  },
  {
    name: "Adidas - Shoes",
    url: "https://www.adidas.ae/en/adidas-disney-sl-72-rs-elastic-lace-shoes/IH1707.html",
    expected: "unknown", // Not in default profiles
  },
  {
    name: "Shein - Baby Set (Arabic)",
    url: "https://ar.shein.com/SHEIN-3pcs-Set-Unisex-Baby-Boy-Girl-Cute-Bear-Pattern-Blue-Sleeveless-Vest-White-Short-Sleeve-Shirt-And-Navy-Blue-Shorts-Set-Spring-Summer-Baby-Boy-Clothes-Outfits-Easter-Gift-Sthings-For-Baby-Toddler-Summer-Outfits-Toddler-Two-Piece-Set-p-380067052.html",
    expected: "shein",
    shouldFail: true, // Shein is restricted
  },
  {
    name: "Lefties - Dress",
    url: "https://www.lefties.com/xe/kids/girl/new-in/embroidered-textured-dress-c1030267676p732631353.html?colorId=653&parentId=732634941",
    expected: "lefties",
  },
  {
    name: "H&M - Baby Set",
    url: "https://eg.hm.com/en/buy-2-piece-cotton-set-light-blue-cream",
    expected: "hm",
  },
  {
    name: "Centrepoint - T-shirt & Dungaree",
    url: "https://www.centrepointstores.com/ae/en/buy-juniors-round-neck-short-sleeve-tshirt-and-dungaree-set-with-alligator-applique/p/K31-A15-13-427MULTICOLORMULTISHADE",
    expected: "centrepoint",
  },
];

interface TestResult {
  name: string;
  url: string;
  brandDetected: string;
  brandExpected: string;
  success: boolean;
  error?: string;
  product?: any;
  confidence?: number;
  extractionMode?: string;
  timeMs?: number;
  rateLimit?: {
    profile: string;
    maxRequestsPerMinute: number;
    minDelayMs: number;
  };
}

async function testUrl(testCase: {
  name: string;
  url: string;
  expected: string;
  shouldFail?: boolean;
}): Promise<TestResult> {
  const brandDetector = new BrandDetector();
  const startTime = Date.now();

  logInfo(`Testing: ${testCase.name}`);
  logDebug(`URL: ${testCase.url}`);

  try {
    // Detect brand
    const brandInfo = brandDetector.detectBrand(testCase.url);
    const brandKey = brandInfo.brandKey || "unknown";
    const brandName = brandInfo.brandName || "Unknown Brand";

    logDebug(`Brand: ${brandName} (${brandKey})`);

    // Get brand profile
    const profile = brandLimitManager.getProfile(brandKey);
    logDebug(`Profile: ${brandLimitManager.getProfileSummary(brandKey)}`);

    // Check if brand is restricted
    if (profile.maxConcurrency === 0) {
      logWarning(`Brand is RESTRICTED (maxConcurrency = 0)`);
      if (testCase.shouldFail) {
        logSuccess(`Expected restriction - skipping extraction`);
        return {
          name: testCase.name,
          url: testCase.url,
          brandDetected: brandKey,
          brandExpected: testCase.expected,
          success: true,
          error: "Brand is restricted (expected)",
          rateLimit: {
            profile: brandLimitManager.getProfileSummary(brandKey),
            maxRequestsPerMinute: profile.maxRequestsPerMinute,
            minDelayMs: profile.minDelayMs,
          },
          timeMs: Date.now() - startTime,
        };
      }
    }

    // Prepare extraction input
    const input: SourceInput = {
      url: testCase.url,
      sourceType: "product_url",
      mode: "auto",
    };

    // Test extraction
    logDebug(`Starting extraction with mode: ${profile.defaultMode}`);
    const result = await productExtractionEngine.extract(input);

    if (!result.ok) {
      logError(`Extraction failed: ${result.status}`);
      return {
        name: testCase.name,
        url: testCase.url,
        brandDetected: brandKey,
        brandExpected: testCase.expected,
        success: false,
        error: result.status,
        rateLimit: {
          profile: brandLimitManager.getProfileSummary(brandKey),
          maxRequestsPerMinute: profile.maxRequestsPerMinute,
          minDelayMs: profile.minDelayMs,
        },
        timeMs: Date.now() - startTime,
      };
    }

    const product = result.products?.[0];
    if (!product) {
      logError(`No product extracted`);
      return {
        name: testCase.name,
        url: testCase.url,
        brandDetected: brandKey,
        brandExpected: testCase.expected,
        success: false,
        error: "No product data",
        rateLimit: {
          profile: brandLimitManager.getProfileSummary(brandKey),
          maxRequestsPerMinute: profile.maxRequestsPerMinute,
          minDelayMs: profile.minDelayMs,
        },
        timeMs: Date.now() - startTime,
      };
    }

    logSuccess(`Extracted: ${product.title}`);
    logDebug(`Price: ${product.currency} ${product.price}`);
    logDebug(`Images: ${product.media?.images?.length || 0}`);
    logDebug(`Variants: ${product.variants?.length || 0}`);
    logDebug(`Confidence: ${product.confidence?.overall || 0}%`);

    return {
      name: testCase.name,
      url: testCase.url,
      brandDetected: brandKey,
      brandExpected: testCase.expected,
      success: true,
      product: {
        title: product.title,
        price: product.price,
        currency: product.currency,
        images: product.media?.images?.length,
        variants: product.variants?.length,
      },
      confidence: product.confidence?.overall,
      extractionMode: profile.defaultMode,
      rateLimit: {
        profile: brandLimitManager.getProfileSummary(brandKey),
        maxRequestsPerMinute: profile.maxRequestsPerMinute,
        minDelayMs: profile.minDelayMs,
      },
      timeMs: Date.now() - startTime,
    };
  } catch (error: any) {
    logError(`Error: ${error.message}`);
    const brandInfo = brandDetector.detectBrand(testCase.url);
    const brandKey = brandInfo.brandKey || "unknown";
    const profile = brandLimitManager.getProfile(brandKey);

    return {
      name: testCase.name,
      url: testCase.url,
      brandDetected: brandKey,
      brandExpected: testCase.expected,
      success: false,
      error: error.message || "Unknown error",
      rateLimit: {
        profile: brandLimitManager.getProfileSummary(brandKey),
        maxRequestsPerMinute: profile.maxRequestsPerMinute,
        minDelayMs: profile.minDelayMs,
      },
      timeMs: Date.now() - startTime,
    };
  }
}

async function main() {
  logSection("🚀 Brand Limit & Rate Limiting Test Suite");

  logInfo(`Testing ${TEST_URLS.length} URLs across multiple retailers`);
  logInfo(`Starting at ${new Date().toLocaleString()}\n`);

  const results: TestResult[] = [];

  for (let i = 0; i < TEST_URLS.length; i++) {
    console.log(`\n[${i + 1}/${TEST_URLS.length}]`);
    const testCase = TEST_URLS[i];
    const result = await testUrl(testCase);
    results.push(result);

    // Log brand profile
    if (result.rateLimit) {
      logDebug(
        `Rate Limit: ${result.rateLimit.maxRequestsPerMinute}/min, Delay: ${result.rateLimit.minDelayMs}ms`,
      );
    }

    console.log();
  }

  // Summary
  logSection("📊 Test Results Summary");

  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  logSuccess(`Successful: ${successful.length}/${results.length}`);
  if (failed.length > 0) {
    logWarning(`Failed: ${failed.length}/${results.length}`);
  }

  // Results table
  console.log("\n" + "─".repeat(120));
  console.log(
    `${colors.bright}${"Test".padEnd(30)}${"Brand".padEnd(15)}${"Status".padEnd(12)}${"Confidence".padEnd(12)}${"Time (ms)".padEnd(12)}${"Mode".padEnd(15)}${colors.reset}`,
  );
  console.log("─".repeat(120));

  for (const result of results) {
    const status = result.success
      ? colors.green + "✓ OK" + colors.reset
      : colors.red + "✗ FAIL" + colors.reset;
    const confidence = result.confidence ? `${result.confidence}%` : "—";
    const mode = result.extractionMode || "—";

    console.log(
      `${result.name.padEnd(30)}${result.brandDetected.padEnd(15)}${status.padEnd(20)}${confidence.padEnd(12)}${result.timeMs?.toString().padEnd(12)}${mode.padEnd(15)}`,
    );

    if (result.error && !result.success) {
      logDebug(`Error: ${result.error}`);
    }
  }

  console.log("─".repeat(120) + "\n");

  // Brand profile summary
  logSection("📋 Brand Profiles Applied");
  const uniqueBrands = [...new Set(results.map((r) => r.brandDetected))];

  for (const brandKey of uniqueBrands) {
    const profile = brandLimitManager.getProfile(brandKey);
    console.log(`\n${colors.bright}${brandKey.toUpperCase()}${colors.reset}`);
    logDebug(`Mode: ${profile.defaultMode}`);
    logDebug(`Concurrency: ${profile.maxConcurrency}`);
    logDebug(`Delay: ${profile.minDelayMs}ms`);
    logDebug(`Rate Limit: ${profile.maxRequestsPerMinute}/min`);
    logDebug(`Products/Run: ${profile.maxProductsPerRun}`);
    logDebug(`Pages/Run: ${profile.maxPagesPerRun}`);
    if (profile.notes.length > 0) {
      logDebug(`Notes: ${profile.notes.join(", ")}`);
    }
  }

  // Stats
  logSection("📈 Statistics");
  const totalTime = results.reduce((sum, r) => sum + (r.timeMs || 0), 0);
  const avgTime = totalTime / results.length;
  const avgConfidence =
    successful.reduce((sum, r) => sum + (r.confidence || 0), 0) /
    successful.length;

  logInfo(`Total Time: ${totalTime}ms`);
  logInfo(`Average Time per URL: ${avgTime.toFixed(0)}ms`);
  logInfo(`Average Confidence: ${avgConfidence.toFixed(1)}%`);
  logInfo(
    `Success Rate: ${((successful.length / results.length) * 100).toFixed(1)}%`,
  );

  logSection("✅ Test Complete!");
  logInfo(`Tested at ${new Date().toLocaleString()}`);
}

main().catch((error) => {
  logError(`Fatal error: ${error.message}`);
  process.exit(1);
});
