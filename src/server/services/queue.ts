import PQueue from 'p-queue';
import { prisma } from '../db.js';
import { ShopifyService } from './shopify.js';
import { PricingEngine } from './pricing.js';
import { ScraperService, type NormalizedProduct } from './scraper.js';

const DEFAULT_IN_STOCK_QUANTITY = Number(process.env.SHOPIFY_DEFAULT_IN_STOCK_QUANTITY || 10);
const INVENTORY_SYNC_INTERVAL_MINUTES = Number(process.env.SYNC_INVENTORY_INTERVAL_MINUTES || 30);
const INVENTORY_SYNC_BATCH_SIZE = Number(process.env.SYNC_INVENTORY_BATCH_SIZE || 25);
const INVENTORY_SYNC_MIN_AGE_MINUTES = Number(process.env.SYNC_INVENTORY_MIN_AGE_MINUTES || 30);
const FULL_SOURCE_SYNC_ENABLED = process.env.SYNC_FULL_SOURCE_REFRESH !== 'false';
const REBUILD_ON_VARIANT_CHANGE = process.env.SYNC_REBUILD_ON_VARIANT_CHANGE !== 'false';
const SYNC_JOB_WAIT_TIMEOUT_MS = Number(process.env.SYNC_JOB_WAIT_TIMEOUT_MS || 15 * 60 * 1000);
const SYNC_JOB_RECOVERY_ENABLED = process.env.SYNC_JOB_RECOVERY_ENABLED !== 'false';
const SYNC_JOB_RECOVERY_LIMIT = Number(process.env.SYNC_JOB_RECOVERY_LIMIT || 50);
const SYNC_JOB_STALE_RUNNING_MINUTES = Number(process.env.SYNC_JOB_STALE_RUNNING_MINUTES || 10);
const MAX_SHOPIFY_MEDIA_ITEMS = 250;
const scraperService = new ScraperService();

type CatalogSyncOptions = {
  reason?: string;
  refreshSource?: boolean;
  pricingRuleId?: string | null;
  priceMultiplier?: number | null;
  priceOverride?: number | null;
  collections?: string[];
  sheetMeta?: Record<string, any>;
};

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

function isProductionRuntime() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

function hasShopifySyncRuntimeConfig() {
  if (!isProductionRuntime()) return true;
  return Boolean(String(process.env.ENCRYPTION_KEY || '').trim());
}

function isShopifyRuntimeConfigError(error: any) {
  const message = String(error?.message || error || '');
  return /ENCRYPTION_KEY is required in production|Shopify connection needs to be reconnected|No active Shopify connection found/i.test(message);
}

function toPositiveNumber(value: any): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function moneyClose(left: any, right: any): boolean {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.01;
}

function formatShopifyPrice(value: number): string {
  return Number(value).toFixed(2);
}

function getImportMeta(product: any): Record<string, any> {
  const parsed = parseProductRaw(product?.raw);
  const importMeta = parsed?.import;
  return importMeta && typeof importMeta === 'object' ? importMeta : {};
}

function cleanStringList(values: any): string[] {
  return Array.isArray(values)
    ? values.map(value => cleanOptionText(value)).filter(Boolean)
    : [];
}

function parseStoredCollectionIds(value: any): string[] {
  const raw = cleanOptionText(value);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return cleanStringList(parsed);
  } catch {
    return raw
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean);
  }
}

function getSyncCollections(product: any, options: CatalogSyncOptions): string[] {
  const requested = cleanStringList(options.collections);
  return requested.length ? requested : parseStoredCollectionIds(product?.shopifyProduct?.collectionIds);
}

function normalizeFreshProductPrices(product: NormalizedProduct, options: CatalogSyncOptions): NormalizedProduct {
  const priceOverride = toPositiveNumber(options.priceOverride);
  const variants = product.variants.map((variant) => {
    const variantPrice =
      priceOverride ||
      toPositiveNumber(variant.price) ||
      toPositiveNumber(product.price) ||
      0;

    return {
      ...variant,
      price: variantPrice,
      currency: variant.currency || product.currency,
    };
  });
  const variantPrices = variants
    .map(variant => toPositiveNumber(variant.price))
    .filter((price): price is number => Boolean(price));

  return {
    ...product,
    price: priceOverride || (variantPrices.length ? Math.min(...variantPrices) : product.price),
    variants,
  };
}

