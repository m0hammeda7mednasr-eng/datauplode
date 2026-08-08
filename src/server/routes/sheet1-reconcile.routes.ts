import { Router, type Request } from "express";
import axios from "axios";
import crypto from "crypto";
import { prisma } from "../db.js";
import { ScraperService, type NormalizedProduct } from "../services/scraper.js";
import { ShopifyService } from "../services/shopify.js";

const router = Router();
const scraperService = new ScraperService();

const SPREADSHEET_ID = "1fCbPajWL3nukX0TdoN1m2X8LV3pfPsxSMLBb0yWug2w";
const SHEET_NAME = "الورقة1";
const SHEET_GID = 0;
const SHEET_ID = 0;
const RUN_CONFIRMATION = "2026-08-09-sheet1-reconcile-v1";
const DEFAULT_IN_STOCK_QUANTITY = Math.max(
  1,
  Number(process.env.SHOPIFY_DEFAULT_IN_STOCK_QUANTITY || 10) || 10,
);

type SheetRow = {
  rowNumber: number;
  url: string;
  normalizedUrl: string;
  multiplier: number;
  collection: string;
  existingSku: string;
};

type ReconcileStatus =
  | "verified"
  | "missing"
  | "ambiguous"
  | "conflict"
  | "error"
  | "skipped";

type ReconcileResult = {
  status: ReconcileStatus;
  rows: number[];
  url: string;
  multiplier: number | null;
  productCode?: string | null;
  shopifyProductId?: string;
  shopifyTitle?: string;
  expectedSku?: string;
  canonicalSize?: string;
  variantsChecked?: number;
  pricesChanged?: number;
  inventoryChanged?: number;
  skuChanged?: boolean;
  sheetWritten?: boolean;
  readbackVerified?: boolean;
  reason?: string;
};

type ReconcileUnit = {
  rows: SheetRow[];
  primary: SheetRow;
  conflict: boolean;
  conflictMultipliers: number[];
};

let googleTokenCache: { token: string; expiresAt: number } | null = null;

function clean(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function canonicalizeUrl(value: string) {
  const raw = String(value || "").replace(/[\t\r\n]+/g, "").trim();
  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    parsed.search = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return raw;
  }
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"') {
      if (quoted && next === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }

  row.push(cell);
  if (row.some((value) => clean(value))) rows.push(row);
  return rows;
}

function parseMultiplier(value: unknown) {
  const normalized = clean(value).replace(/,/g, ".");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const number = Number(normalized);
  if (!Number.isFinite(number) || number < 1 || number > 100) return null;
  return number;
}

