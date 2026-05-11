import { Router } from 'express';
import { prisma } from './db.js';
import { ScraperService } from './services/scraper.js';
import { PricingEngine } from './services/pricing.js';
import { QueueService } from './services/queue.js';
import { encrypt, decrypt } from './services/encryption.js';
import { ShopifyService } from './services/shopify.js';
import axios from 'axios';
import crypto from 'crypto';

const router = Router();
const scraperService = new ScraperService();

// Analysis
router.post('/imports/analyze', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    const data = await scraperService.scrape(url);
    
    // Find matching pricing rule
    const rule = await prisma.pricingRule.findFirst({
      where: { isDefault: true }
    });

    const calculatedPrice = rule ? PricingEngine.calculatePrice(data.price, rule) : data.price;
    const variants = data.variants.map((variant: any) => {
      const sourcePrice = variant.price || data.price;
      return {
        ...variant,
        price: sourcePrice,
        currency: variant.currency || data.currency,
        calculatedPrice: rule ? PricingEngine.calculatePrice(sourcePrice, rule) : sourcePrice
      };
    });

    res.json({
      ...data,
      variants,
      calculatedPrice,
      pricingRule: rule
    });
  } catch (error: any) {
    res.status(422).json({ error: error.message || 'Failed to analyze product URL' });
  }
});

// Products
router.get('/products', async (req, res) => {
  const { collectionId } = req.query;
  
  const where: any = {};
  if (collectionId) {
    where.shopifyProduct = {
      collectionIds: {
        contains: collectionId as string
      }
    };
  }

  const products = await prisma.sourceProduct.findMany({
    where,
    include: {
      shopifyProduct: true,
      supplier: true,
    },
    orderBy: { updatedAt: 'desc' }
  });
  res.json(products);
});

router.get('/products/:id', async (req, res) => {
  const product = await prisma.sourceProduct.findUnique({
    where: { id: req.params.id },
    include: {
      variants: true,
      images: true,
      shopifyProduct: {
        include: { variants: true }
      },
      supplier: true,
      auditLogs: { orderBy: { createdAt: 'desc' }, take: 10 }
    }
  });
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json(product);
});

// Pricing Rules
router.get('/pricing-rules', async (req, res) => {
  const rules = await prisma.pricingRule.findMany();
  res.json(rules);
});

router.post('/pricing-rules', async (req, res) => {
  const rule = await prisma.pricingRule.create({ data: req.body });
  res.json(rule);
});

// Suppliers
router.get('/suppliers', async (req, res) => {
  const suppliers = await prisma.supplier.findMany({
    orderBy: { name: 'asc' }
  });
  res.json(suppliers);
});

// Sync Jobs
router.get('/sync-jobs', async (req, res) => {
  const jobs = await prisma.syncJob.findMany({
    orderBy: { createdAt: 'desc' },
    take: 50
  });
  res.json(jobs);
});

