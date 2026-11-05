import crypto from "crypto";
import { Router } from "express";
import { prisma } from "../db.js";
import { ShopifyService } from "../services/shopify.js";

const router = Router();

const REQUIRED_SHOP_DOMAIN = "09fgkz-6n.myshopify.com";
const CONFIRMATION = "DELETE_ALL_PRODUCTS_AND_COLLECTIONS_FROM_09FGKZ_6N";
const JOB_TYPE = "SHOPIFY_FULL_STORE_PURGE";
const PRODUCT_BATCH_SIZE = 10;
const COLLECTION_BATCH_SIZE = 10;

type ProductSnapshot = {
  id: string;
  title: string;
  createdAt: string;
};

type CollectionSnapshot = {
  id: string;
  title: string;
  handle: string;
  updatedAt: string;
};

type DeleteResult = {
  deleted: string[];
  failed: Array<{ id: string; error: string }>;
};

let runningPurge: Promise<void> | null = null;

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunks<T>(values: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function parseJsonObject(value: string | null | undefined) {
  if (!value) return {} as Record<string, any>;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {} as Record<string, any>;
  }
}

async function getShopIdentity(client: any) {
  const data = await client.request(`
    query FullStorePurgeIdentity {
      shop {
        id
        name
        myshopifyDomain
      }
    }
  `);
  const shop = data?.shop;
  const domain = clean(shop?.myshopifyDomain).toLowerCase();
  if (domain !== REQUIRED_SHOP_DOMAIN) {
    throw Object.assign(
      new Error(`Refusing purge: connected Shopify store is ${domain || "unknown"}, expected ${REQUIRED_SHOP_DOMAIN}`),
      { statusCode: 409 },
    );
  }
  return {
    id: clean(shop?.id),
    name: clean(shop?.name),
    myshopifyDomain: domain,
  };
}

async function loadAllProducts(client: any) {
  const products: ProductSnapshot[] = [];
  let after: string | null = null;

  do {
    const data: any = await client.request(`
      query FullStorePurgeProducts($after: String) {
        products(first: 250, after: $after) {
          nodes {
            id
            title
            createdAt
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `, { after });
    const connection = data?.products;
    for (const node of connection?.nodes || []) {
      const id = clean(node?.id);
      if (!id) continue;
      products.push({
        id,
        title: clean(node?.title),
        createdAt: clean(node?.createdAt),
      });
    }
    if (!connection?.pageInfo?.hasNextPage) break;
    after = clean(connection.pageInfo.endCursor) || null;
    if (!after) throw new Error("Shopify product pagination did not return an end cursor");
  } while (after);

  return products.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function loadAllCollections(client: any) {
  const collections: CollectionSnapshot[] = [];
  let after: string | null = null;

  do {
    const data: any = await client.request(`
      query FullStorePurgeCollections($after: String) {
        collections(first: 250, after: $after) {
          nodes {
            id
            title
            handle
            updatedAt
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `, { after });
    const connection = data?.collections;
    for (const node of connection?.nodes || []) {
      const id = clean(node?.id);
      if (!id) continue;
      collections.push({
        id,
        title: clean(node?.title),
        handle: clean(node?.handle),
        updatedAt: clean(node?.updatedAt),
      });
    }
    if (!connection?.pageInfo?.hasNextPage) break;
    after = clean(connection.pageInfo.endCursor) || null;
    if (!after) throw new Error("Shopify collection pagination did not return an end cursor");
  } while (after);

  return collections.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function buildPlanHash(products: ProductSnapshot[], collections: CollectionSnapshot[]) {
  return crypto
    .createHash("sha256")
    .update([
      ...products.map((product) => `product:${product.id}`),
      ...collections.map((collection) => `collection:${collection.id}`),
    ].sort().join("\n"))
    .digest("hex");
}

async function buildPlan(client: any) {
  const shop = await getShopIdentity(client);
  const [products, collections] = await Promise.all([
    loadAllProducts(client),
    loadAllCollections(client),
  ]);
  return {
    shop,
    products,
    collections,
    planHash: buildPlanHash(products, collections),
  };
}

async function requestWithRetry<T>(operation: () => Promise<T>) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      const message = clean(error?.message || error);
      const retryable = /thrott|429|rate limit|temporar|timeout|5\d\d|service unavailable|socket|econnreset/i.test(message);
      if (!retryable || attempt === 7) break;
      await sleep(750 * (attempt + 1));
    }
  }
  throw lastError;
}

