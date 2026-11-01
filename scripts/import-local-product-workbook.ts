import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import XLSX from "xlsx";

const execFileAsync = promisify(execFile);

type WorkbookRow = {
  sheetName: string;
  rowNumber: number;
  url: string;
  priceMultiplier: number;
  collection: string;
};

type CheckpointEntry = {
  at: string;
  sheetName?: string;
  rowNumber: number;
  url: string;
  outcome: "successful" | "skipped" | "failed";
  response?: unknown;
  error?: string;
};

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (!value.startsWith("--")) continue;
  const [key, inlineValue] = value.slice(2).split("=", 2);
  args.set(key, inlineValue ?? process.argv[index + 1] ?? "true");
  if (inlineValue === undefined && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    index += 1;
  }
}

const filePath = args.get("file");
if (!filePath) throw new Error("Missing required --file argument");

const apiBase = (args.get("api") || "https://datauplode-production.up.railway.app").replace(/\/$/, "");
const sheetNameArg = args.get("sheet");
const allSheets = args.get("all-sheets") === "true";
const limit = Math.max(1, Number(args.get("limit") || Number.MAX_SAFE_INTEGER));
const concurrency = Math.min(8, Math.max(1, Number(args.get("concurrency") || 1)));
const retryFailed = args.get("retry-failed") === "true";
const scraperApiKey = args.get("scraper-api-key") || process.env.SCRAPERAPI_KEY || "";
const reefApiKey = args.get("reef-api-key") || process.env.REEF_API_KEY || "";
const reefDemo = args.get("reef-demo") === "true";
const managedFirst = args.get("managed-first") === "true";
const directFirst = args.get("direct-first") === "true";
const nextApiFirst = args.get("next-api-first") === "true";
const brandCollection = String(args.get("brand-collection") || "").trim();
const normalizeCollections = args.get("normalize-collections") === "true";
const defaultMultiplierArg = String(args.get("default-multiplier") || "").trim();
const defaultMultiplier = defaultMultiplierArg ? Number(defaultMultiplierArg) : null;
if (defaultMultiplier !== null && ![22, 23, 24].includes(defaultMultiplier)) {
  throw new Error("--default-multiplier must be one of 22, 23, or 24");
}
const compareAtMultiplierArg = String(args.get("compare-at-multiplier") || "").trim();
const compareAtMultiplier = compareAtMultiplierArg ? Number(compareAtMultiplierArg) : null;
if (
  compareAtMultiplier !== null &&
  (!Number.isFinite(compareAtMultiplier) || compareAtMultiplier <= 0)
) {
  throw new Error("--compare-at-multiplier must be a positive number");
}
const onlyUrlsFile = String(args.get("only-urls-file") || "").trim();
const checkpointPath = args.get("checkpoint") || path.join(
  process.env.TEMP || "C:/tmp",
  `${path.basename(filePath).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}-shopify-import.jsonl`,
);

