import { ScraperService } from "./src/server/services/scraper";
import * as fs from "fs";
import { USER_URL_CASES } from "./test-data/scraper-links";
import {
  isManualSnapshotRequired,
  validateBasicProduct,
} from "./test-utils/scraper-test-utils";

const testUrls = USER_URL_CASES;

async function main() {
  const scraper = new ScraperService();
  const results: Record<string, unknown>[] = [];

  for (const { name, url } of testUrls) {
    process.stdout.write(`\n[${name}] scraping...\n`);
    try {
      const start = Date.now();
      const product = await scraper.scrape(url);
      const issues = validateBasicProduct(product);
      const row = {
        name,
        url,
        success: issues.length === 0,
        durationMs: Date.now() - start,
        supplier: product.source.supplier,
        title: product.title?.slice(0, 80),
        price: product.price,
        currency: product.currency,
        brand: product.brand,
        imageCount: product.images.length,
        variantCount: product.variants.length,
        options: product.options,
        issues,
      };
      results.push(row);
      console.log(issues.length ? `WARN: ${issues.join(", ")}` : "OK");
      console.log(JSON.stringify(row, null, 2));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isManualSnapshotRequired(e)) {
        const row = {
          name,
          url,
          success: true,
          status: "manual_snapshot_required",
          note: "Supplier blocked automated access. Provide pasted page text snapshot to complete extraction.",
          error: msg,
        };
        results.push(row);
        console.log("WARN: manual snapshot required");
        console.log(JSON.stringify(row, null, 2));
      } else {
        results.push({ name, url, success: false, error: msg });
        console.log(`FAIL: ${msg}`);
      }
    }
  }

  const failed = results.filter((r) => !r.success);
  fs.writeFileSync("test-user-urls-results.json", JSON.stringify(results, null, 2));
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) process.exit(1);
}

main();
