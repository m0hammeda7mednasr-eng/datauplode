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
const DEFAULT_SHOPIFY_SCOPES = [
  'read_products',
  'write_products',
  'read_inventory',
  'write_inventory',
  'read_files',
  'write_files',
];
const SHOPIFY_DOMAIN_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

function firstQueryValue(value: any): string {
  return String(Array.isArray(value) ? value[0] : value || '').trim();
}

function normalizePublicUrl(value?: string | null) {
  if (!value) return '';
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function getBackendUrl(req: any) {
  const configured = normalizePublicUrl(process.env.APP_URL);
  if (configured) return configured;

  const forwardedProto = firstQueryValue(req.get('x-forwarded-proto')).split(',')[0];
  const forwardedHost = firstQueryValue(req.get('x-forwarded-host')).split(',')[0];
  const protocol = forwardedProto || req.protocol || 'http';
  const host = forwardedHost || req.get('host');

  return `${protocol}://${host}`;
}

function getFrontendUrl(req?: any) {
  return normalizePublicUrl(
    process.env.FRONTEND_URL ||
    process.env.VITE_FRONTEND_URL ||
    (req ? getBackendUrl(req) : '') ||
    'https://datauplode.vercel.app'
  );
}

function getShopifyRedirectUri(req: any) {
  return `${getBackendUrl(req)}/api/shopify/callback`;
}

function redirectToFrontend(req: any, res: any, params: Record<string, string>) {
  const redirectUrl = new URL('/settings', getFrontendUrl(req));
  for (const [key, value] of Object.entries(params)) {
    redirectUrl.searchParams.set(key, value);
  }
  res.redirect(redirectUrl.toString());
}

function normalizeShopDomain(value: any) {
  let domain = String(value || '').trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, '');
  domain = domain.replace(/\/admin.*$/, '');
  domain = domain.replace(/\/.*$/, '');
  return domain;
}

function assertShopDomain(value: any) {
  const domain = normalizeShopDomain(value);
  if (!SHOPIFY_DOMAIN_REGEX.test(domain)) {
    throw Object.assign(new Error('Shop domain must be a valid .myshopify.com hostname'), {
      statusCode: 400,
    });
  }
  return domain;
}

function normalizeScopes(scopes: any) {
  const scopeList = Array.isArray(scopes)
    ? scopes
    : String(scopes || '').split(',');

  const cleanedScopes = scopeList
    .map((scope: string) => String(scope).trim())
    .filter(Boolean);

  return cleanedScopes.length ? cleanedScopes : DEFAULT_SHOPIFY_SCOPES;
}

function verifyShopifyHmac(query: any, clientSecret: string) {
  const hmac = firstQueryValue(query.hmac);
  if (!hmac) return false;

  const message = Object.keys(query)
    .filter((key) => key !== 'hmac' && key !== 'signature')
    .sort()
    .map((key) => {
      const value = Array.isArray(query[key]) ? query[key].join(',') : query[key];
      return `${key}=${value}`;
    })
    .join('&');

  const digest = crypto
    .createHmac('sha256', clientSecret)
    .update(message)
    .digest('hex');

  const hmacBuffer = Buffer.from(hmac, 'hex');
  const digestBuffer = Buffer.from(digest, 'hex');

  return hmacBuffer.length === digestBuffer.length && crypto.timingSafeEqual(hmacBuffer, digestBuffer);
}

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

