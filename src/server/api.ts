import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { prisma } from "./db.js";
import {
  ScraperService,
  fetchHtmlViaManagedBypass,
  fetchHtmlViaManagedBypassRace,
  type NormalizedProduct,
  normalizeProductImageList,
} from "./services/scraper.js";
import { PricingEngine } from "./services/pricing.js";
import { QueueService } from "./services/queue.js";
import { encrypt, decrypt, isDecryptionError } from "./services/encryption.js";
import { ShopifyService } from "./services/shopify.js";
import { PersistentJsonCache } from "./services/persistentCache.js";
import { reconcileExistingShopifyProductForImport } from "./firstFiveSheetsReconcile.js";
import { applyDeterministicDabSkus } from "./services/dabSku.js";
import scraperRoutes from "./routes/scraper.routes.js";
import sourceCapabilityRoutes from "./routes/source-capability.routes.js";
import { CategoryDiscoveryService } from "./scraper/services/CategoryDiscoveryService.js";
import axios from "axios";
import crypto from "crypto";

const router = Router();
router.use(scraperRoutes);
router.use(sourceCapabilityRoutes);
const scraperService = new ScraperService();
const categoryDiscoveryService = new CategoryDiscoveryService();
const DEFAULT_SHOPIFY_SCOPES = [
  "read_products",
  "write_products",
  "read_inventory",
  "write_inventory",
  "read_files",
  "write_files",
  "read_publications",
  "write_publications",
];
const SHOPIFY_DOMAIN_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;
const analyzeProductCache = new Map<
  string,
  { expiresAt: number; product: NormalizedProduct }
>();
const analyzeProductPersistentCache = new PersistentJsonCache<NormalizedProduct>(
  process.env.SCRAPE_ANALYZE_CACHE_FILE ||
    ".syncly-cache/analyze-products.json",
  { maxEntries: 2500 },
);
const nextListingDiscoveryCache = new Map<
  string,
  {
    expiresAt: number;
    result: {
      pagesVisited: number;
      candidates: Array<{
        url: string;
        title: string;
        supplier: string;
        productId?: string;
      }>;
    };
  }
>();
type NextListingDiscoveryResult = {
  pagesVisited: number;
  candidates: Array<{
    url: string;
    title: string;
    supplier: string;
    productId?: string;
  }>;
};
const nextListingPersistentCache = new PersistentJsonCache<NextListingDiscoveryResult>(
  process.env.NEXT_LISTING_CACHE_FILE || ".syncly-cache/next-listings.json",
  { maxEntries: 500 },
);
const googleSheetProcessedRowsCache = new PersistentJsonCache<Record<string, number>>(
  process.env.GOOGLE_SHEET_PROCESSED_ROWS_CACHE_FILE ||
    ".syncly-cache/google-sheet-processed-rows.json",
  { maxEntries: 100 },
);
const configuredGoogleSheetAutoSyncInterval = Number(
  process.env.GOOGLE_SHEET_AUTO_SYNC_DEFAULT_INTERVAL_SECONDS || 1800,
);
const DEFAULT_GOOGLE_SHEET_AUTO_SYNC_INTERVAL_SECONDS = Number.isFinite(
  configuredGoogleSheetAutoSyncInterval,
)
  ? Math.max(20, Math.floor(configuredGoogleSheetAutoSyncInterval))
  : 1800;

type GoogleSheetAutoSyncState = {
  running: boolean;
  inProgress: boolean;
  currentRunStartedAt: string | null;
  sheetUrl: string | null;
  csvUrl: string | null;
  intervalSeconds: number;
  pricingRuleId: string | null;
  defaultCollections: string[];
  createManualReview: boolean;
  lastRunAt: string | null;
  lastResult: any;
  lastError: string | null;
  lastBatchId: string | null;
};

export type GoogleSheetRow = {
  rowNumber: number;
  url: string;
  price: number | null;
  priceMultiplier: number | null;
  collection: string;
  sku?: string;
};

export const APPROVED_CATALOG_SHEETS: Record<string, string> = {
  "0": "\u0627\u0644\u0648\u0631\u0642\u06291",
  "531292068": "\u0627\u0644\u0648\u0631\u0642\u06292",
  "242585683": "\u0627\u0644\u0648\u0631\u0642\u062915",
  "1991302797": "\u0627\u0644\u0648\u0631\u0642\u062910",
  "1951926772": "\u0627\u0644\u0648\u0631\u0642\u06296",
  "93159589": "\u0627\u0644\u0648\u0631\u0642\u06297",
  "916372394": "\u0627\u0644\u0648\u0631\u0642\u06298",
  "202697256": "\u0627\u0644\u0648\u0631\u0642\u062920",
};

let googleSheetAutoSyncTimer: ReturnType<typeof setInterval> | null = null;
const googleSheetAutoSyncState: GoogleSheetAutoSyncState = {
  running: false,
  inProgress: false,
  currentRunStartedAt: null,
  sheetUrl: null,
  csvUrl: null,
  intervalSeconds: DEFAULT_GOOGLE_SHEET_AUTO_SYNC_INTERVAL_SECONDS,
  pricingRuleId: null,
  defaultCollections: [],
  createManualReview: true,
  lastRunAt: null,
  lastResult: null,
  lastError: null,
  lastBatchId: null,
};

function envNumber(name: string, defaultValue: number): number {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return defaultValue;
  const value = Number(raw);
  return Number.isFinite(value) ? value : defaultValue;
}

function envFlag(name: string, defaultValue = false): boolean {
  const value = String(process.env[name] || "").trim();
  if (!value) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function normalizeAnalyzeCacheUrl(url: string): string {
  try {
    const parsed = new URL(String(url).trim());
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return String(url || "").trim();
  }
}

function getAnalyzeCacheMs(): number {
  const hours = Math.max(0, envNumber("SCRAPE_ANALYZE_CACHE_HOURS", 168));
  return hours * 60 * 60 * 1000;
}

function cloneProduct(product: NormalizedProduct): NormalizedProduct {
  return JSON.parse(JSON.stringify(product));
}

function isUsableAnalyzeProduct(product: NormalizedProduct | undefined) {
  if (!product) return false;
  const title = String(product.title || "").replace(/\s+/g, " ").trim();
  if (!title) return false;
  if (/^(?:Excel Import Issue|Blocked Source Product)\b/i.test(title)) {
    return false;
  }
  if (!Number.isFinite(Number(product.price)) || Number(product.price) <= 0) {
    return false;
  }
  const supplier = String(product.source?.supplier || "").toLowerCase();
  const sourceUrl = String(product.source?.url || "").toLowerCase();
  const raw = product.raw && typeof product.raw === "object" ? product.raw : {};
  if (
    (supplier.includes("centrepoint") ||
      sourceUrl.includes("centrepointstores.com")) &&
    (raw.readerFallback || raw.pastedSnapshotFallback) &&
    (String(product.currency || "").toUpperCase() !== "AED" ||
      Number(product.price) <= 1)
  ) {
    return false;
  }
  if (
    (supplier.includes("h&m") || sourceUrl.includes("ae.hm.com")) &&
    sourceUrl.includes("ae.hm.com") &&
    (String(product.currency || "").toUpperCase() !== "AED" ||
      Number(product.price) < 10)
  ) {
    return false;
  }
  return true;
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

function getCachedAnalyzeProduct(url: string): NormalizedProduct | undefined {
  const cacheMs = getAnalyzeCacheMs();
  if (cacheMs <= 0) return undefined;

  const key = normalizeAnalyzeCacheUrl(url);
  const cached = analyzeProductCache.get(key);
  if (cached) {
    if (cached.expiresAt <= Date.now()) {
      analyzeProductCache.delete(key);
    } else if (!isUsableAnalyzeProduct(cached.product)) {
      analyzeProductCache.delete(key);
    } else {
      return cloneProduct(cached.product);
    }
  }

  if (!envFlag("SCRAPE_ANALYZE_PERSISTENT_CACHE", true)) return undefined;

  const persisted = analyzeProductPersistentCache.get(key);
  if (!persisted) return undefined;
  if (!isUsableAnalyzeProduct(persisted)) {
    analyzeProductPersistentCache.delete(key);
    return undefined;
  }

  analyzeProductCache.set(key, {
    expiresAt: Date.now() + cacheMs,
    product: cloneProduct(persisted),
  });

  return cloneProduct(persisted);
}

function setCachedAnalyzeProduct(url: string, product: NormalizedProduct) {
  const cacheMs = getAnalyzeCacheMs();
  if (cacheMs <= 0) return;
  if (!isUsableAnalyzeProduct(product)) return;
  const key = normalizeAnalyzeCacheUrl(url);
  analyzeProductCache.set(key, {
    expiresAt: Date.now() + cacheMs,
    product: cloneProduct(product),
  });
  if (envFlag("SCRAPE_ANALYZE_PERSISTENT_CACHE", true)) {
    analyzeProductPersistentCache.set(key, product, cacheMs);
  }
}

const analyzePrewarmJobs = new Map<string, Promise<void>>();

type LocalBridgeTaskStatus = "pending" | "claimed" | "completed" | "failed";

type LocalBridgeTask = {
  id: string;
  url: string;
  key: string;
  status: LocalBridgeTaskStatus;
  createdAt: number;
  updatedAt: number;
  claimedAt?: number;
  completedAt?: number;
  lastError?: string;
};

const localBridgeTasks = new Map<string, LocalBridgeTask>();
const localBridgeTaskByKey = new Map<string, string>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSyncJobResult(result: string | null | undefined): Record<string, any> {
  if (!result) return {};
  try {
    const parsed = JSON.parse(result);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return { raw: String(result) };
  }
}

type SyncJobStatus = "pending" | "running" | "completed" | "failed";

async function waitForSyncJobCompletion(jobId: string) {
  const timeoutMs = Math.max(
    15000,
    envNumber("EXCEL_IMPORT_PUBLISH_TIMEOUT_MS", 10 * 60 * 1000),
  );
  const pollMs = Math.max(500, envNumber("EXCEL_IMPORT_PUBLISH_POLL_MS", 1500));
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const job = await prisma.syncJob.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        type: true,
        status: true,
        result: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
      },
    });

    if (!job) {
      throw new Error(`Sync job not found (${jobId})`);
    }

    const status = String(job.status || "").toLowerCase() as SyncJobStatus;
    if (status === "completed" || status === "failed") {
      return {
        ...job,
        status,
        parsedResult: parseSyncJobResult(job.result),
      };
    }

    await sleep(pollMs);
  }

  throw new Error(
    `Timed out while waiting for Shopify publish job ${jobId} to complete`,
  );
}

function verifyPublishJobResult(jobResult: Record<string, any>) {
  const errorText = String(jobResult?.error || jobResult?.raw || "").trim();
  if (errorText) {
    throw new Error(errorText);
  }

  if (!jobResult?.shopifyId) {
    throw new Error("Shopify publish finished without a Shopify product id");
  }

  if (jobResult?.shopifyVerified === false) {
    throw new Error("Shopify product verification failed after publish");
  }

  const variantsExpected = Number(jobResult?.variantsExpected);
  const variantsCreated = Number(jobResult?.variantsCreated);
  const variantsLinked = Number(jobResult?.variantsLinked);

  if (
    Number.isFinite(variantsExpected) &&
    variantsExpected > 0 &&
    Number.isFinite(variantsCreated) &&
    variantsCreated < variantsExpected
  ) {
    throw new Error(
      `Variant creation mismatch (${variantsCreated}/${variantsExpected})`,
    );
  }

  if (
    Number.isFinite(variantsExpected) &&
    variantsExpected > 0 &&
    Number.isFinite(variantsLinked) &&
    variantsLinked < variantsExpected
  ) {
    throw new Error(
      `Variant linking mismatch (${variantsLinked}/${variantsExpected})`,
    );
  }

  if (jobResult?.variantsVerified === false) {
    throw new Error("Shopify variant verification failed");
  }

  if (jobResult?.variantSkusVerified === false) {
    throw new Error("Shopify variant SKU verification failed");
  }

  const variantImagesRequested = Number(jobResult?.variantImagesRequested);
  const variantImagesLinked = Number(jobResult?.variantImagesLinked);
  if (
    Number.isFinite(variantImagesRequested) &&
    variantImagesRequested > 0 &&
    Number.isFinite(variantImagesLinked) &&
    variantImagesLinked <= 0
  ) {
    throw new Error("Variant images were requested but none were linked");
  }
}

function shouldPrewarmAnalyzeUrl(url: string): boolean {
  // In strict local-only mode prewarm tends to loop on blocked sources (403),
  // so we disable it to avoid repeated background requests.
  if (envFlag("SCRAPER_LOCAL_ONLY_MODE", false)) return false;

  if (!envFlag("ANALYZE_PREWARM_ENABLED", true)) return false;
  if (!hasManagedBypassProviderConfigured()) return false;

  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      (host.includes("next.") && isNextProductUrl(url)) ||
      host.includes("maxfashion")
    );
  } catch {
    return false;
  }
}

function hasManagedBypassProviderConfigured(): boolean {
  const mode = String(process.env.SCRAPER_BYPASS_MODE || "never")
    .trim()
    .toLowerCase();
  if (mode === "never") return false;

  return [
    "SCRAPERAPI_KEY",
    "ZENROWS_API_KEY",
    "SCRAPINGBEE_API_KEY",
    "SCRAPINGANT_API_KEY",
    "SCRAPEDO_TOKEN",
  ].some((name) => String(process.env[name] || "").trim().length > 0);
}

function localBridgeEnabled(): boolean {
  return envFlag("LOCAL_BRIDGE_ENABLED", true);
}

function localBridgeRequireToken(): boolean {
  return envFlag("LOCAL_BRIDGE_REQUIRE_TOKEN", true);
}

function localBridgeToken(): string {
  return String(process.env.LOCAL_BRIDGE_TOKEN || "").trim();
}

function localBridgeIsOperational() {
  if (!localBridgeEnabled()) {
    return { enabled: false, reason: "LOCAL_BRIDGE_ENABLED is false" };
  }

  if (localBridgeRequireToken() && !localBridgeToken()) {
    return {
      enabled: false,
      reason: "LOCAL_BRIDGE_TOKEN is missing while LOCAL_BRIDGE_REQUIRE_TOKEN is true",
    };
  }

  return { enabled: true as const, reason: null };
}

function authorizeLocalBridgeRequest(req: Request, res: Response): boolean {
  if (!localBridgeRequireToken()) return true;

  const token = localBridgeToken();
  if (!token) {
    res.status(503).json({
      error:
        "Local bridge is not configured. Set LOCAL_BRIDGE_TOKEN or disable LOCAL_BRIDGE_REQUIRE_TOKEN.",
      code: "LOCAL_BRIDGE_NOT_CONFIGURED",
    });
    return false;
  }

  const provided = String(
    req.get("x-bridge-token") ||
      req.query.token ||
      (typeof req.body === "object" ? (req.body as any)?.token : "") ||
      "",
  ).trim();
  if (!provided || provided !== token) {
    res
      .status(401)
      .json({ error: "Invalid bridge token", code: "LOCAL_BRIDGE_UNAUTHORIZED" });
    return false;
  }

  return true;
}

function clearBridgeTask(task: LocalBridgeTask) {
  localBridgeTasks.delete(task.id);
  const existingId = localBridgeTaskByKey.get(task.key);
  if (existingId === task.id) {
    localBridgeTaskByKey.delete(task.key);
  }
}

function pruneLocalBridgeTasks() {
  const now = Date.now();
  const taskTtlMs = Math.max(1, envNumber("LOCAL_BRIDGE_TASK_TTL_MINUTES", 60)) * 60 * 1000;

  for (const task of localBridgeTasks.values()) {
    const ageMs = now - task.updatedAt;
    if (ageMs > taskTtlMs) {
      clearBridgeTask(task);
    }
  }
}

function getOrCreateLocalBridgeTask(url: string): LocalBridgeTask | null {
  const bridge = localBridgeIsOperational();
  if (!bridge.enabled) return null;

  pruneLocalBridgeTasks();
  const key = normalizeAnalyzeCacheUrl(url);
  const existingTaskId = localBridgeTaskByKey.get(key);
  if (existingTaskId) {
    const existingTask = localBridgeTasks.get(existingTaskId);
    if (existingTask) {
      if (existingTask.status === "pending" || existingTask.status === "claimed") {
        return existingTask;
      }
      clearBridgeTask(existingTask);
    }
  }

  const task: LocalBridgeTask = {
    id: crypto.randomUUID(),
    url: key,
    key,
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  localBridgeTasks.set(task.id, task);
  localBridgeTaskByKey.set(key, task.id);
  return task;
}

function claimLocalBridgeTask(): LocalBridgeTask | null {
  pruneLocalBridgeTasks();
  const now = Date.now();
  const reclaimMs = Math.max(1, envNumber("LOCAL_BRIDGE_RECLAIM_MINUTES", 5)) * 60 * 1000;

  const candidates = [...localBridgeTasks.values()]
    .filter((task) => {
      if (task.status === "pending") return true;
      if (task.status !== "claimed") return false;
      if (!task.claimedAt) return true;
      return now - task.claimedAt > reclaimMs;
    })
    .sort((a, b) => a.createdAt - b.createdAt);

  const task = candidates[0];
  if (!task) return null;

  task.status = "claimed";
  task.claimedAt = now;
  task.updatedAt = now;
  localBridgeTasks.set(task.id, task);
  return task;
}

function isNextHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "next.ae" ||
      host.endsWith(".next.ae") ||
      host === "nextdirect.com" ||
      host.endsWith(".nextdirect.com") ||
      host === "next.co.uk" ||
      host.endsWith(".next.co.uk") ||
      host === "next.us" ||
      host.endsWith(".next.us")
    );
  } catch {
    return /next\.(?:ae|us)|nextdirect\.com|next\.co\.uk/i.test(url);
  }
}

function expectedSupplierForUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (/(^|\.)next\./i.test(host) || /nextdirect\.com/i.test(host))
      return "Next";
    if (/maxfashion/i.test(host)) return "Max Fashion";
    if (/centrepointstores/i.test(host)) return "Centrepoint";
    if (/shein/i.test(host)) return "SHEIN";
    if (/marksandspencer/i.test(host)) return "Marks & Spencer";
    if (/(^|\.)hm\.com$/i.test(host)) return "H&M";
    if (/lefties/i.test(host)) return "Lefties";
    if (/gap\./i.test(host)) return "Gap";
    if (/zara\./i.test(host)) return "Zara";
    if (/mothercare/i.test(host)) return "Mothercare";
    if (/adidas\./i.test(host)) return "Adidas";
    if (/primark/i.test(host)) return "Primark";
  } catch {}

  return null;
}

function productSupplierMatchesUrl(url: string, product: NormalizedProduct | null | undefined): boolean {
  if (!product?.source?.supplier) return true;
  const expected = expectedSupplierForUrl(url);
  if (!expected) return true;
  return normalizeLabel(product.source.supplier) === normalizeLabel(expected);
}

