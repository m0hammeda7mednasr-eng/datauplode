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

            const input: any = {
              title: product.title,
              descriptionHtml: product.description,
              vendor: product.brand || product.supplier.name,
              status: 'DRAFT',
              tags: [product.supplier.name, product.brand, 'SyncEngine'].filter(Boolean),
              images: product.images.map(img => ({ altText: img.alt, src: img.url })),
              variants: product.variants.map(v => ({
                price: rule ? PricingEngine.calculatePrice(v.price || product.price, rule) : (v.price || product.price),
                sku: v.sku || `${product.supplier.name}-${product.productId}-${v.id.slice(-4)}`,
                inventoryItem: {
                  tracked: true
                },
                options: buildShopifyVariantOptions(v, optionNames)
              })),
              options: optionNames
            };

            // 3. Create in Shopify
            const shopifyResponse = await ShopifyService.createProduct(client, input);
            const { product: shopifyProductResult, userErrors } = shopifyResponse.productCreate;

            if (userErrors && userErrors.length > 0) {
              throw new Error(`Shopify Error: ${userErrors[0].message}`);
            }

            // 4. Save to DB
            const dbShopifyProduct = await prisma.shopifyProduct.create({
              data: {
                sourceProductId,
                shopifyId: shopifyProductResult.id,
                handle: shopifyProductResult.handle,
                collectionIds: collections?.join(',') || null,
                price: parseFloat(shopifyProductResult.variants.edges[0].node.price),
                variants: {
                  create: shopifyProductResult.variants.edges.map((edge: any, index: number) => ({
                    shopifyId: edge.node.id,
                    sku: edge.node.sku,
                    price: parseFloat(edge.node.price),
                    sourceVariantId: product.variants[index]?.id || product.variants[0].id
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
