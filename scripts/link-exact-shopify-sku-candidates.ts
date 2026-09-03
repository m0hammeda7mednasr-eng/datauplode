import { readFile, writeFile } from "node:fs/promises";
import { prisma } from "../src/server/db.js";
import { ShopifyService } from "../src/server/services/shopify.js";

type Candidate = {
  sku: string;
  row: {
    rowNumber: number;
    url: string;
    priceMultiplier: number;
    collection: string;
    sheetName: string;
    gid: number;
    sheetUrl: string;
  };
  shopify: { productId: string; status: string };
};

const confirmation = "link-exact-shopify-sku-v1";
const execute = process.env.LINK_EXACT_SKU_CONFIRMATION === confirmation;
const inputPath = process.env.LINK_EXACT_SKU_INPUT || "C:/tmp/sheet-shopify-link-candidates.json";
const outputPath = process.env.LINK_EXACT_SKU_REPORT || `C:/tmp/link-exact-sku-${Date.now()}.json`;
const limit = boundedInteger(process.env.LINK_EXACT_SKU_LIMIT || "500", 1, 500);
const input = JSON.parse(await readFile(inputPath, "utf8")) as { candidates: Candidate[] };
const candidates = input.candidates
  .filter((candidate) => clean(candidate.shopify.status).toUpperCase() === "ACTIVE")
  .slice(0, limit);

if (!execute) {
  console.log(JSON.stringify({
    dryRun: true,
    candidates: candidates.length,
    shopifyMutations: 0,
    missingProductsCreated: 0,
    confirmationRequired: confirmation,
  }));
  await prisma.$disconnect();
  process.exit(0);
}

const client = await ShopifyService.getClientFromDb(prisma);
const report = {
  startedAt: new Date().toISOString(),
  candidates: candidates.length,
  linked: 0,
  alreadyLinked: 0,
  skipped: [] as Array<{ sku: string; reason: string }>,
  failed: [] as Array<{ sku: string; reason: string }>,
  shopifyMutations: 0,
  missingProductsCreated: 0,
};

for (const [index, candidate] of candidates.entries()) {
  try {
    const url = canonicalUrl(candidate.row.url);
    if (new URL(url).hostname.toLowerCase() !== "www.next.ae") {
      throw new Error("Exact-SKU bootstrap is currently restricted to www.next.ae rows");
    }
    if (![22, 23, 24].includes(Number(candidate.row.priceMultiplier))) {
      throw new Error("Sheet multiplier is outside the approved 22/23/24 set");
    }
    const product = await readShopifyProduct(candidate.shopify.productId);
    if (!product || clean(product.status).toUpperCase() !== "ACTIVE") {
      throw new Error("Shopify product is no longer ACTIVE");
    }
    const variants = product.variants?.nodes || [];
    if (!variants.length || product.variants?.pageInfo?.hasNextPage) {
      throw new Error("Shopify variant set is empty or exceeds the verified 250-variant limit");
    }
    const exactSkuVariants = variants.filter((variant: any) => normalizeSku(variant.sku) === normalizeSku(candidate.sku));
    if (exactSkuVariants.length !== 1) {
      throw new Error(`Expected exactly one current Shopify variant with sheet SKU; found ${exactSkuVariants.length}`);
    }

    const outcome = await prisma.$transaction(async (tx) => {
      const existingShopify = await tx.shopifyProduct.findUnique({
        where: { shopifyId: product.id },
        select: { id: true, sourceProductId: true },
      });
      const existingSource = await tx.sourceProduct.findUnique({
        where: { url },
        include: { shopifyProduct: { select: { id: true, shopifyId: true } } },
      });
      if (existingShopify || existingSource?.shopifyProduct) {
        if (existingShopify?.sourceProductId === existingSource?.id && existingSource?.shopifyProduct?.shopifyId === product.id) {
          return "already_linked" as const;
        }
        throw new Error("Source URL or Shopify product is already linked to a different record");
      }

      const supplier = await tx.supplier.upsert({
        where: { name: "Next" },
        update: {},
        create: { name: "Next", baseUrl: "https://www.next.ae" },
      });
      const canonicalVariant = exactSkuVariants[0];
      const inferredSourcePrice = Number((Number(canonicalVariant.price) / candidate.row.priceMultiplier).toFixed(4));
      const importMeta = {
        spreadsheetId: "1fCbPajWL3nukX0TdoN1m2X8LV3pfPsxSMLBb0yWug2w",
        sheetUrl: candidate.row.sheetUrl,
        sheetName: candidate.row.sheetName,
        sheetId: candidate.row.gid,
        excelRowNumber: candidate.row.rowNumber,
        sheetCollection: candidate.row.collection,
        sheetPriceMultiplier: candidate.row.priceMultiplier,
        exactSkuBootstrap: true,
        sourcePricePendingRefresh: true,
        linkedAt: new Date().toISOString(),
      };
      const sourceData = {
        supplierId: supplier.id,
        productId: nextProductCode(url),
        title: product.title,
        description: null,
        brand: product.vendor || "Next",
        currency: "AED",
        price: inferredSourcePrice,
        syncStatus: "active",
        lastScrapedAt: new Date(0),
        raw: JSON.stringify({ options: shopifyOptions(variants), import: importMeta, bootstrap: { shopifyProductId: product.id } }),
      };
      const sourceProduct = existingSource
        ? await tx.sourceProduct.update({ where: { id: existingSource.id }, data: sourceData })
        : await tx.sourceProduct.create({ data: { ...sourceData, url } });

      await tx.manualReviewItem.deleteMany({ where: { sourceProductId: sourceProduct.id, status: "pending" } });
      await tx.sourceImage.deleteMany({ where: { sourceProductId: sourceProduct.id } });
      await tx.sourceVariant.deleteMany({ where: { sourceProductId: sourceProduct.id } });
      const dbShopifyProduct = await tx.shopifyProduct.create({
        data: {
          sourceProductId: sourceProduct.id,
          shopifyId: product.id,
          handle: product.handle,
          status: "active",
          collectionIds: candidate.row.collection || null,
          price: Number(canonicalVariant.price),
          syncEnabled: true,
          syncPrice: true,
          syncInventory: true,
          syncImages: false,
        },
      });
      for (const [variantIndex, variant] of variants.entries()) {
        const optionValues = Object.fromEntries(
          (variant.selectedOptions || []).map((option: any) => [clean(option.name), clean(option.value)]),
        );
        const sourceVariant = await tx.sourceVariant.create({
          data: {
            sourceProductId: sourceProduct.id,
            sourceVariantId: `shopify-bootstrap-${String(variant.id).split("/").pop()}`,
            sku: clean(variant.sku) || null,
            color: optionValue(optionValues, /colou?r/i),
            size: optionValue(optionValues, /size|age/i),
            price: Number((Number(variant.price) / candidate.row.priceMultiplier).toFixed(4)),
            currency: "AED",
            available: Number(variant.inventoryQuantity) > 0,
            stockStatus: Number(variant.inventoryQuantity) > 0 ? "in_stock" : "out_of_stock",
            raw: JSON.stringify({ optionValues, exactSkuBootstrap: variantIndex === variants.indexOf(canonicalVariant) }),
          },
        });
        await tx.shopifyVariant.create({
          data: {
            shopifyProductId: dbShopifyProduct.id,
            sourceVariantId: sourceVariant.id,
            shopifyId: variant.id,
            sku: clean(variant.sku) || null,
            price: Number(variant.price),
          },
        });
      }
      await tx.auditLog.create({
        data: {
          sourceProductId: sourceProduct.id,
          action: "LINK_EXISTING_EXACT_SKU_BOOTSTRAP",
          details: JSON.stringify({
            shopifyProductId: product.id,
            sheetSku: candidate.sku,
            rowNumber: candidate.row.rowNumber,
            sheetId: candidate.row.gid,
            variantsLinked: variants.length,
            shopifyMutations: 0,
          }),
        },
      });
      return "linked" as const;
    }, { maxWait: 10_000, timeout: 30_000 });

    if (outcome === "linked") report.linked += 1;
    else report.alreadyLinked += 1;
  } catch (error: any) {
    report.failed.push({ sku: candidate.sku, reason: clean(error?.message || error).slice(0, 1000) });
  }
  if ((index + 1) % 25 === 0 || index + 1 === candidates.length) {
    console.log(JSON.stringify({ processed: index + 1, linked: report.linked, alreadyLinked: report.alreadyLinked, failed: report.failed.length }));
  }
}