function normalizeProductUrl(value: string) {
  const parsed = new URL(value.trim());
  parsed.hash = "";
  if (/(^|\.)centrepointstores\.com$/i.test(parsed.hostname)) {
    parsed.pathname = parsed.pathname.replace(/[.,;:]+$/, "");
  }
  if (/^(www\.)?next\.ae$/i.test(parsed.hostname)) {
    parsed.pathname = parsed.pathname.replace(/^\/ar\//i, "/en/");
  }
  return parsed.toString().replace(/\/$/, "");
}

function productIdentity(url: string) {
  const parsed = new URL(url);
  if (/(^|\.)shein\.com$/i.test(parsed.hostname)) {
    const productId = parsed.pathname.match(/-p-(\d+)(?:\.|-|\/|$)/i)?.[1];
    if (productId) return `shein:${productId}`;
  }
  return url;
}

function checkpointKey(entry: { sheetName?: string; rowNumber: number }) {
  return `${entry.sheetName || sheetNameArg || ""}:${entry.rowNumber}`;
}

const COLLECTION_ALIASES = new Map<string, string>([
  ["blanket", "Blanket"],
  ["blankets", "Blanket"],
  ["body suit", "Bodysuits"],
  ["bodysuit", "Bodysuits"],
  ["bodysuits", "Bodysuits"],
  ["dress", "Dresses"],
  ["dresses", "Dresses"],
  ["dreeses", "Dresses"],
  ["dungaree set", "Dungrees & sets"],
  ["dungarees set", "Dungrees & sets"],
  ["dungrees & sets", "Dungrees & sets"],
  ["hospital set", "Hospital sets"],
  ["hospital sets", "Hospital sets"],
  ["jacket", "Jackets"],
  ["leggings", "Trousers & Leggings"],
  ["pyjama", "Pyjamas & Homewear"],
  ["pyjamas", "Pyjamas & Homewear"],
  ["pramsuit", "Pramsuits & Snowsuits"],
  ["romper", "Rompers"],
  ["rompers", "Rompers"],
  ["shoes", "Footwear"],
  ["sleepsuit", "Sleepsuits"],
  ["sleepsuits", "Sleepsuits"],
  ["snowsuit", "Pramsuits & Snowsuits"],
  ["t-shirts", "Tops & T-shirts"],
  ["tops & t-shirts", "Tops & T-shirts"],
]);

function normalizedCollectionName(value: string, url: string) {
  const trimmed = value.trim();
  if (!normalizeCollections) return trimmed || "General";
  if (!trimmed && /(?:^|[-/])shirt(?:s)?(?:[-/]|$)/i.test(new URL(url).pathname)) {
    return "Tops & T-shirts";
  }
  return COLLECTION_ALIASES.get(trimmed.toLowerCase()) || trimmed || "General";
}

function loadCompleted() {
  const completed = new Map<string, CheckpointEntry>();
  if (!fs.existsSync(checkpointPath)) return completed;
  for (const line of fs.readFileSync(checkpointPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as CheckpointEntry;
      if (entry.outcome !== "failed" || !retryFailed) completed.set(checkpointKey(entry), entry);
    } catch {
      // Ignore a partially written final line so interrupted runs stay resumable.
    }
  }
  return completed;
}

async function postJson(url: string, body: unknown, attempts = 3) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(12 * 60 * 1000),
      });
      const text = await response.text();
      const parsed = text ? JSON.parse(text) : {};
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${parsed?.error || text}`);
      return parsed;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
    }
  }
  throw lastError;
}

function shouldRetryWithManagedSnapshot(response: any) {
  const failure = response?.failed?.[0];
  const message = String(failure?.error || failure?.reason || "");
  return /HTTP 403|Cloudflare|protected|browser snapshot|Bridge task timeout|No usable product HTML/i.test(message);
}

async function loadManagedSnapshot(url: string) {
  if (!scraperApiKey) return "";
  const endpoint = new URL("https://api.scraperapi.com");
  endpoint.searchParams.set("api_key", scraperApiKey);
  if (/^(www\.)?next\.ae$/i.test(new URL(url).hostname)) {
    endpoint.searchParams.set("premium", "true");
    endpoint.searchParams.set("max_cost", "10");
  }
  endpoint.searchParams.set("url", url);
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(3 * 60 * 1000) });
  if (!response.ok) throw new Error(`Managed snapshot failed with HTTP ${response.status}`);
  const html = await response.text();
  if (html.trim().length < 500) throw new Error("Managed snapshot returned incomplete HTML");
  return html;
}

async function loadDirectSnapshot(url: string) {
  const { stdout: html } = await execFileAsync(
    "curl.exe",
    [
      "-L",
      "-sS",
      "--fail-with-body",
      "--compressed",
      "--retry",
      "4",
      "--retry-all-errors",
      "--retry-delay",
      "3",
      "--connect-timeout",
      "30",
      "-m",
      "180",
      "-A",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
      url,
    ],
    { maxBuffer: 12 * 1024 * 1024, windowsHide: true },
  );
  if (html.trim().length < 500) throw new Error("Direct snapshot returned incomplete HTML");
  return html;
}

function isSheinProductUrl(url: string) {
  try {
    return /(^|\.)shein\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isNextProductUrl(url: string) {
  try {
    return /(^|\.)next\.ae$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

async function loadStructuredNextSnapshot(url: string) {
  const itemNumber = new URL(url).pathname.split("/").filter(Boolean).at(-1)?.toUpperCase();
  if (!itemNumber || !/^[A-Z0-9]+$/.test(itemNumber)) {
    throw new Error("Next URL does not include a valid item number");
  }

  const endpoint = new URL("https://api.nextdirect.com/api/edge-aggregator/product/V2/index.json");
  endpoint.searchParams.set("realm", "next");
  endpoint.searchParams.set("territory", "AE");
  endpoint.searchParams.set("language", "en");
  endpoint.searchParams.set("useStock", "true");
  endpoint.searchParams.set("productId", itemNumber);

  const response = await fetch(endpoint, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Next product API failed with HTTP ${response.status}`);
  const payload: any = await response.json();
  const style = payload?.productData?.data?.style;
  const item = style?.item;
  if (!style || !item?.itemNumber || !item?.itemTitle) {
    throw new Error("Next product API did not return a usable product");
  }

  const optionPrices = new Map<string, number>(
    (Array.isArray(item?.price?.options) ? item.price.options : [])
      .map((entry: any) => [String(entry?.optionNumber || ""), Number(entry?.price || 0)] as const)
      .filter((entry: readonly [string, number]) => entry[0] && entry[1] > 0),
  );
  const minPrice = Number(item?.price?.price?.minPrice || 0);
  const maxPrice = Number(item?.price?.price?.maxPrice || minPrice);
  const options = (Array.isArray(item?.options) ? item.options : []).map((option: any) => ({
    name: String(option?.displaySize || "").trim(),
    value: String(option?.number || "").trim(),
    optionNumber: String(option?.number || "").trim(),
    stockStatus: String(option?.stockStatus || "").trim(),
    priceUnformatted: optionPrices.get(String(option?.number || "")) || minPrice,
  }));
  if (!options.length || options.some((option: any) => !option.name || !option.value)) {
    throw new Error("Next product API did not return complete size options");
  }

  const imageUrls = (Array.isArray(item?.media) ? item.media : [])
    .map((media: any) => String(media?.name || "").trim())
    .filter(Boolean)
    .map((name: string) =>
      `https://xcdn.next.co.uk/common/items/default/default/itemimages/3_4Ratio/product/lge/${name}.jpg?im=Resize,width=750`,
    );
  if (!imageUrls.length) throw new Error("Next product API did not return product images");

  const embeddedProduct = {
    itemNumber: String(item.itemNumber),
    productCode: String(item.itemNumber),
    title: String(item.itemTitle),
    itemDescription: item.itemDescription || {},
    brand: String(style.brand || "Next"),
    colour: String(item.colour || ""),
    currencyCode: String(item?.price?.currencyCode || "AED"),
    price: `${String(item?.price?.currencyCode || "AED")} ${minPrice}`,
    priceData: {
      price: { minPrice, maxPrice },
      priceOptions: [...optionPrices].map(([optionNumber, price]) => ({ optionNumber, price })),
    },
    options: { options },
    imageUrls,
  };
  const nextData = {
    props: { pageProps: { dehydratedState: { queries: [{ state: { data: embeddedProduct } }] } } },
  };
  const serialized = JSON.stringify(nextData).replace(/<\/script/gi, "<\\/script");
  return `<html><head><title>${embeddedProduct.title}</title></head><body><script id="__NEXT_DATA__" type="application/json">${serialized}</script>${imageUrls.join("\n")}</body></html>`;
}