function isNextProductUrl(url: string): boolean {
  return isNextHost(url) && /\/style\/[a-z0-9]+\/[a-z0-9]+/i.test(url);
}

function isNextListingUrl(url: string): boolean {
  if (!isNextHost(url) || isNextProductUrl(url)) return false;
  try {
    const path = new URL(url).pathname.toLowerCase();
    return /\/shop(?:\/|$)|\/search(?:\/|$)|\/baby(?:\/|$)|\/girls(?:\/|$)|\/boys(?:\/|$)|\/women(?:\/|$)|\/men(?:\/|$)/i.test(
      path,
    );
  } catch {
    return /\/(?:shop|search|baby|girls|boys|women|men)(?:\/|$)/i.test(url);
  }
}

function nextProductLabelFromUrl(url: string, index: number): string {
  const match = url.match(/\/style\/([a-z0-9]+)\/([a-z0-9]+)/i);
  if (!match) return `Next product ${index + 1}`;
  return `Next ${match[1].toUpperCase()} / ${match[2].toUpperCase()}`;
}

function getNextListingDiscoveryCache(url: string): NextListingDiscoveryResult | undefined {
  const minutes = Math.max(0, envNumber("NEXT_LISTING_CACHE_MINUTES", 60));
  if (minutes <= 0) return undefined;

  const key = normalizeAnalyzeCacheUrl(url);
  const cached = nextListingDiscoveryCache.get(key);
  if (cached) {
    if (cached.expiresAt <= Date.now()) {
      nextListingDiscoveryCache.delete(key);
    } else {
      return JSON.parse(JSON.stringify(cached.result));
    }
  }

  if (!envFlag("NEXT_LISTING_PERSISTENT_CACHE", true)) return undefined;

  const persisted = nextListingPersistentCache.get(key);
  if (!persisted) return undefined;

  nextListingDiscoveryCache.set(key, {
    expiresAt: Date.now() + minutes * 60 * 1000,
    result: JSON.parse(JSON.stringify(persisted)),
  });

  return JSON.parse(JSON.stringify(persisted));
}

function setNextListingDiscoveryCache(
  url: string,
  result: NextListingDiscoveryResult,
) {
  const minutes = Math.max(0, envNumber("NEXT_LISTING_CACHE_MINUTES", 60));
  if (minutes <= 0) return;
  const key = normalizeAnalyzeCacheUrl(url);
  nextListingDiscoveryCache.set(key, {
    expiresAt: Date.now() + minutes * 60 * 1000,
    result: JSON.parse(JSON.stringify(result)),
  });
  if (envFlag("NEXT_LISTING_PERSISTENT_CACHE", true)) {
    nextListingPersistentCache.set(key, result, minutes * 60 * 1000);
  }
}

