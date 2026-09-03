import type { NormalizedProduct } from "./scraper.js";
import { prisma } from "../db.js";

type VerifiedVariantLink = {
  shopifyVariantId: string;
  sourceVariantIndex: number;
};

type PersistExistingLinkInput = {
  fresh: NormalizedProduct;
  shopifyProductId: string;
  shopifyHandle?: string | null;
  shopifyStatus?: string | null;
  shopifyPrice?: number | null;
  multiplier: number;
  sheetUrl: string;
  sheetName: string;
  sheetId: number;
  rowNumber: number;
  collection?: string | null;
  variantLinks: VerifiedVariantLink[];
};

function clean(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function canonicalUrl(value: string) {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function spreadsheetId(value: string) {
  return value.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)?.[1] || "";
}

export async function persistVerifiedExistingShopifyLink(input: PersistExistingLinkInput) {
  const url = canonicalUrl(input.fresh.source.url);
  const variants = Array.isArray(input.fresh.variants) ? input.fresh.variants : [];
  const variantLinks = input.variantLinks.filter(
    (link) => clean(link.shopifyVariantId) && Number.isInteger(link.sourceVariantIndex),
  );
  if (!variantLinks.length || variantLinks.length !== input.variantLinks.length) {
    throw new Error("Verified reconciliation returned an incomplete variant link map");
  }
  if (new Set(variantLinks.map((link) => link.shopifyVariantId)).size !== variantLinks.length) {
    throw new Error("Verified reconciliation returned duplicate Shopify variant links");
  }
  for (const link of variantLinks) {
    if (!variants[link.sourceVariantIndex]) {
      throw new Error("Verified reconciliation referenced a missing source variant");
    }
  }

  return prisma.$transaction(async (tx) => {
    const linkedShopify = await tx.shopifyProduct.findUnique({
      where: { shopifyId: input.shopifyProductId },
      select: { id: true, sourceProductId: true },
    });
    const existingSource = await tx.sourceProduct.findUnique({
      where: { url },
      include: { shopifyProduct: { select: { id: true, shopifyId: true } } },
    });
    if (linkedShopify && linkedShopify.sourceProductId !== existingSource?.id) {
      throw new Error("Shopify product became linked to another source during reconciliation");
    }
    if (existingSource?.shopifyProduct?.shopifyId !== undefined &&
        existingSource.shopifyProduct.shopifyId !== input.shopifyProductId) {
      throw new Error("Source URL is already linked to a different Shopify product");
    }
    if (linkedShopify && existingSource?.shopifyProduct) {
      return { sourceProductId: existingSource.id, shopifyProductId: linkedShopify.id, alreadyLinked: true };
    }

    const supplierName = clean(input.fresh.source.supplier || input.fresh.brand || "Unknown Supplier");
    const supplier = await tx.supplier.upsert({
      where: { name: supplierName },
      update: {},
      create: { name: supplierName, baseUrl: url },
    });
    const importMeta = {
      spreadsheetId: spreadsheetId(input.sheetUrl),
      sheetUrl: input.sheetUrl,
      sheetName: input.sheetName,
      sheetId: input.sheetId,
      excelRowNumber: input.rowNumber,
      sheetCollection: clean(input.collection),
      sheetPriceMultiplier: input.multiplier,
      linkedExistingOnly: true,
      linkedAt: new Date().toISOString(),
    };
    const productData = {
      supplierId: supplier.id,
      productId: input.fresh.source.productId || null,
      title: input.fresh.title,
      description: input.fresh.description || null,
      brand: input.fresh.brand || input.fresh.source.supplier || null,
      currency: input.fresh.currency,
      price: input.fresh.price,
      syncStatus: "active",
      lastScrapedAt: new Date(),
      raw: JSON.stringify({ options: input.fresh.options, raw: input.fresh.raw, import: importMeta }),
    };
    const sourceProduct = existingSource
      ? await tx.sourceProduct.update({ where: { id: existingSource.id }, data: productData })
      : await tx.sourceProduct.create({ data: { ...productData, url } });

    await tx.manualReviewItem.deleteMany({ where: { sourceProductId: sourceProduct.id, status: "pending" } });
    await tx.sourceImage.deleteMany({ where: { sourceProductId: sourceProduct.id } });
    await tx.sourceVariant.deleteMany({ where: { sourceProductId: sourceProduct.id } });
    const imageRows = input.fresh.images.filter((image) => clean(image.url)).map((image, position) => ({
      sourceProductId: sourceProduct.id,
      url: image.url,
      alt: image.alt || null,
      color: image.color || null,
      position: Number.isInteger(image.position) ? image.position : position,
    }));
    if (imageRows.length) {
      await tx.sourceImage.createMany({
        data: imageRows,
      });
    }

    const shopifyProduct = await tx.shopifyProduct.create({
      data: {
        sourceProductId: sourceProduct.id,
        shopifyId: input.shopifyProductId,
        handle: clean(input.shopifyHandle) || null,
        status: clean(input.shopifyStatus || "active").toLowerCase(),
        collectionIds: clean(input.collection) || null,
        price: Number.isFinite(Number(input.shopifyPrice)) ? Number(input.shopifyPrice) : null,
        syncEnabled: true,
        syncPrice: true,
        syncInventory: true,
        syncImages: false,
      },
    });

    for (const [linkIndex, link] of variantLinks.entries()) {
      const variant = variants[link.sourceVariantIndex];
      const sourceVariant = await tx.sourceVariant.create({
        data: {
          sourceProductId: sourceProduct.id,
          sourceVariantId: variant.sourceVariantId || variant.sku || `${input.fresh.source.productId || "variant"}-${link.sourceVariantIndex}`,
          sku: variant.sku || null,
          color: variant.color || null,
          size: variant.size || null,
          price: Number(variant.price || input.fresh.price),
          currency: variant.currency || input.fresh.currency,
          available: variant.available !== false,
          stockStatus: variant.stockStatus || "unknown",
          imageUrl: variant.imageUrl || input.fresh.images[0]?.url || null,
          raw: JSON.stringify({ optionValues: variant.optionValues || {}, raw: variant.raw || null }),
        },
      });
      await tx.shopifyVariant.create({
        data: {
          shopifyProductId: shopifyProduct.id,
          sourceVariantId: sourceVariant.id,
          shopifyId: link.shopifyVariantId,
          sku: variant.sku || null,
          price: Number(variant.calculatedPrice || (variant.price || input.fresh.price) * input.multiplier),
        },
      });
      if (linkIndex === 0 && !Number.isFinite(Number(input.shopifyPrice))) {
        await tx.shopifyProduct.update({
          where: { id: shopifyProduct.id },
          data: { price: Number(variant.calculatedPrice || (variant.price || input.fresh.price) * input.multiplier) },
        });
      }
    }

    await tx.auditLog.create({
      data: {
        sourceProductId: sourceProduct.id,
        action: "LINK_EXISTING_SHOPIFY_VERIFIED",
        details: JSON.stringify({
          shopifyProductId: input.shopifyProductId,
          sheetName: input.sheetName,
          sheetId: input.sheetId,
          rowNumber: input.rowNumber,
          multiplier: input.multiplier,
          variantsLinked: variantLinks.length,
          readbackVerified: true,
        }),
      },
    });
    return { sourceProductId: sourceProduct.id, shopifyProductId: shopifyProduct.id, alreadyLinked: false };
  }, { maxWait: 10_000, timeout: 30_000 });
}
