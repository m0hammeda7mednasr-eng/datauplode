import * as cheerio from "cheerio";
import { prisma } from "../src/server/db.js";
import { applyDeterministicDabSkus } from "../src/server/services/dabSku.js";
import { ScraperService } from "../src/server/services/scraper.js";
import { ShopifyService } from "../src/server/services/shopify.js";

function clean(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function htmlText(value: unknown) {
  return clean(cheerio.load(String(value || "")).text());
}

function parseRaw(value: string | null | undefined) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function moneyClose(left: unknown, right: unknown) {
  return Math.abs(Number(left) - Number(right)) < 0.01;
}

const sourceProductId = clean(process.env.SOURCE_PRODUCT_ID);
const candidate = await prisma.sourceProduct.findFirst({
  where: {
    ...(sourceProductId ? { id: sourceProductId } : {}),
    url: { contains: "centrepointstores.com", mode: "insensitive" },
    shopifyProduct: { is: { syncEnabled: true } },
    raw: { contains: "sheetPriceMultiplier" },
    createdAt: { lt: new Date("2026-09-01T00:00:00.000Z") },
  },
  orderBy: { updatedAt: "asc" },
  include: {
    variants: { include: { shopifyVariant: true } },
    images: true,
    shopifyProduct: true,
  },
});

if (!candidate?.shopifyProduct) {
  throw new Error("No linked pre-existing Centrepoint canary with sheet metadata was found");
}

const raw = parseRaw(candidate.raw);
const multiplier = Number(raw?.import?.sheetPriceMultiplier);
if (![22, 23, 24].includes(multiplier)) {
  throw new Error("Canary does not have an approved sheet multiplier");
}

const fresh = await new ScraperService().scrape(candidate.url);
applyDeterministicDabSkus({
  product: fresh,
  url: candidate.url,
  multiplier,
});

const client = await ShopifyService.getClientFromDb(prisma);
const live = await ShopifyService.getProductCatalogSnapshot(
  client,
  candidate.shopifyProduct.shopifyId,
);
if (!live) throw new Error("Linked Shopify canary no longer exists");

const liveBySku = new Map(
  live.variants.map((variant: any) => [clean(variant.sku).toLowerCase(), variant]),
);
const variantChecks = fresh.variants.map((variant: any) => {
  const sku = clean(variant.sku);
  const current: any = liveBySku.get(sku.toLowerCase());
  const expectedPrice = Number(variant.price || fresh.price) * multiplier;
  return {
    sku,
    linked: Boolean(current),
    expectedPrice,
    livePrice: current ? Number(current.price) : null,
    priceMatches: Boolean(current && moneyClose(current.price, expectedPrice)),
    expectedAvailable: variant.available !== false && variant.stockStatus !== "out_of_stock",
    liveQuantity: current ? Number(current.inventoryQuantity) : null,
    options: variant.optionValues || { color: variant.color, size: variant.size },
  };
});

const report = {
  auditedAt: new Date().toISOString(),
  readOnly: true,
  sourceProductId: candidate.id,
  shopifyProductId: candidate.shopifyProduct.shopifyId,
  url: candidate.url,
  multiplier,
  source: {
    title: fresh.title,
    descriptionText: htmlText(fresh.description),
    images: fresh.images.length,
    variants: fresh.variants.length,
  },
  shopify: {
    title: live.title,
    descriptionText: htmlText(live.descriptionHtml),
    images: live.media.length,
    variants: live.variants.length,
    status: live.status,
  },
  checks: {
    titleMatches: clean(fresh.title).toLowerCase() === clean(live.title).toLowerCase(),
    descriptionMatches:
      htmlText(fresh.description).toLowerCase() === htmlText(live.descriptionHtml).toLowerCase(),
    imageCountMatches: fresh.images.length === live.media.length,
    variantCountMatches: fresh.variants.length === live.variants.length,
    variantsLinkedBySku: variantChecks.every((variant) => variant.linked),
    pricesMatch: variantChecks.every((variant) => variant.priceMatches),
  },
  variants: variantChecks,
};

console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();