function variantOptionValues(variant: any): Record<string, string> {
  const parsedRaw = parseVariantRaw(variant?.raw);
  const optionValues = {
    ...(parsedRaw?.optionValues && typeof parsedRaw.optionValues === 'object'
      ? parsedRaw.optionValues
      : {}),
    ...(variant?.optionValues && typeof variant.optionValues === 'object'
      ? variant.optionValues
      : {}),
  };
  const values: Record<string, string> = {};

  for (const [name, value] of Object.entries(optionValues)) {
    const cleanName = cleanOptionText(name === 'Colour' ? 'Color' : name);
    const cleanValue = cleanOptionText(value);
    if (cleanName && cleanValue && !/^default$/i.test(cleanValue)) {
      values[cleanName] = cleanValue;
    }
  }

  if (variant?.color) values.Color = cleanOptionText(variant.color);
  if (variant?.size) values.Size = cleanOptionText(variant.size);

  return values;
}

function variantOptionKey(variant: any): string {
  return Object.entries(variantOptionValues(variant))
    .map(([name, value]) => `${normalizeForMatch(name)}=${normalizeForMatch(value)}`)
    .sort()
    .join('|');
}

function variantMatchKeys(variant: any): string[] {
  const keys: string[] = [];
  const sourceVariantId = normalizeForMatch(variant?.sourceVariantId);
  const sku = normalizeForMatch(variant?.sku);
  const color = normalizeForMatch(variant?.color || variantOptionValues(variant).Color);
  const size = normalizeForMatch(variant?.size || variantOptionValues(variant).Size);
  const options = variantOptionKey(variant);

  if (sourceVariantId) keys.push(`source:${sourceVariantId}`);
  if (sku) keys.push(`sku:${sku}`);
  if (color || size) keys.push(`combo:${color}|${size}`);
  if (options) keys.push(`options:${options}`);

  return [...new Set(keys)];
}

function primaryVariantKey(variant: any, index: number): string {
  return variantMatchKeys(variant)[0] || `index:${index}`;
}

function buildVariantLookup(variants: any[]): Map<string, any> {
  const lookup = new Map<string, any>();
  variants.forEach((variant, index) => {
    lookup.set(`index:${index}`, variant);
    for (const key of variantMatchKeys(variant)) {
      if (!lookup.has(key)) lookup.set(key, variant);
    }
  });
  return lookup;
}

function findMatchingStoredVariant(
  freshVariant: any,
  freshIndex: number,
  lookup: Map<string, any>,
) {
  for (const key of variantMatchKeys(freshVariant)) {
    const match = lookup.get(key);
    if (match) return match;
  }

  return lookup.get(`index:${freshIndex}`) || null;
}

function diffVariantStructure(existingVariants: any[], freshVariants: any[]) {
  const existingKeys = existingVariants.map(primaryVariantKey);
  const freshKeys = freshVariants.map(primaryVariantKey);
  const existingSet = new Set(existingKeys);
  const freshSet = new Set(freshKeys);
  const added = freshKeys.filter(key => !existingSet.has(key));
  const removed = existingKeys.filter(key => !freshSet.has(key));

  return {
    changed:
      existingVariants.length !== freshVariants.length ||
      added.length > 0 ||
      removed.length > 0,
    added,
    removed,
  };
}

function buildProductRawAfterSourceSync(
  existingProduct: any,
  freshProduct: NormalizedProduct,
  options: CatalogSyncOptions,
) {
  const currentRaw = parseProductRaw(existingProduct?.raw);
  const currentImportMeta = getImportMeta(existingProduct);
  const nextImportMeta = {
    ...currentImportMeta,
    ...(options.sheetMeta || {}),
    ...(options.pricingRuleId ? { pricingRuleId: options.pricingRuleId } : {}),
    ...(toPositiveNumber(options.priceOverride)
      ? { sheetPriceOverride: toPositiveNumber(options.priceOverride) }
      : {}),
    ...(toPositiveNumber(options.priceMultiplier)
      ? { sheetPriceMultiplier: toPositiveNumber(options.priceMultiplier) }
      : {}),
    lastSourceSyncedAt: new Date().toISOString(),
    lastSourceSyncReason: cleanOptionText(options.reason || 'scheduled'),
  };

  return JSON.stringify({
    ...currentRaw,
    options: freshProduct.options,
    raw: freshProduct.raw,
    import: nextImportMeta,
  });
}

function imageRecordsForProduct(product: NormalizedProduct) {
  return product.images
    .filter(image => normalizeUrl(image.url))
    .map((image, index) => ({
      url: normalizeUrl(image.url),
      alt: image.alt || product.title,
      color: image.color,
      position: Number.isInteger(image.position) ? image.position : index,
    }));
}

function sourceVariantDataFromFresh(
  product: NormalizedProduct,
  variant: NormalizedProduct['variants'][number],
  index: number,
) {
  const sourcePrice =
    toPositiveNumber(variant.price) ||
    toPositiveNumber(product.price) ||
    0;

  return {
    sourceVariantId:
      variant.sourceVariantId ||
      variant.sku ||
      `${product.source.productId || 'variant'}-${index + 1}`,
    sku: variant.sku,
    color: variant.color,
    size: variant.size,
    price: sourcePrice,
    currency: variant.currency || product.currency,
    available: variant.available ?? true,
    stockStatus: variant.stockStatus || 'unknown',
    imageUrl: variant.imageUrl,
    raw: JSON.stringify({
      optionValues: variant.optionValues,
      raw: variant.raw,
    }),
  };
}