async function loadStructuredSheinSnapshot(url: string) {
  const goodsId = new URL(url).pathname.match(/-p-(\d+)(?:\.|-|\/|$)/i)?.[1];
  if (!goodsId) throw new Error("SHEIN URL does not include a product ID");
  if (!reefApiKey && !reefDemo) {
    throw new Error("SHEIN requires --reef-api-key (or --reef-demo for a one-row canary)");
  }

  const params = { goods_id: goodsId, market: "ae", url, deep: true };
  const endpoint = reefApiKey
    ? "https://api.reefapi.com/shein/v1/product/detail"
    : "https://reefapi.com/api/proxy";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(reefApiKey ? { "x-api-key": reefApiKey } : {}),
    },
    body: JSON.stringify(
      reefApiKey
        ? params
        : { engine: "shein", action: "product/detail", params },
    ),
    signal: AbortSignal.timeout(3 * 60 * 1000),
  });
  const text = await response.text();
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`SHEIN structured API returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok || payload?.ok !== true || !payload?.data?.product) {
    throw new Error(
      `SHEIN structured API failed: ${payload?.error?.message || `HTTP ${response.status}`}`,
    );
  }
  return `SYNCLY_SHEIN_STRUCTURED_V1\n${JSON.stringify(payload.data.product)}`;
}

const workbook = XLSX.readFile(filePath, { raw: false });
const selectedSheetNames = allSheets
  ? workbook.SheetNames
  : [sheetNameArg || workbook.SheetNames[0]];
const seenProducts = new Set<string>();
const rows: WorkbookRow[] = [];
for (const sheetName of selectedSheetNames) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`Sheet not found: ${sheetName}`);
  const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
  for (let index = 0; index < rawRows.length; index += 1) {
    const values = rawRows[index];
    const urlIndex = values.findIndex((value) => /^https?:\/\//i.test(String(value || "").trim()));
    if (urlIndex < 0) continue;
    const multiplierIndex = values.findIndex(
      (value, valueIndex) => valueIndex !== urlIndex && [22, 23, 24].includes(Number(value)),
    );
    if (multiplierIndex < 0 && defaultMultiplier === null) continue;
    const rawUrl = String(values[urlIndex] || "").trim();
    const priceMultiplier = multiplierIndex >= 0
      ? Number(values[multiplierIndex])
      : defaultMultiplier!;
    const url = normalizeProductUrl(rawUrl);
    const identity = productIdentity(url);
    if (seenProducts.has(identity)) continue;
    seenProducts.add(identity);
    const collectionAnchorIndex = multiplierIndex >= 0 ? multiplierIndex : urlIndex;
    const collectionIndex = values.findIndex((value, valueIndex) => {
      const text = String(value || "").trim();
      return valueIndex > collectionAnchorIndex && Boolean(text) && !/^https?:\/\//i.test(text) && ![22, 23, 24].includes(Number(value));
    });
    rows.push({
      sheetName,
      rowNumber: index + 1,
      url,
      priceMultiplier,
      collection: normalizedCollectionName(
        collectionIndex >= 0 ? String(values[collectionIndex]).trim() : "",
        url,
      ),
    });
  }
}

const completed = loadCompleted();
const onlyUrls = (() => {
  if (!onlyUrlsFile) return null;
  const text = fs.readFileSync(onlyUrlsFile, "utf8").replace(/^\uFEFF/, "");
  let values: unknown[];
  try {
    const parsed = JSON.parse(text);
    values = Array.isArray(parsed) ? parsed : [];
  } catch {
    values = text.split(/\r?\n/).filter(Boolean);
  }
  return new Set(values.map((value: any) => normalizeProductUrl(String(value?.url || value || ""))).filter(Boolean));
})();
const pending = rows
  .filter((row) => !onlyUrls || onlyUrls.has(row.url))
  .filter((row) => !completed.has(checkpointKey(row)) && !completed.has(`:${row.rowNumber}`))
  .slice(0, limit);
if (reefDemo && pending.filter((row) => isSheinProductUrl(row.url)).length > 1) {
  throw new Error("--reef-demo is limited to a single SHEIN canary row; use --reef-api-key for batch imports");
}
fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });

console.log(JSON.stringify({
  event: "start",
  filePath,
  sheetNames: selectedSheetNames,
  uniqueRows: rows.length,
  alreadyCompleted: completed.size,
  selected: pending.length,
  concurrency,
  managedFirst,
  directFirst,
  nextApiFirst,
  brandCollection: brandCollection || null,
  normalizeCollections,
  defaultMultiplier,
  compareAtMultiplier,
  checkpointPath,
}));

let successful = 0;
let skipped = 0;
let failed = 0;
let completedCount = 0;
const verifiedShopifyProductIds = new Set<string>();
for (const entry of completed.values()) {
  if (entry.outcome !== "successful") continue;
  const response = entry.response as any;
  const shopifyId = String(response?.verification?.shopifyId || "").trim();
  if (/^gid:\/\/shopify\/Product\/\d+$/.test(shopifyId)) {
    verifiedShopifyProductIds.add(shopifyId);
  }
}

async function processRow(row: WorkbookRow) {
  let checkpoint: CheckpointEntry;
  try {
    const snapshotText = isSheinProductUrl(row.url)
      ? await loadStructuredSheinSnapshot(row.url)
      : nextApiFirst && isNextProductUrl(row.url)
        ? await loadStructuredNextSnapshot(row.url)
      : directFirst
        ? await loadDirectSnapshot(row.url)
        : managedFirst && scraperApiKey
          ? await loadManagedSnapshot(row.url)
          : undefined;
    const requestBody = {
      rows: [{ ...row, snapshotText }],
      collectionNames: [...new Set([brandCollection, row.collection].filter(Boolean))],
      ...(compareAtMultiplier ? { compareAtMultiplier } : {}),
      createManualReview: true,
      waitForPublishCompletion: true,
      reconcileExistingProducts: true,
      sheetName: `${path.basename(filePath)} / ${row.sheetName}`,
      sheetUrl: `local-workbook:${path.basename(filePath)}`,
    };
    let response = await postJson(`${apiBase}/api/imports/excel/process`, requestBody);
    if (scraperApiKey && shouldRetryWithManagedSnapshot(response)) {
      const pageText = await loadManagedSnapshot(row.url);
      requestBody.rows[0].snapshotText = pageText;
      response = await postJson(`${apiBase}/api/imports/excel/process`, requestBody);
    }
    const success = response?.successful?.find((item: any) => item.rowNumber === row.rowNumber);
    const skip = response?.skipped?.find((item: any) => item.rowNumber === row.rowNumber);
    const failure = response?.failed?.find((item: any) => item.rowNumber === row.rowNumber);
    if (success) {
      const shopifyId = String(success?.verification?.shopifyId || "").trim();
      if (compareAtMultiplier) {
        if (!shopifyId) {
          throw new Error("Compare-at verification requires the Shopify product id returned by publish");
        }
        success.pricingPresentation = await postJson(
          `${apiBase}/api/shopify/products/apply-price-presentation`,
          {
            productIds: [shopifyId],
            sellingMultiplier: row.priceMultiplier,
            compareAtMultiplier,
          },
        );
      }
      if (/^gid:\/\/shopify\/Product\/\d+$/.test(shopifyId)) {
        verifiedShopifyProductIds.add(shopifyId);
      }
      successful += 1;
      checkpoint = { at: new Date().toISOString(), sheetName: row.sheetName, rowNumber: row.rowNumber, url: row.url, outcome: "successful", response: success };
    } else if (skip) {
      skipped += 1;
      checkpoint = { at: new Date().toISOString(), sheetName: row.sheetName, rowNumber: row.rowNumber, url: row.url, outcome: "skipped", response: skip };
    } else {
      failed += 1;
      checkpoint = { at: new Date().toISOString(), sheetName: row.sheetName, rowNumber: row.rowNumber, url: row.url, outcome: "failed", response: failure || response, error: failure?.error || failure?.reason || "No successful result returned" };
    }
  } catch (error) {
    failed += 1;
    checkpoint = { at: new Date().toISOString(), sheetName: row.sheetName, rowNumber: row.rowNumber, url: row.url, outcome: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  fs.appendFileSync(checkpointPath, `${JSON.stringify(checkpoint)}\n`);
  completedCount += 1;
  console.log(JSON.stringify({
    event: "row",
    progress: `${completedCount}/${pending.length}`,
    successful,
    skipped,
    failed,
    ...checkpoint,
  }));
}

let nextRowIndex = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    while (nextRowIndex < pending.length) {
      const row = pending[nextRowIndex];
      nextRowIndex += 1;
      await processRow(row);
    }
  }),
);

if (brandCollection && verifiedShopifyProductIds.size > 0) {
  const productIds = [...verifiedShopifyProductIds];
  for (let index = 0; index < productIds.length; index += 500) {
    const assignment = await postJson(`${apiBase}/api/shopify/collections/assign-products`, {
      collectionTitle: brandCollection,
      productIds: productIds.slice(index, index + 500),
    });
    if (assignment?.success !== true) {
      throw new Error(`Collection verification failed for ${brandCollection}`);
    }
    console.log(JSON.stringify({
      event: "collection_verified",
      collection: brandCollection,
      requested: assignment.requested,
      verified: assignment.verified,
      collectionProductCount: assignment.collectionProductCount,
    }));
  }
}

console.log(JSON.stringify({ event: "complete", selected: pending.length, successful, skipped, failed, checkpointPath }));
if (failed > 0) process.exitCode = 2;
