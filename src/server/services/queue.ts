import PQueue from 'p-queue';
import { prisma } from '../db.js';
import { ShopifyService } from './shopify.js';
import { PricingEngine } from './pricing.js';
import { ScraperService } from './scraper.js';

const DEFAULT_IN_STOCK_QUANTITY = Number(process.env.SHOPIFY_DEFAULT_IN_STOCK_QUANTITY || 10);
const INVENTORY_SYNC_INTERVAL_MINUTES = Number(process.env.SYNC_INVENTORY_INTERVAL_MINUTES || 15);
const INVENTORY_SYNC_BATCH_SIZE = Number(process.env.SYNC_INVENTORY_BATCH_SIZE || 25);
const INVENTORY_SYNC_MIN_AGE_MINUTES = Number(process.env.SYNC_INVENTORY_MIN_AGE_MINUTES || 1440);
const MAX_SHOPIFY_MEDIA_ITEMS = 250;
const scraperService = new ScraperService();

function inventorySyncCutoffDate(): Date {
  const minutes = Number.isFinite(INVENTORY_SYNC_MIN_AGE_MINUTES) && INVENTORY_SYNC_MIN_AGE_MINUTES > 0
    ? INVENTORY_SYNC_MIN_AGE_MINUTES
    : 1440;
  return new Date(Date.now() - minutes * 60 * 1000);
}

