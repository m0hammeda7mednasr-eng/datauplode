import { readFile, writeFile } from "node:fs/promises";
import { prisma } from "../src/server/db.js";
import { ShopifyService } from "../src/server/services/shopify.js";

type Candidate = {
  url: string;
  row: {
    rowNumber: number;
    priceMultiplier: number;
    collection: string;
    sheetName: string;
    gid: number;
    sheetUrl: string;
  };
  shopify: { productId: string; status: string };
};

const confirmation = "link-exact-source-url-v1";
const execute = process.env.LINK_EXACT_URL_CONFIRMATION === confirmation;
const inputPath = process.env.LINK_EXACT_URL_INPUT || "C:/tmp/shopify-exact-source-url-candidates.json";
const outputPath = process.env.LINK_EXACT_URL_REPORT || `C:/tmp/link-exact-url-${Date.now()}.json`;
const limit = boundedInteger(process.env.LINK_EXACT_URL_LIMIT || "500", 1, 500);
const input = JSON.parse(await readFile(inputPath, "utf8")) as { candidates: Candidate[] };
const candidates = input.candidates
  .filter((candidate) => clean(candidate.shopify.status).toUpperCase() === "ACTIVE")
  .slice(0, limit);

if (!execute) {
  console.log(JSON.stringify({ dryRun: true, candidates: candidates.length, shopifyMutations: 0, confirmationRequired: confirmation }));
  await prisma.$disconnect();
  process.exit(0);
}