async function deleteProductBatch(client: any, ids: string[]): Promise<DeleteResult> {
  const definitions: string[] = [];
  const fields: string[] = [];
  const variables: Record<string, string> = {};
  ids.forEach((id, index) => {
    definitions.push(`$id${index}: ID!`);
    fields.push(`p${index}: productDelete(input: { id: $id${index} }, synchronous: true) { deletedProductId userErrors { field message } }`);
    variables[`id${index}`] = id;
  });
  const mutation = `mutation FullStorePurgeProducts(${definitions.join(", ")}) { ${fields.join("\n")} }`;
  const data: any = await requestWithRetry(() => client.request(mutation, variables));

  const deleted: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  ids.forEach((id, index) => {
    const payload = data?.[`p${index}`];
    const errors = Array.isArray(payload?.userErrors) ? payload.userErrors : [];
    const message = errors.map((entry: any) => clean(entry?.message)).filter(Boolean).join("; ");
    if (clean(payload?.deletedProductId) === id) deleted.push(id);
    else failed.push({ id, error: message || "Shopify did not confirm product deletion" });
  });
  return { deleted, failed };
}

async function deleteCollectionBatch(client: any, ids: string[]): Promise<DeleteResult> {
  const definitions: string[] = [];
  const fields: string[] = [];
  const variables: Record<string, string> = {};
  ids.forEach((id, index) => {
    definitions.push(`$id${index}: ID!`);
    fields.push(`c${index}: collectionDelete(input: { id: $id${index} }) { deletedCollectionId userErrors { field message } }`);
    variables[`id${index}`] = id;
  });
  const mutation = `mutation FullStorePurgeCollections(${definitions.join(", ")}) { ${fields.join("\n")} }`;
  const data: any = await requestWithRetry(() => client.request(mutation, variables));

  const deleted: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  ids.forEach((id, index) => {
    const payload = data?.[`c${index}`];
    const errors = Array.isArray(payload?.userErrors) ? payload.userErrors : [];
    const message = errors.map((entry: any) => clean(entry?.message)).filter(Boolean).join("; ");
    if (clean(payload?.deletedCollectionId) === id) deleted.push(id);
    else failed.push({ id, error: message || "Shopify did not confirm collection deletion" });
  });
  return { deleted, failed };
}

async function disableLocalProductLinks(shopifyIds: string[]) {
  if (!shopifyIds.length) return { linksRemoved: 0, sourcesPaused: 0 };
  const linked = await prisma.shopifyProduct.findMany({
    where: { shopifyId: { in: shopifyIds } },
    select: { id: true, sourceProductId: true },
  });
  const localIds = linked.map((entry) => entry.id);
  const sourceIds = [...new Set(linked.map((entry) => entry.sourceProductId))];

  if (localIds.length > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.shopifyVariant.deleteMany({ where: { shopifyProductId: { in: localIds } } });
      await tx.shopifyProduct.deleteMany({ where: { id: { in: localIds } } });
      if (sourceIds.length > 0) {
        await tx.sourceProduct.updateMany({
          where: { id: { in: sourceIds } },
          data: { syncStatus: "paused" },
        });
      }
    });
  }

  try {
    await prisma.$executeRawUnsafe(`
      UPDATE "ShopifyCatalogIndexV2"
      SET "status" = 'DELETED',
          "matchStatus" = 'deleted',
          "reason" = 'full_store_purge',
          "updatedAt" = NOW()
      WHERE "shopifyId" = ANY($1::text[])
    `, shopifyIds);
  } catch (error: any) {
    console.warn("[full-store-purge] catalog index cleanup skipped:", clean(error?.message || error));
  }

  return { linksRemoved: localIds.length, sourcesPaused: sourceIds.length };
}

async function clearRemainingLocalLinks() {
  const linked = await prisma.shopifyProduct.findMany({
    select: { id: true, sourceProductId: true },
  });
  const sourceIds = [...new Set(linked.map((entry) => entry.sourceProductId))];
  await prisma.$transaction(async (tx) => {
    await tx.shopifyVariant.deleteMany({});
    await tx.shopifyProduct.deleteMany({});
    if (sourceIds.length > 0) {
      await tx.sourceProduct.updateMany({
        where: { id: { in: sourceIds } },
        data: { syncStatus: "paused" },
      });
    }
  });
  try {
    await prisma.$executeRawUnsafe(`
      UPDATE "ShopifyCatalogIndexV2"
      SET "status" = 'DELETED',
          "matchStatus" = 'deleted',
          "reason" = 'full_store_purge',
          "updatedAt" = NOW()
      WHERE COALESCE("status", '') <> 'DELETED'
         OR COALESCE("matchStatus", '') <> 'deleted'
    `);
  } catch (error: any) {
    console.warn("[full-store-purge] final catalog index cleanup skipped:", clean(error?.message || error));
  }
  return { linksRemoved: linked.length, sourcesPaused: sourceIds.length };
}

