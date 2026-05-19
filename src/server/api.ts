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
    } else {
      return cloneProduct(cached.product);
    }
  }

  if (!envFlag("SCRAPE_ANALYZE_PERSISTENT_CACHE", true)) return undefined;

  const persisted = analyzeProductPersistentCache.get(key);
  if (!persisted) return undefined;

  analyzeProductCache.set(key, {
    expiresAt: Date.now() + cacheMs,
    product: cloneProduct(persisted),
  });

  return cloneProduct(persisted);
}

function setCachedAnalyzeProduct(url: string, product: NormalizedProduct) {
  const cacheMs = getAnalyzeCacheMs();
  if (cacheMs <= 0) return;
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  try {
    const snapshotText = typeof pageText === "string" ? pageText.trim() : "";
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
        if (productSupplierMatchesUrl(url, cachedProduct)) {
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
      return res.json({
        blocked: true,
        error: error.message || "Source requires browser page snapshot.",
        code: error.code,
        supplier: error.supplier,
        retryWithSnapshot: true,
        details: error.details,
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
router.get("/products", async (req, res) => {
  const { collectionId } = req.query;

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
    include: {
      shopifyProduct: true,
      supplier: true,
      images: { orderBy: { position: "asc" } },
    },
    orderBy: { updatedAt: "desc" },
  });
  res.json(products);
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
  res.json(product);
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
router.post("/imports/publish", async (req, res) => {
  const { productData, pricingRuleId, collections } = req.body;
  if (!productData)
    return res.status(400).json({ error: "Product data is required" });
  if (!productData.source?.url)
    return res.status(400).json({ error: "Product source URL is required" });

  try {
    const sourcePrice = Number(productData.price);
    if (!PricingEngine.validatePrice(sourcePrice)) {
      return res.status(400).json({ error: "Product source price is invalid" });
    }

    const selectedPricingRuleId = asOptionalString(pricingRuleId);
    if (selectedPricingRuleId) {
      const ruleExists = await prisma.pricingRule.findUnique({
        where: { id: selectedPricingRuleId },
        select: { id: true },
      });

      if (!ruleExists) {
        return res
          .status(400)
          .json({ error: "Selected pricing rule was not found" });
      }
    }

    const connection = await prisma.shopifyConnection.findFirst({
      where: { isConnected: true },
      select: { accessTokenEnc: true },
    });

    if (!connection?.accessTokenEnc) {
      return res
        .status(400)
        .json({ error: "Connect Shopify before publishing products." });
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
    const images = normalizeProductImageList(nextSafePayload.images, {
      keepIfAllRejected: false,
      maxImages: 30,
    });
    if (requestedImages.length > 0 && images.length === 0) {
      return res
        .status(400)
        .json({ error: "Selected product images are not valid image URLs" });
    }
    const variants = nextSafePayload.variants;
    const collectionIds = Array.isArray(collections) ? collections : [];

    // 1. Create Source Product record
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
            selectedImageCount: images.length,
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

    // 2. Queue the Shopify push
    const job = await QueueService.addTask("PUBLISH_TO_SHOPIFY", {
      sourceProductId: sourceProduct.id,
      pricingRuleId: selectedPricingRuleId,
      collections: collectionIds,
    });

    res.json({ success: true, productId: sourceProduct.id, jobId: job.id });
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
    include: { sourceProduct: true },
  });
  res.json(items);
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