function normalizeNextCandidateUrl(rawUrl: string, pageUrl: string) {
  const cleaned = String(rawUrl || "")
    .replace(/\\u002[fF]/g, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .trim();
  if (!cleaned) return undefined;

  try {
    const resolved = new URL(cleaned, pageUrl);
    if (!isNextProductUrl(resolved.toString())) return undefined;
    resolved.hash = "";
    resolved.search = "";
    return resolved.toString();
  } catch {
    return undefined;
  }
}

function extractNextProductUrlsFromHtml(html: string, pageUrl: string) {
  const decodedHtml = String(html || "")
    .replace(/\\u002[fF]/g, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
  const productUrls = new Set<string>();
  const patterns = [
    /href=["']([^"']*\/style\/[a-z0-9]+\/[a-z0-9]+[^"']*)["']/gi,
    /"(?:url|href|targetUrl|productUrl)"\s*:\s*"([^"]*\/style\/[a-z0-9]+\/[a-z0-9]+[^"]*)"/gi,
    /(https?:\/\/[^"'<>\\\s]+\/style\/[a-z0-9]+\/[a-z0-9]+[^"'<>\\\s]*)/gi,
    /(\/(?:[a-z]{2}\/)?style\/[a-z0-9]+\/[a-z0-9]+[^"'<>\\\s]*)/gi,
  ];

  for (const pattern of patterns) {
    for (const match of decodedHtml.matchAll(pattern)) {
      const normalized = normalizeNextCandidateUrl(match[1], pageUrl);
      if (normalized) productUrls.add(normalized);
    }
  }

  return [...productUrls];
}

async function discoverNextListingProducts(url: string) {
  const cached = getNextListingDiscoveryCache(url);
  if (cached) return cached;

  let pagesVisited = 1;
  let productUrls: string[] = [];

  if (envFlag("NEXT_LISTING_FAST_BYPASS", true)) {
    try {
      const listingBypassOptions = {
        deviceType: "none",
        jsRender: false,
        premium: envFlag("NEXT_LISTING_PREMIUM", false),
      } as const;
      const html = envFlag("NEXT_LISTING_BYPASS_RACE", true)
        ? await fetchHtmlViaManagedBypassRace(url, listingBypassOptions, {
            maxProviders: envNumber("NEXT_LISTING_RACE_MAX_PROVIDERS", 2),
            timeoutMs: envNumber("NEXT_LISTING_RACE_TIMEOUT_MS", 12000),
          })
        : await fetchHtmlViaManagedBypass(url, listingBypassOptions);
      productUrls = extractNextProductUrlsFromHtml(html, url);
    } catch (error) {
      console.warn(
        "Next listing managed discovery failed:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  if (productUrls.length === 0) {
    const result = await categoryDiscoveryService.discover({
      startUrl: url,
      maxPages: 1,
      maxProducts: 24,
      includePatterns: ["\\/style\\/[a-z0-9]+\\/[a-z0-9]+"],
      excludePatterns: [],
      mode: "auto",
    });
    pagesVisited = result.pagesVisited;
    productUrls = result.productUrls
      .map((productUrl) => normalizeNextCandidateUrl(productUrl, url))
      .filter((productUrl): productUrl is string => Boolean(productUrl));
  }

  const candidates = [...new Set(productUrls)].slice(0, 24).map((productUrl, index) => ({
    url: productUrl,
    title: nextProductLabelFromUrl(productUrl, index),
    supplier: "Next",
    productId:
      productUrl
        .match(/\/style\/([a-z0-9]+)\/([a-z0-9]+)/i)
        ?.slice(1)
        .join("-") || undefined,
  }));

  const discoveryResult = {
    pagesVisited,
    candidates,
  };

  setNextListingDiscoveryCache(url, discoveryResult);
  return discoveryResult;
}

function prewarmAnalyzeUrl(url: string) {
  const key = normalizeAnalyzeCacheUrl(url);
  if (getCachedAnalyzeProduct(url) || analyzePrewarmJobs.has(key)) return;
  if (!shouldPrewarmAnalyzeUrl(url)) return;

  let finishJob: () => void = () => {};
  const job = new Promise<void>((resolve) => {
    finishJob = resolve;
  });

  analyzePrewarmJobs.set(key, job);

  setTimeout(() => {
    scraperService
      .scrape(url)
      .then((product) => setCachedAnalyzeProduct(url, product))
      .catch((error) => {
        console.warn("Analyze prewarm failed:", error?.message || error);
      })
      .finally(() => {
        analyzePrewarmJobs.delete(key);
        finishJob();
      });
  }, 0);
}

async function waitForAnalyzePrewarm(url: string): Promise<NormalizedProduct | undefined> {
  const waitMs = Math.max(0, envNumber("ANALYZE_PREWARM_WAIT_MS", 2500));
  if (waitMs <= 0) return undefined;

  const key = normalizeAnalyzeCacheUrl(url);
  const job = analyzePrewarmJobs.get(key);
  if (!job) return undefined;

  await Promise.race([job, sleep(waitMs)]);
  return getCachedAnalyzeProduct(url);
}

function isSnapshotRequiredError(error: unknown): boolean {
  const typedError = error as {
    code?: string;
    retryWithSnapshot?: boolean;
    message?: string;
  };
  const message = String(typedError?.message || "");
  return (
    typedError?.code === "SOURCE_BLOCKED" ||
    typedError?.retryWithSnapshot === true ||
    /blocked automated server access|http 403|access denied|forbidden/i.test(
      message,
    )
  );
}

async function findStoredSourceProductByUrl(
  url: string,
  options: { maxAgeMs?: number } = {},
) {
  const normalizedUrl = normalizeAnalyzeCacheUrl(url);
  const where: any = {
    OR: [{ url }, ...(normalizedUrl !== url ? [{ url: normalizedUrl }] : [])],
  };

  if (options.maxAgeMs && options.maxAgeMs > 0) {
    where.lastScrapedAt = {
      gte: new Date(Date.now() - options.maxAgeMs),
    };
  }

  return prisma.sourceProduct.findFirst({
    where,
    include: {
      supplier: true,
      images: { orderBy: { position: "asc" } },
      variants: true,
    },
    orderBy: [{ lastScrapedAt: "desc" }, { updatedAt: "desc" }],
  });
}

function deriveOptionsFromStoredVariants(variants: any[]) {
  const colors = [
    ...new Set(
      variants
        .map((variant) => String(variant.color || "").trim())
        .filter(Boolean),
    ),
  ];
  const sizes = [
    ...new Set(
      variants
        .map((variant) => String(variant.size || "").trim())
        .filter(Boolean),
    ),
  ];
  const options = [];
  if (colors.length) options.push({ name: "Color", values: colors });
  if (sizes.length) options.push({ name: "Size", values: sizes });
  return options.length ? options : [{ name: "Default", values: ["Default"] }];
}

function sourceProductToNormalizedProduct(
  sourceProduct: any,
): NormalizedProduct {
  const sourceRaw = readJsonObject(sourceProduct.raw);
  const variants = (sourceProduct.variants || []).map((variant: any) => {
    const variantRaw = readJsonObject(variant.raw);
    return {
      sourceVariantId: variant.sourceVariantId,
      sku: variant.sku,
      color: variant.color,
      size: variant.size,
      price: variant.price ?? sourceProduct.price,
      currency: variant.currency || sourceProduct.currency,
      optionValues: variantRaw.optionValues,
      available: variant.available ?? true,
      stockStatus: variant.stockStatus || "unknown",
      imageUrl: variant.imageUrl,
      raw: variantRaw.raw || variantRaw,
    };
  });

  return {
    source: {
      supplier: sourceProduct.supplier?.name || "Unknown",
      url: sourceProduct.url,
      productId: sourceProduct.productId,
    },
    title: sourceProduct.title,
    description: sourceProduct.description || undefined,
    brand: sourceProduct.brand || undefined,
    currency: sourceProduct.currency,
    price: sourceProduct.price,
    images: (sourceProduct.images || []).map((image: any, index: number) => ({
      url: image.url,
      alt: image.alt || undefined,
      color: image.color || undefined,
      position: Number.isInteger(image.position) ? image.position : index,
    })),
    options:
      Array.isArray(sourceRaw.options) && sourceRaw.options.length
        ? sourceRaw.options
        : deriveOptionsFromStoredVariants(variants),
    variants,
    raw: {
      ...(sourceRaw.raw && typeof sourceRaw.raw === "object"
        ? sourceRaw.raw
        : {}),
      cachedFromSourceProductId: sourceProduct.id,
      cachedAt: new Date().toISOString(),
    },
  };
}

function wrapAsyncHandler(handler: any) {
  if (handler.length > 3 || handler.__synclyAsyncWrapped) return handler;

  const wrapped = function (req: Request, res: Response, next: NextFunction) {
    try {
      const result = handler(req, res, next);
      if (result && typeof result.then === "function") {
        result.catch(next);
      }
    } catch (error) {
      next(error);
    }
  };

  Object.defineProperty(wrapped, "__synclyAsyncWrapped", { value: true });
  return wrapped;
}

function wrapAsyncRouterHandlers(expressRouter: any) {
  for (const layer of expressRouter.stack || []) {
    if (layer.route?.stack) {
      for (const routeLayer of layer.route.stack) {
        routeLayer.handle = wrapAsyncHandler(routeLayer.handle);
      }
    } else if (layer.handle) {
      layer.handle = wrapAsyncHandler(layer.handle);
    }
  }
}

function getApiErrorStatus(error: any) {
  if (Number.isInteger(error?.statusCode)) return error.statusCode;
  if (Number.isInteger(error?.status)) return error.status;
  if (isDatabaseUnavailableError(error)) return 503;
  return 500;
}

function getApiErrorMessage(error: any) {
  if (isDatabaseUnavailableError(error)) {
    return "Database is currently unavailable or DATABASE_URL is invalid. Check DATABASE_URL format and database reachability.";
  }

  return error?.message || "Internal server error";
}

function getApiErrorCode(error: any) {
  if (isDatabaseUnavailableError(error)) return "DB_UNAVAILABLE";
  return error?.code || "API_ERROR";
}

function isDatabaseUnavailableError(error: any) {
  const message = String(error?.message || "");
  return (
    error?.code === "P1001" ||
    message.includes("Can't reach database server") ||
    message.includes("Error validating datasource `db`") ||
    message.includes("URL must start with `postgresql://` or `postgres://`") ||
    message.includes("Environment variable not found: DATABASE_URL")
  );
}

function isShopifyReconnectRequired(error: any) {
  return (
    error?.code === "SHOPIFY_RECONNECT_REQUIRED" || isDecryptionError(error)
  );
}

function firstQueryValue(value: any): string {
  return String(Array.isArray(value) ? value[0] : value || "").trim();
}

function normalizePublicUrl(value?: string | null) {
  if (!value) return "";
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/^(MY_|YOUR[_-])/i.test(trimmed)) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function getBackendUrl(req: any) {
  const configured = normalizePublicUrl(process.env.APP_URL);
  const forwardedProto = firstQueryValue(req.get("x-forwarded-proto")).split(
    ",",
  )[0];
  const forwardedHost = firstQueryValue(req.get("x-forwarded-host")).split(
    ",",
  )[0];
  const protocol = forwardedProto || req.protocol || "http";
  const host = forwardedHost || req.get("host");
  const requestUrl = `${protocol}://${host}`;

  if (!configured) return requestUrl;

  try {
    const configuredUrl = new URL(configured);
    const requestHost = new URL(requestUrl).hostname;
    const configuredIsLocal = [
      "localhost",
      "127.0.0.1",
      "::1",
      "0.0.0.0",
    ].includes(configuredUrl.hostname.toLowerCase());

    if (
      configuredIsLocal &&
      !["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(
        requestHost.toLowerCase(),
      )
    ) {
      return requestUrl;
    }
  } catch {
    return requestUrl;
  }

  return configured;
}

function getFrontendUrl(req?: any) {
  return normalizePublicUrl(
    process.env.FRONTEND_URL ||
      process.env.FRONTEND_UR ||
      process.env.VITE_FRONTEND_URL ||
      (req ? getBackendUrl(req) : "") ||
      "https://datauplode.vercel.app",
  );
}

function getShopifyRedirectUri(req: any) {
  return `${getBackendUrl(req)}/api/shopify/callback`;
}

function redirectToFrontend(
  req: any,
  res: any,
  params: Record<string, string>,
) {
  const redirectUrl = new URL("/settings", getFrontendUrl(req));
  for (const [key, value] of Object.entries(params)) {
    redirectUrl.searchParams.set(key, value);
  }
  res.redirect(redirectUrl.toString());
}

function normalizeShopDomain(value: any) {
  let domain = String(value || "")
    .trim()
    .toLowerCase();
  domain = domain.replace(/^https?:\/\//, "");
  domain = domain.replace(/\/admin.*$/, "");
  domain = domain.replace(/\/.*$/, "");
  return domain;
}

function assertShopDomain(value: any) {
  const domain = normalizeShopDomain(value);
  if (!SHOPIFY_DOMAIN_REGEX.test(domain)) {
    throw Object.assign(
      new Error("Shop domain must be a valid .myshopify.com hostname"),
      {
        statusCode: 400,
      },
    );
  }
  return domain;
}

function normalizeScopes(scopes: any) {
  const scopeList = Array.isArray(scopes)
    ? scopes
    : String(scopes || "").split(",");

  const cleanedScopes = scopeList
    .map((scope: string) => String(scope).trim())
    .filter(Boolean);

  return cleanedScopes.length ? cleanedScopes : DEFAULT_SHOPIFY_SCOPES;
}

function normalizeLabel(value: any) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function labelContainsLabel(haystack: any, needle: any) {
  const normalizedHaystack = normalizeLabel(haystack);
  const normalizedNeedle = normalizeLabel(needle);
  if (!normalizedHaystack || !normalizedNeedle) return false;
  if (normalizedHaystack === normalizedNeedle) return true;

  const escapedNeedle = normalizedNeedle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escapedNeedle}($|[^a-z0-9])`, "i").test(
    normalizedHaystack,
  );
}

function getVariantColor(variant: any) {
  const optionValues = variant?.optionValues || {};
  return String(
    variant?.color || optionValues.Color || optionValues.Colour || "",
  ).trim();
}

function hasMultipleVariantColors(variants: any[]) {
  const colors = new Set(
    variants.map(getVariantColor).map(normalizeLabel).filter(Boolean),
  );

  return colors.size > 1;
}

function parseRawObject(value: any) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
}

function isNextProductPayload(productData: any) {
  const supplier = normalizeLabel(productData?.source?.supplier);
  const url = normalizeLabel(productData?.source?.url);
  return (
    supplier === "next" ||
    url.includes("nextdirect.com") ||
    url.includes("next.co.uk") ||
    url.includes("next.ae") ||
    url.includes("next.us")
  );
}

function removeRelatedNextColorways(
  productData: any,
  variants: any[],
  images: any[],
) {
  if (!isNextProductPayload(productData)) return { variants, images };

  const currentVariants = variants.filter((variant: any) => {
    const raw = parseRawObject(variant?.raw);
    return !raw?.inferredFromColorwayCard && !raw?.colorwayUrl;
  });
  const safeVariants = currentVariants.length ? currentVariants : variants;
  const allowedColors = new Set(
    safeVariants.map(getVariantColor).map(normalizeLabel).filter(Boolean),
  );

  if (allowedColors.size === 0) return { variants: safeVariants, images };

  return {
    variants: safeVariants,
    images: images.filter((image: any) => {
      const imageColor = normalizeLabel(image?.color);
      if (!imageColor) return true;
      return allowedColors.has(imageColor);
    }),
  };
}

function resolveVariantImageUrl(
  variant: any,
  images: any[],
  variants: any[] = [],
) {
  const directImageUrl = String(variant?.imageUrl || "").trim();
  const selectedImageUrls = new Set(
    images.map((image: any) => String(image?.url || "").trim()).filter(Boolean),
  );

  if (
    directImageUrl &&
    (selectedImageUrls.has(directImageUrl) || images.length === 0)
  ) {
    return directImageUrl;
  }

  const color = normalizeLabel(getVariantColor(variant));
  if (color) {
    const matchedImage = images.find((image: any) => {
      const imageColor = normalizeLabel(image?.color);
      const imageAlt = normalizeLabel(image?.alt);
      return imageColor === color || labelContainsLabel(imageAlt, color);
    });

    if (matchedImage?.url) return String(matchedImage.url).trim();
  }

  if (images.length === 1 || !hasMultipleVariantColors(variants)) {
    return images.find((image: any) => image?.url)?.url;
  }

  return undefined;
}

function strictShopifyCatalogGuardEnabled() {
  return envFlag("STRICT_SHOPIFY_CATALOG_GUARD", true);
}

function normalizeCatalogUrlForDedupe(value: any) {
  try {
    const parsed = new URL(String(value || "").trim());
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString();
  } catch {
    return String(value || "").trim();
  }
}

function variantOptionText(value: any) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function getVariantOptionValuesForQuality(variant: any) {
  const optionValuesFromVariant = variant?.optionValues;
  if (optionValuesFromVariant && typeof optionValuesFromVariant === "object") {
    return optionValuesFromVariant;
  }
  const raw = parseRawObject(variant?.raw);
  if (raw?.optionValues && typeof raw.optionValues === "object") {
    return raw.optionValues;
  }
  return {};
}

function buildVariantQualitySignature(variant: any, index: number) {
  const optionValues = getVariantOptionValuesForQuality(variant);
  const optionEntries = Object.entries(optionValues)
    .map(([key, value]) => [normalizeLabel(key), normalizeLabel(value)])
    .filter(([key, value]) => Boolean(key && value))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${value}`);

  const color = normalizeLabel(variant?.color);
  const size = normalizeLabel(variant?.size);
  if (color) optionEntries.push(`color:${color}`);
  if (size) optionEntries.push(`size:${size}`);

  if (optionEntries.length > 0) return optionEntries.join("|");
  const sourceVariantId = normalizeLabel(variant?.sourceVariantId);
  if (sourceVariantId) return `source:${sourceVariantId}`;
  const sku = normalizeLabel(variant?.sku);
  if (sku) return `sku:${sku}`;
  return `index:${index}`;
}

function collectCatalogQualityIssues(
  productData: any,
  normalizedVariants: any[] = [],
  normalizedImages: any[] = [],
) {
  const issues: string[] = [];
  const sourceUrl = String(productData?.source?.url || "").trim();
  const title = String(productData?.title || "").replace(/\s+/g, " ").trim();
  const currency = String(productData?.currency || "").trim().toUpperCase();
  const sourceSupplier = String(productData?.source?.supplier || "").trim();
  const raw = productData?.raw && typeof productData.raw === "object"
    ? productData.raw
    : {};
  const variants = Array.isArray(normalizedVariants) ? normalizedVariants : [];
  const images = Array.isArray(normalizedImages) ? normalizedImages : [];
  const sourcePrice = Number(productData?.price);

  if (!sourceUrl || !isHttpUrl(sourceUrl)) {
    issues.push("missing/invalid product source URL");
  }
  if (!title || title.length < 3) {
    issues.push("missing/invalid product title");
  }
  if (!sourceSupplier) {
    issues.push("missing supplier name");
  }
  if (!productSupplierMatchesUrl(sourceUrl, productData)) {
    issues.push("supplier does not match source URL domain");
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    issues.push("missing/invalid currency code");
  }
  if (!PricingEngine.validatePrice(sourcePrice)) {
    issues.push("invalid product price");
  }
  if (
    sourceUrl.toLowerCase().includes("centrepointstores.com") &&
    (raw.readerFallback || raw.pastedSnapshotFallback) &&
    (currency !== "AED" || sourcePrice <= 1)
  ) {
    issues.push("untrusted Centrepoint reader fallback price");
  }
  if (
    sourceUrl.toLowerCase().includes("ae.hm.com") &&
    (currency !== "AED" || sourcePrice < 10)
  ) {
    issues.push("untrusted H&M UAE product price");
  }
  if (!variants.length) {
    issues.push("product has no variants");
  }

  const variantSignatures = new Set<string>();
  const duplicateVariantSignatures = new Set<string>();
  const duplicateSkus = new Set<string>();
  const duplicateSourceVariantIds = new Set<string>();
  const skuSeen = new Set<string>();
  const sourceVariantSeen = new Set<string>();

  for (const [index, variant] of variants.entries()) {
    const variantPrice = Number(variant?.price ?? sourcePrice);
    if (!PricingEngine.validatePrice(variantPrice)) {
      issues.push(`variant #${index + 1} has invalid price`);
    }

    const signature = buildVariantQualitySignature(variant, index);
    if (variantSignatures.has(signature)) {
      duplicateVariantSignatures.add(signature);
    } else {
      variantSignatures.add(signature);
    }

    const sku = normalizeLabel(variant?.sku);
    if (sku) {
      if (skuSeen.has(sku)) duplicateSkus.add(sku);
      skuSeen.add(sku);
    }

    const sourceVariantId = normalizeLabel(variant?.sourceVariantId);
    if (sourceVariantId) {
      if (sourceVariantSeen.has(sourceVariantId)) {
        duplicateSourceVariantIds.add(sourceVariantId);
      }
      sourceVariantSeen.add(sourceVariantId);
    }
  }

  if (duplicateVariantSignatures.size > 0) {
    issues.push("duplicate variant options detected");
  }
  if (duplicateSkus.size > 0) {
    issues.push("duplicate variant SKU detected");
  }
  if (duplicateSourceVariantIds.size > 0) {
    issues.push("duplicate source variant id detected");
  }

  const imageUrlSeen = new Set<string>();
  const duplicateImageUrls = new Set<string>();
  const validImageUrls: string[] = [];

  for (const image of images) {
    const url = String(image?.url || "").trim();
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) continue;
    if (imageUrlSeen.has(url)) {
      duplicateImageUrls.add(url);
    } else {
      imageUrlSeen.add(url);
      validImageUrls.push(url);
    }
  }

  if (duplicateImageUrls.size > 0) {
    issues.push("duplicate product images detected");
  }

  const hasVariantImage = variants.some((variant) =>
    /^https?:\/\//i.test(String(variant?.imageUrl || "").trim()),
  );
  if (validImageUrls.length === 0 && !hasVariantImage) {
    issues.push("product has no valid images");
  }

  return [...new Set(issues)];
}

function assertStrictCatalogQuality(
  productData: any,
  normalizedVariants: any[],
  normalizedImages: any[],
) {
  if (!strictShopifyCatalogGuardEnabled()) return;
  const issues = collectCatalogQualityIssues(
    productData,
    normalizedVariants,
    normalizedImages,
  );
  if (issues.length === 0) return;

  throw Object.assign(
    new Error(`Product quality check failed: ${issues.join("; ")}`),
    { statusCode: 422, code: "PRODUCT_QUALITY_FAILED", issues },
  );
}

function buildCatalogDuplicateKey(product: any) {
  const supplierKey = String(product?.supplierId || "").trim();
  const productId = normalizeLabel(product?.productId);
  if (supplierKey && productId) return `${supplierKey}|pid:${productId}`;

  const url = normalizeCatalogUrlForDedupe(product?.url);
  if (url) return `url:${url}`;

  const title = normalizeLabel(product?.title);
  const brand = normalizeLabel(product?.brand);
  const price = Number(product?.price);
  if (supplierKey && title) {
    const normalizedPrice = Number.isFinite(price) ? price.toFixed(2) : "na";
    return `${supplierKey}|title:${title}|brand:${brand}|price:${normalizedPrice}`;
  }

  return null;
}

function buildStoredProductQualityInput(product: any) {
  const variants = Array.isArray(product?.variants)
    ? product.variants.map((variant: any) => ({
        sourceVariantId: variant.sourceVariantId,
        sku: variant.sku,
        color: variant.color,
        size: variant.size,
        price: variant.price,
        currency: variant.currency,
        available: variant.available,
        stockStatus: variant.stockStatus,
        imageUrl: variant.imageUrl,
        raw: parseJsonObject(variant.raw) || {},
      }))
    : [];
  const images = Array.isArray(product?.images)
    ? product.images.map((image: any) => ({
        url: image.url,
        alt: image.alt,
        color: image.color,
        position: image.position,
      }))
    : [];

  return {
    source: {
      supplier: product?.supplier?.name || "",
      url: product?.url || "",
      productId: product?.productId || "",
    },
    title: product?.title || "",
    description: product?.description || "",
    brand: product?.brand || "",
    currency: product?.currency || "",
    price: product?.price,
    raw: parseJsonObject(product?.raw) || {},
    variants,
    images,
  };
}

function dedupeCatalogImages(images: any[]) {
  const seen = new Set<string>();
  const deduped: any[] = [];
  let removed = 0;

  for (const image of images) {
    const url = String(image?.url || "").trim();
    if (!url) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) {
      removed += 1;
      continue;
    }
    seen.add(key);
    deduped.push(image);
  }

  return { images: deduped, removed };
}

function dedupeCatalogVariants(variants: any[]) {
  const seenSignatures = new Set<string>();
  const seenSkus = new Set<string>();
  const seenSourceVariantIds = new Set<string>();
  const deduped: any[] = [];
  let removed = 0;

  for (const [index, variant] of variants.entries()) {
    const signature = buildVariantQualitySignature(variant, index);
    const sku = normalizeLabel(variant?.sku);
    const sourceVariantId = normalizeLabel(variant?.sourceVariantId);

    const duplicateBySignature = seenSignatures.has(signature);
    const duplicateBySku = Boolean(sku) && seenSkus.has(sku);
    const duplicateBySourceVariantId =
      Boolean(sourceVariantId) && seenSourceVariantIds.has(sourceVariantId);

    if (duplicateBySignature || duplicateBySku || duplicateBySourceVariantId) {
      removed += 1;
      continue;
    }

    seenSignatures.add(signature);
    if (sku) seenSkus.add(sku);
    if (sourceVariantId) seenSourceVariantIds.add(sourceVariantId);
    deduped.push(variant);
  }

  return { variants: deduped, removed };
}

async function hardDeleteCatalogProduct(params: {
  sourceProductId: string;
  reason: string;
  deleteFromShopify: boolean;
  shopifyClient?: any;
}) {
  const target = await prisma.sourceProduct.findUnique({
    where: { id: params.sourceProductId },
    select: {
      id: true,
      url: true,
      shopifyProduct: {
        select: { id: true, shopifyId: true },
      },
    },
  });
  if (!target) {
    return {
      deleted: false,
      sourceProductId: params.sourceProductId,
      reason: params.reason,
      skipped: "not_found",
    };
  }

  let shopifyDeleteError: string | null = null;
  if (
    params.deleteFromShopify &&
    params.shopifyClient &&
    target.shopifyProduct?.shopifyId
  ) {
    try {
      await ShopifyService.deleteProduct(
        params.shopifyClient,
        target.shopifyProduct.shopifyId,
      );
    } catch (error: any) {
      shopifyDeleteError = String(
        error?.message || "Unknown Shopify delete error",
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.shopifyVariant.deleteMany({
      where: {
        OR: [
          { sourceVariant: { sourceProductId: target.id } },
          ...(target.shopifyProduct?.id
            ? [{ shopifyProductId: target.shopifyProduct.id }]
            : []),
        ],
      },
    });
    await tx.shopifyProduct.deleteMany({ where: { sourceProductId: target.id } });
    await tx.manualReviewItem.deleteMany({ where: { sourceProductId: target.id } });
    await tx.auditLog.deleteMany({ where: { sourceProductId: target.id } });
    await tx.sourceImage.deleteMany({ where: { sourceProductId: target.id } });
    await tx.sourceVariant.deleteMany({ where: { sourceProductId: target.id } });
    await tx.sourceProduct.delete({ where: { id: target.id } });
  });

  return {
    deleted: true,
    sourceProductId: target.id,
    url: target.url,
    shopifyId: target.shopifyProduct?.shopifyId || null,
    reason: params.reason,
    shopifyDeleteError,
  };
}

async function cleanupCatalogIntegrity(params: {
  dryRun?: boolean;
  limit?: number;
} = {}) {
  const dryRun = params.dryRun === true;
  const limitRaw = Number(params.limit);
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.floor(limitRaw))
    : undefined;

  const products = await prisma.sourceProduct.findMany({
    include: {
      supplier: true,
      variants: true,
      images: true,
      shopifyProduct: {
        select: { id: true, shopifyId: true },
      },
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    ...(limit ? { take: limit } : {}),
  });

  const keepByKey = new Map<string, string>();
  const candidates: Array<{
    sourceProductId: string;
    reason: string;
    hasShopify: boolean;
    issues: string[];
    duplicateOf?: string;
  }> = [];

  for (const product of products) {
    const qualityInput = buildStoredProductQualityInput(product);
    const issues = collectCatalogQualityIssues(
      qualityInput,
      qualityInput.variants,
      qualityInput.images,
    );

    const duplicateKey = buildCatalogDuplicateKey(product);
    const duplicateOf = duplicateKey ? keepByKey.get(duplicateKey) : undefined;
    if (duplicateKey && !duplicateOf) {
      keepByKey.set(duplicateKey, product.id);
    }

    if (issues.length === 0 && !duplicateOf) continue;

    candidates.push({
      sourceProductId: product.id,
      reason:
        issues.length > 0
          ? `quality_failed:${issues.join("|")}`
          : `duplicate_of:${duplicateOf}`,
      hasShopify: Boolean(product.shopifyProduct?.shopifyId),
      issues,
      ...(duplicateOf ? { duplicateOf } : {}),
    });
  }

  if (dryRun) {
    return {
      scanned: products.length,
      candidates: candidates.length,
      deleted: 0,
      skipped: 0,
      dryRun: true,
      details: candidates,
    };
  }

  let shopifyClient: any = null;
  try {
    shopifyClient = await ShopifyService.getClientFromDb(prisma);
  } catch {
    shopifyClient = null;
  }

  const deleted: any[] = [];
  const skipped: any[] = [];

  for (const candidate of candidates) {
    if (candidate.hasShopify && !shopifyClient) {
      skipped.push({
        sourceProductId: candidate.sourceProductId,
        reason: candidate.reason,
        skipped: "shopify_client_unavailable",
      });
      continue;
    }

    const result = await hardDeleteCatalogProduct({
      sourceProductId: candidate.sourceProductId,
      reason: candidate.reason,
      deleteFromShopify: candidate.hasShopify,
      shopifyClient: shopifyClient || undefined,
    });

    if (result.deleted) {
      deleted.push(result);
    } else {
      skipped.push(result);
    }
  }

  return {
    scanned: products.length,
    candidates: candidates.length,
    deleted: deleted.length,
    skipped: skipped.length,
    dryRun: false,
    deletedItems: deleted,
    skippedItems: skipped,
  };
}

function asOptionalString(value: any) {
  const text = String(value || "").trim();
  return text || null;
}

function asOptionalNumber(value: any) {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function asNumber(value: any, fallback: number) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function normalizePricingRuleInput(body: any) {
  const name = String(body?.name || "").trim();
  const rounding = String(body?.rounding || "none").trim();
  const allowedRounding = ["none", ".99", ".00"];
  const multiplier = asNumber(body?.multiplier, 1);

  if (!name) {
    throw Object.assign(new Error("Pricing rule name is required"), {
      statusCode: 400,
    });
  }
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw Object.assign(new Error("Multiplier must be greater than zero"), {
      statusCode: 400,
    });
  }
  const minPrice = asOptionalNumber(body?.minPrice);
  const maxPrice = asOptionalNumber(body?.maxPrice);
  if (minPrice !== null && maxPrice !== null && maxPrice < minPrice) {
    throw Object.assign(
      new Error("Max price must be greater than or equal to min price"),
      { statusCode: 400 },
    );
  }

  return {
    name,
    supplierId: asOptionalString(body?.supplierId),
    currency: asOptionalString(body?.currency)?.toUpperCase() || null,
    multiplier,
    fixedMarkup: asNumber(body?.fixedMarkup, 0),
    percentageMarkup: asNumber(body?.percentageMarkup, 0),
    rounding: allowedRounding.includes(rounding) ? rounding : "none",
    minPrice,
    maxPrice,
    isDefault:
      body?.isDefault === true ||
      body?.isDefault === "true" ||
      body?.isDefault === "on",
  };
}

async function findBestPricingRuleForProduct(product: any) {
  try {
    const [rules, supplier] = await Promise.all([
      prisma.pricingRule.findMany(),
      product?.source?.supplier
        ? prisma.supplier
            .findUnique({ where: { name: product.source.supplier } })
            .catch(() => null)
        : Promise.resolve(null),
    ]);

    return PricingEngine.selectBestRule(rules, {
      supplierId: supplier?.id,
      currency: product?.currency,
    });
  } catch (error) {
    console.warn(
      "Pricing rules unavailable during import analysis:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

function isHttpUrl(value: any) {
  try {
    const parsed = new URL(String(value || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeManualReviewReason(value: any) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "Unknown import issue";
  return text.slice(0, 500);
}

function parseJsonObject(value: any): Record<string, any> | null {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, any>;
    }
    return null;
  } catch {
    return null;
  }
}

function extractExcelRowNumberFromReason(reason: any): number | null {
  const text = String(reason || "");
  const match = text.match(/\[Excel Row\s+(\d+)\]/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function extractExcelRowNumberFromRaw(rawValue: any): number | null {
  const raw = parseJsonObject(rawValue);
  if (!raw) return null;

  const direct = Number(raw.rowNumber);
  if (Number.isFinite(direct) && direct > 0) return Math.floor(direct);

  const importMeta = parseJsonObject(raw.import);
  const importRow = Number(importMeta?.excelRowNumber ?? importMeta?.rowNumber);
  if (Number.isFinite(importRow) && importRow > 0) return Math.floor(importRow);

  return null;
}

function normalizeExcelImportMeta(meta: Record<string, any> | null | undefined) {
  const row = Number(meta?.excelRowNumber ?? meta?.rowNumber);
  const sheetPriceMultiplier = toPositiveSheetNumber(meta?.sheetPriceMultiplier);
  const sheetPriceOverride = toPriceNumber(meta?.sheetPriceOverride);
  return {
    excelRowNumber:
      Number.isFinite(row) && row > 0 ? Math.floor(row) : undefined,
    sheetUrl: asOptionalString(meta?.sheetUrl),
    csvUrl: asOptionalString(meta?.csvUrl),
    mode: asOptionalString(meta?.mode),
    sheetCollection: asOptionalString(meta?.sheetCollection),
    sheetPriceMultiplier,
    sheetPriceOverride,
  };
}

async function upsertSourceProductExcelImportMeta(
  sourceProductUrl: string,
  importMeta: Record<string, any>,
) {
  const normalizedUrl = normalizeAnalyzeCacheUrl(sourceProductUrl);
  const product = await prisma.sourceProduct.findUnique({
    where: { url: normalizedUrl },
    select: { id: true, raw: true },
  });
  if (!product) return;

  const currentRaw = parseJsonObject(product.raw) || {};
  const currentImportMeta = parseJsonObject(currentRaw.import) || {};
  const normalizedMeta = normalizeExcelImportMeta(importMeta);
  const mergedImportMeta = {
    ...currentImportMeta,
    ...Object.fromEntries(
      Object.entries(normalizedMeta).filter(([, value]) => value !== undefined && value !== null),
    ),
  };
  const nextRaw = {
    ...currentRaw,
    import: mergedImportMeta,
  };

  await prisma.sourceProduct.update({
    where: { id: product.id },
    data: { raw: JSON.stringify(nextRaw) },
  });
}

function isAlreadyLinkedToShopifyMessage(value: any) {
  const text = String(value || "").toLowerCase();
  return (
    text.includes("already linked to shopify") &&
    text.includes("sync now")
  );
}

function parseImportBatchPayload(payloadJson: string | null | undefined) {
  if (!payloadJson) return {};
  try {
    const parsed = JSON.parse(payloadJson);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function getExcelRunStatus(summary: any) {
  const processedRows = Number(summary?.processedRows ?? summary?.total ?? 0);
  const published = Number(summary?.published || 0);
  const syncedExisting = Number(summary?.syncedExisting || 0);
  const skipped = Number(summary?.skipped || 0);
  const failed = Number(summary?.failed || 0);
  const processedNewRows = Number(summary?.processedNewRows ?? processedRows);

  if (processedRows === 0 || processedNewRows === 0) return "NO_CHANGES";
  if (published === 0 && failed === 0 && skipped > 0) return "NO_CHANGES";
  if ((published > 0 || syncedExisting > 0 || skipped > 0) && failed === 0) return "COMPLETED";
  if (published > 0 && failed > 0) return "PARTIAL";
  if (syncedExisting > 0 && failed > 0) return "PARTIAL";
  if (published === 0 && failed > 0) return "FAILED";
  return "UNKNOWN";
}

async function saveExcelImportRun(params: {
  mode: "sheet_link" | "auto_sync" | "file_upload";
  sheetUrl?: string | null;
  csvUrl?: string | null;
  summary: any;
  successful: any[];
  skipped?: any[];
  failed: any[];
  metadata?: Record<string, any>;
}) {
  const successful = Array.isArray(params.successful) ? params.successful : [];
  const skipped = Array.isArray(params.skipped) ? params.skipped : [];
  const failed = Array.isArray(params.failed) ? params.failed : [];
  const summary = params.summary || {};
  const status = getExcelRunStatus(summary);
  const payload = {
    mode: params.mode,
    sheetUrl: params.sheetUrl || null,
    csvUrl: params.csvUrl || null,
    summary,
    successful,
    skipped,
    failed,
    metadata: params.metadata || {},
    completedAt: new Date().toISOString(),
  };
  const productIds = successful
    .map((entry: any) => String(entry?.sourceProductId || "").trim())
    .filter(Boolean)
    .join(",");

  return prisma.importBatch.create({
    data: {
      status,
      target: "excel_sheet",
      productIds,
      payloadJson: JSON.stringify(payload),
    },
  });
}

async function ensureShopifyConnection() {
  const connection = await prisma.shopifyConnection.findFirst({
    where: { isConnected: true },
    select: { accessTokenEnc: true },
  });

  if (!connection?.accessTokenEnc) {
    throw Object.assign(
      new Error("Connect Shopify before publishing products."),
      { statusCode: 400 },
    );
  }
}

export function normalizeGoogleSheetUrl(sheetUrl: any) {
  const input = String(sheetUrl || "").trim();
  if (!input) {
    throw Object.assign(new Error("Google Sheet URL is required"), {
      statusCode: 400,
    });
  }

  if (/\/export\?format=csv/i.test(input) || /output=csv/i.test(input)) {
    return input;
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw Object.assign(new Error("Invalid Google Sheet URL"), {
      statusCode: 400,
    });
  }

  const fileMatch = parsed.pathname.match(/\/spreadsheets\/d\/([^/]+)/i);
  if (!fileMatch?.[1]) {
    throw Object.assign(new Error("Could not detect Google Sheet ID from URL"), {
      statusCode: 400,
    });
  }

  const fileId = fileMatch[1];
  const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  const gid = parsed.searchParams.get("gid") || hashParams.get("gid") || "0";
  return `https://docs.google.com/spreadsheets/d/${fileId}/export?format=csv&gid=${encodeURIComponent(gid)}`;
}

function parseCsvMatrix(csvText: string) {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = "";
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i += 1) {
    const char = csvText[i];
    const nextChar = csvText[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentCell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      currentRow.push(currentCell);
      currentCell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") i += 1;
      currentRow.push(currentCell);
      rows.push(currentRow);
      currentRow = [];
      currentCell = "";
      continue;
    }

    currentCell += char;
  }

  currentRow.push(currentCell);
  if (currentRow.some((cell) => String(cell || "").trim().length > 0)) {
    rows.push(currentRow);
  }

  return rows;
}

function detectSheetColumn(headers: string[], patterns: RegExp[]) {
  return (
    headers.find((header) => patterns.some((pattern) => pattern.test(header))) ||
    ""
  );
}

function toSheetHeaderKey(value: any) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function toPriceNumber(value: any) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/[^0-9.,-]/g, "").replace(/,/g, ".");
  const numberValue = Number(normalized);
  if (!Number.isFinite(numberValue) || numberValue <= 0) return null;
  return numberValue;
}

function toPositiveSheetNumber(value: any) {
  return toPriceNumber(value);
}

export function parseHeaderlessGoogleSheetRows(
  matrix: string[][],
  startIndex = 0,
): GoogleSheetRow[] {
  return matrix
    .slice(startIndex)
    .map((cells, offset) => {
      const normalized = cells.map((cell) => String(cell || "").trim());
      const urlIndex = normalized.findIndex((cell) => isHttpUrl(cell));
      if (urlIndex < 0) return null;

      let multiplierIndex = -1;
      let priceMultiplier: number | null = null;
      for (let index = urlIndex + 1; index < normalized.length; index += 1) {
        const parsed = toPositiveSheetNumber(normalized[index]);
        if (parsed !== null) {
          multiplierIndex = index;
          priceMultiplier = parsed;
          break;
        }
      }
      if (priceMultiplier === null) {
        for (let index = 0; index < urlIndex; index += 1) {
          const parsed = toPositiveSheetNumber(normalized[index]);
          if (parsed !== null) {
            multiplierIndex = index;
            priceMultiplier = parsed;
            break;
          }
        }
      }

      const sku =
        normalized.find((cell) => /^DAB-[A-Z0-9-]+$/i.test(cell)) || "";
      const collection =
        normalized.find((cell, index) => {
          if (!cell || index === urlIndex || index === multiplierIndex) return false;
          if (isHttpUrl(cell) || toPositiveSheetNumber(cell) !== null) return false;
          if (/^DAB-[A-Z0-9-]+$/i.test(cell)) return false;
          return !/^(price|multiplier|collection|sku)$/i.test(cell);
        }) || "";

      return {
        rowNumber: startIndex + offset + 1,
        url: normalized[urlIndex],
        price: null,
        priceMultiplier,
        collection,
        sku,
      } satisfies GoogleSheetRow;
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
}

export function googleSheetRowFingerprint(row: GoogleSheetRow) {
  const normalizedUrl = normalizeAnalyzeCacheUrl(row.url);
  const value = [
    normalizedUrl,
    row.price === null ? "" : row.price.toFixed(2),
    row.priceMultiplier === null ? "" : row.priceMultiplier.toFixed(4),
    normalizeLabel(row.collection),
    String(row.sku || "").trim().toUpperCase(),
  ].join("|");

  return {
    normalizedUrl,
    hash: crypto.createHash("sha1").update(value).digest("hex"),
  };
}

export function filterUnseenGoogleSheetRows(
  rows: GoogleSheetRow[],
  seenMap: Record<string, number>,
  processOnlyNewRows: boolean,
) {
  if (!processOnlyNewRows) return [...rows];
  return rows.filter((row) => !seenMap[googleSheetRowFingerprint(row).hash]);
}

export function orderGoogleSheetRowsExistingFirst(
  rows: GoogleSheetRow[],
  linkedUrls: Set<string>,
  maxRows: number,
) {
  return rows
    .map((row, position) => ({ row, position }))
    .sort((left, right) => {
      const leftLinked = linkedUrls.has(normalizeAnalyzeCacheUrl(left.row.url));
      const rightLinked = linkedUrls.has(normalizeAnalyzeCacheUrl(right.row.url));
      if (leftLinked === rightLinked) return left.position - right.position;
      return leftLinked ? -1 : 1;
    })
    .slice(0, Math.max(1, maxRows))
    .map((entry) => entry.row);
}

export function shouldDeferMissingCatalogRow(
  isApprovedCatalogSheet: boolean,
  isLinkedToShopify: boolean,
  createMissingProducts: boolean | undefined,
) {
  return (
    isApprovedCatalogSheet &&
    !isLinkedToShopify &&
    createMissingProducts === false
  );
}

export async function loadGoogleSheetRows(sheetUrl: string) {
  const csvUrl = normalizeGoogleSheetUrl(sheetUrl);
  const response = await axios.get(csvUrl, {
    timeout: Math.max(5000, envNumber("GOOGLE_SHEET_FETCH_TIMEOUT_MS", 20000)),
  });
  const csvText = String(response.data || "");
  const matrix = parseCsvMatrix(csvText);
  if (matrix.length === 0) {
    return {
      csvUrl,
      headers: [],
      rows: [] as GoogleSheetRow[],
    };
  }

  const firstRow = matrix[0].map((cell) => String(cell || "").trim());
  const firstRowLooksLikeData = firstRow.some((cell) => isHttpUrl(cell));
  const normalizedFirstRow = firstRow.map((cell) => toSheetHeaderKey(cell));
  const firstRowLooksLikeHeader = normalizedFirstRow.some((cell) =>
    /(^|[^a-z])(url|link)($|[^a-z])/i.test(cell),
  );

  if (firstRowLooksLikeData || !firstRowLooksLikeHeader) {
    return {
      csvUrl,
      headers: ["link", "multiplier", "collection", "sku"],
      rows: parseHeaderlessGoogleSheetRows(matrix),
    };
  }

  if (matrix.length < 2) {
    return {
      csvUrl,
      headers: [],
      rows: [] as GoogleSheetRow[],
    };
  }

  const headers = matrix[0].map((cell) => toSheetHeaderKey(cell));
  const urlColumn =
    detectSheetColumn(headers, [
      /(^|[^a-z])(url|link)($|[^a-z])/i,
      /product[\s_-]*(url|link)/i,
      /supplier[\s_-]*(url|link)/i,
    ]) || headers[0];
  const priceColumn = detectSheetColumn(headers, [/^price$/i, /source[\s_-]*price/i]);
  const multiplierColumn = detectSheetColumn(headers, [
    /^multiplier$/i,
    /^price[\s_-]*multiplier$/i,
    /^row[\s_-]*multiplier$/i,
    /^markup[\s_-]*multiplier$/i,
  ]);
  const collectionColumn = detectSheetColumn(headers, [
    /^collection$/i,
    /shopify[\s_-]*collection/i,
  ]);
  const skuColumn = detectSheetColumn(headers, [/^sku$/i, /product[\s_-]*sku/i]);

  const urlIndex = headers.indexOf(urlColumn);
  const priceIndex = priceColumn ? headers.indexOf(priceColumn) : -1;
  const multiplierIndex = multiplierColumn ? headers.indexOf(multiplierColumn) : -1;
  const collectionIndex = collectionColumn ? headers.indexOf(collectionColumn) : -1;
  const skuIndex = skuColumn ? headers.indexOf(skuColumn) : -1;

  const rows = matrix
    .slice(1)
    .map((row, index) => ({
      rowNumber: index + 2,
      url: String(row[urlIndex] || "").trim(),
      price: priceIndex >= 0 ? toPriceNumber(row[priceIndex]) : null,
      priceMultiplier:
        multiplierIndex >= 0 ? toPositiveSheetNumber(row[multiplierIndex]) : null,
      collection: collectionIndex >= 0 ? String(row[collectionIndex] || "").trim() : "",
      sku: skuIndex >= 0 ? String(row[skuIndex] || "").trim() : "",
    }))
    .filter((row) => row.url.length > 0);

  return {
    csvUrl,
    headers,
    rows,
  };
}

function getProcessedSheetRowsMap(sheetKey: string) {
  const state = googleSheetProcessedRowsCache.get(sheetKey);
  if (!state || typeof state !== "object") return {};
  return state;
}

function setProcessedSheetRowsMap(sheetKey: string, map: Record<string, number>) {
  const maxHours = Math.max(1, envNumber("GOOGLE_SHEET_PROCESSED_ROWS_TTL_HOURS", 720));
  googleSheetProcessedRowsCache.set(sheetKey, map, maxHours * 60 * 60 * 1000);
}

async function sleepMs(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withImportScrapeTimeout<T>(
  operation: Promise<T>,
  url: string,
): Promise<T> {
  const timeoutMs = Math.max(
    15000,
    envNumber("EXCEL_IMPORT_SCRAPE_TIMEOUT_MS", 90 * 1000),
  );
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              Object.assign(
                new Error(
                  `Timed out while scraping source product after ${timeoutMs}ms`,
                ),
                {
                  statusCode: 408,
                  code: "IMPORT_SCRAPE_TIMEOUT",
                  url,
                },
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function scrapeWithBridgeFallback(url: string) {
  try {
    return await scraperService.scrape(url);
  } catch (error: any) {
    if (!error?.retryWithSnapshot) throw error;

    const bridge = localBridgeIsOperational();
    const task = getOrCreateLocalBridgeTask(url);
    if (!bridge.enabled || !task) throw error;

    const waitMs = Math.max(5000, envNumber("LOCAL_BRIDGE_WAIT_MS", 90000));
    const pollMs = Math.max(1000, envNumber("LOCAL_BRIDGE_WAIT_POLL_MS", 2000));
    const deadline = Date.now() + waitMs;
    const normalizedUrl = normalizeAnalyzeCacheUrl(url);

    while (Date.now() < deadline) {
      const cached = getCachedAnalyzeProduct(normalizedUrl);
      if (cached) {
        return cached;
      }

      const currentTask = localBridgeTasks.get(task.id);
      if (currentTask?.status === "failed" && currentTask.lastError) {
        throw Object.assign(
          new Error(
            `Bridge task failed: ${currentTask.lastError}`,
          ),
          { statusCode: 422, code: "LOCAL_BRIDGE_TASK_FAILED" },
        );
      }

      await sleepMs(pollMs);
    }

    throw Object.assign(
      new Error(
        "Bridge task timeout while waiting for browser snapshot result.",
      ),
      { statusCode: 408, code: "LOCAL_BRIDGE_TIMEOUT" },
    );
  }
}

function isLikelyBlockedImportError(error: any) {
  const reason = String(error?.message || error || "").toLowerCase();
  return (
    reason.includes("http 403") ||
    reason.includes("source_blocked") ||
    reason.includes("blocked automated server access") ||
    reason.includes("bridge task timeout") ||
    reason.includes("bridge task failed") ||
    error?.retryWithSnapshot === true
  );
}

function guessProductIdFromUrl(url: string) {
  const normalizedUrl = normalizeAnalyzeCacheUrl(url);
  const nextStyleMatch = normalizedUrl.match(/\/style\/([a-z0-9]+)\/([a-z0-9]+)/i);
  if (nextStyleMatch?.[2]) return nextStyleMatch[2].toUpperCase();
  const lastSegment = normalizedUrl.split("/").filter(Boolean).pop() || "";
  const cleaned = lastSegment.replace(/[^a-z0-9_-]/gi, "");
  return cleaned ? cleaned.toUpperCase() : null;
}

function uniqueSheetFallbackValues(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const clean = String(value || "").replace(/\s+/g, " ").trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
  }
  return result;
}

async function buildBlockedSheetFallbackProduct(params: {
  url: string;
  rowNumber: number;
  price: number;
  sheetUrl: string;
  csvUrl: string;
  mode: "sheet_link" | "auto_sync" | "file_upload";
  collection: string;
}): Promise<NormalizedProduct> {
  const normalizedUrl = normalizeAnalyzeCacheUrl(params.url);
  const existing = await prisma.sourceProduct.findUnique({
    where: { url: normalizedUrl },
    include: {
      images: { orderBy: { position: "asc" } },
      variants: { orderBy: { createdAt: "asc" } },
      supplier: true,
    },
  });

  const cachedTitle = String(existing?.title || "").replace(/\s+/g, " ").trim();
  const cachedImages = existing?.images || [];
  const cachedVariants = existing?.variants || [];
  const hasVerifiedCachedSnapshot =
    Boolean(existing) &&
    Boolean(cachedTitle) &&
    !/^Excel Import Issue\b/i.test(cachedTitle) &&
    !/^Blocked Source Product\b/i.test(cachedTitle) &&
    cachedImages.length > 0 &&
    cachedVariants.length > 0;

  if (!hasVerifiedCachedSnapshot) {
    throw Object.assign(
      new Error(
        "Blocked source did not have a verified cached product snapshot with title, images, and variants; product was not published.",
      ),
      {
        statusCode: 422,
        code: "BLOCKED_SOURCE_UNVERIFIED_FALLBACK",
      },
    );
  }

  const supplierName =
    existing?.supplier?.name ||
    expectedSupplierForUrl(normalizedUrl) ||
    "Unknown Supplier";
  const guessedProductId = existing?.productId || guessProductIdFromUrl(normalizedUrl);
  const title = cachedTitle;
  const description =
    existing?.description ||
    `Auto-published from sheet row ${params.rowNumber} because supplier source access was blocked during scrape.`;
  const brand = existing?.brand || (supplierName === "Next" ? "Next" : supplierName);
  const currency =
    existing?.currency && existing.currency !== "USD"
      ? existing.currency
      : supplierName === "Next"
      ? "AED"
      : "USD";

  const images =
    cachedImages.map((img: any) => ({
      url: img.url,
      alt: img.alt || undefined,
      color: img.color || undefined,
      position: img.position,
    }));

  const variants: NormalizedProduct["variants"] =
    cachedVariants.map((variant: any, index: number) => ({
          sourceVariantId:
            variant.sourceVariantId ||
            `${guessedProductId || "variant"}-${index + 1}`,
          sku: variant.sku || undefined,
          color: variant.color || undefined,
          size: variant.size || undefined,
          price: params.price,
          currency,
          available: variant.available ?? true,
          stockStatus: variant.stockStatus || "unknown",
          imageUrl: variant.imageUrl || undefined,
        }));
  const colorValues = uniqueSheetFallbackValues(
    variants.map((variant) => variant.color),
  );
  const sizeValues = uniqueSheetFallbackValues(
    variants.map((variant) => variant.size),
  );
  const options = [
    ...(colorValues.length ? [{ name: "Color", values: colorValues }] : []),
    ...(sizeValues.length ? [{ name: "Size", values: sizeValues }] : []),
  ];

  return {
    source: {
      supplier: supplierName,
      url: normalizedUrl,
      productId: guessedProductId,
    },
    title,
    description,
    brand,
    currency,
    price: params.price,
    images,
    options: options.length ? options : [{ name: "Default", values: ["Default"] }],
    variants,
    raw: {
      fallbackFromBlockedSource: true,
      rowNumber: params.rowNumber,
      originalUrl: normalizedUrl,
    },
    importMeta: {
      excelRowNumber: params.rowNumber,
      sheetUrl: params.sheetUrl,
      csvUrl: params.csvUrl,
      mode: params.mode,
      sheetCollection: params.collection || null,
    },
  };
}

export async function processGoogleSheetBatch(params: {
  sheetUrl: string;
  pricingRuleId?: string | null;
  defaultCollections?: string[];
  createManualReview?: boolean;
  processOnlyNewRows?: boolean;
  rowNumbers?: number[];
  waitForPublishCompletion?: boolean;
  mode?: "sheet_link" | "auto_sync";
  createMissingProducts?: boolean;
}) {
  await ensureShopifyConnection();
  const selectedPricingRuleId = asOptionalString(params.pricingRuleId);
  const createManualReview = params.createManualReview !== false;
  const waitForPublishCompletion = params.waitForPublishCompletion !== false;
  const sheetData = await loadGoogleSheetRows(params.sheetUrl);
  const sheetKey = normalizeAnalyzeCacheUrl(sheetData.csvUrl);
  const approvedCatalogGid = (() => {
    try {
      const gid = new URL(sheetData.csvUrl).searchParams.get("gid") || "0";
      return APPROVED_CATALOG_SHEETS[gid] ? gid : null;
    } catch {
      return null;
    }
  })();
  const isApprovedCatalogSheet = approvedCatalogGid !== null;
  const maxRows = Math.max(1, envNumber("EXCEL_IMPORT_MAX_ROWS", 300));
  const requestedRowNumbers = Array.isArray(params.rowNumbers)
    ? params.rowNumbers
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
        .map((value) => Math.max(1, Math.floor(value)))
    : [];
  const rowFilterSet = new Set<number>(requestedRowNumbers);
  const filteredRows = rowFilterSet.size
    ? sheetData.rows.filter((row) => rowFilterSet.has(row.rowNumber))
    : sheetData.rows;
  const seenMap = getProcessedSheetRowsMap(sheetKey);
  const eligibleRows = filterUnseenGoogleSheetRows(
    filteredRows,
    seenMap,
    params.processOnlyNewRows === true,
  );

  // Run linked Shopify products first. Besides matching the requested business
  // order, this avoids spending scraper capacity on rows that can be refreshed
  // through their existing database link.
  const candidateUrls = [
    ...new Set(
      eligibleRows
        .map((row) => normalizeAnalyzeCacheUrl(row.url))
        .filter((url) => isHttpUrl(url)),
    ),
  ];
  const linkedProducts = candidateUrls.length
    ? await prisma.sourceProduct.findMany({
        where: {
          url: { in: candidateUrls },
          shopifyProduct: { isNot: null },
        },
        select: { url: true },
      })
    : [];
  const linkedUrls = new Set(linkedProducts.map((product) => product.url));
  const processRows = orderGoogleSheetRowsExistingFirst(
    eligibleRows,
    linkedUrls,
    maxRows,
  );

  if (selectedPricingRuleId) {
    const ruleExists = await prisma.pricingRule.findUnique({
      where: { id: selectedPricingRuleId },
      select: { id: true },
    });
    if (!ruleExists) {
      throw Object.assign(new Error("Selected pricing rule was not found"), {
        statusCode: 400,
      });
    }
  }

  const shopifyClient = await ShopifyService.getClientFromDb(prisma);
  const shopifyInventoryLocation = isApprovedCatalogSheet
    ? await ShopifyService.getInventoryLocation(shopifyClient)
    : null;
  if (isApprovedCatalogSheet && !shopifyInventoryLocation?.id) {
    throw new Error("Shopify inventory location is required for safe catalog reconciliation");
  }
  const shopifyCollections = await ShopifyService.getCollections(shopifyClient);
  const collectionByName = new Map<string, string>(
    shopifyCollections
      .map((collection: any) => [normalizeLabel(collection.title), String(collection.id)] as const)
      .filter((entry) => Boolean(entry[0] && entry[1])),
  );

  const successful: Array<{
    rowNumber: number;
    url: string;
    action?: "published" | "synced_existing" | "reconciled_existing";
    sku?: string;
    priceOverride: number | null;
    priceMultiplier: number | null;
    collection: string;
    sourceProductId?: string;
    jobId?: string;
    verification?: {
      shopifyId: string;
      variantsExpected?: number;
      variantsCreated?: number;
      variantsLinked?: number;
      variantImagesRequested?: number;
      variantImagesLinked?: number;
      salesChannelsPublished?: number;
    };
  }> = [];
  const skipped: Array<{
    rowNumber: number;
    url: string;
    reason: string;
    sourceProductId?: string;
  }> = [];
  const failed: Array<{
    rowNumber: number;
    url: string;
    reason: string;
    sourceProductId?: string;
    manualReviewId?: string;
  }> = [];
  const processedUrls = new Set<string>();
  let processedNewRows = 0;
  let syncedExistingRows = 0;

  for (const row of processRows) {
    const fingerprint = googleSheetRowFingerprint(row);
    const normalizedUrl = fingerprint.normalizedUrl;
    const fingerprintHash = fingerprint.hash;
    processedNewRows += 1;

    if (processedUrls.has(normalizedUrl)) {
      skipped.push({
        rowNumber: row.rowNumber,
        url: normalizedUrl,
        reason: "Duplicate URL inside the same Google Sheet batch",
      });
      seenMap[fingerprintHash] = Date.now();
      continue;
    }
    processedUrls.add(normalizedUrl);

    const registerFailure = async (reason: string) => {
      let review: { sourceProductId: string; manualReviewId: string } | null = null;
      if (createManualReview) {
        try {
          review = await createManualReviewIssueForExcel({
            url: normalizedUrl,
            rowNumber: row.rowNumber,
            reason,
          });
        } catch (reviewError) {
          console.warn(
            "Manual review auto-create failed:",
            reviewError instanceof Error ? reviewError.message : reviewError,
          );
        }
      }

      failed.push({
        rowNumber: row.rowNumber,
        url: normalizedUrl,
        reason: normalizeManualReviewReason(reason),
        sourceProductId: review?.sourceProductId,
        manualReviewId: review?.manualReviewId,
      });
    };

    if (!isHttpUrl(normalizedUrl)) {
      await registerFailure("Invalid product URL");
      continue;
    }

    const rowCollectionNames = row.collection
      .split(/[|,]/)
      .map((name) => name.trim())
      .filter(Boolean);
    const rowCollectionIds = rowCollectionNames
      .map((name) => collectionByName.get(normalizeLabel(name)) || "")
      .filter(Boolean);
    const fallbackCollectionIds = (params.defaultCollections || [])
      .map((id) => String(id || "").trim())
      .filter(Boolean);
    const selectedCollectionIds = rowCollectionIds.length
      ? rowCollectionIds
      : fallbackCollectionIds;

    const queueExistingLinkedProductSync = async (reason: string, sku?: string) => {
      const existing = await prisma.sourceProduct.findUnique({
        where: { url: normalizedUrl },
        select: {
          id: true,
          shopifyProduct: { select: { id: true } },
        },
      });

      if (!existing?.shopifyProduct?.id) {
        return false;
      }

      await upsertSourceProductExcelImportMeta(normalizedUrl, {
        excelRowNumber: row.rowNumber,
        sheetUrl: params.sheetUrl,
        csvUrl: sheetData.csvUrl,
        mode: params.mode || (params.processOnlyNewRows ? "auto_sync" : "sheet_link"),
        sheetCollection: row.collection || null,
        sheetPriceMultiplier: row.priceMultiplier,
      });

      const syncJob = await QueueService.addTask("SYNC_PRODUCT", {
        sourceProductId: existing.id,
        reason,
        refreshSource: true,
        priceMultiplier: row.priceMultiplier,
        priceOverride:
          row.price !== null && PricingEngine.validatePrice(row.price)
            ? row.price
            : null,
        pricingRuleId: selectedPricingRuleId,
        collections: selectedCollectionIds,
        sheetMeta: {
          excelRowNumber: row.rowNumber,
          sheetUrl: params.sheetUrl,
          csvUrl: sheetData.csvUrl,
          mode: params.mode || (params.processOnlyNewRows ? "auto_sync" : "sheet_link"),
          sheetCollection: row.collection || null,
          sheetPriceMultiplier: row.priceMultiplier,
          sheetSku: row.sku || null,
        },
      });

      if (waitForPublishCompletion) {
        const completedSyncJob = await waitForSyncJobCompletion(syncJob.id);
        if (completedSyncJob.status === "failed") {
          const syncError =
            String(completedSyncJob.parsedResult?.error || "").trim() ||
            `Existing Shopify sync job failed (${syncJob.id})`;
          throw new Error(syncError);
        }
      }

      successful.push({
        rowNumber: row.rowNumber,
        url: normalizedUrl,
        action: "synced_existing",
        sku,
        priceOverride: row.price,
        priceMultiplier: row.priceMultiplier,
        collection: row.collection,
        sourceProductId: existing.id,
        jobId: syncJob.id,
      });
      syncedExistingRows += 1;
      return true;
    };

    if (isApprovedCatalogSheet && row.priceMultiplier === null) {
      await registerFailure("Missing or invalid price multiplier in the Google Sheet row");
      continue;
    }

    if (linkedUrls.has(normalizedUrl) && !isApprovedCatalogSheet) {
      try {
        const queued = await queueExistingLinkedProductSync(
          "sheet_existing_product_first",
        );
        if (queued) {
          seenMap[fingerprintHash] = Date.now();
          continue;
        }
      } catch (error: any) {
        await registerFailure(
          error?.message || "Failed to refresh the existing Shopify product",
        );
        continue;
      }
    }

    if (
      shouldDeferMissingCatalogRow(
        isApprovedCatalogSheet,
        linkedUrls.has(normalizedUrl),
        params.createMissingProducts,
      )
    ) {
      skipped.push({
        rowNumber: row.rowNumber,
        url: normalizedUrl,
        reason: "missing_product_deferred_for_publish_phase",
      });
      continue;
    }

    try {
      const analyzed = await withImportScrapeTimeout(
        scrapeWithBridgeFallback(normalizedUrl),
        normalizedUrl,
      );
      if (row.price !== null && PricingEngine.validatePrice(row.price)) {
        analyzed.price = row.price;
        analyzed.variants = analyzed.variants.map((variant: any) => ({
          ...variant,
          price: row.price,
        }));
      }
      analyzed.importMeta = {
        excelRowNumber: row.rowNumber,
        sheetUrl: params.sheetUrl,
        csvUrl: sheetData.csvUrl,
        mode: params.mode || (params.processOnlyNewRows ? "auto_sync" : "sheet_link"),
        sheetCollection: row.collection || null,
        sheetPriceMultiplier: row.priceMultiplier,
      };
      const skuPlan = isApprovedCatalogSheet
        ? applyDeterministicDabSkus({
            product: analyzed,
            url: normalizedUrl,
            multiplier: row.priceMultiplier,
            existingProductSku: row.sku,
          })
        : null;
      setCachedAnalyzeProduct(normalizedUrl, analyzed);

      if (
        isApprovedCatalogSheet &&
        linkedUrls.has(normalizedUrl) &&
        analyzed.raw?.repairedFlattenedNextVariants === true
      ) {
        const queued = await queueExistingLinkedProductSync(
          "sheet_repair_flattened_next_variants",
          skuPlan?.canonicalSku,
        );
        if (queued) {
          seenMap[fingerprintHash] = Date.now();
          continue;
        }
      }

      if (isApprovedCatalogSheet && shopifyInventoryLocation?.id) {
        const reconciliation = await reconcileExistingShopifyProductForImport({
          client: shopifyClient,
          locationId: shopifyInventoryLocation.id,
          url: normalizedUrl,
          rowNumber: row.rowNumber,
          multiplier: row.priceMultiplier || 1,
          collection: row.collection,
          sheetId: Number(approvedCatalogGid),
          sheetName: APPROVED_CATALOG_SHEETS[approvedCatalogGid],
          existingSku: row.sku,
          fresh: analyzed,
        });

        if (reconciliation.status === "verified" && reconciliation.shopifyProductId) {
          successful.push({
            rowNumber: row.rowNumber,
            url: normalizedUrl,
            action: "reconciled_existing",
            sku: reconciliation.expectedSku || skuPlan?.canonicalSku,
            priceOverride: row.price,
            priceMultiplier: row.priceMultiplier,
            collection: row.collection,
            verification: {
              shopifyId: reconciliation.shopifyProductId,
              variantsExpected: reconciliation.variantsChecked,
              variantsCreated: 0,
              variantsLinked: reconciliation.variantsChecked,
            },
          });
          syncedExistingRows += 1;
          seenMap[fingerprintHash] = Date.now();
          continue;
        }

        if (
          reconciliation.status === "rebuild_required" &&
          reconciliation.shopifyProductId &&
          reconciliation.shopifyHandle
        ) {
          const publishResult = await publishPreparedProductToQueue({
            productData: analyzed,
            pricingRuleId: selectedPricingRuleId,
            collections: selectedCollectionIds,
            priceMultiplier: row.priceMultiplier,
            replaceShopifyProductId: reconciliation.shopifyProductId,
            replaceShopifyHandle: reconciliation.shopifyHandle,
          });
          const publishJob = await waitForSyncJobCompletion(publishResult.jobId);
          if (publishJob.status === "failed") {
            const reason =
              String(publishJob.parsedResult?.error || "").trim() ||
              `Shopify rebuild job failed (${publishResult.jobId})`;
            throw new Error(reason);
          }
          verifyPublishJobResult(publishJob.parsedResult || {});
          successful.push({
            rowNumber: row.rowNumber,
            url: normalizedUrl,
            action: "reconciled_existing",
            sku: skuPlan?.canonicalSku,
            priceOverride: row.price,
            priceMultiplier: row.priceMultiplier,
            collection: row.collection,
            sourceProductId: publishResult.sourceProductId,
            jobId: publishResult.jobId,
            verification: {
              shopifyId: String(publishJob.parsedResult?.shopifyId || ""),
              variantsExpected: Number(publishJob.parsedResult?.variantsExpected),
              variantsCreated: Number(publishJob.parsedResult?.variantsCreated),
              variantsLinked: Number(publishJob.parsedResult?.variantsLinked),
              variantImagesRequested: Number(
                publishJob.parsedResult?.variantImagesRequested,
              ),
              variantImagesLinked: Number(
                publishJob.parsedResult?.variantImagesLinked,
              ),
              salesChannelsPublished: Number(
                publishJob.parsedResult?.salesChannelsPublished,
              ),
            },
          });
          syncedExistingRows += 1;
          seenMap[fingerprintHash] = Date.now();
          continue;
        }

        if (reconciliation.status !== "missing") {
          await registerFailure(
            reconciliation.reason ||
              `Existing Shopify product reconciliation stopped with status ${reconciliation.status}`,
          );
          continue;
        }


        if (params.createMissingProducts === false) {
          skipped.push({
            rowNumber: row.rowNumber,
            url: normalizedUrl,
            reason: "missing_product_deferred_for_publish_phase",
          });
          continue;
        }
      }

      const publishResult = await publishPreparedProductToQueue({
        productData: analyzed,
        pricingRuleId: selectedPricingRuleId,
        collections: selectedCollectionIds,
        priceMultiplier: row.priceMultiplier,
      });

      let verification:
        | {
            shopifyId: string;
            variantsExpected?: number;
            variantsCreated?: number;
            variantsLinked?: number;
            variantImagesRequested?: number;
            variantImagesLinked?: number;
            salesChannelsPublished?: number;
          }
        | undefined;
      if (waitForPublishCompletion) {
        const publishJob = await waitForSyncJobCompletion(publishResult.jobId);
        if (publishJob.status === "failed") {
          const reason =
            String(publishJob.parsedResult?.error || "").trim() ||
            `Shopify publish job failed (${publishResult.jobId})`;
          throw new Error(reason);
        }

        verifyPublishJobResult(publishJob.parsedResult || {});
        verification = {
          shopifyId: String(publishJob.parsedResult?.shopifyId || ""),
          variantsExpected: Number(publishJob.parsedResult?.variantsExpected),
          variantsCreated: Number(publishJob.parsedResult?.variantsCreated),
          variantsLinked: Number(publishJob.parsedResult?.variantsLinked),
          variantImagesRequested: Number(
            publishJob.parsedResult?.variantImagesRequested,
          ),
          variantImagesLinked: Number(
            publishJob.parsedResult?.variantImagesLinked,
          ),
          salesChannelsPublished: Number(
            publishJob.parsedResult?.salesChannelsPublished,
          ),
        };
      }

      successful.push({
        rowNumber: row.rowNumber,
        url: normalizedUrl,
        action: "published",
        sku: skuPlan?.canonicalSku,
        priceOverride: row.price,
        priceMultiplier: row.priceMultiplier,
        collection: row.collection,
        sourceProductId: publishResult.sourceProductId,
        jobId: publishResult.jobId,
        ...(verification ? { verification } : {}),
      });
      seenMap[fingerprintHash] = Date.now();
    } catch (error: any) {
      const reason = error?.message || "Failed to analyze or publish this URL";
      if (isAlreadyLinkedToShopifyMessage(reason)) {
        const queued = await queueExistingLinkedProductSync("sheet_row_already_linked");
        if (queued) seenMap[fingerprintHash] = Date.now();
        if (!queued) {
          const existing = await prisma.sourceProduct.findUnique({
            where: { url: normalizedUrl },
            select: { id: true },
          });
          skipped.push({
            rowNumber: row.rowNumber,
            url: normalizedUrl,
            reason,
            sourceProductId: existing?.id,
          });
        }
      } else if (isLikelyBlockedImportError(error) && row.price !== null && PricingEngine.validatePrice(row.price)) {
        try {
          const fallbackProduct = await buildBlockedSheetFallbackProduct({
            url: normalizedUrl,
            rowNumber: row.rowNumber,
            price: row.price,
            sheetUrl: params.sheetUrl,
            csvUrl: sheetData.csvUrl,
            mode: params.mode || (params.processOnlyNewRows ? "auto_sync" : "sheet_link"),
            collection: row.collection,
          });
          const fallbackSkuPlan = isApprovedCatalogSheet
            ? applyDeterministicDabSkus({
                product: fallbackProduct,
                url: normalizedUrl,
                multiplier: row.priceMultiplier,
                existingProductSku: row.sku,
              })
            : null;
          const publishResult = await publishPreparedProductToQueue({
            productData: fallbackProduct,
            pricingRuleId: selectedPricingRuleId,
            collections: selectedCollectionIds,
            priceMultiplier: row.priceMultiplier,
          });

          let verification:
            | {
                shopifyId: string;
                variantsExpected?: number;
                variantsCreated?: number;
                variantsLinked?: number;
                variantImagesRequested?: number;
                variantImagesLinked?: number;
                salesChannelsPublished?: number;
              }
            | undefined;
          if (waitForPublishCompletion) {
            const publishJob = await waitForSyncJobCompletion(
              publishResult.jobId,
            );
            if (publishJob.status === "failed") {
              const reason =
                String(publishJob.parsedResult?.error || "").trim() ||
                `Shopify publish job failed (${publishResult.jobId})`;
              throw new Error(reason);
            }

            verifyPublishJobResult(publishJob.parsedResult || {});
            verification = {
              shopifyId: String(publishJob.parsedResult?.shopifyId || ""),
              variantsExpected: Number(
                publishJob.parsedResult?.variantsExpected,
              ),
              variantsCreated: Number(
                publishJob.parsedResult?.variantsCreated,
              ),
              variantsLinked: Number(publishJob.parsedResult?.variantsLinked),
              variantImagesRequested: Number(
                publishJob.parsedResult?.variantImagesRequested,
              ),
              variantImagesLinked: Number(
                publishJob.parsedResult?.variantImagesLinked,
              ),
              salesChannelsPublished: Number(
                publishJob.parsedResult?.salesChannelsPublished,
              ),
            };
          }
          successful.push({
            rowNumber: row.rowNumber,
            url: normalizedUrl,
            action: "published",
            sku: fallbackSkuPlan?.canonicalSku,
            priceOverride: row.price,
            priceMultiplier: row.priceMultiplier,
            collection: row.collection,
            sourceProductId: publishResult.sourceProductId,
            jobId: publishResult.jobId,
            ...(verification ? { verification } : {}),
          });
          seenMap[fingerprintHash] = Date.now();
        } catch (fallbackError: any) {
          const fallbackReason =
            fallbackError?.message ||
            `Fallback publish failed after source blocked: ${reason}`;
          if (isAlreadyLinkedToShopifyMessage(fallbackReason)) {
            const queued = await queueExistingLinkedProductSync("sheet_fallback_already_linked");
            if (queued) seenMap[fingerprintHash] = Date.now();
            if (!queued) {
              const existing = await prisma.sourceProduct.findUnique({
                where: { url: normalizedUrl },
                select: { id: true },
              });
              skipped.push({
                rowNumber: row.rowNumber,
                url: normalizedUrl,
                reason: fallbackReason,
                sourceProductId: existing?.id,
              });
            }
          } else {
            await registerFailure(fallbackReason);
          }
        }
      } else {
        await registerFailure(reason);
      }
    }

  }

  setProcessedSheetRowsMap(sheetKey, seenMap);
  const publishedRows = successful.filter(
    (entry) =>
      entry.action !== "synced_existing" &&
      entry.action !== "reconciled_existing",
  ).length;

  const responsePayload = {
    success: true,
    csvUrl: sheetData.csvUrl,
    headers: sheetData.headers,
    summary: {
      totalRowsInSheet: sheetData.rows.length,
      selectedRows: filteredRows.length,
      eligibleRows: eligibleRows.length,
      processedRows: processRows.length,
      processedNewRows,
      remainingRows: Math.max(0, eligibleRows.length - processRows.length),
      published: publishedRows,
      syncedExisting: syncedExistingRows,
      skipped: skipped.length,
      failed: failed.length,
      manualReviewCreated: failed.filter((entry) => entry.manualReviewId).length,
    },
    successful,
    skipped,
    failed,
  };

  const batch = await saveExcelImportRun({
    mode: params.mode || (params.processOnlyNewRows ? "auto_sync" : "sheet_link"),
    sheetUrl: params.sheetUrl,
    csvUrl: sheetData.csvUrl,
    summary: responsePayload.summary,
    successful,
    skipped,
    failed,
    metadata: {
      processOnlyNewRows: params.processOnlyNewRows === true,
      rowNumbers: rowFilterSet.size ? [...rowFilterSet] : null,
      pricingRuleId: selectedPricingRuleId,
      defaultCollections: params.defaultCollections || [],
      createMissingProducts: params.createMissingProducts !== false,
    },
  });

  return {
    ...responsePayload,
    batchId: batch.id,
    batchStatus: batch.status,
    batchCreatedAt: batch.createdAt.toISOString(),
  };
}

async function createManualReviewIssueForExcel(params: {
  url: string;
  rowNumber: number;
  reason: string;
}) {
  const normalizedUrl = normalizeAnalyzeCacheUrl(params.url);
  const issueReason = normalizeManualReviewReason(
    `[Excel Row ${params.rowNumber}] ${params.reason}`,
  );
  const guessedSupplier = expectedSupplierForUrl(normalizedUrl) || "Unknown Supplier";

  const result = await prisma.$transaction(async (tx) => {
    const supplier = await tx.supplier.upsert({
      where: { name: guessedSupplier },
      update: {},
      create: {
        name: guessedSupplier,
        baseUrl: normalizedUrl,
      },
    });

    let sourceProduct = await tx.sourceProduct.findUnique({
      where: { url: normalizedUrl },
      select: { id: true, raw: true },
    });

    if (!sourceProduct) {
      sourceProduct = await tx.sourceProduct.create({
        data: {
          supplierId: supplier.id,
          url: normalizedUrl,
          productId: null,
          title: `Excel Import Issue - Row ${params.rowNumber}`,
          description:
            "Created automatically because this Excel row failed and requires manual review.",
          brand: null,
          currency: "USD",
          price: 0,
          syncStatus: "error",
          raw: JSON.stringify({
            excelImportIssue: true,
            rowNumber: params.rowNumber,
            reason: issueReason,
            sourceUrl: normalizedUrl,
          }),
        },
        select: { id: true, raw: true },
      });
    } else {
      const currentRaw = parseJsonObject(sourceProduct.raw) || {};
      const currentImportMeta = parseJsonObject(currentRaw.import) || {};
      const mergedImportMeta = {
        ...currentImportMeta,
        excelRowNumber: params.rowNumber,
      };
      await tx.sourceProduct.update({
        where: { id: sourceProduct.id },
        data: {
          raw: JSON.stringify({
            ...currentRaw,
            import: mergedImportMeta,
          }),
        },
      });
    }

    const existingReview = await tx.manualReviewItem.findFirst({
      where: {
        sourceProductId: sourceProduct.id,
        status: "pending",
        reason: issueReason,
      },
      select: { id: true },
    });

    if (existingReview) {
      return { sourceProductId: sourceProduct.id, manualReviewId: existingReview.id };
    }

    const manualReview = await tx.manualReviewItem.create({
      data: {
        sourceProductId: sourceProduct.id,
        reason: issueReason,
        status: "pending",
      },
      select: { id: true },
    });

    return { sourceProductId: sourceProduct.id, manualReviewId: manualReview.id };
  });

  return result;
}

async function publishPreparedProductToQueue(params: {
  productData: any;
  pricingRuleId?: string | null;
  collections?: string[];
  priceMultiplier?: number | null;
  replaceShopifyProductId?: string;
  replaceShopifyHandle?: string;
}) {
  const {
    productData,
    pricingRuleId,
    collections,
    priceMultiplier,
    replaceShopifyProductId,
    replaceShopifyHandle,
  } = params;
  const sourceUrl = String(productData?.source?.url || "").trim();
  if (!sourceUrl || !isHttpUrl(sourceUrl)) {
    throw Object.assign(new Error("Product source URL is missing or invalid"), {
      statusCode: 400,
      code: "INVALID_SOURCE_URL",
    });
  }

  const sourcePrice = Number(productData.price);
  if (!PricingEngine.validatePrice(sourcePrice)) {
    throw Object.assign(new Error("Product source price is invalid"), {
      statusCode: 400,
    });
  }

  const selectedPricingRuleId = asOptionalString(pricingRuleId);
  const selectedPriceMultiplier = toPositiveSheetNumber(priceMultiplier);
  if (selectedPricingRuleId) {
    const ruleExists = await prisma.pricingRule.findUnique({
      where: { id: selectedPricingRuleId },
      select: { id: true },
    });

    if (!ruleExists) {
      throw Object.assign(new Error("Selected pricing rule was not found"), {
        statusCode: 400,
      });
    }
  }

  const supplierName =
    String(productData.source?.supplier || "Unknown Supplier").trim() ||
    "Unknown Supplier";
  const requestedImages = Array.isArray(productData.images)
    ? productData.images
    : [];
  const requestedVariants =
    Array.isArray(productData.variants) && productData.variants.length > 0
      ? productData.variants
      : [
          {
            sourceVariantId: productData.source.productId || "default",
            price: sourcePrice,
            currency: productData.currency,
            available: true,
            stockStatus: "unknown",
          },
        ];
  const nextSafePayload = removeRelatedNextColorways(
    productData,
    requestedVariants,
    requestedImages,
  );
  const normalizedImages = normalizeProductImageList(nextSafePayload.images, {
    keepIfAllRejected: false,
    maxImages: 30,
  });
  if (requestedImages.length > 0 && normalizedImages.length === 0) {
    throw Object.assign(
      new Error("Selected product images are not valid image URLs"),
      { statusCode: 400 },
    );
  }
  const { images, removed: removedDuplicateImages } =
    dedupeCatalogImages(normalizedImages);
  const { variants, removed: removedDuplicateVariants } = dedupeCatalogVariants(
    nextSafePayload.variants,
  );

  assertStrictCatalogQuality(productData, variants, images);

  const collectionIds = Array.isArray(collections) ? collections : [];
  const importMeta = normalizeExcelImportMeta(parseJsonObject(productData?.importMeta));

  const sourceProduct = await prisma.$transaction(async (tx) => {
    const supplier = await tx.supplier.upsert({
      where: { name: supplierName },
      update: {},
      create: { name: supplierName, baseUrl: productData.source.url },
    });

    const existingProduct = await tx.sourceProduct.findUnique({
      where: { url: productData.source.url },
      include: { shopifyProduct: true },
    });

    if (existingProduct?.shopifyProduct) {
      throw Object.assign(
        new Error(
          "This product is already linked to Shopify. Use Sync Now from the product detail page.",
        ),
        {
          statusCode: 409,
        },
      );
    }

    const productRecord = {
      supplierId: supplier.id,
      productId: productData.source.productId,
      title: productData.title,
      description: productData.description,
      brand: productData.brand,
      currency: productData.currency,
      price: sourcePrice,
      raw: JSON.stringify({
        options: productData.options,
          raw: productData.raw,
          import: {
            pricingRuleId: selectedPricingRuleId,
            ...(selectedPriceMultiplier
              ? { sheetPriceMultiplier: selectedPriceMultiplier }
              : {}),
            selectedImageCount: images.length,
            removedDuplicateImages,
            removedDuplicateVariants,
            ...Object.fromEntries(
              Object.entries(importMeta).filter(([, value]) => value !== undefined && value !== null),
            ),
          },
        }),
      syncStatus: "pending",
    };

    const imageRecords = images
      .filter((img: any) => img?.url)
      .map((img: any, index: number) => ({
        url: img.url,
        alt: img.alt,
        color: img.color,
        position: Number.isInteger(img.position) ? img.position : index,
      }));

    const variantRecords = variants.map((v: any, index: number) => {
      const resolvedImageUrl = resolveVariantImageUrl(v, images, variants);
      const variantPrice = Number(v.price || sourcePrice);

      return {
        sourceVariantId:
          v.sourceVariantId ||
          v.sku ||
          `${productData.source.productId || "variant"}-${index}`,
        sku: v.sku,
        color: v.color,
        size: v.size,
        price: PricingEngine.validatePrice(variantPrice)
          ? variantPrice
          : sourcePrice,
        currency: v.currency || productData.currency,
        available: v.available ?? true,
        stockStatus: v.stockStatus || "unknown",
        imageUrl: resolvedImageUrl,
        raw: JSON.stringify({
          optionValues: v.optionValues,
          calculatedPrice: v.calculatedPrice,
          imageUrl: resolvedImageUrl,
          raw: v.raw,
        }),
      };
    });

    if (existingProduct) {
      await tx.sourceImage.deleteMany({
        where: { sourceProductId: existingProduct.id },
      });
      await tx.sourceVariant.deleteMany({
        where: { sourceProductId: existingProduct.id },
      });
      await tx.manualReviewItem.deleteMany({
        where: { sourceProductId: existingProduct.id, status: "pending" },
      });

      return tx.sourceProduct.update({
        where: { id: existingProduct.id },
        data: {
          ...productRecord,
          images: { create: imageRecords },
          variants: { create: variantRecords },
        },
      });
    }

    return tx.sourceProduct.create({
      data: {
        ...productRecord,
        url: productData.source.url,
        images: { create: imageRecords },
        variants: { create: variantRecords },
      },
    });
  });

  const job = await QueueService.addTask("PUBLISH_TO_SHOPIFY", {
    sourceProductId: sourceProduct.id,
    pricingRuleId: selectedPricingRuleId,
    collections: collectionIds,
    ...(replaceShopifyProductId && replaceShopifyHandle
      ? {
          replaceShopifyProductId,
          replaceShopifyHandle,
          handle: replaceShopifyHandle,
        }
      : {}),
    ...(selectedPriceMultiplier ? { priceMultiplier: selectedPriceMultiplier } : {}),
  });

  return { sourceProductId: sourceProduct.id, jobId: job.id };
}

function verifyShopifyHmac(query: any, clientSecret: string) {
  const hmac = firstQueryValue(query.hmac);
  if (!hmac) return false;

  const message = Object.keys(query)
    .filter((key) => key !== "hmac" && key !== "signature")
    .sort()
    .map((key) => {
      const value = Array.isArray(query[key])
        ? query[key].join(",")
        : query[key];
      return `${key}=${value}`;
    })
    .join("&");

  const digest = crypto
    .createHmac("sha256", clientSecret)
    .update(message)
    .digest("hex");

  const hmacBuffer = Buffer.from(hmac, "hex");
  const digestBuffer = Buffer.from(digest, "hex");

  return (
    hmacBuffer.length === digestBuffer.length &&
    crypto.timingSafeEqual(hmacBuffer, digestBuffer)
  );
}

// Analysis
router.get("/bridge/status", async (req, res) => {
  const url = String(req.query.url || "").trim();
  const bridge = localBridgeIsOperational();
  if (!url) {
    return res.json({
      enabled: bridge.enabled,
      reason: bridge.reason,
      task: null,
    });
  }

  const key = normalizeAnalyzeCacheUrl(url);
  const taskId = localBridgeTaskByKey.get(key);
  const task = taskId ? localBridgeTasks.get(taskId) : null;

  if (!task) {
    return res.json({
      enabled: bridge.enabled,
      reason: bridge.reason,
      task: null,
    });
  }

  res.json({
    enabled: bridge.enabled,
    reason: bridge.reason,
    task: {
      id: task.id,
      status: task.status,
      url: task.url,
      createdAt: new Date(task.createdAt).toISOString(),
      updatedAt: new Date(task.updatedAt).toISOString(),
      completedAt: task.completedAt
        ? new Date(task.completedAt).toISOString()
        : null,
      lastError: task.lastError || null,
    },
  });
});

router.post("/bridge/tasks/claim", async (req, res) => {
  const bridge = localBridgeIsOperational();
  if (!bridge.enabled) {
    return res.status(404).json({
      error: "Local bridge is disabled",
      reason: bridge.reason,
      code: "LOCAL_BRIDGE_DISABLED",
    });
  }
  if (!authorizeLocalBridgeRequest(req, res)) return;

  const task = claimLocalBridgeTask();
  if (!task) return res.status(204).end();

  res.json({
    id: task.id,
    url: task.url,
    status: task.status,
    createdAt: new Date(task.createdAt).toISOString(),
  });
});

router.post("/bridge/tasks/:id/submit", async (req, res) => {
  const bridge = localBridgeIsOperational();
  if (!bridge.enabled) {
    return res.status(404).json({
      error: "Local bridge is disabled",
      reason: bridge.reason,
      code: "LOCAL_BRIDGE_DISABLED",
    });
  }
  if (!authorizeLocalBridgeRequest(req, res)) return;

  const task = localBridgeTasks.get(req.params.id);
  if (!task) {
    return res
      .status(404)
      .json({ error: "Bridge task not found", code: "LOCAL_BRIDGE_TASK_NOT_FOUND" });
  }

  const pageText = String(req.body?.pageText || "").trim();
  if (!pageText) {
    return res.status(400).json({
      error: "pageText is required",
      code: "LOCAL_BRIDGE_PAGE_TEXT_REQUIRED",
    });
  }

  try {
    const data = await scraperService.scrapeSnapshot(task.url, pageText);
    if (!productSupplierMatchesUrl(task.url, data)) {
      const expected = expectedSupplierForUrl(task.url) || "target supplier";
      throw Object.assign(
        new Error(
          `Bridge snapshot does not match URL supplier. Expected ${expected}.`,
        ),
        { status: 422, code: "LOCAL_BRIDGE_SNAPSHOT_MISMATCH" },
      );
    }

    setCachedAnalyzeProduct(task.url, data);
    task.status = "completed";
    task.completedAt = Date.now();
    task.updatedAt = Date.now();
    task.lastError = undefined;
    localBridgeTasks.set(task.id, task);

    res.json({
      success: true,
      taskId: task.id,
      url: task.url,
      status: task.status,
    });
  } catch (error: any) {
    task.status = "failed";
    task.updatedAt = Date.now();
    task.lastError = error?.message || "Bridge snapshot parse failed";
    localBridgeTasks.set(task.id, task);
    res.status(error?.status || 422).json({
      error: task.lastError,
      code: error?.code || "LOCAL_BRIDGE_SUBMIT_FAILED",
    });
  }
});

router.post("/imports/prewarm", async (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (!url) return res.status(400).json({ error: "URL is required" });

  const key = normalizeAnalyzeCacheUrl(url);
  const cached = getCachedAnalyzeProduct(url);
  if (cached) {
    return res.json({ status: "cached", ready: true, url: key });
  }

  if (!shouldPrewarmAnalyzeUrl(url)) {
    return res.json({ status: "skipped", ready: false, url: key });
  }

  prewarmAnalyzeUrl(url);
  res.json({
    status: analyzePrewarmJobs.has(key) ? "warming" : "skipped",
    ready: false,
    url: key,
  });
});

router.post("/imports/analyze", async (req, res) => {
  const { url, pageText } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });
  const hasSnapshotText =
    typeof pageText === "string" && pageText.trim().length > 0;

  try {
    const snapshotText = hasSnapshotText ? pageText.trim() : "";
    if (!snapshotText && isNextListingUrl(url)) {
      const discovery = await discoverNextListingProducts(url);
      discovery.candidates.slice(0, 6).forEach((candidate) => {
        prewarmAnalyzeUrl(candidate.url);
      });

      return res.json({
        source: {
          supplier: "Next",
          url,
          productId: "category",
        },
        title: "Next category page detected",
        description:
          "This is a listing page, not a single product page. Choose one product below and Syncly will analyze that product directly.",
        brand: "Next",
        currency: "AED",
        price: 0,
        images: [],
        options: [],
        variants: [],
        raw: {
          categoryDiscovery: true,
          categoryUrl: url,
          pagesVisited: discovery.pagesVisited,
          productCandidates: discovery.candidates,
        },
        categoryCandidates: discovery.candidates,
      });
    }

    let data = !snapshotText ? getCachedAnalyzeProduct(url) : undefined;
    if (data && !productSupplierMatchesUrl(url, data)) {
      data = undefined;
    }

    if (!data && !snapshotText) {
      data = await waitForAnalyzePrewarm(url);
      if (data && !productSupplierMatchesUrl(url, data)) {
        data = undefined;
      }
    }

    if (!data && !snapshotText) {
      const cacheMs = getAnalyzeCacheMs();
      const cachedSourceProduct =
        cacheMs > 0
          ? await findStoredSourceProductByUrl(url, { maxAgeMs: cacheMs }).catch(
              (error) => {
                console.warn(
                  "Analyze DB cache lookup failed:",
                  error instanceof Error ? error.message : error,
                );
                return null;
              },
            )
          : null;

      if (cachedSourceProduct) {
        const cachedProduct = sourceProductToNormalizedProduct(cachedSourceProduct);
        if (
          productSupplierMatchesUrl(url, cachedProduct) &&
          isUsableAnalyzeProduct(cachedProduct)
        ) {
          data = cachedProduct;
          setCachedAnalyzeProduct(url, data);
        }
      }
    }

      if (!data) {
        if (snapshotText) {
          data = await scraperService.scrapeSnapshot(url, snapshotText);
          if (!productSupplierMatchesUrl(url, data)) {
            const expected = expectedSupplierForUrl(url) || "the target supplier";
            throw Object.assign(
              new Error(
                `Snapshot text does not match this URL. Open the same product page (${expected}), copy its visible text, then analyze again.`,
              ),
              {
                status: 422,
                code: "SNAPSHOT_MISMATCH",
                retryWithSnapshot: true,
                supplier: expected,
              },
            );
          }
        } else {
          try {
            data = await scraperService.scrape(url);
        } catch (error) {
          if (!isSnapshotRequiredError(error)) throw error;

          const staleSourceProduct = await findStoredSourceProductByUrl(
            url,
          ).catch((dbError) => {
            console.warn(
              "Analyze stale DB fallback failed:",
              dbError instanceof Error ? dbError.message : dbError,
            );
            return null;
          });
          if (!staleSourceProduct) throw error;

          const staleProduct = sourceProductToNormalizedProduct(staleSourceProduct);
          if (!productSupplierMatchesUrl(url, staleProduct)) throw error;
          if (!isUsableAnalyzeProduct(staleProduct)) throw error;
          data = staleProduct;
          data.raw = {
            ...(data.raw || {}),
            staleCacheFallback: true,
            staleCacheSourceProductId: staleSourceProduct.id,
            staleCacheLastScrapedAt:
              staleSourceProduct.lastScrapedAt?.toISOString() || null,
            staleCacheReason:
              "Live source blocked. Used last known cached product snapshot for fast pricing continuity.",
          };
        }
      }
      if (!snapshotText) setCachedAnalyzeProduct(url, data);
    }

    const rule = await findBestPricingRuleForProduct(data);

    const calculatedPrice = rule
      ? PricingEngine.calculatePrice(data.price, rule)
      : data.price;
    const variants = data.variants.map((variant: any) => {
      const sourcePrice = variant.price || data.price;
      return {
        ...variant,
        price: sourcePrice,
        currency: variant.currency || data.currency,
        calculatedPrice: rule
          ? PricingEngine.calculatePrice(sourcePrice, rule)
          : sourcePrice,
      };
    });

    res.json({
      ...data,
      variants,
      calculatedPrice,
      pricingRule: rule,
    });
  } catch (error: any) {
    if (error?.retryWithSnapshot) {
      const bridge = localBridgeIsOperational();
      const bridgeTask = !hasSnapshotText ? getOrCreateLocalBridgeTask(url) : null;
      return res.json({
        blocked: true,
        error: error.message || "Source requires browser page snapshot.",
        code: error.code,
        supplier: error.supplier,
        retryWithSnapshot: true,
        details: error.details,
        bridge: {
          enabled: bridge.enabled,
          reason: bridge.reason,
          taskId: bridgeTask?.id || null,
          status: bridgeTask?.status || null,
        },
      });
    }

    res.status(error.status || 422).json({
      error: error.message || "Failed to analyze product URL",
      code: error.code,
      supplier: error.supplier,
      retryWithSnapshot: error.retryWithSnapshot,
      details: error.details,
    });
  }
});

// Products
router.get("/products/stats", async (req, res) => {
  const [totalLinked, activeSync] = await Promise.all([
    prisma.sourceProduct.count({
      where: {
        shopifyProduct: { isNot: null },
      },
    }),
    prisma.sourceProduct.count({
      where: {
        syncStatus: "active",
        shopifyProduct: { isNot: null },
      },
    }),
  ]);

  res.json({
    totalLinked,
    activeSync,
  });
});

router.get("/products", async (req, res) => {
  const { collectionId } = req.query;
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(500, Math.max(20, Math.floor(limitRaw)))
    : 160;

  const where: any = {};
  if (collectionId) {
    where.shopifyProduct = {
      collectionIds: {
        contains: collectionId as string,
      },
    };
  }

  const products = await prisma.sourceProduct.findMany({
    where,
    select: {
      id: true,
      url: true,
      title: true,
      currency: true,
      price: true,
      syncStatus: true,
      updatedAt: true,
      lastScrapedAt: true,
      raw: true,
      supplier: {
        select: {
          id: true,
          name: true,
        },
      },
      shopifyProduct: {
        select: {
          id: true,
          shopifyId: true,
          price: true,
          status: true,
          collectionIds: true,
          syncEnabled: true,
          syncPrice: true,
          syncInventory: true,
          syncImages: true,
          outOfStockAction: true,
        },
      },
      images: {
        orderBy: { position: "asc" },
        take: 1,
        select: {
          id: true,
          url: true,
          alt: true,
          color: true,
          position: true,
        },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
  });
  const response = products.map((product: any) => {
    const excelRowNumber = extractExcelRowNumberFromRaw(product.raw);
    const { raw, ...rest } = product;
    return {
      ...rest,
      excelRowNumber,
    };
  });
  res.json(response);
});

router.post("/products/cleanup-integrity", async (req, res) => {
  try {
    const dryRun = req.body?.dryRun === true;
    const limitRaw = Number(req.body?.limit);
    const result = await cleanupCatalogIntegrity({
      dryRun,
      limit: Number.isFinite(limitRaw) ? Math.floor(limitRaw) : undefined,
    });
    res.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({
      error: error.message || "Failed to cleanup catalog integrity",
      code: error.code || "CATALOG_CLEANUP_FAILED",
    });
  }
});

router.get("/products/:id", async (req, res) => {
  const product = await prisma.sourceProduct.findUnique({
    where: { id: req.params.id },
    include: {
      variants: true,
      images: true,
      shopifyProduct: {
        include: { variants: true },
      },
      supplier: true,
      auditLogs: { orderBy: { createdAt: "desc" }, take: 10 },
    },
  });
  if (!product) return res.status(404).json({ error: "Product not found" });
  res.json({
    ...product,
    excelRowNumber: extractExcelRowNumberFromRaw((product as any).raw),
  });
});

router.delete("/products/:id", async (req, res) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const product = await tx.sourceProduct.findUnique({
        where: { id: req.params.id },
        include: {
          variants: { select: { id: true } },
          shopifyProduct: { select: { id: true, shopifyId: true } },
        },
      });

      if (!product) {
        throw Object.assign(new Error("Product not found"), {
          statusCode: 404,
        });
      }

      const sourceVariantIds = product.variants.map((variant) => variant.id);
      if (product.shopifyProduct) {
        await tx.shopifyVariant.deleteMany({
          where: { shopifyProductId: product.shopifyProduct.id },
        });
      } else if (sourceVariantIds.length > 0) {
        await tx.shopifyVariant.deleteMany({
          where: { sourceVariantId: { in: sourceVariantIds } },
        });
      }

      await tx.shopifyProduct.deleteMany({
        where: { sourceProductId: product.id },
      });
      await tx.manualReviewItem.deleteMany({
        where: { sourceProductId: product.id },
      });
      await tx.auditLog.deleteMany({ where: { sourceProductId: product.id } });
      await tx.sourceImage.deleteMany({
        where: { sourceProductId: product.id },
      });
      await tx.sourceVariant.deleteMany({
        where: { sourceProductId: product.id },
      });
      await tx.sourceProduct.delete({ where: { id: product.id } });

      return {
        deletedProductId: product.id,
        shopifyProductId: product.shopifyProduct?.shopifyId || null,
      };
    });

    res.json({
      success: true,
      ...result,
      shopifyDeleted: false,
    });
  } catch (error: any) {
    res
      .status(error.statusCode || 500)
      .json({ error: error.message || "Failed to delete product" });
  }
});

// Pricing Rules
router.get("/pricing-rules", async (req, res) => {
  const rules = await prisma.pricingRule.findMany({
    orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
  });
  res.json(rules);
});

router.post("/pricing-rules", async (req, res) => {
  try {
    const data = normalizePricingRuleInput(req.body);
    const rule = await prisma.$transaction(async (tx) => {
      if (data.isDefault) {
        await tx.pricingRule.updateMany({ data: { isDefault: false } });
      }

      return tx.pricingRule.create({ data });
    });

    res.json(rule);
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.patch("/pricing-rules/:id", async (req, res) => {
  try {
    const data = normalizePricingRuleInput(req.body);
    const rule = await prisma.$transaction(async (tx) => {
      if (data.isDefault) {
        await tx.pricingRule.updateMany({
          where: { NOT: { id: req.params.id } },
          data: { isDefault: false },
        });
      }

      return tx.pricingRule.update({
        where: { id: req.params.id },
        data,
      });
    });

    res.json(rule);
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.delete("/pricing-rules/:id", async (req, res) => {
  try {
    await prisma.pricingRule.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(404).json({ error: error.message || "Pricing rule not found" });
  }
});

// Suppliers
router.get("/suppliers", async (req, res) => {
  const suppliers = await prisma.supplier.findMany({
    orderBy: { name: "asc" },
  });
  res.json(suppliers);
});

// Sync Jobs
router.get("/sync-jobs", async (req, res) => {
  const jobs = await prisma.syncJob.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.json(jobs);
});

// Publishing
router.post("/imports/excel/process-sheet-link", async (req, res) => {
  const sheetUrl = String(req.body?.sheetUrl || "").trim();
  const pricingRuleId = asOptionalString(req.body?.pricingRuleId);
  const rowNumbers = Array.isArray(req.body?.rowNumbers)
    ? req.body.rowNumbers
        .map((value: any) => Number(value))
        .filter((value: number) => Number.isFinite(value))
        .map((value: number) => Math.max(1, Math.floor(value)))
    : [];
  const collections = Array.isArray(req.body?.collections)
    ? req.body.collections
    : [];
  const createManualReview = req.body?.createManualReview !== false;
  const processOnlyNewRows = req.body?.processOnlyNewRows === true;
  const waitForPublishCompletion = req.body?.waitForPublishCompletion !== false;

  if (!sheetUrl) {
    return res.status(400).json({ error: "sheetUrl is required" });
  }

  try {
    const result = await processGoogleSheetBatch({
      sheetUrl,
      pricingRuleId,
      rowNumbers,
      defaultCollections: collections,
      createManualReview,
      processOnlyNewRows,
      waitForPublishCompletion,
      mode: processOnlyNewRows ? "auto_sync" : "sheet_link",
    });
    res.json(result);
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.get("/imports/excel/auto-sync/status", async (req, res) => {
  res.json({
    ...googleSheetAutoSyncState,
    running: Boolean(googleSheetAutoSyncTimer),
  });
});

router.post("/imports/excel/auto-sync/start", async (req, res) => {
  const sheetUrl = String(req.body?.sheetUrl || "").trim();
  const pricingRuleId = asOptionalString(req.body?.pricingRuleId);
  const collections = Array.isArray(req.body?.collections)
    ? req.body.collections.map((value: any) => String(value || "").trim()).filter(Boolean)
    : [];
  const createManualReview = req.body?.createManualReview !== false;
  const intervalSecondsRaw = Number(req.body?.intervalSeconds);
  const intervalSeconds = Number.isFinite(intervalSecondsRaw)
    ? Math.max(20, Math.floor(intervalSecondsRaw))
    : DEFAULT_GOOGLE_SHEET_AUTO_SYNC_INTERVAL_SECONDS;

  if (!sheetUrl) {
    return res.status(400).json({ error: "sheetUrl is required" });
  }

  const run = async () => {
    if (googleSheetAutoSyncState.inProgress) {
      console.warn("Google Sheet auto sync skipped an overlapping interval");
      return;
    }

    googleSheetAutoSyncState.inProgress = true;
    googleSheetAutoSyncState.currentRunStartedAt = new Date().toISOString();
    try {
      const result = await processGoogleSheetBatch({
        sheetUrl,
        pricingRuleId,
        defaultCollections: collections,
        createManualReview,
        processOnlyNewRows: true,
        waitForPublishCompletion: false,
        mode: "auto_sync",
      });
      googleSheetAutoSyncState.lastRunAt = new Date().toISOString();
      googleSheetAutoSyncState.lastResult = result.summary;
      googleSheetAutoSyncState.lastError = null;
      googleSheetAutoSyncState.lastBatchId = result.batchId || null;
    } catch (error: any) {
      googleSheetAutoSyncState.lastRunAt = new Date().toISOString();
      googleSheetAutoSyncState.lastError = error?.message || "Auto sync failed";
      googleSheetAutoSyncState.lastBatchId = null;
    } finally {
      googleSheetAutoSyncState.inProgress = false;
      googleSheetAutoSyncState.currentRunStartedAt = null;
    }
  };

  if (googleSheetAutoSyncTimer) {
    clearInterval(googleSheetAutoSyncTimer);
    googleSheetAutoSyncTimer = null;
  }

  googleSheetAutoSyncState.running = true;
  googleSheetAutoSyncState.inProgress = false;
  googleSheetAutoSyncState.currentRunStartedAt = null;
  googleSheetAutoSyncState.sheetUrl = sheetUrl;
  googleSheetAutoSyncState.csvUrl = normalizeGoogleSheetUrl(sheetUrl);
  googleSheetAutoSyncState.intervalSeconds = intervalSeconds;
  googleSheetAutoSyncState.pricingRuleId = pricingRuleId;
  googleSheetAutoSyncState.defaultCollections = collections;
  googleSheetAutoSyncState.createManualReview = createManualReview;
  googleSheetAutoSyncState.lastError = null;
  googleSheetAutoSyncState.lastBatchId = null;

  void run();
  googleSheetAutoSyncTimer = setInterval(() => {
    void run();
  }, intervalSeconds * 1000);
  (googleSheetAutoSyncTimer as any).unref?.();

  res.json({
    success: true,
    message: "Google Sheet auto sync started",
    state: {
      ...googleSheetAutoSyncState,
      running: true,
    },
  });
});

router.post("/imports/excel/auto-sync/stop", async (req, res) => {
  if (googleSheetAutoSyncTimer) {
    clearInterval(googleSheetAutoSyncTimer);
    googleSheetAutoSyncTimer = null;
  }

  googleSheetAutoSyncState.running = false;
  res.json({
    success: true,
    message: "Google Sheet auto sync stopped",
    state: {
      ...googleSheetAutoSyncState,
      running: false,
    },
  });
});

router.get("/imports/excel/runs", async (req, res) => {
  const takeRaw = Number(req.query.take);
  const take = Number.isFinite(takeRaw) ? Math.min(200, Math.max(1, Math.floor(takeRaw))) : 50;

  const runs = await prisma.importBatch.findMany({
    where: { target: "excel_sheet" },
    orderBy: { createdAt: "desc" },
    take,
  });

  const response = runs.map((run) => {
    const payload = parseImportBatchPayload(run.payloadJson);
    return {
      id: run.id,
      status: run.status,
      target: run.target,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      mode: payload.mode || "unknown",
      sheetUrl: payload.sheetUrl || null,
      csvUrl: payload.csvUrl || null,
      summary: payload.summary || {},
      metadata: payload.metadata || {},
      successfulCount: Array.isArray(payload.successful) ? payload.successful.length : 0,
      skippedCount: Array.isArray(payload.skipped) ? payload.skipped.length : 0,
      failedCount: Array.isArray(payload.failed) ? payload.failed.length : 0,
    };
  });

  res.json(response);
});

router.get("/imports/excel/runs/:id", async (req, res) => {
  const run = await prisma.importBatch.findUnique({
    where: { id: req.params.id },
  });
  if (!run || run.target !== "excel_sheet") {
    return res.status(404).json({ error: "Excel run not found" });
  }

  const payload = parseImportBatchPayload(run.payloadJson);
  res.json({
    id: run.id,
    status: run.status,
    target: run.target,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    mode: payload.mode || "unknown",
    sheetUrl: payload.sheetUrl || null,
    csvUrl: payload.csvUrl || null,
    summary: payload.summary || {},
    metadata: payload.metadata || {},
    successful: Array.isArray(payload.successful) ? payload.successful : [],
    skipped: Array.isArray(payload.skipped) ? payload.skipped : [],
    failed: Array.isArray(payload.failed) ? payload.failed : [],
  });
});

router.post("/imports/excel/process", async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const selectedPricingRuleId = asOptionalString(req.body?.pricingRuleId);
  const collections = Array.isArray(req.body?.collections)
    ? req.body.collections.map((value: any) => String(value || "").trim()).filter(Boolean)
    : [];
  const createManualReview = req.body?.createManualReview !== false;
  const waitForPublishCompletion = req.body?.waitForPublishCompletion !== false;
  const maxRows = Math.max(1, envNumber("EXCEL_IMPORT_MAX_ROWS", 300));

  if (rows.length === 0) {
    return res.status(400).json({ error: "rows is required" });
  }
  if (rows.length > maxRows) {
    return res.status(400).json({
      error: `Excel import allows up to ${maxRows} rows per batch.`,
    });
  }

  try {
    await ensureShopifyConnection();
    if (selectedPricingRuleId) {
      const ruleExists = await prisma.pricingRule.findUnique({
        where: { id: selectedPricingRuleId },
        select: { id: true },
      });
      if (!ruleExists) {
        return res.status(400).json({ error: "Selected pricing rule was not found" });
      }
    }

    const successful: Array<{
      rowNumber: number;
      url: string;
      sourceProductId: string;
      jobId: string;
      verification?: {
        shopifyId: string;
        variantsExpected?: number;
        variantsCreated?: number;
        variantsLinked?: number;
        variantImagesRequested?: number;
        variantImagesLinked?: number;
        salesChannelsPublished?: number;
      };
    }> = [];
    const skipped: Array<{
      rowNumber: number;
      url: string;
      reason: string;
      sourceProductId?: string;
    }> = [];
    const failed: Array<{
      rowNumber: number;
      url: string;
      reason: string;
      sourceProductId?: string;
      manualReviewId?: string;
    }> = [];
    const processedUrls = new Set<string>();

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index] || {};
      const rowNumberRaw = Number(row?.rowNumber);
      const rowNumber = Number.isFinite(rowNumberRaw)
        ? Math.max(1, Math.floor(rowNumberRaw))
        : index + 2;
      const rawUrl = String(row?.url || "").trim();
      const normalizedUrl = normalizeAnalyzeCacheUrl(rawUrl);

      const registerFailure = async (reason: string) => {
        let review: { sourceProductId: string; manualReviewId: string } | null = null;
        if (createManualReview && normalizedUrl) {
          try {
            review = await createManualReviewIssueForExcel({
              url: normalizedUrl,
              rowNumber,
              reason,
            });
          } catch (reviewError) {
            console.warn(
              "Manual review auto-create failed:",
              reviewError instanceof Error ? reviewError.message : reviewError,
            );
          }
        }

        failed.push({
          rowNumber,
          url: normalizedUrl || rawUrl,
          reason: normalizeManualReviewReason(reason),
          sourceProductId: review?.sourceProductId,
          manualReviewId: review?.manualReviewId,
        });
      };

      if (!rawUrl) {
        await registerFailure("Missing product URL");
        continue;
      }
      if (!isHttpUrl(rawUrl)) {
        await registerFailure("Invalid product URL");
        continue;
      }
      if (processedUrls.has(normalizedUrl)) {
        await registerFailure("Duplicate URL inside the same Excel batch");
        continue;
      }
      processedUrls.add(normalizedUrl);

      try {
        const analyzed = await scrapeWithBridgeFallback(normalizedUrl);
        analyzed.importMeta = {
          excelRowNumber: rowNumber,
          mode: "file_upload",
        };
        setCachedAnalyzeProduct(normalizedUrl, analyzed);
        const publishResult = await publishPreparedProductToQueue({
          productData: analyzed,
          pricingRuleId: selectedPricingRuleId,
          collections,
        });

        let verification:
          | {
              shopifyId: string;
              variantsExpected?: number;
              variantsCreated?: number;
              variantsLinked?: number;
              variantImagesRequested?: number;
              variantImagesLinked?: number;
              salesChannelsPublished?: number;
            }
          | undefined;
        if (waitForPublishCompletion) {
          const publishJob = await waitForSyncJobCompletion(publishResult.jobId);
          if (publishJob.status === "failed") {
            const reason =
              String(publishJob.parsedResult?.error || "").trim() ||
              `Shopify publish job failed (${publishResult.jobId})`;
            throw new Error(reason);
          }

          verifyPublishJobResult(publishJob.parsedResult || {});
          verification = {
            shopifyId: String(publishJob.parsedResult?.shopifyId || ""),
            variantsExpected: Number(publishJob.parsedResult?.variantsExpected),
            variantsCreated: Number(publishJob.parsedResult?.variantsCreated),
            variantsLinked: Number(publishJob.parsedResult?.variantsLinked),
            variantImagesRequested: Number(
              publishJob.parsedResult?.variantImagesRequested,
            ),
            variantImagesLinked: Number(
              publishJob.parsedResult?.variantImagesLinked,
            ),
            salesChannelsPublished: Number(
              publishJob.parsedResult?.salesChannelsPublished,
            ),
          };
        }

          successful.push({
          rowNumber,
          url: normalizedUrl,
          sourceProductId: publishResult.sourceProductId,
          jobId: publishResult.jobId,
          ...(verification ? { verification } : {}),
        });
      } catch (error: any) {
        const reason = error?.message || "Failed to analyze or publish this URL";
        if (isAlreadyLinkedToShopifyMessage(reason)) {
          const existing = await prisma.sourceProduct.findUnique({
            where: { url: normalizedUrl },
            select: { id: true },
          });
          if (existing?.id) {
            await upsertSourceProductExcelImportMeta(normalizedUrl, {
              excelRowNumber: rowNumber,
              mode: "file_upload",
            });
          }
          skipped.push({
            rowNumber,
            url: normalizedUrl || rawUrl,
            reason,
            sourceProductId: existing?.id,
          });
        } else {
          await registerFailure(reason);
        }
      }
    }

    const summary = {
      total: rows.length,
      processedRows: rows.length,
      processedNewRows: rows.length,
      published: successful.length,
      skipped: skipped.length,
      failed: failed.length,
      manualReviewCreated: failed.filter((entry) => entry.manualReviewId).length,
    };

    const batch = await saveExcelImportRun({
      mode: "file_upload",
      summary,
      successful,
      skipped,
      failed,
      metadata: {
        pricingRuleId: selectedPricingRuleId,
        collections,
      },
    });

    return res.json({
      success: true,
      summary,
      successful,
      skipped,
      failed,
      batchId: batch.id,
      batchStatus: batch.status,
      batchCreatedAt: batch.createdAt.toISOString(),
    });
  } catch (error: any) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.post("/imports/publish", async (req, res) => {
  const { productData, pricingRuleId, collections } = req.body;
  if (!productData)
    return res.status(400).json({ error: "Product data is required" });
  if (!productData.source?.url)
    return res.status(400).json({ error: "Product source URL is required" });

  try {
    await ensureShopifyConnection();
    const queued = await publishPreparedProductToQueue({
      productData,
      pricingRuleId,
      collections,
    });

    res.json({
      success: true,
      productId: queued.sourceProductId,
      jobId: queued.jobId,
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Sync execution
router.post("/products/:id/sync", async (req, res) => {
  const product = await prisma.sourceProduct.findUnique({
    where: { id: req.params.id },
    select: {
      id: true,
      shopifyProduct: { select: { id: true } },
    },
  });

  if (!product) {
    return res.status(404).json({ error: "Product not found" });
  }
  if (!product.shopifyProduct) {
    return res.status(409).json({
      error:
        "Product is not linked to Shopify yet. Publish it to Shopify before running Sync Now.",
    });
  }

  const job = await QueueService.addTask("SYNC_PRODUCT", {
    sourceProductId: req.params.id,
  });
  res.json({ success: true, jobId: job.id });
});

router.post("/products/:id/republish", async (req, res) => {
  const product = await prisma.sourceProduct.findUnique({
    where: { id: req.params.id },
    select: { id: true },
  });

  if (!product) {
    return res.status(404).json({ error: "Product not found" });
  }

  const connection = await prisma.shopifyConnection.findFirst({
    where: { isConnected: true },
    select: { accessTokenEnc: true },
  });

  if (!connection?.accessTokenEnc) {
    return res
      .status(400)
      .json({ error: "Connect Shopify before republishing products." });
  }

  const job = await QueueService.addTask("REPUBLISH_TO_SHOPIFY", {
    sourceProductId: req.params.id,
  });
  res.json({ success: true, jobId: job.id });
});

router.patch("/products/:id", async (req, res) => {
  const { syncStatus } = req.body;
  if (!syncStatus) return res.status(400).json({ error: "Missing syncStatus" });

  const product = await prisma.sourceProduct.update({
    where: { id: req.params.id },
    data: { syncStatus },
  });
  res.json(product);
});

router.delete("/products/:id", async (req, res) => {
  try {
    const product = await prisma.sourceProduct.findUnique({
      where: { id: req.params.id },
      include: { shopifyProduct: true },
    });

    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    // Delete related records first (cascade)
    await prisma.$transaction([
      prisma.auditLog.deleteMany({ where: { sourceProductId: req.params.id } }),
      prisma.sourceImage.deleteMany({
        where: { sourceProductId: req.params.id },
      }),
      prisma.sourceVariant.deleteMany({
        where: { sourceProductId: req.params.id },
      }),
      prisma.manualReviewItem.deleteMany({
        where: { sourceProductId: req.params.id },
      }),
      ...(product.shopifyProduct
        ? [
            prisma.shopifyVariant.deleteMany({
              where: { shopifyProductId: product.shopifyProduct.id },
            }),
            prisma.shopifyProduct.delete({
              where: { id: product.shopifyProduct.id },
            }),
          ]
        : []),
      prisma.sourceProduct.delete({ where: { id: req.params.id } }),
    ]);

    res.json({ success: true, message: "Product deleted successfully" });
  } catch (error: any) {
    console.error("Delete product error:", error);
    res
      .status(500)
      .json({ error: error.message || "Failed to delete product" });
  }
});

// Manual Review
router.get("/manual-review", async (req, res) => {
  const items = await prisma.manualReviewItem.findMany({
    where: { status: "pending" },
    include: { sourceProduct: { include: { supplier: true } } },
  });
  const response = items.map((item: any) => {
    const fromRaw = extractExcelRowNumberFromRaw(item?.sourceProduct?.raw);
    const fromReason = extractExcelRowNumberFromReason(item?.reason);
    return {
      ...item,
      excelRowNumber: fromRaw ?? fromReason,
    };
  });
  res.json(response);
});

// Manual Review resolution
router.post("/manual-review/:id/:decision", async (req, res) => {
  const { id, decision } = req.params;
  const status = decision === "approve" ? "approved" : "rejected";

  await prisma.manualReviewItem.update({
    where: { id },
    data: { status, resolvedAt: new Date() },
  });

  res.json({ success: true });
});

// Settings - Shopify Connection
router.get("/settings/shopify", async (req, res) => {
  try {
    const connection = await prisma.shopifyConnection.findFirst();
    if (!connection) {
      return res.json({
        shopDomain: "",
        clientId: "",
        clientSecret: "",
        hasClientSecret: false,
        accessToken: "Not Connected",
        scopes: DEFAULT_SHOPIFY_SCOPES,
        isConnected: false,
        connectedAt: null,
        callbackUrl: getShopifyRedirectUri(req),
        apiVersion: process.env.SHOPIFY_API_VERSION || "2026-04",
      });
    }

    const tokenNeedsReconnect = Boolean(
      connection.accessTokenEnc &&
      (() => {
        try {
          decrypt(connection.accessTokenEnc);
          return false;
        } catch (error) {
          return isDecryptionError(error);
        }
      })(),
    );
    const connected = Boolean(
      connection.isConnected &&
      connection.accessTokenEnc &&
      !tokenNeedsReconnect,
    );

    res.json({
      shopDomain: connection.shopDomain,
      clientId: connection.clientId,
      clientSecret: "****************",
      hasClientSecret: Boolean(connection.clientSecretEnc),
      accessToken: connected
        ? "Connected"
        : tokenNeedsReconnect
          ? "Reconnect Required"
          : "Not Connected",
      scopes: connection.scopes.split(","),
      isConnected: connected,
      connectedAt: connection.connectedAt,
      reconnectRequired: tokenNeedsReconnect,
      callbackUrl: getShopifyRedirectUri(req),
      apiVersion: process.env.SHOPIFY_API_VERSION || "2026-04",
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

router.post("/settings/shopify", async (req, res) => {
  const { shopDomain, clientId, clientSecret, scopes } = req.body;

  if (!shopDomain || !clientId) {
    return res
      .status(400)
      .json({ error: "Missing required configuration fields" });
  }

  try {
    const normalizedShopDomain = assertShopDomain(shopDomain);
    const cleanClientId = String(clientId).trim();
    const cleanClientSecret = String(clientSecret || "").trim();
    const scopesStr = normalizeScopes(scopes).join(",");
    const existing = await prisma.shopifyConnection.findUnique({
      where: { shopDomain: normalizedShopDomain },
    });

    if (!existing && !cleanClientSecret) {
      return res.status(400).json({
        error: "Client secret is required for a new Shopify connection",
      });
    }

    const credentialsChanged = Boolean(
      existing &&
      (existing.clientId !== cleanClientId ||
        existing.scopes !== scopesStr ||
        cleanClientSecret),
    );
    const encryptedSecret = cleanClientSecret
      ? encrypt(cleanClientSecret)
      : existing?.clientSecretEnc;

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
        updatedAt: new Date(),
      },
      create: {
        shopDomain: normalizedShopDomain,
        clientId: cleanClientId,
        clientSecretEnc: encryptedSecret!,
        scopes: scopesStr,
      },
    });

    res.json({ success: true, callbackUrl: getShopifyRedirectUri(req) });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.post("/settings/shopify/test", async (req, res) => {
  const { shopDomain } = req.body;
  if (!shopDomain)
    return res.status(400).json({ error: "Shop domain required" });

  try {
    const normalizedShopDomain = assertShopDomain(shopDomain);
    // Simple reachability test
    await axios.get(`https://${normalizedShopDomain}/admin`, {
      timeout: 5000,
      maxRedirects: 0,
      validateStatus: (status) => status < 500,
    });
    res.json({ success: true, message: "Shopify domain is reachable" });
  } catch (error: any) {
    if (
      error.response?.status === 302 ||
      error.response?.status === 200 ||
      error.response?.status === 401
    ) {
      // 401 means reachable but unauthorized, which is expected for /admin without token
      return res.json({
        success: true,
        message: "Shopify domain is reachable",
      });
    }
    res.status(error.statusCode || 400).json({
      error:
        error.message ||
        "Could not reach Shopify domain. Please check the URL.",
    });
  }
});

router.post("/shopify/connect", async (req, res) => {
  try {
    const connection = await prisma.shopifyConnection.findFirst();
    if (!connection)
      return res
        .status(400)
        .json({ error: "Shopify connection not configured" });
    if (!connection.clientSecretEnc)
      return res
        .status(400)
        .json({ error: "Shopify client secret is missing" });

    let clientSecret = "";
    try {
      clientSecret = decrypt(connection.clientSecretEnc);
    } catch (error) {
      if (isDecryptionError(error)) {
        await prisma.shopifyConnection.update({
          where: { id: connection.id },
          data: {
            accessTokenEnc: null,
            isConnected: false,
            connectedAt: null,
            oauthState: null,
            oauthStateExpiresAt: null,
          },
        });
        return res.status(409).json({
          error:
            "Saved Shopify secret cannot be decrypted. Re-save the client secret, then connect again.",
          code: "SHOPIFY_SECRET_RECONNECT_REQUIRED",
        });
      }
      throw error;
    }

    const state = crypto.randomBytes(16).toString("hex");
    const redirectUri = getShopifyRedirectUri(req);
    const oauthUrl = new URL(
      `https://${connection.shopDomain}/admin/oauth/authorize`,
    );
    oauthUrl.searchParams.set("client_id", connection.clientId);
    oauthUrl.searchParams.set("scope", connection.scopes);
    oauthUrl.searchParams.set("redirect_uri", redirectUri);
    oauthUrl.searchParams.set("state", state);

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

router.get("/shopify/callback", async (req, res) => {
  const code = firstQueryValue(req.query.code);
  const state = firstQueryValue(req.query.state);
  const shop = normalizeShopDomain(req.query.shop);

  if (!code || !shop || !state) return res.status(400).send("Invalid callback");

  try {
    const shopDomain = assertShopDomain(shop);
    const connection = await prisma.shopifyConnection.findUnique({
      where: { shopDomain },
    });
    if (!connection) return res.status(404).send("Connection not found");

    const clientSecret = decrypt(connection.clientSecretEnc);
    const stateExpired =
      !connection.oauthStateExpiresAt ||
      connection.oauthStateExpiresAt < new Date();
    if (
      !connection.oauthState ||
      connection.oauthState !== state ||
      stateExpired
    ) {
      return res.status(400).send("Invalid or expired OAuth state");
    }

    if (!verifyShopifyHmac(req.query, clientSecret)) {
      return res.status(400).send("Invalid Shopify callback signature");
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
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
      },
    );

    const { access_token, scope } = response.data;
    if (!access_token)
      throw new Error("Shopify did not return an access token");

    await prisma.shopifyConnection.update({
      where: { id: connection.id },
      data: {
        accessTokenEnc: encrypt(access_token),
        scopes: scope || connection.scopes,
        isConnected: true,
        connectedAt: new Date(),
        oauthState: null,
        oauthStateExpiresAt: null,
      },
    });

    redirectToFrontend(req, res, { connected: "true", shop: shopDomain });
  } catch (error: any) {
    console.error("OAuth Error:", error.response?.data || error.message);
    redirectToFrontend(req, res, {
      connected: "false",
      error: "shopify_oauth_failed",
    });
  }
});

router.post("/shopify/disconnect", async (req, res) => {
  try {
    const connection = await prisma.shopifyConnection.findFirst();
    if (!connection) return res.status(404).json({ error: "Not configured" });

    await prisma.shopifyConnection.update({
      where: { id: connection.id },
      data: {
        accessTokenEnc: null,
        isConnected: false,
        connectedAt: null,
        oauthState: null,
        oauthStateExpiresAt: null,
      },
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/shopify/collections", async (req, res) => {
  try {
    const client = await ShopifyService.getClientFromDb(prisma);
    const collections = await ShopifyService.getCollections(client);
    res.json(collections);
  } catch (error: any) {
    if (isShopifyReconnectRequired(error)) {
      return res.json([]);
    }

    if (error.message === "No active Shopify connection found") {
      return res.json([]);
    }

    if (isDatabaseUnavailableError(error)) {
      return res.status(503).json({
        error:
          "Database is currently unavailable or DATABASE_URL is invalid. Check DATABASE_URL format and database reachability.",
        code: "DB_UNAVAILABLE",
      });
    }

    console.error("Failed to load Shopify collections:", error.message);
    res.json([]);
  }
});

wrapAsyncRouterHandlers(router);

router.use((error: any, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const status = getApiErrorStatus(error);
  const code = getApiErrorCode(error);
  const message = getApiErrorMessage(error);

  console.error("API route failed:", {
    method: req.method,
    path: req.originalUrl,
    status,
    code,
    message,
  });

  res.status(status).json({ error: message, code });
});

export default router;