async function loadSheetRows(): Promise<SheetRow[]> {
  const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/export?format=csv&gid=${SHEET_GID}`;
  const response = await axios.get(url, {
    timeout: Number(process.env.GOOGLE_SHEET_FETCH_TIMEOUT_MS || 30000),
    responseType: "text",
  });

  return parseCsv(String(response.data || ""))
    .map((cells, index): SheetRow | null => {
      const productUrl = clean(cells[0]);
      const multiplier = parseMultiplier(cells[1]);
      if (!/^https?:\/\//i.test(productUrl) || multiplier === null) return null;
      return {
        rowNumber: index + 1,
        url: productUrl,
        normalizedUrl: canonicalizeUrl(productUrl),
        multiplier,
        collection: clean(cells[2]),
        existingSku: clean(cells[3]),
      };
    })
    .filter((row): row is SheetRow => Boolean(row));
}

function buildUnits(rows: SheetRow[], onlyMissingSku: boolean): ReconcileUnit[] {
  const byUrl = new Map<string, SheetRow[]>();
  for (const row of rows) {
    if (onlyMissingSku && row.existingSku) continue;
    const list = byUrl.get(row.normalizedUrl) || [];
    list.push(row);
    byUrl.set(row.normalizedUrl, list);
  }

  return [...byUrl.values()].map((group) => {
    const multipliers = [...new Set(group.map((row) => row.multiplier))].sort((a, b) => a - b);
    return {
      rows: group,
      primary: group[0],
      conflict: multipliers.length > 1,
      conflictMultipliers: multipliers,
    };
  });
}

function extractRawProductCode(url: string): string | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const styleIndex = parts.findIndex((part) => part.toLowerCase() === "style");
    const raw = styleIndex >= 0 ? parts[styleIndex + 2] : parts[parts.length - 1];
    const code = clean(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
    return code || null;
  } catch {
    return null;
  }
}

function formatProductCode(rawCode: string) {
  const code = clean(rawCode).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length <= 3) return code;
  return `${code.slice(0, -3)}-${code.slice(-3)}`;
}

function brandCode(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("next.")) return "NXT";
    if (host.includes("hm.com")) return "HM";
    if (host.includes("maxfashion")) return "MAX";
    if (host.includes("centrepoint")) return "CPT";
    if (host.includes("shein")) return "SHN";
    if (host.includes("lefties")) return "LFT";
    if (host.includes("marksandspencer")) return "MNS";
  } catch {}
  return "SRC";
}

function numberToken(value: number) {
  return Number.isInteger(value) ? String(value) : String(value).replace(/0+$/, "").replace(/\.$/, "");
}

function normalizeSizeToken(value: unknown): string | null {
  const raw = clean(value).toUpperCase();
  if (!raw || raw === "DEFAULT" || raw === "DEFAULT TITLE") return null;

  let match = raw.match(/(\d+)\s*CM[^0-9]*(\d+)\s*LB/);
  if (match) return `${match[1]}CM-${match[2]}LB`;

  match = raw.match(/(\d+)\s*CM.*FIRST\s*SIZE/);
  if (match) return `${match[1]}CM-FIRST-SIZE`;

  if (/\bNEW\s*BORN\b|\bNEWBORN\b|\bNB\b/.test(raw)) return "NB";

  match = raw.match(/UP\s*TO\s*(\d+(?:\.\d+)?)\s*MONTH/);
  if (match) return `UP-TO-${match[1]}M`;

  match = raw.match(/EU\s*(\d+(?:\.\d+)?).*?UK\s*(\d+(?:\.\d+)?)/);
  if (match) return `EU-${match[1]}-UK-${match[2]}`;

  match = raw.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*MONTH/);
  if (match) return `${match[1]}-${match[2]}M`;

  match = raw.match(/(?:^|[^0-9])(\d+(?:\.\d+)?)\s*MONTH/);
  if (match) return `${match[1]}M`;

  match = raw.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*YEAR/);
  if (match) return `${match[1]}-${match[2]}Y`;

  match = raw.match(/(?:^|[^0-9])(\d+(?:\.\d+)?)\s*YEAR/);
  if (match) return `${match[1]}Y`;

  if (/\bONE\s*SIZE\b|\bSIZE\s*ONE\b|^ONE$/.test(raw)) return "ONE";

  return null;
}

function sizeRank(token: string | null) {
  if (!token) return Number.POSITIVE_INFINITY;
  if (/^\d+CM-\d+LB$/.test(token)) return -100;
  if (/^\d+CM-FIRST-SIZE$/.test(token)) return -90;
  if (token === "NB") return -80;
  let match = token.match(/^UP-TO-(\d+(?:\.\d+)?)M$/);
  if (match) return -70 + Number(match[1]);
  match = token.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)M$/);
  if (match) return Number(match[1]);
  match = token.match(/^(\d+(?:\.\d+)?)M$/);
  if (match) return Number(match[1]);
  match = token.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)Y$/);
  if (match) return Number(match[1]) * 12;
  match = token.match(/^(\d+(?:\.\d+)?)Y$/);
  if (match) return Number(match[1]) * 12;
  match = token.match(/^EU-(\d+(?:\.\d+)?)-UK-/);
  if (match) return 1000 + Number(match[1]);
  if (token === "ONE") return 5000;
  return Number.POSITIVE_INFINITY;
}

function optionValues(variant: any) {
  const raw = variant?.raw && typeof variant.raw === "string"
    ? (() => {
        try { return JSON.parse(variant.raw); } catch { return {}; }
      })()
    : (variant?.raw || {});
  return raw?.optionValues && typeof raw.optionValues === "object" ? raw.optionValues : {};
}

function variantSize(variant: any) {
  const values = optionValues(variant);
  return clean(
    variant?.size ||
      values.Size ||
      values.size ||
      values["Age/Size"] ||
      values.Age ||
      "",
  );
}

function variantColor(variant: any) {
  const values = optionValues(variant);
  return clean(variant?.color || values.Color || values.Colour || values.color || values.colour || "");
}

function normalizedMatchText(value: unknown) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function matchFreshVariant(dbVariant: any, freshVariants: any[]) {
  const sourceVariantId = clean(dbVariant?.sourceVariantId);
  if (sourceVariantId) {
    const exactId = freshVariants.find((variant) => clean(variant?.sourceVariantId) === sourceVariantId);
    if (exactId) return exactId;
  }

  const dbSku = clean(dbVariant?.sku);
  if (dbSku) {
    const exactSku = freshVariants.find((variant) => clean(variant?.sku) === dbSku);
    if (exactSku) return exactSku;
  }

  const dbSize = normalizedMatchText(variantSize(dbVariant));
  const dbColor = normalizedMatchText(variantColor(dbVariant));
  const optionMatch = freshVariants.find((variant) => {
    const size = normalizedMatchText(variantSize(variant));
    const color = normalizedMatchText(variantColor(variant));
    return (!dbSize || dbSize === size) && (!dbColor || dbColor === color) && (dbSize || dbColor);
  });
  if (optionMatch) return optionMatch;

  return freshVariants.length === 1 ? freshVariants[0] : null;
}

function positiveNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function quantityNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    return Math.max(0, Math.floor(Number(value)));
  }
  return null;
}

function findQuantity(value: any, depth = 0): number | null {
  if (!value || typeof value !== "object" || depth > 4) return null;
  for (const key of ["stockQuantity", "availableQuantity", "inventoryQuantity", "onlineStockAvailable", "quantity", "qty", "stock"]) {
    const quantity = quantityNumber(value[key]);
    if (quantity !== null) return quantity;
  }
  for (const key of ["inventoryInfo", "availability", "stockInfo", "raw", "product"]) {
    const quantity = findQuantity(value[key], depth + 1);
    if (quantity !== null) return quantity;
  }
  if (depth >= 2) return null;
  for (const child of Object.values(value)) {
    const quantity = findQuantity(child, depth + 1);
    if (quantity !== null) return quantity;
  }
  return null;
}

function inventoryQuantity(variant: any): number | null {
  if (variant?.available === false || variant?.stockStatus === "out_of_stock") return 0;
  const direct = quantityNumber(variant?.stockQuantity) ?? quantityNumber(variant?.quantity);
  if (direct !== null) return direct;
  const nested = findQuantity(variant?.raw);
  if (nested !== null) return nested;
  if (variant?.stockStatus === "low_stock") return 1;
  if (variant?.stockStatus === "in_stock") return DEFAULT_IN_STOCK_QUANTITY;
  return null;
}

function expectedSku(url: string, rawProductCode: string, sizeToken: string, multiplier: number) {
  return `DAB-${brandCode(url)}-${formatProductCode(rawProductCode)}-${sizeToken}-${numberToken(multiplier)}`.slice(0, 64);
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function writeAuthorized(req: Request) {
  const configured = clean(process.env.CATALOG_AUDIT_WRITE_TOKEN);
  const supplied = clean(req.header("x-catalog-audit-write-token"));
  return Boolean(configured && supplied && safeEqual(configured, supplied));
}

function runConfirmed(req: Request) {
  return clean(req.header("x-sheet1-reconcile-run")) === RUN_CONFIRMATION;
}

async function findMappedProduct(row: SheetRow, rawProductCode: string | null) {
  const orFilters: any[] = [
    { url: { equals: row.url, mode: "insensitive" } },
    { url: { equals: row.normalizedUrl, mode: "insensitive" } },
  ];
  if (rawProductCode) {
    orFilters.push(
      { productId: { contains: rawProductCode, mode: "insensitive" } },
      { variants: { some: { sku: { contains: rawProductCode, mode: "insensitive" } } } },
    );
  }

  const candidates = await prisma.sourceProduct.findMany({
    where: {
      shopifyProduct: { isNot: null },
      OR: orFilters,
    } as any,
    include: {
      shopifyProduct: true,
      variants: { include: { shopifyVariant: true } },
    },
    take: 30,
  });

  const exact = candidates.filter((candidate) => canonicalizeUrl(candidate.url) === row.normalizedUrl);
  if (exact.length === 1) return { product: exact[0], ambiguous: false };
  if (exact.length > 1) return { product: null, ambiguous: true };

  if (!rawProductCode) return { product: null, ambiguous: false };
  const normalizedCode = rawProductCode.toLowerCase();
  const codeMatches = candidates.filter((candidate) => {
    if (clean(candidate.productId).toLowerCase().includes(normalizedCode)) return true;
    return candidate.variants.some((variant) => clean(variant.sku).toLowerCase().includes(normalizedCode));
  });
  return codeMatches.length === 1
    ? { product: codeMatches[0], ambiguous: false }
    : { product: null, ambiguous: codeMatches.length > 1 };
}

async function shopifyReadback(client: any, productId: string) {
  const query = `
    query Sheet1ReconcileReadback($id: ID!) {
      product(id: $id) {
        id
        title
        status
        variants(first: 250) {
          nodes {
            id
            title
            price
            sku
            inventoryQuantity
            inventoryItem { id sku tracked }
            selectedOptions { name value }
          }
        }
      }
    }
  `;
  const data = await client.request(query, { id: productId });
  return data?.product || null;
}

function freshVariantPrice(fresh: NormalizedProduct, variant: any) {
  return positiveNumber(variant?.price) ?? positiveNumber(fresh.price);
}

async function updateDatabaseFromFresh(sourceProduct: any, fresh: NormalizedProduct, mapped: any[]) {
  await prisma.sourceProduct.update({
    where: { id: sourceProduct.id },
    data: {
      title: fresh.title || sourceProduct.title,
      description: fresh.description ?? sourceProduct.description,
      brand: fresh.brand ?? sourceProduct.brand,
      currency: fresh.currency || sourceProduct.currency,
      price: positiveNumber(fresh.price) ?? sourceProduct.price,
      raw: JSON.stringify(fresh.raw ?? fresh),
      lastScrapedAt: new Date(),
      syncStatus: "active",
    },
  });

  for (const entry of mapped) {
    if (!entry.freshVariant) continue;
    await prisma.sourceVariant.update({
      where: { id: entry.dbVariant.id },
      data: {
        sourceVariantId: clean(entry.freshVariant.sourceVariantId) || entry.dbVariant.sourceVariantId,
        sku: clean(entry.freshVariant.sku) || entry.dbVariant.sku,
        color: clean(entry.freshVariant.color) || entry.dbVariant.color,
        size: clean(entry.freshVariant.size) || entry.dbVariant.size,
        price: positiveNumber(entry.freshVariant.price) ?? entry.dbVariant.price,
        currency: clean(entry.freshVariant.currency) || entry.dbVariant.currency,
        available: entry.freshVariant.available !== false,
        stockStatus: clean(entry.freshVariant.stockStatus) || entry.dbVariant.stockStatus,
        imageUrl: clean(entry.freshVariant.imageUrl) || entry.dbVariant.imageUrl,
        raw: JSON.stringify(entry.freshVariant.raw ?? entry.freshVariant),
      },
    });
  }
}

async function googleAccessToken() {
  const direct = clean(process.env.GOOGLE_SHEETS_ACCESS_TOKEN);
  if (direct) return direct;
  if (googleTokenCache && googleTokenCache.expiresAt > Date.now() + 60_000) return googleTokenCache.token;

  const email = clean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
  const encodedKey = clean(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY_BASE64);
  const privateKey = encodedKey
    ? Buffer.from(encodedKey, "base64").toString("utf8")
    : String(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!email || !privateKey) throw new Error("Google Sheets service-account credentials are missing");

  const now = Math.floor(Date.now() / 1000);
  const encode = (value: string | Buffer) => (Buffer.isBuffer(value) ? value : Buffer.from(value))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const header = encode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = encode(JSON.stringify({
    iss: email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claim}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${encode(signer.sign(privateKey))}`;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const response = await axios.post("https://oauth2.googleapis.com/token", body, {
    timeout: 20000,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const token = clean(response.data?.access_token);
  if (!token) throw new Error("Google did not return an access token");
  googleTokenCache = {
    token,
    expiresAt: Date.now() + Number(response.data?.expires_in || 3600) * 1000,
  };
  return token;
}

async function writeSkuToSheet(results: ReconcileResult[]) {
  const writable = results.filter((result) => result.status === "verified" && result.expectedSku && result.rows.length);
  if (!writable.length) return { cellsWritten: 0, batches: 0 };
  const token = await googleAccessToken();
  const requests: any[] = [];
  for (const result of writable) {
    for (const rowNumber of result.rows) {
      requests.push({
        updateCells: {
          range: {
            sheetId: SHEET_ID,
            startRowIndex: rowNumber - 1,
            endRowIndex: rowNumber,
            startColumnIndex: 3,
            endColumnIndex: 4,
          },
          rows: [{ values: [{ userEnteredValue: { stringValue: result.expectedSku } }] }],
          fields: "userEnteredValue",
        },
      });
    }
  }

  let batches = 0;
  for (let index = 0; index < requests.length; index += 300) {
    await axios.post(
      `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`,
      { requests: requests.slice(index, index + 300) },
      {
        timeout: 30000,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
    );
    batches += 1;
  }
  return { cellsWritten: requests.length, batches };
}

async function reconcileUnit(client: any, unit: ReconcileUnit, dryRun: boolean): Promise<ReconcileResult> {
  const row = unit.primary;
  if (unit.conflict) {
    return {
      status: "conflict",
      rows: unit.rows.map((entry) => entry.rowNumber),
      url: row.normalizedUrl,
      multiplier: null,
      reason: `Same source URL has conflicting multipliers: ${unit.conflictMultipliers.join(", ")}`,
    };
  }

  const rawProductCode = extractRawProductCode(row.normalizedUrl);
  if (!rawProductCode) {
    return {
      status: "error",
      rows: unit.rows.map((entry) => entry.rowNumber),
      url: row.normalizedUrl,
      multiplier: row.multiplier,
      reason: "Could not extract a stable supplier product code",
    };
  }

  const located = await findMappedProduct(row, rawProductCode);
  if (located.ambiguous) {
    return {
      status: "ambiguous",
      rows: unit.rows.map((entry) => entry.rowNumber),
      url: row.normalizedUrl,
      multiplier: row.multiplier,
      productCode: rawProductCode,
      reason: "More than one linked source product matched; no write was attempted",
    };
  }
  if (!located.product?.shopifyProduct?.shopifyId) {
    return {
      status: "missing",
      rows: unit.rows.map((entry) => entry.rowNumber),
      url: row.normalizedUrl,
      multiplier: row.multiplier,
      productCode: rawProductCode,
      reason: "No existing linked Shopify product was found; product creation is disabled",
    };
  }

  const sourceProduct = located.product;
  const productId = sourceProduct.shopifyProduct.shopifyId;
  const fresh = await scraperService.scrape(row.url);
  const freshVariants = Array.isArray(fresh.variants) ? fresh.variants : [];
  if (!freshVariants.length) throw new Error("Fresh source scrape returned no variants");

  const before = await shopifyReadback(client, productId);
  if (!before?.variants?.nodes?.length) throw new Error("Linked Shopify product has no readable variants");
  const beforeById = new Map(before.variants.nodes.map((variant: any) => [variant.id, variant]));

  const mapped = sourceProduct.variants
    .filter((dbVariant: any) => dbVariant.shopifyVariant?.shopifyId)
    .map((dbVariant: any) => {
      const shopifyVariantId = dbVariant.shopifyVariant.shopifyId;
      const current = beforeById.get(shopifyVariantId);
      const freshVariant = matchFreshVariant(dbVariant, freshVariants);
      const rawSize = variantSize(freshVariant) || variantSize(dbVariant) || clean(current?.title) || clean(before.title);
      const sizeToken = normalizeSizeToken(rawSize) || normalizeSizeToken(before.title);
      return { dbVariant, current, freshVariant, sizeToken };
    })
    .filter((entry: any) => entry.current && entry.freshVariant);

  if (!mapped.length) throw new Error("No existing linked variant could be matched to the fresh source data");

  const canonical = [...mapped]
    .filter((entry) => entry.sizeToken)
    .sort((left, right) => sizeRank(left.sizeToken) - sizeRank(right.sizeToken))[0];
  if (!canonical?.sizeToken) throw new Error("Could not determine the canonical first/smallest size safely");

  const sku = expectedSku(row.normalizedUrl, rawProductCode, canonical.sizeToken, row.multiplier);
  const variantUpdates: any[] = [];
  const expectedById = new Map<string, { price?: number; sku?: string; inventory?: number | null }>();

  for (const entry of mapped) {
    const sourcePrice = freshVariantPrice(fresh, entry.freshVariant);
    const targetPrice = sourcePrice ? Number((sourcePrice * row.multiplier).toFixed(2)) : undefined;
    const update: any = { id: entry.current.id };
    if (targetPrice) update.price = targetPrice.toFixed(2);
    if (entry.current.id === canonical.current.id) update.inventoryItem = { sku };
    variantUpdates.push(update);
    expectedById.set(entry.current.id, {
      price: targetPrice,
      sku: entry.current.id === canonical.current.id ? sku : undefined,
      inventory: inventoryQuantity(entry.freshVariant),
    });
  }

  if (!dryRun) {
    const response = await ShopifyService.updateVariantsBulk(client, productId, variantUpdates);
    const userErrors = response?.productVariantsBulkUpdate?.userErrors || [];
    if (userErrors.length) throw new Error(`Shopify variant update failed: ${userErrors[0].message}`);

    const location = await ShopifyService.getInventoryLocation(client);
    const quantities = mapped
      .map((entry) => {
        const quantity = expectedById.get(entry.current.id)?.inventory;
        const itemId = clean(entry.current?.inventoryItem?.id);
        const tracked = entry.current?.inventoryItem?.tracked === true;
        return quantity !== null && quantity !== undefined && itemId && tracked
          ? { inventoryItemId: itemId, quantity }
          : null;
      })
      .filter(Boolean) as Array<{ inventoryItemId: string; quantity: number }>;
    if (quantities.length) {
      const inventoryResponse = await ShopifyService.setInventoryQuantities(client, {
        locationId: location.id,
        quantities,
        referenceDocumentUri: `syncly://sheet1-reconcile/${RUN_CONFIRMATION}/${sourceProduct.id}`,
      });
      const inventoryErrors = inventoryResponse?.inventorySetQuantities?.userErrors || [];
      if (inventoryErrors.length) throw new Error(`Shopify inventory update failed: ${inventoryErrors[0].message}`);
    }
  }

  const after = dryRun ? before : await shopifyReadback(client, productId);
  const afterById = new Map((after?.variants?.nodes || []).map((variant: any) => [variant.id, variant]));
  let readbackVerified = true;
  let pricesChanged = 0;
  let inventoryChanged = 0;

  for (const entry of mapped) {
    const actual: any = afterById.get(entry.current.id);
    const expected = expectedById.get(entry.current.id)!;
    if (!actual) {
      readbackVerified = false;
      continue;
    }
    if (expected.price !== undefined) {
      const expectedPrice = dryRun ? Number(entry.current.price) : expected.price;
      if (Math.abs(Number(actual.price) - expectedPrice) >= 0.01) readbackVerified = false;
      if (Math.abs(Number(entry.current.price) - expected.price) >= 0.01) pricesChanged += 1;
    }
    if (entry.current.id === canonical.current.id) {
      const actualSku = clean(actual?.inventoryItem?.sku || actual?.sku);
      const expectedCanonicalSku = dryRun
        ? clean(entry.current?.inventoryItem?.sku || entry.current?.sku)
        : sku;
      if (actualSku !== expectedCanonicalSku) readbackVerified = false;
    }
    if (expected.inventory !== null && expected.inventory !== undefined && entry.current?.inventoryItem?.tracked === true) {
      const expectedInventory = dryRun ? Number(entry.current.inventoryQuantity ?? actual.inventoryQuantity) : expected.inventory;
      if (Number(actual.inventoryQuantity) !== expectedInventory) readbackVerified = false;
      if (Number(entry.current.inventoryQuantity) !== expected.inventory) inventoryChanged += 1;
    }
  }

  if (!dryRun && !readbackVerified) throw new Error("Shopify read-back did not match the expected price/SKU/inventory values");

  if (!dryRun) {
    await updateDatabaseFromFresh(sourceProduct, fresh, mapped);
    for (const entry of mapped) {
      const expected = expectedById.get(entry.current.id)!;
      await prisma.shopifyVariant.updateMany({
        where: { shopifyId: entry.current.id },
        data: {
          ...(expected.price !== undefined ? { price: expected.price } : {}),
          ...(entry.current.id === canonical.current.id ? { sku } : {}),
        },
      });
    }
  }

  return {
    status: "verified",
    rows: unit.rows.map((entry) => entry.rowNumber),
    url: row.normalizedUrl,
    multiplier: row.multiplier,
    productCode: rawProductCode,
    shopifyProductId: productId,
    shopifyTitle: clean(after?.title || before.title),
    expectedSku: sku,
    canonicalSize: canonical.sizeToken,
    variantsChecked: mapped.length,
    pricesChanged,
    inventoryChanged,
    skuChanged: clean(canonical.current?.inventoryItem?.sku || canonical.current?.sku) !== sku,
    readbackVerified,
  };
}

router.get("/sheet1-reconcile/config", (_req, res) => {
  res.json({
    mode: "existing_products_only",
    spreadsheetId: SPREADSHEET_ID,
    sheet: SHEET_NAME,
    gid: SHEET_GID,
    createProducts: false,
    rebuildProducts: false,
    skuFormat: "DAB-BRAND-PRODUCTCODE-CANONICALSIZE-MULTIPLIER",
    runConfirmation: RUN_CONFIRMATION,
  });
});

router.post("/sheet1-reconcile/run", async (req, res) => {
  const dryRun = req.body?.dryRun !== false;
  const writeSheet = req.body?.writeSheet === true && !dryRun;
  const onlyMissingSku = req.body?.onlyMissingSku !== false;
  const offset = Math.max(0, Math.floor(Number(req.body?.offset || 0)));
  const maxRowsRaw = Number(req.body?.maxRows || 25);
  const maxRows = Math.min(50, Math.max(1, Number.isFinite(maxRowsRaw) ? Math.floor(maxRowsRaw) : 25));
  const rowNumbers = Array.isArray(req.body?.rowNumbers)
    ? new Set(req.body.rowNumbers.map((value: any) => Number(value)).filter((value: number) => Number.isSafeInteger(value) && value > 0))
    : null;

  if (!dryRun && (!writeAuthorized(req) || !runConfirmed(req))) {
    return res.status(403).json({
      success: false,
      code: "SHEET1_RECONCILE_WRITE_NOT_AUTHORIZED",
      error: "Write mode requires the production catalog write token and the exact one-time run confirmation header",
    });
  }

  try {
    const rows = await loadSheetRows();
    const selectedRows = rowNumbers ? rows.filter((row) => rowNumbers.has(row.rowNumber)) : rows;
    const allUnits = buildUnits(selectedRows, rowNumbers ? false : onlyMissingSku);
    const units = rowNumbers ? allUnits : allUnits.slice(offset, offset + maxRows);
    const client = await ShopifyService.getClientFromDb(prisma);
    const results: ReconcileResult[] = [];

    for (const unit of units) {
      try {
        results.push(await reconcileUnit(client, unit, dryRun));
      } catch (error: any) {
        results.push({
          status: "error",
          rows: unit.rows.map((row) => row.rowNumber),
          url: unit.primary.normalizedUrl,
          multiplier: unit.conflict ? null : unit.primary.multiplier,
          productCode: extractRawProductCode(unit.primary.normalizedUrl),
          reason: clean(error?.message || error || "Unknown reconcile error").slice(0, 2000),
        });
      }
    }

    let sheetWrite = { cellsWritten: 0, batches: 0 };
    if (writeSheet) {
      sheetWrite = await writeSkuToSheet(results);
      for (const result of results) {
        if (result.status === "verified" && result.expectedSku) result.sheetWritten = true;
      }
    }

    const summary = {
      totalSheetRows: rows.length,
      eligibleRows: selectedRows.length,
      totalUnits: allUnits.length,
      unitsProcessed: units.length,
      rowsProcessed: results.reduce((sum, result) => sum + result.rows.length, 0),
      verified: results.filter((result) => result.status === "verified").length,
      missing: results.filter((result) => result.status === "missing").length,
      ambiguous: results.filter((result) => result.status === "ambiguous").length,
      conflicts: results.filter((result) => result.status === "conflict").length,
      errors: results.filter((result) => result.status === "error").length,
      dryRun,
      writeSheet,
      onlyMissingSku,
      offset,
      nextOffset: rowNumbers ? null : offset + units.length,
      hasMore: rowNumbers ? false : offset + units.length < allUnits.length,
      sheetWrite,
    };

    const batch = await prisma.importBatch.create({
      data: {
        status: summary.errors || summary.ambiguous || summary.conflicts ? "PARTIAL" : "COMPLETED",
        target: "sheet1_reconcile",
        productIds: results.map((result) => result.shopifyProductId || "").filter(Boolean).join(","),
        payloadJson: JSON.stringify({
          runConfirmation: RUN_CONFIRMATION,
          summary,
          results,
          completedAt: new Date().toISOString(),
        }),
      },
    });

    res.json({
      success: true,
      mode: "existing_products_only",
      createProducts: false,
      rebuildProducts: false,
      batchId: batch.id,
      summary,
      results,
    });
  } catch (error: any) {
    res.status(error?.statusCode || 500).json({
      success: false,
      mode: "existing_products_only",
      createProducts: false,
      rebuildProducts: false,
      error: clean(error?.message || error || "Sheet 1 reconcile failed"),
    });
  }
});

router.get("/sheet1-reconcile/runs", async (req, res) => {
  const take = Math.min(50, Math.max(1, Number(req.query.take || 10)));
  const runs = await prisma.importBatch.findMany({
    where: { target: "sheet1_reconcile" },
    orderBy: { createdAt: "desc" },
    take,
  });
  res.json(runs.map((run) => {
    let payload: any = {};
    try { payload = JSON.parse(run.payloadJson || "{}"); } catch {}
    return {
      id: run.id,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      summary: payload.summary || {},
    };
  }));
});

export default router;