async function resolvePricingRule(product: any, options: CatalogSyncOptions) {
  const payloadMultiplier = toPositiveNumber(options.priceMultiplier);
  const importMeta = getImportMeta(product);
  const storedMultiplier = toPositiveNumber(importMeta.sheetPriceMultiplier);
  const multiplier = payloadMultiplier || storedMultiplier;
  if (multiplier) {
    return {
      multiplier,
      fixedMarkup: 0,
      percentageMarkup: 0,
      rounding: 'none',
      minPrice: null,
      maxPrice: null,
    };
  }

  const pricingRuleId =
    cleanOptionText(options.pricingRuleId) ||
    cleanOptionText(importMeta.pricingRuleId);
  if (pricingRuleId) {
    const rule = await prisma.pricingRule.findUnique({ where: { id: pricingRuleId } });
    if (rule) return rule;
  }

  const rules = await prisma.pricingRule.findMany();
  return PricingEngine.selectBestRule(rules, {
    supplierId: product.supplierId,
    currency: product.currency,
  });
}

function calculatedVariantPrice(sourcePrice: any, rule: any) {
  const price = toPositiveNumber(sourcePrice);
  if (!price) return null;
  return rule ? PricingEngine.calculatePrice(price, rule) : Number(price.toFixed(2));
}

function isTransientQueueDbError(error: any) {
  const message = String(error?.message || error || '');
  return (
    ['P1001', 'P1017'].includes(String(error?.code || '')) ||
    /can't reach database server|server has closed the connection|connection terminated|econnreset|timeout|forcibly closed/i.test(
      message,
    )
  );
}

