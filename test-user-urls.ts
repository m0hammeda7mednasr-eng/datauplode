import { ScraperService } from "./src/server/services/scraper";
import * as fs from "fs";

const testUrls = [
  { name: "Max Fashion", url: "https://www.maxfashion.com/ae/en/buy-stitch-embroidered-denim-dungaree-with-tshirt/p/B26KIBFEDTRDUNG147MULTICOLORMEDIUM" },
  { name: "Next UAE (su759706)", url: "https://www.next.ae/en/style/su759706/w59264#w59264" },
  { name: "M&S UAE", url: "https://www.marksandspencerme.com/en-ae/l/denim-striped-bibshort-with-t-shirt-0-3-yrs-/p/T784681D" },
  { name: "H&M UAE", url: "https://ae.hm.com/en/buy-2-piece-set-light-blue-white-striped" },
  { name: "Mothercare", url: "https://www.mothercare.ae/en/buy-3-pack-mothercare-newborn-bibs-4" },
  { name: "Zara", url: "https://www.zara.com/ae/en/-p01473692.html?v1=511134201" },
  { name: "Centrepoint", url: "https://www.centrepointstores.com/ae/en/buy-juniors-round-neck-short-sleeve-tshirt-and-dungaree-set-with-alligator-applique/p/K31-A15-13-427MULTICOLORMULTISHADE" },
  { name: "Next UAE (sv124809)", url: "https://www.next.ae/en/style/sv124809/g44412#g44412" },
];

function validate(product: Awaited<ReturnType<ScraperService["scrape"]>>) {
  const issues: string[] = [];
  if (!product.title?.trim()) issues.push("missing title");
  if (!product.price || product.price <= 0) issues.push(`invalid price: ${product.price}`);
  if (!product.currency?.trim()) issues.push("missing currency");
  if (!product.images?.length) issues.push("no images");
  if (!product.variants?.length) issues.push("no variants");
  return issues;
}

function isSnapshotRequiredError(error: unknown) {
  const typedError = error as {
    code?: string;
    retryWithSnapshot?: boolean;
    message?: string;
  };
  const message = String(typedError?.message || "");
  return (
    typedError?.code === "SOURCE_BLOCKED" ||
    typedError?.retryWithSnapshot === true ||
    /blocked automated server access|http 403/i.test(message)
  );
}

async function main() {
  const scraper = new ScraperService();
  const results: Record<string, unknown>[] = [];

  for (const { name, url } of testUrls) {
    process.stdout.write(`\n[${name}] scraping...\n`);
    try {
      const start = Date.now();
      const product = await scraper.scrape(url);
      const issues = validate(product);
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
      if (isSnapshotRequiredError(e)) {
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
