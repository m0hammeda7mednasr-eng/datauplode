/**
 * سكريبت تست احترافي للسكرابينج
 * Professional Scraper Testing Script
 */

import { ScraperService } from "./src/server/services/scraper";

// ألوان للـ console output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

function log(message: string, color: string = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logSection(title: string) {
  console.log("\n" + "=".repeat(60));
  log(title, colors.bright + colors.cyan);
  console.log("=".repeat(60) + "\n");
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

// URLs للتست
const testUrls = [
  {
    name: "Next.co.uk Product",
    url: "https://www.nextdirect.com/eg/ar/style/su864117/y13998#y13998",
    supplier: "Next",
  },
  {
    name: "Next UAE Product",
    url: "https://www.next.ae/en/style/su827809/v18422",
    supplier: "Next",
  },
  {
    name: "Generic E-commerce Demo Site",
    url: "https://webscraper.io/test-sites/e-commerce/static/product/60",
    supplier: "Generic",
  },
];

async function testScraper() {
  logSection("🚀 بدء اختبار السكرابينج / Starting Scraper Tests");

  const scraperService = new ScraperService();
  const results: any[] = [];

  for (const testCase of testUrls) {
    logSection(`📦 اختبار: ${testCase.name}`);
    logInfo(`URL: ${testCase.url}`);
    logInfo(`المورد المتوقع / Expected Supplier: ${testCase.supplier}`);

    try {
      log("\n⏳ جاري السكرابينج... / Scraping in progress...\n", colors.yellow);

      const startTime = Date.now();
      const product = await scraperService.scrape(testCase.url);
      const duration = Date.now() - startTime;

      logSuccess(`تم السكرابينج بنجاح في ${duration}ms`);

      // عرض النتائج
      console.log("\n📊 نتائج السكرابينج / Scraping Results:");
      console.log("─".repeat(60));

      log(`العنوان / Title: ${product.title}`, colors.bright);
      log(`المورد / Supplier: ${product.source.supplier}`);
      log(`السعر / Price: ${product.price} ${product.currency}`);
      log(`البراند / Brand: ${product.brand || "N/A"}`);
      log(`عدد الصور / Images: ${product.images.length}`);
      log(`عدد الـ Variants: ${product.variants.length}`);

      if (product.description) {
        const shortDesc = product.description.substring(0, 100);
        log(
          `الوصف / Description: ${shortDesc}${product.description.length > 100 ? "..." : ""}`,
        );
      }

      // عرض الـ Variants
      if (product.variants.length > 0) {
        console.log("\n🔄 Variants:");
        product.variants.slice(0, 3).forEach((variant, idx) => {
          console.log(
            `  ${idx + 1}. SKU: ${variant.sku || "N/A"} | Price: ${variant.price || product.price} | Available: ${variant.available ? "✓" : "✗"} | Stock: ${variant.stockStatus}`,
          );
        });
        if (product.variants.length > 3) {
          log(
            `  ... و ${product.variants.length - 3} variants أخرى`,
            colors.cyan,
          );
        }
      }

      // عرض الصور
      if (product.images.length > 0) {
        console.log("\n🖼️  الصور / Images:");
        product.images.slice(0, 3).forEach((img, idx) => {
          console.log(
            `  ${idx + 1}. ${img.url.substring(0, 80)}${img.url.length > 80 ? "..." : ""}`,
          );
        });
        if (product.images.length > 3) {
          log(`  ... و ${product.images.length - 3} صور أخرى`, colors.cyan);
        }
      }

      // اختبار الـ Availability
      console.log("\n🔍 اختبار التوفر / Testing Availability...");
      const availability = await scraperService.checkAvailability(testCase.url);
      log(
        `متوفر / Available: ${availability.available ? "✓ نعم" : "✗ لا"}`,
        availability.available ? colors.green : colors.red,
      );

      results.push({
        name: testCase.name,
        success: true,
        duration,
        product,
        availability,
      });
    } catch (error: any) {
      logError(`فشل السكرابينج / Scraping Failed: ${error.message}`);
      console.error(error);

      results.push({
        name: testCase.name,
        success: false,
        error: error.message,
      });
    }
  }

  // ملخص النتائج
  logSection("📈 ملخص النتائج / Results Summary");

  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  log(`إجمالي الاختبارات / Total Tests: ${results.length}`, colors.bright);
  logSuccess(`نجح / Successful: ${successful}`);
  if (failed > 0) {
    logError(`فشل / Failed: ${failed}`);
  }

  if (successful > 0) {
    const avgDuration =
      results.filter((r) => r.success).reduce((sum, r) => sum + r.duration, 0) /
      successful;
    logInfo(`متوسط الوقت / Average Duration: ${avgDuration.toFixed(0)}ms`);
  }

  console.log("\n" + "=".repeat(60) + "\n");

  // حفظ النتائج في ملف JSON
  const fs = await import("fs");
  const outputPath = "./scraper-test-results.json";
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf-8");
  logSuccess(`تم حفظ النتائج في / Results saved to: ${outputPath}`);
  if (failed > 0) {
    throw new Error(`${failed} scraper test(s) failed`);
  }
}

// تشغيل الاختبار
testScraper()
  .then(() => {
    logSuccess("\n✅ اكتمل الاختبار بنجاح / Test completed successfully");
    process.exit(0);
  })
  .catch((error) => {
    logError("\n❌ حدث خطأ في الاختبار / Test failed with error");
    console.error(error);
    process.exit(1);
  });