const completed = { ...report, completedAt: new Date().toISOString() };
await writeFile(outputPath, `${JSON.stringify(completed, null, 2)}\n`, "utf8");
await prisma.importBatch.create({
  data: {
    status: report.failed.length ? "PARTIAL" : "COMPLETED",
    target: "link_existing_exact_sku",
    productIds: String(report.linked),
    payloadJson: JSON.stringify({ ...completed, failed: completed.failed.slice(0, 100) }),
  },
});
console.log(JSON.stringify({ ...completed, failed: report.failed.length, outputPath }));
await prisma.$disconnect();

async function readShopifyProduct(id: string) {
  const data: any = await client.request(`
    query ExactSkuLinkProduct($id: ID!) {
      product(id: $id) {
        id title handle status vendor
        variants(first: 250) {
          nodes { id sku price inventoryQuantity selectedOptions { name value } }
          pageInfo { hasNextPage }
        }
      }
    }
  `, { id });
  return data?.product;
}

function shopifyOptions(variants: any[]) {
  const values = new Map<string, Set<string>>();
  for (const variant of variants) {
    for (const option of variant.selectedOptions || []) {
      const name = clean(option.name);
      if (!name || name === "Title") continue;
      const set = values.get(name) || new Set<string>();
      if (clean(option.value)) set.add(clean(option.value));
      values.set(name, set);
    }
  }
  return [...values].map(([name, set]) => ({ name, values: [...set] }));
}

function optionValue(values: Record<string, string>, pattern: RegExp) {
  const match = Object.entries(values).find(([name]) => pattern.test(name));
  return match?.[1] || null;
}

function nextProductCode(url: string) {
  const match = new URL(url).pathname.match(/\/style\/([^/]+)\/([^/]+)/i);
  return match ? `${match[1]}-${match[2]}`.toUpperCase() : null;
}

function canonicalUrl(value: string) {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function normalizeSku(value: unknown) {
  return clean(value).replace(/\s+/g, "").toUpperCase();
}

function clean(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function boundedInteger(raw: string, min: number, max: number) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Expected ${min}-${max}`);
  return value;
}
