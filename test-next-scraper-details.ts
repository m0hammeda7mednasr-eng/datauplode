import assert from "node:assert/strict";
import "dotenv/config";
import { ScraperService, type NormalizedProduct } from "./src/server/services/scraper";

const NEXT_AE_URL = "https://www.next.ae/en/style/su876474/y19782";

const nextAeSnapshot = `
7.6.0 1778850790396 next AE en 5.2.4 1778850559399 1826710

Search for anything here...

![Image: Abstract Toe Thong Slippers - Image 1 of 7](https://xcdn.next.co.uk/common/items/default/default/itemimages/3_4Ratio/product/lge/Y19782s.jpg?im=Resize,width=750)
![Image: Abstract Toe Thong Slippers - Image 2 of 7](https://xcdn.next.co.uk/common/items/default/default/itemimages/3_4Ratio/product/lge/Y19782s2.jpg?im=Resize,width=750)

# Abstract Toe Thong Slippers

AED59

Product Code: Y19-782

* * *

Size:

Choose Size

Add to Bag

## Description

Upper - Textile, Lining & Sock - Textile, Sole - Textile, Other Materials. Country of Origin: China

* * *

## Recently Viewed
`;

function variantSizes(product: NormalizedProduct): string[] {
  return product.variants.map(variant => variant.size).filter(Boolean) as string[];
}

function assertNextAeDetails(product: NormalizedProduct, expectedCurrency?: string, expectedSizes?: string[]) {
  assert.equal(product.source.supplier, "Next");
  assert.equal(product.source.url, NEXT_AE_URL);
  assert.equal(product.source.productId, "Y19-782");
  assert.equal(product.title, "Abstract Toe Thong Slippers");
  assert.equal(product.brand, "Next");
  assert.ok(product.description?.includes("Upper - Textile"), "description should include product materials");
  assert.ok(!product.description?.includes("xcdn.next.co.uk"), "description should not include image URLs");
  assert.ok(product.price > 0, "price should be positive");
  if (expectedCurrency) assert.equal(product.currency, expectedCurrency);
  assert.ok(product.images.length >= 2, "should extract product images");
  const sizes = product.options.find(option => option.name === "Size")?.values || [];
  if (expectedSizes) {
    assert.deepEqual(sizes, expectedSizes);
    assert.deepEqual(variantSizes(product), expectedSizes);
  } else {
    assert.ok(sizes.length >= 3, "live page should expose product sizes");
    assert.deepEqual(variantSizes(product), sizes);
  }

  for (const variant of product.variants) {
    assert.ok(variant.sourceVariantId?.startsWith("Y19-782-"));
    assert.ok(variant.sku?.startsWith("Y19-782-"));
    assert.equal(variant.available, true);
    assert.equal(variant.stockStatus, "in_stock");
    assert.equal(variant.price, product.price);
    assert.equal(variant.currency, product.currency);
    assert.equal(variant.optionValues?.Size, variant.size);
  }
}

async function runSnapshotTest(scraper: ScraperService) {
  const product = await scraper.scrapeSnapshot(NEXT_AE_URL, nextAeSnapshot);
  assertNextAeDetails(product, "AED", ["S", "M", "L"]);
  assert.equal(product.price, 59);
  assert.equal(product.raw.pastedSnapshotFallback, true);
  assert.equal(product.raw.sizesInferredFromProductType, true);
  console.log("Snapshot details test passed", {
    title: product.title,
    price: product.price,
    currency: product.currency,
    images: product.images.length,
    variants: product.variants.length,
  });
}

async function runLiveSmokeTest(scraper: ScraperService) {
  const product = await scraper.scrape(NEXT_AE_URL);
  assertNextAeDetails(product);
  assert.ok(["AED", "USD", "GBP", "EGP"].includes(product.currency), `unexpected currency ${product.currency}`);
  console.log("Live scrape smoke test passed", {
    title: product.title,
    price: product.price,
    currency: product.currency,
    images: product.images.length,
    variants: product.variants.length,
    regionalFallback: product.raw.regionalFallback,
    readerUrl: product.raw.readerUrl,
  });
}

const scraper = new ScraperService();
await runSnapshotTest(scraper);
await runLiveSmokeTest(scraper);
