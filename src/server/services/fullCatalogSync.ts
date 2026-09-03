import * as cheerio from "cheerio";
import type { PrismaClient } from "@prisma/client";
import { applyDeterministicDabSkus } from "./dabSku.js";
import {
  isLikelyProductImageSource,
  ScraperService,
  type NormalizedProduct,
} from "./scraper.js";
import { ShopifyService, type ShopifyGraphqlClient } from "./shopify.js";

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
    return host === "www.centrepointstores.com" ||
      host === "centrepointstores.com" ||
      host === "www.next.ae" ||
      host === "next.ae";
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

function validateFreshProduct(product: NormalizedProduct, multiplier: number) {
  if (![22, 23, 24].includes(multiplier)) {
    throw new Error("Product has no approved sheet multiplier");
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
}

export interface FullCatalogSyncOptions {
  prisma: PrismaClient;
  sourceProductId: string;
  client?: ShopifyGraphqlClient;
  location?: { id: string };
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
    throw new Error("Only linked Centrepoint and Next UAE products are enabled for full catalog sync");
  }

  const oldRaw = parseRaw(product.raw);
  const multiplier = Number(oldRaw?.import?.sheetPriceMultiplier);
  const fresh = await withTimeout(
    new ScraperService().scrape(product.url),
    120_000,
    "Fresh source scrape timed out before Shopify mutation",
  );
  applyDeterministicDabSkus({ product: fresh, url: product.url, multiplier });
  validateFreshProduct(fresh, multiplier);

  const client = options.client || await ShopifyService.getClientFromDb(prisma);
  const location = options.location || await ShopifyService.getInventoryLocation(client);
  const shopifyProductId = product.shopifyProduct.shopifyId;
  const before = await ShopifyService.getProductCatalogSnapshot(client, shopifyProductId);
  if (!before || before.id !== shopifyProductId) {
    throw new Error("Linked Shopify product could not be read before mutation");
  }
  const existingBySku = new Map(
    before.variants.map((variant: any) => [clean(variant.sku).toLowerCase(), variant]),
  );

  const productOptions = fresh.options.map((option, position) => ({
    name: clean(option.name),
    position: position + 1,
    values: option.values.map((value) => ({ name: clean(value) })),
  }));
  if (
    productOptions.length === 0 ||
    productOptions.some((option) => !option.name || option.values.some((value) => !value.name))
  ) {
    throw new Error("Fresh source has invalid product options");
  }

  const files = fresh.images.map((image, index) => ({
    originalSource: image.url,
    alt: clean(image.alt || fresh.title),
    filename: filenameFor(image.url, index),
    contentType: "IMAGE",
  }));
  const variants = fresh.variants.map((variant: any, index) => {
    const optionValues = productOptions.map((option) => ({
      optionName: option.name,
      name: clean(
        variant.optionValues?.[option.name] ||
        variant.optionValues?.[option.name.toLowerCase()] ||
        (/colou?r/i.test(option.name) ? variant.color : variant.size) ||
        option.values[0]?.name,
      ),
    }));
    if (optionValues.some((value) => !value.name)) {
      throw new Error(`Variant has an empty option value: ${variant.sku}`);
    }
    const sku = clean(variant.sku);
    const existing: any = existingBySku.get(sku.toLowerCase());
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

    for (const [index, variant] of fresh.variants.entries()) {
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
      data: { status: "active", handle: verified.handle, price: Number(variants[0].price) },
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
