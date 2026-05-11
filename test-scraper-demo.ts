/**
 * سكريبت تست احترافي للسكرابينج - نسخة تجريبية
 * Professional Scraper Testing Script - Demo Version
 */

import type { NormalizedProduct } from "./src/server/services/scraper";

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
};

function log(message: string, color: string = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logSection(title: string) {
  console.log("\n" + "=".repeat(70));
  log(title, colors.bright + colors.cyan);
  console.log("=".repeat(70) + "\n");
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

// دالة لإنشاء منتج تجريبي
function createMockProduct(): NormalizedProduct {
  return {
    source: {
      supplier: "Demo Store",
      url: "https://demo-store.example.com/products/test-product-123",
      productId: "DEMO-PROD-123",
    },
    title: "قميص رجالي كلاسيكي - Classic Men's Shirt",
    description:
      "قميص رجالي عالي الجودة مصنوع من القطن 100%. مناسب للمناسبات الرسمية والكاجوال. متوفر بألوان وأحجام متعددة.\n\nHigh-quality men's shirt made from 100% cotton. Suitable for formal and casual occasions. Available in multiple colors and sizes.",
    brand: "Premium Fashion",
    currency: "EGP",
    price: 599.99,
    images: [
      {
        url: "https://via.placeholder.com/1200x1200/2C3E50/FFFFFF?text=Front+View",
        position: 0,
        alt: "Front View",
        color: "Blue",
      },
      {
        url: "https://via.placeholder.com/1200x1200/34495E/FFFFFF?text=Side+View",
        position: 1,
        alt: "Side View",
      },
      {
        url: "https://via.placeholder.com/1200x1200/1ABC9C/FFFFFF?text=Detail",
        position: 2,
        alt: "Detail View",
      },
      {
        url: "https://via.placeholder.com/1200x1200/E74C3C/FFFFFF?text=Red+Variant",
        position: 3,
        alt: "Red Color Variant",
        color: "Red",
      },
    ],
    options: [
      { name: "Size", values: ["S", "M", "L", "XL", "XXL"] },
      {
        name: "Color",
        values: ["أزرق/Blue", "أحمر/Red", "أبيض/White", "أسود/Black"],
      },
    ],
    variants: [
      {
        sourceVariantId: "VAR-S-BLUE",
        sku: "SHIRT-S-BLUE-001",
        size: "S",
        color: "Blue",
        price: 599.99,
        available: true,
        stockStatus: "in_stock" as const,
        imageUrl:
          "https://via.placeholder.com/800x800/2C3E50/FFFFFF?text=S+Blue",
      },
      {
        sourceVariantId: "VAR-M-BLUE",
        sku: "SHIRT-M-BLUE-001",
        size: "M",
        color: "Blue",
        price: 599.99,
        available: true,
        stockStatus: "in_stock" as const,
        imageUrl:
          "https://via.placeholder.com/800x800/2C3E50/FFFFFF?text=M+Blue",
      },
      {
        sourceVariantId: "VAR-L-RED",
        sku: "SHIRT-L-RED-001",
        size: "L",
        color: "Red",
        price: 599.99,
        available: false,
        stockStatus: "out_of_stock" as const,
        imageUrl:
          "https://via.placeholder.com/800x800/E74C3C/FFFFFF?text=L+Red",
      },
      {
        sourceVariantId: "VAR-XL-BLACK",
        sku: "SHIRT-XL-BLACK-001",
        size: "XL",
        color: "Black",
        price: 649.99,
        available: true,
        stockStatus: "low_stock" as const,
        imageUrl:
          "https://via.placeholder.com/800x800/000000/FFFFFF?text=XL+Black",
      },
      {
        sourceVariantId: "VAR-XXL-WHITE",
        sku: "SHIRT-XXL-WHITE-001",
        size: "XXL",
        color: "White",
        price: 649.99,
        available: true,
        stockStatus: "in_stock" as const,
        imageUrl:
          "https://via.placeholder.com/800x800/FFFFFF/000000?text=XXL+White",
      },
    ],
    raw: {
      demo: true,
      timestamp: new Date().toISOString(),
      metadata: {
        scrapedAt: new Date().toISOString(),
        scraperVersion: "1.0.0",
        confidence: 0.95,
      },
    },
  };
}

// دالة لإنشاء منتج تجريبي آخر
function createMockProduct2(): NormalizedProduct {
  return {
    source: {
      supplier: "Tech Store",
      url: "https://tech-store.example.com/products/wireless-headphones",
      productId: "TECH-456",
    },
    title: "سماعات لاسلكية - Wireless Headphones Pro",
    description:
      "سماعات لاسلكية عالية الجودة مع خاصية إلغاء الضوضاء. بطارية تدوم حتى 30 ساعة.\n\nPremium wireless headphones with active noise cancellation. Battery life up to 30 hours.",
    brand: "AudioTech",
    currency: "EGP",
    price: 1299.0,
    images: [
      {
        url: "https://via.placeholder.com/1200x1200/3498DB/FFFFFF?text=Headphones",
        position: 0,
        alt: "Main View",
      },
      {
        url: "https://via.placeholder.com/1200x1200/2980B9/FFFFFF?text=Side+View",
        position: 1,
        alt: "Side View",
      },
    ],
    options: [{ name: "Color", values: ["Black", "Silver", "Rose Gold"] }],
    variants: [
      {
        sourceVariantId: "HP-BLACK",
        sku: "HP-001-BLK",
        color: "Black",
        price: 1299.0,
        available: true,
        stockStatus: "in_stock" as const,
      },
      {
        sourceVariantId: "HP-SILVER",
        sku: "HP-001-SLV",
        color: "Silver",
        price: 1299.0,
        available: true,
        stockStatus: "in_stock" as const,
      },
      {
        sourceVariantId: "HP-ROSE",
        sku: "HP-001-RSG",
        color: "Rose Gold",
        price: 1399.0,
        available: true,
        stockStatus: "low_stock" as const,
      },
    ],
    raw: { demo: true, timestamp: new Date().toISOString() },
  };
}

async function testScraperDemo() {
  logSection("🚀 بدء اختبار السكرابينج التجريبي / Starting Demo Scraper Tests");

  logInfo("هذا اختبار تجريبي يوضح كيفية عمل نظام السكرابينج");
  logInfo("This is a demo test showing how the scraping system works");

  const products = [
    { name: "منتج 1: قميص رجالي", product: createMockProduct() },
    { name: "منتج 2: سماعات لاسلكية", product: createMockProduct2() },
  ];

  const results: any[] = [];

  for (const { name, product } of products) {
    logSection(`📦 اختبار: ${name}`);

    try {
      const startTime = Date.now();

      // محاكاة وقت السكرابينج
      await new Promise((resolve) =>
        setTimeout(resolve, 500 + Math.random() * 1000),
      );

      const duration = Date.now() - startTime;

      logSuccess(`تم السكرابينج بنجاح في ${duration}ms`);

      // عرض النتائج
      console.log("\n📊 نتائج السكرابينج / Scraping Results:");
      console.log("─".repeat(70));

      log(`\n🏷️  العنوان / Title:`, colors.bright);
      log(`   ${product.title}`, colors.cyan);

      log(`\n🏪 المورد / Supplier: ${product.source.supplier}`, colors.magenta);
      log(`🔗 URL: ${product.source.url}`);
      log(`🆔 Product ID: ${product.source.productId}`);

      log(
        `\n💰 السعر / Price: ${product.price} ${product.currency}`,
        colors.green + colors.bright,
      );
      log(`🏭 البراند / Brand: ${product.brand || "N/A"}`);

      if (product.description) {
        const lines = product.description.split("\n").filter((l) => l.trim());
        log(`\n📝 الوصف / Description:`);
        lines.forEach((line) => log(`   ${line}`, colors.reset));
      }

      // عرض الـ Options
      if (product.options.length > 0) {
        log(`\n⚙️  الخيارات / Options:`, colors.yellow);
        product.options.forEach((opt, idx) => {
          log(
            `   ${idx + 1}. ${opt.name}: ${opt.values.join(", ")}`,
            colors.cyan,
          );
        });
      }

      // عرض الـ Variants
      if (product.variants.length > 0) {
        log(
          `\n🔄 المتغيرات / Variants (${product.variants.length} total):`,
          colors.yellow,
        );
        product.variants.forEach((variant, idx) => {
          const statusIcon = variant.available ? "✓" : "✗";
          const statusColor = variant.available ? colors.green : colors.red;
          const stockEmoji =
            variant.stockStatus === "in_stock"
              ? "📦"
              : variant.stockStatus === "low_stock"
                ? "⚠️"
                : "❌";

          log(
            `   ${idx + 1}. ${stockEmoji} SKU: ${variant.sku || "N/A"}`,
            colors.bright,
          );
          log(
            `      Size: ${variant.size || "N/A"} | Color: ${variant.color || "N/A"}`,
          );
          log(
            `      Price: ${variant.price || product.price} ${product.currency}`,
          );
          log(
            `      ${statusIcon} Available: ${variant.available ? "Yes" : "No"} | Stock: ${variant.stockStatus}`,
            statusColor,
          );
        });
      }

      // عرض الصور
      if (product.images.length > 0) {
        log(
          `\n🖼️  الصور / Images (${product.images.length} total):`,
          colors.yellow,
        );
        product.images.forEach((img, idx) => {
          const colorInfo = img.color ? ` [${img.color}]` : "";
          const altInfo = img.alt ? ` - ${img.alt}` : "";
          log(`   ${idx + 1}.${colorInfo}${altInfo}`, colors.cyan);
          log(`      ${img.url}`, colors.reset);
        });
      }

      // إحصائيات
      log(`\n📈 الإحصائيات / Statistics:`, colors.magenta);
      const availableVariants = product.variants.filter(
        (v) => v.available,
      ).length;
      const inStockVariants = product.variants.filter(
        (v) => v.stockStatus === "in_stock",
      ).length;
      const lowStockVariants = product.variants.filter(
        (v) => v.stockStatus === "low_stock",
      ).length;
      const outOfStockVariants = product.variants.filter(
        (v) => v.stockStatus === "out_of_stock",
      ).length;

      log(`   • Total Variants: ${product.variants.length}`);
      log(
        `   • Available: ${availableVariants} (${((availableVariants / product.variants.length) * 100).toFixed(1)}%)`,
        colors.green,
      );
      log(`   • In Stock: ${inStockVariants}`, colors.green);
      log(`   • Low Stock: ${lowStockVariants}`, colors.yellow);
      log(`   • Out of Stock: ${outOfStockVariants}`, colors.red);
      log(`   • Total Images: ${product.images.length}`);
      log(`   • Options: ${product.options.length}`);

      // حساب متوسط السعر
      const prices = product.variants.map((v) => v.price || product.price);
      const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
      const minPrice = Math.min(...prices);
      const maxPrice = Math.max(...prices);

      log(`\n💵 تحليل الأسعار / Price Analysis:`, colors.green);
      log(`   • Base Price: ${product.price} ${product.currency}`);
      log(`   • Min Price: ${minPrice} ${product.currency}`);
      log(`   • Max Price: ${maxPrice} ${product.currency}`);
      log(`   • Avg Price: ${avgPrice.toFixed(2)} ${product.currency}`);

      results.push({
        name,
        success: true,
        duration,
        product,
        stats: {
          totalVariants: product.variants.length,
          availableVariants,
          inStockVariants,
          lowStockVariants,
          outOfStockVariants,
          totalImages: product.images.length,
          priceRange: { min: minPrice, max: maxPrice, avg: avgPrice },
        },
      });
    } catch (error: any) {
      logError(`فشل السكرابينج / Scraping Failed: ${error.message}`);
      results.push({
        name,
        success: false,
        error: error.message,
      });
    }
  }

  // ملخص النتائج
  logSection("📈 ملخص النتائج النهائي / Final Results Summary");

  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  log(`📊 إجمالي الاختبارات / Total Tests: ${results.length}`, colors.bright);
  logSuccess(`✅ نجح / Successful: ${successful}`);
  if (failed > 0) {
    logError(`❌ فشل / Failed: ${failed}`);
  }

  if (successful > 0) {
    const avgDuration =
      results.filter((r) => r.success).reduce((sum, r) => sum + r.duration, 0) /
      successful;
    logInfo(`⏱️  متوسط الوقت / Average Duration: ${avgDuration.toFixed(0)}ms`);

    const totalVariants = results
      .filter((r) => r.success)
      .reduce((sum, r) => sum + r.stats.totalVariants, 0);
    logInfo(`🔄 إجمالي الـ Variants: ${totalVariants}`);

    const totalImages = results
      .filter((r) => r.success)
      .reduce((sum, r) => sum + r.stats.totalImages, 0);
    logInfo(`🖼️  إجمالي الصور: ${totalImages}`);
  }

  console.log("\n" + "=".repeat(70));

  // حفظ النتائج في ملف JSON
  const fs = await import("fs");
  const outputPath = "./scraper-demo-results.json";
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf-8");
  logSuccess(`💾 تم حفظ النتائج في / Results saved to: ${outputPath}`);

  // نصائح للاستخدام
  logSection("💡 نصائح للاستخدام / Usage Tips");
  log("1. استخدم URLs حقيقية للمنتجات في الكود الفعلي", colors.cyan);
  log("   Use real product URLs in actual code");
  log("\n2. تأكد من احترام robots.txt وشروط الاستخدام", colors.cyan);
  log("   Make sure to respect robots.txt and terms of service");
  log("\n3. استخدم rate limiting لتجنب حظر IP", colors.cyan);
  log("   Use rate limiting to avoid IP blocking");
  log("\n4. احفظ البيانات في قاعدة البيانات للاستخدام لاحقاً", colors.cyan);
  log("   Save data to database for later use");
  log("\n5. راجع الـ SETUP-GUIDE.md للمزيد من التفاصيل", colors.cyan);
  log("   Check SETUP-GUIDE.md for more details\n");
}

// تشغيل الاختبار
testScraperDemo()
  .then(() => {
    logSuccess(
      "\n✅ اكتمل الاختبار التجريبي بنجاح / Demo test completed successfully",
    );
    log(
      "\n🚀 الخطوة التالية: شغل المشروع بـ npm run dev",
      colors.bright + colors.green,
    );
    log(
      "🚀 Next step: Run the project with npm run dev\n",
      colors.bright + colors.green,
    );
    process.exit(0);
  })
  .catch((error) => {
    logError("\n❌ حدث خطأ في الاختبار / Test failed with error");
    console.error(error);
    process.exit(1);
  });
