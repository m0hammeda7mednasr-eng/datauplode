import * as cheerio from "cheerio";
import type { PrismaClient } from "@prisma/client";
import { applyDeterministicDabSkus } from "./dabSku.js";
import {
  isLikelyProductImageSource,
  ScraperService,
  type NormalizedProduct,
} from "./scraper.js";
import { ShopifyService, type ShopifyGraphqlClient } from "./shopify.js";
import { getApprovedSheetMultiplier } from "./sheetMultiplier.js";

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

function isSupportedCatalogSource(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const supportedHosts = [
      "www.maxfashion.com",
      "maxfashion.com",
      "www.centrepointstores.com",
      "centrepointstores.com",
      "www.next.ae",
      "next.ae",
      "ae.hm.com",
      "www.mothercare.ae",
      "mothercare.ae",
      "www.lefties.com",
      "lefties.com",
      "www.marksandspencerme.com",
      "marksandspencerme.com",
      "www.marksandspencer.ae",
      "marksandspencer.ae",
      "www.zara.com",
      "zara.com",
      "www.ae.carters.com",
      "ae.carters.com",
      "www.adidas.ae",
      "adidas.ae",
    ];
    return supportedHosts.includes(host);
  } catch {
    return false;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function filenameFor(url: string, index: number) {
  try {
    const name = new URL(url).pathname.split("/").filter(Boolean).at(-1);
    return clean(name) || `product-${index + 1}.jpg`;
  } catch {
    return `product-${index + 1}.jpg`;
  }
}

function sourceScrapeTimeoutMs() {
  const configured = Number(process.env.SYNC_FULL_CATALOG_SCRAPE_TIMEOUT_MS || 120_000);
  if (!Number.isFinite(configured)) return 120_000;
  return Math.min(180_000, Math.max(30_000, Math.floor(configured)));
}

const SOLD_OUT_CONFIRMATION_ACTION = "SYNC_SOURCE_SOLD_OUT_CONFIRMATION";
const SOLD_OUT_DELETED_ACTION = "SYNC_SOURCE_SOLD_OUT_DELETED";

function soldOutDeletionEnabled() {
  return String(process.env.SYNC_SOLD_OUT_DELETE_ENABLED || "").toLowerCase() === "true";
}

function requiredSoldOutConfirmations() {
  const configured = Number(process.env.SYNC_SOLD_OUT_DELETE_CONFIRMATIONS || 2);
  if (!Number.isFinite(configured)) return 2;
  return Math.min(3, Math.max(2, Math.floor(configured)));
}

function allVariantsSoldOut(product: NormalizedProduct) {
  return product.variants.length > 0 && product.variants.every(
    (variant) => variant.available === false || variant.stockStatus === "out_of_stock",
  );
}

async function deleteConfirmedSoldOutProduct(options: {
  prisma: PrismaClient;
  client: ShopifyGraphqlClient;
  sourceProduct: any;
  fresh: NormalizedProduct;
  oldRaw: any;
}) {
  const { prisma, client, sourceProduct, fresh, oldRaw } = options;
  const sourceProductId = sourceProduct.id;
  const shopifyProductId = sourceProduct.shopifyProduct.shopifyId;
  const required = requiredSoldOutConfirmations();
  const lastHealthySync = await prisma.auditLog.findFirst({
    where: { sourceProductId, action: "SYNC_PRODUCT_CATALOG_SET" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const previousConfirmations = await prisma.auditLog.count({
    where: {
      sourceProductId,
      action: SOLD_OUT_CONFIRMATION_ACTION,
      ...(lastHealthySync ? { createdAt: { gt: lastHealthySync.createdAt } } : {}),
    },
  });
  const confirmation = previousConfirmations + 1;

  await prisma.auditLog.create({
    data: {
      sourceProductId,
      action: SOLD_OUT_CONFIRMATION_ACTION,
      userId: "System",
      details: JSON.stringify({
        confirmation,
        required,
        sourceUrl: sourceProduct.url,
        variants: fresh.variants.length,
        confirmedAt: new Date().toISOString(),
      }),
    },
  });

  if (confirmation < required) {
    throw new Error(`Source sold out confirmation ${confirmation}/${required}; Shopify deletion deferred`);
  }

  const before = await ShopifyService.getProductBasic(client, shopifyProductId).catch(() => null);
  if (before) await ShopifyService.deleteProduct(client, shopifyProductId);

  let readback = before;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    readback = await ShopifyService.getProductBasic(client, shopifyProductId).catch(() => null);
    if (!readback) break;
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }
  if (readback) throw new Error("Sold-out Shopify deletion could not be verified");

  await prisma.$executeRawUnsafe(`
    UPDATE "ShopifyCatalogIndexV2"
    SET "status" = 'DELETED',
        "matchStatus" = 'deleted',
        "reason" = 'source_sold_out_confirmed_deleted',
        "updatedAt" = NOW()
    WHERE "shopifyId" = $1
  `, shopifyProductId).catch(() => undefined);

  await prisma.$transaction(async (tx) => {
    await tx.shopifyVariant.deleteMany({
      where: { shopifyProductId: sourceProduct.shopifyProduct.id },
    });
    await tx.shopifyProduct.delete({
      where: { id: sourceProduct.shopifyProduct.id },
    });
    await tx.sourceVariant.updateMany({
      where: { sourceProductId },
      data: { available: false, stockStatus: "out_of_stock" },
    });
    await tx.sourceProduct.update({
      where: { id: sourceProductId },
      data: {
        syncStatus: "paused",
        lastScrapedAt: new Date(),
        raw: JSON.stringify({
          ...oldRaw,
          soldOutDeletion: {
            confirmed: true,
            confirmations: confirmation,
            deletedAt: new Date().toISOString(),
            shopifyProductId,
          },
        }),
      },
    });
    await tx.auditLog.create({
      data: {
        sourceProductId,
        action: SOLD_OUT_DELETED_ACTION,
        userId: "System",
        details: JSON.stringify({
          shopifyProductId,
          sourceUrl: sourceProduct.url,
          confirmations: confirmation,
          deleteReadbackVerified: true,
          deletedAt: new Date().toISOString(),
        }),
      },
    });
  }, { maxWait: 10_000, timeout: 30_000 });

  return {
    success: true,
    deleted: true,
    soldOut: true,
    sourceProductId,
    shopifyProductId,
    confirmations: confirmation,
    readbackVerified: true,
  };
}

function optionValueForVariant(variant: NormalizedProduct["variants"][number], optionName: string) {
  return clean(
    variant.optionValues?.[optionName] ||
    variant.optionValues?.[optionName.toLowerCase()] ||
    (/colou?r/i.test(optionName) ? variant.color : variant.size) ||
    "Default",
  ).toLowerCase();
}

function dedupeVariantsByOptionValues(product: NormalizedProduct) {
  const optionNames = product.options.map((option) => clean(option.name)).filter(Boolean);
  if (optionNames.length === 0) return;

  const seen = new Set<string>();
  product.variants = product.variants.filter((variant) => {
    const key = optionNames.map((optionName) => optionValueForVariant(variant, optionName)).join(" / ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function optionValuesKey(optionValues: Array<{ optionName: string; name: string }>) {
  return optionValues
    .map((value) => `${clean(value.optionName).toLowerCase()}:${clean(value.name).toLowerCase()}`)
    .join("|");
}

function selectedOptionsKey(selectedOptions: Array<{ name: string; value: string }>) {
  return (selectedOptions || [])
    .map((option) => `${clean(option.name).toLowerCase()}:${clean(option.value).toLowerCase()}`)
    .join("|");
}

function uniqueOptionValues(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = clean(value).toLowerCase();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function variantOptionValue(
  variant: NormalizedProduct["variants"][number],
  optionName: string,
  fallbackValues: Array<{ name: string }> = [],
) {
  return clean(
    variant.optionValues?.[optionName] ||
    variant.optionValues?.[optionName.toLowerCase()] ||
    (/colou?r/i.test(optionName) ? variant.color : variant.size) ||
    (fallbackValues.length === 1 ? fallbackValues[0]?.name : ""),
  );
}

function validateFreshProduct(product: NormalizedProduct, multiplier: number) {
  if (![22, 23, 24].includes(multiplier)) {
    throw new Error("Product has no approved sheet multiplier");
  }
  if (product.raw?.nextSelectedSizeOnly) {
    throw new Error(
      "Next exposed only one selected size for a multi-size product. Full catalog sync was stopped before Shopify variant mutation.",
    );
  }
  if (
    product.currency !== "AED" ||
    product.price <= 1 ||
    !clean(product.title) ||
    !htmlText(product.description) ||
    product.images.length === 0 ||
    product.variants.length === 0 ||
    product.variants.length > 100
  ) {
    throw new Error("Fresh source failed the strict catalog quality gate");
  }
  const badImage = product.images.find(
    (image) => !isLikelyProductImageSource(image.url, image.alt),
  );
  if (badImage) throw new Error(`Suspicious source image rejected: ${badImage.url}`);

  const skus = product.variants.map((variant) => clean(variant.sku).toLowerCase());
  if (skus.some((sku) => !sku) || new Set(skus).size !== skus.length) {
    throw new Error("Fresh source has empty or duplicate deterministic SKUs");
  }

  const markupPattern = /<\/?(?:script|style|html|body)\b|javascript:|personalisationScript/i;
  if (markupPattern.test(clean(product.title)) || markupPattern.test(String(product.description || ""))) {
    throw new Error("Fresh source title or description contains executable markup");
  }

  const prices = product.variants.map((variant) => Number(variant.price || product.price));
  if (prices.some((price) => !Number.isFinite(price) || price <= 1 || price > 10_000)) {
    throw new Error("Fresh source contains an implausible or missing AED variant price");
  }
  const lowestPrice = Math.min(...prices);
  const highestPrice = Math.max(...prices);
  if (highestPrice / lowestPrice > 8) {
    throw new Error("Fresh source variant price spread is implausibly large");
  }

  const suspiciousOption = /(?:<[^>]+>|https?:\/\/|\b(?:aed|egp|price|add to|description|javascript|undefined|null)\b)/i;
  const optionValues = product.options.flatMap((option) => option.values.map((value) => clean(value)));
  const variantValues = product.variants.flatMap((variant) => [
    clean(variant.color),
    clean(variant.size),
    ...Object.values(variant.optionValues || {}).map((value) => clean(value)),
  ]).filter(Boolean);
  if (
    [...optionValues, ...variantValues].some((value) => value.length > 100 || suspiciousOption.test(value))
  ) {
    throw new Error("Fresh source contains a suspicious color or size value");
  }
  if (product.variants.length > 1 && variantValues.some((value) => /^default(?: title| 1)?$/i.test(value))) {
    throw new Error("Fresh multi-variant source contains a placeholder option value");
  }
}

export interface FullCatalogSyncOptions {
  prisma: PrismaClient;
  sourceProductId: string;
  client?: ShopifyGraphqlClient;
  location?: { id: string };
  requireVariantExpansion?: boolean;
}

export async function syncFullProductCatalog(options: FullCatalogSyncOptions) {
  const { prisma, sourceProductId } = options;
  const product = await prisma.sourceProduct.findUnique({
    where: { id: sourceProductId },
    include: {
      supplier: true,
      variants: { include: { shopifyVariant: true } },
      images: true,
      shopifyProduct: { include: { variants: true } },
    },
  });
  if (!product?.shopifyProduct || !isSupportedCatalogSource(product.url)) {
    throw new Error("Only linked Max Fashion UAE, Centrepoint UAE, and Next UAE products are enabled for full catalog sync");
  }

  const oldRaw = parseRaw(product.raw);
  const multiplier = getApprovedSheetMultiplier(product);
  if (!multiplier) {
    throw new Error("Product has no approved sheet multiplier");
  }
  const fresh = await withTimeout(
    new ScraperService().scrape(product.url),
    sourceScrapeTimeoutMs(),
    "Fresh source scrape timed out before Shopify mutation",
  );
  applyDeterministicDabSkus({ product: fresh, url: product.url, multiplier });
  dedupeVariantsByOptionValues(fresh);
  validateFreshProduct(fresh, multiplier);

  const client = options.client || await ShopifyService.getClientFromDb(prisma);
  if (soldOutDeletionEnabled() && allVariantsSoldOut(fresh)) {
    return deleteConfirmedSoldOutProduct({
      prisma,
      client,
      sourceProduct: product,
      fresh,
      oldRaw,
    });
  }
  const location = options.location || await ShopifyService.getInventoryLocation(client);
  const shopifyProductId = product.shopifyProduct.shopifyId;
  const before = await ShopifyService.getProductCatalogSnapshot(client, shopifyProductId);
  if (!before || before.id !== shopifyProductId) {
    throw new Error("Linked Shopify product could not be read before mutation");
  }
  if (options.requireVariantExpansion && (before.variants.length > 1 || fresh.variants.length <= 1)) {
    return {
      success: true,
      skipped: true,
      sourceProductId,
      shopifyProductId,
      reason: before.variants.length > 1
        ? "Shopify product is no longer a single-variant candidate"
        : "Source is a genuine single-variant product",
      sourceVariants: fresh.variants.length,
      shopifyVariants: before.variants.length,
      readbackVerified: true,
    };
  }
  const existingBySku = new Map(
    before.variants.map((variant: any) => [clean(variant.sku).toLowerCase(), variant]),
  );

  const productOptions = fresh.options.map((option, position) => ({
    name: clean(option.name),
    position: position + 1,
    values: uniqueOptionValues(option.values).map((value) => ({ name: clean(value) })),
  }));
  if (
    productOptions.length === 0 ||
    productOptions.some((option) => !option.name || option.values.some((value) => !value.name))
  ) {
    throw new Error("Fresh source has invalid product options");
  }
  const completeFreshVariants = fresh.variants.filter((variant) =>
    productOptions.every((option) => variantOptionValue(variant, option.name, option.values)),
  );
  if (completeFreshVariants.length === 0) {
    throw new Error("Fresh source has no complete variants for its option set");
  }
  const existingByOptions = new Map<string, any>();
  for (const variant of before.variants) {
    const key = selectedOptionsKey(variant.selectedOptions || []);
    if (key && !existingByOptions.has(key)) existingByOptions.set(key, variant);
  }

  const files = fresh.images.map((image, index) => ({
    originalSource: image.url,
    alt: clean(image.alt || fresh.title),
    filename: filenameFor(image.url, index),
    contentType: "IMAGE",
  }));
  const variants = completeFreshVariants.map((variant: any, index) => {
    const optionValues = productOptions.map((option) => ({
      optionName: option.name,
      name: variantOptionValue(variant, option.name, option.values),
    }));
    if (optionValues.some((value) => !value.name)) {
      throw new Error(`Variant has an empty option value: ${variant.sku}`);
    }
    const sku = clean(variant.sku);
    const existing: any = existingBySku.get(sku.toLowerCase()) || existingByOptions.get(optionValuesKey(optionValues));
    const imageUrl = clean(variant.imageUrl || fresh.images[0]?.url);
    return {
      ...(existing?.id ? { id: existing.id } : {}),
      optionValues,
      price: Number(variant.price || fresh.price) * multiplier,
      sku,
      position: index + 1,
      inventoryItem: { tracked: true },
      inventoryQuantities: [{
        locationId: location.id,
        name: "available",
        quantity: variant.available === false || variant.stockStatus === "out_of_stock" ? 0 : 10,
      }],
      ...(imageUrl ? {
        file: {
          originalSource: imageUrl,
          alt: clean(fresh.title),
          filename: filenameFor(imageUrl, index),
          contentType: "IMAGE",
        },
      } : {}),
    };
  });

  const response = await ShopifyService.setProductCatalog(client, shopifyProductId, {
    title: fresh.title,
    descriptionHtml: fresh.description || "",
    vendor: fresh.brand || fresh.source.supplier,
    status: "ACTIVE",
    productOptions,
    files,
    variants,
  });
  const errors = response.productSet?.userErrors || [];
  if (errors.length > 0) {
    throw new Error(`Shopify productSet rejected catalog sync: ${errors[0].message}`);
  }

  let verified: any = null;
  let verificationError = "Shopify catalog read-back did not converge";
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const live = await ShopifyService.getProductCatalogSnapshot(client, shopifyProductId);
    const liveBySku = new Map(
      (live?.variants || []).map((variant: any) => [clean(variant.sku).toLowerCase(), variant]),
    );
    const variantsMatch = variants.every((expected) => {
      const actual: any = liveBySku.get(expected.sku.toLowerCase());
      return Boolean(
        actual &&
        Math.abs(Number(actual.price) - Number(expected.price)) < 0.01 &&
        Number(actual.inventoryQuantity) === Number(expected.inventoryQuantities[0].quantity),
      );
    });
    if (
      live?.id === shopifyProductId &&
      clean(live.title).toLowerCase() === clean(fresh.title).toLowerCase() &&
      htmlText(live.descriptionHtml).toLowerCase() === htmlText(fresh.description).toLowerCase() &&
      live.media.length === files.length &&
      live.variants.length === variants.length &&
      variantsMatch
    ) {
      verified = live;
      break;
    }
    verificationError = JSON.stringify({
      title: live?.title,
      images: live?.media?.length,
      variants: live?.variants?.length,
      variantsMatch,
    });
    if (attempt < 8) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
  }
  if (!verified) {
    throw new Error(`Catalog write could not be verified: ${verificationError}`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.shopifyVariant.deleteMany({
      where: { shopifyProductId: product.shopifyProduct!.id },
    });
    await tx.sourceVariant.deleteMany({ where: { sourceProductId } });
    await tx.sourceImage.deleteMany({ where: { sourceProductId } });
    await tx.sourceProduct.update({
      where: { id: sourceProductId },
      data: {
        productId: fresh.source.productId,
        title: fresh.title,
        description: fresh.description,
        brand: fresh.brand || fresh.source.supplier,
        currency: fresh.currency,
        price: fresh.price,
        syncStatus: "active",
        lastScrapedAt: new Date(),
        raw: JSON.stringify({
          options: fresh.options,
          raw: fresh.raw,
          import: oldRaw.import || {},
        }),
        images: {
          create: fresh.images.map((image, position) => ({
            url: image.url,
            alt: image.alt,
            color: image.color,
            position,
          })),
        },
      },
    });

    for (const [index, variant] of completeFreshVariants.entries()) {
      const sku = clean(variant.sku);
      const live: any = verified.variants.find(
        (entry: any) => clean(entry.sku).toLowerCase() === sku.toLowerCase(),
      );
      if (!live) throw new Error(`Verified Shopify variant missing during DB link: ${sku}`);
      const sourceVariant = await tx.sourceVariant.create({
        data: {
          sourceProductId,
          sourceVariantId: variant.sourceVariantId || `${fresh.source.productId}-${index}`,
          sku,
          color: variant.color,
          size: variant.size,
          price: Number(variant.price || fresh.price),
          currency: variant.currency || fresh.currency,
          available: variant.available !== false,
          stockStatus: variant.stockStatus || "unknown",
          imageUrl: variant.imageUrl || fresh.images[0]?.url,
          raw: JSON.stringify({ optionValues: variant.optionValues || {} }),
        },
      });
      await tx.shopifyVariant.create({
        data: {
          shopifyProductId: product.shopifyProduct!.id,
          sourceVariantId: sourceVariant.id,
          shopifyId: live.id,
          sku,
          price: Number(live.price),
        },
      });
    }

    await tx.shopifyProduct.update({
      where: { id: product.shopifyProduct!.id },
      data: {
        status: "active",
        handle: verified.handle,
        price: Number(variants[0].price),
        syncEnabled: true,
        syncPrice: true,
        syncInventory: true,
      },
    });
    await tx.manualReviewItem.updateMany({
      where: { sourceProductId, status: "pending" },
      data: { status: "approved", resolvedAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        sourceProductId,
        action: "SYNC_PRODUCT_CATALOG_SET",
        details: JSON.stringify({
          readbackVerified: true,
          variants: variants.length,
          images: files.length,
          multiplier,
        }),
      },
    });
  }, { maxWait: 10_000, timeout: 30_000 });

  return {
    success: true,
    sourceProductId,
    shopifyProductId,
    title: fresh.title,
    multiplier,
    images: files.length,
    variants: variants.length,
    readbackVerified: true,
  };
}