// Publishing
router.post('/imports/publish', async (req, res) => {
  const { productData, pricingRuleId, collections } = req.body;
  if (!productData) return res.status(400).json({ error: 'Product data is required' });
  if (!productData.source?.url) return res.status(400).json({ error: 'Product source URL is required' });

  try {
    const connection = await prisma.shopifyConnection.findFirst({
      where: { isConnected: true },
      select: { accessTokenEnc: true }
    });

    if (!connection?.accessTokenEnc) {
      return res.status(400).json({ error: 'Connect Shopify before publishing products.' });
    }

    const supplierName = String(productData.source?.supplier || 'Unknown Supplier').trim() || 'Unknown Supplier';
    const images = Array.isArray(productData.images) ? productData.images : [];
    const variants = Array.isArray(productData.variants) && productData.variants.length > 0
      ? productData.variants
      : [{
          sourceVariantId: productData.source.productId || 'default',
          price: productData.price,
          currency: productData.currency,
          available: true,
          stockStatus: 'unknown'
        }];
    const collectionIds = Array.isArray(collections) ? collections : [];

    // 1. Create Source Product record
    const sourceProduct = await prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.upsert({
        where: { name: supplierName },
        update: {},
        create: { name: supplierName, baseUrl: productData.source.url }
      });

      const existingProduct = await tx.sourceProduct.findUnique({
        where: { url: productData.source.url },
        include: { shopifyProduct: true }
      });

      if (existingProduct?.shopifyProduct) {
        throw Object.assign(new Error('This product is already linked to Shopify. Use Sync Now from the product detail page.'), {
          statusCode: 409
        });
      }

      const productRecord = {
        supplierId: supplier.id,
        productId: productData.source.productId,
        title: productData.title,
        description: productData.description,
        brand: productData.brand,
        currency: productData.currency,
        price: productData.price,
        raw: JSON.stringify({
          options: productData.options,
          raw: productData.raw
        }),
        syncStatus: 'active',
      };

      const imageRecords = images
        .filter((img: any) => img?.url)
        .map((img: any, index: number) => ({
          url: img.url,
          alt: img.alt,
          color: img.color,
          position: Number.isInteger(img.position) ? img.position : index
        }));

      const variantRecords = variants.map((v: any, index: number) => ({
        sourceVariantId: v.sourceVariantId || v.sku || `${productData.source.productId || 'variant'}-${index}`,
        sku: v.sku,
        color: v.color,
        size: v.size,
        price: v.price || productData.price,
        currency: v.currency || productData.currency,
        available: v.available ?? true,
        stockStatus: v.stockStatus || 'unknown',
        imageUrl: v.imageUrl,
        raw: JSON.stringify({
          optionValues: v.optionValues,
          calculatedPrice: v.calculatedPrice,
          raw: v.raw
        })
      }));

      if (existingProduct) {
        await tx.sourceImage.deleteMany({ where: { sourceProductId: existingProduct.id } });
        await tx.sourceVariant.deleteMany({ where: { sourceProductId: existingProduct.id } });

        return tx.sourceProduct.update({
          where: { id: existingProduct.id },
          data: {
            ...productRecord,
            images: { create: imageRecords },
            variants: { create: variantRecords }
          }
        });
      }

      return tx.sourceProduct.create({
        data: {
          ...productRecord,
          url: productData.source.url,
          images: { create: imageRecords },
          variants: { create: variantRecords }
        }
      });
    });

    // 2. Queue the Shopify push
    const job = await QueueService.addTask('PUBLISH_TO_SHOPIFY', {
      sourceProductId: sourceProduct.id,
      pricingRuleId,
      collections: collectionIds
    });

    res.json({ success: true, productId: sourceProduct.id, jobId: job.id });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Sync execution
router.post('/products/:id/sync', async (req, res) => {
  const job = await QueueService.addTask('SYNC_PRODUCT', {
    sourceProductId: req.params.id
  });
  res.json({ success: true, jobId: job.id });
});

router.patch('/products/:id', async (req, res) => {
  const { syncStatus } = req.body;
  if (!syncStatus) return res.status(400).json({ error: 'Missing syncStatus' });
  
  const product = await prisma.sourceProduct.update({
    where: { id: req.params.id },
    data: { syncStatus }
  });
  res.json(product);
});

// Manual Review
router.get('/manual-review', async (req, res) => {
  const items = await prisma.manualReviewItem.findMany({
    where: { status: 'pending' },
    include: { sourceProduct: true }
  });
  res.json(items);
});

// Manual Review resolution
router.post('/manual-review/:id/:decision', async (req, res) => {
  const { id, decision } = req.params;
  const status = decision === 'approve' ? 'approved' : 'rejected';
  
  await prisma.manualReviewItem.update({
    where: { id },
    data: { status, resolvedAt: new Date() }
  });

  res.json({ success: true });
});

// Settings - Shopify Connection
router.get('/settings/shopify', async (req, res) => {
  try {
    const connection = await prisma.shopifyConnection.findFirst();
    if (!connection) return res.json(null);
    
    res.json({
      shopDomain: connection.shopDomain,
      clientId: connection.clientId,
      clientSecret: '••••••••••••••••',
      accessToken: connection.accessTokenEnc ? 'Connected' : 'Not Connected',
      scopes: connection.scopes.split(','),
      isConnected: connection.isConnected,
      connectedAt: connection.connectedAt
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

router.post('/settings/shopify', async (req, res) => {
  const { shopDomain, clientId, clientSecret, scopes } = req.body;
  
  if (!shopDomain || !clientId || !clientSecret) {
    return res.status(400).json({ error: 'Missing required configuration fields' });
  }

  try {
    const clientSecretEnc = encrypt(clientSecret);
    const scopesStr = Array.isArray(scopes) ? scopes.join(',') : scopes;

    await prisma.shopifyConnection.upsert({
      where: { shopDomain },
      update: {
        clientId,
        clientSecretEnc,
        scopes: scopesStr,
        updatedAt: new Date()
      },
      create: {
        shopDomain,
        clientId,
        clientSecretEnc,
        scopes: scopesStr
      }
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/settings/shopify/test', async (req, res) => {
  const { shopDomain } = req.body;
  if (!shopDomain) return res.status(400).json({ error: 'Shop domain required' });

  try {
    // Simple reachability test
    await axios.get(`https://${shopDomain}/admin`, { timeout: 5000 });
    res.json({ success: true, message: 'Shopify domain is reachable' });
  } catch (error: any) {
    if (error.response?.status === 302 || error.response?.status === 200 || error.response?.status === 401) {
      // 401 means reachable but unauthorized, which is expected for /admin without token
      return res.json({ success: true, message: 'Shopify domain is reachable' });
    }
    res.status(400).json({ error: 'Could not reach Shopify domain. Please check the URL.' });
  }
});

router.post('/shopify/connect', async (req, res) => {
  try {
    const connection = await prisma.shopifyConnection.findFirst();
    if (!connection) return res.status(400).json({ error: 'Shopify connection not configured' });

    const state = crypto.randomBytes(16).toString('hex');
    const redirectUri = `${process.env.APP_URL}/api/shopify/callback`;
    const installUrl = `https://${connection.shopDomain}/admin/oauth/authorize?client_id=${connection.clientId}&scope=${connection.scopes}&redirect_uri=${redirectUri}&state=${state}`;

    res.json({ url: installUrl });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/shopify/callback', async (req, res) => {
  const { code, shop } = req.query;
  
  if (!code || !shop) return res.status(400).send('Invalid callback');

  try {
    const connection = await prisma.shopifyConnection.findUnique({ where: { shopDomain: shop as string } });
    if (!connection) return res.status(404).send('Connection not found');

    const clientSecret = decrypt(connection.clientSecretEnc);

    const response = await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id: connection.clientId,
      client_secret: clientSecret,
      code
    });

    const { access_token } = response.data;
    await prisma.shopifyConnection.update({
      where: { id: connection.id },
      data: {
        accessTokenEnc: encrypt(access_token),
        isConnected: true,
        connectedAt: new Date()
      }
    });

    res.redirect('/settings?connected=true');
  } catch (error: any) {
    console.error('OAuth Error:', error.response?.data || error.message);
    res.status(500).send('Failed to exchange code for token');
  }
});

router.post('/shopify/disconnect', async (req, res) => {
  try {
    const connection = await prisma.shopifyConnection.findFirst();
    if (!connection) return res.status(404).json({ error: 'Not configured' });

    await prisma.shopifyConnection.update({
      where: { id: connection.id },
      data: {
        accessTokenEnc: null,
        isConnected: false,
        connectedAt: null
      }
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/shopify/collections', async (req, res) => {
  try {
    const client = await ShopifyService.getClientFromDb(prisma);
    const collections = await ShopifyService.getCollections(client);
    res.json(collections);
  } catch (error: any) {
    if (error.message === 'No active Shopify connection found') {
      return res.json([]);
    }

    res.status(500).json({ error: error.message });
  }
});

export default router;