async function queueDbRetry<T>(
  label: string,
  operation: () => Promise<T>,
  attempts = 8,
): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      if (!isTransientQueueDbError(error) || attempt === attempts) break;
      const delayMs = Math.min(30000, 1500 * attempt);
      console.warn(`${label} transient DB error; retry ${attempt}/${attempts}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

export class QueueService {
  private static queue = new PQueue({ concurrency: 2 });
  private static inventoryMonitorStarted = false;
  private static inventoryMonitorTimer: ReturnType<typeof setInterval> | null = null;

  static async addTask(type: string, payload: any) {
    if (type === 'SYNC_PRODUCT' && payload?.sourceProductId) {
      const activeJobs = await prisma.syncJob.findMany({
        where: {
          type: 'SYNC_PRODUCT',
          status: { in: ['pending', 'running'] },
          createdAt: {
            gte: new Date(Date.now() - SYNC_JOB_WAIT_TIMEOUT_MS),
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      const existingJob = activeJobs.find((job) => {
        try {
          const existingPayload = JSON.parse(job.payload || '{}');
          return existingPayload?.sourceProductId === payload.sourceProductId;
        } catch {
          return false;
        }
      });

      if (existingJob) return existingJob;
    }

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

  static async recoverInterruptedJobs() {
    if (!SYNC_JOB_RECOVERY_ENABLED) {
      console.log('Sync job recovery disabled by SYNC_JOB_RECOVERY_ENABLED=false');
      return { recovered: 0 };
    }

    const staleMinutes =
      Number.isFinite(SYNC_JOB_STALE_RUNNING_MINUTES) && SYNC_JOB_STALE_RUNNING_MINUTES > 0
        ? SYNC_JOB_STALE_RUNNING_MINUTES
        : 10;
    const recoveryLimit =
      Number.isFinite(SYNC_JOB_RECOVERY_LIMIT) && SYNC_JOB_RECOVERY_LIMIT > 0
        ? Math.floor(SYNC_JOB_RECOVERY_LIMIT)
        : 50;
    const staleCutoff = new Date(Date.now() - staleMinutes * 60 * 1000);
    const recoverableTypes = [
      'PUBLISH_TO_SHOPIFY',
      'REPUBLISH_TO_SHOPIFY',
      'SYNC_PRODUCT',
      'SYNC_INVENTORY',
    ];
    const jobs = await prisma.syncJob.findMany({
      where: {
        type: { in: recoverableTypes },
        OR: [
          { status: 'pending' },
          {
            status: 'running',
            OR: [
              { startedAt: null },
              { startedAt: { lte: staleCutoff } },
            ],
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: recoveryLimit,
    });

    const recoveredProductIds = new Set<string>();
    for (const job of jobs) {
      if (job.type === 'SYNC_PRODUCT') {
        let sourceProductId = '';
        try {
          sourceProductId = cleanOptionText(JSON.parse(job.payload || '{}')?.sourceProductId);
        } catch {}

        if (sourceProductId && recoveredProductIds.has(sourceProductId)) {
          await prisma.syncJob.update({
            where: { id: job.id },
            data: {
              status: 'completed',
              completedAt: new Date(),
              result: JSON.stringify({
                skipped: true,
                reason: 'Duplicate recovered SYNC_PRODUCT job for the same product',
                sourceProductId,
              }),
            },
          });
          continue;
        }

        if (sourceProductId) recoveredProductIds.add(sourceProductId);
      }

      if (job.status === 'running') {
        await prisma.syncJob.update({
          where: { id: job.id },
          data: { status: 'pending', startedAt: null },
        });
      }
      this.processJob(job.id);
    }

    if (jobs.length > 0) {
      console.log(`Recovered ${jobs.length} interrupted sync job(s)`);
    }

    return { recovered: jobs.length };
  }

  static startInventoryMonitor() {
    if (this.inventoryMonitorStarted) return;
    if (process.env.SYNC_INVENTORY_AUTOSTART === 'false') {
      console.log('Inventory monitor disabled by SYNC_INVENTORY_AUTOSTART=false');
      return;
    }
    if (!hasShopifySyncRuntimeConfig()) {
      console.warn('Inventory monitor disabled: ENCRYPTION_KEY is missing in production.');
      return;
    }

    const intervalMinutes = Number.isFinite(INVENTORY_SYNC_INTERVAL_MINUTES) && INVENTORY_SYNC_INTERVAL_MINUTES > 0
      ? INVENTORY_SYNC_INTERVAL_MINUTES
      : 30;
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

  private static async waitForJobCompletion(jobId: string, timeoutMs = SYNC_JOB_WAIT_TIMEOUT_MS) {
    const deadline = Date.now() + Math.max(30_000, timeoutMs);

    while (Date.now() < deadline) {
      const job = await prisma.syncJob.findUnique({ where: { id: jobId } });
      if (!job) throw new Error(`Missing sync job ${jobId}`);

      if (job.status === 'completed' || job.status === 'failed') {
        let parsedResult: any = {};
        try {
          parsedResult = job.result ? JSON.parse(job.result) : {};
        } catch {}
        return { ...job, parsedResult };
      }

      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    throw new Error(`Timed out waiting for sync job ${jobId}`);
  }

  private static async refreshStoredSourceProduct(
    existingProduct: any,
    freshProduct: NormalizedProduct,
    options: CatalogSyncOptions,
  ) {
    const variantLookup = buildVariantLookup(existingProduct.variants || []);
    const imageRecords = imageRecordsForProduct(freshProduct);

    await prisma.$transaction(async (tx) => {
      await tx.sourceImage.deleteMany({
        where: { sourceProductId: existingProduct.id },
      });

      await tx.sourceProduct.update({
        where: { id: existingProduct.id },
        data: {
          productId: freshProduct.source.productId,
          title: freshProduct.title,
          description: freshProduct.description,
          brand: freshProduct.brand || freshProduct.source.supplier,
          currency: freshProduct.currency,
          price: freshProduct.price,
          raw: buildProductRawAfterSourceSync(existingProduct, freshProduct, options),
          syncStatus: 'active',
          images: { create: imageRecords },
        },
      });

      for (const [index, freshVariant] of freshProduct.variants.entries()) {
        const existingVariant = findMatchingStoredVariant(freshVariant, index, variantLookup);
        const data = sourceVariantDataFromFresh(freshProduct, freshVariant, index);

        if (existingVariant?.id) {
          await tx.sourceVariant.update({
            where: { id: existingVariant.id },
            data,
          });
        } else {
          await tx.sourceVariant.create({
            data: {
              ...data,
              sourceProductId: existingProduct.id,
            },
          });
        }
      }
    });

    return prisma.sourceProduct.findUnique({
      where: { id: existingProduct.id },
      include: {
        variants: { include: { shopifyVariant: true } },
        images: true,
        shopifyProduct: true,
        supplier: true,
      },
    });
  }

  private static async rebuildLinkedProductFromFreshSource(
    client: any,
    existingProduct: any,
    freshProduct: NormalizedProduct,
    options: CatalogSyncOptions,
  ) {
    const collections = getSyncCollections(existingProduct, options);
    const importMeta = getImportMeta(existingProduct);
    const pricingRuleId =
      cleanOptionText(options.pricingRuleId) ||
      cleanOptionText(importMeta.pricingRuleId) ||
      null;
    const priceMultiplier =
      toPositiveNumber(options.priceMultiplier) ||
      toPositiveNumber(importMeta.sheetPriceMultiplier);
    const shopifyId = existingProduct.shopifyProduct?.shopifyId;

    if (!shopifyId) {
      throw new Error('Product is not linked to Shopify');
    }

    await ShopifyService.deleteProduct(client, shopifyId);

    await prisma.$transaction(async (tx) => {
      if (existingProduct.shopifyProduct?.id) {
        await tx.shopifyVariant.deleteMany({
          where: { shopifyProductId: existingProduct.shopifyProduct.id },
        });
        await tx.shopifyProduct.delete({
          where: { id: existingProduct.shopifyProduct.id },
        });
      }

      await tx.sourceImage.deleteMany({
        where: { sourceProductId: existingProduct.id },
      });
      await tx.sourceVariant.deleteMany({
        where: { sourceProductId: existingProduct.id },
      });
      await tx.manualReviewItem.deleteMany({
        where: { sourceProductId: existingProduct.id, status: 'pending' },
      });

      await tx.sourceProduct.update({
        where: { id: existingProduct.id },
        data: {
          productId: freshProduct.source.productId,
          title: freshProduct.title,
          description: freshProduct.description,
          brand: freshProduct.brand || freshProduct.source.supplier,
          currency: freshProduct.currency,
          price: freshProduct.price,
          raw: buildProductRawAfterSourceSync(existingProduct, freshProduct, options),
          syncStatus: 'pending',
          images: { create: imageRecordsForProduct(freshProduct) },
          variants: {
            create: freshProduct.variants.map((variant, index) =>
              sourceVariantDataFromFresh(freshProduct, variant, index),
            ),
          },
        },
      });
    });

    const publishJob = await this.addTask('PUBLISH_TO_SHOPIFY', {
      sourceProductId: existingProduct.id,
      pricingRuleId,
      collections,
      ...(priceMultiplier ? { priceMultiplier } : {}),
    });
    const finishedJob = await this.waitForJobCompletion(publishJob.id);

    if (finishedJob.status === 'failed') {
      throw new Error(
        cleanOptionText(finishedJob.parsedResult?.error) ||
          `Shopify rebuild publish failed (${publishJob.id})`,
      );
    }

    return {
      productRebuilt: true,
      rebuildPublishJobId: publishJob.id,
      rebuiltShopifyId: cleanOptionText(finishedJob.parsedResult?.shopifyId),
      variantsCreated: Number(finishedJob.parsedResult?.variantsCreated || 0),
      variantsExpected: Number(finishedJob.parsedResult?.variantsExpected || 0),
    };
  }

  private static async syncProductInventory(
    sourceProductId: string,
    jobId: string,
    options: CatalogSyncOptions = {},
  ) {
    let product = await prisma.sourceProduct.findUnique({
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
    if (!product.shopifyProduct.syncEnabled) {
      return { skipped: true, reason: 'Product sync is disabled', sourceProductId };
    }

    const shouldSyncInventory = Boolean(product.shopifyProduct.syncInventory);
    const shouldSyncPrice = Boolean(product.shopifyProduct.syncPrice);
    const shouldSyncImages = Boolean(product.shopifyProduct.syncImages);
    if (!shouldSyncInventory && !shouldSyncPrice && !shouldSyncImages) {
      return { skipped: true, reason: 'Price, inventory, and image sync are disabled for product', sourceProductId };
    }

    const client = await ShopifyService.getClientFromDb(prisma);
    const inventoryLocation = await ShopifyService.getInventoryLocation(client);
    const summary: any = {
      sourceProductId,
      shopifyProductId: product.shopifyProduct.shopifyId,
      inventoryLocationId: inventoryLocation.id,
      inventoryLocationName: inventoryLocation.name,
      reason: cleanOptionText(options.reason || 'scheduled'),
      sourceRefreshed: false,
      productDetailsUpdated: false,
      productRebuilt: false,
      variantStructureChanged: false,
      variantsAdded: 0,
      variantsRemoved: 0,
      variantsChecked: product.variants.length,
      pricesChecked: 0,
      pricesUpdated: 0,
      variantsUpdated: 0,
      inStock: 0,
      outOfStock: 0,
      lowStock: 0,
      skippedVariants: 0,
      variantImagesChecked: 0,
      variantImagesUpdated: 0,
      sourceRefreshError: null,
    };

    const shouldRefreshSource =
      FULL_SOURCE_SYNC_ENABLED && options.refreshSource !== false;
    if (shouldRefreshSource) {
      try {
        const scraped = normalizeFreshProductPrices(
          await scraperService.scrape(product.url),
          options,
        );
        const variantDiff = diffVariantStructure(product.variants || [], scraped.variants || []);
        summary.variantStructureChanged = variantDiff.changed;
        summary.variantsAdded = variantDiff.added.length;
        summary.variantsRemoved = variantDiff.removed.length;
        summary.sourceVariantsScraped = scraped.variants.length;

        if (variantDiff.changed && REBUILD_ON_VARIANT_CHANGE) {
          const rebuildResult = await this.rebuildLinkedProductFromFreshSource(
            client,
            product,
            scraped,
            options,
          );
          const rebuildSummary = {
            ...summary,
            ...rebuildResult,
            sourceRefreshed: true,
          };
          await prisma.auditLog.create({
            data: {
              sourceProductId: product.id,
              action: 'SYNC_PRODUCT_FULL',
              details: JSON.stringify(rebuildSummary),
            },
          });
          return rebuildSummary;
        }

        const refreshedProduct = await this.refreshStoredSourceProduct(product, scraped, options);
        if (refreshedProduct) {
          product = refreshedProduct;
          summary.sourceRefreshed = true;
          summary.variantsChecked = product.variants.length;
        }

        const productUpdate = await ShopifyService.updateProductDetails(
          client,
          product.shopifyProduct.shopifyId,
          {
            title: product.title,
            descriptionHtml: product.description || undefined,
            vendor: product.brand || product.supplier.name,
            status: 'ACTIVE',
            tags: [product.supplier.name, product.brand, 'SyncEngine'].filter(Boolean),
          },
        );
        const productUpdateErrors = productUpdate.productUpdate?.userErrors || [];
        if (productUpdateErrors.length > 0) {
          throw new Error(`Shopify Product Update Error: ${productUpdateErrors[0].message}`);
        }
        summary.productDetailsUpdated = true;
      } catch (error: any) {
        if (summary.variantStructureChanged && REBUILD_ON_VARIANT_CHANGE) {
          throw error;
        }
        summary.sourceRefreshError = error?.message || 'Source refresh failed';
      }
    }

    const availabilitySnapshot = shouldSyncInventory
      ? await scraperService.checkAvailability(product.url)
      : { available: true, variants: [] };
    const shopifyInventoryVariants = await ShopifyService.getProductInventoryVariants(
      client,
      product.shopifyProduct.shopifyId,
    );
    const shopifyVariantById = new Map<string, any>(
      shopifyInventoryVariants.map((variant: any) => [variant.id, variant]),
    );

    const quantities: Array<{ inventoryItemId: string; quantity: number }> = [];
    const priceUpdates: Array<{ id: string; price: string }> = [];
    const sourceUpdates: any[] = [];
    const imageVariantPayloads: Array<{ sourceVariant: any; imageUrl: string; input: any }> = [];
    const pricingRule = shouldSyncPrice ? await resolvePricingRule(product, options) : null;

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

      if (shouldSyncPrice && shopifyVariant) {
        const targetPrice = calculatedVariantPrice(sourceVariant.price || product.price, pricingRule);
        if (targetPrice) {
          summary.pricesChecked += 1;
          if (
            !moneyClose(shopifyVariant.price, targetPrice) ||
            !moneyClose(inventoryVariant?.price, targetPrice)
          ) {
            priceUpdates.push({
              id: shopifyVariant.shopifyId,
              price: formatShopifyPrice(targetPrice),
            });
            sourceUpdates.push(
              prisma.shopifyVariant.update({
                where: { id: shopifyVariant.id },
                data: { price: targetPrice },
              }),
            );
          }
        }
      }

      if (!shouldSyncInventory) {
        continue;
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

    if (priceUpdates.length > 0) {
      const priceResponse = await ShopifyService.updateVariantsBulk(
        client,
        product.shopifyProduct.shopifyId,
        priceUpdates,
      );
      const priceErrors = priceResponse.productVariantsBulkUpdate?.userErrors || [];
      if (priceErrors.length > 0) {
        throw new Error(`Shopify Price Sync Error: ${priceErrors[0].message}`);
      }
      summary.pricesUpdated = priceUpdates.length;
    }

    if (shouldSyncInventory) {
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
    }

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

    const collections = getSyncCollections(product, options);
    if (collections.length > 0) {
      for (const collectionId of collections) {
        await ShopifyService.addProductToCollection(
          client,
          product.shopifyProduct.shopifyId,
          collectionId,
        );
      }
      await prisma.shopifyProduct.update({
        where: { id: product.shopifyProduct.id },
        data: { collectionIds: collections.join(',') },
      });
      summary.collectionsEnsured = collections.length;
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
          action: 'SYNC_PRODUCT_FULL',
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
            OR: [
              { syncInventory: true },
              { syncPrice: true },
              { syncImages: true },
            ],
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

  private static processJob(jobId: string) {
    void this.queue.add(async () => {
      let job: any = null;
      try {
        job = await queueDbRetry('syncJob.findUnique.start', () =>
          prisma.syncJob.findUnique({ where: { id: jobId } }),
        );
        if (!job) return;

        await queueDbRetry('syncJob.update.running', () =>
          prisma.syncJob.update({
            where: { id: jobId },
            data: { status: 'running', startedAt: new Date() }
          }),
        );

        const payload = JSON.parse(job.payload || '{}');
        let result: any = {};

        switch (job.type) {
          case 'PUBLISH_TO_SHOPIFY': {
            const { sourceProductId, pricingRuleId, collections, priceMultiplier } = payload;
            let createdShopifyProductId: string | null = null;
            let client: any = null;
            
            // 1. Fetch source product
            const product = await prisma.sourceProduct.findUnique({
              where: { id: sourceProductId },
              include: { variants: true, images: true, supplier: true }
            });
            if (!product) throw new Error('Source product not found');

            // 2. Prepare Shopify Input
            client = await ShopifyService.getClientFromDb(prisma);
            
            // Apply pricing rule
            let rule: any = null;
            const payloadMultiplier = Number(priceMultiplier);
            if (Number.isFinite(payloadMultiplier) && payloadMultiplier > 0) {
              rule = {
                multiplier: payloadMultiplier,
                fixedMarkup: 0,
                percentageMarkup: 0,
                rounding: 'none',
                minPrice: null,
                maxPrice: null,
              };
            } else if (pricingRuleId) {
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

            try {
              // 3. Create in Shopify
              const shopifyResponse = await ShopifyService.createProduct(client, input);
              const { product: shopifyProductResult, userErrors } = shopifyResponse.productCreate;

              if (userErrors && userErrors.length > 0) {
                throw new Error(`Shopify Error: ${userErrors[0].message}`);
              }
              createdShopifyProductId = shopifyProductResult?.id || null;

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
              const verifiedShopifyProduct = await ShopifyService.getProductBasic(
                client,
                shopifyProductResult.id,
              );

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
                variantsLinked: createdVariants.length,
                variantsExpected: variantPayloads.length,
                variantsVerified: createdVariants.length === variantPayloads.length,
                shopifyVerified: Boolean(verifiedShopifyProduct?.id),
                shopifyStatus: String(verifiedShopifyProduct?.status || shopifyProductResult.status || 'ACTIVE').toLowerCase(),
                salesChannelsPublished: publicationResult.publishedCount,
                salesChannels: publicationResult.publications
                  .flatMap((publication: any) => publication.channels || [])
                  .map((channel: any) => channel.name || channel.handle)
                  .filter(Boolean),
                publicationWarning: publicationResult.warning,
              };
            } catch (publishError: any) {
              if (createdShopifyProductId) {
                try {
                  await ShopifyService.deleteProduct(client, createdShopifyProductId);
                } catch (cleanupError: any) {
                  const cleanupMessage = cleanupError?.message || 'unknown cleanup error';
                  throw new Error(
                    `${publishError?.message || publishError}; rollback failed for ${createdShopifyProductId}: ${cleanupMessage}`,
                  );
                }
              }
              throw publishError;
            }
            break;
          }
          case 'REPUBLISH_TO_SHOPIFY': {
            const { sourceProductId } = payload;
            if (!sourceProductId) throw new Error('Missing sourceProductId');

            const product = await prisma.sourceProduct.findUnique({
              where: { id: sourceProductId },
              include: {
                shopifyProduct: { include: { variants: true } },
              },
            });
            if (!product) throw new Error('Source product not found');

            if (!product.shopifyProduct) {
              const publishJob = await this.addTask('PUBLISH_TO_SHOPIFY', {
                sourceProductId,
              });
              result = {
                republishMode: 'publish_new',
                queuedPublishJobId: publishJob.id,
              };
              break;
            }

            const client = await ShopifyService.getClientFromDb(prisma);
            const existingShopifyProduct = await ShopifyService.getProductBasic(
              client,
              product.shopifyProduct.shopifyId,
            );

            if (!existingShopifyProduct) {
              const collectionIds = product.shopifyProduct.collectionIds
                ?.split(',')
                .map((collectionId: string) => collectionId.trim())
                .filter(Boolean);

              await prisma.$transaction(async (tx) => {
                await tx.shopifyVariant.deleteMany({
                  where: { shopifyProductId: product.shopifyProduct!.id },
                });
                await tx.shopifyProduct.delete({
                  where: { id: product.shopifyProduct!.id },
                });
                await tx.sourceProduct.update({
                  where: { id: sourceProductId },
                  data: { syncStatus: 'pending' },
                });
              });

              const publishJob = await this.addTask('PUBLISH_TO_SHOPIFY', {
                sourceProductId,
                collections: collectionIds || [],
              });
              result = {
                republishMode: 'recreate_deleted_shopify_product',
                queuedPublishJobId: publishJob.id,
              };
              break;
            }

            const updateResponse = await ShopifyService.updateProductStatus(
              client,
              product.shopifyProduct.shopifyId,
              'ACTIVE',
            );
            const updateErrors = updateResponse.productUpdate?.userErrors || [];
            if (updateErrors.length > 0) {
              throw new Error(`Shopify Product Update Error: ${updateErrors[0].message}`);
            }

            const publicationResult = await ShopifyService.publishProductToSalesChannels(
              client,
              product.shopifyProduct.shopifyId,
            );
            const publicationErrors = publicationResult.userErrors || [];
            const verifiedShopifyProduct = await ShopifyService.getProductBasic(
              client,
              product.shopifyProduct.shopifyId,
            );
            const verifiedShopifyVariants = await ShopifyService.getProductInventoryVariants(
              client,
              product.shopifyProduct.shopifyId,
            );

            await prisma.shopifyProduct.update({
              where: { id: product.shopifyProduct.id },
              data: {
                handle:
                  verifiedShopifyProduct?.handle ||
                  updateResponse.productUpdate?.product?.handle ||
                  existingShopifyProduct.handle,
                status: String(
                  verifiedShopifyProduct?.status ||
                    updateResponse.productUpdate?.product?.status ||
                    'ACTIVE',
                ).toLowerCase(),
              },
            });
            await prisma.sourceProduct.update({
              where: { id: sourceProductId },
              data: { syncStatus: 'active' },
            });

            result = {
              republishMode: 'existing_shopify_product',
              shopifyId: product.shopifyProduct.shopifyId,
              shopifyVerified: Boolean(verifiedShopifyProduct?.id),
              shopifyStatus: String(verifiedShopifyProduct?.status || 'ACTIVE').toLowerCase(),
              variantsLinked: product.shopifyProduct.variants.length,
              variantsVerifiedOnShopify: verifiedShopifyVariants.length,
              variantsVerified:
                product.shopifyProduct.variants.length === 0 ||
                verifiedShopifyVariants.length >= product.shopifyProduct.variants.length,
              salesChannelsPublished: publicationResult.publishedCount,
              salesChannels: publicationResult.publications
                .flatMap((publication: any) => publication.channels || [])
                .map((channel: any) => channel.name || channel.handle)
                .filter(Boolean),
              publicationWarning:
                publicationErrors.length > 0
                  ? `Shopify publication warning: ${publicationErrors[0].message}`
                  : null,
            };
            break;
          }
          case 'SCRAPE_PRODUCT':
            // Scrape logic would go here
            break;
          case 'SYNC_PRODUCT': {
            const { sourceProductId } = payload;
            if (!sourceProductId) throw new Error('Missing sourceProductId');
            result = await this.syncProductInventory(sourceProductId, jobId, payload);
            break;
          }
          case 'SYNC_INVENTORY':
            result = await this.queueInventorySyncBatch();
            break;
          default:
            throw new Error(`Unknown job type: ${job.type}`);
        }

        await queueDbRetry('syncJob.update.completed', () =>
          prisma.syncJob.update({
            where: { id: jobId },
            data: {
              status: 'completed',
              completedAt: new Date(),
              result: JSON.stringify(result)
            }
          }),
        );
      } catch (error: any) {
        if (!job) {
          console.error('Failed to start sync job:', error?.message || error);
          return;
        }

        if (job.type === 'PUBLISH_TO_SHOPIFY') {
          try {
            const payload = JSON.parse(job.payload || '{}');
            const sourceProductId = String(payload?.sourceProductId || '').trim();
            if (sourceProductId) {
              const sourceProduct = await prisma.sourceProduct.findUnique({
                where: { id: sourceProductId },
                select: { id: true, shopifyProduct: { select: { id: true } } },
              });

              // If Shopify product creation partially succeeded but DB linking did not,
              // we still mark source product as error and keep catalog state consistent.
              if (sourceProduct && !sourceProduct.shopifyProduct) {
                await prisma.sourceProduct.update({
                  where: { id: sourceProduct.id },
                  data: { syncStatus: 'error' },
                });
              }
            }
          } catch {}
        }

        try {
          const payload = JSON.parse(job.payload || '{}');
          if (
            (job.type === 'SYNC_PRODUCT' || job.type === 'PUBLISH_TO_SHOPIFY' || job.type === 'REPUBLISH_TO_SHOPIFY') &&
            payload.sourceProductId &&
            !isShopifyRuntimeConfigError(error)
          ) {
            await prisma.sourceProduct.updateMany({
              where: { id: payload.sourceProductId },
              data: { syncStatus: 'error' },
            });
          }
        } catch {}

        try {
          await queueDbRetry('syncJob.update.failed', () =>
            prisma.syncJob.update({
              where: { id: jobId },
              data: {
                status: 'failed',
                completedAt: new Date(),
                result: JSON.stringify({ error: error.message })
              }
            }),
          );
        } catch (statusError: any) {
          console.error(
            `Failed to mark sync job ${jobId} as failed:`,
            statusError?.message || statusError,
          );
        }
      }
    });
  }
}