function cleanOptionText(value: any): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseVariantRaw(raw: string | null | undefined): any {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function parseProductRaw(raw: string | null | undefined): any {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function normalizeColorKey(value: any): string {
  return cleanOptionText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeSwatchHex(value: any): string {
  const raw = cleanOptionText(value);
  const match = raw.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return '';

  const hex = match[1].length === 3
    ? match[1].split('').map(char => `${char}${char}`).join('')
    : match[1];
  return `#${hex.toUpperCase()}`;
}

function normalizeSwatchEntry(value: any): { color?: string; image?: string } | null {
  if (!value) return null;

  const color = normalizeSwatchHex(value.color || value.hex || value.colorHex || value.colourHex || value.value);
  const image = cleanOptionText(value.image || value.imageUrl || value.url);
  if (!color && !image) return null;

  return {
    ...(color ? { color } : {}),
    ...(image ? { image } : {}),
  };
}

function getProductColorSwatches(product: any): Record<string, { color?: string; image?: string }> {
  const parsedRaw = parseProductRaw(product.raw);
  const swatches: Record<string, { color?: string; image?: string }> = {};

  for (const option of parsedRaw.options || []) {
    if (!/^colou?r$/i.test(cleanOptionText(option?.name))) continue;
    const optionSwatches = option?.swatches || {};

    for (const [name, swatch] of Object.entries(optionSwatches)) {
      const cleanName = cleanOptionText(name);
      const normalized = normalizeSwatchEntry(swatch);
      if (cleanName && normalized) swatches[cleanName] = normalized;
    }
  }

  return swatches;
}

function findColorSwatch(productSwatches: Record<string, { color?: string; image?: string }>, color: any) {
  const colorKey = normalizeColorKey(color);
  if (!colorKey) return null;

  const entry = Object.entries(productSwatches).find(([name]) => normalizeColorKey(name) === colorKey);
  return entry ? entry[1] : null;
}

function getVariantOptionValues(variant: any): Record<string, string> {
  const parsedRaw = parseVariantRaw(variant.raw);
  const values: Record<string, string> = {};

  for (const [name, value] of Object.entries(parsedRaw.optionValues || {})) {
    const cleanName = cleanOptionText(name);
    const cleanValue = cleanOptionText(value);
    if (cleanName && cleanValue && !/^default$/i.test(cleanValue)) {
      values[cleanName] = cleanValue;
    }
  }

  if (variant.color) values.Color = cleanOptionText(variant.color);
  if (variant.size) values.Size = cleanOptionText(variant.size);

  return values;
}

function buildShopifyOptionNames(variants: any[]): string[] {
  const names = new Set<string>();
  for (const variant of variants) {
    Object.keys(getVariantOptionValues(variant)).forEach(name => names.add(name === 'Colour' ? 'Color' : name));
  }

  const preferred = ['Color', 'Size'];
  const ordered = [
    ...preferred.filter(name => names.has(name)),
    ...[...names].filter(name => !preferred.includes(name)),
  ];

  return ordered.length ? ordered.slice(0, 3) : ['Title'];
}

function buildShopifyVariantOptions(variant: any, optionNames: string[]): string[] {
  if (optionNames.length === 1 && optionNames[0] === 'Title') return ['Default Title'];

  const values = getVariantOptionValues(variant);
  return optionNames.map(name => cleanOptionText(values[name] || 'Default'));
}

function buildShopifyProductOptions(variants: any[], optionNames: string[]) {
  return optionNames.map((name, index) => {
    const values = new Set<string>();

    for (const variant of variants) {
      const optionValue = buildShopifyVariantOptions(variant, optionNames)[index] || 'Default';
      values.add(optionValue);
    }

    if (values.size === 0) values.add(name === 'Title' ? 'Default Title' : 'Default');

    return {
      name,
      values: [...values].map(value => ({ name: value })),
    };
  });
}

function buildProductMetafields(product: any, colorSwatches: Record<string, { color?: string; image?: string }>) {
  if (Object.keys(colorSwatches).length === 0) return [];

  return [{
    namespace: 'syncly',
    key: 'color_swatches',
    type: 'json',
    value: JSON.stringify(colorSwatches),
  }];
}

function buildVariantMetafields(variant: any, productSwatches: Record<string, { color?: string; image?: string }>) {
  const color = getVariantColor(variant);
  const swatch = findColorSwatch(productSwatches, color);
  if (!color || !swatch) return [];

  return [
    {
      namespace: 'syncly',
      key: 'color_swatch',
      type: 'json',
      value: JSON.stringify({ name: color, ...swatch }),
    },
    ...(swatch.color ? [{
      namespace: 'syncly',
      key: 'color_hex',
      type: 'single_line_text_field',
      value: swatch.color,
    }] : []),
  ];
}

function formatPrice(value: number) {
  return Number(value.toFixed(2));
}

function normalizeUrl(value: any): string {
  return String(value || '').trim();
}

function normalizeForMatch(value: any): string {
  return cleanOptionText(value).toLowerCase();
}

function labelContainsLabel(haystack: any, needle: any): boolean {
  const normalizedHaystack = normalizeForMatch(haystack);
  const normalizedNeedle = normalizeForMatch(needle);
  if (!normalizedHaystack || !normalizedNeedle) return false;
  if (normalizedHaystack === normalizedNeedle) return true;

  const escapedNeedle = normalizedNeedle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escapedNeedle}($|[^a-z0-9])`, 'i').test(normalizedHaystack);
}

function getVariantColor(variant: any): string {
  const values = getVariantOptionValues(variant);
  return cleanOptionText(variant.color || values.Color || values.Colour);
}

function hasMultipleVariantColors(variants: any[]): boolean {
  const colors = new Set(
    variants
      .map(getVariantColor)
      .map(normalizeForMatch)
      .filter(Boolean),
  );

  return colors.size > 1;
}

function toInventoryQuantity(value: any): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }

  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) {
    return Math.max(0, Math.floor(Number(value)));
  }

  return null;
}

function findQuantityInObject(value: any, depth = 0): number | null {
  if (!value || typeof value !== 'object' || depth > 4) return null;

  const quantityKeys = [
    'stockQuantity',
    'availableQuantity',
    'inventoryQuantity',
    'onlineStockAvailable',
    'quantity',
    'qty',
    'stock',
  ];

  for (const key of quantityKeys) {
    const quantity = toInventoryQuantity(value[key]);
    if (quantity !== null) return quantity;
  }

  const preferredContainers = ['inventoryInfo', 'availability', 'raw', 'product', 'stockInfo'];
  for (const key of preferredContainers) {
    const quantity = findQuantityInObject(value[key], depth + 1);
    if (quantity !== null) return quantity;
  }

  if (depth >= 2) return null;

  for (const child of Object.values(value)) {
    const quantity = findQuantityInObject(child, depth + 1);
    if (quantity !== null) return quantity;
  }

  return null;
}

function getFallbackInventoryQuantity(variant: any): number {
  if (variant.available === false || variant.stockStatus === 'out_of_stock') return 0;
  if (variant.stockStatus === 'low_stock') return 1;
  if (variant.stockStatus !== 'in_stock') return 0;

  return Number.isFinite(DEFAULT_IN_STOCK_QUANTITY) && DEFAULT_IN_STOCK_QUANTITY > 0
    ? Math.floor(DEFAULT_IN_STOCK_QUANTITY)
    : 10;
}

function getVariantInventoryQuantity(variant: any): number {
  if (
    variant.available === false ||
    variant.stockStatus === 'out_of_stock'
  ) {
    return 0;
  }

  const parsedRaw = parseVariantRaw(variant.raw);
  const explicitQuantity =
    toInventoryQuantity(variant.stockQuantity) ??
    toInventoryQuantity(variant.quantity) ??
    findQuantityInObject(parsedRaw);

  return explicitQuantity ?? getFallbackInventoryQuantity(variant);
}

function getVariantImageUrl(variant: any, images: any[], allVariants: any[] = []): string | undefined {
  const directImageUrl = normalizeUrl(variant.imageUrl);
  if (directImageUrl) return directImageUrl;

  const color = normalizeForMatch(getVariantColor(variant));
  if (color) {
    const colorImage = images.find((image: any) => {
      const imageColor = normalizeForMatch(image.color);
      const imageAlt = normalizeForMatch(image.alt);
      return imageColor === color || labelContainsLabel(imageAlt, color);
    });
    if (colorImage?.url) return normalizeUrl(colorImage.url);
  }

  if (images.length === 1 || !hasMultipleVariantColors(allVariants)) {
    return normalizeUrl(images[0]?.url) || undefined;
  }

  return undefined;
}

function buildVariantMediaAlt(product: any, variant: any, optionNames: string[]) {
  const optionValues = buildShopifyVariantOptions(variant, optionNames)
    .filter(value => value && value !== 'Default' && value !== 'Default Title');
  const details = [
    variant.color,
    variant.size,
    ...optionValues,
  ]
    .map(value => cleanOptionText(value))
    .filter(Boolean);
  const uniqueDetails = [...new Set(details)];

  return uniqueDetails.length
    ? `${product.title} - ${uniqueDetails.join(' / ')}`
    : product.title;
}

function buildProductMedia(
  product: any,
  optionNames: string[],
  variantPayloads: any[] = [],
  includeProductImages = true,
) {
  const mediaByUrl = new Map<string, any>();
  const media: any[] = [];

  const pushMedia = (url: any, alt: any) => {
    const cleanUrl = normalizeUrl(url);
    if (!cleanUrl) return;

    const cleanAlt = cleanOptionText(alt) || product.title;
    const existingMedia = mediaByUrl.get(cleanUrl);
    if (existingMedia) {
      if (cleanAlt.length > String(existingMedia.alt || '').length) {
        existingMedia.alt = cleanAlt;
      }
      return;
    }

    const mediaEntry = {
      mediaContentType: 'IMAGE',
      originalSource: cleanUrl,
      alt: cleanAlt,
    };
    mediaByUrl.set(cleanUrl, mediaEntry);
    media.push(mediaEntry);
  };

  if (includeProductImages) {
    for (const image of product.images || []) {
      pushMedia(image.url, image.alt || image.color || product.title);
    }
  }

  const variantsWithImages = variantPayloads.length
    ? variantPayloads.map((variantPayload: any) => ({
        variant: variantPayload.sourceVariant,
        imageUrl: variantPayload.imageUrl,
      }))
    : (product.variants || []).map((variant: any) => ({
        variant,
        imageUrl: getVariantImageUrl(variant, product.images || [], product.variants || []),
      }));

  for (const { variant, imageUrl } of variantsWithImages) {
    pushMedia(
      imageUrl,
      buildVariantMediaAlt(product, variant, optionNames),
    );
  }

  return media.slice(0, MAX_SHOPIFY_MEDIA_ITEMS);
}

function buildSelectedOptionsKey(selectedOptions: any[], optionNames: string[]) {
  const selectedValues = new Map<string, string>();
  for (const option of selectedOptions || []) {
    selectedValues.set(cleanOptionText(option?.name), cleanOptionText(option?.value));
  }

  return optionNames
    .map(optionName => selectedValues.get(optionName) || 'Default')
    .join('||');
}

function matchCreatedVariantPayload(createdVariant: any, variantPayloads: any[], optionNames: string[], fallbackIndex: number) {
  const payloadsByKey = new Map(variantPayloads.map(payload => [payload.key, payload]));
  const selectedOptionsKey = buildSelectedOptionsKey(createdVariant.selectedOptions || [], optionNames);
  return payloadsByKey.get(selectedOptionsKey) || variantPayloads[fallbackIndex] || variantPayloads[0];
}

function buildVariantPayloads(product: any, rule: any, optionNames: string[], locationId: string) {
  const seen = new Set<string>();
  const productSwatches = getProductColorSwatches(product);

  return product.variants
    .map((variant: any) => {
      const optionValues = buildShopifyVariantOptions(variant, optionNames);
      const key = optionValues.join('||');
      const sourcePrice = variant.price || product.price;
      const calculatedPrice = rule
        ? PricingEngine.calculatePrice(sourcePrice, rule)
        : sourcePrice;
      const imageUrl = getVariantImageUrl(variant, product.images || [], product.variants || []);
      const availableQuantity = getVariantInventoryQuantity(variant);
      const metafields = buildVariantMetafields(variant, productSwatches);

      return {
        key,
        sourceVariant: variant,
        price: formatPrice(calculatedPrice),
        imageUrl,
        availableQuantity,
        input: {
          price: formatPrice(calculatedPrice),
          inventoryPolicy: 'DENY',
          optionValues: optionNames.map((optionName, index) => ({
            optionName,
            name: optionValues[index],
          })),
          inventoryItem: {
            sku: variant.sku || `${product.supplier.name}-${product.productId || product.id}-${variant.id.slice(-4)}`,
            tracked: true,
          },
          ...(metafields.length ? { metafields } : {}),
          inventoryQuantities: [
            {
              locationId,
              availableQuantity,
            },
          ],
          ...(imageUrl ? { mediaSrc: [imageUrl] } : {}),
        },
      };
    })
    .filter((variantPayload: any) => {
      if (seen.has(variantPayload.key)) return false;
      seen.add(variantPayload.key);
      return true;
    });
}

function normalizeAvailabilityKey(value: any) {
  return cleanOptionText(value).toLowerCase();
}

function findVariantAvailability(sourceVariant: any, availabilitySnapshot: any) {
  const variants = Array.isArray(availabilitySnapshot?.variants) ? availabilitySnapshot.variants : [];
  if (variants.length === 0) return null;

  const candidates = [
    sourceVariant.sourceVariantId,
    sourceVariant.sku,
    sourceVariant.id,
  ]
    .map(normalizeAvailabilityKey)
    .filter(Boolean);

  return variants.find((variant: any) => {
    const id = normalizeAvailabilityKey(variant.id);
    return candidates.includes(id);
  }) || (variants.length === 1 ? variants[0] : null);
}

function getSyncedStockStatus(isAvailable: boolean, availabilityStatus: any) {
  if (!isAvailable) return 'out_of_stock';
  if (availabilityStatus === 'out_of_stock') return 'out_of_stock';
  if (availabilityStatus === 'low_stock') return 'low_stock';
  if (availabilityStatus === 'in_stock') return 'in_stock';
  return 'unknown';
}

function getInventoryQuantityForStatus(stockStatus: string) {
  if (stockStatus === 'out_of_stock') return 0;
  if (stockStatus === 'low_stock') return 1;
  if (stockStatus !== 'in_stock') return 0;
  return getFallbackInventoryQuantity({ available: true, stockStatus });
}

export class QueueService {
  private static queue = new PQueue({ concurrency: 2 });
  private static inventoryMonitorStarted = false;
  private static inventoryMonitorTimer: ReturnType<typeof setInterval> | null = null;

  static async addTask(type: string, payload: any) {
    const job = await prisma.syncJob.create({
      data: {
        type,
        payload: JSON.stringify(payload),
        status: 'pending',
      }
    });

    // Start processing async
    this.processJob(job.id);
    
    return job;
  }

  static startInventoryMonitor() {
    if (this.inventoryMonitorStarted) return;
    if (process.env.SYNC_INVENTORY_AUTOSTART === 'false') {
      console.log('Inventory monitor disabled by SYNC_INVENTORY_AUTOSTART=false');
      return;
    }

    const intervalMinutes = Number.isFinite(INVENTORY_SYNC_INTERVAL_MINUTES) && INVENTORY_SYNC_INTERVAL_MINUTES > 0
      ? INVENTORY_SYNC_INTERVAL_MINUTES
      : 15;
    const intervalMs = intervalMinutes * 60 * 1000;

    const enqueueInventorySync = async () => {
      try {
        await this.addTask('SYNC_INVENTORY', { reason: 'scheduled' });
      } catch (error: any) {
        console.error('Failed to queue scheduled inventory sync:', error.message);
      }
    };

    this.inventoryMonitorStarted = true;
    this.inventoryMonitorTimer = setInterval(() => {
      void enqueueInventorySync();
    }, intervalMs);
    (this.inventoryMonitorTimer as any).unref?.();

    const initialTimer = setTimeout(() => {
      void enqueueInventorySync();
    }, 10_000);
    (initialTimer as any).unref?.();

    console.log(`Inventory monitor enabled: every ${intervalMinutes} minute(s), batch size ${INVENTORY_SYNC_BATCH_SIZE}`);
  }

  private static async syncProductInventory(sourceProductId: string, jobId: string) {
    const product = await prisma.sourceProduct.findUnique({
      where: { id: sourceProductId },
      include: {
        variants: { include: { shopifyVariant: true } },
        images: true,
        shopifyProduct: true,
        supplier: true,
      },
    });

    if (!product) throw new Error('Source product not found');
    if (product.syncStatus === 'paused') {
      return { skipped: true, reason: 'Product sync is paused', sourceProductId };
    }
    if (!product.shopifyProduct) {
      throw new Error('Product is not linked to Shopify');
    }
    if (!product.shopifyProduct.syncEnabled || !product.shopifyProduct.syncInventory) {
      return { skipped: true, reason: 'Inventory sync disabled for product', sourceProductId };
    }

    const client = await ShopifyService.getClientFromDb(prisma);
    const inventoryLocation = await ShopifyService.getInventoryLocation(client);
    const availabilitySnapshot = await scraperService.checkAvailability(product.url);
    const shopifyInventoryVariants = await ShopifyService.getProductInventoryVariants(
      client,
      product.shopifyProduct.shopifyId,
    );
    const shopifyVariantById = new Map<string, any>(
      shopifyInventoryVariants.map((variant: any) => [variant.id, variant]),
    );

    const quantities: Array<{ inventoryItemId: string; quantity: number }> = [];
    const sourceUpdates: any[] = [];
    const summary = {
      sourceProductId,
      shopifyProductId: product.shopifyProduct.shopifyId,
      inventoryLocationId: inventoryLocation.id,
      inventoryLocationName: inventoryLocation.name,
      variantsChecked: product.variants.length,
      variantsUpdated: 0,
      inStock: 0,
      outOfStock: 0,
      lowStock: 0,
      skippedVariants: 0,
      variantImagesChecked: 0,
      variantImagesUpdated: 0,
    };
    const imageVariantPayloads: Array<{ sourceVariant: any; imageUrl: string; input: any }> = [];
    const shouldSyncImages = Boolean(product.shopifyProduct.syncImages);

    for (const sourceVariant of product.variants) {
      const shopifyVariant = sourceVariant.shopifyVariant;
      const inventoryVariant = shopifyVariant
        ? shopifyVariantById.get(shopifyVariant.shopifyId)
        : null;
      const inventoryItemId = inventoryVariant?.inventoryItem?.id;
      const currentVariantMedia = inventoryVariant?.media?.nodes || [];

      if (shouldSyncImages && shopifyVariant && inventoryVariant) {
        summary.variantImagesChecked += 1;
        const imageUrl = getVariantImageUrl(sourceVariant, product.images || [], product.variants || []);
        if (imageUrl && currentVariantMedia.length === 0) {
          imageVariantPayloads.push({
            sourceVariant,
            imageUrl,
            input: {
              id: shopifyVariant.shopifyId,
              mediaSrc: [imageUrl],
            },
          });
        }
      }

      if (!inventoryItemId) {
        summary.skippedVariants += 1;
        continue;
      }

      const variantAvailability = findVariantAvailability(sourceVariant, availabilitySnapshot);
      const isAvailable = variantAvailability?.available ?? availabilitySnapshot.available;
      const stockStatus = getSyncedStockStatus(isAvailable, variantAvailability?.stockStatus);
      const quantity = getInventoryQuantityForStatus(stockStatus);

      if (stockStatus === 'out_of_stock') summary.outOfStock += 1;
      else if (stockStatus === 'low_stock') summary.lowStock += 1;
      else summary.inStock += 1;

      quantities.push({ inventoryItemId, quantity });
      sourceUpdates.push(
        prisma.sourceVariant.update({
          where: { id: sourceVariant.id },
          data: {
            available: isAvailable,
            stockStatus,
            ...(variantAvailability?.price ? { price: variantAvailability.price } : {}),
          },
        }),
      );
    }

    if (quantities.length === 0) {
      throw new Error('No linked Shopify inventory items found for this product');
    }

    const inventoryResponse = await ShopifyService.setInventoryQuantities(client, {
      locationId: inventoryLocation.id,
      quantities,
      referenceDocumentUri: `gid://syncly/SyncJob/${jobId}`,
    });
    const userErrors = inventoryResponse.inventorySetQuantities?.userErrors || [];
    if (userErrors.length > 0) {
      throw new Error(`Shopify Inventory Error: ${userErrors[0].message}`);
    }

    summary.variantsUpdated = quantities.length;

    if (imageVariantPayloads.length > 0) {
      const optionNames = buildShopifyOptionNames(product.variants);
      const media = buildProductMedia(product, optionNames, imageVariantPayloads, false);
      const imageResponse = await ShopifyService.updateVariantsBulkMedia(
        client,
        product.shopifyProduct.shopifyId,
        imageVariantPayloads.map(payload => payload.input),
        media,
      );
      const imageErrors = imageResponse.productVariantsBulkUpdate?.userErrors || [];
      if (imageErrors.length > 0) {
        throw new Error(`Shopify Image Sync Error: ${imageErrors[0].message}`);
      }

      summary.variantImagesUpdated = (imageResponse.productVariantsBulkUpdate?.productVariants || [])
        .filter((variant: any) => (variant.media?.nodes || []).length > 0)
        .length;
    }

    await prisma.$transaction([
      ...sourceUpdates,
      prisma.sourceProduct.update({
        where: { id: product.id },
        data: {
          syncStatus: 'active',
          lastScrapedAt: new Date(),
        },
      }),
      prisma.auditLog.create({
        data: {
          sourceProductId: product.id,
          action: 'SYNC_INVENTORY',
          details: JSON.stringify(summary),
        },
      }),
    ]);

    return summary;
  }

  private static async queueInventorySyncBatch() {
    const take = Number.isFinite(INVENTORY_SYNC_BATCH_SIZE) && INVENTORY_SYNC_BATCH_SIZE > 0
      ? Math.floor(INVENTORY_SYNC_BATCH_SIZE)
      : 25;
    const products = await prisma.sourceProduct.findMany({
      where: {
        syncStatus: 'active',
        lastScrapedAt: {
          lte: inventorySyncCutoffDate(),
        },
        shopifyProduct: {
          is: {
            syncEnabled: true,
            syncInventory: true,
          },
        },
      },
      select: { id: true, title: true },
      orderBy: { lastScrapedAt: 'asc' },
      take,
    });

    for (const product of products) {
      await this.addTask('SYNC_PRODUCT', {
        sourceProductId: product.id,
        reason: 'scheduled',
      });
    }

    return {
      queued: products.length,
      productIds: products.map(product => product.id),
    };
  }

  private static async processJob(jobId: string) {
    const job = await prisma.syncJob.findUnique({ where: { id: jobId } });
    if (!job) return;

    await prisma.syncJob.update({
      where: { id: jobId },
      data: { status: 'running', startedAt: new Date() }
    });

    this.queue.add(async () => {
      try {
        const payload = JSON.parse(job.payload || '{}');
        let result: any = {};

        switch (job.type) {
          case 'PUBLISH_TO_SHOPIFY': {
            const { sourceProductId, pricingRuleId, collections } = payload;
            
            // 1. Fetch source product
            const product = await prisma.sourceProduct.findUnique({
              where: { id: sourceProductId },
              include: { variants: true, images: true, supplier: true }
            });
            if (!product) throw new Error('Source product not found');

            // 2. Prepare Shopify Input
            const client = await ShopifyService.getClientFromDb(prisma);
            
            // Apply pricing rule
            let rule = null;
            if (pricingRuleId) {
              rule = await prisma.pricingRule.findUnique({ where: { id: pricingRuleId } });
              if (!rule) throw new Error('Selected pricing rule was not found');
            } else {
              const rules = await prisma.pricingRule.findMany();
              rule = PricingEngine.selectBestRule(rules, {
                supplierId: product.supplierId,
                currency: product.currency,
              });
            }

            const inventoryLocation = await ShopifyService.getInventoryLocation(client);
            const optionNames = buildShopifyOptionNames(product.variants);
            const variantPayloads = buildVariantPayloads(product, rule, optionNames, inventoryLocation.id);
            if (variantPayloads.length === 0) {
              throw new Error('No variants available to publish');
            }
            const productMedia = buildProductMedia(product, optionNames, variantPayloads);
            const productMetafields = buildProductMetafields(product, getProductColorSwatches(product));

            const input: any = {
              product: {
                title: product.title,
                descriptionHtml: product.description || undefined,
                vendor: product.brand || product.supplier.name,
                status: 'ACTIVE',
                tags: [product.supplier.name, product.brand, 'SyncEngine'].filter(Boolean),
                productOptions: buildShopifyProductOptions(product.variants, optionNames),
                ...(productMetafields.length ? { metafields: productMetafields } : {}),
              },
            };

            // 3. Create in Shopify
            const shopifyResponse = await ShopifyService.createProduct(client, input);
            const { product: shopifyProductResult, userErrors } = shopifyResponse.productCreate;

            if (userErrors && userErrors.length > 0) {
              throw new Error(`Shopify Error: ${userErrors[0].message}`);
            }

            const variantsResponse = await ShopifyService.createVariantsBulk(
              client,
              shopifyProductResult.id,
              variantPayloads.map((variantPayload: any) => variantPayload.input),
              productMedia,
            );
            const {
              productVariants: createdVariants,
              userErrors: variantErrors,
            } = variantsResponse.productVariantsBulkCreate;

            if (variantErrors && variantErrors.length > 0) {
              throw new Error(`Shopify Variant Error: ${variantErrors[0].message}`);
            }
            if (!createdVariants || createdVariants.length === 0) {
              throw new Error('Shopify did not return created variants');
            }

            // 4. Save to DB
            const dbShopifyProduct = await prisma.shopifyProduct.create({
              data: {
                sourceProductId,
                shopifyId: shopifyProductResult.id,
                handle: shopifyProductResult.handle,
                status: String(shopifyProductResult.status || 'ACTIVE').toLowerCase(),
                collectionIds: collections?.join(',') || null,
                price: createdVariants[0]?.price ? parseFloat(createdVariants[0].price) : variantPayloads[0].price,
                variants: {
                  create: createdVariants.map((variant: any, index: number) => {
                    const variantPayload = matchCreatedVariantPayload(variant, variantPayloads, optionNames, index);

                    return {
                      shopifyId: variant.id,
                      sku: variant.inventoryItem?.sku,
                      price: variant.price ? parseFloat(variant.price) : variantPayload?.price,
                      sourceVariantId: variantPayload?.sourceVariant.id || product.variants[0].id
                    };
                  })
                }
              }
            });
            await prisma.sourceProduct.update({
              where: { id: sourceProductId },
              data: { syncStatus: 'active' },
            });

            // 5. Add to collections if any
            if (collections && collections.length > 0) {
              for (const collectionId of collections) {
                await ShopifyService.addProductToCollection(client, shopifyProductResult.id, collectionId);
              }
            }

            let publicationResult: any = {
              publishedCount: 0,
              publications: [],
              warning: null,
            };
            try {
              publicationResult = await ShopifyService.publishProductToSalesChannels(
                client,
                shopifyProductResult.id,
              );
              const publicationErrors = publicationResult.userErrors || [];
              if (publicationErrors.length > 0) {
                publicationResult.warning = `Shopify publication warning: ${publicationErrors[0].message}`;
                console.warn(publicationResult.warning);
              }
            } catch (publicationError: any) {
              publicationResult.warning =
                `Product created, but sales-channel publishing failed: ${publicationError.message}. ` +
                'Reconnect Shopify with read_publications and write_publications scopes.';
              console.warn(publicationResult.warning);
            }

            result = {
              shopifyProductId: dbShopifyProduct.id,
              shopifyId: shopifyProductResult.id,
              inventoryLocationId: inventoryLocation.id,
              inventoryLocationName: inventoryLocation.name,
              variantsCreated: createdVariants.length,
              productMediaSubmitted: productMedia.length,
              variantImagesRequested: variantPayloads.filter((variantPayload: any) => variantPayload.imageUrl).length,
              variantImagesLinked: createdVariants.filter((variant: any) => (variant.media?.nodes || []).length > 0).length,
              salesChannelsPublished: publicationResult.publishedCount,
              salesChannels: publicationResult.publications
                .flatMap((publication: any) => publication.channels || [])
                .map((channel: any) => channel.name || channel.handle)
                .filter(Boolean),
              publicationWarning: publicationResult.warning,
            };
            break;
          }
          case 'SCRAPE_PRODUCT':
            // Scrape logic would go here
            break;
          case 'SYNC_PRODUCT': {
            const { sourceProductId } = payload;
            if (!sourceProductId) throw new Error('Missing sourceProductId');
            result = await this.syncProductInventory(sourceProductId, jobId);
            break;
          }
          case 'SYNC_INVENTORY':
            result = await this.queueInventorySyncBatch();
            break;
          default:
            throw new Error(`Unknown job type: ${job.type}`);
        }

        await prisma.syncJob.update({
          where: { id: jobId },
          data: { 
            status: 'completed', 
            completedAt: new Date(),
            result: JSON.stringify(result)
          }
        });
      } catch (error: any) {
        try {
          const payload = JSON.parse(job.payload || '{}');
          if ((job.type === 'SYNC_PRODUCT' || job.type === 'PUBLISH_TO_SHOPIFY') && payload.sourceProductId) {
            await prisma.sourceProduct.update({
              where: { id: payload.sourceProductId },
              data: { syncStatus: 'error' },
            });
          }
        } catch {}

        await prisma.syncJob.update({
          where: { id: jobId },
          data: { 
            status: 'failed', 
            completedAt: new Date(),
            result: JSON.stringify({ error: error.message })
          }
        });
      }
    });
  }
}
