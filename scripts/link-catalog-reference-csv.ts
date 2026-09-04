import XLSX from "xlsx";
import { prisma } from "../src/server/db.js";
import { ShopifyService } from "../src/server/services/shopify.js";

const CACHE_TABLE = "ShopifyCatalogIndexV2";
const CONFIRMATION = "LINK_REFERENCE_CSV_EXACT";
const csvPath = process.argv.find((arg) => arg.startsWith("--file="))?.slice(7);
const apply = process.argv.includes("--apply");
const confirmed = process.argv.includes(`--confirm=${CONFIRMATION}`);
const reassignInactiveOwners = process.argv.includes("--reassign-inactive-owner");
const linkSharedActiveOwners = process.argv.includes("--link-shared-active-owner");
const crossVendorProductCode = process.argv.includes("--cross-vendor-product-code");
const limit = Math.max(1, Number(process.argv.find((arg) => arg.startsWith("--limit="))?.slice(8) || 10_000));

if (!csvPath) throw new Error("Pass --file=<absolute CSV path>");
if (apply && !confirmed) throw new Error(`Apply requires --confirm=${CONFIRMATION}`);

type ReferenceRow = {
  "Source Link": string;
  "Product Name": string;
  "Source Product Code": string;
  "Sheet SKU(s)": string;
  Supplier: string;
  Collection: string;
  Multiplier: string;
  Workbook: string;
  "Sheet / Tab": string;
  GID: string;
  Row: string;
  "Sheet Link": string;
  "Name Status": string;
  "Name Basis": string;
};

type CacheRow = {
  shopifyId: string;
  title: string;
  vendor: string | null;
  handle: string | null;
  price: number | null;
  primarySku: string | null;
  matchStatus: "needs_link" | "needs_review";
};