async function updateJob(jobId: string, progress: Record<string, any>) {
  await prisma.syncJob.update({
    where: { id: jobId },
    data: { result: JSON.stringify(progress) },
  });
}

async function runPurge(jobId: string, initialPlan: Awaited<ReturnType<typeof buildPlan>>) {
  const client = await ShopifyService.getClientFromDb(prisma);
  await getShopIdentity(client);
  const progress: Record<string, any> = {
    shopDomain: REQUIRED_SHOP_DOMAIN,
    stage: "deleting_products",
    startedAt: new Date().toISOString(),
    initialProductCount: initialPlan.products.length,
    initialCollectionCount: initialPlan.collections.length,
    productsDeleted: 0,
    collectionsDeleted: 0,
    linksRemoved: 0,
    sourcesPaused: 0,
    productFailures: [],
    collectionFailures: [],
  };

  try {
    for (let pass = 1; pass <= 5; pass += 1) {
      const products = await loadAllProducts(client);
      progress.productPass = pass;
      progress.productsRemaining = products.length;
      await updateJob(jobId, progress);
      if (products.length === 0) break;

      for (const batch of chunks(products.map((product) => product.id), PRODUCT_BATCH_SIZE)) {
        const result = await deleteProductBatch(client, batch);
        const local = await disableLocalProductLinks(result.deleted);
        progress.productsDeleted += result.deleted.length;
        progress.linksRemoved += local.linksRemoved;
        progress.sourcesPaused += local.sourcesPaused;
        progress.productsRemaining = Math.max(0, Number(progress.productsRemaining) - result.deleted.length);
        if (result.failed.length > 0) {
          progress.productFailures = [...progress.productFailures, ...result.failed].slice(-100);
        }
        progress.updatedAt = new Date().toISOString();
        await updateJob(jobId, progress);
        await sleep(200);
      }
    }

    const remainingProducts = await loadAllProducts(client);
    if (remainingProducts.length > 0) {
      throw new Error(`Shopify read-back still found ${remainingProducts.length} products after five deletion passes`);
    }

    progress.stage = "deleting_collections";
    progress.productsRemaining = 0;
    await updateJob(jobId, progress);

    for (let pass = 1; pass <= 5; pass += 1) {
      const collections = await loadAllCollections(client);
      progress.collectionPass = pass;
      progress.collectionsRemaining = collections.length;
      await updateJob(jobId, progress);
      if (collections.length === 0) break;

      for (const batch of chunks(collections.map((collection) => collection.id), COLLECTION_BATCH_SIZE)) {
        const result = await deleteCollectionBatch(client, batch);
        progress.collectionsDeleted += result.deleted.length;
        progress.collectionsRemaining = Math.max(0, Number(progress.collectionsRemaining) - result.deleted.length);
        if (result.failed.length > 0) {
          progress.collectionFailures = [...progress.collectionFailures, ...result.failed].slice(-100);
        }
        progress.updatedAt = new Date().toISOString();
        await updateJob(jobId, progress);
        await sleep(150);
      }
    }

    const [finalProducts, finalCollections] = await Promise.all([
      loadAllProducts(client),
      loadAllCollections(client),
    ]);
    if (finalProducts.length > 0 || finalCollections.length > 0) {
      throw new Error(`Final Shopify read-back found ${finalProducts.length} products and ${finalCollections.length} collections`);
    }

    const finalLocal = await clearRemainingLocalLinks();
    progress.linksRemoved += finalLocal.linksRemoved;
    progress.sourcesPaused += finalLocal.sourcesPaused;
    progress.stage = "completed";
    progress.productsRemaining = 0;
    progress.collectionsRemaining = 0;
    progress.finalProductCount = 0;
    progress.finalCollectionCount = 0;
    progress.completedAt = new Date().toISOString();

    await prisma.$transaction([
      prisma.syncJob.update({
        where: { id: jobId },
        data: {
          status: "completed",
          result: JSON.stringify(progress),
          completedAt: new Date(),
        },
      }),
      prisma.auditLog.create({
        data: {
          action: "SHOPIFY_FULL_STORE_PURGE_COMPLETED",
          userId: "System",
          details: JSON.stringify(progress),
        },
      }),
    ]);
  } catch (error: any) {
    progress.stage = "failed";
    progress.error = clean(error?.message || error || "Unknown full-store purge error");
    progress.failedAt = new Date().toISOString();
    await prisma.syncJob.update({
      where: { id: jobId },
      data: {
        status: "failed",
        result: JSON.stringify(progress),
        completedAt: new Date(),
      },
    });
    throw error;
  }
}

