import { Router } from "express";
import axios from "axios";
import crypto from "crypto";
import { prisma } from "../db.js";
import { ScraperService } from "../services/scraper.js";
import { ShopifyService } from "../services/shopify.js";

const router = Router();
const scraperService = new ScraperService();

const DEFAULT_SPREADSHEET_URL =
  "https://docs.google.com/spreadsheets/d/1fCbPajWL3nukX0TdoN1m2X8LV3pfPsxSMLBb0yWug2w/edit";

const DEFAULT_SHEETS = [
  { name: "الورقة1", gid: 0, sheetId: 0, columnCount: 4 },
  { name: "الورقة2", gid: 531292068, sheetId: 531292068, columnCount: 3 },
  { name: "الورقة15", gid: 242585683, sheetId: 242585683, columnCount: 26 },
  { name: "الورقة10", gid: 1991302797, sheetId: 1991302797, columnCount: 4 },
  { name: "الورقة6", gid: 1951926772, sheetId: 1951926772, columnCount: 3 },
  { name: "الورقة7", gid: 93159589, sheetId: 93159589, columnCount: 3 },
  { name: "الورقة8", gid: 916372394, sheetId: 916372394, columnCount: 26 },
  { name: "الورقة20", gid: 202697256, sheetId: 202697256, columnCount: 25 },
  { name: "الورقة9", gid: 1264806944, sheetId: 1264806944, columnCount: 26 },
  { name: "الورقة11", gid: 106757984, sheetId: 106757984, columnCount: 26 },
] as const;

type SheetConfig = {
  name: string;
  gid: number;
  sheetId: number;
  columnCount: number;
};

type AuditRow = {
  sheet: SheetConfig;
  rowNumber: number;
  urlColumn: number;
  rawUrl: string;
  normalizedUrl: string;
  multiplier: number;
  collection: string;
};

type AuditStatus = "verified" | "missing" | "error" | "ambiguous";

type AuditResult = {
  status: AuditStatus;
  sheetName: string;
  sheetId: number;
  rowNumber: number;
  urlColumn: number;
  url: string;
  productCode: string | null;
  shopifyProductId?: string;
  shopifyTitle?: string;
  variantsChecked?: number;
  variantsUpdated?: number;
  priceUpdated?: boolean;
  skuUpdated?: boolean;
  reason?: string;
  skus?: string[];
};

type ShopifyProductMatch = {
  id: string;
  title: string;
  handle?: string;
  variants: any[];
  sourceProductId?: string;
};

const COLORS = {
  verified: { red: 0.7176471, green: 0.8980392, blue: 0.7176471 },
  missing: { red: 0.9568627, green: 0.8, blue: 0.8 },
  warning: { red: 0.9882353, green: 0.8980392, blue: 0.7490196 },
};

let googleTokenCache: { token: string; expiresAt: number } | null = null;

function cleanText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isHttpUrl(value: unknown) {
  return /^https?:\/\//i.test(cleanText(value));
}

function toPositiveNumber(value: unknown): number | null {
  const normalized = cleanText(value)
    .replace(/[^0-9.,-]/g, "")
    .replace(/,/g, ".");
  if (!normalized) return null;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (quoted && next === '"') {
        cell += '"';
        index += 1;
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
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell);
  if (row.some((value) => cleanText(value))) rows.push(row);
  return rows;
}

function spreadsheetIdFromUrl(value: string) {
  const match = cleanText(value).match(/\/spreadsheets\/d\/([^/]+)/i);
  if (!match?.[1]) throw new Error("Invalid Google Sheet URL");
  return match[1];
}

function canonicalizeSourceUrl(value: string) {
  const trimmed = String(value || "").replace(/[\t\r\n]+/g, "").trim();
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    parsed.search = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return trimmed;
  }
}