router.delete('/pricing-rules/:id', async (req, res) => {
  try {
    await prisma.pricingRule.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(404).json({ error: error.message || 'Pricing rule not found' });
  }
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
    if (!connection) {
      return res.json({
        shopDomain: '',
        clientId: '',
        clientSecret: '',
        hasClientSecret: false,
        accessToken: 'Not Connected',
        scopes: DEFAULT_SHOPIFY_SCOPES,
        isConnected: false,
        connectedAt: null,
        callbackUrl: getShopifyRedirectUri(req),
        apiVersion: process.env.SHOPIFY_API_VERSION || '2026-04',
      });
    }
    
    res.json({
      shopDomain: connection.shopDomain,
      clientId: connection.clientId,
      clientSecret: '****************',
      hasClientSecret: Boolean(connection.clientSecretEnc),
      accessToken: connection.accessTokenEnc ? 'Connected' : 'Not Connected',
      scopes: connection.scopes.split(','),
      isConnected: connection.isConnected,
      connectedAt: connection.connectedAt,
      callbackUrl: getShopifyRedirectUri(req),
      apiVersion: process.env.SHOPIFY_API_VERSION || '2026-04',
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

router.post('/settings/shopify', async (req, res) => {
  const { shopDomain, clientId, clientSecret, scopes } = req.body;
  
  if (!shopDomain || !clientId) {
    return res.status(400).json({ error: 'Missing required configuration fields' });
  }

  try {
    const normalizedShopDomain = assertShopDomain(shopDomain);
    const cleanClientId = String(clientId).trim();
    const cleanClientSecret = String(clientSecret || '').trim();
    const scopesStr = normalizeScopes(scopes).join(',');
    const existing = await prisma.shopifyConnection.findUnique({
      where: { shopDomain: normalizedShopDomain },
    });

    if (!existing && !cleanClientSecret) {
      return res.status(400).json({ error: 'Client secret is required for a new Shopify connection' });
    }

    const credentialsChanged = Boolean(
      existing &&
      (existing.clientId !== cleanClientId || existing.scopes !== scopesStr || cleanClientSecret)
    );
    const encryptedSecret = cleanClientSecret ? encrypt(cleanClientSecret) : existing?.clientSecretEnc;

    await prisma.shopifyConnection.upsert({
      where: { shopDomain: normalizedShopDomain },
      update: {
        clientId: cleanClientId,
        clientSecretEnc: encryptedSecret!,
        scopes: scopesStr,
        ...(credentialsChanged
          ? {
              accessTokenEnc: null,
              isConnected: false,
              connectedAt: null,
              oauthState: null,
              oauthStateExpiresAt: null,
            }
          : {}),
        updatedAt: new Date()
      },
      create: {
        shopDomain: normalizedShopDomain,
        clientId: cleanClientId,
        clientSecretEnc: encryptedSecret!,
        scopes: scopesStr
      }
    });

    res.json({ success: true, callbackUrl: getShopifyRedirectUri(req) });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.post('/settings/shopify/test', async (req, res) => {
  const { shopDomain } = req.body;
  if (!shopDomain) return res.status(400).json({ error: 'Shop domain required' });

  try {
    const normalizedShopDomain = assertShopDomain(shopDomain);
    // Simple reachability test
    await axios.get(`https://${normalizedShopDomain}/admin`, {
      timeout: 5000,
      maxRedirects: 0,
      validateStatus: (status) => status < 500,
    });
    res.json({ success: true, message: 'Shopify domain is reachable' });
  } catch (error: any) {
    if (error.response?.status === 302 || error.response?.status === 200 || error.response?.status === 401) {
      // 401 means reachable but unauthorized, which is expected for /admin without token
      return res.json({ success: true, message: 'Shopify domain is reachable' });
    }
    res.status(error.statusCode || 400).json({ error: error.message || 'Could not reach Shopify domain. Please check the URL.' });
  }
});

router.post('/shopify/connect', async (req, res) => {
  try {
    const connection = await prisma.shopifyConnection.findFirst();
    if (!connection) return res.status(400).json({ error: 'Shopify connection not configured' });
    if (!connection.clientSecretEnc) return res.status(400).json({ error: 'Shopify client secret is missing' });

    const state = crypto.randomBytes(16).toString('hex');
    const redirectUri = getShopifyRedirectUri(req);
    const oauthUrl = new URL(`https://${connection.shopDomain}/admin/oauth/authorize`);
    oauthUrl.searchParams.set('client_id', connection.clientId);
    oauthUrl.searchParams.set('scope', connection.scopes);
    oauthUrl.searchParams.set('redirect_uri', redirectUri);
    oauthUrl.searchParams.set('state', state);

    await prisma.shopifyConnection.update({
      where: { id: connection.id },
      data: {
        oauthState: state,
        oauthStateExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    res.json({ url: oauthUrl.toString(), redirectUri });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/shopify/callback', async (req, res) => {
  const code = firstQueryValue(req.query.code);
  const state = firstQueryValue(req.query.state);
  const shop = normalizeShopDomain(req.query.shop);
  
  if (!code || !shop || !state) return res.status(400).send('Invalid callback');

  try {
    const shopDomain = assertShopDomain(shop);
    const connection = await prisma.shopifyConnection.findUnique({ where: { shopDomain } });
    if (!connection) return res.status(404).send('Connection not found');

    const clientSecret = decrypt(connection.clientSecretEnc);
    const stateExpired = !connection.oauthStateExpiresAt || connection.oauthStateExpiresAt < new Date();
    if (!connection.oauthState || connection.oauthState !== state || stateExpired) {
      return res.status(400).send('Invalid or expired OAuth state');
    }

    if (!verifyShopifyHmac(req.query, clientSecret)) {
      return res.status(400).send('Invalid Shopify callback signature');
    }

    const response = await axios.post(
      `https://${shopDomain}/admin/oauth/access_token`,
      new URLSearchParams({
        client_id: connection.clientId,
        client_secret: clientSecret,
        code,
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
      }
    );

    const { access_token, scope } = response.data;
    if (!access_token) throw new Error('Shopify did not return an access token');

    await prisma.shopifyConnection.update({
      where: { id: connection.id },
      data: {
        accessTokenEnc: encrypt(access_token),
        scopes: scope || connection.scopes,
        isConnected: true,
        connectedAt: new Date(),
        oauthState: null,
        oauthStateExpiresAt: null,
      }
    });

    redirectToFrontend(req, res, { connected: 'true', shop: shopDomain });
  } catch (error: any) {
    console.error('OAuth Error:', error.response?.data || error.message);
    redirectToFrontend(req, res, { connected: 'false', error: 'shopify_oauth_failed' });
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
        connectedAt: null,
        oauthState: null,
        oauthStateExpiresAt: null,
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