router.post("/shopify/store-purge/full/preflight", async (req, res) => {
  try {
    const expectedShopDomain = clean(req.body?.expectedShopDomain).toLowerCase();
    if (expectedShopDomain !== REQUIRED_SHOP_DOMAIN) {
      return res.status(400).json({
        success: false,
        error: `expectedShopDomain must equal ${REQUIRED_SHOP_DOMAIN}`,
      });
    }
    const client = await ShopifyService.getClientFromDb(prisma);
    const plan = await buildPlan(client);
    return res.json({
      success: true,
      dryRun: true,
      confirmationRequired: CONFIRMATION,
      shop: plan.shop,
      productCount: plan.products.length,
      collectionCount: plan.collections.length,
      planHash: plan.planHash,
      newestProducts: plan.products.slice(0, 10),
      newestCollections: plan.collections.slice(0, 10),
    });
  } catch (error: any) {
    return res.status(Number(error?.statusCode) || 500).json({
      success: false,
      error: clean(error?.message || error || "Full-store purge preflight failed"),
    });
  }
});

router.post("/shopify/store-purge/full/start", async (req, res) => {
  try {
    if (process.env.SHOPIFY_FULL_STORE_PURGE_ENABLED !== "true") {
      return res.status(403).json({
        success: false,
        error: "Full-store purge is disabled by configuration",
      });
    }
    if (clean(req.body?.expectedShopDomain).toLowerCase() !== REQUIRED_SHOP_DOMAIN) {
      return res.status(400).json({ success: false, error: "Shop domain confirmation does not match" });
    }
    if (clean(req.body?.confirm) !== CONFIRMATION) {
      return res.status(400).json({ success: false, error: `confirm must equal ${CONFIRMATION}` });
    }
    if (runningPurge) {
      return res.status(409).json({ success: false, error: "A full-store purge is already running" });
    }

    const client = await ShopifyService.getClientFromDb(prisma);
    const plan = await buildPlan(client);
    if (clean(req.body?.expectedPlanHash) !== plan.planHash) {
      return res.status(409).json({ success: false, error: "Deletion plan changed; run preflight again" });
    }
    if (Number(req.body?.expectedProductCount) !== plan.products.length) {
      return res.status(409).json({ success: false, error: "Product count changed; run preflight again" });
    }
    if (Number(req.body?.expectedCollectionCount) !== plan.collections.length) {
      return res.status(409).json({ success: false, error: "Collection count changed; run preflight again" });
    }

    const staleJobs = await prisma.syncJob.findMany({
      where: { type: JOB_TYPE, status: { in: ["running", "pending"] } },
      select: { id: true, result: true },
    });
    for (const stale of staleJobs) {
      const previous = parseJsonObject(stale.result);
      await prisma.syncJob.update({
        where: { id: stale.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          result: JSON.stringify({ ...previous, stage: "superseded", supersededAt: new Date().toISOString() }),
        },
      });
    }

    const job = await prisma.syncJob.create({
      data: {
        type: JOB_TYPE,
        status: "running",
        startedAt: new Date(),
        payload: JSON.stringify({
          shopDomain: REQUIRED_SHOP_DOMAIN,
          planHash: plan.planHash,
          productCount: plan.products.length,
          collectionCount: plan.collections.length,
        }),
        result: JSON.stringify({
          stage: "queued",
          productCount: plan.products.length,
          collectionCount: plan.collections.length,
        }),
      },
    });

    runningPurge = runPurge(job.id, plan)
      .catch((error) => {
        console.error("[full-store-purge] failed:", clean(error?.message || error));
      })
      .finally(() => {
        runningPurge = null;
      });

    return res.status(202).json({
      success: true,
      accepted: true,
      jobId: job.id,
      shopDomain: REQUIRED_SHOP_DOMAIN,
      productCount: plan.products.length,
      collectionCount: plan.collections.length,
    });
  } catch (error: any) {
    return res.status(Number(error?.statusCode) || 500).json({
      success: false,
      error: clean(error?.message || error || "Failed to start full-store purge"),
    });
  }
});

router.get("/shopify/store-purge/full/status", async (_req, res) => {
  const job = await prisma.syncJob.findFirst({
    where: { type: JOB_TYPE },
    orderBy: { createdAt: "desc" },
  });
  return res.json({
    success: true,
    runningInThisProcess: Boolean(runningPurge),
    job: job ? {
      id: job.id,
      status: job.status,
      payload: parseJsonObject(job.payload),
      result: parseJsonObject(job.result),
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      createdAt: job.createdAt,
    } : null,
  });
});

export default router;