function extractProductCode(url: string): string | null {
  const cleanUrl = canonicalizeSourceUrl(url);
  const patterns = [
    /\/style\/[^/]+\/([^/?#]+)/i,
    /\/p\/([^/?#]+)/i,
    /-p-(\d+)\.html/i,
    /\/product\/([^/?#]+)/i,
  ];

  for (const pattern of patterns) {
    const match = cleanUrl.match(pattern);
    if (match?.[1]) return sanitizeSkuPart(match[1], 28);
  }

  try {
    const parsed = new URL(cleanUrl);
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    return last ? sanitizeSkuPart(last, 28) : null;
  } catch {
    return null;
  }
}

function brandCodeForUrl(url: string) {
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();

  if (host.includes("next.")) return "NXT";
  if (host.includes("hm.com")) return "HM";
  if (host.includes("maxfashion")) return "MAX";
  if (host.includes("centrepoint")) return "CPT";
  if (host.includes("shein")) return "SHN";
  if (host.includes("lefties")) return "LFT";
  if (host.includes("marksandspencer")) return "MNS";
  return "SRC";
}

function sanitizeSkuPart(value: unknown, maxLength = 18) {
  return cleanText(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
}

function normalizeOptionName(value: unknown) {
  const name = cleanText(value).toLowerCase();
  return name === "colour" ? "color" : name;
}

function optionMapFromSourceVariant(variant: any) {
  const values: Record<string, string> = {};
  const optionValues =
    variant?.optionValues && typeof variant.optionValues === "object"
      ? variant.optionValues
      : {};

  for (const [name, value] of Object.entries(optionValues)) {
    const normalizedName = normalizeOptionName(name);
    const normalizedValue = cleanText(value).toLowerCase();
    if (normalizedName && normalizedValue && normalizedValue !== "default") {
      values[normalizedName] = normalizedValue;
    }
  }

  if (variant?.color) values.color = cleanText(variant.color).toLowerCase();
  if (variant?.size) values.size = cleanText(variant.size).toLowerCase();
  return values;
}

function optionMapFromShopifyVariant(variant: any) {
  const values: Record<string, string> = {};
  for (const option of variant?.selectedOptions || []) {
    const name = normalizeOptionName(option?.name);
    const value = cleanText(option?.value).toLowerCase();
    if (name && value && value !== "default title") values[name] = value;
  }
  return values;
}

function optionKey(values: Record<string, string>) {
  return Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join("|");
}

function makeSku(url: string, productCode: string | null, variant: any) {
  const options = optionMapFromShopifyVariant(variant);
  const optionToken =
    Object.values(options)
      .map((value) => sanitizeSkuPart(value, 12))
      .filter(Boolean)
      .join("-") || "ONE";
  const hash = crypto
    .createHash("sha1")
    .update(`${canonicalizeSourceUrl(url)}|${optionKey(options) || cleanText(variant?.id)}`)
    .digest("hex")
    .slice(0, 6)
    .toUpperCase();
  const code = sanitizeSkuPart(productCode || hash, 24) || hash;
  return `DAB-${brandCodeForUrl(url)}-${code}-${optionToken}-${hash}`.slice(0, 64);
}

function moneyClose(left: unknown, right: unknown) {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.01;
}

function parseSheetRow(sheet: SheetConfig, cells: string[], rowNumber: number): AuditRow | null {
  const urlColumn = cells.findIndex((value) => isHttpUrl(value));
  if (urlColumn < 0) return null;

  const rawUrl = cleanText(cells[urlColumn]);
  const candidates = cells
    .map((value, index) => ({ index, number: toPositiveNumber(value), text: cleanText(value) }))
    .filter((entry) => entry.index !== urlColumn);
  const multiplierEntry = candidates.find(
    (entry) => entry.number !== null && entry.number >= 1 && entry.number <= 100,
  );
  if (!multiplierEntry?.number) return null;

  const collection =
    candidates.find(
      (entry) =>
        entry.index !== multiplierEntry.index &&
        entry.text &&
        entry.number === null &&
        !isHttpUrl(entry.text) &&
        !/^(price|collection)$/i.test(entry.text),
    )?.text || "";

  return {
    sheet,
    rowNumber,
    urlColumn,
    rawUrl,
    normalizedUrl: canonicalizeSourceUrl(rawUrl),
    multiplier: multiplierEntry.number,
    collection,
  };
}

async function loadRows(spreadsheetId: string, sheet: SheetConfig) {
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${sheet.gid}`;
  const response = await axios.get(url, {
    timeout: Number(process.env.GOOGLE_SHEET_FETCH_TIMEOUT_MS || 30000),
    responseType: "text",
  });
  return parseCsv(String(response.data || ""))
    .map((cells, index) => parseSheetRow(sheet, cells, index + 1))
    .filter((row): row is AuditRow => Boolean(row));
}

function uniqueSheetConfigs(value: unknown): SheetConfig[] {
  if (!Array.isArray(value) || value.length === 0) return [...DEFAULT_SHEETS];
  const output: SheetConfig[] = [];
  for (const entry of value) {
    const name = cleanText((entry as any)?.name);
    const gid = Number((entry as any)?.gid);
    const sheetId = Number((entry as any)?.sheetId ?? gid);
    const columnCount = Number((entry as any)?.columnCount || 26);
    if (!name || !Number.isFinite(gid) || !Number.isFinite(sheetId)) continue;
    output.push({
      name,
      gid,
      sheetId,
      columnCount: Number.isFinite(columnCount) ? Math.max(3, columnCount) : 26,
    });
  }
  return output.length ? output : [...DEFAULT_SHEETS];
}

async function findDbProduct(row: AuditRow, productCode: string | null) {
  const orFilters: any[] = [
    { url: { equals: row.rawUrl, mode: "insensitive" } },
    { url: { equals: row.normalizedUrl, mode: "insensitive" } },
  ];
  if (productCode) {
    orFilters.push(
      { productId: { contains: productCode, mode: "insensitive" } },
      { variants: { some: { sku: { contains: productCode, mode: "insensitive" } } } },
    );
  }

  const products = await prisma.sourceProduct.findMany({
    where: {
      shopifyProduct: { isNot: null },
      OR: orFilters,
    } as any,
    include: {
      shopifyProduct: true,
      variants: { include: { shopifyVariant: true } },
    },
    take: 20,
  });

  const exact = products.find(
    (product) => canonicalizeSourceUrl(product.url) === row.normalizedUrl,
  );
  const selected = exact || (products.length === 1 ? products[0] : null);
  if (!selected?.shopifyProduct?.shopifyId) return null;

  return {
    id: selected.shopifyProduct.shopifyId,
    title: selected.title,
    handle: selected.shopifyProduct.handle || undefined,
    variants: [],
    sourceProductId: selected.id,
  } satisfies ShopifyProductMatch;
}

async function findShopifyProduct(client: any, row: AuditRow, productCode: string | null) {
  const dbMatch = await findDbProduct(row, productCode);
  if (dbMatch) {
    dbMatch.variants = await ShopifyService.getProductInventoryVariants(client, dbMatch.id);
    return { match: dbMatch, ambiguous: false };
  }

  if (!productCode) return { match: null, ambiguous: false };
  const queryText = `sku:${productCode} OR title:${productCode} OR handle:${productCode.toLowerCase()}`;
  const query = `
    query CatalogAuditFind($query: String!) {
      products(first: 20, query: $query) {
        nodes {
          id
          title
          handle
          variants(first: 250) {
            nodes {
              id
              title
              price
              sku
              selectedOptions { name value }
              inventoryItem { id sku tracked }
            }
          }
        }
      }
    }
  `;
  const data = await client.request(query, { query: queryText });
  const products = data?.products?.nodes || [];
  if (products.length === 0) return { match: null, ambiguous: false };

  const normalizedCode = productCode.toLowerCase();
  const strong = products.filter((product: any) => {
    if (String(product.handle || "").toLowerCase().includes(normalizedCode)) return true;
    return (product.variants?.nodes || []).some((variant: any) =>
      String(variant?.inventoryItem?.sku || variant?.sku || "")
        .toLowerCase()
        .includes(normalizedCode),
    );
  });
  const candidates = strong.length ? strong : products;
  if (candidates.length !== 1) return { match: null, ambiguous: true };

  const product = candidates[0];
  return {
    match: {
      id: product.id,
      title: product.title,
      handle: product.handle,
      variants: product.variants?.nodes || [],
    } satisfies ShopifyProductMatch,
    ambiguous: false,
  };
}

function sourceVariantPrice(sourceProduct: any, shopifyVariant: any): number | null {
  const sourceVariants = Array.isArray(sourceProduct?.variants)
    ? sourceProduct.variants
    : [];
  const shopifyOptions = optionMapFromShopifyVariant(shopifyVariant);
  const shopifyKey = optionKey(shopifyOptions);

  const exact = sourceVariants.find(
    (variant: any) => optionKey(optionMapFromSourceVariant(variant)) === shopifyKey,
  );
  const exactPrice = toPositiveNumber(exact?.price);
  if (exactPrice) return exactPrice;

  const relaxed = sourceVariants.find((variant: any) => {
    const sourceOptions = optionMapFromSourceVariant(variant);
    return Object.entries(shopifyOptions).every(
      ([name, value]) => !sourceOptions[name] || sourceOptions[name] === value,
    );
  });
  const relaxedPrice = toPositiveNumber(relaxed?.price);
  if (relaxedPrice) return relaxedPrice;

  if (sourceVariants.length === 1) {
    const singlePrice = toPositiveNumber(sourceVariants[0]?.price);
    if (singlePrice) return singlePrice;
  }

  const distinctPrices = [
    ...new Set(
      sourceVariants
        .map((variant: any) => toPositiveNumber(variant?.price))
        .filter((value: number | null): value is number => value !== null),
    ),
  ];
  if (distinctPrices.length === 1) return distinctPrices[0];
  return toPositiveNumber(sourceProduct?.price);
}

async function syncDbVariant(shopifyVariantId: string, price: number, sku: string) {
  await prisma.shopifyVariant.updateMany({
    where: { shopifyId: shopifyVariantId },
    data: { price, sku },
  });
}

function readJsonObject(value: unknown): any {
  if (!value || typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function storedSourceProductIsUsable(product: any, expectedUrl: string) {
  const title = cleanText(product?.title);
  return (
    product &&
    canonicalizeSourceUrl(product.url) === canonicalizeSourceUrl(expectedUrl) &&
    title &&
    !/^(?:Excel Import Issue|Blocked Source Product)\b/i.test(title) &&
    !/client challenge|metadata/i.test(title) &&
    toPositiveNumber(product.price) !== null &&
    (product.images || []).length > 0 &&
    (product.variants || []).length > 0
  );
}

function storedSourceProductToAuditProduct(product: any, url: string) {
  const raw = readJsonObject(product.raw);
  const variants = (product.variants || []).map((variant: any) => {
    const variantRaw = readJsonObject(variant.raw);
    return {
      sourceVariantId: variant.sourceVariantId,
      sku: variant.sku,
      color: variant.color,
      size: variant.size,
      price: variant.price ?? product.price,
      currency: variant.currency || product.currency,
      optionValues: variantRaw.optionValues,
      available: variant.available ?? true,
      stockStatus: variant.stockStatus || "unknown",
      imageUrl: variant.imageUrl,
      raw: variantRaw.raw || variantRaw,
    };
  });

  return {
    source: {
      supplier: product.supplier?.name || "Unknown",
      url,
      productId: product.productId,
    },
    title: product.title,
    description: product.description || undefined,
    brand: product.brand || undefined,
    currency: product.currency,
    price: product.price,
    images: (product.images || []).map((image: any, index: number) => ({
      url: image.url,
      alt: image.alt || undefined,
      color: image.color || undefined,
      position: Number.isInteger(image.position) ? image.position : index,
    })),
    options: Array.isArray(raw.options) ? raw.options : [],
    variants,
    raw: {
      ...(raw.raw && typeof raw.raw === "object" ? raw.raw : {}),
      auditCachedSourceProductFallback: true,
      cachedFromSourceProductId: product.id,
      cachedAt: new Date().toISOString(),
    },
  };
}

async function scrapeSourceProductForAudit(row: AuditRow) {
  try {
    return await scraperService.scrape(row.rawUrl);
  } catch (error) {
    const cached = await prisma.sourceProduct.findFirst({
      where: {
        url: { equals: row.normalizedUrl, mode: "insensitive" },
      } as any,
      include: {
        supplier: true,
        images: { orderBy: { position: "asc" } },
        variants: { orderBy: { createdAt: "asc" } },
      },
    });
    if (storedSourceProductIsUsable(cached, row.normalizedUrl)) {
      return storedSourceProductToAuditProduct(cached, row.normalizedUrl);
    }
    throw error;
  }
}

async function auditOneRow(client: any, row: AuditRow, dryRun: boolean): Promise<AuditResult> {
  const productCode = extractProductCode(row.normalizedUrl);
  const located = await findShopifyProduct(client, row, productCode);
  if (located.ambiguous) {
    return {
      status: "ambiguous",
      sheetName: row.sheet.name,
      sheetId: row.sheet.sheetId,
      rowNumber: row.rowNumber,
      urlColumn: row.urlColumn,
      url: row.normalizedUrl,
      productCode,
      reason: "More than one Shopify product matched; no automatic change was made.",
    };
  }
  if (!located.match) {
    return {
      status: "missing",
      sheetName: row.sheet.name,
      sheetId: row.sheet.sheetId,
      rowNumber: row.rowNumber,
      urlColumn: row.urlColumn,
      url: row.normalizedUrl,
      productCode,
      reason: "Product is not currently found in Shopify. No product was created.",
    };
  }

  const product = located.match;
  if (!product.variants.length) {
    return {
      status: "error",
      sheetName: row.sheet.name,
      sheetId: row.sheet.sheetId,
      rowNumber: row.rowNumber,
      urlColumn: row.urlColumn,
      url: row.normalizedUrl,
      productCode,
      shopifyProductId: product.id,
      shopifyTitle: product.title,
      reason: "Shopify product has no readable variants.",
    };
  }

  const sourceProduct = await scrapeSourceProductForAudit(row);
  const updates = product.variants.map((variant: any) => {
    const sourcePrice = sourceVariantPrice(sourceProduct, variant);
    if (!sourcePrice) {
      throw new Error(`Could not match a source price for variant ${variant.title || variant.id}`);
    }
    const price = Number((sourcePrice * row.multiplier).toFixed(2));
    const sku = makeSku(row.normalizedUrl, productCode, variant);
    return {
      id: variant.id,
      price,
      sku,
      currentPrice: Number(variant.price),
      currentSku: cleanText(variant?.inventoryItem?.sku || variant?.sku),
    };
  });

  const priceUpdated = updates.some((entry) => !moneyClose(entry.currentPrice, entry.price));
  const skuUpdated = updates.some((entry) => entry.currentSku !== entry.sku);

  if (!dryRun && (priceUpdated || skuUpdated)) {
    const response = await ShopifyService.updateVariantsBulk(
      client,
      product.id,
      updates.map((entry) => ({
        id: entry.id,
        price: entry.price.toFixed(2),
        inventoryItem: { sku: entry.sku },
      })),
    );
    const userErrors = response?.productVariantsBulkUpdate?.userErrors || [];
    if (userErrors.length) {
      throw new Error(`Shopify update failed: ${userErrors[0].message}`);
    }
    await Promise.all(
      updates.map((entry) => syncDbVariant(entry.id, entry.price, entry.sku)),
    );
  }

  const readback = dryRun
    ? product.variants
    : await ShopifyService.getProductInventoryVariants(client, product.id);
  const readbackMap = new Map(readback.map((variant: any) => [variant.id, variant]));
  const verified = updates.every((entry) => {
    const variant = readbackMap.get(entry.id);
    const actualSku = cleanText(variant?.inventoryItem?.sku || variant?.sku);
    const expectedPrice = dryRun ? entry.currentPrice : entry.price;
    const expectedSku = dryRun ? entry.currentSku : entry.sku;
    return moneyClose(variant?.price, expectedPrice) && actualSku === expectedSku;
  });

  if (!verified) {
    return {
      status: "error",
      sheetName: row.sheet.name,
      sheetId: row.sheet.sheetId,
      rowNumber: row.rowNumber,
      urlColumn: row.urlColumn,
      url: row.normalizedUrl,
      productCode,
      shopifyProductId: product.id,
      shopifyTitle: product.title,
      variantsChecked: updates.length,
      reason: dryRun
        ? "Dry run found changes; the row was not marked green."
        : "Shopify read-back did not match the expected price/SKU.",
    };
  }

  return {
    status: "verified",
    sheetName: row.sheet.name,
    sheetId: row.sheet.sheetId,
    rowNumber: row.rowNumber,
    urlColumn: row.urlColumn,
    url: row.normalizedUrl,
    productCode,
    shopifyProductId: product.id,
    shopifyTitle: product.title,
    variantsChecked: updates.length,
    variantsUpdated: updates.filter(
      (entry) => !moneyClose(entry.currentPrice, entry.price) || entry.currentSku !== entry.sku,
    ).length,
    priceUpdated,
    skuUpdated,
    skus: updates.map((entry) => entry.sku),
  };
}

function base64Url(value: string | Buffer) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function serviceAccountPrivateKey() {
  const encoded = cleanText(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY_BASE64);
  if (encoded) return Buffer.from(encoded, "base64").toString("utf8");
  return String(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n");
}

async function googleAccessToken() {
  const direct = cleanText(process.env.GOOGLE_SHEETS_ACCESS_TOKEN);
  if (direct) return direct;
  if (googleTokenCache && googleTokenCache.expiresAt > Date.now() + 60_000) {
    return googleTokenCache.token;
  }

  const email = cleanText(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
  const privateKey = serviceAccountPrivateKey();
  if (!email || !privateKey) {
    throw new Error(
      "Google Sheets write credentials are missing. Configure GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, then share the sheet with that service account.",
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(
    JSON.stringify({
      iss: email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${claim}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${base64Url(signer.sign(privateKey))}`;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const response = await axios.post("https://oauth2.googleapis.com/token", body, {
    timeout: 20000,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const token = cleanText(response.data?.access_token);
  if (!token) throw new Error("Google did not return an access token");
  googleTokenCache = {
    token,
    expiresAt: Date.now() + Number(response.data?.expires_in || 3600) * 1000,
  };
  return token;
}

function sheetRequests(results: AuditResult[], sheetMap: Map<number, SheetConfig>) {
  const requests: any[] = [];
  for (const result of results) {
    const sheet = sheetMap.get(result.sheetId);
    if (!sheet) continue;
    const color =
      result.status === "verified"
        ? COLORS.verified
        : result.status === "missing"
          ? COLORS.missing
          : COLORS.warning;
    requests.push({
      repeatCell: {
        range: {
          sheetId: result.sheetId,
          startRowIndex: result.rowNumber - 1,
          endRowIndex: result.rowNumber,
          startColumnIndex: 0,
          endColumnIndex: sheet.columnCount,
        },
        cell: { userEnteredFormat: { backgroundColor: color } },
        fields: "userEnteredFormat.backgroundColor",
      },
    });

    const note = [
      `Catalog audit: ${result.status.toUpperCase()}`,
      result.shopifyTitle ? `Shopify: ${result.shopifyTitle}` : "",
      result.shopifyProductId ? `Product ID: ${result.shopifyProductId}` : "",
      result.skus?.length ? `SKU: ${result.skus.join(", ")}` : "",
      result.reason || "",
      `Checked: ${new Date().toISOString()}`,
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 5000);
    requests.push({
      updateCells: {
        range: {
          sheetId: result.sheetId,
          startRowIndex: result.rowNumber - 1,
          endRowIndex: result.rowNumber,
          startColumnIndex: result.urlColumn,
          endColumnIndex: result.urlColumn + 1,
        },
        rows: [{ values: [{ note }] }],
        fields: "note",
      },
    });
  }
  return requests;
}

async function writeResultsToSheet(
  spreadsheetId: string,
  results: AuditResult[],
  sheets: SheetConfig[],
) {
  if (!results.length) return { requestCount: 0, batches: 0 };
  const token = await googleAccessToken();
  const requests = sheetRequests(
    results,
    new Map(sheets.map((sheet) => [sheet.sheetId, sheet])),
  );
  const chunkSize = 400;
  let batches = 0;
  for (let index = 0; index < requests.length; index += chunkSize) {
    await axios.post(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
      { requests: requests.slice(index, index + chunkSize) },
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
  return { requestCount: requests.length, batches };
}

function dedupeRows(rows: AuditRow[]) {
  const grouped = new Map<string, AuditRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.normalizedUrl) || [];
    list.push(row);
    grouped.set(row.normalizedUrl, list);
  }

  return [...grouped.values()].map((group) => {
    const bestMultiplier = Math.min(...group.map((row) => row.multiplier));
    return {
      primary: { ...group[0], multiplier: bestMultiplier },
      allRows: group,
    };
  });
}

router.get("/catalog-audit/config", (_req, res) => {
  res.json({
    mode: "existing_products_only",
    createProducts: false,
    spreadsheetUrl: process.env.CATALOG_AUDIT_SHEET_URL || DEFAULT_SPREADSHEET_URL,
    sheets: DEFAULT_SHEETS,
    colors: {
      green: "existing and verified after price/SKU read-back",
      red: "not found in Shopify; no product created",
      orange: "blocked, ambiguous, or verification error",
    },
    skuFormat: "DAB-BRAND-PRODUCTCODE-OPTIONS-HASH",
  });
});

router.post("/catalog-audit/run", async (req, res) => {
  const spreadsheetUrl =
    cleanText(req.body?.spreadsheetUrl) ||
    cleanText(process.env.CATALOG_AUDIT_SHEET_URL) ||
    DEFAULT_SPREADSHEET_URL;
  const sheets = uniqueSheetConfigs(req.body?.sheets);
  const dryRun = req.body?.dryRun === true;
  const writeSheet = req.body?.writeSheet !== false && !dryRun;
  const offset = Math.max(0, Number(req.body?.offset || 0));
  const maxRowsRaw = Number(req.body?.maxRows || 0);
  const maxRows = Number.isFinite(maxRowsRaw) && maxRowsRaw > 0
    ? Math.floor(maxRowsRaw)
    : 0;

  try {
    const spreadsheetId = spreadsheetIdFromUrl(spreadsheetUrl);
    const client = await ShopifyService.getClientFromDb(prisma);
    const loaded = await Promise.all(
      sheets.map((sheet) => loadRows(spreadsheetId, sheet)),
    );
    const allRows = loaded.flat();
    const grouped = dedupeRows(allRows).slice(
      offset,
      maxRows ? offset + maxRows : undefined,
    );
    const results: AuditResult[] = [];

    for (const group of grouped) {
      let primaryResult: AuditResult;
      try {
        primaryResult = await auditOneRow(client, group.primary, dryRun);
      } catch (error: any) {
        primaryResult = {
          status: "error",
          sheetName: group.primary.sheet.name,
          sheetId: group.primary.sheet.sheetId,
          rowNumber: group.primary.rowNumber,
          urlColumn: group.primary.urlColumn,
          url: group.primary.normalizedUrl,
          productCode: extractProductCode(group.primary.normalizedUrl),
          reason: error?.message || "Catalog audit failed",
        };
      }

      for (const row of group.allRows) {
        results.push({
          ...primaryResult,
          sheetName: row.sheet.name,
          sheetId: row.sheet.sheetId,
          rowNumber: row.rowNumber,
          urlColumn: row.urlColumn,
          url: row.normalizedUrl,
        });
      }
    }

    const sheetWrite = writeSheet
      ? await writeResultsToSheet(spreadsheetId, results, sheets)
      : { requestCount: 0, batches: 0 };
    const summary = {
      totalRowsLoaded: allRows.length,
      uniqueProductsLoaded: dedupeRows(allRows).length,
      uniqueProductsProcessed: grouped.length,
      rowsMarked: results.length,
      verified: results.filter((entry) => entry.status === "verified").length,
      missing: results.filter((entry) => entry.status === "missing").length,
      ambiguous: results.filter((entry) => entry.status === "ambiguous").length,
      errors: results.filter((entry) => entry.status === "error").length,
      dryRun,
      writeSheet,
      nextOffset: offset + grouped.length,
      hasMore: offset + grouped.length < dedupeRows(allRows).length,
      sheetWrite,
    };

    const batch = await prisma.importBatch.create({
      data: {
        status:
          summary.errors > 0 || summary.ambiguous > 0 ? "PARTIAL" : "COMPLETED",
        target: "catalog_audit",
        productIds: results
          .map((entry) => entry.shopifyProductId || "")
          .filter(Boolean)
          .join(","),
        payloadJson: JSON.stringify({
          mode: "existing_products_only",
          spreadsheetUrl,
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
      batchId: batch.id,
      summary,
      results,
    });
  } catch (error: any) {
    res.status(error?.statusCode || 500).json({
      success: false,
      mode: "existing_products_only",
      createProducts: false,
      error: error?.message || "Catalog audit failed",
    });
  }
});

router.get("/catalog-audit/runs", async (req, res) => {
  const take = Math.min(50, Math.max(1, Number(req.query.take || 10)));
  const runs = await prisma.importBatch.findMany({
    where: { target: "catalog_audit" },
    orderBy: { createdAt: "desc" },
    take,
  });
  res.json(
    runs.map((run) => {
      let payload: any = {};
      try {
        payload = JSON.parse(run.payloadJson || "{}");
      } catch {}
      return {
        id: run.id,
        status: run.status,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        summary: payload.summary || {},
      };
    }),
  );
});

export default router;
