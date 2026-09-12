import type { PrismaClient } from '@prisma/client';
import { ShopifyService, type ShopifyGraphqlClient } from './shopify.js';
import { getApprovedSheetMultiplier } from './sheetMultiplier.js';

function clean(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function htmlText(value: unknown) {
  return clean(String(value ?? '').replace(/<[^>]+>/g, ' '));
}

function unique(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = clean(raw);
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function filenameFor(url: string, index: number) {
  try {
    return clean(new URL(url).pathname.split('/').filter(Boolean).at(-1)) || `stored-${index + 1}.jpg`;
  } catch {
    return `stored-${index + 1}.jpg`;
  }
}

function parseVariantOptions(raw: string | null | undefined) {
  try {
    const parsed = JSON.parse(raw || '{}');
    const values = parsed?.optionValues;
    return values && typeof values === 'object' ? values as Record<string, string> : {};
  } catch {
    return {} as Record<string, string>;
  }
}

export async function syncTrustedStoredCatalog(options: {
  prisma: PrismaClient;
  sourceProductId: string;
  client?: ShopifyGraphqlClient;
  location?: { id: string };
}) {
  const { prisma, sourceProductId } = options;
  const product = await prisma.sourceProduct.findUnique({
    where: { id: sourceProductId },
    include: {
      supplier: true,
      images: { orderBy: { position: 'asc' } },
      variants: { orderBy: { createdAt: 'asc' }, include: { shopifyVariant: true } },
      shopifyProduct: { include: { variants: true } },
    },
  });

  if (!product?.shopifyProduct?.shopifyId || !product.shopifyProduct.syncEnabled) {
    throw new Error('Stored fallback requires a linked, sync-enabled Shopify product');
  }

  const multiplier = getApprovedSheetMultiplier(product as any);
  if (!multiplier || ![22, 23, 24].includes(multiplier)) {
    throw new Error('Stored fallback has no approved sheet multiplier');
  }
  if (
    product.currency !== 'AED' ||
    product.price <= 1 ||
    !clean(product.title) ||
    !htmlText(product.description) ||
    product.images.length === 0 ||
    product.variants.length === 0 ||
    product.variants.length > 100
  ) {
    throw new Error('Stored fallback rejected incomplete trusted catalog data');
  }

  const skus = product.variants.map((variant) => clean(variant.sku));
  if (skus.some((sku) => !sku) || new Set(skus.map((sku) => sku.toLowerCase())).size !== skus.length) {
    throw new Error('Stored fallback requires complete unique source SKUs');
  }

  const colors = unique(product.variants.map((variant) => variant.color));
  const sizes = unique(product.variants.map((variant) => variant.size));
  const optionNames: string[] = [];
  if (colors.length) optionNames.push('Color');
  if (sizes.length) optionNames.push('Size');
  if (!optionNames.length) optionNames.push('Default');

  const productOptions = optionNames.map((name, position) => ({
    name,
    position: position + 1,
    values: (name === 'Color' ? colors : name === 'Size' ? sizes : ['Default']).map((value) => ({ name: value })),
  }));

  const client = options.client || await ShopifyService.getClientFromDb(prisma);
  const location = options.location || await ShopifyService.getInventoryLocation(client);
  const shopifyProductId = product.shopifyProduct.shopifyId;
  const before = await ShopifyService.getProductCatalogSnapshot(client, shopifyProductId);
  if (!before?.id) throw new Error('Stored fallback could not read linked Shopify product');

  const beforeBySku = new Map(
    (before.variants || []).map((variant: any) => [clean(variant.sku).toLowerCase(), variant]),
  );

  const files = product.images.map((image, index) => ({
    originalSource: image.url,
    alt: clean(image.alt || product.title),
    filename: filenameFor(image.url, index),
    contentType: 'IMAGE',
  }));

  const variants = product.variants.map((variant, index) => {
    const parsed = parseVariantOptions(variant.raw);
    const color = clean(variant.color || parsed.Color || parsed.color);
    const size = clean(variant.size || parsed.Size || parsed.size);
    const optionValues = optionNames.map((name) => ({
      optionName: name,
      name: name === 'Color' ? color : name === 'Size' ? size : 'Default',
    }));
    if (optionValues.some((value) => !value.name)) {
      throw new Error(`Stored fallback variant has incomplete options: ${variant.sku}`);
    }
    const existing: any = beforeBySku.get(clean(variant.sku).toLowerCase());
    const sourcePrice = Number(variant.price || product.price);
    const imageUrl = clean(variant.imageUrl || product.images[0]?.url);
    return {
      ...(existing?.id ? { id: existing.id } : {}),
      optionValues,
      price: sourcePrice * multiplier,
      sku: clean(variant.sku),
      position: index + 1,
      inventoryItem: { tracked: true },
      inventoryQuantities: [{
        locationId: location.id,
        name: 'available',
        quantity: variant.available === false || variant.stockStatus === 'out_of_stock' ? 0 : 10,
      }],
      ...(imageUrl ? {
        file: {
          originalSource: imageUrl,
          alt: clean(product.title),
          filename: filenameFor(imageUrl, index),
          contentType: 'IMAGE',
        },
      } : {}),
    };
  });

  const response = await ShopifyService.setProductCatalog(client, shopifyProductId, {
    title: product.title,
    descriptionHtml: product.description || '',
    vendor: product.brand || product.supplier.name,
    status: 'ACTIVE',
    productOptions,
    files,
    variants,
  });
  const errors = response.productSet?.userErrors || [];
  if (errors.length) throw new Error(`Stored fallback Shopify write rejected: ${errors[0].message}`);

  let verified: any = null;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
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
      clean(live.title).toLowerCase() === clean(product.title).toLowerCase() &&
      live.variants.length === variants.length &&
      variantsMatch
    ) {
      verified = live;
      break;
    }
    if (attempt < 6) await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
  }
  if (!verified) throw new Error('Stored fallback Shopify read-back did not converge');

  await prisma.auditLog.create({
    data: {
      sourceProductId,
      action: 'SYNC_STORED_CATALOG_SET',
      userId: 'System',
      details: JSON.stringify({
        sourceMode: 'stored-fallback',
        freshSourceVerified: false,
        readbackVerified: true,
        shopifyProductId,
        variants: variants.length,
        images: files.length,
        multiplier,
        syncedAt: new Date().toISOString(),
      }),
    },
  });

  return {
    success: true,
    sourceMode: 'stored-fallback',
    freshSourceVerified: false,
    readbackVerified: true,
    sourceProductId,
    shopifyProductId,
    variants: variants.length,
    images: files.length,
  };
}