const client = await ShopifyService.getClientFromDb(prisma);
const report = { candidates: candidates.length, linked: 0, alreadyLinked: 0, failed: [] as Array<{ url: string; reason: string }>, shopifyMutations: 0 };
for (const [index, candidate] of candidates.entries()) {
  try {
    const url = canonicalUrl(candidate.url);
    if (![22, 23, 24].includes(Number(candidate.row.priceMultiplier))) throw new Error("Multiplier is outside 22/23/24");
    const product = await readProduct(candidate.shopify.productId);
    if (!product || clean(product.status).toUpperCase() !== "ACTIVE") throw new Error("Shopify product is no longer ACTIVE");
    const evidence = [product.descriptionHtml, product.synclySource?.value, product.customSource?.value]
      .map((value) => decodeHtml(String(value || "")))
      .flatMap(extractUrls)
      .map(canonicalUrl);
    if (!evidence.includes(url)) throw new Error("Exact source URL evidence is no longer present on Shopify");
    const variants = product.variants?.nodes || [];
    if (!variants.length || product.variants?.pageInfo?.hasNextPage) throw new Error("Variant set cannot be proven complete");

    const outcome = await prisma.$transaction(async (tx) => {
      const existingShopify = await tx.shopifyProduct.findUnique({ where: { shopifyId: product.id }, select: { id: true, sourceProductId: true } });
      const existingSource = await tx.sourceProduct.findUnique({ where: { url }, include: { shopifyProduct: { select: { shopifyId: true } } } });
      if (existingShopify || existingSource?.shopifyProduct) {
        if (existingShopify?.sourceProductId === existingSource?.id && existingSource?.shopifyProduct?.shopifyId === product.id) return "already" as const;
        throw new Error("Source URL or Shopify product is linked elsewhere");
      }
      const supplierName = supplierFromUrl(url);
      const supplier = await tx.supplier.upsert({
        where: { name: supplierName },
        update: {},
        create: { name: supplierName, baseUrl: new URL(url).origin },
      });
      const multiplier = candidate.row.priceMultiplier;
      const inferredPrice = Number((Math.min(...variants.map((variant: any) => Number(variant.price))) / multiplier).toFixed(4));
      const importMeta = {
        spreadsheetId: "1fCbPajWL3nukX0TdoN1m2X8LV3pfPsxSMLBb0yWug2w",
        sheetUrl: candidate.row.sheetUrl,
        sheetName: candidate.row.sheetName,
        sheetId: candidate.row.gid,
        excelRowNumber: candidate.row.rowNumber,
        sheetCollection: candidate.row.collection,
        sheetPriceMultiplier: multiplier,
        exactSourceUrlBootstrap: true,
        sourcePricePendingRefresh: true,
        linkedAt: new Date().toISOString(),
      };
      const sourceData = {
        supplierId: supplier.id,
        productId: productCode(url),
        title: product.title,
        description: null,
        brand: product.vendor || supplierName,
        currency: "AED",
        price: inferredPrice,
        raw: JSON.stringify({ options: optionSummary(variants), import: importMeta, bootstrap: { shopifyProductId: product.id } }),
        syncStatus: "paused",
        lastScrapedAt: new Date(0),
      };
      const sourceProduct = existingSource
        ? await tx.sourceProduct.update({ where: { id: existingSource.id }, data: sourceData })
        : await tx.sourceProduct.create({ data: { ...sourceData, url } });
      await tx.manualReviewItem.deleteMany({ where: { sourceProductId: sourceProduct.id, status: "pending" } });
      await tx.sourceImage.deleteMany({ where: { sourceProductId: sourceProduct.id } });
      await tx.sourceVariant.deleteMany({ where: { sourceProductId: sourceProduct.id } });
      const dbProduct = await tx.shopifyProduct.create({
        data: {
          sourceProductId: sourceProduct.id,
          shopifyId: product.id,
          handle: product.handle,
          status: "active",
          collectionIds: candidate.row.collection || null,
          price: Math.min(...variants.map((variant: any) => Number(variant.price))),
          syncEnabled: false,
          syncPrice: true,
          syncInventory: true,
          syncImages: false,
        },
      });
      for (const variant of variants) {
        const optionValues = Object.fromEntries((variant.selectedOptions || []).map((option: any) => [clean(option.name), clean(option.value)]));
        const sourceVariant = await tx.sourceVariant.create({
          data: {
            sourceProductId: sourceProduct.id,
            sourceVariantId: `shopify-bootstrap-${String(variant.id).split("/").pop()}`,
            sku: clean(variant.sku) || null,
            color: optionValue(optionValues, /colou?r/i),
            size: optionValue(optionValues, /size|age/i),
            price: Number((Number(variant.price) / multiplier).toFixed(4)),
            currency: "AED",
            available: Number(variant.inventoryQuantity) > 0,
            stockStatus: Number(variant.inventoryQuantity) > 0 ? "in_stock" : "out_of_stock",
            raw: JSON.stringify({ optionValues, exactSourceUrlBootstrap: true }),
          },
        });
        await tx.shopifyVariant.create({ data: {
          shopifyProductId: dbProduct.id,
          sourceVariantId: sourceVariant.id,
          shopifyId: variant.id,
          sku: clean(variant.sku) || null,
          price: Number(variant.price),
        } });
      }
      await tx.auditLog.create({ data: {
        sourceProductId: sourceProduct.id,
        action: "LINK_EXISTING_EXACT_SOURCE_URL",
        details: JSON.stringify({ shopifyProductId: product.id, rowNumber: candidate.row.rowNumber, sheetId: candidate.row.gid, variantsLinked: variants.length, shopifyMutations: 0 }),
      } });
      return "linked" as const;
    }, { maxWait: 10_000, timeout: 30_000 });
    if (outcome === "linked") report.linked += 1;
    else report.alreadyLinked += 1;
  } catch (error: any) {
    report.failed.push({ url: candidate.url, reason: clean(error?.message || error).slice(0, 1000) });
  }
  if ((index + 1) % 25 === 0 || index + 1 === candidates.length) console.log(JSON.stringify({ processed: index + 1, linked: report.linked, alreadyLinked: report.alreadyLinked, failed: report.failed.length }));
}
const completed = { ...report, completedAt: new Date().toISOString() };
await writeFile(outputPath, `${JSON.stringify(completed, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ...completed, failed: report.failed.length, outputPath }));
await prisma.$disconnect();

async function readProduct(id: string) {
  const data: any = await client.request(`query ExactUrlLink($id: ID!) { product(id: $id) { id title handle status vendor descriptionHtml synclySource: metafield(namespace: "syncly", key: "source_url") { value } customSource: metafield(namespace: "custom", key: "source_url") { value } variants(first: 250) { nodes { id sku price inventoryQuantity selectedOptions { name value } } pageInfo { hasNextPage } } } }`, { id });
  return data?.product;
}
function optionSummary(variants: any[]) { const map = new Map<string, Set<string>>(); for (const variant of variants) for (const option of variant.selectedOptions || []) { const name = clean(option.name); if (!name || name === "Title") continue; const set = map.get(name) || new Set<string>(); set.add(clean(option.value)); map.set(name, set); } return [...map].map(([name, values]) => ({ name, values: [...values] })); }
function optionValue(values: Record<string, string>, pattern: RegExp) { return Object.entries(values).find(([name]) => pattern.test(name))?.[1] || null; }
function supplierFromUrl(url: string) { const host = new URL(url).hostname.toLowerCase(); if (host.includes("next.")) return "Next"; if (host.includes("centrepoint")) return "Centrepoint"; if (host.includes("hm.com")) return "H&M"; if (host.includes("maxfashion")) return "Max Fashion"; if (host.includes("shein")) return "Shein"; if (host.includes("lefties")) return "Lefties"; if (host.includes("marksandspencer")) return "M&S"; return host.replace(/^www\./, ""); }
function productCode(url: string) { const path = new URL(url).pathname; return path.match(/\/style\/[^/]+\/([^/]+)/i)?.[1]?.toUpperCase() || path.split("/").filter(Boolean).pop() || null; }
function extractUrls(value: string) { return value.match(/https?:\/\/[^\s<>"']+/gi) || []; }
function decodeHtml(value: string) { return value.replace(/&amp;/gi, "&").replace(/&#x2F;/gi, "/").replace(/&#47;/gi, "/"); }
function canonicalUrl(value: string) { const parsed = new URL(String(value || "").replace(/[),.;]+$/, "")); parsed.hash = ""; parsed.hostname = parsed.hostname.toLowerCase().replace(/^m\./, "www."); for (const key of [...parsed.searchParams.keys()]) if (/^(utm_|gclid|fbclid|ref|source)/i.test(key)) parsed.searchParams.delete(key); parsed.pathname = parsed.pathname.replace(/\/+$/, ""); return parsed.toString().replace(/\/$/, "").toLowerCase(); }
function clean(value: unknown) { return String(value ?? "").replace(/\s+/g, " ").trim(); }
function boundedInteger(raw: string, min: number, max: number) { const value = Number(raw); if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Expected ${min}-${max}`); return value; }
