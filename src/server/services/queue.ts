import PQueue from 'p-queue';
import { prisma } from '../db.js';
import { ShopifyService } from './shopify.js';
import { PricingEngine } from './pricing.js';

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

function formatPrice(value: number) {
  return Number(value.toFixed(2));
}

function buildVariantPayloads(product: any, rule: any, optionNames: string[]) {
  const seen = new Set<string>();

  return product.variants
    .map((variant: any) => {
      const optionValues = buildShopifyVariantOptions(variant, optionNames);
      const key = optionValues.join('||');
      const sourcePrice = variant.price || product.price;
      const calculatedPrice = rule
        ? PricingEngine.calculatePrice(sourcePrice, rule)
        : sourcePrice;

      return {
        key,
        sourceVariant: variant,
        price: formatPrice(calculatedPrice),
        input: {
          price: formatPrice(calculatedPrice),
          optionValues: optionNames.map((optionName, index) => ({
            optionName,
            name: optionValues[index],
          })),
          inventoryItem: {
            sku: variant.sku || `${product.supplier.name}-${product.productId || product.id}-${variant.id.slice(-4)}`,
            tracked: true,
          },
        },
      };
    })
    .filter((variantPayload: any) => {
      if (seen.has(variantPayload.key)) return false;
      seen.add(variantPayload.key);
      return true;
    });
}

export class QueueService {
  private static queue = new PQueue({ concurrency: 2 });

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
            const rule = pricingRuleId 
              ? await prisma.pricingRule.findUnique({ where: { id: pricingRuleId } })
              : await prisma.pricingRule.findFirst({ where: { isDefault: true } });

            const optionNames = buildShopifyOptionNames(product.variants);
            const variantPayloads = buildVariantPayloads(product, rule, optionNames);
            if (variantPayloads.length === 0) {
              throw new Error('No variants available to publish');
            }

            const input: any = {
              product: {
                title: product.title,
                descriptionHtml: product.description || undefined,
                vendor: product.brand || product.supplier.name,
                status: 'DRAFT',
                tags: [product.supplier.name, product.brand, 'SyncEngine'].filter(Boolean),
                productOptions: buildShopifyProductOptions(product.variants, optionNames),
              },
              media: product.images
                .filter(img => img.url)
                .slice(0, 20)
                .map(img => ({
                  mediaContentType: 'IMAGE',
                  originalSource: img.url,
                  alt: img.alt || product.title,
                })),
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
                collectionIds: collections?.join(',') || null,
                price: createdVariants[0]?.price ? parseFloat(createdVariants[0].price) : variantPayloads[0].price,
                variants: {
                  create: createdVariants.map((variant: any, index: number) => ({
                    shopifyId: variant.id,
                    sku: variant.inventoryItem?.sku,
                    price: variant.price ? parseFloat(variant.price) : variantPayloads[index]?.price,
                    sourceVariantId: variantPayloads[index]?.sourceVariant.id || product.variants[0].id
                  }))
                }
              }
            });

            // 5. Add to collections if any
            if (collections && collections.length > 0) {
              for (const collectionId of collections) {
                await ShopifyService.addProductToCollection(client, shopifyProductResult.id, collectionId);
              }
            }

            result = { shopifyProductId: dbShopifyProduct.id, shopifyId: shopifyProductResult.id };
            break;
          }
          case 'SCRAPE_PRODUCT':
            // Scrape logic would go here
            break;
          case 'SYNC_PRODUCT':
            result = { message: 'Product sync worker is not configured yet' };
            break;
          case 'SYNC_INVENTORY':
            // Sync logic
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