const clean = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
const chunks = <T>(values: T[], size = 200) => Array.from(
  { length: Math.ceil(values.length / size) },
  (_, index) => values.slice(index * size, (index + 1) * size),
);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function withDbRetry<T>(operation: () => Promise<T>) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try { return await operation(); }
    catch (error: any) {
      lastError = error;
      if (!/P1017|closed the connection|connection.*closed/i.test(clean(error?.code || error?.message || error)) || attempt === 4) throw error;
      await sleep(attempt * 1_500);
    }
  }
  throw lastError;
}
const normalizedTitle = (value: unknown) => clean(value)
  .toLowerCase()
  .replace(/&(?:amp;)?/g, " and ")
  .replace(/[^a-z0-9]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();
const normalizedSku = (value: unknown) => clean(value).toUpperCase().replace(/\s+/g, "");
const compactIdentity = (value: unknown) => clean(value).toUpperCase().replace(/[^A-Z0-9]+/g, "");
const normalizedVendor = (value: unknown) => compactIdentity(value)
  .replace(/^HAN(D|)M$/, "HM")
  .replace(/^MANDS$/, "MS")
  .replace(/^MAXFASHION$/, "MAX");
const rowSkus = (row: ReferenceRow) => clean(row["Sheet SKU(s)"])
  .split("|")
  .map(normalizedSku)
  .filter(Boolean);

const workbook = XLSX.readFile(csvPath, { raw: false });
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const references = XLSX.utils.sheet_to_json<ReferenceRow>(sheet, { defval: "" });
const referencesByTitle = new Map<string, ReferenceRow[]>();
const referencesBySku = new Map<string, ReferenceRow[]>();
const codeReferences: Array<{ code: string; row: ReferenceRow }> = [];
for (const row of references) {
  if (!clean(row["Source Link"])) continue;
  for (const sku of rowSkus(row)) {
    referencesBySku.set(sku, [...(referencesBySku.get(sku) || []), row]);
  }
  const code = compactIdentity(row["Source Product Code"]);
  if (code.length >= 5) codeReferences.push({ code, row });
  if (clean(row["Name Status"]) !== "Needs lookup") {
    const key = normalizedTitle(row["Product Name"]);
    if (key) referencesByTitle.set(key, [...(referencesByTitle.get(key) || []), row]);
  }
}

const cacheRows = await prisma.$queryRawUnsafe<CacheRow[]>(`
  SELECT "shopifyId", "title", "vendor", "handle", "price", "primarySku", "matchStatus"
  FROM "${CACHE_TABLE}"
  WHERE UPPER(COALESCE("status", '')) = 'ACTIVE'
    AND "matchStatus" IN ('needs_link', 'needs_review')
  ORDER BY "shopifyId" ASC
`);

const candidates = cacheRows.flatMap((row) => {
  const skuMatches = referencesBySku.get(normalizedSku(row.primarySku)) || [];
  const titleMatches = referencesByTitle.get(normalizedTitle(row.title)) || [];
  const compactSku = compactIdentity(row.primarySku);
  const vendor = normalizedVendor(row.vendor);
  const codeMatches = compactSku
    ? codeReferences.filter((entry) => compactSku.includes(entry.code)
      && (crossVendorProductCode || !vendor || !normalizedVendor(entry.row.Supplier) || normalizedVendor(entry.row.Supplier) === vendor))
        .map((entry) => entry.row)
    : [];
  const exactSkuUrls = [...new Set(skuMatches.map((entry) => clean(entry["Source Link"])).filter(Boolean))];
  const exactTitleUrls = [...new Set(titleMatches.map((entry) => clean(entry["Source Link"])).filter(Boolean))];
  const productCodeUrls = [...new Set(codeMatches.map((entry) => clean(entry["Source Link"])).filter(Boolean))];
  const method = exactSkuUrls.length === 1
    ? "exact_sku"
    : exactTitleUrls.length === 1
      ? "exact_title"
      : productCodeUrls.length === 1
        ? "product_code_in_sku"
        : null;
  const matches = method === "exact_sku" ? skuMatches : method === "exact_title" ? titleMatches : codeMatches;
  const url = method === "exact_sku" ? exactSkuUrls[0] : method === "exact_title" ? exactTitleUrls[0] : productCodeUrls[0];
  if (!method || !url) return [];
  return [{ cache: row, reference: matches.find((entry) => clean(entry["Source Link"]) === url)!, url, method }];
});
const existingShopify = [] as Array<{ shopifyId: string }>;
for (const ids of chunks(candidates.map((entry) => entry.cache.shopifyId))) {
  existingShopify.push(...await withDbRetry(() => prisma.shopifyProduct.findMany({
    where: { shopifyId: { in: ids } },
    select: { shopifyId: true },
  })));
}
const existingSources: Array<any> = [];
for (const urls of chunks(candidates.map((entry) => entry.url))) {
  existingSources.push(...await withDbRetry(() => prisma.sourceProduct.findMany({
    where: { url: { in: urls } },
    include: { shopifyProduct: { select: { shopifyId: true, status: true } } },
  })));
}
const activeCatalogRows = await prisma.$queryRawUnsafe<Array<{ shopifyId: string }>>(`
  SELECT "shopifyId" FROM "${CACHE_TABLE}" WHERE UPPER(COALESCE("status", '')) = 'ACTIVE'
`);
const activeCatalogIds = new Set(activeCatalogRows.map((entry) => entry.shopifyId));
const linkedShopifyIds = new Set(existingShopify.map((entry) => entry.shopifyId));
const sourceByUrl = new Map(existingSources.map((entry) => [entry.url, entry]));
const unowned = candidates.filter((entry) => {
  if (linkedShopifyIds.has(entry.cache.shopifyId)) return false;
  const owner = sourceByUrl.get(entry.url)?.shopifyProduct?.shopifyId;
  return !owner || owner === entry.cache.shopifyId;
});
const conflicts = candidates.filter((entry) => {
  const owner = sourceByUrl.get(entry.url)?.shopifyProduct?.shopifyId;
  return Boolean(owner && owner !== entry.cache.shopifyId);
});
const reassignable = conflicts.filter((entry) => !activeCatalogIds.has(sourceByUrl.get(entry.url)?.shopifyProduct?.shopifyId || ""));
const available = reassignInactiveOwners ? [...unowned, ...reassignable] : unowned;
const sharedActiveOwnerCandidates = linkSharedActiveOwners
  ? conflicts.filter((entry) => activeCatalogIds.has(sourceByUrl.get(entry.url)?.shopifyProduct?.shopifyId || ""))
  : [];

const summary = {
  csvRows: references.length,
  cacheRows: cacheRows.length,
  deterministicCandidates: candidates.length,
  available: available.length,
  conflicts: conflicts.length,
  conflictsOwnedByActiveCatalog: conflicts.filter((entry) => activeCatalogIds.has(sourceByUrl.get(entry.url)?.shopifyProduct?.shopifyId || "")).length,
  conflictsOwnedByInactiveOrMissingCatalog: conflicts.filter((entry) => !activeCatalogIds.has(sourceByUrl.get(entry.url)?.shopifyProduct?.shopifyId || "")).length,
  reassignInactiveOwners,
  linkSharedActiveOwners,
  crossVendorProductCode,
  sharedActiveOwnerCandidates: sharedActiveOwnerCandidates.length,
  alreadyLinked: candidates.filter((entry) => linkedShopifyIds.has(entry.cache.shopifyId)).length,
  byStatus: Object.fromEntries(["needs_link", "needs_review"].map((status) => [status, available.filter((entry) => entry.cache.matchStatus === status).length])),
  byMethod: Object.fromEntries(["exact_sku", "exact_title", "product_code_in_sku"].map((method) => [method, available.filter((entry) => entry.method === method).length])),
  apply,
  limit,
};
console.log(JSON.stringify(summary));
if (!apply) {
  await prisma.$disconnect();
  process.exit(0);
}

const client = await ShopifyService.getClientFromDb(prisma);
const results = { linked: 0, sharedLinked: 0, failed: 0, issues: [] as Array<{ shopifyId: string; error: string }> };

function verifyLiveReference(product: any, entry: (typeof candidates)[number]) {
  if (!product || product.status !== "ACTIVE") throw new Error("Shopify product is missing or not active");
  if (entry.method === "exact_title" && normalizedTitle(product.title) !== normalizedTitle(entry.reference["Product Name"])) {
    throw new Error("Live Shopify title no longer exactly matches the CSV reference title");
  }
  if (entry.method === "exact_sku") {
    const liveSkus = new Set(product.variants.map((variant: any) => normalizedSku(variant.sku)).filter(Boolean));
    if (!rowSkus(entry.reference).some((sku) => liveSkus.has(sku))) {
      throw new Error("Live Shopify variants no longer contain the exact CSV SKU");
    }
  }
  if (entry.method === "product_code_in_sku") {
    const code = compactIdentity(entry.reference["Source Product Code"]);
    const liveSkus = product.variants.map((variant: any) => compactIdentity(variant.sku)).filter(Boolean);
    if (!code || !liveSkus.some((sku: string) => sku.includes(code))) {
      throw new Error("Live Shopify variants no longer contain the CSV source product code");
    }
    const liveVendor = normalizedVendor(product.vendor);
    const referenceVendor = normalizedVendor(entry.reference.Supplier);
    if (!crossVendorProductCode && liveVendor && referenceVendor && liveVendor !== referenceVendor) {
      throw new Error("Live Shopify vendor does not match the CSV supplier");
    }
  }
  if (!product.variants.length) throw new Error("Live Shopify product has no variants");
}

for (const entry of available.slice(0, limit)) {
  try {
    const previousOwnerId = sourceByUrl.get(entry.url)?.shopifyProduct?.shopifyId || null;
    const product = await ShopifyService.getProductCatalogSnapshot(client, entry.cache.shopifyId);
    verifyLiveReference(product, entry);
    if (previousOwnerId && previousOwnerId !== product.id) {
      const previousOwner = await ShopifyService.getProductCatalogSnapshot(client, previousOwnerId);
      if (previousOwner?.status === "ACTIVE") {
        throw new Error("CSV source URL is still owned by another active Shopify product");
      }
    }
    const multiplier = Number(entry.reference.Multiplier || 23) || 23;
    const firstPrice = Number(product.variants[0]?.price || entry.cache.price || 0);
    await prisma.$transaction(async (tx) => {
      const concurrentShopify = await tx.shopifyProduct.findUnique({ where: { shopifyId: product.id } });
      if (concurrentShopify) return;
      const currentSource = await tx.sourceProduct.findUnique({
        where: { url: entry.url },
        include: { shopifyProduct: true, variants: { include: { shopifyVariant: true } } },
      });
      if (currentSource?.shopifyProduct && currentSource.shopifyProduct.shopifyId !== product.id) {
        if (!reassignInactiveOwners || currentSource.shopifyProduct.shopifyId !== previousOwnerId) {
          throw new Error("CSV source URL became owned by another Shopify product");
        }
        await tx.shopifyVariant.deleteMany({ where: { shopifyProductId: currentSource.shopifyProduct.id } });
        await tx.shopifyProduct.delete({ where: { id: currentSource.shopifyProduct.id } });
      }
      const supplierName = clean(entry.reference.Supplier) || clean(product.vendor) || "CSV Reference";
      const supplier = await tx.supplier.upsert({
        where: { name: supplierName },
        update: {},
        create: { name: supplierName, baseUrl: new URL(entry.url).origin },
      });
      const raw = JSON.stringify({
        import: {
          csvReference: true,
          sourceProductCode: clean(entry.reference["Source Product Code"]) || null,
          spreadsheetName: clean(entry.reference.Workbook) || null,
          sheetName: clean(entry.reference["Sheet / Tab"]) || null,
          sheetId: clean(entry.reference.GID) || null,
          excelRowNumber: Number(entry.reference.Row || 0) || null,
          sheetUrl: clean(entry.reference["Sheet Link"]) || null,
          sheetSku: clean(entry.reference["Sheet SKU(s)"]) || null,
          sheetPriceMultiplier: multiplier,
          exactTitleReference: true,
          nameStatus: clean(entry.reference["Name Status"]),
          nameBasis: clean(entry.reference["Name Basis"]),
          linkedAt: new Date().toISOString(),
        },
      });
      const source = currentSource
        ? await tx.sourceProduct.update({ where: { id: currentSource.id }, data: { syncStatus: "active", raw } })
        : await tx.sourceProduct.create({
            data: {
              supplierId: supplier.id,
              url: entry.url,
              productId: clean(entry.reference["Source Product Code"]) || null,
              title: product.title,
              description: product.descriptionHtml || null,
              brand: product.vendor || supplierName,
              currency: "AED",
              price: firstPrice > 0 ? Number((firstPrice / multiplier).toFixed(4)) : 0,
              syncStatus: "active",
              lastScrapedAt: new Date(0),
              raw,
            },
          });
      if (!currentSource) {
        const images = product.media
          .filter((media: any) => media.mediaContentType === "IMAGE" && media.image?.url)
          .map((media: any, index: number) => ({ sourceProductId: source.id, url: media.image.url, alt: media.alt || product.title, position: index }));
        if (images.length) await tx.sourceImage.createMany({ data: images });
      }
      const shopifyProduct = await tx.shopifyProduct.create({
        data: {
          sourceProductId: source.id,
          shopifyId: product.id,
          handle: product.handle || entry.cache.handle,
          status: "active",
          collectionIds: clean(entry.reference.Collection) || null,
          price: firstPrice || null,
          syncEnabled: true,
          syncPrice: true,
          syncInventory: true,
          syncImages: false,
        },
      });
      const existingVariants = currentSource?.variants || [];
      for (const [index, variant] of product.variants.entries()) {
        const sku = clean(variant.sku);
        const exact = sku ? existingVariants.filter((item) => clean(item.sku).toUpperCase() === sku.toUpperCase() && !item.shopifyVariant) : [];
        const sourceVariant = exact.length === 1 ? exact[0] : await tx.sourceVariant.create({
          data: {
            sourceProductId: source.id,
            sourceVariantId: `csv-reference-${clean(variant.id).split("/").pop() || index + 1}`,
            sku: sku || null,
            size: clean(variant.title) || null,
            price: Number(variant.price || 0) / multiplier || null,
            currency: "AED",
            available: Number(variant.inventoryQuantity || 0) > 0,
            stockStatus: Number(variant.inventoryQuantity || 0) > 0 ? "in_stock" : "out_of_stock",
          },
        });
        await tx.shopifyVariant.create({
          data: { shopifyProductId: shopifyProduct.id, sourceVariantId: sourceVariant.id, shopifyId: variant.id, sku: sku || null, price: Number(variant.price || 0) || null },
        });
      }
      await tx.manualReviewItem.deleteMany({ where: { sourceProductId: source.id, status: "pending" } });
      await tx.auditLog.create({
        data: { sourceProductId: source.id, action: "LINK_EXISTING_SHOPIFY_CATALOG_REFERENCE_CSV", details: JSON.stringify({ shopifyId: product.id, sourceUrl: entry.url, title: product.title, multiplier, method: entry.method, previousOwnerId }) },
      });
      await tx.$executeRawUnsafe(`
        UPDATE "${CACHE_TABLE}"
        SET "matchStatus"='active', "matchMethod"=$3,
            "matchedSourceUrl"=$2, "reason"=NULL,
            "evidence"=$4, "updatedAt"=NOW()
        WHERE "shopifyId"=$1
      `, product.id, entry.url, `csv_reference_${entry.method}`, JSON.stringify(["csv_unique_source_url", `live_shopify_${entry.method}`]));
    }, { maxWait: 15_000, timeout: 45_000 });
    results.linked += 1;
  } catch (error: any) {
    results.failed += 1;
    results.issues.push({ shopifyId: entry.cache.shopifyId, error: clean(error?.message || error).slice(0, 500) });
  }
}

for (const entry of sharedActiveOwnerCandidates.slice(0, Math.max(0, limit - results.linked))) {
  try {
    const source = sourceByUrl.get(entry.url);
    const ownerId = source?.shopifyProduct?.shopifyId || "";
    if (!source || !ownerId || !activeCatalogIds.has(ownerId)) {
      throw new Error("Shared source owner is no longer an active Shopify catalog product");
    }
    const product = await ShopifyService.getProductCatalogSnapshot(client, entry.cache.shopifyId);
    verifyLiveReference(product, entry);
    await prisma.$transaction(async (tx) => {
      const changed = await tx.$executeRawUnsafe(`
        UPDATE "${CACHE_TABLE}"
        SET "matchStatus"='linked', "matchMethod"=$3,
            "matchedSourceUrl"=$2,
            "reason"='Verified shared source URL; variant-group materialization pending',
            "evidence"=$4, "updatedAt"=NOW()
        WHERE "shopifyId"=$1 AND "matchStatus" IN ('needs_link', 'needs_review')
      `, product.id, entry.url, `csv_reference_shared_${entry.method}`, JSON.stringify(["csv_unique_source_url", `live_shopify_${entry.method}`, "active_source_owner"]));
      if (!changed) return;
      await tx.auditLog.create({
        data: {
          sourceProductId: source.id,
          action: "LINK_EXISTING_SHOPIFY_CATALOG_SHARED_REFERENCE",
          details: JSON.stringify({ shopifyId: product.id, sourceUrl: entry.url, ownerShopifyId: ownerId, method: entry.method, liveReadbackVerified: true }),
        },
      });
      results.sharedLinked += 1;
    }, { maxWait: 15_000, timeout: 45_000 });
  } catch (error: any) {
    results.failed += 1;
    results.issues.push({ shopifyId: entry.cache.shopifyId, error: clean(error?.message || error).slice(0, 500) });
  }
}

console.log(JSON.stringify(results));
await prisma.$disconnect();
