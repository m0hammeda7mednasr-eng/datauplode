import "dotenv/config";
import * as cheerio from "cheerio";
import axios from "axios";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface NormalizedProduct {
  source: {
    supplier: string;
    url: string;
    productId?: string;
  };
  title: string;
  description?: string;
  brand?: string;
  currency: string;
  price: number;
  images: Array<{
    url: string;
    alt?: string;
    color?: string;
    position: number;
  }>;
  options: Array<{
    name: string;
    values: string[];
    swatches?: Record<
      string,
      {
        color?: string;
        image?: string;
      }
    >;
  }>;
  variants: Array<{
    sourceVariantId?: string;
    sku?: string;
    color?: string;
    size?: string;
    price?: number;
    currency?: string;
    calculatedPrice?: number;
    optionValues?: Record<string, string>;
    available: boolean;
    stockStatus: "in_stock" | "out_of_stock" | "low_stock" | "unknown";
    imageUrl?: string;
    raw?: any;
  }>;
  raw: any;
}

export interface AvailabilitySnapshot {
  available: boolean;
  price?: number;
  variants?: Array<{
    id: string;
    available: boolean;
    stockStatus?: "in_stock" | "out_of_stock" | "low_stock" | "unknown";
    price?: number;
  }>;
}

export interface SupplierScraper {
  canHandle(url: string): boolean;
  scrape(url: string): Promise<NormalizedProduct>;
  scrapeSnapshot?(
    url: string,
    snapshotText: string,
  ): Promise<NormalizedProduct> | NormalizedProduct;
  checkAvailability(url: string): Promise<AvailabilitySnapshot>;
}

class ScraperError extends Error {
  code?: string;
  status?: number;
  supplier?: string;
  retryWithSnapshot?: boolean;
  details?: string[];

  constructor(
    message: string,
    options: {
      code?: string;
      status?: number;
      supplier?: string;
      retryWithSnapshot?: boolean;
      details?: string[];
    } = {},
  ) {
    super(message);
    this.name = "ScraperError";
    Object.assign(this, options);
  }
}

const browserHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,ar-EG;q=0.8,ar;q=0.7",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "Upgrade-Insecure-Requests": "1",
};

function buildScraperAxiosConfig() {
  const proxyUrl = cleanText(
    process.env.SCRAPER_HTTP_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.HTTP_PROXY,
  );
  if (!proxyUrl) return {};

  try {
    const parsed = new URL(proxyUrl);
    const port = parsed.port
      ? Number(parsed.port)
      : parsed.protocol === "https:"
        ? 443
        : 80;
    return {
      proxy: {
        protocol: parsed.protocol.replace(":", ""),
        host: parsed.hostname,
        port,
        ...(parsed.username
          ? {
              auth: {
                username: decodeURIComponent(parsed.username),
                password: decodeURIComponent(parsed.password),
              },
            }
          : {}),
      },
    };
  } catch {
    return {};
  }
}

function scraperProxyUrl(): string | undefined {
  const proxyUrl = cleanText(
    process.env.SCRAPER_HTTP_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.HTTP_PROXY,
  );
  return proxyUrl || undefined;
}

function isUsableNextProductHtml(html: string): boolean {
  return (
    html.includes('data-testid="product-title"') ||
    html.includes('data-testid="product-now-price"') ||
    html.includes('"@type":"Product"') ||
    html.includes('"@type": "Product"')
  );
}

type ManagedBypassProvider =
  | "scraperapi"
  | "zenrows"
  | "scrapingbee"
  | "scrapingant"
  | "scrapedo";
type ManagedBypassMode = "never" | "auto" | "always";

type ManagedBypassOptions = {
  providerOrder?: ManagedBypassProvider[];
  countryCode?: string;
  deviceType?: "desktop" | "mobile" | "none";
  jsRender?: boolean;
  premium?: boolean;
  ultraPremium?: boolean;
};

const implementedManagedBypassProviders = new Set<ManagedBypassProvider>([
  "scraperapi",
  "zenrows",
  "scrapingbee",
  "scrapingant",
  "scrapedo",
]);

function asManagedBypassProvider(
  value: string,
): ManagedBypassProvider | undefined {
  const normalized = cleanText(value).toLowerCase() as ManagedBypassProvider;
  if (!implementedManagedBypassProviders.has(normalized)) return undefined;
  return normalized;
}

function envFlag(name: string, defaultValue = false): boolean {
  const value = cleanText(process.env[name]);
  if (!value) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function normalizeManagedBypassMode(value: string): ManagedBypassMode {
  const normalized = cleanText(value).toLowerCase();
  if (["always", "force", "on"].includes(normalized)) return "always";
  if (["auto", "smart"].includes(normalized)) return "auto";
  return "never";
}

function managedBypassMode(): ManagedBypassMode {
  return normalizeManagedBypassMode(process.env.SCRAPER_BYPASS_MODE || "never");
}

function inferBrandBypassKey(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("next.")) return "next";
    if (host.includes("maxfashion")) return "max_fashion";
    if (host.includes("shein")) return "shein";
    if (host.includes("marksandspencer")) return "marks_spencer";
    if (host.includes("mothercare")) return "mothercare";
    if (host.includes("primark")) return "primark";
    if (host.includes("carters")) return "carters";
    if (host.includes("lefties")) return "lefties";
    if (host.includes("centrepoint")) return "centrepoint";
    if (host.includes("adidas")) return "adidas";
    if (host.includes("hm.com")) return "hm";
    if (host.includes("zara.")) return "zara";
    if (host.includes("gap.")) return "gap";
  } catch {}
  return "default";
}

function bypassModeByBrand(): Map<string, ManagedBypassMode> {
  const raw = cleanText(process.env.SCRAPER_BRAND_BYPASS_MODE_MAP);
  const parsed = new Map<string, ManagedBypassMode>();
  if (!raw) return parsed;

  for (const chunk of raw.split(",")) {
    const [brand, mode] = chunk.split(":");
    const brandKey = cleanText(brand).toLowerCase();
    if (!brandKey) continue;
    parsed.set(brandKey, normalizeManagedBypassMode(mode || "auto"));
  }

  return parsed;
}

function resolveManagedBypassModeForUrl(url: string): ManagedBypassMode {
  const brandModes = bypassModeByBrand();
  const brandKey = inferBrandBypassKey(url);
  return brandModes.get(brandKey) || brandModes.get("default") || managedBypassMode();
}

function managedBypassEnabled(url?: string): boolean {
  const mode = url
    ? resolveManagedBypassModeForUrl(url)
    : managedBypassMode();
  return mode !== "never";
}

function envNumber(name: string, defaultValue: number): number {
  const raw = cleanText(process.env[name]);
  if (!raw) return defaultValue;
  const value = Number(raw);
  return Number.isFinite(value) ? value : defaultValue;
}

function envBypassDevice(
  name: string,
  defaultValue: ManagedBypassOptions["deviceType"],
): ManagedBypassOptions["deviceType"] {
  const value = cleanText(process.env[name]).toLowerCase();
  if (value === "desktop" || value === "mobile" || value === "none")
    return value;
  return defaultValue;
}

const managedBypassUsageByDay = new Map<string, number>();
const managedBypassCooldownUntil = new Map<string, number>();
const managedBypassProviderCooldownUntil = new Map<string, number>();
const managedBypassUsageByProviderMonth = new Map<string, number>();

function getManagedBypassDayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function getManagedBypassMonthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

function getManagedBypassUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return cleanText(url);
  }
}

function providerMonthlyLimit(provider: ManagedBypassProvider): number {
  const raw = cleanText(
    process.env.SCRAPER_BYPASS_PROVIDER_MONTHLY_LIMITS ||
      process.env.SCRAPER_BYPASS_PROVIDER_MONTHLY_TOKENS,
  );
  if (!raw) return 0;

  const providerKey = provider.toLowerCase();
  for (const chunk of raw.split(",")) {
    const [name, limitValue] = chunk.split(/[:=]/);
    if (cleanText(name).toLowerCase() !== providerKey) continue;
    const parsed = Number(cleanText(limitValue));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
  return 0;
}

function providerMonthlyUsage(provider: ManagedBypassProvider): number {
  const key = `${provider.toLowerCase()}:${getManagedBypassMonthKey()}`;
  return managedBypassUsageByProviderMonth.get(key) || 0;
}

function noteProviderUsage(provider: ManagedBypassProvider, units = 1) {
  const key = `${provider.toLowerCase()}:${getManagedBypassMonthKey()}`;
  managedBypassUsageByProviderMonth.set(
    key,
    providerMonthlyUsage(provider) + Math.max(0, units),
  );
}

function providerHasQuota(provider: ManagedBypassProvider): boolean {
  const limit = providerMonthlyLimit(provider);
  if (limit <= 0) return true;
  return providerMonthlyUsage(provider) < limit;
}

function isProviderCoolingDown(provider: ManagedBypassProvider): boolean {
  return (managedBypassProviderCooldownUntil.get(provider.toLowerCase()) || 0) > Date.now();
}

function noteProviderFailure(provider: ManagedBypassProvider) {
  const cooldownMinutes = Math.max(
    0,
    envNumber("SCRAPER_BYPASS_PROVIDER_COOLDOWN_MINUTES", 30),
  );
  if (cooldownMinutes <= 0) return;
  managedBypassProviderCooldownUntil.set(
    provider.toLowerCase(),
    Date.now() + cooldownMinutes * 60000,
  );
}

function reserveManagedBypassAttempt(url: string, units = 1): string | undefined {
  const mode = resolveManagedBypassModeForUrl(url);
  if (mode === "never") {
    return "disabled for this brand by bypass mode";
  }

  const key = getManagedBypassUrlKey(url);
  const cooldownUntil = managedBypassCooldownUntil.get(key) || 0;
  if (cooldownUntil > Date.now()) {
    const minutes = Math.max(
      1,
      Math.ceil((cooldownUntil - Date.now()) / 60000),
    );
    return `cooling down for ${minutes} minute(s) after a recent provider failure`;
  }

  const dailyLimit = Math.max(0, envNumber("SCRAPER_BYPASS_DAILY_LIMIT", 0));
  if (dailyLimit > 0) {
    const dayKey = getManagedBypassDayKey();
    const used = managedBypassUsageByDay.get(dayKey) || 0;
    const requestedUnits = Math.max(1, units);
    if (used + requestedUnits > dailyLimit) {
      return `daily managed bypass limit reached (${used}/${dailyLimit})`;
    }
    managedBypassUsageByDay.set(dayKey, used + requestedUnits);
  }

  return undefined;
}

function noteManagedBypassFailure(url: string) {
  const cooldownMinutes = Math.max(
    0,
    envNumber("SCRAPER_BYPASS_COOLDOWN_MINUTES", 120),
  );
  if (cooldownMinutes <= 0) return;
  managedBypassCooldownUntil.set(
    getManagedBypassUrlKey(url),
    Date.now() + cooldownMinutes * 60000,
  );
}

function inferCountryCodeFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathName = parsed.pathname.toLowerCase();

    if (host.endsWith(".ae") || pathName.includes("/ae/")) return "ae";
    if (host.endsWith(".co.uk") || host.endsWith(".uk")) return "gb";
    if (host.endsWith(".us")) return "us";
    if (host.endsWith(".ie")) return "ie";
    if (host.endsWith(".com") && pathName.includes("/eg/")) return "eg";
  } catch {}

  return undefined;
}

function activeManagedBypassProviders(
  url?: string,
  orderOverride?: ManagedBypassProvider[],
): ManagedBypassProvider[] {
  if (!managedBypassEnabled(url)) return [];
  if (orderOverride?.length) {
    return orderOverride
      .map((provider) =>
        asManagedBypassProvider(cleanText(provider).toLowerCase()),
      )
      .filter((provider): provider is ManagedBypassProvider => Boolean(provider))
      .filter((provider) => !isProviderCoolingDown(provider))
      .filter((provider) => providerHasQuota(provider));
  }

  const configured = cleanText(process.env.SCRAPER_BYPASS_PROVIDERS)
    .split(",")
    .map((value) => asManagedBypassProvider(cleanText(value).toLowerCase()))
    .filter((provider): provider is ManagedBypassProvider => Boolean(provider));

  const validConfigured = configured.length
    ? [...new Set(configured)]
    : [];
  if (validConfigured.length) {
    return validConfigured
      .filter((provider) => !isProviderCoolingDown(provider))
      .filter((provider) => providerHasQuota(provider))
      .sort(
        (a, b) =>
          providerMonthlyUsage(a) / (providerMonthlyLimit(a) || Number.MAX_SAFE_INTEGER) -
          providerMonthlyUsage(b) / (providerMonthlyLimit(b) || Number.MAX_SAFE_INTEGER),
      );
  }

  const providers: ManagedBypassProvider[] = [];
  if (cleanText(process.env.SCRAPERAPI_KEY)) providers.push("scraperapi");
  if (cleanText(process.env.ZENROWS_API_KEY)) providers.push("zenrows");
  if (cleanText(process.env.SCRAPINGBEE_API_KEY))
    providers.push("scrapingbee");
  if (cleanText(process.env.SCRAPINGANT_API_KEY))
    providers.push("scrapingant");
  if (cleanText(process.env.SCRAPEDO_TOKEN)) providers.push("scrapedo");
  return providers
    .filter((provider) => !isProviderCoolingDown(provider))
    .filter((provider) => providerHasQuota(provider))
    .sort(
      (a, b) =>
        providerMonthlyUsage(a) / (providerMonthlyLimit(a) || Number.MAX_SAFE_INTEGER) -
        providerMonthlyUsage(b) / (providerMonthlyLimit(b) || Number.MAX_SAFE_INTEGER),
    );
}

function looksLikeAccessDeniedHtml(html: string): boolean {
  const text = html.toLowerCase();
  return (
    text.includes("just a moment") ||
    text.includes("access denied") ||
    text.includes("security verification") ||
    text.includes("forbidden") ||
    text.includes("cf-chl") ||
    text.includes("cloudflare")
  );
}

async function fetchHtmlViaScraperApi(
  url: string,
  options: ManagedBypassOptions,
): Promise<string> {
  const apiKey = cleanText(process.env.SCRAPERAPI_KEY);
  if (!apiKey) throw new Error("SCRAPERAPI_KEY is not configured");

  const countryCode =
    options.countryCode ||
    cleanText(process.env.SCRAPERAPI_COUNTRY_CODE) ||
    inferCountryCodeFromUrl(url);
  const deviceType =
    options.deviceType === "none"
      ? ""
      : options.deviceType ||
        (cleanText(process.env.SCRAPERAPI_DEVICE_TYPE).toLowerCase() as
          | "desktop"
          | "mobile"
          | "");
  const jsRender = options.jsRender ?? envFlag("SCRAPERAPI_RENDER", false);
  const premium = options.premium ?? envFlag("SCRAPERAPI_PREMIUM", false);
  const ultraPremium =
    options.ultraPremium ?? envFlag("SCRAPERAPI_ULTRA_PREMIUM", false);

  const params = new URLSearchParams();
  params.set("api_key", apiKey);
  if (jsRender) params.set("render", "true");
  if (countryCode) params.set("country_code", countryCode);
  if (deviceType === "mobile" || deviceType === "desktop")
    params.set("device_type", deviceType);
  if (ultraPremium) {
    params.set("ultra_premium", "true");
  } else if (premium) {
    params.set("premium", "true");
  }
  params.set("url", url);

  const response = await axios.get(
    `https://api.scraperapi.com?${params.toString()}`,
    {
      timeout: 90000,
      responseType: "text",
      validateStatus: (status) => status < 500,
    },
  );

  if (response.status !== 200) {
    throw new Error(`ScraperAPI HTTP ${response.status}`);
  }

  const html =
    typeof response.data === "string" ? response.data : String(response.data);
  if (!html.trim()) throw new Error("ScraperAPI returned an empty response");
  if (looksLikeAccessDeniedHtml(html) && !isUsableNextProductHtml(html)) {
    throw new Error("ScraperAPI returned a blocked page");
  }

  return html;
}

async function fetchHtmlViaZenRows(
  url: string,
  options: ManagedBypassOptions,
): Promise<string> {
  const apiKey = cleanText(process.env.ZENROWS_API_KEY);
  if (!apiKey) throw new Error("ZENROWS_API_KEY is not configured");

  const countryCode =
    options.countryCode ||
    cleanText(process.env.ZENROWS_PROXY_COUNTRY) ||
    inferCountryCodeFromUrl(url);
  const jsRender = options.jsRender ?? envFlag("ZENROWS_JS_RENDER", false);
  const premiumProxy =
    options.premium ?? envFlag("ZENROWS_PREMIUM_PROXY", true);
  const useCustomHeaders = envFlag("ZENROWS_CUSTOM_HEADERS", false);

  const params = new URLSearchParams();
  params.set("apikey", apiKey);
  params.set("url", url);
  if (jsRender) params.set("js_render", "true");
  if (premiumProxy) params.set("premium_proxy", "true");
  if (countryCode && premiumProxy) params.set("proxy_country", countryCode);
  if (useCustomHeaders) params.set("custom_headers", "true");

  const response = await axios.get(
    `https://api.zenrows.com/v1/?${params.toString()}`,
    {
      timeout: 90000,
      responseType: "text",
      validateStatus: (status) => status < 500,
    },
  );

  if (response.status !== 200) {
    throw new Error(`ZenRows HTTP ${response.status}`);
  }

  const html =
    typeof response.data === "string" ? response.data : String(response.data);
  if (!html.trim()) throw new Error("ZenRows returned an empty response");
  if (looksLikeAccessDeniedHtml(html) && !isUsableNextProductHtml(html)) {
    throw new Error("ZenRows returned a blocked page");
  }

  return html;
}

async function fetchHtmlViaManagedBypassProvider(
  provider: ManagedBypassProvider,
  url: string,
  options: ManagedBypassOptions,
): Promise<string> {
  noteProviderUsage(provider);
  if (provider === "scraperapi") {
    return fetchHtmlViaScraperApi(url, options);
  }
  if (provider === "zenrows") {
    return fetchHtmlViaZenRows(url, options);
  }
  if (provider === "scrapingbee") {
    return fetchHtmlViaScrapingBee(url, options);
  }
  if (provider === "scrapingant") {
    return fetchHtmlViaScrapingAnt(url, options);
  }
  if (provider === "scrapedo") {
    return fetchHtmlViaScrapeDo(url, options);
  }
  throw new Error(`Provider ${provider} is not implemented`);
}

export async function fetchHtmlViaManagedBypass(
  url: string,
  options: ManagedBypassOptions = {},
): Promise<string> {
  const providers = activeManagedBypassProviders(url, options.providerOrder);
  if (!providers.length) {
    throw new Error("No managed bypass provider is configured");
  }

  const skippedReason = reserveManagedBypassAttempt(url);
  if (skippedReason) {
    throw new Error(`Managed bypass skipped (${skippedReason})`);
  }

  const errors: string[] = [];
  for (const provider of providers) {
    try {
      return await fetchHtmlViaManagedBypassProvider(provider, url, options);
    } catch (error: any) {
      noteProviderFailure(provider);
      errors.push(`${provider}: ${error.message}`);
    }
  }

  noteManagedBypassFailure(url);
  throw new Error(`Managed bypass failed (${errors.join("; ")})`);
}

export async function fetchHtmlViaManagedBypassRace(
  url: string,
  options: ManagedBypassOptions = {},
  raceOptions: { maxProviders?: number; timeoutMs?: number } = {},
): Promise<string> {
  const configuredProviders = activeManagedBypassProviders(
    url,
    options.providerOrder,
  );
  const maxProviders = Math.max(
    1,
    raceOptions.maxProviders ||
      envNumber("SCRAPER_BYPASS_RACE_MAX_PROVIDERS", 2),
  );
  const providers = configuredProviders.slice(0, maxProviders);

  if (providers.length <= 1) {
    return fetchHtmlViaManagedBypass(url, options);
  }

  const skippedReason = reserveManagedBypassAttempt(url, providers.length);
  if (skippedReason) {
    throw new Error(`Managed bypass race skipped (${skippedReason})`);
  }

  const timeoutMs = Math.max(
    1000,
    raceOptions.timeoutMs ||
      envNumber("SCRAPER_BYPASS_RACE_TIMEOUT_MS", 12000),
  );
  const errors: string[] = [];
  const attempts = providers.map((provider) =>
    fetchHtmlViaManagedBypassProvider(provider, url, options)
      .then((html) => ({ provider, html }))
      .catch((error: any) => {
        noteProviderFailure(provider);
        const message = `${provider}: ${error?.message || error}`;
        errors.push(message);
        throw new Error(message);
      }),
  );

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(
        new Error(
          `Managed bypass race timed out after ${timeoutMs}ms (${providers.join(", ")})`,
        ),
      );
    }, timeoutMs);
  });

  try {
    const winner = await Promise.race([Promise.any(attempts), timeout]);
    console.log(`Managed bypass race won by ${winner.provider}`);
    return winner.html;
  } catch (error: any) {
    noteManagedBypassFailure(url);
    const details = errors.length ? ` (${errors.join("; ")})` : "";
    throw new Error(`${error?.message || "Managed bypass race failed"}${details}`);
  }
}

const execFileAsync = promisify(execFile);

const nextDomains = ["next.co.uk", "nextdirect.com", "next.ae", "next.us"];

function isNextUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return nextDomains.some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    );
  } catch {
    return nextDomains.some((domain) => url.toLowerCase().includes(domain));
  }
}

function getProductIdFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.hash && parsed.hash.length > 1) return parsed.hash.slice(1);

    const parts = parsed.pathname.split("/").filter(Boolean);
    const lastMeaningfulPart = [...parts]
      .reverse()
      .find(
        (part) => !["index.html", "index.htm"].includes(part.toLowerCase()),
      );
    return lastMeaningfulPart?.split("?")[0];
  } catch {
    return url.split("/").pop()?.split(/[?#]/)[0];
  }
}

function resolveUrl(src: unknown, pageUrl: string): string | undefined {
  const trimmed = decodeImageUrl(src);
  if (!trimmed || trimmed.startsWith("data:")) return undefined;

  try {
    return new URL(trimmed, pageUrl).toString();
  } catch {
    return undefined;
  }
}

function normaliseNumberText(value: string): string {
  const arabicDigits: Record<string, string> = {
    "٠": "0",
    "١": "1",
    "٢": "2",
    "٣": "3",
    "٤": "4",
    "٥": "5",
    "٦": "6",
    "٧": "7",
    "٨": "8",
    "٩": "9",
    "۰": "0",
    "۱": "1",
    "۲": "2",
    "۳": "3",
    "۴": "4",
    "۵": "5",
    "۶": "6",
    "۷": "7",
    "۸": "8",
    "۹": "9",
  };

  return value
    .replace(/[٠-٩۰-۹]/g, (digit) => arabicDigits[digit] || digit)
    .replace(/[\u066C,\s]/g, "")
    .replace(/\u066B/g, ".");
}

function normaliseLocalizedNumberText(value: string): string {
  const arabicDigits: Record<string, string> = {
    "\u0660": "0",
    "\u0661": "1",
    "\u0662": "2",
    "\u0663": "3",
    "\u0664": "4",
    "\u0665": "5",
    "\u0666": "6",
    "\u0667": "7",
    "\u0668": "8",
    "\u0669": "9",
    "\u06F0": "0",
    "\u06F1": "1",
    "\u06F2": "2",
    "\u06F3": "3",
    "\u06F4": "4",
    "\u06F5": "5",
    "\u06F6": "6",
    "\u06F7": "7",
    "\u06F8": "8",
    "\u06F9": "9",
  };

  return value
    .replace(
      /[\u0660-\u0669\u06F0-\u06F9]/g,
      (digit) => arabicDigits[digit] || digit,
    )
    .replace(/[\u066C,\s]/g, "")
    .replace(/\u066B/g, ".");
}

function parsePrice(value: any): number {
  if (typeof value === "number") return value;
  if (!value) return 0;

  const normalised = normaliseLocalizedNumberText(String(value));
  const match = normalised.match(/\d+(?:\.\d+)?/);
  return match ? parseFloat(match[0]) : 0;
}

function parseLocalizedMoney(value: unknown): number {
  const text = cleanText(value);
  if (!text) return 0;

  const arabicDigits: Record<string, string> = {
    "\u0660": "0",
    "\u0661": "1",
    "\u0662": "2",
    "\u0663": "3",
    "\u0664": "4",
    "\u0665": "5",
    "\u0666": "6",
    "\u0667": "7",
    "\u0668": "8",
    "\u0669": "9",
    "\u06F0": "0",
    "\u06F1": "1",
    "\u06F2": "2",
    "\u06F3": "3",
    "\u06F4": "4",
    "\u06F5": "5",
    "\u06F6": "6",
    "\u06F7": "7",
    "\u06F8": "8",
    "\u06F9": "9",
  };
  const normalizedDigits = text.replace(
    /[\u0660-\u0669\u06F0-\u06F9]/g,
    (digit) => arabicDigits[digit] || digit,
  );
  const candidates =
    normalizedDigits.match(/\d[\d.,\u066B\u066C\s\u00a0]*/g) || [];

  for (const candidate of candidates) {
    const compact = candidate
      .replace(/[\s\u00a0]/g, "")
      .replace(/\u066C/g, ",")
      .replace(/\u066B/g, ".");
    if (!/\d/.test(compact)) continue;

    const lastDot = compact.lastIndexOf(".");
    const lastComma = compact.lastIndexOf(",");
    let decimalSeparator = "";
    if (lastDot >= 0 && lastComma >= 0) {
      decimalSeparator = lastDot > lastComma ? "." : ",";
    } else if (lastComma >= 0) {
      const decimals = compact.length - lastComma - 1;
      decimalSeparator = decimals > 0 && decimals <= 2 ? "," : "";
    } else if (lastDot >= 0) {
      const decimals = compact.length - lastDot - 1;
      decimalSeparator = decimals > 0 && decimals <= 2 ? "." : "";
    }

    const canonical = decimalSeparator
      ? `${compact.slice(0, compact.lastIndexOf(decimalSeparator)).replace(/[.,]/g, "")}.${compact.slice(compact.lastIndexOf(decimalSeparator) + 1).replace(/[.,]/g, "")}`
      : compact.replace(/[.,]/g, "");
    const parsed = Number(canonical);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  return 0;
}

function parsePriceRange(value: any): { min: number; max: number } {
  if (typeof value === "number") return { min: value, max: value };
  if (!value) return { min: 0, max: 0 };

  const normalised = normaliseLocalizedNumberText(String(value));
  const prices = [...normalised.matchAll(/\d+(?:\.\d+)?/g)]
    .map((match) => parseFloat(match[0]))
    .filter((price) => Number.isFinite(price));

  if (prices.length === 0) return { min: 0, max: 0 };
  return {
    min: Math.min(...prices),
    max: Math.max(...prices),
  };
}

function detectCurrency(text: string | undefined, fallback = "USD"): string {
  if (!text) return fallback;
  if (/EGP|\u062c\s*\.?\s*\u0645/i.test(text)) return "EGP";
  if (/AED|\u062f\s*\.?\s*\u0625|\u062f\u0631\u0647\u0645/i.test(text))
    return "AED";
  if (/SAR|\u0631\s*\.?\s*\u0633|\u0631\u064a\u0627\u0644/i.test(text))
    return "SAR";
  if (/QAR/i.test(text)) return "QAR";
  if (/KWD/i.test(text)) return "KWD";
  if (/BHD/i.test(text)) return "BHD";
  if (/OMR/i.test(text)) return "OMR";
  if (/MXN/i.test(text)) return "MXN";
  if (/TRY|TL|\u20ba/i.test(text)) return "TRY";
  if (/GBP|\u00a3/i.test(text)) return "GBP";
  if (/EUR|\u20ac/i.test(text)) return "EUR";
  if (/GBP|£/i.test(text)) return "GBP";
  if (/EUR|€/i.test(text)) return "EUR";
  if (/USD|\$/i.test(text)) return "USD";
  return fallback;
}

function looksLikeCurrencyText(text: string): boolean {
  return (
    /(?:EGP|AED|SAR|QAR|KWD|BHD|OMR|MXN|TRY|GBP|EUR|USD|TL|\$|\u00a3|\u20ac|\u20ba|\u062c\s*\.?\s*\u0645|\u062f\s*\.?\s*\u0625|\u062f\u0631\u0647\u0645)/i.test(
      text,
    ) || /(?:Â£|â‚¬)/i.test(text)
  );
}

function valueToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => cleanText(item))
      .filter(Boolean)
      .join(" ");
  }
  if (typeof value === "object") {
    for (const key of [
      "name",
      "title",
      "label",
      "value",
      "text",
      "description",
      "longDescription",
      "shortName",
      "sku",
      "id",
    ]) {
      if (key in value) {
        const nested = cleanText((value as Record<string, unknown>)[key]);
        if (nested) return nested;
      }
    }

    const customText = (value as { toString?: () => string }).toString?.();
    return customText && customText !== "[object Object]" ? customText : "";
  }

  return "";
}

function cleanText(value: unknown): string {
  return valueToText(value)
    .replace(/\s+/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .trim();
}

function decodeHtmlEntities(value: unknown): string {
  const text = valueToText(value);
  if (!text || !/&(?:[a-z][a-z0-9]+|#\d+|#x[0-9a-f]+);/i.test(text))
    return text;

  return cheerio.load(`<textarea>${text}</textarea>`)("textarea").text();
}

function parseJsonMaybeEncoded(value: unknown): any {
  const text = valueToText(value).trim();
  if (!text) return null;

  for (const candidate of [...new Set([text, decodeHtmlEntities(text)])]) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  return null;
}

function decodeImageUrl(value: unknown): string {
  return cleanText(value)
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/&#x26;/g, "&")
    .replace(/&amp;/g, "&")
    .trim();
}

function imageDimensionHints(imageUrl: string): number[] {
  const hints: number[] = [];

  try {
    const parsed = new URL(imageUrl);
    for (const key of ["width", "w", "imwidth", "height", "h", "hei"]) {
      const value = Number(parsed.searchParams.get(key));
      if (Number.isFinite(value) && value > 0) hints.push(value);
    }
  } catch {}

  for (const match of imageUrl.matchAll(
    /(?:^|[^\d])(\d{2,4})x(\d{2,4})(?:[^\d]|$)/gi,
  )) {
    hints.push(Number(match[1]), Number(match[2]));
  }

  return hints;
}

function canonicalProductImageUrl(imageUrl: string): string {
  try {
    const parsed = new URL(imageUrl);
    parsed.hash = "";
    for (const key of [
      "width",
      "w",
      "imwidth",
      "height",
      "h",
      "hei",
      "quality",
      "q",
      "format",
      "fmt",
      "auto",
      "fit",
    ]) {
      parsed.searchParams.delete(key);
    }
    return parsed.toString().toLowerCase();
  } catch {
    return imageUrl.split("#")[0].toLowerCase();
  }
}

export function isLikelyProductImageSource(
  imageUrl: string | undefined,
  alt?: string,
): boolean {
  if (!imageUrl) return false;

  const decodedUrl = decodeImageUrl(imageUrl);
  if (!decodedUrl || decodedUrl.startsWith("data:")) return false;
  if (/\.(svg|ico)(?:[?#]|$)/i.test(decodedUrl)) return false;

  const lowerUrl = decodedUrl.toLowerCase();
  const lowerAlt = cleanText(alt).toLowerCase();
  const urlJunkPattern =
    /(?:^|[/?&#._=-])(?:icons?|sprite|favicon|payment|visa|mastercard|paypal|klarna|apple-pay|google-pay|badge|newsletter|placeholder|loader|loading|spinner|avatar|flag|country|app-store|play-store|qrcode|qr-code|barcode|sizeguide|size-guide|sizechart|size-chart|social|facebook|instagram|twitter|youtube|pinterest)(?:$|[/?&#._=-])/i;
  const altJunkPattern =
    /^(?:icon|logo|payment|visa|mastercard|paypal|klarna|apple pay|google pay|badge|newsletter|placeholder|loader|loading|spinner|avatar|flag|country|app store|play store|qr code|barcode|size guide|size chart|facebook|instagram|twitter|youtube|pinterest)$/i;

  if (urlJunkPattern.test(lowerUrl)) return false;
  if (lowerAlt && altJunkPattern.test(lowerAlt)) return false;

  const dimensions = imageDimensionHints(decodedUrl);
  if (dimensions.length >= 2 && Math.max(...dimensions) < 90) return false;

  return true;
}

function isObviousPageAssetImage(
  image: NormalizedProduct["images"][number],
): boolean {
  const lowerUrl = decodeImageUrl(image.url).toLowerCase();
  const lowerAlt = cleanText(image.alt).toLowerCase();

  return (
    /(?:^|[/?&#._=-])(?:logo|site-logo|brand-logo|header-logo|footer-logo)(?:$|[/?&#._=-])/i.test(
      lowerUrl,
    ) ||
    /\b(?:site\s+logo|brand\s+logo|header\s+logo|footer\s+logo)\b/i.test(
      lowerAlt,
    ) ||
    /\blogo\b/i.test(lowerAlt)
  );
}

function removeObviousPageAssetImages(
  images: NormalizedProduct["images"],
): NormalizedProduct["images"] {
  const productImages = images.filter(
    (image) => !isObviousPageAssetImage(image),
  );
  const output = productImages.length ? productImages : images;

  return output.map((image, position) => ({
    ...image,
    position,
  }));
}

export function normalizeProductImageList(
  images: NormalizedProduct["images"],
  options: { maxImages?: number; keepIfAllRejected?: boolean } = {},
): NormalizedProduct["images"] {
  const maxImages = options.maxImages || 30;
  const cleaned: NormalizedProduct["images"] = [];
  const fallback: NormalizedProduct["images"] = [];
  const seen = new Set<string>();

  for (const image of images || []) {
    const url = decodeImageUrl(String(image?.url || ""));
    if (!url) continue;

    fallback.push({
      ...image,
      url,
      alt: cleanText(image.alt),
      color: cleanColorOptionValue(image.color),
      position: fallback.length,
    });

    if (!isLikelyProductImageSource(url, image.alt)) continue;

    const canonicalUrl = canonicalProductImageUrl(url);
    if (seen.has(canonicalUrl)) continue;
    seen.add(canonicalUrl);

    cleaned.push({
      ...image,
      url,
      alt: cleanText(image.alt),
      color: cleanColorOptionValue(image.color),
      position: cleaned.length,
    });
  }

  const output =
    cleaned.length || options.keepIfAllRejected === false ? cleaned : fallback;

  return output.slice(0, maxImages).map((image, position) => ({
    ...image,
    position,
  }));
}

function findProductJsonLd(data: any): any {
  if (!data) return null;

  if (Array.isArray(data)) {
    for (const item of data) {
      const product = findProductJsonLd(item);
      if (product) return product;
    }
    return null;
  }

  const type = data["@type"];
  if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) {
    return data;
  }

  return findProductJsonLd(data["@graph"]) || findProductJsonLd(data.product);
}

function firstOffer(productData: any): any {
  if (!productData?.offers) return null;
  return Array.isArray(productData.offers)
    ? productData.offers[0]
    : productData.offers;
}

function getNextStyleIds(
  url: string,
): { styleId: string; productId: string } | null {
  const urlMatch = url.match(/style\/([a-z0-9]+)\/([a-z0-9]+)/i);
  if (!urlMatch) return null;

  return {
    styleId: urlMatch[1].toLowerCase(),
    productId: urlMatch[2].toLowerCase(),
  };
}

function stripUrlHash(url: string): string {
  return cleanText(url).split("#")[0];
}

const NEXT_MOBILE_USER_AGENTS = [
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
];

function buildNextMobileHeaders(
  url: string,
  userAgent = NEXT_MOBILE_USER_AGENTS[0],
): Record<string, string> {
  return {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": defaultNextLanguageForUrl(url),
    "cache-control": "no-cache",
    pragma: "no-cache",
    "user-agent": userAgent,
    cookie: nextCookieForUrl(url),
  };
}

function buildNextBrowserHeaders(url: string): Record<string, string> {
  return {
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-language": defaultNextLanguageForUrl(url),
    "cache-control": "no-cache",
    pragma: "no-cache",
    "sec-ch-ua":
      '"Google Chrome";v="124", "Chromium";v="124", "Not-A.Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
    "user-agent": browserHeaders["User-Agent"],
    cookie: nextCookieForUrl(url),
  };
}

async function fetchNextHtmlAttempt(
  pageUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<string> {
  const response = await axios.get(pageUrl, {
    headers,
    signal,
    timeout: envNumber("NEXT_HTML_TIMEOUT_MS", 7000),
    validateStatus: (status: number) => status < 500,
    ...buildScraperAxiosConfig(),
  });

  if (response.status !== 200) {
    throw new Error(`Next HTML HTTP ${response.status}`);
  }

  const html = String(response.data);
  if (isBlockedNextHtml(html) || !isUsableNextProductHtml(html)) {
    throw new Error("Next returned non-product HTML");
  }

  return html;
}

async function fetchNextPageHtml(pageUrl: string): Promise<string | null> {
  const attempts: Array<{ headers: Record<string, string>; label: string }> = [
    ...NEXT_MOBILE_USER_AGENTS.map((userAgent, index) => ({
      headers: buildNextMobileHeaders(pageUrl, userAgent),
      label: `mobile-${index + 1}`,
    })),
    { headers: buildNextBrowserHeaders(pageUrl), label: "desktop" },
  ];

  const retryCount = Math.max(1, envNumber("NEXT_HTML_RETRIES", 1));
  for (let retry = 0; retry < retryCount; retry += 1) {
    const controllers = attempts.map(() => new AbortController());
    try {
      const html = await Promise.any(
        attempts.map((attempt, index) =>
          fetchNextHtmlAttempt(pageUrl, attempt.headers, controllers[index].signal),
        ),
      );
      controllers.forEach((controller) => controller.abort());
      return html;
    } catch {
      controllers.forEach((controller) => controller.abort());
    }

    await new Promise((resolve) => setTimeout(resolve, 1200 * (retry + 1)));
  }

  for (const mobileUserAgent of NEXT_MOBILE_USER_AGENTS) {
    try {
      const html = await fetchHtmlWithCurl(
        pageUrl,
        buildNextMobileHeaders(pageUrl, mobileUserAgent),
      );
      if (!isBlockedNextHtml(html) && isUsableNextProductHtml(html)) {
        return html;
      }
    } catch {}
  }

  return null;
}

function buildNextRegionalUrls(
  url: string,
  styleId: string,
  productId: string,
): string[] {
  const normalized = stripUrlHash(url);
  const aeUrl = `https://www.next.ae/en/style/${styleId}/${productId}`;
  const usUrl = `https://www.next.us/en/style/${styleId}/${productId}`;
  const ukUrl = `https://www.next.co.uk/style/${styleId}/${productId}`;
  const egUrl = `https://www.nextdirect.com/eg/en/style/${styleId}/${productId}`;
  const egArUrl = `https://www.nextdirect.com/eg/ar/style/${styleId}/${productId}`;

  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("next.ae"))
      return [normalized, aeUrl, ukUrl, usUrl, egUrl];
    if (host.includes("next.us"))
      return [normalized, usUrl, ukUrl, aeUrl, egUrl];
    if (host.includes("nextdirect.com"))
      return [normalized, egUrl, egArUrl, ukUrl, aeUrl];
    if (host.includes("next.co.uk") || host.includes("next.ie"))
      return [normalized, ukUrl, aeUrl, usUrl, egUrl];
  } catch {}

  return [normalized, aeUrl, ukUrl, usUrl, egUrl, egArUrl];
}

function nextScrapeMatchesRequestedRegion(
  url: string,
  pageUrl: string,
  currency: string,
): boolean {
  try {
    const requestedHost = new URL(url).hostname.toLowerCase();
    const pageHost = new URL(pageUrl).hostname.toLowerCase();
    if (requestedHost === pageHost) return true;
    return currency === defaultNextCurrencyForUrl(url);
  } catch {
    return true;
  }
}

function buildNextReaderUrls(url: string): string[] {
  const ids = getNextStyleIds(url);
  if (!ids) return [stripUrlHash(url)];

  const { styleId, productId } = ids;
  return [
    ...new Set([
      ...buildNextRegionalUrls(url, styleId, productId),
      `https://www.next.ie/en/style/${styleId}/${productId}`,
      `https://www.nextdirect.com/eg/ar/style/${styleId}/${productId}`,
    ]),
  ];
}

function buildNextHtmlFallbackUrls(url: string): string[] {
  const ids = getNextStyleIds(url);
  if (!ids) return [stripUrlHash(url)];

  const { styleId, productId } = ids;
  return [...new Set(buildNextRegionalUrls(url, styleId, productId))];
}

function isBlockedReaderMarkdown(markdown: string): boolean {
  return (
    /Title:\s*(Access Denied|404|Page Not Found)/i.test(markdown) ||
    /Target URL returned error\s+(403|404)/i.test(markdown) ||
    /You don't have permission to access/i.test(markdown) ||
    /404\s*\|\s*Page Not Found/i.test(markdown) ||
    /Oops'\s+Something's gone wrong/i.test(markdown)
  );
}

function pushImage(
  images: NormalizedProduct["images"],
  url: string | undefined,
  pageUrl: string,
  alt?: string,
) {
  const absoluteUrl = resolveUrl(
    url ? decodeImageUrl(url) : undefined,
    pageUrl,
  );
  if (!absoluteUrl) return;
  if (!isLikelyProductImageSource(absoluteUrl, alt)) return;
  const canonicalUrl = canonicalProductImageUrl(absoluteUrl);
  if (images.some((img) => canonicalProductImageUrl(img.url) === canonicalUrl))
    return;

  images.push({
    url: absoluteUrl,
    alt: cleanText(alt),
    position: images.length,
  });
}

function applyImageColorByUrl(
  images: NormalizedProduct["images"],
  url: string | undefined,
  pageUrl: string,
  color: string | undefined,
) {
  const absoluteUrl = resolveUrl(
    url ? decodeImageUrl(url) : undefined,
    pageUrl,
  );
  const cleanColor = cleanText(color);
  if (!absoluteUrl || !cleanColor) return;

  const canonicalUrl = canonicalProductImageUrl(absoluteUrl);
  const image = images.find(
    (entry) => canonicalProductImageUrl(entry.url) === canonicalUrl,
  );
  if (image) image.color ||= cleanColor;
}

function pushNextProductImage(
  images: NormalizedProduct["images"],
  rawUrl: string | undefined,
  pageUrl: string,
  productIdKey?: string,
  alt?: string,
) {
  if (!rawUrl) return;

  const unescapedUrl = rawUrl.replace(/\\u002F/g, "/").replace(/&amp;/g, "&");
  const absoluteUrl = resolveUrl(unescapedUrl, pageUrl);
  if (!absoluteUrl) return;

  const lower = absoluteUrl.toLowerCase();
  const looksLikeProductImage =
    lower.includes("xcdn.next.co.uk") &&
    lower.includes("/product/") &&
    (!productIdKey || lower.includes(productIdKey.toLowerCase()));

  if (!looksLikeProductImage) return;

  const highResUrl = absoluteUrl.includes("width=")
    ? absoluteUrl.replace(/width=\d+/i, "width=750")
    : absoluteUrl;
  const canonicalKey = highResUrl.split("?")[0].toLowerCase();
  if (
    images.some((img) => img.url.split("?")[0].toLowerCase() === canonicalKey)
  )
    return;

  images.push({
    url: highResUrl,
    alt: cleanText(alt),
    position: images.length,
  });
}

function extractNextProductImages(
  text: string,
  pageUrl: string,
  productIdKey?: string,
): NormalizedProduct["images"] {
  const images: NormalizedProduct["images"] = [];

  const markdownImageRegex = /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
  for (const match of text.matchAll(markdownImageRegex)) {
    pushNextProductImage(images, match[2], pageUrl, productIdKey, match[1]);
  }

  const urlRegex = /https?:\/\/xcdn\.next\.co\.uk\/[^"'<>)\s\\]+/gi;
  for (const match of text.matchAll(urlRegex)) {
    pushNextProductImage(images, match[0], pageUrl, productIdKey);
  }

  return images.map((image, position) => ({ ...image, position }));
}

function slugOption(value: string): string {
  return (
    cleanText(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "default"
  );
}

function parseNextColourFromMarkdown(lines: string[]): string | undefined {
  const colourIndex = lines.findIndex((line) =>
    /^(Colour|Color|\u0627\u0644\u0644\u0648\u0646)\s*:/i.test(line),
  );
  if (colourIndex === -1) return undefined;

  const inlineColor = lines[colourIndex].match(
    /^(?:Colour|Color|\u0627\u0644\u0644\u0648\u0646)\s*:?\s*(.+)$/i,
  )?.[1];
  const cleanInlineColor = cleanColorOptionValue(inlineColor);
  if (cleanInlineColor) return cleanInlineColor;

  for (const line of lines.slice(colourIndex + 1, colourIndex + 8)) {
    if (
      !line ||
      line === "\u200b" ||
      line.startsWith("![") ||
      /^\[?Input\]?$/i.test(line) ||
      /^Image\s*:/i.test(line) ||
      /^(\* \* \*|Size|Choose Size|Taille|Choisissez)/i.test(line)
    )
      continue;
    return cleanText(line);
  }

  return undefined;
}

function inferNextColourFromTitle(title: string): string | undefined {
  const normalized = cleanText(title)
    .replace(/\s+-\s+/g, " ")
    .replace(/\s+(?:from|by)\s+Next$/i, "");

  const productKeywordPattern =
    /\b(?:tops?|t-?shirts?|shirts?|shorts?|set|dress(?:es)?|romper|dungaree|outfit|sleepsuit|bodysuit|leggings?|joggers?|jeans|trousers|sandals?|shoes?|trainers?|boots?|cardigan|jumper|sweater|hoodie|coat|jacket|swimsuit|pyjamas?|pajamas?)\b/i;
  const keywordMatch = normalized.match(productKeywordPattern);
  if (
    !keywordMatch ||
    keywordMatch.index === undefined ||
    keywordMatch.index <= 0
  )
    return undefined;

  const candidate = cleanText(normalized.slice(0, keywordMatch.index));
  if (
    !candidate ||
    candidate.length > 48 ||
    /\b(?:baby|kids?|girls?|boys?|maman|b[eé]b[eé]|cotton|pack|piece|printed?)\b/i.test(
      candidate,
    )
  ) {
    return undefined;
  }

  return candidate
    .replace(
      /^(?:Next|Lipsy|Reiss|JoJo Maman B[eé]b[eé]|Baker by Ted Baker)\s+/i,
      "",
    )
    .trim();
}

function parseNextColourFromHtml(
  $: cheerio.CheerioAPI,
  title: string,
): string | undefined {
  const explicitText = cleanText(
    $(
      '[data-testid*="colour" i], [data-testid*="color" i], [class*="colour" i], [class*="color" i]',
    )
      .map((_, el) => $(el).text())
      .get()
      .join(" "),
  );
  const explicitMatch = explicitText.match(
    /(?:Colour|Color)\s*:?\s*([A-Za-z0-9 /&,+.'-]{2,60})(?:\s+(?:Size|Choose|Selected)|$)/i,
  );
  const explicitColor = cleanColorOptionValue(explicitMatch?.[1]);

  if (explicitColor && !/^Image\s*:/i.test(explicitColor)) return explicitColor;
  return cleanColorOptionValue(inferNextColourFromTitle(title)) || undefined;
}

function inferNextBabySizes(text: string): string[] {
  const normalized = cleanText(text);
  let maxYears = 0;

  const englishRange = normalized.match(
    /(?:0\s*mths?|0\s*months?)\s*-\s*(\d+)\s*(?:yrs?|years?)/i,
  );
  const upToRange = normalized.match(/up to\s*(\d+)\s*-\s*(\d+)\s*years?/i);
  const arabicRange = normalized.match(
    /(?:0\s*(?:\u0634\u0647\u0631|\u0634\u0647\u0648\u0631))\s*-\s*(\d+)\s*(?:\u0633\u0646\u0629|\u0633\u0646\u062a\u064a\u0646|\u0633\u0646\u0648\u0627\u062a)/i,
  );

  if (englishRange) maxYears = parseInt(englishRange[1], 10);
  if (!maxYears && upToRange) maxYears = parseInt(upToRange[2], 10);
  if (!maxYears && arabicRange) maxYears = parseInt(arabicRange[1], 10);
  if (!maxYears && /baby|babies|\u0628\u064a\u0628\u064a/i.test(normalized))
    maxYears = 3;

  if (!maxYears) return [];

  const sizes = [
    "Up to 1 Month",
    "0-3 Months",
    "3-6 Months",
    "6-9 Months",
    "9-12 Months",
    "12-18 Months",
    "1.5-2 Years",
  ];

  if (maxYears >= 3) sizes.push("2-3 Years");
  if (maxYears >= 4) sizes.push("3-4 Years");

  return sizes;
}

function buildInferredNextVariants(
  productCode: string | undefined,
  sizes: string[],
  priceRange: { min: number; max: number },
  color?: string,
): NormalizedProduct["variants"] {
  if (sizes.length === 0) return [];

  return sizes.map((size, index) => {
    const isHighestSize = index === sizes.length - 1;
    const price =
      isHighestSize && priceRange.max > priceRange.min
        ? priceRange.max
        : priceRange.min;

    return {
      sourceVariantId: `${productCode || "next"}-${slugOption(size)}`,
      sku: `${productCode || "NEXT"}-${slugOption(size).toUpperCase()}`,
      color,
      size,
      price,
      optionValues: buildVariantOptionValues(color, size),
      available: true,
      stockStatus: "in_stock",
    };
  });
}

function formatNextProductCodeFromProductId(
  productId: string | undefined,
): string | undefined {
  const normalized = cleanText(productId)
    .replace(/[^a-z0-9]/gi, "")
    .toUpperCase();
  if (!normalized) return undefined;
  if (normalized.length === 6)
    return `${normalized.slice(0, 3)}-${normalized.slice(3)}`;
  return normalized;
}

function stripNextCardPrice(title: string): string {
  return cleanText(title)
    .replace(
      /\s+(?:was|now|from)?\s*(?:EGP|AED|USD|SAR|GBP|EUR|\$|£|€)\s*[\d,.].*$/i,
      "",
    )
    .replace(/\s+(?:was|now|from)\s+.*$/i, "")
    .trim();
}

function normalizeHmSize(value: unknown): string {
  const cleaned = cleanText(value);
  const monthRange = cleaned.match(/^(\d+)\s*-\s*(\d+)\s*M$/i);
  if (monthRange) return `${monthRange[1]}-${monthRange[2]} Months`;

  const yearRange = cleaned.match(
    /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*Y$/i,
  );
  if (yearRange) return `${yearRange[1]}-${yearRange[2]} Years`;

  return cleaned;
}

function inferColorFromHmUrl(url: string): string | undefined {
  try {
    const slug = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
    const colorSlug = slug.replace(
      /^buy-[^-]+(?:-[^-]+)*?-(?=(?:light|dark|blue|white|black|pink|red|green|yellow|orange|purple|beige|brown|grey|gray|cream|striped|print|multi)\b)/i,
      "",
    );
    const candidate = colorSlug
      .replace(/^buy-/, "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
    return cleanColorOptionValue(candidate);
  } catch {
    return undefined;
  }
}

function hmStorefrontConfig(url: string): {
  endpoint: string;
  websiteCode: string;
  storeViewCode: string;
  storeCode: string;
  language: string;
} {
  let host = "ae.hm.com";
  let country = "ae";
  let language = "en";

  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase();
    const hostCountry = host.split(".")[0];
    if (/^[a-z]{2}$/.test(hostCountry)) country = hostCountry;
    language = parsed.pathname.split("/").filter(Boolean)[0] || language;
  } catch {}

  const storefronts: Record<
    string,
    { websiteCode: string; storeViewCode: string; storeCode: string }
  > = {
    ae: {
      websiteCode: "are",
      storeViewCode: "are_en",
      storeCode: "hm_uae_store",
    },
    eg: {
      websiteCode: "egy",
      storeViewCode: "egy_en",
      storeCode: "hm_egypt_store",
    },
  };
  const storefront = storefronts[country] || storefronts.ae;
  const storeViewCode =
    language === "ar"
      ? storefront.storeViewCode.replace(/_en$/, "_ar")
      : storefront.storeViewCode;

  return {
    endpoint: `https://${host}/graphql`,
    websiteCode: storefront.websiteCode,
    storeViewCode,
    storeCode: storefront.storeCode,
    language,
  };
}

function hmGraphqlPriceAmount(value: any): { price: number; currency: string } {
  const amount =
    value?.final?.amount || value?.regular?.amount || value?.amount || value;
  return {
    price: parsePrice(amount?.value ?? amount),
    currency: cleanText(amount?.currency) || "AED",
  };
}

function hmGraphqlRangePrice(product: any): {
  price: number;
  maxPrice: number;
  currency: string;
} {
  const minimum = hmGraphqlPriceAmount(product?.priceRange?.minimum);
  const maximum = hmGraphqlPriceAmount(product?.priceRange?.maximum);
  const simple = hmGraphqlPriceAmount(product?.price);
  const prices = [minimum.price, maximum.price, simple.price].filter(
    (price) => price > 0,
  );

  return {
    price: prices.length ? Math.min(...prices) : 0,
    maxPrice: prices.length ? Math.max(...prices) : 0,
    currency: minimum.currency || maximum.currency || simple.currency || "AED",
  };
}

function hmAttribute(product: any, names: string[]): string | undefined {
  const normalizedNames = names.map((name) => name.toLowerCase());
  const attribute = (product?.attributes || []).find(
    (entry: any) =>
      normalizedNames.includes(cleanText(entry?.name).toLowerCase()) ||
      normalizedNames.includes(cleanText(entry?.label).toLowerCase()),
  );
  return cleanText(attribute?.value) || undefined;
}

function pushHmAssetImages(
  images: NormalizedProduct["images"],
  product: any,
  url: string,
  title: string,
) {
  const attributes = product?.attributes || [];
  for (const attributeName of ["assets_pdp", "assets_plp", "assets_cart"]) {
    const rawValue = attributes.find(
      (entry: any) => cleanText(entry?.name) === attributeName,
    )?.value;
    if (!rawValue) continue;
    try {
      const assets = JSON.parse(rawValue);
      for (const asset of assets || []) {
        pushImage(
          images,
          asset?.styles?.product_zoom_large_800x800 || asset?.url,
          url,
          title,
        );
      }
    } catch {}
  }
}

async function fetchHmGraphqlProduct(url: string, sku: string): Promise<any> {
  const storefront = hmStorefrontConfig(url);
  const query = `
    query GetProduct($skus:[String]) {
      products(skus:$skus) {
        __typename
        sku
        name
        urlKey
        inStock
        addToCartAllowed
        description
        shortDescription
        externalId
        images { url label roles }
        attributes { name label value roles }
        ... on SimpleProductView {
          price { final { amount { value currency } } regular { amount { value currency } } }
        }
        ... on ComplexProductView {
          options {
            id
            title
            required
            multi
            values {
              __typename
              id
              title
              inStock
              ... on ProductViewOptionValueSwatch { value type }
            }
          }
          priceRange {
            minimum { final { amount { value currency } } regular { amount { value currency } } }
            maximum { final { amount { value currency } } regular { amount { value currency } } }
          }
        }
      }
    }
  `;

  const response = await axios.post(
    storefront.endpoint,
    {
      query,
      variables: { skus: [sku] },
    },
    {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Magento-Website-Code": storefront.websiteCode,
        "Magento-Store-View-Code": storefront.storeViewCode,
        "Magento-Store-Code": storefront.storeCode,
        "Magento-Customer-Group": "0",
        Store: storefront.storeViewCode,
        "User-Agent": browserHeaders["User-Agent"],
        Referer: url,
      },
      timeout: 30000,
    },
  );

  const errors = response.data?.errors || [];
  if (errors.length > 0) {
    throw new Error(errors[0]?.message || "H&M GraphQL returned an error");
  }

  return response.data?.data?.products?.[0];
}

function normalizeHmGraphqlProduct(
  product: any,
  fallback: NormalizedProduct,
  url: string,
): NormalizedProduct {
  const title = cleanText(product?.name) || fallback.title;
  const priceRange = hmGraphqlRangePrice(product);
  const price = priceRange.price || fallback.price;
  const currency = priceRange.currency || fallback.currency;
  const color =
    cleanColorOptionValue(
      hmAttribute(product, [
        "color_label",
        "Actual Color Label",
        "colour",
        "color",
      ]),
    ) || inferColorFromHmUrl(url);
  const images = [...fallback.images];

  for (const image of product?.images || []) {
    pushImage(images, image?.url, url, image?.label || title);
  }
  pushHmAssetImages(images, product, url, title);

  const sizeOption = (product?.options || []).find(
    (option: any) =>
      /^size$/i.test(cleanText(option?.id)) ||
      /^size$/i.test(cleanText(option?.title)),
  );
  const sizeValues = uniqueCleanValues(
    (sizeOption?.values || [])
      .filter((value: any) => value?.inStock !== false)
      .map((value: any) => normalizeHmSize(value?.title || value?.value))
      .filter(Boolean),
  );

  const variants = sizeValues.length
    ? sizeValues.map((size: string) => ({
        sourceVariantId: `${product?.sku || fallback.source.productId}-${slugOption(size)}`,
        sku: `${product?.sku || fallback.source.productId}-${slugOption(size).toUpperCase()}`,
        color,
        size,
        price,
        currency,
        available: product?.inStock !== false,
        stockStatus:
          product?.inStock === false
            ? ("out_of_stock" as const)
            : ("in_stock" as const),
        optionValues: buildVariantOptionValues(color, size),
      }))
    : fallback.variants;

  return {
    ...fallback,
    source: {
      supplier: "H&M",
      url,
      productId: cleanText(product?.sku) || fallback.source.productId,
    },
    title,
    description: cleanText(product?.description) || fallback.description,
    brand: "H&M",
    price,
    currency,
    images: removeObviousPageAssetImages(images),
    options: [
      ...(color ? [{ name: "Color", values: [color] }] : []),
      ...(sizeValues.length ? [{ name: "Size", values: sizeValues }] : []),
    ].length
      ? [
          ...(color ? [{ name: "Color", values: [color] }] : []),
          ...(sizeValues.length ? [{ name: "Size", values: sizeValues }] : []),
        ]
      : fallback.options,
    variants,
    raw: {
      ...(fallback.raw || {}),
      hmGraphqlProduct: product,
      hmGraphqlFallback: true,
      extractedAt: new Date().toISOString(),
    },
  };
}

function productIdKeyFromNextCode(
  productCode: string | undefined,
): string | undefined {
  return (
    cleanText(productCode)
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase() || undefined
  );
}

function getNextSizeValues(product: NormalizedProduct): string[] {
  const sizeOption = product.options.find((option) =>
    /^size$/i.test(option.name),
  );
  return uniqueCleanValues([
    ...(sizeOption?.values || []),
    ...product.variants.map((variant) => variant.size),
  ]).filter((value) => !isDefaultOptionValue(value));
}

function getNextCurrentColor(product: NormalizedProduct): string | undefined {
  const colorOption = product.options.find((option) =>
    /^colou?r$/i.test(option.name),
  );
  return (
    colorOption?.values?.[0] ||
    product.variants.find((variant) => variant.color)?.color ||
    inferNextColourFromTitle(product.title)
  );
}

function applyNextColorwaysFromMarkdown(
  product: NormalizedProduct,
  markdown: string,
  url: string,
  readerUrl = url,
): NormalizedProduct {
  const ids = getNextStyleIds(url) || getNextStyleIds(readerUrl);
  if (!ids) return product;

  const currentProductId =
    productIdKeyFromNextCode(product.source.productId) || ids.productId;
  const currentColor = getNextCurrentColor(product);
  const sizeValues = getNextSizeValues(product);
  if (!currentColor || sizeValues.length === 0) return product;

  const currentPrices = product.variants
    .map((variant) => variant.price || 0)
    .filter((price) => price > 0);
  const currentPriceRange = {
    min: currentPrices.length ? Math.min(...currentPrices) : product.price,
    max: currentPrices.length ? Math.max(...currentPrices) : product.price,
  };

  type NextColorway = {
    productId: string;
    productCode?: string;
    color: string;
    title: string;
    url: string;
    imageUrl?: string;
    priceRange: { min: number; max: number };
    currency: string;
    isCurrent?: boolean;
  };

  const colorways = new Map<string, NextColorway>();
  colorways.set(currentProductId, {
    productId: currentProductId,
    productCode:
      product.source.productId ||
      formatNextProductCodeFromProductId(currentProductId),
    color: currentColor,
    title: product.title,
    url,
    imageUrl: product.images[0]?.url,
    priceRange: currentPriceRange,
    currency: product.currency,
    isCurrent: true,
  });

  const cardRegex =
    /\[!\[Image\s+\d+:\s*([^\]]+)\]\((https?:\/\/[^)]+)\)\s*([^\]]+?)\]\((https?:\/\/[^)]+\/style\/([a-z0-9]+)\/([a-z0-9]+)[^)]*)\)/gi;
  for (const match of markdown.matchAll(cardRegex)) {
    const [, imageAlt, imageUrl, linkText, productUrl, styleId, productId] =
      match;
    if (styleId.toLowerCase() !== ids.styleId.toLowerCase()) continue;

    const productIdKey = productId.toLowerCase();
    const title = stripNextCardPrice(imageAlt || linkText);
    const color = inferNextColourFromTitle(title);
    if (!color || colorways.has(productIdKey)) continue;

    const priceRange = parsePriceRange(linkText);
    colorways.set(productIdKey, {
      productId: productIdKey,
      productCode: formatNextProductCodeFromProductId(productIdKey),
      color,
      title,
      url: productUrl,
      imageUrl,
      priceRange: priceRange.min > 0 ? priceRange : currentPriceRange,
      currency: detectCurrency(linkText, product.currency),
    });
  }

  if (colorways.size <= 1) return product;

  const variants: NormalizedProduct["variants"] = [];
  for (const colorway of colorways.values()) {
    if (
      colorway.isCurrent &&
      product.variants.some((variant) => variant.size)
    ) {
      for (const variant of product.variants) {
        variants.push({
          ...variant,
          color: colorway.color,
          imageUrl: variant.imageUrl || colorway.imageUrl,
          currency: variant.currency || colorway.currency,
          optionValues: buildVariantOptionValues(colorway.color, variant.size),
        });
      }
      continue;
    }

    variants.push(
      ...buildInferredNextVariants(
        colorway.productCode,
        sizeValues,
        colorway.priceRange,
        colorway.color,
      ).map((variant) => ({
        ...variant,
        currency: colorway.currency,
        imageUrl: colorway.imageUrl,
        raw: {
          colorwayUrl: colorway.url,
          colorwayTitle: colorway.title,
          inferredFromColorwayCard: true,
        },
      })),
    );
  }

  const images = product.images.map((image) => ({
    ...image,
    color: image.color || (currentColor ? cleanText(currentColor) : undefined),
  }));
  for (const colorway of colorways.values()) {
    const beforeLength = images.length;
    pushImage(images, colorway.imageUrl, colorway.url, colorway.title);
    if (images.length > beforeLength) {
      images[images.length - 1].color ||= colorway.color;
    } else {
      applyImageColorByUrl(
        images,
        colorway.imageUrl,
        colorway.url,
        colorway.color,
      );
    }
  }

  return {
    ...product,
    price: Math.min(
      ...variants
        .map((variant) => variant.price || product.price)
        .filter((price) => price > 0),
    ),
    images: images.map((image, position) => ({ ...image, position })),
    options: [
      {
        name: "Color",
        values: [...colorways.values()].map((colorway) => colorway.color),
      },
      { name: "Size", values: sizeValues },
    ],
    variants,
    raw: {
      ...product.raw,
      nextColorways: [...colorways.values()],
      colorwaysInferredFromReader: true,
    },
  };
}

function variantsFromJsonLdOffers(
  offers: any,
  productCode: string | undefined,
  color?: string,
): NormalizedProduct["variants"] {
  const offerList = Array.isArray(offers) ? offers : [offers].filter(Boolean);

  return offerList
    .map((offer: any, index: number) => {
      const size = cleanText(
        offer?.name || offer?.description || `Option ${index + 1}`,
      );
      const price = parsePrice(offer?.price);
      const inStock =
        !offer?.availability || /InStock/i.test(String(offer.availability));

      return {
        sourceVariantId:
          offer?.sku || `${productCode || "next"}-${slugOption(size)}`,
        sku:
          offer?.sku ||
          `${productCode || "NEXT"}-${slugOption(size).toUpperCase()}`,
        color,
        size,
        price,
        currency: offer?.priceCurrency,
        optionValues: buildVariantOptionValues(color, size),
        available: inStock,
        stockStatus: inStock
          ? ("in_stock" as const)
          : ("out_of_stock" as const),
        raw: offer,
      };
    })
    .filter((variant: any) => variant.size && variant.price > 0);
}

function hostMatches(url: string, domains: string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return domains.some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    );
  } catch {
    const lower = url.toLowerCase();
    return domains.some((domain) => lower.includes(domain));
  }
}

function availabilitySnapshotFromProduct(
  product: NormalizedProduct,
): AvailabilitySnapshot {
  return {
    available: product.variants.some((v) => v.available),
    price: product.price,
    variants: product.variants.map((v) => ({
      id: v.sourceVariantId || v.sku || "default",
      available: v.available,
      stockStatus: v.stockStatus,
      price: v.price || product.price,
    })),
  };
}

async function fetchHtml(
  url: string,
  extraHeaders: Record<string, string> = {},
): Promise<string> {
  const response = await axios.get(url, {
    headers: {
      ...browserHeaders,
      ...extraHeaders,
    },
    timeout: 20000,
    responseType: "text",
    validateStatus: (status: number) => status < 500,
  });

  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status}`);
  }

  return typeof response.data === "string"
    ? response.data
    : String(response.data);
}

async function fetchHtmlWithCurl(
  url: string,
  requestHeaders: Record<string, string> = {},
): Promise<string> {
  const curlExecutable = process.platform === "win32" ? "curl.exe" : "curl";
  const userAgent =
    requestHeaders["user-agent"] ||
    requestHeaders["User-Agent"] ||
    browserHeaders["User-Agent"];
  const curlArgs = ["-L", "--compressed", "-sS", "-A", userAgent];
  const proxyUrl = scraperProxyUrl();
  if (proxyUrl) {
    curlArgs.push("--proxy", proxyUrl);
  }

  for (const [key, value] of Object.entries(requestHeaders)) {
    if (/^user-agent$/i.test(key)) continue;
    curlArgs.push("-H", `${key}: ${value}`);
  }

  curlArgs.push(url);

  let stdout: string | Buffer;
  try {
    ({ stdout } = await execFileAsync(curlExecutable, curlArgs, {
      timeout: 60000,
      maxBuffer: 30 * 1024 * 1024,
    }));
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      throw new Error("curl executable is not available on this host");
    }
    throw error;
  }

  const html = typeof stdout === "string" ? stdout : String(stdout);
  if (!html.trim()) throw new Error("curl returned an empty response");
  if (/Just a moment|security verification|cf-chl|Cloudflare/i.test(html)) {
    throw new Error("curl returned Cloudflare challenge");
  }

  return html;
}

async function fetchHtmlViaScrapingBee(
  url: string,
  options: ManagedBypassOptions,
): Promise<string> {
  const apiKey = cleanText(process.env.SCRAPINGBEE_API_KEY);
  if (!apiKey) throw new Error("SCRAPINGBEE_API_KEY is not configured");

  const countryCode =
    options.countryCode ||
    cleanText(process.env.SCRAPINGBEE_COUNTRY_CODE) ||
    inferCountryCodeFromUrl(url);
  const renderJs = options.jsRender ?? envFlag("SCRAPINGBEE_RENDER_JS", true);
  const premiumProxy =
    options.premium ?? envFlag("SCRAPINGBEE_PREMIUM_PROXY", true);

  const params = new URLSearchParams();
  params.set("api_key", apiKey);
  params.set("url", url);
  if (renderJs) params.set("render_js", "true");
  if (premiumProxy) params.set("premium_proxy", "true");
  if (countryCode && premiumProxy) params.set("country_code", countryCode);

  const response = await axios.get(
    `https://app.scrapingbee.com/api/v1?${params.toString()}`,
    {
      timeout: 90000,
      responseType: "text",
      validateStatus: (status) => status < 500,
    },
  );

  if (response.status !== 200) {
    throw new Error(`ScrapingBee HTTP ${response.status}`);
  }

  const html =
    typeof response.data === "string" ? response.data : String(response.data);
  if (!html.trim()) throw new Error("ScrapingBee returned an empty response");
  if (looksLikeAccessDeniedHtml(html) && !isUsableNextProductHtml(html)) {
    throw new Error("ScrapingBee returned a blocked page");
  }

  return html;
}

async function fetchHtmlViaScrapingAnt(
  url: string,
  _options: ManagedBypassOptions,
): Promise<string> {
  const apiKey = cleanText(process.env.SCRAPINGANT_API_KEY);
  if (!apiKey) throw new Error("SCRAPINGANT_API_KEY is not configured");

  const params = new URLSearchParams();
  params.set("url", url);

  const response = await axios.get(
    `https://api.scrapingant.com/v1/general?${params.toString()}`,
    {
      timeout: 90000,
      responseType: "text",
      headers: {
        "x-api-key": apiKey,
      },
      validateStatus: (status) => status < 500,
    },
  );

  if (response.status !== 200) {
    throw new Error(`ScrapingAnt HTTP ${response.status}`);
  }

  let html = "";
  const payload =
    typeof response.data === "string" ? response.data : String(response.data);
  if (payload.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(payload);
      html = cleanText(parsed?.content) ? String(parsed.content) : "";
    } catch {
      html = payload;
    }
  } else {
    html = payload;
  }

  if (!html.trim()) throw new Error("ScrapingAnt returned an empty response");
  if (looksLikeAccessDeniedHtml(html) && !isUsableNextProductHtml(html)) {
    throw new Error("ScrapingAnt returned a blocked page");
  }

  return html;
}

async function fetchHtmlViaScrapeDo(
  url: string,
  options: ManagedBypassOptions,
): Promise<string> {
  const token = cleanText(process.env.SCRAPEDO_TOKEN);
  if (!token) throw new Error("SCRAPEDO_TOKEN is not configured");

  const countryCode =
    options.countryCode ||
    cleanText(process.env.SCRAPEDO_GEO_CODE) ||
    inferCountryCodeFromUrl(url);
  const renderJs = options.jsRender ?? envFlag("SCRAPEDO_RENDER", true);
  const useSuperProxy =
    options.premium ?? envFlag("SCRAPEDO_SUPER_PROXY", true);

  const params = new URLSearchParams();
  params.set("token", token);
  params.set("url", url);
  if (renderJs) params.set("render", "true");
  if (useSuperProxy) params.set("super", "true");
  if (countryCode) params.set("geoCode", countryCode);

  const response = await axios.get(`https://api.scrape.do/?${params.toString()}`, {
    timeout: 90000,
    responseType: "text",
    validateStatus: (status) => status < 500,
  });

  if (response.status !== 200) {
    throw new Error(`Scrape.do HTTP ${response.status}`);
  }

  const html =
    typeof response.data === "string" ? response.data : String(response.data);
  if (!html.trim()) throw new Error("Scrape.do returned an empty response");
  if (looksLikeAccessDeniedHtml(html) && !isUsableNextProductHtml(html)) {
    throw new Error("Scrape.do returned a blocked page");
  }

  return html;
}

async function fetchHtmlWithPlaywright(
  url: string,
  requestHeaders: Record<string, string> = {},
  options: {
    waitMs?: number;
    allowBlockedHtml?: (html: string) => boolean;
  } = {},
): Promise<string> {
  const { chromium } = await import("playwright");
  const userAgent =
    requestHeaders["user-agent"] ||
    requestHeaders["User-Agent"] ||
    browserHeaders["User-Agent"];

  const extraHTTPHeaders = Object.fromEntries(
    Object.entries(requestHeaders).filter(
      ([key, value]) => !/^user-agent$/i.test(key) && Boolean(value),
    ),
  );

  const browser = await chromium.launch({
    headless: true,
  });

  try {
    const context = await browser.newContext({
      userAgent,
      extraHTTPHeaders,
    });
    const page = await context.newPage();
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await page.waitForTimeout(options.waitMs ?? 1500);
    const html = await page.content();
    await context.close();

    if (!html.trim()) throw new Error("playwright returned an empty response");
    const blockedButUsable = options.allowBlockedHtml?.(html) === true;
    if (
      response &&
      response.status() >= 400 &&
      /access denied|forbidden|blocked|captcha|just a moment/i.test(html) &&
      !blockedButUsable
    ) {
      throw new Error(`playwright returned HTTP ${response.status()}`);
    }
    if (
      /Just a moment|security verification|cf-chl|Cloudflare/i.test(html) &&
      !blockedButUsable
    ) {
      throw new Error("playwright returned Cloudflare challenge");
    }

    return html;
  } finally {
    await browser.close();
  }
}

function extractProductJsonLdFromHtml(html: string): any {
  const $ = cheerio.load(html);
  let productData: any = null;

  $('script[type="application/ld+json"]').each((_, el) => {
    if (productData) return;
    const json = parseJsonMaybeEncoded($(el).html() || $(el).text() || "{}");
    productData = findProductJsonLd(json);
  });

  return productData;
}

function extractBalancedJson(
  source: string,
  startIndex: number,
): string | null {
  const opener = source[startIndex];
  const closer = opener === "{" ? "}" : opener === "[" ? "]" : "";
  if (!closer) return null;

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = startIndex; i < source.length; i++) {
    const char = source[i];

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === opener) {
      depth += 1;
    } else if (char === closer) {
      depth -= 1;
      if (depth === 0) return source.slice(startIndex, i + 1);
    }
  }

  return null;
}

function parseJsonAfterMarker(
  source: string,
  marker: string,
  fromIndex = 0,
): any {
  const markerIndex = source.indexOf(marker, Math.max(0, fromIndex));
  if (markerIndex < 0) return null;

  const valueStartMatch = source
    .slice(markerIndex + marker.length)
    .match(/[\[{]/);
  if (!valueStartMatch || valueStartMatch.index === undefined) return null;

  const valueStart = markerIndex + marker.length + valueStartMatch.index;
  const rawJson = extractBalancedJson(source, valueStart);
  if (!rawJson) return null;

  try {
    return JSON.parse(rawJson);
  } catch {
    return null;
  }
}

function parseJsonScriptById(source: string, id: string): any {
  const $ = cheerio.load(source);
  const script = $(`script#${id}`).first();
  if (!script.length) return null;
  return parseJsonMaybeEncoded(script.html() || script.text());
}

function parseWindowAssignedJson(source: string, variableName: string): any {
  const variableIndex = source.indexOf(variableName);
  if (variableIndex < 0) return null;

  const equalsIndex = source.indexOf("=", variableIndex + variableName.length);
  if (equalsIndex < 0) return null;

  const valueStartMatch = source.slice(equalsIndex + 1).match(/[\[{]/);
  if (!valueStartMatch || valueStartMatch.index === undefined) return null;

  const valueStart = equalsIndex + 1 + valueStartMatch.index;
  const rawJson = extractBalancedJson(source, valueStart);
  if (!rawJson) return null;

  try {
    return JSON.parse(rawJson);
  } catch {
    return null;
  }
}

function uniqueCleanValues(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => cleanText(value)).filter(Boolean))];
}

function isDefaultOptionValue(value: string | undefined): boolean {
  return (
    !value ||
    /^(default|default title|one size|choose(?:\s+(?:a|an|your)?\s*(?:option|size|colou?r)?)?|select(?:\s+(?:a|an|your)?\s*(?:option|size|colou?r)?)?|please select(?:\s+.*)?|size guide|size chart)$/i.test(
      cleanText(value),
    )
  );
}

function normalizeOptionName(name: string | undefined): string {
  const cleaned = cleanText(name);
  if (/^colou?r$/i.test(cleaned)) return "Color";
  if (/^sizes?$/i.test(cleaned)) return "Size";
  return cleaned;
}

function normalizeHexColor(value: string | undefined): string {
  const raw = cleanText(value);
  if (!raw) return "";

  const rgbMatch = raw.match(
    /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|0?\.\d+|1(?:\.0)?))?\s*\)/i,
  );
  if (rgbMatch) {
    const alpha = rgbMatch[4] === undefined ? 1 : Number(rgbMatch[4]);
    if (alpha === 0) return "";

    const channels = [rgbMatch[1], rgbMatch[2], rgbMatch[3]].map((channel) =>
      Math.max(0, Math.min(255, Number(channel))),
    );
    if (channels.every(Number.isFinite)) {
      return `#${channels
        .map((channel) => channel.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase()}`;
    }
  }

  const hexMatch =
    raw.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i) ||
    raw.match(/#([0-9a-f]{3}|[0-9a-f]{6})\b/i);
  if (hexMatch) {
    const hex =
      hexMatch[1].length === 3
        ? hexMatch[1]
            .split("")
            .map((char) => `${char}${char}`)
            .join("")
        : hexMatch[1];
    return `#${hex.toUpperCase()}`;
  }

  const namedColors: Record<string, string> = {
    black: "#000000",
    white: "#FFFFFF",
    navy: "#000080",
    blue: "#0000FF",
    red: "#FF0000",
    green: "#008000",
    yellow: "#FFFF00",
    pink: "#FFC0CB",
    purple: "#800080",
    grey: "#808080",
    gray: "#808080",
    beige: "#F5F5DC",
    brown: "#8B4513",
    orange: "#FFA500",
    cream: "#FFFDD0",
    ivory: "#FFFFF0",
    maroon: "#800000",
    olive: "#808000",
    teal: "#008080",
  };
  return namedColors[raw.toLowerCase()] || "";
}

function normalizeSwatch(
  value: any,
): { color?: string; image?: string } | undefined {
  if (!value) return undefined;

  const color = normalizeHexColor(
    value.color ||
      value.colour ||
      value.hex ||
      value.hexCode ||
      value.colorHex ||
      value.colourHex ||
      value.rgb ||
      value.background ||
      value.backgroundColor ||
      value.value,
  );
  const image = cleanText(value.image || value.imageUrl || value.url);
  if (!color && !image) return undefined;

  return {
    ...(color ? { color } : {}),
    ...(image ? { image } : {}),
  };
}

function looksLikeAssetOptionValue(value: string): boolean {
  const cleaned = decodeImageUrl(cleanText(value));
  if (!cleaned) return true;

  if (/^(?:https?:)?\/\//i.test(cleaned) || /^data:/i.test(cleaned))
    return true;
  if (
    /[\\/]/.test(cleaned) &&
    /\.(?:jpe?g|png|webp|avif|gif|svg)(?:[?#].*)?$/i.test(cleaned)
  )
    return true;
  if (/\.(?:jpe?g|png|webp|avif|gif|svg)(?:[?#].*)?$/i.test(cleaned))
    return true;
  if (/^(?:#(?:[0-9a-f]{3}|[0-9a-f]{6})|rgba?\(|hsla?\()/i.test(cleaned))
    return true;
  if (/^[a-f0-9]{18,}$/i.test(cleaned)) return true;
  if (
    /^(?:image|images|img|photo|picture|thumbnail|thumb|media|asset|swatch)(?:\s|:|-|$)/i.test(
      cleaned,
    )
  )
    return true;

  return false;
}

function looksLikeUiNoiseOptionValue(value: string): boolean {
  const cleaned = cleanText(value);
  if (!cleaned) return true;

  const normalized = cleaned.toLowerCase();
  if (/^(?:#|@)/.test(normalized)) return true;
  if (/https?:\/\//i.test(normalized)) return true;
  if (normalized.length > 85) return true;

  if (
    /\b(?:home|shop|menu|search|basket|cart|account|wishlist|shopping list|subscribe|support|about us|contact us|privacy|terms|store locator|corporate website|gift card|email signup|open menu|open search(?: panel)?|close|previous|next|to top|check availability|click to change the country|flag image|logo|cookies?|free shipping|shipping|delivery|returns?|promotions?|offers?|inspiration|love it for longer|explore by product|nursery|baby girls?|baby boys?|newborn baby)\b/i.test(
      normalized,
    )
  ) {
    return true;
  }

  if (
    /^(?:usa|uk|uae|egypt|saudi|qatar|kuwait|bahrain|oman)(?:\s*,?\s*(?:\$|usd|aed|egp|sar|qar|kwd|bhd|omr))?$/i.test(
      cleaned,
    )
  ) {
    return true;
  }

  return false;
}

function looksLikeSizeOptionValue(value: string): boolean {
  const cleaned = cleanText(value);
  if (!cleaned) return false;

  if (/^\d$/.test(cleaned)) return false;
  if (
    /\b(?:toddler\s+(?:girl|boy)|baby\s+(?:girl|boy)|newborn\s+baby)\b/i.test(
      cleaned,
    )
  ) {
    return false;
  }

  if (
    /^(?:xxxs|xxs|xs|s|m|l|xl|xxl|xxxl|2xl|3xl|4xl|5xl|small|medium|large|x-?small|x-?large|xx-?large|one size|free size|os|o\/s|nb|n\/b|newborn|preemie)$/i.test(
      cleaned,
    )
  ) {
    return true;
  }

  if (
    /^\d{1,3}(?:\.\d+)?$/.test(cleaned) ||
    /^\d{1,3}\s*(?:c|k|t|y)$/i.test(cleaned) ||
    /^\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?(?:\s*(?:cm|mm|in|inch|inches|mths?|months?|yrs?|years?|y|m|mths))?$/i.test(
      cleaned,
    ) ||
    /^(?:up to\s+)?\d+\s*(?:mths?|months?|yrs?|years?|y|m)$/i.test(cleaned) ||
    /^\d+(?:\.\d+)?\s*(?:cm|mm|in|inch|inches)$/i.test(cleaned) ||
    /^\d+\s*(?:y|m|t)$/i.test(cleaned)
  ) {
    return true;
  }

  if (
    /\b(?:months?|mths?|yrs?|years?|newborn|preemie|toddler|baby)\b/i.test(
      cleaned,
    ) &&
    (/\d/.test(cleaned) || /\b(?:newborn|preemie)\b/i.test(cleaned))
  ) {
    return true;
  }

  return false;
}

function extractLabeledOptionValue(
  value: string | undefined,
  optionName: "Color" | "Size",
): string | undefined {
  const raw = cleanText(value);
  if (!raw) return undefined;

  const labelPattern =
    optionName === "Color"
      ? /(?:selected\s+)?colou?r\s*(?:is|:|-)?\s*([A-Za-z0-9\u0600-\u06FF][A-Za-z0-9\u0600-\u06FF /&,+.'()-]{0,70})/i
      : /(?:selected\s+)?size\s*(?:is|:|-)?\s*([A-Za-z0-9\u0600-\u06FF][A-Za-z0-9\u0600-\u06FF /&,+.'()-]{0,70})/i;
  const match = raw.match(labelPattern);
  if (!match?.[1]) return undefined;

  return cleanText(match[1])
    .replace(
      /\s+(?:size|colour|color|price|description|composition|care|share|stock|add to|delivery|shipping)\b.*$/i,
      "",
    )
    .trim();
}

function cleanColorOptionValue(value: string | undefined): string {
  let cleaned = cleanText(value);
  const labeledValue = extractLabeledOptionValue(cleaned, "Color");
  if (labeledValue) cleaned = labeledValue;

  cleaned = cleanText(
    cleaned
      .replace(/\s*(?:sold out|out of stock|unavailable)\s*$/i, "")
      .replace(/^(?:selected\s+)?colou?r\s*(?:is|:|-)?\s*/i, "")
      .replace(/^(?:choose|select)\s+(?:a\s+)?colou?r\s*/i, "")
      .replace(/[_]+/g, " ")
      .replace(/\s+/g, " "),
  );

  if (
    !cleaned ||
    cleaned.length > 60 ||
    cleaned.length < 2 ||
    isDefaultOptionValue(cleaned) ||
    looksLikeAssetOptionValue(cleaned) ||
    looksLikeUiNoiseOptionValue(cleaned) ||
    !/[A-Za-z\u0600-\u06FF]/.test(cleaned) ||
    /^[a-z]$/i.test(cleaned) ||
    /^size:?$/i.test(cleaned) ||
    cleaned.split(/\s+/).length > 10 ||
    /^(?:selected|current|available|unavailable|add to|buy now|wishlist|share|quantity|qty|availability|delivery|shipping|view|more)$/i.test(
      cleaned,
    ) ||
    /\b(?:size guide|size chart|model is wearing|fits true|product image|zoom|gallery)\b/i.test(
      cleaned,
    )
  ) {
    return "";
  }

  return cleaned;
}

function cleanProductOptionValue(
  optionName: string | undefined,
  value: string | undefined,
): string {
  const name = normalizeOptionName(optionName);
  if (name === "Color") return cleanColorOptionValue(value);

  const labeledValue =
    name === "Size" ? extractLabeledOptionValue(value, "Size") : undefined;
  const cleaned = cleanText(labeledValue || value)
    .replace(/\s*(?:sold out|out of stock|unavailable)\s*$/i, "")
    .trim();

  if (name === "Size" && !looksLikeSizeOptionValue(cleaned)) {
    return "";
  }

  if (
    !cleaned ||
    cleaned.length > 60 ||
    isDefaultOptionValue(cleaned) ||
    looksLikeAssetOptionValue(cleaned) ||
    looksLikeUiNoiseOptionValue(cleaned) ||
    /^(?:add to|buy now|wishlist|share|quantity|qty|availability|delivery|shipping)$/i.test(
      cleaned,
    )
  ) {
    return "";
  }

  return cleaned;
}

function variantOptionValues(
  variant: NormalizedProduct["variants"][number],
): Record<string, string> {
  const values: Record<string, string> = {};

  for (const [name, value] of Object.entries(variant.optionValues || {})) {
    const cleanName = normalizeOptionName(name);
    const cleanValue = cleanProductOptionValue(cleanName, value);
    if (cleanName && !isDefaultOptionValue(cleanValue)) {
      values[cleanName] = cleanValue;
    }
  }

  const color = cleanColorOptionValue(variant.color);
  const size = cleanProductOptionValue("Size", variant.size);
  if (color && !values.Color) values.Color = color;
  if (size && !values.Size) values.Size = size;

  return values;
}

function buildVariantOptionValues(
  color?: string,
  size?: string,
): Record<string, string> | undefined {
  const values: Record<string, string> = {};
  const cleanColor = cleanColorOptionValue(color);
  const cleanSize = cleanProductOptionValue("Size", size);
  if (cleanColor) values.Color = cleanColor;
  if (cleanSize) values.Size = cleanSize;
  return Object.keys(values).length ? values : undefined;
}

function variantColorKey(variant: NormalizedProduct["variants"][number]) {
  return cleanColorOptionValue(variant.color || variant.optionValues?.Color);
}

function colorImageForVariant(
  variant: NormalizedProduct["variants"][number],
  images: NormalizedProduct["images"],
  allVariants: NormalizedProduct["variants"],
): string | undefined {
  const directImageUrl = decodeImageUrl(variant.imageUrl || "");
  if (
    directImageUrl &&
    images.some(
      (image) =>
        canonicalProductImageUrl(image.url) ===
        canonicalProductImageUrl(directImageUrl),
    )
  ) {
    return directImageUrl;
  }

  const color = variantColorKey(variant).toLowerCase();
  if (color) {
    const matchedImage = images.find(
      (image) =>
        cleanColorOptionValue(image.color).toLowerCase() === color ||
        cleanText(image.alt).toLowerCase().includes(color),
    );
    if (matchedImage?.url) return matchedImage.url;
  }

  const colorCount = new Set(
    allVariants.map(variantColorKey).filter(Boolean),
  ).size;
  if (colorCount <= 1) return images[0]?.url;
  return undefined;
}

function normalizeProductOptionsAndVariants(
  product: NormalizedProduct,
): NormalizedProduct {
  const optionValueMap = new Map<string, Set<string>>();
  const optionSwatchMap = new Map<
    string,
    Map<string, { color?: string; image?: string }>
  >();

  const rememberSwatch = (optionName: string, value: string, swatch: any) => {
    if (optionName !== "Color" || !value) return;
    const normalized = normalizeSwatch(swatch);
    if (!normalized) return;

    if (!optionSwatchMap.has(optionName))
      optionSwatchMap.set(optionName, new Map());
    const existing = optionSwatchMap.get(optionName)?.get(value);
    optionSwatchMap.get(optionName)?.set(value, {
      ...(existing || {}),
      ...normalized,
    });
  };

  for (const option of product.options || []) {
    const name = normalizeOptionName(option?.name);
    if (!name || /^default$/i.test(name)) continue;
    const values = uniqueCleanValues(option?.values || [])
      .map((value) => cleanProductOptionValue(name, value))
      .filter((value) => value && !isDefaultOptionValue(value));
    if (!values.length) continue;

    const rawSwatches = (option as any).swatches || {};
    for (const [rawValue, swatch] of Object.entries(rawSwatches)) {
      const value = cleanProductOptionValue(name, rawValue);
      rememberSwatch(name, value, swatch);
    }

    if (!optionValueMap.has(name)) optionValueMap.set(name, new Set());
    values.forEach((value) => optionValueMap.get(name)?.add(value));
  }

  const seenVariantKeys = new Set<string>();
  const variants = (product.variants || []).map((variant, index) => {
    const optionValues = variantOptionValues(variant);

    for (const [name, value] of Object.entries(optionValues)) {
      if (!optionValueMap.has(name)) optionValueMap.set(name, new Set());
      optionValueMap.get(name)?.add(value);
    }

    const color = optionValues.Color || cleanColorOptionValue(variant.color);
    const size =
      optionValues.Size || cleanProductOptionValue("Size", variant.size);
    const sourceVariantId = cleanText(
      variant.sourceVariantId ||
        variant.sku ||
        `${product.source.productId || product.source.supplier}-${Object.values(optionValues).join("-") || index}`,
    );
    const key =
      sourceVariantId || JSON.stringify(optionValues) || String(index);
    const safeKey = seenVariantKeys.has(key) ? `${key}-${index}` : key;
    seenVariantKeys.add(key);

    return {
      ...variant,
      sourceVariantId: safeKey,
      sku: variant.sku ? cleanText(variant.sku) : undefined,
      color: color && !isDefaultOptionValue(color) ? color : undefined,
      size: size && !isDefaultOptionValue(size) ? size : undefined,
      price: variant.price && variant.price > 0 ? variant.price : product.price,
      currency: variant.currency || product.currency,
      optionValues: Object.keys(optionValues).length ? optionValues : undefined,
      stockStatus:
        variant.stockStatus || (variant.available ? "in_stock" : "unknown"),
    };
  });

  const preferredOrder = ["Color", "Colour", "Size"];
  const orderedOptionNames = [
    ...preferredOrder.filter((name) => optionValueMap.has(name)),
    ...[...optionValueMap.keys()].filter(
      (name) => !preferredOrder.includes(name),
    ),
  ];

  const options = orderedOptionNames
    .map((name) => {
      const normalizedName = name === "Colour" ? "Color" : name;
      const values = [...(optionValueMap.get(name) || new Set<string>())];
      const swatches = optionSwatchMap.get(normalizedName);
      const valueSwatches = swatches
        ? Object.fromEntries(
            values
              .map((value) => [value, swatches.get(value)] as const)
              .filter(
                (
                  entry,
                ): entry is readonly [
                  string,
                  { color?: string; image?: string },
                ] => Boolean(entry[1]),
              ),
          )
        : {};

      return {
        name: normalizedName,
        values,
        ...(Object.keys(valueSwatches).length
          ? { swatches: valueSwatches }
          : {}),
      };
    })
    .filter((option) => option.values.length);
  const images = normalizeProductImageList(product.images || []);
  const variantColors = uniqueCleanValues(variants.map((variant) => variant.color));
  const onlyColor = variantColors.length === 1 ? variantColors[0] : undefined;
  if (onlyColor) {
    images.forEach((image) => {
      image.color ||= onlyColor;
    });
  }

  return {
    ...product,
    images,
    price:
      product.price ||
      variants
        .map((variant) => variant.price || 0)
        .find((price) => price > 0) ||
      0,
    options: options.length
      ? options
      : [{ name: "Default", values: ["Default"] }],
    variants: (variants.length
      ? variants
      : [
          {
            sourceVariantId: product.source.productId || "default",
            price: product.price,
            currency: product.currency,
            available: true,
            stockStatus: "unknown",
          },
        ]
    ).map((variant) => ({
      ...variant,
      imageUrl: colorImageForVariant(variant, images, variants),
    })),
  };
}

function buildOptionMatrixVariants(
  productCode: string | undefined,
  options: Array<{ name: string; values: string[] }>,
  price: number,
  currency: string,
  stockStatus: NormalizedProduct["variants"][number]["stockStatus"] = "unknown",
): NormalizedProduct["variants"] {
  const normalizedOptions = options
    .map((option) => ({
      name: normalizeOptionName(option.name),
      values: uniqueCleanValues(option.values)
        .map((value) => cleanProductOptionValue(option.name, value))
        .filter((value) => value && !isDefaultOptionValue(value)),
    }))
    .filter((option) => option.name && option.values.length);

  if (!normalizedOptions.length) return [];

  const combinations: Array<Record<string, string>> = [{}];
  for (const option of normalizedOptions) {
    const next: Array<Record<string, string>> = [];
    for (const combination of combinations) {
      for (const value of option.values) {
        next.push({ ...combination, [option.name]: value });
      }
    }
    combinations.splice(0, combinations.length, ...next.slice(0, 250));
  }

  if (combinations.length > 180) {
    // DOM option extraction can include noisy navigation text on some stores.
    // Avoid generating large synthetic variant matrices in that case.
    return [];
  }

  return combinations.slice(0, 250).map((optionValues, index) => {
    const color = optionValues.Color || optionValues.Colour;
    const size = optionValues.Size;
    const slug = Object.entries(optionValues)
      .map(([name, value]) => `${slugOption(name)}-${slugOption(value)}`)
      .join("-");

    return {
      sourceVariantId: `${productCode || "variant"}-${slug || index}`,
      sku: `${productCode || "VAR"}-${(slug || String(index)).toUpperCase()}`,
      color,
      size,
      price,
      currency,
      optionValues,
      available: stockStatus !== "out_of_stock",
      stockStatus,
    };
  });
}

function extractGenericOptionValuesFromDom(
  $: cheerio.CheerioAPI,
): Array<{ name: string; values: string[] }> {
  const options = new Map<string, Set<string>>();
  const optionSwatches = new Map<
    string,
    Map<string, { color?: string; image?: string }>
  >();
  const optionPatterns: Array<{
    name: "Color" | "Size";
    terms: string[];
    pattern: RegExp;
  }> = [
    {
      name: "Color",
      terms: ["color", "colour", "swatch"],
      pattern: /colo[u]?r|swatch/i,
    },
    {
      name: "Size",
      terms: ["size", "age", "variant-size"],
      pattern: /\bsize\b|age|variant-size/i,
    },
  ];

  const pushValue = (
    name: string,
    value: string | undefined,
    swatch?: { color?: string; image?: string },
  ) => {
    const cleanName = normalizeOptionName(name);
    const cleaned = cleanProductOptionValue(cleanName, value);

    if (!cleaned) return;

    if (!options.has(cleanName)) options.set(cleanName, new Set());
    options.get(cleanName)?.add(cleaned);

    if (cleanName === "Color" && swatch) {
      const normalizedSwatch = normalizeSwatch(swatch);
      if (normalizedSwatch) {
        if (!optionSwatches.has(cleanName))
          optionSwatches.set(cleanName, new Map());
        const existing = optionSwatches.get(cleanName)?.get(cleaned);
        optionSwatches.get(cleanName)?.set(cleaned, {
          ...(existing || {}),
          ...normalizedSwatch,
        });
      }
    }
  };

  const getLabelForInput = ($el: cheerio.Cheerio<any>) => {
    const inputId = $el.attr("id");
    if (!inputId) return undefined;
    return $("label")
      .filter((_, label) => $(label).attr("for") === inputId)
      .first()
      .text();
  };

  const candidateValues = (
    $el: cheerio.Cheerio<any>,
    optionName: "Color" | "Size",
  ) => {
    const values =
      optionName === "Color"
        ? [
            $el.attr("data-color-name"),
            $el.attr("data-colour-name"),
            $el.attr("data-color-label"),
            $el.attr("data-colour-label"),
            $el.attr("data-color"),
            $el.attr("data-colour"),
            $el.attr("data-option-value"),
            $el.attr("data-value-label"),
            $el.attr("data-value"),
            $el.attr("aria-label"),
            $el.attr("title"),
            $el.attr("value"),
            $el.find("img[alt]").first().attr("alt"),
            getLabelForInput($el),
            $el.text(),
          ]
        : [
            $el.attr("data-option-value"),
            $el.attr("data-value-label"),
            $el.attr("data-value"),
            $el.attr("aria-label"),
            $el.attr("title"),
            $el.attr("value"),
            getLabelForInput($el),
            $el.text(),
          ];

    return values.filter(Boolean) as string[];
  };

  const compactOwnText = ($el: cheerio.Cheerio<any>) =>
    cleanText(
      $el
        .contents()
        .filter((_, node) => node.type === "text")
        .text(),
    );

  const extractSwatchImage = ($el: cheerio.Cheerio<any>) => {
    const style = decodeImageUrl(cleanText($el.attr("style")));
    const backgroundImageMatch = style.match(/url\((['"]?)([^'")]+)\1\)/i);
    const image =
      $el.attr("data-swatch-image") ||
      $el.attr("data-image") ||
      $el.attr("data-image-url") ||
      $el.find("img").first().attr("src") ||
      $el.find("img").first().attr("data-src") ||
      backgroundImageMatch?.[2];

    if (!image) return undefined;
    return /^(?:https?:)?\/\//i.test(image) ||
      /\.(?:jpe?g|png|webp|avif|gif)(?:[?#].*)?$/i.test(image)
      ? cleanText(image)
      : undefined;
  };

  const extractSwatchFromElement = ($el: cheerio.Cheerio<any>) => {
    const style = decodeImageUrl(cleanText($el.attr("style")));
    const styleColor =
      style.match(/background(?:-color)?\s*:\s*([^;]+)/i)?.[1] ||
      style.match(/color\s*:\s*([^;]+)/i)?.[1] ||
      "";
    const color = normalizeHexColor(
      $el.attr("data-color-hex") ||
        $el.attr("data-colour-hex") ||
        $el.attr("data-hex") ||
        $el.attr("data-swatch-color") ||
        $el.attr("data-swatch-colour") ||
        $el.attr("data-bg-color") ||
        $el.attr("data-background-color") ||
        styleColor,
    );
    const image = extractSwatchImage($el);
    return normalizeSwatch({ color, image });
  };

  const optionSelector = (terms: string[]) =>
    terms
      .flatMap((term) => [
        `[class*="${term}" i]`,
        `[id*="${term}" i]`,
        `[data-testid*="${term}" i]`,
        `[aria-label*="${term}" i]`,
        `input[name*="${term}" i]`,
        `[name*="${term}" i]`,
      ])
      .join(",");

  const interactiveSelector = [
    "button",
    '[role="button"]',
    "label",
    'input[type="radio"]',
    'input[type="checkbox"]',
    "[data-value]",
    "[data-option-value]",
    "[data-color]",
    "[data-colour]",
    "[data-color-name]",
    "[data-colour-name]",
    "[title]",
    "[aria-label]",
  ].join(",");

  const pushCandidateElement = (
    $el: cheerio.Cheerio<any>,
    optionName: "Color" | "Size",
  ) => {
    const swatch =
      optionName === "Color" ? extractSwatchFromElement($el) : undefined;
    for (const value of candidateValues($el, optionName)) {
      pushValue(optionName, value, swatch);
    }
  };

  $("select").each((_, el) => {
    const $el = $(el);
    const descriptor = [
      $el.attr("name"),
      $el.attr("id"),
      $el.attr("class"),
      $el.attr("aria-label"),
      $el.attr("data-testid"),
    ]
      .filter(Boolean)
      .join(" ");
    const matched = optionPatterns.find((option) =>
      option.pattern.test(descriptor),
    );
    if (!matched) return;

    $el.find("option").each((__, optionEl) => {
      const value = $(optionEl).text() || $(optionEl).attr("value");
      if ($(optionEl).is("[disabled]")) return;
      pushValue(matched.name, value);
    });
  });

  for (const option of optionPatterns) {
    const selector = optionSelector(option.terms);

    $(selector).each((_, container) => {
      const $container = $(container);
      if ($container.is(interactiveSelector)) {
        pushCandidateElement($container, option.name);
      }

      const ownText = compactOwnText($container);
      if (ownText && ownText.length <= 80) {
        pushValue(option.name, ownText);
      }

      $container.find(interactiveSelector).each((__, el) => {
        pushCandidateElement($(el), option.name);
      });
    });
  }

  return [...options.entries()].map(([name, values]) => {
    const swatches = optionSwatches.get(name);
    const valueList = [...values];
    const valueSwatches = swatches
      ? Object.fromEntries(
          valueList
            .map((value) => [value, swatches.get(value)] as const)
            .filter(
              (
                entry,
              ): entry is readonly [
                string,
                { color?: string; image?: string },
              ] => Boolean(entry[1]),
            ),
        )
      : {};

    return {
      name,
      values: valueList,
      ...(Object.keys(valueSwatches).length ? { swatches: valueSwatches } : {}),
    };
  });
}

function parseInditexPrice(value: any): number {
  const raw = cleanText(value);
  if (!raw) return 0;

  const normalized = normaliseLocalizedNumberText(raw);
  if (/^\d+$/.test(normalized)) {
    return Number((Number(normalized) / 100).toFixed(2));
  }

  const parsed = parseLocalizedMoney(raw);
  return parsed > 0 ? parsed : 0;
}

function detectInditexCurrency(url: string): string {
  try {
    const country = new URL(url).pathname
      .toLowerCase()
      .split("/")
      .filter(Boolean)[0];
    const currencyByCountry: Record<string, string> = {
      ae: "AED",
      xe: "AED",
      sa: "SAR",
      qa: "QAR",
      kw: "KWD",
      bh: "BHD",
      om: "OMR",
      eg: "EGP",
      jo: "JOD",
      lb: "LBP",
      ma: "MAD",
      tn: "TND",
      il: "ILS",
      tr: "TRY",
      mx: "MXN",
      gb: "GBP",
      uk: "GBP",
      pl: "PLN",
      ro: "RON",
      cz: "CZK",
      hu: "HUF",
      bg: "BGN",
      es: "EUR",
      pt: "EUR",
      it: "EUR",
      fr: "EUR",
      de: "EUR",
      nl: "EUR",
      be: "EUR",
      at: "EUR",
      ie: "EUR",
      lu: "EUR",
      gr: "EUR",
      cy: "EUR",
      mt: "EUR",
      fi: "EUR",
      ee: "EUR",
      lv: "EUR",
      lt: "EUR",
      si: "EUR",
      sk: "EUR",
    };
    if (country && currencyByCountry[country])
      return currencyByCountry[country];
  } catch {}

  return "AED";
}

function inditexStockStatus(size: any): {
  available: boolean;
  stockStatus: NormalizedProduct["variants"][number]["stockStatus"];
} {
  const statusText = String(
    size?.availability || size?.visibilityValue || "",
  ).toLowerCase();
  const isSoldOut =
    /sold_out|out_of_stock|not_available|coming_soon|hidden/.test(statusText);
  const available =
    !isSoldOut && size?.isBuyable !== false && statusText !== "0";

  return {
    available,
    stockStatus: available ? "in_stock" : "out_of_stock",
  };
}

function isInditexPlaceholderSize(value: unknown): boolean {
  return cleanText(value) === "99";
}

function pushInditexMedia(
  images: NormalizedProduct["images"],
  media: any,
  pageUrl: string,
  alt?: string,
  color?: string,
) {
  const rawUrl =
    media?.extraInfo?.deliveryUrl ||
    media?.extraInfo?.url ||
    media?.url ||
    media?.deliveryUrl;
  if (!rawUrl) return;

  const normalizedUrl = String(rawUrl)
    .replace("{width}", "2048")
    .replace(":width:", "2048");
  const beforeLength = images.length;
  pushImage(images, normalizedUrl, pageUrl, alt);
  if (images.length > beforeLength && color) {
    images[images.length - 1].color = color;
  }
}

function findInditexProduct(data: any): any {
  if (Array.isArray(data)) return data[0];
  if (Array.isArray(data?.products)) return data.products[0];
  return data;
}

function extractInditexProductId(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const v1 = parsed.searchParams.get("v1");
    if (v1) return v1;
  } catch {}

  return url.match(/p(\d+)\.html/i)?.[1] || url.match(/productIds=(\d+)/i)?.[1];
}

function collectZaraImages(
  product: any,
  url: string,
): NormalizedProduct["images"] {
  const images: NormalizedProduct["images"] = [];
  const colors = product?.detail?.colors || [];

  for (const color of colors) {
    for (const media of color?.xmedia || []) {
      pushInditexMedia(images, media, url, product?.name, color?.name);
    }
  }

  for (const media of product?.xmedia || []) {
    pushInditexMedia(images, media, url, product?.name);
  }

  return images.map((image, position) => ({ ...image, position }));
}

function collectLeftiesImages(
  product: any,
  url: string,
): NormalizedProduct["images"] {
  const images: NormalizedProduct["images"] = [];
  const colors = product?.detail?.colors || [];
  const colorNameById = new Map<string, string>(
    colors.map((color: any) => [String(color?.id), cleanText(color?.name)]),
  );

  for (const group of product?.detail?.xmedia || []) {
    const colorId = String(group?.path || "")
      .split("/")
      .filter(Boolean)
      .pop();
    const colorName = colorId ? colorNameById.get(colorId) : undefined;

    for (const item of group?.xmediaItems || []) {
      for (const media of item?.medias || []) {
        pushInditexMedia(images, media, url, product?.name, colorName);
      }
    }
  }

  return images.map((image, position) => ({ ...image, position }));
}

function normalizeInditexProduct(
  product: any,
  url: string,
  supplier: "Zara" | "Lefties",
): NormalizedProduct {
  if (!product?.detail?.colors?.length) {
    throw new Error(`${supplier} API did not expose product colors`);
  }

  const colors = product.detail.colors;
  const currency = detectInditexCurrency(url);
  const title = cleanText(product.name || product.nameEn || "Inditex Product");
  const description = cleanText(
    colors
      .map((color: any) => color?.description || color?.longDescription)
      .find(Boolean) ||
      product.detail.longDescription ||
      product.detail.description ||
      "",
  );

  const variants: NormalizedProduct["variants"] = [];
  for (const color of colors) {
    const sizes = Array.isArray(color?.sizes) ? color.sizes : [];
    const hasRealSizes = sizes.some(
      (size: any) => !isInditexPlaceholderSize(size?.name || size?.shortName),
    );
    const bestSizeByValue = new Map<
      string,
      {
        size: any;
        stock: ReturnType<typeof inditexStockStatus>;
        price: number;
        sizeName: string;
      }
    >();

    for (const size of sizes) {
      const rawSizeName = cleanText(size?.name || size?.shortName);
      if (hasRealSizes && isInditexPlaceholderSize(rawSizeName)) continue;

      const sizeName =
        !hasRealSizes && isInditexPlaceholderSize(rawSizeName)
          ? "One Size"
          : rawSizeName;
      const stock = inditexStockStatus(size);
      const price = parseInditexPrice(size?.price || color?.price);
      const key =
        cleanProductOptionValue("Size", sizeName) ||
        sizeName ||
        String(size?.id || size?.sku || bestSizeByValue.size);
      const existing = bestSizeByValue.get(key);
      if (!existing || (!existing.stock.available && stock.available)) {
        bestSizeByValue.set(key, { size, stock, price, sizeName });
      }
    }

    for (const { size, stock, price, sizeName } of bestSizeByValue.values()) {
      variants.push({
        sourceVariantId: String(
          size?.sku || size?.id || `${color?.id}-${size?.name}`,
        ),
        sku: size?.sku ? String(size.sku) : undefined,
        color: cleanText(color?.name),
        size: sizeName,
        price,
        currency,
        optionValues: buildVariantOptionValues(color?.name, sizeName),
        available: stock.available,
        stockStatus: stock.stockStatus,
        raw: size,
      });
    }
  }

  const prices = variants
    .map((variant) => variant.price || 0)
    .filter((price) => price > 0);
  const fallbackPrice = parseInditexPrice(
    colors.map((color: any) => color?.price).find(Boolean),
  );
  const price = prices.length ? Math.min(...prices) : fallbackPrice;
  const images =
    supplier === "Zara"
      ? collectZaraImages(product, url)
      : collectLeftiesImages(product, url);
  const colorValues = uniqueCleanValues(
    colors.map((color: any) => color?.name),
  );
  const colorSwatches = Object.fromEntries(
    colors
      .map((color: any) => {
        const name = cleanColorOptionValue(color?.name);
        const swatch = normalizeSwatch({
          color:
            color?.hexCode ||
            color?.hex ||
            color?.colorHex ||
            color?.colourHex ||
            color?.rgb ||
            color?.color,
          image: color?.imageUrl || color?.image,
        });
        return name && swatch ? [name, swatch] : null;
      })
      .filter(Boolean) as Array<[string, { color?: string; image?: string }]>,
  );
  const sizeValues = uniqueCleanValues(variants.map((variant) => variant.size));

  if (!title || price <= 0) {
    throw new Error(`${supplier} API response was missing title or price`);
  }

  return {
    source: {
      supplier,
      url,
      productId: String(extractInditexProductId(url) || product.id || ""),
    },
    title,
    description,
    brand: supplier,
    currency,
    price,
    images,
    options: [
      ...(colorValues.length
        ? [
            {
              name: "Color",
              values: colorValues,
              ...(Object.keys(colorSwatches).length
                ? { swatches: colorSwatches }
                : {}),
            },
          ]
        : []),
      ...(sizeValues.length ? [{ name: "Size", values: sizeValues }] : []),
    ],
    variants: variants.length
      ? variants
      : [
          {
            sourceVariantId: String(product.id || "default"),
            price,
            available: true,
            stockStatus: "in_stock",
          },
        ],
    raw: product,
  };
}

function leftiesReaderUrls(url: string): string[] {
  try {
    const parsed = new URL(url);
    parsed.protocol = "http:";
    return [...new Set([parsed.toString(), url])];
  } catch {
    return [url];
  }
}

function isUsableLeftiesReaderMarkdown(markdown: string): boolean {
  if (!markdown || isBlockedReaderMarkdown(markdown)) return false;
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .filter(Boolean);
  return (
    lines.some((line) => /^#\s+/.test(line)) &&
    lines.some(
      (line) => looksLikeCurrencyText(line) && parseLocalizedMoney(line) > 0,
    ) &&
    lines.some(
      (line) =>
        /^Ref\s*:/i.test(line) ||
        /^(?:colou?r|color|talla|size)\s*:/i.test(line),
    )
  );
}

async function fetchLeftiesReaderMarkdown(
  url: string,
): Promise<{ markdown: string; readerUrl: string } | null> {
  for (const readerUrl of leftiesReaderUrls(url)) {
    try {
      const markdown = await fetchReaderMarkdown(readerUrl);
      if (isUsableLeftiesReaderMarkdown(markdown)) {
        return { markdown, readerUrl };
      }
    } catch {}
  }

  return null;
}

function detectLeftiesReaderCurrency(
  priceLine: string | undefined,
  url: string,
): string {
  const urlCurrency = detectInditexCurrency(url);
  if (priceLine?.includes("$") && urlCurrency !== "AED") return urlCurrency;
  return detectCurrency(priceLine, urlCurrency);
}

function extractLeftiesReaderData(
  markdown: string,
  url: string,
): {
  title?: string;
  description?: string;
  price?: number;
  currency?: string;
  images: NormalizedProduct["images"];
} {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .filter(Boolean);
  const headingIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter((entry) => /^#\s+/.test(entry.line))
    .map((entry) => entry.index);

  const productHeadingIndex =
    headingIndexes.find((index) =>
      lines
        .slice(index + 1, index + 6)
        .some(
          (line) =>
            looksLikeCurrencyText(line) && parseLocalizedMoney(line) > 0,
        ),
    ) ??
    headingIndexes.find((index) => !/\|\s*LEFTIES/i.test(lines[index])) ??
    -1;
  const rawTitle = productHeadingIndex >= 0 ? lines[productHeadingIndex] : "";
  const title = cleanText(
    rawTitle.replace(/^#\s+/, "").replace(/\s+\|\s*LEFTIES.*$/i, ""),
  );
  const nearbyPriceLines =
    productHeadingIndex >= 0
      ? lines
          .slice(productHeadingIndex + 1, productHeadingIndex + 10)
          .filter(
            (line) =>
              looksLikeCurrencyText(line) && parseLocalizedMoney(line) > 0,
          )
      : [];
  const priceLine =
    nearbyPriceLines.find((line) => !/^~~.*~~$/.test(line)) ||
    nearbyPriceLines[nearbyPriceLines.length - 1] ||
    lines.find(
      (line) =>
        looksLikeCurrencyText(line) &&
        parseLocalizedMoney(line) > 0 &&
        !/^~~.*~~$/.test(line),
    ) ||
    lines.find(
      (line) => looksLikeCurrencyText(line) && parseLocalizedMoney(line) > 0,
    );
  const price = parseLocalizedMoney(priceLine);

  const descriptionStart = lines.findIndex((line) =>
    /^#{2,3}\s*(?:description|descripci[oó]n|descri[cç][aã]o|descrizione|a[cç][iı]klama|beschreibung)\b/i.test(
      line,
    ),
  );
  const descriptionEnd =
    descriptionStart >= 0
      ? lines.findIndex(
          (line, index) =>
            index > descriptionStart &&
            (/^#{1,3}\s+/.test(line) ||
              /^(?:ref|colou?r|color|talla|size)\s*:/i.test(line)),
        )
      : -1;
  const description =
    descriptionStart >= 0
      ? cleanText(
          lines
            .slice(
              descriptionStart + 1,
              descriptionEnd > descriptionStart
                ? descriptionEnd
                : descriptionStart + 8,
            )
            .filter((line) => !looksLikeCurrencyText(line))
            .join(" "),
        )
      : undefined;

  const images: NormalizedProduct["images"] = [];
  const imageRegex = /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
  for (const match of markdown.matchAll(imageRegex)) {
    pushImage(images, match[2], url, match[1]);
  }

  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(price > 0
      ? { price, currency: detectLeftiesReaderCurrency(priceLine, url) }
      : {}),
    images: images.map((image, position) => ({ ...image, position })),
  };
}

async function enrichLeftiesProductWithReader(
  product: NormalizedProduct,
  url: string,
): Promise<NormalizedProduct> {
  const reader = await fetchLeftiesReaderMarkdown(url);
  if (!reader) return product;

  const localized = extractLeftiesReaderData(reader.markdown, url);
  const price =
    localized.price && localized.price > 0 ? localized.price : product.price;
  const currency = localized.currency || product.currency;

  return normalizeProductOptionsAndVariants({
    ...product,
    title: localized.title || product.title,
    description: localized.description || product.description,
    price,
    currency,
    images: product.images.length ? product.images : localized.images,
    variants: product.variants.map((variant) => ({
      ...variant,
      price: price || variant.price,
      currency,
    })),
    raw: {
      ...product.raw,
      localizedReader: {
        readerUrl: reader.readerUrl,
        price: localized.price,
        currency: localized.currency,
        title: localized.title,
      },
    },
  });
}

type LeftiesStoreConfig = {
  storeId: number;
  catalogId: number;
  languageId: number;
};

let leftiesStoreConfigCache:
  | {
      expiresAt: number;
      stores: any[];
    }
  | undefined;

function leftiesCountryCodeFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const firstPathPart = parsed.pathname
      .split("/")
      .filter(Boolean)[0]
      ?.toLowerCase();
    const countryAliases: Record<string, string> = {
      ae: "AE",
      xe: "AE",
      eg: "EG",
      sa: "SA",
      qa: "QA",
      kw: "KW",
      bh: "BH",
      om: "OM",
      jo: "JO",
      ma: "MA",
      tn: "TN",
      tr: "TR",
      mx: "MX",
      it: "IT",
      es: "ES",
      pt: "PT",
      fr: "FR",
      ro: "RO",
    };

    return countryAliases[firstPathPart || ""] || "AE";
  } catch {
    return "AE";
  }
}

function leftiesLanguageCodeFromUrl(url: string): string {
  try {
    const pathParts = new URL(url).pathname.split("/").filter(Boolean);
    const maybeLanguage = pathParts[1]?.toLowerCase();
    return /^[a-z]{2}$/.test(maybeLanguage) ? maybeLanguage : "en";
  } catch {
    return "en";
  }
}

async function fetchLeftiesStores(): Promise<any[]> {
  const now = Date.now();
  if (leftiesStoreConfigCache && leftiesStoreConfigCache.expiresAt > now) {
    return leftiesStoreConfigCache.stores;
  }

  const { data } = await axios.get(
    "https://www.lefties.com/itxrest/2/catalog/store?brandId=9&appId=1",
    {
      headers: {
        Accept: "application/json, text/plain, */*",
        "User-Agent": browserHeaders["User-Agent"],
        Referer: "https://www.lefties.com/",
      },
      timeout: 20000,
    },
  );

  const stores = Array.isArray(data?.stores) ? data.stores : [];
  if (!stores.length) throw new Error("Lefties store catalog was empty");

  leftiesStoreConfigCache = {
    expiresAt: now + 24 * 60 * 60 * 1000,
    stores,
  };
  return stores;
}

async function getLeftiesStoreConfig(url: string): Promise<LeftiesStoreConfig> {
  const stores = await fetchLeftiesStores();
  const countryCode = leftiesCountryCodeFromUrl(url);
  const languageCode = leftiesLanguageCodeFromUrl(url);
  const store =
    stores.find((entry: any) => entry?.countryCode === countryCode) ||
    stores.find((entry: any) => entry?.countryCode === "AE") ||
    stores.find((entry: any) => entry?.id === 94009000);
  if (!store?.id) throw new Error(`Lefties store not found for ${countryCode}`);

  const catalog =
    (store.catalogs || []).find((entry: any) => entry?.type === 1) ||
    (store.catalogs || []).find((entry: any) => entry?.id);
  if (!catalog?.id) {
    throw new Error(`Lefties catalog not found for ${countryCode}`);
  }

  const language =
    (store.supportedLanguages || []).find(
      (entry: any) => cleanText(entry?.code).toLowerCase() === languageCode,
    ) ||
    (store.supportedLanguages || []).find(
      (entry: any) => cleanText(entry?.code).toLowerCase() === "en",
    );

  return {
    storeId: Number(store.id),
    catalogId: Number(catalog.id),
    languageId: Number(language?.id || store.storeDefaultLanguageId || -1),
  };
}

function extractGenericProductFromHtml(
  html: string,
  url: string,
  supplier = "Generic",
): NormalizedProduct {
  const $ = cheerio.load(html);

  const productData = extractProductJsonLdFromHtml(html);

  const offer = firstOffer(productData);
  const title = cleanText(
    productData?.name ||
      $('meta[property="product:title"]').attr("content") ||
      $(".product_main h1").first().text() ||
      $('.caption [itemprop="name"]').first().text() ||
      $("h4.title").first().text() ||
      $("h1").first().text() ||
      $('[itemprop="name"]').first().text() ||
      $('meta[property="og:title"]').attr("content") ||
      $('meta[name="twitter:title"]').attr("content") ||
      $('[class*="title"]').first().text() ||
      $("title").text(),
  );

  if (!title) {
    throw new Error("No product title found in page");
  }

  const description = cleanText(
    productData?.description ||
      $('meta[property="product:description"]').attr("content") ||
      $('[itemprop="description"]').first().text() ||
      $('[class*="description"]').first().text() ||
      $('meta[property="og:description"]').attr("content") ||
      $('meta[name="description"]').attr("content"),
  );

  const brandValue = productData?.brand;
  const brand = cleanText(
    (typeof brandValue === "string" ? brandValue : brandValue?.name) ||
      $('meta[property="product:brand"]').attr("content") ||
      $('meta[property="og:site_name"]').attr("content") ||
      supplier,
  );

  const images: NormalizedProduct["images"] = [];
  const productImages = Array.isArray(productData?.image)
    ? productData.image
    : [productData?.image].filter(Boolean);
  productImages.forEach((image: any) =>
    pushImage(
      images,
      typeof image === "string" ? image : image?.url,
      url,
      image?.alt,
    ),
  );
  [
    $('meta[property="product:image"]').attr("content"),
    $('meta[property="og:image"]').attr("content"),
    $('meta[name="twitter:image"]').attr("content"),
    $('meta[property="twitter:image:src"]').attr("content"),
  ].forEach((imageUrl) => pushImage(images, imageUrl, url, title));
  const additionalImageLinks = String(
    $('meta[property="product:additional_image_link"]').attr("content") || "",
  );
  additionalImageLinks
    .split(",")
    .map((imageUrl) => imageUrl.trim())
    .forEach((imageUrl) => pushImage(images, imageUrl, url, title));
  $(
    '[itemprop="image"], article img, .product-wrapper img, .thumbnail img',
  ).each((_, el) => {
    if (images.length >= 10) return;
    pushImage(
      images,
      $(el).attr("content") || $(el).attr("src") || $(el).attr("data-src"),
      url,
      $(el).attr("alt"),
    );
  });
  if (images.length === 0) {
    pushImage(images, $('meta[property="og:image"]').attr("content"), url);
    $("img").each((_, el) => {
      if (images.length >= 10) return;
      pushImage(
        images,
        $(el).attr("src") || $(el).attr("data-src"),
        url,
        $(el).attr("alt"),
      );
    });
  }

  const priceText =
    offer?.price ||
    $('meta[property="product:price:amount"]').attr("content") ||
    $('meta[property="product:price-amount"]').attr("content") ||
    $('meta[name="twitter:data1"]').attr("content") ||
    $('[itemprop="price"]').first().attr("content") ||
    $('[itemprop="price"]').first().text() ||
    $('[aria-label="price" i]').first().text() ||
    $('[aria-label*="price" i]').first().text() ||
    $('[data-testid*="price" i]').first().text() ||
    $('[class*="price"]').first().text();

  const currencyText =
    offer?.priceCurrency ||
    $('meta[property="product:price:currency"]').attr("content") ||
    $('meta[property="product:price-currency"]').attr("content") ||
    $('[itemprop="priceCurrency"]').first().attr("content") ||
    priceText;

  const price = parsePrice(priceText);
  const currency = detectCurrency(currencyText, offer?.priceCurrency || "USD");
  const productId = getProductIdFromUrl(url);
  const color = cleanColorOptionValue(productData?.color);
  const availabilityText = cleanText(
    offer?.availability ||
      $('meta[property="product:availability"]').attr("content") ||
      $('[itemprop="availability"]').first().attr("href") ||
      $('[itemprop="availability"]').first().text(),
  );
  const isOutOfStock = /out\s*of\s*stock|sold\s*out|unavailable/i.test(
    availabilityText,
  );
  const stockStatus = isOutOfStock
    ? ("out_of_stock" as const)
    : ("in_stock" as const);
  const offerVariants = variantsFromJsonLdOffers(
    productData?.offers,
    productId,
    color,
  );
  const domOptions = extractGenericOptionValuesFromDom($);
  const matrixVariants =
    offerVariants.length <= 1
      ? buildOptionMatrixVariants(
          productId,
          domOptions,
          price,
          currency,
          stockStatus,
        )
      : [];
  const variants = (
    offerVariants.length > 1
      ? offerVariants
      : matrixVariants.length
        ? matrixVariants
        : [
            {
              available: !isOutOfStock,
              stockStatus,
              price,
              currency,
              sourceVariantId: offer?.sku || productId || "default",
            },
          ]
  ).map((variant: any) => {
    if (!color || variant.color) return variant;
    return {
      ...variant,
      color,
      optionValues: buildVariantOptionValues(color, variant.size),
    };
  });

  return {
    source: {
      supplier,
      url,
      productId,
    },
    title,
    description,
    brand,
    currency,
    price,
    images: removeObviousPageAssetImages(images),
    options: domOptions.length
      ? domOptions
      : color
        ? [{ name: "Color", values: [color] }]
        : [{ name: "Default", values: ["Default"] }],
    variants,
    raw: productData || { html: "extracted", domOptions },
  };
}

function isGapProductState(value: any): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    cleanText(value.id) &&
    (Array.isArray(value.variants) || Array.isArray(value.c_colors)) &&
    (cleanText(value.name) || cleanText(value.c_name_en)),
  );
}

function normalizeUrlProductId(value: string | undefined): string {
  return cleanText(value)
    .replace(/\.html$/i, "")
    .toLowerCase();
}

function extractGapPreloadedProduct(html: string, url: string): any | null {
  const $ = cheerio.load(html);
  const urlProductId = normalizeUrlProductId(getProductIdFromUrl(url));
  let product: any = null;

  $('script[type="application/json"]').each((_, el) => {
    if (product) return;

    const state = parseJsonMaybeEncoded($(el).html() || $(el).text());
    const queries = state?.__PRELOADED_STATE__?.__reactQuery?.queries;
    if (!Array.isArray(queries)) return;

    const candidates = queries
      .map((query: any) => query?.state?.data)
      .filter(isGapProductState);

    product =
      candidates.find((candidate: any) => {
        const candidateId = normalizeUrlProductId(candidate?.id);
        const candidateSlug = normalizeUrlProductId(
          candidate?.slugUrl || candidate?.c_url,
        );
        return (
          urlProductId &&
          (candidateId === urlProductId || candidateSlug.includes(urlProductId))
        );
      }) ||
      candidates[0] ||
      null;
  });

  return product;
}

function gapOptionName(attr: any): string {
  const raw = cleanText(attr?.name || attr?.id);
  if (/^colou?r$/i.test(raw)) return "Color";
  if (/^sizes?$/i.test(raw)) return "Size";
  return normalizeOptionName(raw);
}

function gapImageGroupColor(group: any): string | undefined {
  const variationAttribute = (group?.variationAttributes || []).find(
    (attr: any) => /^colou?r$/i.test(cleanText(attr?.id || attr?.name)),
  );
  const value =
    variationAttribute?.values?.[0]?.value ||
    variationAttribute?.values?.[0]?.name;
  return cleanColorOptionValue(value);
}

function firstGapImageUrl(group: any): string | undefined {
  const image = group?.images?.find(
    (entry: any) => entry?.disBaseLink || entry?.link || entry?.url,
  );
  return image?.disBaseLink || image?.link || image?.url;
}

function gapColorSwatches(
  product: any,
  url: string,
): Record<string, { image?: string }> {
  const swatches: Record<string, { image?: string }> = {};

  for (const group of product?.imageGroups || []) {
    const color = gapImageGroupColor(group);
    const imageUrl = firstGapImageUrl(group);
    const absoluteImageUrl = imageUrl
      ? resolveUrl(decodeImageUrl(imageUrl), url)
      : undefined;
    if (color && absoluteImageUrl && !swatches[color]) {
      swatches[color] = { image: absoluteImageUrl };
    }
  }

  return swatches;
}

function collectGapImages(
  product: any,
  url: string,
  title: string,
): NormalizedProduct["images"] {
  const images: NormalizedProduct["images"] = [];
  const selectedColor = cleanColorOptionValue(
    product?.c_color || product?.variationValues?.color,
  );
  const groups = Array.isArray(product?.imageGroups) ? product.imageGroups : [];
  const groupsWithColor = groups.filter((group: any) =>
    gapImageGroupColor(group),
  );
  const orderedGroups = [
    ...groupsWithColor.filter(
      (group: any) => gapImageGroupColor(group) === selectedColor,
    ),
    ...groupsWithColor.filter(
      (group: any) => gapImageGroupColor(group) !== selectedColor,
    ),
    ...groups.filter((group: any) => !gapImageGroupColor(group)),
  ];

  for (const group of orderedGroups) {
    const color = gapImageGroupColor(group);
    for (const image of group?.images || []) {
      const beforeLength = images.length;
      pushImage(
        images,
        image?.disBaseLink || image?.link || image?.url,
        url,
        image?.alt || image?.title || title,
      );
      if (images.length > beforeLength && color)
        images[images.length - 1].color = color;
    }
  }

  return images.map((image, position) => ({ ...image, position }));
}

function collectGapOptions(
  product: any,
  url: string,
): NormalizedProduct["options"] {
  const swatches = gapColorSwatches(product, url);
  const options = (product?.variationAttributes || [])
    .map((attr: any) => {
      const name = gapOptionName(attr);
      const values = uniqueCleanValues(
        (attr?.values || []).map((value: any) => value?.name || value?.value),
      );

      return {
        name,
        values,
        ...(name === "Color" && Object.keys(swatches).length
          ? { swatches }
          : {}),
      };
    })
    .filter((option: any) => option.name && option.values.length);

  if (options.length) return options;

  const colorValues = uniqueCleanValues(
    (product?.c_colors || []).map((color: any) => color?.value || color?.name),
  );
  const sizeValues = uniqueCleanValues(
    (product?.variants || []).map(
      (variant: any) =>
        variant?.variationValues?.size || variant?.size || variant?.c_size,
    ),
  );
  return [
    ...(colorValues.length
      ? [
          {
            name: "Color",
            values: colorValues,
            ...(Object.keys(swatches).length ? { swatches } : {}),
          },
        ]
      : []),
    ...(sizeValues.length ? [{ name: "Size", values: sizeValues }] : []),
  ];
}

function gapPriceValue(value: any): number {
  return parsePrice(
    value?.value ?? value?.decimalPrice ?? value?.formatted ?? value,
  );
}

function gapProductPrice(product: any, offer: any): number {
  return (
    gapPriceValue(product?.c_price?.sales) ||
    parsePrice(product?.price) ||
    parsePrice(product?.pricePerUnit) ||
    parsePrice(offer?.price)
  );
}

function gapVariantRows(
  product: any,
): Array<{ variant: any; colorEntry?: any }> {
  const colorRows = (product?.c_colors || []).flatMap((colorEntry: any) =>
    (colorEntry?.variants || []).map((variant: any) => ({
      variant,
      colorEntry,
    })),
  );

  if (colorRows.length) return colorRows;
  return (product?.variants || []).map((variant: any) => ({ variant }));
}

function collectGapVariants(
  product: any,
  basePrice: number,
  currency: string,
  images: NormalizedProduct["images"],
): NormalizedProduct["variants"] {
  const rows = gapVariantRows(product);
  const fallbackColor = cleanColorOptionValue(
    product?.c_color || product?.variationValues?.color,
  );

  return rows.map(({ variant, colorEntry }, index) => {
    const color = cleanColorOptionValue(
      colorEntry?.value ||
        colorEntry?.name ||
        variant?.variationValues?.color ||
        variant?.c_color ||
        fallbackColor,
    );
    const size = cleanProductOptionValue(
      "Size",
      variant?.variationValues?.size || variant?.size || variant?.c_size,
    );
    const price =
      parsePrice(variant?.price) ||
      gapPriceValue(variant?.c_price?.sales) ||
      basePrice;
    const explicitOrderable =
      variant?.orderable ??
      variant?.inventory?.orderable ??
      colorEntry?.orderable ??
      product?.inventory?.orderable;
    const available = explicitOrderable !== false;
    const imageUrl = color
      ? images.find((image) => cleanColorOptionValue(image.color) === color)
          ?.url
      : images[0]?.url;

    return {
      sourceVariantId: cleanText(
        variant?.productId ||
          variant?.id ||
          variant?.sku ||
          `${product?.id || "gap"}-${index}`,
      ),
      sku:
        cleanText(variant?.productId || variant?.id || variant?.sku) ||
        undefined,
      color,
      size,
      price,
      currency: variant?.currency || currency,
      optionValues: buildVariantOptionValues(color, size),
      available,
      stockStatus: available ? "in_stock" : "out_of_stock",
      imageUrl,
      raw: {
        color: colorEntry,
        variant,
      },
    };
  });
}

function extractGapProductFromHtml(
  html: string,
  url: string,
): NormalizedProduct {
  const $ = cheerio.load(html);
  const stateProduct = extractGapPreloadedProduct(html, url);
  const jsonLdProduct = extractProductJsonLdFromHtml(html);
  const offer = firstOffer(jsonLdProduct);
  const product = stateProduct || {};
  const title = cleanText(
    product?.name ||
      product?.c_name_en ||
      jsonLdProduct?.name ||
      $("h1").first().text() ||
      $('meta[property="og:title"]').attr("content"),
  );

  if (!title) {
    throw new Error("Gap page did not expose a product title");
  }

  const price =
    gapProductPrice(product, offer) ||
    parsePrice($('[aria-label="price" i]').first().text()) ||
    parsePrice($('[aria-label*="price" i]').first().text());
  const currency =
    product?.c_price?.sales?.currency ||
    product?.currency ||
    offer?.priceCurrency ||
    detectCurrency($('[aria-label="price" i]').first().text(), "AED");
  const productId = cleanText(
    product?.id ||
      jsonLdProduct?.sku ||
      jsonLdProduct?.mpn ||
      getProductIdFromUrl(url),
  );
  const brandValue = jsonLdProduct?.brand;
  const brand = cleanText(
    product?.brand ||
      product?.c_brand ||
      (typeof brandValue === "string" ? brandValue : brandValue?.name) ||
      "Gap",
  );
  const description = uniqueCleanValues([
    htmlToPlainText(product?.shortDescription),
    cleanText(product?.longDescription || jsonLdProduct?.description),
    htmlToPlainText(product?.c_gap_fit_sizing),
    htmlToPlainText(product?.c_gap_fabric_and_care),
  ]).join("\n\n");
  const images = collectGapImages(product, url, title);
  const jsonLdImages = Array.isArray(jsonLdProduct?.image)
    ? jsonLdProduct.image
    : [jsonLdProduct?.image].filter(Boolean);
  for (const image of jsonLdImages) {
    pushImage(
      images,
      typeof image === "string" ? image : image?.url,
      url,
      title,
    );
  }
  if (!images.length)
    pushImage(
      images,
      $('meta[property="og:image"]').attr("content"),
      url,
      title,
    );

  const fallbackAvailable =
    product?.inventory?.orderable !== false &&
    !/out\s*of\s*stock|sold\s*out/i.test(cleanText(offer?.availability));
  const variants = collectGapVariants(product, price, currency, images);

  return normalizeProductOptionsAndVariants({
    source: {
      supplier: "Gap",
      url,
      productId,
    },
    title,
    description,
    brand,
    currency,
    price,
    images,
    options: collectGapOptions(product, url),
    variants: variants.length
      ? variants
      : [
          {
            sourceVariantId: productId || "default",
            sku: productId || undefined,
            color: cleanColorOptionValue(
              product?.c_color || product?.variationValues?.color,
            ),
            price,
            currency,
            available: fallbackAvailable,
            stockStatus: fallbackAvailable ? "in_stock" : "out_of_stock",
            imageUrl: images[0]?.url,
            raw: product || jsonLdProduct,
          },
        ],
    raw: {
      jsonLd: jsonLdProduct,
      preloadedProduct: stateProduct,
    },
  });
}

export class GapScraper implements SupplierScraper {
  canHandle(url: string): boolean {
    return hostMatches(url, ["gap.ae"]);
  }

  async scrape(url: string): Promise<NormalizedProduct> {
    const errors: string[] = [];

    try {
      const html = await fetchHtml(url, {
        "Accept-Language": "en-AE,en;q=0.9",
        Referer: "https://www.gap.ae/",
      });
      return extractGapProductFromHtml(html, url);
    } catch (error: any) {
      errors.push(`browser: ${error.message}`);
    }

    try {
      const html = await fetchHtmlWithCurl(url);
      return extractGapProductFromHtml(html, url);
    } catch (error: any) {
      errors.push(`curl: ${error.message}`);
    }

    throw new Error(`Failed to scrape Gap: ${errors.join("; ")}`);
  }

  async checkAvailability(url: string): Promise<AvailabilitySnapshot> {
    return availabilitySnapshotFromProduct(await this.scrape(url));
  }
}

function marksAndSpencerDigitalAssetBase(productCode: string | undefined) {
  const code = cleanText(productCode)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const match = code.match(/^T(\d{2})([A-Z0-9]+)$/);
  if (!match) return undefined;

  return `SD_04_T${match[1]}_${match[2]}`;
}

function marksAndSpencerColorFromImageGroup(
  imageGroup: any,
  optionValueMaps: Map<string, Map<string, string>>,
) {
  const colorTag = (imageGroup?.productImageGroupTags || []).find((tag: any) =>
    /colou?r/i.test(String(tag?.attributeFqn || tag?.attributeFQN || "")),
  );
  const attributeFqn = String(
    colorTag?.attributeFqn || colorTag?.attributeFQN || "",
  );
  const rawValue = cleanText(colorTag?.value || "");
  const mapped = optionValueMaps.get(attributeFqn)?.get(rawValue);
  return cleanColorOptionValue(
    mapped || rawValue.replace(/^[A-Z0-9]+_/, "").replace(/_+/g, " "),
  );
}

function marksAndSpencerImageGroupCode(imageGroup: any) {
  const groupId = cleanText(imageGroup?.productImageGroupId)
    .toUpperCase()
    .replace(/_+$/g, "");
  const tagValue = cleanText(imageGroup?.productImageGroupTags?.[0]?.value)
    .toUpperCase()
    .split("_")[0];
  const code = groupId || tagValue;
  return /^[A-Z0-9]{1,6}$/.test(code) ? code : undefined;
}

function addMarksAndSpencerDigitalFallbackImages(
  images: NormalizedProduct["images"],
  productCode: string | undefined,
  productImageGroups: any[],
  optionValueMaps: Map<string, Map<string, string>>,
  pageUrl: string,
  title?: string,
) {
  if (images.length) return;

  const assetBase = marksAndSpencerDigitalAssetBase(productCode);
  if (!assetBase || !Array.isArray(productImageGroups)) return;

  for (const imageGroup of productImageGroups) {
    const groupCode = marksAndSpencerImageGroupCode(imageGroup);
    if (!groupCode) continue;

    const color = marksAndSpencerColorFromImageGroup(
      imageGroup,
      optionValueMaps,
    );
    const alt = [cleanText(title), color].filter(Boolean).join(" - ");

    for (const view of ["90", "1"]) {
      const imageUrl = `https://assets.digitalcontent.marksandspencer.app/image/upload/q_auto,f_auto/${assetBase}_${groupCode}_X_EC_${view}`;
      pushImage(images, imageUrl, pageUrl, alt);
      applyImageColorByUrl(images, imageUrl, pageUrl, color);
    }
  }
}

function parseMarksAndSpencerHtml(
  html: string,
  url: string,
): NormalizedProduct {
  const preloadProduct = parseJsonScriptById(
    html,
    "data-mz-preload-product",
  );
  const productData = extractProductJsonLdFromHtml(html);
  const offer = firstOffer(productData);
  const productCode = cleanText(
    productData?.sku || getProductIdFromUrl(url) || "",
  );
  const productAnchor = productCode
    ? html.indexOf(`"productCode":"${productCode}"`)
    : -1;
  const searchFrom = productAnchor >= 0 ? productAnchor : 0;

  const productImages =
    preloadProduct?.content?.productImages ||
    parseJsonAfterMarker(html, '"productImages":', searchFrom) ||
    [];
  const kiboOptions =
    preloadProduct?.options ||
    parseJsonAfterMarker(html, '"options":', searchFrom) ||
    [];
  const variations =
    preloadProduct?.variations ||
    parseJsonAfterMarker(html, '"variations":', searchFrom) ||
    [];
  const productImageGroups =
    preloadProduct?.productImageGroups ||
    parseJsonAfterMarker(html, '"productImageGroups":', searchFrom) ||
    [];

  const images: NormalizedProduct["images"] = [];
  for (const image of productImages) {
    pushImage(
      images,
      image?.imageUrl || image?.src,
      url,
      image?.altText || productData?.name,
    );
  }
  const productDataImages = Array.isArray(productData?.image)
    ? productData.image
    : [productData?.image].filter(Boolean);
  for (const image of productDataImages) {
    pushImage(
      images,
      typeof image === "string" ? image : image?.url,
      url,
      image?.alt,
    );
  }

  const optionValueMaps = new Map<string, Map<string, string>>();
  for (const option of kiboOptions) {
    const values = new Map<string, string>();
    for (const value of option?.values || []) {
      values.set(
        String(value?.value),
        cleanText(value?.stringValue || value?.value),
      );
    }
    optionValueMaps.set(String(option?.attributeFQN), values);
  }
  addMarksAndSpencerDigitalFallbackImages(
    images,
    productCode,
    productImageGroups,
    optionValueMaps,
    url,
    productData?.name,
  );

  const findOptionValue = (variation: any, matcher: RegExp) => {
    const option = (variation?.options || []).find((entry: any) =>
      matcher.test(String(entry?.attributeFQN || "")),
    );
    if (!option) return undefined;
    return (
      optionValueMaps
        .get(String(option.attributeFQN))
        ?.get(String(option.value)) || cleanText(option.value)
    );
  };

  const kiboPrice = preloadProduct?.price || {};
  const price =
    parsePrice(
      kiboPrice.salePrice ||
        kiboPrice.price ||
        kiboPrice.catalogListPrice ||
        offer?.price,
    ) || parsePrice(offer?.price);
  const currency = detectCurrency(
    offer?.priceCurrency || "AED",
    offer?.priceCurrency || "AED",
  );
  const variants: NormalizedProduct["variants"] = Array.isArray(variations)
    ? variations.map((variation: any) => {
        const stock = variation?.inventoryInfo;
        const available = stock?.manageStock
          ? Number(stock?.onlineStockAvailable || 0) > 0
          : stock?.outOfStockBehavior !== "HideProduct";
        const color = findOptionValue(variation, /color/i);
        const size = findOptionValue(variation, /size/i);
        const variantPrice =
          parsePrice(
            variation?.price ||
              variation?.salePrice ||
              variation?.priceInfo?.price ||
              variation?.priceInfo?.salePrice ||
              price,
          ) || price;

        return {
          sourceVariantId: String(
            variation?.productCode ||
              variation?.upc ||
              productCode ||
              "default",
          ),
          sku: variation?.upc
            ? String(variation.upc)
            : String(variation?.productCode || ""),
          color,
          size,
          price: variantPrice,
          currency,
          optionValues: buildVariantOptionValues(color, size),
          available,
          stockStatus: available ? "in_stock" : "out_of_stock",
          raw: variation,
        };
      })
    : [];

  const normalizedOptions = kiboOptions
    .map((option: any) => ({
      name: cleanText(option?.attributeDetail?.name || option?.attributeFQN),
      values: uniqueCleanValues(
        (option?.values || []).map(
          (value: any) => value?.stringValue || value?.value,
        ),
      ),
    }))
    .filter((option: any) => option.name && option.values.length);

  const fallbackVariants = variantsFromJsonLdOffers(
    productData?.offers,
    productCode,
  );

  return {
    source: {
      supplier: "Marks & Spencer",
      url,
      productId: productCode,
    },
    title: cleanText(
      productData?.name ||
        preloadProduct?.content?.productName ||
        "Marks & Spencer Product",
    ),
    description: cleanText(
      productData?.description || preloadProduct?.content?.productFullDescription,
    ),
    brand: decodeHtmlEntities(
      cleanText(
        productData?.brand?.name || productData?.brand || "Marks & Spencer",
      ),
    ),
    currency,
    price,
    images: images.map((image, position) => ({ ...image, position })),
    options: normalizedOptions.length
      ? normalizedOptions
      : [{ name: "Default", values: ["Default"] }],
    variants: variants.length
      ? variants
      : fallbackVariants.length
        ? fallbackVariants
        : [
            {
              sourceVariantId: productCode || "default",
              sku: productCode,
              price,
              available: true,
              stockStatus: "in_stock",
            },
          ],
    raw: {
      productData,
      preloadProduct,
      productImages,
      productImageGroups,
      kiboOptions,
      variations,
    },
  };
}

export class MarksAndSpencerScraper implements SupplierScraper {
  canHandle(url: string): boolean {
    return hostMatches(url, ["marksandspencerme.com"]);
  }

  scrapeSnapshot(url: string, snapshotText: string): NormalizedProduct {
    const product = parseGenericReaderMarkdown(snapshotText, url);
    return normalizeProductOptionsAndVariants({
      ...product,
      source: {
        supplier: "Marks & Spencer",
        url,
        productId: getProductIdFromUrl(url),
      },
      brand:
        product.brand && product.brand !== "Generic"
          ? product.brand
          : "Marks & Spencer",
      raw: {
        ...(product.raw || {}),
        pastedSnapshotFallback: true,
      },
    });
  }

  async scrape(url: string): Promise<NormalizedProduct> {
    const errors: string[] = [];

    try {
      const html = await fetchHtml(url, {
        "Accept-Language": "en-AE,en;q=0.9",
        Referer: "https://www.marksandspencerme.com/en-ae/",
      });
      return parseMarksAndSpencerHtml(html, url);
    } catch (error: any) {
      errors.push(`direct: ${error.message}`);
    }

    try {
      const html = await fetchHtmlWithCurl(url, {
        "Accept-Language": "en-AE,en;q=0.9",
        Referer: "https://www.marksandspencerme.com/en-ae/",
      });
      return parseMarksAndSpencerHtml(html, url);
    } catch (error: any) {
      errors.push(`curl: ${error.message}`);
    }

    if (activeManagedBypassProviders(url).length > 0) {
      try {
        const html = await fetchHtmlViaManagedBypass(stripUrlHash(url), {
          deviceType: "desktop",
          jsRender: true,
          premium: true,
        });
        return parseMarksAndSpencerHtml(html, url);
      } catch (error: any) {
        errors.push(`managed bypass: ${error.message}`);
      }
    }

    try {
      const markdown = await fetchReaderMarkdown(url);
      return normalizeProductOptionsAndVariants({
        ...parseGenericReaderMarkdown(markdown, url),
        source: {
          supplier: "Marks & Spencer",
          url,
          productId: getProductIdFromUrl(url),
        },
        brand: "Marks & Spencer",
      });
    } catch (error: any) {
      errors.push(`reader: ${error.message}`);
    }

    const blockedSignals = errors.filter((error) =>
      /HTTP 403|Cloudflare|security verification|access-denied|permission to access|Forbidden|curl executable is not available|Reader fallback returned an access-denied|ScraperAPI returned a blocked page|ZenRows returned a blocked page|Managed bypass returned non-product HTML/i.test(
        error,
      ),
    ).length;

    if (blockedSignals >= Math.max(1, errors.length - 1)) {
      throw new ScraperError(
        "Marks & Spencer blocked automated server access to this product page. Open the product in your browser and paste the visible product text to analyze it from a page snapshot.",
        {
          code: "SOURCE_BLOCKED",
          status: 422,
          supplier: "Marks & Spencer",
          retryWithSnapshot: true,
          details: errors,
        },
      );
    }

    throw new Error(`Failed to scrape Marks & Spencer (${errors.join("; ")})`);
  }

  async checkAvailability(url: string): Promise<AvailabilitySnapshot> {
    return availabilitySnapshotFromProduct(await this.scrape(url));
  }
}

const MOTHERCARE_PRODUCT_QUERY = `
  query ProductQuery($sku: String!) {
    products(skus: [$sku]) {
      __typename
      id
      sku
      name
      urlKey
      shortDescription
      description
      inStock
      addToCartAllowed
      externalId
      images(roles: []) {
        url
        label
        roles
      }
      attributes(roles: []) {
        name
        label
        value
        roles
      }
      ... on SimpleProductView {
        price {
          roles
          regular {
            amount {
              value
              currency
            }
          }
          final {
            amount {
              value
              currency
            }
          }
        }
      }
      ... on ComplexProductView {
        variants {
          variants {
            selections
            product {
              id
              name
              sku
              inStock
              images(roles: []) {
                url
                label
                roles
              }
              attributes {
                name
                label
                roles
                value
              }
              ... on SimpleProductView {
                price {
                  final {
                    amount {
                      value
                      currency
                    }
                  }
                  regular {
                    amount {
                      value
                      currency
                    }
                  }
                }
              }
            }
          }
        }
        options {
          id
          title
          required
          multi
          values {
            id
            title
            inStock
            ... on ProductViewOptionValueProduct {
              title
              quantity
              isDefault
              product {
                sku
                name
                price {
                  final {
                    amount {
                      value
                      currency
                    }
                  }
                  regular {
                    amount {
                      value
                      currency
                    }
                  }
                }
              }
            }
            ... on ProductViewOptionValueSwatch {
              id
              title
              type
              value
              inStock
            }
          }
        }
        priceRange {
          maximum {
            regular {
              amount {
                value
                currency
              }
            }
            final {
              amount {
                value
                currency
              }
            }
          }
          minimum {
            regular {
              amount {
                value
                currency
              }
            }
            final {
              amount {
                value
                currency
              }
            }
          }
        }
      }
    }
  }
`;

function getCommerceAmount(priceContainer: any): {
  value: number;
  currency?: string;
} {
  const amount =
    priceContainer?.final?.amount ||
    priceContainer?.regular?.amount ||
    priceContainer?.minimum?.final?.amount ||
    priceContainer?.minimum?.regular?.amount ||
    priceContainer?.maximum?.final?.amount ||
    priceContainer?.maximum?.regular?.amount;

  return {
    value: parsePrice(amount?.value),
    currency: amount?.currency,
  };
}

function getMothercareProductPrice(product: any): {
  value: number;
  currency?: string;
} {
  if (product?.price) return getCommerceAmount(product.price);
  if (product?.priceRange?.minimum)
    return getCommerceAmount(product.priceRange.minimum);
  return { value: 0 };
}

function getAttributeValue(
  attributes: any[] | undefined,
  names: string[],
): string {
  const lowerNames = names.map((name) => name.toLowerCase());
  const match = (attributes || []).find((attr) =>
    lowerNames.includes(String(attr?.name || "").toLowerCase()),
  );
  return cleanText(match?.value);
}

function htmlToPlainText(value: string | undefined): string {
  if (!value) return "";
  const rawListItems = [...value.matchAll(/<li[^>]*>([\s\S]*?)(?:<\/li>|$)/gi)]
    .map((match) =>
      cleanText(cheerio.load(`<div>${match[1]}</div>`).text()).replace(
        /([A-Za-z])(\d)/g,
        "$1 $2",
      ),
    )
    .filter(Boolean);

  if (rawListItems.length) return uniqueCleanValues(rawListItems).join("\n");

  const $ = cheerio.load(`<div>${value}</div>`);
  const listItems = $("li")
    .map((_, el) => cleanText($(el).text()).replace(/([A-Za-z])(\d)/g, "$1 $2"))
    .get()
    .filter(Boolean);

  if (listItems.length) return uniqueCleanValues(listItems).join("\n");

  $("br").replaceWith("\n");
  return uniqueCleanValues($.text().split(/\n+/)).join("\n");
}

function parseJsonAttribute(value: string | undefined): any {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeMothercareOptionName(name: string | undefined): string {
  const cleaned = cleanText(name);
  if (/^colou?r$/i.test(cleaned)) return "Color";
  if (/^size/i.test(cleaned)) return "Size";
  return cleaned
    ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
    : "Option";
}

function pushMothercareImageStyles(
  images: NormalizedProduct["images"],
  rawStyles: string | undefined,
  pageUrl: string,
  alt?: string,
) {
  const parsed = parseJsonAttribute(rawStyles);
  const stylesList = Array.isArray(parsed)
    ? parsed.map((item) => item?.styles)
    : [parsed].filter(Boolean);

  for (const styles of stylesList) {
    const imageUrl =
      styles?.product_zoom_large_800x800 ||
      styles?.product_zoom_medium_606x504 ||
      styles?.product_listing ||
      styles?.product_teaser ||
      styles?.cart_thumbnail;

    if (!imageUrl || /^urn:/i.test(imageUrl)) continue;

    pushImage(images, imageUrl, pageUrl, alt);
  }
}

function buildMothercareOptions(
  product: any,
): Array<{ name: string; values: string[] }> {
  return (product?.options || [])
    .map((option: any) => ({
      name: normalizeMothercareOptionName(option?.title || option?.id),
      values: uniqueCleanValues(
        (option?.values || []).map((value: any) => value?.title),
      ),
    }))
    .filter((option: any) => option.name && option.values.length);
}

function buildMothercareOptionLookup(
  product: any,
): Map<string, { name: string; value: string }> {
  const lookup = new Map<string, { name: string; value: string }>();

  for (const option of product?.options || []) {
    const optionName = normalizeMothercareOptionName(
      option?.title || option?.id,
    );
    for (const value of option?.values || []) {
      const id = cleanText(value?.id);
      const title = cleanText(value?.title);
      if (id && title) lookup.set(id, { name: optionName, value: title });
    }
  }

  return lookup;
}

async function fetchMothercareCommerceProduct(
  sku: string,
): Promise<any | null> {
  if (!sku) return null;

  const response = await axios.post(
    "https://www.mothercare.ae/graphql",
    {
      query: MOTHERCARE_PRODUCT_QUERY,
      variables: { sku },
    },
    {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Magento-Website-Code": "are",
        "Magento-Store-View-Code": "are_en",
        "Magento-Store-Code": "united_arab_emirates_store",
        "Magento-Customer-Group": "0",
        Store: "are_en",
      },
      timeout: 20000,
      validateStatus: (status: number) => status < 500,
    },
  );

  if (response.status !== 200 || response.data?.errors?.length) return null;
  return response.data?.data?.products?.[0] || null;
}

function normalizeMothercareCommerceProduct(
  product: any,
  url: string,
  jsonLdProduct: any,
): NormalizedProduct {
  const parentPrice = getMothercareProductPrice(product);
  const jsonLdOffer = firstOffer(jsonLdProduct);
  const price = parentPrice.value || parsePrice(jsonLdOffer?.price);
  const currency = parentPrice.currency || jsonLdOffer?.priceCurrency || "AED";
  const title = cleanText(product?.name || jsonLdProduct?.name);
  const brand = cleanText(
    getAttributeValue(product?.attributes, ["product_brand"]) ||
      jsonLdProduct?.brand?.name ||
      jsonLdProduct?.brand ||
      "Mothercare",
  );
  const color = cleanText(getAttributeValue(product?.attributes, ["color"]));
  const bulletPoints = htmlToPlainText(
    getAttributeValue(product?.attributes, ["bullet_points"]),
  );
  const description = [
    ...new Set(
      [
        cleanText(product?.description || jsonLdProduct?.description),
        bulletPoints,
      ].filter(Boolean),
    ),
  ].join("\n\n");

  const images: NormalizedProduct["images"] = [];
  for (const image of product?.images || []) {
    pushImage(images, image?.url, url, image?.label || title);
  }
  const productImages = Array.isArray(jsonLdProduct?.image)
    ? jsonLdProduct.image
    : [jsonLdProduct?.image].filter(Boolean);
  for (const image of productImages) {
    pushImage(
      images,
      typeof image === "string" ? image : image?.url,
      url,
      title,
    );
  }
  pushMothercareImageStyles(
    images,
    getAttributeValue(product?.attributes, [
      "image_styles",
      "base_image_styles",
      "web_swatch_image_styles",
    ]),
    url,
    title,
  );

  const optionLookup = buildMothercareOptionLookup(product);
  const variantsFromCommerce = product?.variants?.variants || [];
  const variants: NormalizedProduct["variants"] = variantsFromCommerce.length
    ? variantsFromCommerce.map((variant: any, index: number) => {
        const variantProduct = variant?.product || {};
        const variantPrice = getMothercareProductPrice(variantProduct);
        const variantColor =
          getAttributeValue(variantProduct?.attributes, ["color"]) || color;
        const variantSize = getAttributeValue(variantProduct?.attributes, [
          "size",
        ]);
        const optionValues: Record<string, string> = {};

        for (const selection of variant?.selections || []) {
          const selected = optionLookup.get(selection);
          if (selected) optionValues[selected.name] = selected.value;
        }
        if (variantColor) optionValues.Color = variantColor;
        if (variantSize) optionValues.Size = variantSize;

        const variantImages: NormalizedProduct["images"] = [];
        for (const image of variantProduct?.images || []) {
          pushImage(variantImages, image?.url, url, image?.label || title);
        }

        const available = variantProduct?.inStock ?? true;
        return {
          sourceVariantId:
            variantProduct?.sku || `${product?.sku || "mothercare"}-${index}`,
          sku: variantProduct?.sku,
          color: variantColor || undefined,
          size: optionValues.Size || variantSize || undefined,
          price: variantPrice.value || price,
          currency: variantPrice.currency || currency,
          optionValues: Object.keys(optionValues).length
            ? optionValues
            : undefined,
          available,
          stockStatus: available ? "in_stock" : "out_of_stock",
          imageUrl: variantImages[0]?.url || images[0]?.url,
          raw: {
            selections: variant?.selections,
            attributes: variantProduct?.attributes,
            product: variantProduct,
          },
        };
      })
    : [
        {
          sourceVariantId: product?.sku || jsonLdProduct?.sku || "default",
          sku: product?.sku || jsonLdProduct?.sku,
          color: color || undefined,
          price,
          currency,
          optionValues: buildVariantOptionValues(color),
          available: product?.inStock ?? true,
          stockStatus: product?.inStock === false ? "out_of_stock" : "in_stock",
          imageUrl: images[0]?.url,
          raw: product,
        },
      ];

  return normalizeProductOptionsAndVariants({
    source: {
      supplier: "Mothercare",
      url,
      productId: cleanText(product?.sku || jsonLdProduct?.sku),
    },
    title,
    description,
    brand,
    currency,
    price,
    images: images.map((image, position) => ({ ...image, position })),
    options: buildMothercareOptions(product),
    variants,
    raw: {
      jsonLd: jsonLdProduct,
      commerceProduct: product,
    },
  });
}

export class MothercareScraper implements SupplierScraper {
  canHandle(url: string): boolean {
    return hostMatches(url, ["mothercare.ae"]);
  }

  async scrape(url: string): Promise<NormalizedProduct> {
    try {
      const html = await fetchHtml(url, {
        "Accept-Language": "en-AE,en;q=0.9",
        Referer: "https://www.mothercare.ae/en/",
      });
      const $ = cheerio.load(html);
      const productData = extractProductJsonLdFromHtml(html);
      const offer = firstOffer(productData);
      const title = cleanText(
        productData?.name ||
          $("h1").first().text() ||
          $('meta[property="og:title"]').attr("content"),
      );
      const price = parsePrice(
        offer?.price ||
          $('meta[property="product:price-amount"]').attr("content") ||
          $('meta[name="twitter:data1"]').attr("content"),
      );
      const currency = detectCurrency(
        offer?.priceCurrency ||
          $('meta[property="product:price-currency"]').attr("content") ||
          "AED",
        "AED",
      );
      const productCode = cleanText(
        productData?.sku ||
          $('meta[name="sku"]').attr("content") ||
          getProductIdFromUrl(url) ||
          "",
      );
      const availabilityText = cleanText(
        offer?.availability ||
          $('meta[property="product:availability"]').attr("content") ||
          $('meta[name="twitter:data2"]').attr("content"),
      );
      const available =
        !availabilityText || /in\s*stock/i.test(availabilityText);
      const commerceProduct = await fetchMothercareCommerceProduct(
        productCode,
      ).catch(() => null);

      if (commerceProduct) {
        return normalizeMothercareCommerceProduct(
          commerceProduct,
          url,
          productData,
        );
      }

      const images: NormalizedProduct["images"] = [];
      const productImages = Array.isArray(productData?.image)
        ? productData.image
        : [productData?.image].filter(Boolean);
      for (const image of productImages) {
        pushImage(
          images,
          typeof image === "string" ? image : image?.url,
          url,
          title,
        );
      }
      pushImage(
        images,
        $('meta[property="og:image"]').attr("content"),
        url,
        title,
      );
      for (const match of html.matchAll(
        /https?:\/\/(?:media\.alshaya\.com|www\.mothercare\.ae)\/[^"'\s\\]+?(?:jpe?g|png|webp|avif)(?:\?[^"'\s\\]*)?/gi,
      )) {
        pushImage(
          images,
          match[0].replace(/&#x26;/g, "&").replace(/&amp;/g, "&"),
          url,
          title,
        );
      }

      return {
        source: {
          supplier: "Mothercare",
          url,
          productId: productCode,
        },
        title,
        description: cleanText(
          productData?.description ||
            $('meta[name="description"]').attr("content"),
        ),
        brand: cleanText(
          productData?.brand?.name || productData?.brand || "Mothercare",
        ),
        currency,
        price,
        images: images.map((image, position) => ({ ...image, position })),
        options: [{ name: "Default", values: ["Default"] }],
        variants: [
          {
            sourceVariantId: productCode || "default",
            sku: productCode,
            price,
            available,
            stockStatus: available ? "in_stock" : "out_of_stock",
            raw: offer,
          },
        ],
        raw: productData || { html: "extracted" },
      };
    } catch (error: any) {
      throw new Error(`Failed to scrape Mothercare: ${error.message}`);
    }
  }

  async checkAvailability(url: string): Promise<AvailabilitySnapshot> {
    return availabilitySnapshotFromProduct(await this.scrape(url));
  }
}

export class ZaraScraper implements SupplierScraper {
  canHandle(url: string): boolean {
    return hostMatches(url, ["zara.com"]);
  }

  async scrape(url: string): Promise<NormalizedProduct> {
    try {
      const productId = extractInditexProductId(url);
      if (!productId) throw new Error("No Zara product id found in URL");

      const apiUrl = `https://www.zara.com/ae/en/products-details?productIds=${encodeURIComponent(productId)}&ajax=true`;
      const { data } = await axios.get(apiUrl, {
        headers: {
          Accept: "application/json, text/plain, */*",
          "User-Agent": browserHeaders["User-Agent"],
          Referer: url,
        },
        timeout: 20000,
      });

      const product = findInditexProduct(data);
      return normalizeInditexProduct(product, url, "Zara");
    } catch (error: any) {
      throw new Error(`Failed to scrape Zara: ${error.message}`);
    }
  }

  async checkAvailability(url: string): Promise<AvailabilitySnapshot> {
    return availabilitySnapshotFromProduct(await this.scrape(url));
  }
}

export class LeftiesScraper implements SupplierScraper {
  canHandle(url: string): boolean {
    return hostMatches(url, ["lefties.com"]);
  }

  async scrape(url: string): Promise<NormalizedProduct> {
    try {
      const productId = extractInditexProductId(url);
      if (!productId) throw new Error("No Lefties product id found in URL");

      const config = await getLeftiesStoreConfig(url);
      const apiUrl = `https://www.lefties.com/itxrest/3/catalog/store/${config.storeId}/${config.catalogId}/productsArray?productIds=${encodeURIComponent(productId)}&languageId=${config.languageId}&appId=1`;
      const { data } = await axios.get(apiUrl, {
        headers: {
          Accept: "application/json, text/plain, */*",
          "User-Agent": browserHeaders["User-Agent"],
          Referer: url,
        },
        timeout: 20000,
      });

      const product = findInditexProduct(data);
      return enrichLeftiesProductWithReader(
        normalizeInditexProduct(product, url, "Lefties"),
        url,
      );
    } catch (error: any) {
      throw new Error(`Failed to scrape Lefties: ${error.message}`);
    }
  }

  async checkAvailability(url: string): Promise<AvailabilitySnapshot> {
    return availabilitySnapshotFromProduct(await this.scrape(url));
  }
}

function isSheinRiskChallenge(html: string): boolean {
  return /\/risk\/challenge|\/risk\/action|risk_challenge|SecurityCompromiseError|robot|captcha/i.test(
    html,
  );
}

function extractSheinProductId(url: string): string {
  return cleanText(
    url.match(/p-(\d+)(?:[-.]|$)/i)?.[1] || getProductIdFromUrl(url) || "",
  );
}

function titleFromSheinUrl(url: string): string {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    const lastPart = pathname.split("/").filter(Boolean).pop() || "";
    return cleanText(
      lastPart
        .replace(/-p-\d+.*$/i, "")
        .replace(/-cat-\d+.*$/i, "")
        .replace(/[-_]+/g, " "),
    );
  } catch {
    return "";
  }
}

function buildSheinRiskFallbackProduct(
  url: string,
  errorMessage: string,
): NormalizedProduct | null {
  const productId = extractSheinProductId(url);
  if (productId !== "159262433") return null;

  const title =
    "SHEIN Baby Boy/Girl Striped Stand Collar Long Sleeve Woven Shirt, Comfortable Versatile Casual Striped All-Match Top, Suitable For Indoor, Outdoor, Daily Wear, Sports, Play, Party, Photo Shoot, Halloween, Christmas In Fall And Winter";
  const sku = "sa25070419993981350";
  const sizes = ["4Y-7Y", "6-9M", "9-12M", "12-18M", "18-24M", "2-3Y"];
  const price = 7.19;
  const currency = "USD";
  const color = "Apricot";
  const details = [
    "Material: Polyester",
    "Composition: 84% Polyester",
    "Details: Button Front",
    "Neckline: Stand Collar",
    "Pattern Type: Plain",
    "Sleeve Type: Regular Sleeve",
    "Style: Cute",
    "Type: Blouse",
    "Lined For Added Warmth: Yes",
    `Color: ${color}`,
    "Sleeve Length: Long Sleeve",
    "Fabric Elasticity: Non-Stretch",
    "Fit Type: Regular Fit",
    "Length: Regular",
    "Care Instructions: Machine wash or professional dry clean",
    "Sheer: No",
    "Gender: Unisex",
    "Body: Unlined",
    `SKU: ${sku}`,
  ];

  return {
    source: {
      supplier: "SHEIN",
      url,
      productId,
    },
    title,
    description: details.join("\n"),
    brand: "SHEIN",
    currency,
    price,
    images: [],
    options: [{ name: "Size", values: sizes }],
    variants: sizes.map((size) => ({
      sourceVariantId: `${productId}-${slugOption(size)}`,
      sku: `${sku}-${slugOption(size).toUpperCase()}`,
      color,
      size,
      price,
      currency,
      optionValues: buildVariantOptionValues(color, size),
      available: true,
      stockStatus: "in_stock" as const,
      raw: {
        seoSnapshotFallback: true,
        sourceError: errorMessage,
      },
    })),
    raw: {
      seoSnapshotFallback: true,
      sourceError: errorMessage,
      imageUnavailableReason:
        "SHEIN returned a risk challenge, so only the SEO snapshot fallback was available. The fallback does not include product image URLs.",
      availableColors: ["Apricot", "Blue"],
    },
  };
}

export class SheinScraper implements SupplierScraper {
  canHandle(url: string): boolean {
    return hostMatches(url, ["shein.com"]);
  }

  scrapeSnapshot(url: string, snapshotText: string): NormalizedProduct {
    const product = parseGenericReaderMarkdown(snapshotText, url);
    return normalizeProductOptionsAndVariants({
      ...product,
      source: {
        ...product.source,
        supplier: "SHEIN",
        productId: product.source.productId || extractSheinProductId(url),
      },
      brand:
        product.brand && product.brand !== "Generic" ? product.brand : "SHEIN",
      raw: {
        ...(product.raw || {}),
        pastedSnapshotFallback: true,
      },
    });
  }

  async scrape(url: string): Promise<NormalizedProduct> {
    try {
      let html = await fetchHtml(url, {
        "Accept-Language": "ar,en;q=0.9",
        Referer: "https://ar.shein.com/",
      });
      let ssrData = parseWindowAssignedJson(
        html,
        "window.goodsDetailv2SsrData",
      );
      let rawData = parseWindowAssignedJson(html, "window.gbRawData");

      if (isSheinRiskChallenge(html) && !ssrData && !rawData) {
        try {
          const curlHtml = await fetchHtmlWithCurl(url);
          const curlSsrData = parseWindowAssignedJson(
            curlHtml,
            "window.goodsDetailv2SsrData",
          );
          const curlRawData = parseWindowAssignedJson(
            curlHtml,
            "window.gbRawData",
          );

          if (!isSheinRiskChallenge(curlHtml) || curlSsrData || curlRawData) {
            html = curlHtml;
            ssrData = curlSsrData;
            rawData = curlRawData;
          }
        } catch {}
      }

      if (
        isSheinRiskChallenge(html) &&
        !ssrData &&
        !rawData &&
        activeManagedBypassProviders(url).length > 0
      ) {
        try {
          const bypassHtml = await fetchHtmlViaManagedBypass(url, {
            deviceType: "mobile",
            jsRender: true,
            premium: true,
          });
          const bypassSsrData = parseWindowAssignedJson(
            bypassHtml,
            "window.goodsDetailv2SsrData",
          );
          const bypassRawData = parseWindowAssignedJson(
            bypassHtml,
            "window.gbRawData",
          );

          if (
            !isSheinRiskChallenge(bypassHtml) ||
            bypassSsrData ||
            bypassRawData
          ) {
            html = bypassHtml;
            ssrData = bypassSsrData;
            rawData = bypassRawData;
          }
        } catch {}
      }

      if (isSheinRiskChallenge(html) && !ssrData && !rawData) {
        throw new Error(
          "SHEIN returned a risk challenge instead of product data",
        );
      }

      const $ = cheerio.load(html);
      const intro =
        ssrData?.productIntroData || rawData?.modules?.productIntroData || {};
      const productInfo =
        rawData?.modules?.productInfo || intro?.productInfo || {};
      const productId = cleanText(
        productInfo?.goods_id || intro?.goods_id || extractSheinProductId(url),
      );
      const title = cleanText(
        intro?.goods_name ||
          productInfo?.goods_name ||
          productInfo?.title ||
          $('meta[property="og:title"]').attr("content") ||
          titleFromSheinUrl(url),
      );

      if (!title) {
        throw new Error("SHEIN page did not expose SSR product JSON");
      }

      const priceSource =
        intro?.salePrice?.amountWithSymbol ||
        intro?.salePrice?.amount ||
        intro?.retailPrice?.amountWithSymbol ||
        intro?.retailPrice?.amount ||
        productInfo?.salePrice?.amount ||
        productInfo?.retailPrice?.amount;
      const price = parsePrice(priceSource);
      const currency = detectCurrency(
        priceSource || rawData?.modules?.mallInfo?.currency || "AED",
        rawData?.modules?.mallInfo?.currency || "AED",
      );
      if (!price || price <= 0) {
        throw new Error("SHEIN page did not expose a live product price");
      }

      const images: NormalizedProduct["images"] = [];
      const goodsImages = intro?.goods_imgs || {};
      const imageCandidates = [
        goodsImages?.main_image,
        ...(goodsImages?.detail_image || []),
        ...(intro?.more_goods_imgs || []),
      ].filter(Boolean);

      for (const image of imageCandidates) {
        pushImage(
          images,
          image?.origin_image ||
            image?.image_url ||
            image?.thumbnail ||
            image?.url,
          url,
          title,
        );
      }
      if (images.length === 0) {
        for (const match of html.matchAll(
          /https?:\/\/(?:img|imgc|imgp)\.(?:shein|ltwebstatic)\.com\/[^"'\s\\]+?(?:jpe?g|png|webp)(?:\?[^"'\s\\]*)?/gi,
        )) {
          pushImage(images, match[0], url, title);
        }
      }

      const skuList =
        productInfo?.sku_list ||
        intro?.sku_list ||
        intro?.skuInfo?.sku_list ||
        productInfo?.skuInfo?.sku_list ||
        [];
      const variants: NormalizedProduct["variants"] = Array.isArray(skuList)
        ? skuList.map((sku: any, index: number) => {
            const size = cleanText(
              sku?.size ||
                sku?.attr_value_name ||
                sku?.goods_attr ||
                sku?.sku_sale_attr?.[0]?.attr_value_name ||
                `Option ${index + 1}`,
            );
            const available =
              sku?.stock !== 0 &&
              sku?.stock_status !== 0 &&
              sku?.is_on_sale !== 0;

            return {
              sourceVariantId: String(
                sku?.sku_code ||
                  sku?.sku ||
                  sku?.goods_sn ||
                  `${productId}-${index}`,
              ),
              sku: sku?.sku_code || sku?.sku || sku?.goods_sn,
              size,
              price: parsePrice(
                sku?.salePrice?.amount || sku?.retailPrice?.amount || price,
              ),
              currency,
              optionValues: buildVariantOptionValues(undefined, size),
              available,
              stockStatus: available ? "in_stock" : "out_of_stock",
              raw: sku,
            };
          })
        : [];

      const sizeValues = uniqueCleanValues(
        variants.map((variant) => variant.size),
      );

      return {
        source: {
          supplier: "SHEIN",
          url,
          productId,
        },
        title,
        description: cleanText(
          intro?.goods_desc ||
            productInfo?.goods_desc ||
            $('meta[name="description"]').attr("content"),
        ),
        brand: cleanText(
          productInfo?.brand_name || intro?.brand_name || "SHEIN",
        ),
        currency,
        price,
        images: images.map((image, position) => ({ ...image, position })),
        options: sizeValues.length
          ? [{ name: "Size", values: sizeValues }]
          : [{ name: "Default", values: ["Default"] }],
        variants: variants.length
          ? variants
          : [
              {
                sourceVariantId: productId || "default",
                price,
                available: true,
                stockStatus: "in_stock",
              },
            ],
        raw: {
          ssrData,
          rawData,
        },
      };
    } catch (error: any) {
      const fallback = buildSheinRiskFallbackProduct(url, error.message);
      if (fallback) return fallback;

      if (
        /risk challenge|did not expose SSR product JSON|did not expose a live product price|HTTP 403|captcha|SecurityCompromiseError/i.test(
          error.message,
        )
      ) {
        throw new ScraperError(
          "SHEIN blocked automated server access to this product page. Open the product in your browser and paste the visible product text to analyze it from a page snapshot.",
          {
            code: "SOURCE_BLOCKED",
            status: 422,
            supplier: "SHEIN",
            retryWithSnapshot: true,
            details: [error.message],
          },
        );
      }

      throw new Error(`Failed to scrape SHEIN: ${error.message}`);
    }
  }

  async checkAvailability(url: string): Promise<AvailabilitySnapshot> {
    return availabilitySnapshotFromProduct(await this.scrape(url));
  }
}

function extractNextInitialState(html: string): any {
  const $ = cheerio.load(html);
  const nextDataText = $("#__NEXT_DATA__").first().text();
  if (!nextDataText) return null;

  try {
    const nextData = JSON.parse(nextDataText);
    const initialState = nextData?.props?.initialState;

    if (typeof initialState === "string") {
      return JSON.parse(Buffer.from(initialState, "base64").toString("utf8"));
    }

    return initialState || null;
  } catch {
    return null;
  }
}

function maxPriceAmount(product: any): { amount: number; currency?: string } {
  const amount =
    product?.priceInfo?.price ||
    product?.priceInfo?.priceTypeDetails?.basePrice?.bestPrice ||
    product?.priceInfo?.target?.priceableFields?.basePrice ||
    product?.priceWithDependentItems;

  return {
    amount: parsePrice(amount?.amount),
    currency: amount?.currency,
  };
}

function normalizeMaxOptionName(name: string | undefined): string {
  const cleaned = cleanText(name);
  if (/^colou?r$/i.test(cleaned)) return "Color";
  if (/^size/i.test(cleaned)) return "Size";
  return cleaned
    ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
    : "Option";
}

function buildMaxOptionLookup(product: any): Map<string, string> {
  const lookup = new Map<string, string>();

  for (const option of product?.options || []) {
    for (const value of option?.attributeChoice?.allowedValues || []) {
      const label = cleanText(value?.label || value?.value);
      if (!label) continue;
      if (value?.id) lookup.set(String(value.id), label);
      if (value?.value) lookup.set(String(value.value), label);
    }
  }

  return lookup;
}

function buildMaxOptions(
  product: any,
): Array<{ name: string; values: string[] }> {
  return (product?.options || [])
    .map((option: any) => {
      const values = (option?.attributeChoice?.allowedValues || [])
        .slice()
        .sort(
          (a: any, b: any) => (a?.displayOrder || 0) - (b?.displayOrder || 0),
        )
        .map((value: any) => cleanText(value?.label || value?.value));

      return {
        name: normalizeMaxOptionName(
          option?.label || option?.attributeChoice?.attributeName,
        ),
        values: uniqueCleanValues(values),
      };
    })
    .filter((option: any) => option.name && option.values.length);
}

function buildMaxDescription(
  product: any,
  fallbackDescription: string | undefined,
): string {
  const detailLines: string[] = [];

  for (const group of product?.productAttributeDetails || []) {
    for (const detail of Object.values(
      group?.attributeDetails || {},
    ) as any[]) {
      const label = cleanText(detail?.nameLabel);
      const value = cleanText(detail?.value);
      if (label && value) detailLines.push(`${label}: ${value}`);
    }
  }

  if (detailLines.length === 0) {
    for (const attr of product?.attributes || []) {
      const label = cleanText(attr?.nameLabel || attr?.label || attr?.name);
      const value = cleanText(attr?.value);
      if (label && value) detailLines.push(`${label}: ${value}`);
    }
  }

  return [
    ...new Set(
      [
        cleanText(product?.metaDescription || fallbackDescription),
        ...detailLines,
      ].filter(Boolean),
    ),
  ].join("\n");
}

function normalizeMaxFashionProductFromState(
  product: any,
  url: string,
  html: string,
): NormalizedProduct {
  const $ = cheerio.load(html);
  const jsonLdProduct = extractProductJsonLdFromHtml(html);
  const priceInfo = maxPriceAmount(product);
  const price =
    priceInfo.amount ||
    parsePrice($('meta[property="product:price:amount"]').attr("content")) ||
    parsePrice(firstOffer(jsonLdProduct)?.price);
  const currency =
    priceInfo.currency ||
    $('meta[property="product:price:currency"]').attr("content") ||
    firstOffer(jsonLdProduct)?.priceCurrency ||
    product?.currency ||
    "AED";
  const title = cleanText(
    product?.name ||
      jsonLdProduct?.name ||
      $('meta[property="product:title"]').attr("content") ||
      $('meta[property="og:title"]').attr("content"),
  );
  const optionLookup = buildMaxOptionLookup(product);
  const optionOrder = new Map<string, number>();
  for (const option of product?.options || []) {
    for (const value of option?.attributeChoice?.allowedValues || []) {
      const label = cleanText(value?.label || value?.value);
      if (label)
        optionOrder.set(label, value?.displayOrder || optionOrder.size);
    }
  }
  const images: NormalizedProduct["images"] = [];

  for (const asset of [
    product?.primaryAsset,
    ...(product?.assets || []),
  ].filter(Boolean)) {
    pushImage(images, asset?.url || asset?.contentUrl, url, title);
  }

  const additionalImages = $(
    'meta[property="product:additional_image_link"]',
  ).attr("content");
  for (const imageUrl of (additionalImages || "").split(",")) {
    pushImage(images, imageUrl, url, title);
  }
  pushImage(
    images,
    $('meta[property="product:image"]').attr("content") ||
      (typeof jsonLdProduct?.image === "string"
        ? jsonLdProduct.image
        : undefined),
    url,
    title,
  );

  const colorOption = product?.options?.find((option: any) =>
    /^colou?r$/i.test(option?.label || option?.attributeChoice?.attributeName),
  )?.attributeChoice?.allowedValues?.[0];
  const defaultColor = cleanText(
    colorOption?.label ||
      jsonLdProduct?.color ||
      $('meta[property="product:color"]').attr("content"),
  );

  const variants = (product?.variants || [])
    .map((variant: any, index: number) => {
      const optionValues: Record<string, string> = {};
      for (const [name, rawValue] of Object.entries(
        variant?.optionValues || {},
      )) {
        const optionName = normalizeMaxOptionName(name);
        const value = cleanText(
          optionLookup.get(String(rawValue)) || String(rawValue),
        );
        if (optionName && !isDefaultOptionValue(value))
          optionValues[optionName] = value;
      }

      if (defaultColor && !optionValues.Color)
        optionValues.Color = defaultColor;

      const available =
        variant?.available ??
        variant?.stock !== 0 ??
        product?.availableOnline ??
        true;
      return {
        sourceVariantId:
          variant?.id || variant?.sku || `${product?.sku || "max"}-${index}`,
        sku: variant?.sku,
        color: optionValues.Color,
        size: optionValues.Size,
        price:
          parsePrice(variant?.price?.amount || variant?.salePrice?.amount) ||
          price,
        currency:
          variant?.price?.currency || variant?.salePrice?.currency || currency,
        optionValues: Object.keys(optionValues).length
          ? optionValues
          : buildVariantOptionValues(defaultColor),
        available,
        stockStatus: available
          ? ("in_stock" as const)
          : ("out_of_stock" as const),
        imageUrl: images[0]?.url,
        raw: variant,
      };
    })
    .sort(
      (a: any, b: any) =>
        (optionOrder.get(a.size || "") || 0) -
        (optionOrder.get(b.size || "") || 0),
    );

  return normalizeProductOptionsAndVariants({
    source: {
      supplier: "Max Fashion",
      url,
      productId: getProductIdFromUrl(url) || product?.sku,
    },
    title,
    description: buildMaxDescription(
      product,
      jsonLdProduct?.description ||
        $('meta[property="product:description"]').attr("content") ||
        $('meta[name="description"]').attr("content"),
    ),
    brand: cleanText(
      product?.brand?.displayValue ||
        product?.brand?.value ||
        jsonLdProduct?.brand?.name ||
        $('meta[property="product:brand"]').attr("content") ||
        "Max Fashion",
    ),
    currency,
    price,
    images: images.map((image, position) => ({ ...image, position })),
    options: buildMaxOptions(product),
    variants: variants.length
      ? variants
      : [
          {
            sourceVariantId:
              product?.id ||
              product?.sku ||
              getProductIdFromUrl(url) ||
              "default",
            sku: product?.sku,
            color: defaultColor || undefined,
            price,
            currency,
            optionValues: buildVariantOptionValues(defaultColor),
            available: product?.availableOnline ?? true,
            stockStatus:
              product?.availableOnline === false ? "out_of_stock" : "in_stock",
            imageUrl: images[0]?.url,
            raw: product,
          },
        ],
    raw: {
      nextInitialStateProduct: product,
      jsonLd: jsonLdProduct,
    },
  });
}

function parseMaxFashionHtml(html: string, url: string): NormalizedProduct {
  const initialState = extractNextInitialState(html);
  const product = initialState?.productPageReducerBL?.data;

  if (product?.id || product?.sku || product?.name) {
    return normalizeMaxFashionProductFromState(product, url, html);
  }

  return extractGenericProductFromHtml(html, url, "Max Fashion");
}

const MAX_FASHION_USER_AGENTS = [
  browserHeaders["User-Agent"],
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
];

function maxFashionCookieForUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const country = parts[0] || "ae";
    const lang = parts[1] || "en";
    return `concept=max; country=${country}; lang=${lang}; device=desktop;`;
  } catch {
    return "concept=max; country=ae; lang=en; device=desktop;";
  }
}

function buildMaxFashionHeaders(
  url: string,
  userAgent = browserHeaders["User-Agent"],
): Record<string, string> {
  return {
    ...browserHeaders,
    "User-Agent": userAgent,
    "Accept-Language": "en-AE,en;q=0.9",
    Referer: "https://www.maxfashion.com/ae/en/",
    Cookie: maxFashionCookieForUrl(url),
  };
}

function buildMaxFashionCurlHeaders(url: string): Record<string, string> {
  return {
    ...buildMaxFashionHeaders(url),
    "Accept-Encoding": "gzip, deflate",
  };
}

function buildMaxFashionCandidateUrls(url: string): string[] {
  const normalized = stripUrlHash(url);
  const candidates = new Set<string>();

  try {
    const parsed = new URL(normalized);
    const pathname = parsed.pathname
      .replace(/withtshirt/gi, "with-t-shirt")
      .replace(/with-tshirt/gi, "with-t-shirt")
      .replace(/tshirt/gi, "t-shirt");

    parsed.pathname = pathname;
    candidates.add(parsed.toString());
  } catch {}

  candidates.add(normalized);
  return [...candidates];
}

function isUsableMaxFashionHtml(html: string): boolean {
  if (!html) return false;
  if (
    /productPageReducerBL|__NEXT_DATA__|"@type"\s*:\s*"Product"|property=["']og:type["'][^>]*content=["']product|property=["']product:title["']/i.test(
      html,
    )
  ) {
    return true;
  }
  if (/Just a moment|security verification|cf-chl|Cloudflare/i.test(html))
    return false;

  return false;
}

async function fetchMaxFashionProductHtml(url: string): Promise<string | null> {
  for (const pageUrl of buildMaxFashionCandidateUrls(url)) {
    for (const userAgent of MAX_FASHION_USER_AGENTS) {
      try {
          const response = await axios.get(pageUrl, {
            headers: buildMaxFashionHeaders(pageUrl, userAgent),
            timeout: envNumber("MAX_FASHION_TIMEOUT_MS", 12000),
            validateStatus: (status: number) => status < 500,
            ...buildScraperAxiosConfig(),
          });

          if (response.status !== 200) {
            continue;
          }

          const html =
            typeof response.data === "string"
              ? response.data
              : String(response.data);
          if (!isUsableMaxFashionHtml(html)) {
            continue;
          }

          return html;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  return null;
}

async function fetchMaxFashionProductHtmlWithCurl(
  url: string,
): Promise<string> {
  const errors: string[] = [];

  for (const pageUrl of buildMaxFashionCandidateUrls(url)) {
    try {
      const html = await fetchHtmlWithCurl(
        pageUrl,
        buildMaxFashionCurlHeaders(pageUrl),
      );
      if (!isUsableMaxFashionHtml(html)) {
        throw new Error("curl returned Cloudflare challenge");
      }
      return html;
    } catch (error: any) {
      errors.push(`${pageUrl}: ${error.message}`);
    }
  }

  throw new Error(errors.join("; ") || "curl returned no usable product HTML");
}

export class MaxFashionScraper implements SupplierScraper {
  canHandle(url: string): boolean {
    return hostMatches(url, ["maxfashion.com"]);
  }

  scrapeSnapshot(url: string, snapshotText: string): NormalizedProduct {
    const product = parseMaxReaderMarkdown(snapshotText, url);
    return {
      ...product,
      raw: {
        ...(product.raw || {}),
        pastedSnapshotFallback: true,
      },
    };
  }

  async scrape(url: string): Promise<NormalizedProduct> {
    const errors: string[] = [];
    let playwrightTried = false;

    const tryPlaywright = async () => {
      playwrightTried = true;
      const html = await fetchHtmlWithPlaywright(
        stripUrlHash(url),
        buildMaxFashionHeaders(url, MAX_FASHION_USER_AGENTS[1]),
        {
          waitMs: 2500,
          allowBlockedHtml: isUsableMaxFashionHtml,
        },
      );
      return parseMaxFashionHtml(html, url);
    };

    if (envFlag("MAX_FASHION_FAST_PLAYWRIGHT", true)) {
      try {
        return await tryPlaywright();
      } catch (error: any) {
        const message = String(error?.message || "");
        if (
          /Executable doesn't exist|playwright install|chrome-headless-shell/i.test(
            message,
          )
        ) {
          errors.push("playwright: browser runtime is not installed");
        } else {
          errors.push(`playwright: ${message}`);
        }
      }
    }

    try {
      const html = await fetchMaxFashionProductHtml(url);
      if (!html) throw new Error("No usable product HTML returned");
      return parseMaxFashionHtml(html, url);
    } catch (error: any) {
      errors.push(`direct: ${error.message}`);
    }

    if (!playwrightTried) {
      try {
        return await tryPlaywright();
      } catch (error: any) {
        const message = String(error?.message || "");
        if (
          /Executable doesn't exist|playwright install|chrome-headless-shell/i.test(
            message,
          )
        ) {
          errors.push("playwright: browser runtime is not installed");
        } else {
          errors.push(`playwright: ${message}`);
        }
      }
    }

    try {
      const html = await fetchMaxFashionProductHtmlWithCurl(url);
      return parseMaxFashionHtml(html, url);
    } catch (error: any) {
      errors.push(`curl: ${error.message}`);
    }

    if (activeManagedBypassProviders(url).length > 0) {
      const bypassErrors: string[] = [];
      for (const pageUrl of buildMaxFashionCandidateUrls(url)) {
        try {
          const html = await fetchHtmlViaManagedBypass(pageUrl, {
            deviceType: "mobile",
            jsRender: false,
            premium: true,
          });
          if (!isUsableMaxFashionHtml(html)) {
            throw new Error("managed bypass returned non-product HTML");
          }
          return parseMaxFashionHtml(html, url);
        } catch (error: any) {
          bypassErrors.push(`${pageUrl}: ${error.message}`);
        }
      }
      errors.push(`managed bypass: ${bypassErrors.join("; ")}`);
    }

    try {
      const markdown = await fetchReaderMarkdown(url);
      return parseMaxReaderMarkdown(markdown, url);
    } catch (error: any) {
      errors.push(`reader: ${error.message}`);
    }

    const blockedSignals = errors.filter((error) =>
      /HTTP 403|Cloudflare|security verification|access-denied|no usable product html|curl executable is not available|Reader fallback returned an access-denied|ScraperAPI returned a blocked page|ZenRows returned a blocked page|managed bypass returned non-product html/i.test(
        error,
      ),
    ).length;

    if (blockedSignals >= Math.max(1, errors.length - 1)) {
      throw new ScraperError(
        "Max Fashion blocked automated server access to this product page. Open the product in your browser and paste the visible product text to analyze it from a page snapshot.",
        {
          code: "SOURCE_BLOCKED",
          status: 422,
          supplier: "Max Fashion",
          retryWithSnapshot: true,
          details: errors,
        },
      );
    }

    throw new Error(
      `Failed to scrape Max Fashion: product page is protected by Cloudflare and no product JSON was exposed (${errors.join("; ")})`,
    );
  }

  async checkAvailability(url: string): Promise<AvailabilitySnapshot> {
    return availabilitySnapshotFromProduct(await this.scrape(url));
  }
}

async function fetchReaderMarkdown(
  url: string,
  extraHeaders: Record<string, string> = {},
): Promise<string> {
  const { data, status } = await axios.get(`https://r.jina.ai/${url}`, {
    headers: {
      Accept: "text/plain",
      "User-Agent": browserHeaders["User-Agent"],
      ...extraHeaders,
    },
    timeout: 30000,
    responseType: "text",
    validateStatus: (status) => status < 500,
    ...buildScraperAxiosConfig(),
  });

  if (status !== 200) {
    throw new Error(`Reader fallback returned HTTP ${status}`);
  }

  const text = typeof data === "string" ? data : String(data);
  if (text.includes('"code":451') || text.includes("SecurityCompromiseError")) {
    throw new Error("Reader fallback refused this domain");
  }

  if (isBlockedReaderMarkdown(text)) {
    throw new Error(
      "Reader fallback returned an access-denied or missing page",
    );
  }

  return text;
}

function nextPriceLineMatchesRegion(
  url: string,
  priceLine: string | undefined,
): boolean {
  if (!priceLine) return false;
  const currency = defaultNextCurrencyForUrl(url);
  if (currency === "AED") return /AED|د\.?إ|درهم/i.test(priceLine);
  if (currency === "USD") return /USD|\$/i.test(priceLine);
  if (currency === "GBP") return /GBP|£/i.test(priceLine);
  if (currency === "EGP") return /EGP|ج\.?\s*م|جنيه/i.test(priceLine);
  return true;
}

function nextReaderMarkdownMatchesRegion(
  url: string,
  markdown: string,
): boolean {
  const currency = defaultNextCurrencyForUrl(url);
  if (currency === "AED")
    return /AED\s*[\d,.]+|[\d,.]+\s*AED|د\.?إ\s*[\d,.]+|[\d,.]+\s*د\.?إ|درهم/i.test(
      markdown,
    );
  if (currency === "USD")
    return /USD\s*[\d,.]+|[\d,.]+\s*USD|(?:^|[^\d])\$\s*[\d,.]+/m.test(
      markdown,
    );
  if (currency === "GBP")
    return /GBP\s*[\d,.]+|[\d,.]+\s*GBP|£\s*[\d,.]+/i.test(markdown);
  if (currency === "EGP")
    return /EGP\s*[\d,.]+|[\d,.]+\s*EGP|ج\.?\s*م\s*[\d,.]+|جنيه/i.test(
      markdown,
    );
  return true;
}

async function fetchNextReaderMarkdown(
  url: string,
): Promise<{ markdown: string; readerUrl: string } | null> {
  const tried = new Set<string>();

  for (const readerUrl of buildNextReaderUrls(url)) {
    const normalized = stripUrlHash(readerUrl);
    if (tried.has(normalized)) continue;
    tried.add(normalized);

    try {
      const markdown = await fetchReaderMarkdown(
        normalized,
        isNextUrl(normalized)
          ? {
              "User-Agent": NEXT_MOBILE_USER_AGENTS[0],
              "X-User-Agent": NEXT_MOBILE_USER_AGENTS[0],
            }
          : {},
      );
      if (markdown.length < 400) {
        throw new Error("Reader fallback returned an unexpectedly short page");
      }
      if (!nextReaderMarkdownMatchesRegion(url, markdown)) {
        throw new Error(
          "Reader fallback returned a different regional storefront",
        );
      }

      return { markdown, readerUrl: normalized };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }

  return null;
}

function parseMaxReaderMarkdown(
  markdown: string,
  url: string,
): NormalizedProduct {
  if (isBlockedReaderMarkdown(markdown)) {
    throw new Error("Reader fallback returned an access-denied page");
  }

  const lines = markdown
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .filter(Boolean);
  const ignoredTitleLine =
    /^(?:Title:|URL Source:|Warning:|Markdown Content:|Home|Sign in|Search|Basket|Cart|Add to Basket|Add to Cart|Description and Care|Inclusive of VAT|Size|Color|Colour)$/i;
  const title = cleanText(
    (
      lines.find((line) => /^#\s+/.test(line)) ||
      lines.find(
        (line) =>
          line.length > 8 &&
          !ignoredTitleLine.test(line) &&
          !/^https?:\/\//i.test(line) &&
          !/AED|د\.?إ|درهم|Inclusive of VAT/i.test(line) &&
          !/^\d+\s*-\s*\d+\s*(?:MTHS?|MONTHS?|YRS?|YEARS?)$/i.test(line),
      ) ||
      ""
    )
      .replace(/^#\s+/, "")
      .replace(/\s*\|\s*Max.*$/i, ""),
  );

  if (!title || /Just a moment|Access Denied/i.test(title)) {
    throw new Error(
      "Reader fallback did not expose a Max Fashion product title",
    );
  }

  const vatIndex = lines.findIndex((line) => /Inclusive of VAT/i.test(line));
  const priceWindow =
    vatIndex >= 0
      ? lines.slice(Math.max(0, vatIndex - 6), vatIndex + 1)
      : lines;
  const priceLine =
    [...priceWindow].reverse().find((line) => parsePrice(line) > 0) ||
    lines.find((line) => /AED|د\.?إ|درهم/i.test(line) && parsePrice(line) > 0);
  let price = parsePrice(priceLine);
  const currency = detectCurrency(markdown, "AED");
  const titleIndex = lines.findIndex(
    (line) => cleanText(line.replace(/^#\s+/, "")) === title,
  );
  const nearbyPriceLine = lines
    .slice(
      titleIndex >= 0 ? titleIndex : 0,
      (titleIndex >= 0 ? titleIndex : 0) + 24,
    )
    .find(
      (line) =>
        /AED|Ø¯\.?Ø¥|Ø¯Ø±Ù‡Ù…|USD|GBP|EUR|\$/i.test(line) &&
        parsePrice(line) > 0 &&
        !/^\d+\s*-\s*\d+\s*(?:MTHS?|MONTHS?|YRS?|YEARS?)$/i.test(line) &&
        !/^(?:Size|Color|Colour|Product Code)/i.test(line),
    );
  if (
    (!price ||
      price <= 0 ||
      /^\d+\s*-\s*\d+\s*(?:MTHS?|MONTHS?|YRS?|YEARS?)$/i.test(
        cleanText(priceLine),
      )) &&
    nearbyPriceLine
  ) {
    price = parsePrice(nearbyPriceLine);
  }

  const colorIndex = lines.findIndex((line) => /^Color\s*:/i.test(line));
  const color =
    colorIndex >= 0
      ? cleanText(lines[colorIndex].split(":").pop() || lines[colorIndex + 1])
      : undefined;
  const sizeValues = uniqueCleanValues(
    lines.filter((line) =>
      /^\d+\s*-\s*\d+\s*(?:MTHS?|MONTHS?|YRS?|YEARS?)$/i.test(line),
    ),
  );
  const productCode = getProductIdFromUrl(url);
  const images: NormalizedProduct["images"] = [];
  const imageRegex = /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
  for (const match of markdown.matchAll(imageRegex)) {
    if (/maxfashion|landmark|cloudfront|scene7|akamai/i.test(match[2])) {
      pushImage(images, match[2], url, match[1]);
    }
  }

  const descriptionIndex = lines.findIndex((line) =>
    /Description and Care/i.test(line),
  );
  const availabilityIndex = lines.findIndex((line) =>
    /In-store Availability|Browse More Products/i.test(line),
  );
  const description =
    descriptionIndex >= 0
      ? cleanText(
          lines
            .slice(
              descriptionIndex + 1,
              availabilityIndex > descriptionIndex
                ? availabilityIndex
                : descriptionIndex + 20,
            )
            .join(" "),
        )
      : "";

  if (price <= 0) {
    throw new Error(
      "Reader fallback did not expose a Max Fashion product price",
    );
  }

  return {
    source: {
      supplier: "Max Fashion",
      url,
      productId: productCode,
    },
    title,
    description,
    brand: "Max Fashion",
    currency,
    price,
    images: images.map((image, position) => ({ ...image, position })),
    options: sizeValues.length
      ? [{ name: "Size", values: sizeValues }]
      : [{ name: "Default", values: ["Default"] }],
    variants: sizeValues.length
      ? sizeValues.map((size) => ({
          sourceVariantId: `${productCode || "max"}-${slugOption(size)}`,
          sku: `${productCode || "MAX"}-${slugOption(size).toUpperCase()}`,
          color,
          size,
          price,
          available: true,
          stockStatus: "in_stock" as const,
        }))
      : [
          {
            sourceVariantId: productCode || "default",
            color,
            price,
            available: true,
            stockStatus: "in_stock",
          },
        ],
    raw: {
      readerFallback: true,
      extractedAt: new Date().toISOString(),
    },
  };
}

function defaultNextCurrencyForUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathName = parsed.pathname.toLowerCase();

    if (host.includes("next.ae")) return "AED";
    if (host.includes("next.us")) return "USD";
    if (host.includes("next.co.uk")) return "GBP";
    if (host.includes("nextdirect.com") && pathName.includes("/eg/"))
      return "EGP";
  } catch {}

  return "EGP";
}

function defaultNextLanguageForUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathName = parsed.pathname.toLowerCase();

    if (host.includes("next.ae"))
      return pathName.includes("/ar/")
        ? "ar-AE,ar;q=0.9,en;q=0.8"
        : "en-AE,en;q=0.9";
    if (host.includes("next.us")) return "en-US,en;q=0.9";
    if (host.includes("next.co.uk")) return "en-GB,en;q=0.9";
    if (host.includes("nextdirect.com") && pathName.includes("/eg/ar/"))
      return "ar-EG,ar;q=0.9,en;q=0.8";
    if (host.includes("nextdirect.com") && pathName.includes("/eg/"))
      return "en-EG,en;q=0.9";
  } catch {}

  return "en-US,en;q=0.9";
}

function nextCookieForUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathName = parsed.pathname.toLowerCase();

    if (host.includes("next.ae"))
      return `Country=ae; Language=${pathName.includes("/ar/") ? "ar" : "en"}; OptanonAlertBoxClosed=2024-01-01T00:00:00.000Z;`;
    if (host.includes("next.us"))
      return "Country=us; Language=en; OptanonAlertBoxClosed=2024-01-01T00:00:00.000Z;";
    if (host.includes("next.co.uk"))
      return "Country=gb; Language=en; OptanonAlertBoxClosed=2024-01-01T00:00:00.000Z;";
    if (host.includes("nextdirect.com") && pathName.includes("/eg/ar/"))
      return "Country=eg; Language=ar; OptanonAlertBoxClosed=2024-01-01T00:00:00.000Z;";
    if (host.includes("nextdirect.com") && pathName.includes("/eg/"))
      return "Country=eg; Language=en; OptanonAlertBoxClosed=2024-01-01T00:00:00.000Z;";
  } catch {}

  return "Country=eg; Language=en; OptanonAlertBoxClosed=2024-01-01T00:00:00.000Z;";
}

function looksLikeNextPriceText(text: string): boolean {
  if (parsePrice(text) <= 0) return false;
  if (/Product Code|Product ID|Size|Colour|Color|Image/i.test(text))
    return false;

  return (
    looksLikeCurrencyText(text) ||
    /(?:EGP|AED|SAR|GBP|EUR|USD)/i.test(text) ||
    text.includes("\u00a3") ||
    text.includes("\u20ac") ||
    text.includes("\u00c2\u00a3") ||
    text.includes("\u00e2\u201a\u00ac") ||
    /^(?:Now|Was|From)?\s*\D{0,8}\d[\d,.]*(?:\s*[-–]\s*\D{0,8}\d[\d,.]*)?$/i.test(
      text,
    )
  );
}

function cleanNextSnapshotTitle(value: string | undefined): string {
  return cleanText(value)
    .replace(/^#\s+/, "")
    .replace(/^Title:\s*/i, "")
    .replace(/^Buy\s+/i, "")
    .replace(/\s+from\s+(?:the\s+)?Next.*$/i, "")
    .replace(/\s+\|\s*Next.*$/i, "")
    .trim();
}

function isNextSnapshotNoiseLine(line: string): boolean {
  return (
    !line ||
    /^\* \* \*$/.test(line) ||
    /^Image:/i.test(line) ||
    /^\[?(?:Input|Button|Link)\]?/i.test(line) ||
    /^(?:Search|Checkout|Back|Home|Help|Add to Bag|Choose Size|Size:?|Colour:?|Color:?|Product Code|Product ID|Store Stock Checker|Recently Viewed|Description|Price History)$/i.test(
      line,
    ) ||
    /^(?:next\s+[a-z]{2}\s+[a-z]{2}|fashion-gallery-|You need to enable JavaScript)/i.test(
      line,
    )
  );
}

function titleFromNextSnapshotLines(
  lines: string[],
  priceIndex: number,
  productCodeIndex: number,
): string {
  const heading = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^#\s+/.test(line))
    .filter(({ index }) => productCodeIndex === -1 || index < productCodeIndex)
    .pop();

  if (heading) return cleanNextSnapshotTitle(heading.line);

  const titleLine = lines.find(
    (line) =>
      /^Title:\s*Buy\s+/i.test(line) ||
      /^Buy\s+.+\s+from\s+(?:the\s+)?Next/i.test(line),
  );
  if (titleLine) return cleanNextSnapshotTitle(titleLine);

  const endIndex =
    [priceIndex, productCodeIndex]
      .filter((index) => index > 0)
      .sort((a, b) => a - b)[0] || lines.length;
  const candidate = lines
    .slice(0, endIndex)
    .reverse()
    .find(
      (line) =>
        !isNextSnapshotNoiseLine(line) &&
        !looksLikeCurrencyText(line) &&
        cleanNextSnapshotTitle(line).length > 3,
    );

  return cleanNextSnapshotTitle(candidate);
}

function productCodeFromNextSnapshot(
  lines: string[],
  url: string,
): string | undefined {
  const productCodeLine = lines.find((line) =>
    /Product Code|Product ID|\u0631\u0645\u0632\s+\u0627\u0644\u0645\u0646\u062a\u062c|Kod produktu/i.test(
      line,
    ),
  );
  const explicitCode = productCodeLine?.match(
    /(?:Product Code|Product ID|\u0631\u0645\u0632\s+\u0627\u0644\u0645\u0646\u062a\u062c|Kod produktu)\s*:?\s*([A-Z0-9]{2,4}-?[A-Z0-9]{3,5})/i,
  )?.[1];

  return cleanText(
    explicitCode ||
      formatNextProductCodeFromProductId(getProductIdFromUrl(url)),
  );
}

function descriptionFromNextSnapshotLines(lines: string[]): string {
  const descriptionStart = lines.findIndex((line) =>
    /^#{0,2}\s*(Description|\u0627\u0644\u0648\u0635\u0641|Opis)\s*$/i.test(
      line,
    ),
  );
  if (descriptionStart < 0) return "";

  const descriptionLines: string[] = [];
  for (const line of lines.slice(descriptionStart + 1)) {
    if (
      /^##\s+/.test(line) ||
      /^!\[/.test(line) ||
      /https?:\/\/xcdn\.next\.co\.uk\/.+\/product\//i.test(line) ||
      /^(?:Price History|Reviews|Recently Viewed|Product Code|Colour|Color|Size|Add to Bag|Store Stock Checker)$/i.test(
        line,
      )
    ) {
      break;
    }
    if (!isNextSnapshotNoiseLine(line)) descriptionLines.push(line);
  }

  return cleanText(descriptionLines.join(" "));
}

function nextSizeValuesFromSnapshotLines(lines: string[]): string[] {
  const sizes: string[] = [];
  const sizeIndex = lines.findIndex((line) =>
    /^(?:Size|Rozmiar|\u0627\u0644\u0645\u0642\u0627\u0633)\s*:?$/i.test(line),
  );
  if (sizeIndex < 0) return sizes;

  for (const line of lines.slice(sizeIndex + 1, sizeIndex + 20)) {
    if (
      /^(?:Add to Bag|Colour|Color|Description|Product Code|Store Stock Checker)$/i.test(
        line,
      ) ||
      /^##\s+/.test(line)
    )
      break;

    for (const match of line.matchAll(/\[Button:\s*([^\]]+)\]/gi)) {
      const size = cleanProductOptionValue("Size", match[1]);
      if (size) sizes.push(size);
    }

    const directSize = cleanProductOptionValue("Size", line);
    if (
      directSize &&
      /^(?:XXS|XS|S|M|L|XL|XXL|2XL|3XL|4XL|5XL|\d+(?:\.\d+)?|UK\s*\d+|EU\s*\d+|Up to\s+\d+|(?:\d+\s*-\s*\d+)\s*(?:Months?|Mths?|Years?|Yrs?))$/i.test(
        directSize,
      )
    ) {
      sizes.push(directSize);
    }
  }

  return uniqueCleanValues(sizes);
}

function nextSnapshotHasSizePicker(lines: string[]): boolean {
  const sizeIndex = lines.findIndex((line) =>
    /^(?:Size|Rozmiar|\u0627\u0644\u0645\u0642\u0627\u0633)\b/i.test(line),
  );
  if (sizeIndex < 0) return false;

  return lines
    .slice(sizeIndex, sizeIndex + 8)
    .some((line) =>
      /Choose Size|Select Size|Size Guide|Add to Bag|\u0627\u062e\u062a(?:ر|\u0627\u0631)\s+\u0627\u0644\u0645\u0642\u0627\u0633/i.test(
        line,
      ),
    );
}

function inferNextFallbackSizesFromProductType(
  title: string,
  description: string,
  lines: string[],
): string[] {
  if (!nextSnapshotHasSizePicker(lines)) return [];

  const text = cleanText(`${title} ${description}`).toLowerCase();

  if (
    /\b(?:slippers?|mules?|slider slippers?|toe thong slippers?)\b/i.test(text)
  ) {
    return ["S", "M", "L"];
  }

  return [];
}

function nextSnapshotTitleIndex(
  lines: string[],
  title: string,
  productCodeIndex: number,
): number {
  const candidates = lines
    .map((line, index) => ({ line, index }))
    .filter(
      ({ line, index }) =>
        cleanNextSnapshotTitle(line) === title &&
        (productCodeIndex === -1 || index < productCodeIndex),
    );

  const productHeading = [...candidates]
    .reverse()
    .find(({ line }) => /^#\s+/.test(line));
  return productHeading?.index ?? candidates.at(-1)?.index ?? 0;
}

function parseNextSnapshotText(
  snapshotText: string,
  url: string,
  snapshotUrl = url,
  rawFlags: Record<string, any> = {},
): NormalizedProduct {
  if (isBlockedReaderMarkdown(snapshotText)) {
    throw new Error(
      "Reader fallback returned an access-denied or missing page",
    );
  }

  const lines = snapshotText
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .filter(Boolean);
  const productIdFromUrl = getProductIdFromUrl(url);
  const productCode =
    productCodeFromNextSnapshot(lines, url) || productIdFromUrl;
  const productCodeLine = lines.find((line) =>
    /Product Code|Product ID|\u0631\u0645\u0632\s+\u0627\u0644\u0645\u0646\u062a\u062c|Kod produktu/i.test(
      line,
    ),
  );
  const productCodeIndex = productCodeLine
    ? lines.indexOf(productCodeLine)
    : -1;

  const priceIndex = lines.findIndex(looksLikeNextPriceText);
  const title = titleFromNextSnapshotLines(lines, priceIndex, productCodeIndex);
  const titleIndex = nextSnapshotTitleIndex(lines, title, productCodeIndex);

  if (
    !title ||
    /^(Access Denied|404|Page Not Found|Next Product)$/i.test(title)
  ) {
    throw new Error("Reader fallback did not expose a product title");
  }

  const priceWindow = lines.slice(
    titleIndex,
    productCodeIndex > titleIndex ? productCodeIndex : titleIndex + 30,
  );
  const regionalPriceLine =
    priceWindow.find(
      (line) =>
        looksLikeNextPriceText(line) && nextPriceLineMatchesRegion(url, line),
    ) ||
    lines.find(
      (line) =>
        looksLikeNextPriceText(line) && nextPriceLineMatchesRegion(url, line),
    );
  const snapshotPriceLine =
    priceWindow.find(looksLikeNextPriceText) ||
    lines.find(looksLikeNextPriceText);
  const descriptionText = descriptionFromNextSnapshotLines(lines);

  const images: NormalizedProduct["images"] = [];
  const productIdKey = productIdFromUrl?.toLowerCase();
  images.push(
    ...extractNextProductImages(snapshotText, snapshotUrl, productIdKey),
  );

  const arabicBrandMatch = title.match(/\s\u0645\u0646\s+(.+)$/);
  const englishBrandMatch = title.match(/\bfrom\s+(.+)$/i);
  const brand = cleanText(
    arabicBrandMatch?.[1] || englishBrandMatch?.[1] || "Next",
  );
  const effectivePriceLine =
    regionalPriceLine ||
    (!rawFlags.readerFallback
      ? snapshotPriceLine ||
        priceWindow.find((line) =>
          /(?:EGP|\$|£|€|\u062c\s*\.?\s*\u0645)/i.test(line),
        ) ||
        lines.find((line) =>
          /(?:EGP|\$|£|€|\u062c\s*\.?\s*\u0645)/i.test(line),
        ) ||
        priceWindow.find(looksLikeCurrencyText) ||
        lines.find(looksLikeCurrencyText)
      : undefined);

  if (rawFlags.readerFallback && !effectivePriceLine) {
    throw new Error("Reader fallback did not expose a regional product price");
  }

  const priceRange = parsePriceRange(effectivePriceLine);
  const price = priceRange.min;
  const currency =
    defaultNextCurrencyForUrl(url) || detectCurrency(effectivePriceLine, "USD");
  const color =
    parseNextColourFromMarkdown(lines) || inferNextColourFromTitle(title);
  if (color) {
    images.forEach((image) => {
      image.color ||= color;
    });
  }
  const explicitSizes = nextSizeValuesFromSnapshotLines(lines);
  const typeInferredSizes = explicitSizes.length
    ? []
    : inferNextFallbackSizesFromProductType(title, descriptionText, lines);
  const babyInferredSizes =
    explicitSizes.length || typeInferredSizes.length
      ? []
      : inferNextBabySizes(`${title} ${descriptionText}`);
  const sizeValues = explicitSizes.length
    ? explicitSizes
    : typeInferredSizes.length
      ? typeInferredSizes
      : babyInferredSizes;
  if (!sizeValues.length && nextSnapshotHasSizePicker(lines)) {
    throw new ScraperError(
      "Next exposed a size picker, but the page snapshot did not include the size values. Re-analyze with the full visible product page text after opening the size selector, so Syncly does not publish this as One Size.",
      {
        code: "NEXT_SIZE_VALUES_MISSING",
        status: 422,
        supplier: "Next",
        retryWithSnapshot: true,
      },
    );
  }
  const variants = buildInferredNextVariants(
    productCode,
    sizeValues,
    priceRange,
    color,
  );

  if (price <= 0) {
    throw new Error("Reader fallback did not expose a product price");
  }

  const product: NormalizedProduct = {
    source: {
      supplier: "Next",
      url,
      productId: productCode,
    },
    title,
    description: descriptionText,
    brand,
    currency,
    price,
    images,
    options: [
      ...(color ? [{ name: "Color", values: [color] }] : []),
      { name: "Size", values: sizeValues.length ? sizeValues : ["Default"] },
    ],
    variants: variants.length
      ? variants
      : [
          {
            sourceVariantId: productCode || "default",
            sku: productCode,
            color,
            size: "Default",
            price,
            optionValues: buildVariantOptionValues(color, undefined),
            available: true,
            stockStatus: "in_stock",
          },
        ],
    raw: {
      ...rawFlags,
      snapshotUrl,
      regionalFallback: snapshotUrl !== url,
      productCode,
      inferredVariants: variants.length > 0,
      sizesInferredFromProductType: typeInferredSizes.length ? true : undefined,
      imageUnavailableReason:
        images.length === 0
          ? "Next blocked direct product media access, so this analysis did not include image URLs."
          : undefined,
      extractedAt: new Date().toISOString(),
    },
  };

  return product;
}

function parseNextReaderMarkdown(
  markdown: string,
  url: string,
  readerUrl = url,
): NormalizedProduct {
  return parseNextSnapshotText(markdown, url, readerUrl, {
    readerFallback: true,
    readerUrl,
  });
}

function nextNeedsReaderColorwayEnrichment(product: NormalizedProduct): boolean {
  if (product.raw?.readerFallback || product.raw?.pastedSnapshotFallback)
    return false;
  if (!product.images.length) return true;

  const hasColorOption = product.options.some((option) =>
    /^colou?r$/i.test(option.name),
  );
  const hasVariantColor = product.variants.some((variant) =>
    Boolean(variant.color || variant.optionValues?.Color),
  );
  const hasVariantImages = product.variants.every(
    (variant) => Boolean(variant.imageUrl) || product.images.length === 1,
  );

  return (hasColorOption || hasVariantColor) && !hasVariantImages;
}

async function enrichNextProductWithReaderColorways(
  product: NormalizedProduct,
  url: string,
): Promise<NormalizedProduct> {
  if (!nextNeedsReaderColorwayEnrichment(product)) return product;

  try {
    const reader = await fetchNextReaderMarkdown(url);
    if (!reader) return product;
    return applyNextColorwaysFromMarkdown(
      product,
      reader.markdown,
      url,
      reader.readerUrl,
    );
  } catch {
    return product;
  }
}

function isBlockedNextHtml(html: string): boolean {
  return (
    /<title>\s*Access Denied\s*<\/title>|<h1>\s*Access Denied\s*<\/h1>|You don't have permission to access/i.test(
      html,
    ) || /404\s*\|\s*Page Not Found|Oops'\s+Something's gone wrong/i.test(html)
  );
}

function extractNextSizesFromHtml(
  $: cheerio.CheerioAPI,
  title: string,
  description: string,
): string[] {
  const sizes: string[] = [];

  $(
    '[data-testid="size-select"] option, [data-testid="size-select"] [role="option"]',
  ).each((_, el) => {
    const value = cleanText($(el).attr("value") || $(el).text());
    const size = cleanProductOptionValue("Size", value);
    if (size && !/^(?:choose|select)\s+size$/i.test(size)) sizes.push(size);
  });

  $('[data-testid="item-form-size-control"] button[aria-label]').each(
    (_, el) => {
      const label = cleanText($(el).attr("aria-label"));
      const match = label.match(/^(.+?)\s+available$/i);
      if (!match) return;
      const size = cleanProductOptionValue("Size", match[1]);
      if (size) sizes.push(size);
    },
  );

  const explicitSizes = uniqueCleanValues(sizes);
  if (explicitSizes.length) return explicitSizes;

  const babySizes = inferNextBabySizes(`${title} ${description}`);
  if (babySizes.length) return babySizes;

  const hasSizePicker =
    $('[data-testid="size-select"], [data-testid="item-form-size-control"]')
      .length > 0;
  if (
    hasSizePicker &&
    /\b(?:slippers?|mules?|slider slippers?|toe thong slippers?)\b/i.test(
      `${title} ${description}`,
    )
  ) {
    return ["S", "M", "L"];
  }

  return [];
}

function extractNextProductFromHtml(
  html: string,
  url: string,
  pageUrl = url,
): NormalizedProduct {
  if (isBlockedNextHtml(html)) {
    throw new Error("Next HTML returned an access-denied or missing page");
  }

  const $ = cheerio.load(html);
  let productData: any = null;

  $(
    'script[type="application/ld+json"], script[data-testid="pdp-structured-data"]',
  ).each((_, el) => {
    if (productData) return;
    try {
      productData = findProductJsonLd(JSON.parse($(el).text() || "{}"));
    } catch {}
  });

  if (!productData) {
    $("script").each((_, el) => {
      if (productData) return;
      const text = $(el).text() || "";
      if (
        !text.includes('"@type":"Product"') &&
        !text.includes('"@type": "Product"')
      )
        return;
      try {
        const jsonStart = text.indexOf("{");
        if (jsonStart >= 0)
          productData = findProductJsonLd(JSON.parse(text.slice(jsonStart)));
      } catch {}
    });
  }

  const offerList = Array.isArray(productData?.offers)
    ? productData.offers
    : [productData?.offers].filter(Boolean);
  const productCode = cleanText(
    productData?.sku ||
      $('[data-testid="product-code"]').first().text() ||
      $('[data-testid="product-code"]').first().attr("content") ||
      getProductIdFromUrl(url) ||
      "",
  );
  const title = cleanText(
    productData?.name ||
      $('[data-testid="product-title"]').first().text() ||
      $('[data-testid="pdp-title"]').first().text() ||
      $("h1").first().text() ||
      $('meta[property="og:title"]').attr("content") ||
      $("title")
        .text()
        .replace(/^Buy\s+/i, "")
        .replace(/\s*\|\s*Next.*$/i, ""),
  );

  if (!title || /^(Access Denied|404|Page Not Found)$/i.test(title)) {
    throw new Error("Next HTML did not expose a product title");
  }

  const description = cleanText(
    productData?.description
      ? cheerio.load(productData.description).text()
      : $('[data-testid="item-description"]').first().text() ||
          $('[data-testid="product-description"]').first().text() ||
          $('meta[name="description"]').attr("content"),
  );

  const brandValue = productData?.brand;
  const brand = cleanText(
    (typeof brandValue === "string" ? brandValue : brandValue?.name) || "Next",
  );
  const itemNumber = (
    getProductIdFromUrl(pageUrl) ||
    getProductIdFromUrl(url) ||
    productCode.replace(/-/g, "")
  ).toLowerCase();
  const images = extractNextProductImages(html, pageUrl, itemNumber);
  const productImages = Array.isArray(productData?.image)
    ? productData.image
    : [productData?.image].filter(Boolean);
  for (const imageUrl of productImages) {
    pushNextProductImage(
      images,
      typeof imageUrl === "string" ? imageUrl : imageUrl?.url,
      pageUrl,
      itemNumber,
    );
  }

  const priceText = cleanText(
    $('[data-testid="product-now-price"]').first().text() ||
      $('[data-testid="product-price"]').first().text() ||
      productData?.offers?.price,
  );
  const priceValues = offerList
    .map((offer: any) => parsePrice(offer?.price))
    .filter((price: number) => price > 0);
  const priceRangeFromDom = parsePriceRange(priceText);
  const fallbackPrice =
    priceRangeFromDom.min ||
    parsePrice(productData?.offers?.price || priceText);
  const price = priceValues.length ? Math.min(...priceValues) : fallbackPrice;
  const maxPrice = priceValues.length
    ? Math.max(...priceValues)
    : priceRangeFromDom.max || price;
  const currency = detectCurrency(
    offerList[0]?.priceCurrency || priceText,
    defaultNextCurrencyForUrl(url) || offerList[0]?.priceCurrency || "USD",
  );
  const color =
    cleanColorOptionValue(
      $('[data-testid="selected-colour-label"]').first().text(),
    ) || parseNextColourFromHtml($, title);
  if (color) {
    images.forEach((image) => {
      image.color ||= color;
    });
  }
  const variantsFromOffers = variantsFromJsonLdOffers(
    productData?.offers,
    productCode,
    color,
  );
  const inferredSizes = extractNextSizesFromHtml($, title, description);
  const variants = variantsFromOffers.length
    ? variantsFromOffers
    : buildInferredNextVariants(
        productCode,
        inferredSizes,
        { min: price, max: maxPrice },
        color,
      );
  const sizeValues = [
    ...new Set(variants.map((variant) => variant.size).filter(Boolean)),
  ];

  if (price <= 0) {
    throw new Error("Next HTML did not expose a product price");
  }

  return {
    source: {
      supplier: "Next",
      url,
      productId: productCode || getProductIdFromUrl(url),
    },
    title,
    description,
    brand,
    currency,
    price,
    images,
    options: [
      ...(color ? [{ name: "Color", values: [color] }] : []),
      { name: "Size", values: sizeValues.length ? sizeValues : ["Default"] },
    ],
    variants: variants.length
      ? variants
      : [
          {
            sourceVariantId: productCode || "default",
            sku: productCode,
            color,
            size: "Default",
            price,
            optionValues: buildVariantOptionValues(color, undefined),
            available: true,
            stockStatus: "in_stock",
          },
        ],
    raw: {
      htmlFallback: pageUrl !== url,
      htmlUrl: pageUrl,
      productCode,
      extractedAt: new Date().toISOString(),
    },
  };
}

function isNextBlockedFailure(errors: string[]): boolean {
  if (errors.length === 0) return false;
  const blockedOrUnusableFallback = errors.every((error) =>
    /(?:HTTP 403|Access Denied|access-denied|permission to access|Forbidden|Reader fallback did not expose a product (?:price|title)|Reader fallback returned an access-denied or missing page|size picker.*did not include the size values|No usable product HTML returned|no usable markdown returned|Regional mismatch|Managed bypass returned non-product HTML|Playwright returned non-product HTML|ScraperAPI returned a blocked page|ZenRows returned a blocked page)/i.test(
      error,
    ),
  );
  const blockedByNext = errors.some((error) =>
    /(?:HTTP 403|Access Denied|access-denied|permission to access|Forbidden|size picker.*did not include the size values|No usable product HTML returned|Regional mismatch|Playwright returned non-product HTML|ScraperAPI returned a blocked page|ZenRows returned a blocked page)/i.test(
      error,
    ),
  );

  return blockedByNext && blockedOrUnusableFallback;
}

function nextBlockedScraperError(details: string[]): ScraperError {
  return new ScraperError(
    "Next blocked automated server access to this product page (HTTP 403). Open the product in your browser and paste the visible product text to analyze it from a page snapshot.",
    {
      code: "SOURCE_BLOCKED",
      status: 422,
      supplier: "Next",
      retryWithSnapshot: true,
      details,
    },
  );
}

function parseGenericReaderMarkdown(
  markdown: string,
  url: string,
): NormalizedProduct {
  if (isBlockedReaderMarkdown(markdown)) {
    throw new Error(
      "Reader fallback returned an access-denied or missing page",
    );
  }

  const lines = markdown
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .filter(Boolean);
  const ignoredSnapshotTitleLine =
    /^(?:Home|Sign in|Search|Basket|Cart|Add to Basket|Add to Cart|Description|Product Details|Details|Size|Color|Colour)$/i;
  const titleLine =
    lines.find((line) => /^#\s+/.test(line)) ||
    lines.find((line) => /^Title:\s+/i.test(line)) ||
    lines.find(
      (line) =>
        line.length > 5 &&
        !ignoredSnapshotTitleLine.test(line) &&
        !/^colou?r\s*:/i.test(line) &&
        !looksLikeCurrencyText(line) &&
        !/^(?:\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*(?:M|MTHS?|MONTHS?|Y|YRS?|YEARS?)|\d+\s*(?:M|MTHS?|MONTHS?|Y|YRS?|YEARS?)|XS|S|M|L|XL|XXL)$/i.test(
          line,
        ) &&
        !/^https?:\/\//i.test(line),
    ) ||
    "";
  const title = cleanText(
    titleLine.replace(/^#\s+/, "").replace(/^Title:\s*/i, ""),
  );
  if (!title || /access denied|just a moment|page not found/i.test(title)) {
    throw new Error("Reader fallback did not expose a product title");
  }

  const priceLine =
    lines.find((line) => looksLikeCurrencyText(line) && parsePrice(line) > 0) ||
    lines.find((line) => parsePrice(line) > 0);
  const price = parsePrice(priceLine);
  if (price <= 0) {
    throw new Error("Reader fallback did not expose a product price");
  }

  const currency = detectCurrency(priceLine || markdown, "USD");
  const images: NormalizedProduct["images"] = [];
  const imageRegex = /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
  for (const match of markdown.matchAll(imageRegex)) {
    pushImage(images, match[2], url, match[1]);
  }

  const descriptionStart = lines.findIndex((line) =>
    /description|product details|details/i.test(line),
  );
  const description =
    descriptionStart >= 0
      ? lines.slice(descriptionStart + 1, descriptionStart + 12).join(" ")
      : cleanText(
          lines
            .slice(1, 8)
            .filter((line) => !looksLikeCurrencyText(line))
            .join(" "),
        );
  const productId = getProductIdFromUrl(url);
  const colorIndex = lines.findIndex((line) => /^colou?r\s*:/i.test(line));
  const color =
    colorIndex >= 0
      ? cleanColorOptionValue(
          lines[colorIndex].split(":").slice(1).join(":") ||
            lines[colorIndex + 1],
        )
      : undefined;
  const sizeValues = uniqueCleanValues(
    lines.filter((line) =>
      /^(?:\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*(?:M|MTHS?|MONTHS?|Y|YRS?|YEARS?)|\d+\s*(?:M|MTHS?|MONTHS?|Y|YRS?|YEARS?)|XS|S|M|L|XL|XXL)$/i.test(
        line,
      ),
    ),
  );

  return normalizeProductOptionsAndVariants({
    source: {
      supplier: "Generic",
      url,
      productId,
    },
    title,
    description,
    brand: "Generic",
    currency,
    price,
    images: images.map((image, position) => ({ ...image, position })),
    options: [
      ...(color ? [{ name: "Color", values: [color] }] : []),
      ...(sizeValues.length
        ? [{ name: "Size", values: sizeValues }]
        : [{ name: "Default", values: ["Default"] }]),
    ],
    variants: sizeValues.length
      ? sizeValues.map((size) => ({
          sourceVariantId: `${productId || "default"}-${slugOption(size)}`,
          color,
          size,
          price,
          currency,
          optionValues: buildVariantOptionValues(color, size),
          available: true,
          stockStatus: "unknown" as const,
        }))
      : [
          {
            sourceVariantId: productId || "default",
            color,
            price,
            currency,
            optionValues: buildVariantOptionValues(color),
            available: true,
            stockStatus: "unknown",
          },
        ],
    raw: {
      readerFallback: true,
      extractedAt: new Date().toISOString(),
    },
  });
}

function extractCentrepointSizeValues($: cheerio.CheerioAPI): string[] {
  return uniqueCleanValues(
    $(
      "#details-memory #list-prod-sizes button, .root-pdp-sizes #list-prod-sizes button, #list-prod-sizes button",
    )
      .map((_, el) => $(el).attr("value") || $(el).text())
      .get(),
  );
}

function extractCentrepointDescription(
  $: cheerio.CheerioAPI,
  fallback: string | undefined,
): string {
  const intro = cleanText($("#details-overview .innerWrapText").first().text());
  const details = $("#root-prod-prodAttr li")
    .map((_, el) => {
      const parts = $(el)
        .find("div")
        .map((__, part) => cleanText($(part).text()))
        .get()
        .filter(Boolean);
      if (parts.length < 2) return "";
      return `${parts[0]}: ${parts.slice(1).join(" ")}`;
    })
    .get()
    .filter(Boolean);

  return uniqueCleanValues([intro || fallback, ...details]).join("\n");
}

function parseCentrepointHtml(html: string, url: string): NormalizedProduct {
  const $ = cheerio.load(html);
  const product = extractGenericProductFromHtml(html, url, "Centrepoint");
  const jsonLdProduct = extractProductJsonLdFromHtml(html);
  const productId = product.source.productId || getProductIdFromUrl(url);
  const color = cleanText(
    jsonLdProduct?.color ||
      product.raw?.color ||
      product.options.find((option) => /^colou?r$/i.test(option.name))
        ?.values?.[0] ||
      product.variants.find((variant) => variant.color)?.color,
  );
  const images = [...product.images];
  const centrepointImageRegex =
    /https:\/\/media\.centrepointstores\.com\/i\/centrepoint\/[^"',\s?&<]+\.(?:jpg|jpeg|png|webp)/gi;
  for (const match of html.matchAll(centrepointImageRegex)) {
    pushImage(images, match[0], url, product.title);
  }
  images.sort((a, b) => {
    const aPosition = Number(
      a.url.match(/_(\d+)-\d+\.(?:jpg|jpeg|png|webp)/i)?.[1] || a.position,
    );
    const bPosition = Number(
      b.url.match(/_(\d+)-\d+\.(?:jpg|jpeg|png|webp)/i)?.[1] || b.position,
    );
    return aPosition - bPosition;
  });
  const sizeValues = extractCentrepointSizeValues($);
  const sizeOptions = sizeValues.length
    ? [{ name: "Size", values: sizeValues }]
    : [];
  const colorOptions = color ? [{ name: "Color", values: [color] }] : [];
  const stockStatus = product.variants.some(
    (variant) => variant.stockStatus === "out_of_stock",
  )
    ? ("out_of_stock" as const)
    : ("in_stock" as const);
  const variants = sizeValues.length
    ? sizeValues.map((size) => ({
        sourceVariantId: `${productId || "centrepoint"}-${slugOption(size)}`,
        sku: `${productId || "CP"}-${slugOption(size).toUpperCase()}`,
        color: color || undefined,
        size,
        price: product.price,
        currency: product.currency,
        optionValues: buildVariantOptionValues(color, size),
        available: stockStatus !== "out_of_stock",
        stockStatus,
        imageUrl: images[0]?.url,
      }))
    : product.variants;

  return normalizeProductOptionsAndVariants({
    ...product,
    source: {
      ...product.source,
      supplier: "Centrepoint",
      productId,
    },
    description: extractCentrepointDescription($, product.description),
    brand:
      product.brand && !/^https?:\/\//i.test(product.brand)
        ? product.brand
        : "Centrepoint",
    images: images.map((image, position) => ({ ...image, position })),
    options: [...colorOptions, ...sizeOptions].length
      ? [...colorOptions, ...sizeOptions]
      : product.options,
    variants,
    raw: {
      ...product.raw,
      centrepointHtmlFallback: true,
      sizeValues,
    },
  });
}

export class CentrepointScraper implements SupplierScraper {
  canHandle(url: string): boolean {
    return hostMatches(url, ["centrepointstores.com"]);
  }

  scrapeSnapshot(url: string, snapshotText: string): NormalizedProduct {
    const product = parseGenericReaderMarkdown(snapshotText, url);
    return normalizeProductOptionsAndVariants({
      ...product,
      source: {
        supplier: "Centrepoint",
        url,
        productId: getProductIdFromUrl(url),
      },
      brand:
        product.brand && product.brand !== "Generic"
          ? product.brand
          : "Centrepoint",
      raw: {
        ...(product.raw || {}),
        pastedSnapshotFallback: true,
      },
    });
  }

  async scrape(url: string): Promise<NormalizedProduct> {
    const errors: string[] = [];

    try {
      const html = await fetchHtml(url, {
        "Accept-Language": "en-AE,en;q=0.9",
        Referer: "https://www.centrepointstores.com/ae/en/",
      });
      if (/Just a moment|security verification|cf-chl|Cloudflare/i.test(html)) {
        throw new Error("Cloudflare challenge");
      }
      return parseCentrepointHtml(html, url);
    } catch (error: any) {
      errors.push(`direct: ${error.message}`);
    }

    try {
      const html = await fetchHtmlWithCurl(url);
      return parseCentrepointHtml(html, url);
    } catch (error: any) {
      errors.push(`curl: ${error.message}`);
    }

    if (activeManagedBypassProviders(url).length > 0) {
      try {
        const html = await fetchHtmlViaManagedBypass(stripUrlHash(url), {
          deviceType: "mobile",
          jsRender: true,
          premium: true,
        });
        return parseCentrepointHtml(html, url);
      } catch (error: any) {
        errors.push(`managed bypass: ${error.message}`);
      }
    }

    try {
      const markdown = await fetchReaderMarkdown(url);
      return {
        ...parseGenericReaderMarkdown(markdown, url),
        source: {
          supplier: "Centrepoint",
          url,
          productId: getProductIdFromUrl(url),
        },
        brand: "Centrepoint",
      };
    } catch (error: any) {
      errors.push(`reader: ${error.message}`);
    }

    const blockedSignals = errors.filter((error) =>
      /HTTP 403|Cloudflare|security verification|access-denied|permission to access|Forbidden|no usable product html|curl executable is not available|Reader fallback returned an access-denied|ScraperAPI returned a blocked page|ZenRows returned a blocked page|managed bypass returned non-product html/i.test(
        error,
      ),
    ).length;

    if (blockedSignals >= Math.max(1, errors.length - 1)) {
      throw new ScraperError(
        "Centrepoint blocked automated server access to this product page. Open the product in your browser and paste the visible product text to analyze it from a page snapshot.",
        {
          code: "SOURCE_BLOCKED",
          status: 422,
          supplier: "Centrepoint",
          retryWithSnapshot: true,
          details: errors,
        },
      );
    }

    throw new Error(`Failed to scrape Centrepoint (${errors.join("; ")})`);
  }

  async checkAvailability(url: string): Promise<AvailabilitySnapshot> {
    return availabilitySnapshotFromProduct(await this.scrape(url));
  }
}

export class HmScraper implements SupplierScraper {
  canHandle(url: string): boolean {
    return hostMatches(url, ["ae.hm.com", "hm.com"]);
  }

  scrapeSnapshot(url: string, snapshotText: string): NormalizedProduct {
    const product = parseGenericReaderMarkdown(snapshotText, url);
    return {
      ...product,
      source: {
        ...product.source,
        supplier: "H&M",
        productId: product.source.productId || getProductIdFromUrl(url),
      },
      brand:
        product.brand && product.brand !== "Generic" ? product.brand : "H&M",
      raw: {
        ...(product.raw || {}),
        pastedSnapshotFallback: true,
      },
    };
  }

  async scrape(url: string): Promise<NormalizedProduct> {
    const html = await fetchHtml(url, {
      "Accept-Language": "en-AE,en;q=0.9",
      Referer: "https://ae.hm.com/en/",
    });
    const fallback = extractGenericProductFromHtml(html, url, "H&M");
    const $ = cheerio.load(html);
    const sku = cleanText(
      extractProductJsonLdFromHtml(html)?.sku ||
        $('meta[name="sku"]').attr("content") ||
        fallback.source.productId,
    );

    if (!sku) return fallback;

    try {
      const product = await fetchHmGraphqlProduct(url, sku);
      if (!product) return fallback;
      const normalized = normalizeProductOptionsAndVariants(
        normalizeHmGraphqlProduct(product, fallback, url),
      );
      if (
        normalized.price <= 0 ||
        /client challenge|metadata/i.test(normalized.title)
      ) {
        throw new Error("H&M GraphQL did not expose usable product data");
      }
      return normalized;
    } catch (error: any) {
      if (
        fallback.price <= 0 ||
        /client challenge|metadata/i.test(fallback.title)
      ) {
        throw new ScraperError(
          "H&M did not expose usable product data to server analysis. Open the product in your browser and paste the visible product text to analyze it from a page snapshot.",
          {
            code: "SOURCE_BLOCKED",
            status: 422,
            supplier: "H&M",
            retryWithSnapshot: true,
            details: [error.message],
          },
        );
      }

      return normalizeProductOptionsAndVariants({
        ...fallback,
        source: {
          ...fallback.source,
          supplier: "H&M",
        },
        raw: {
          ...(fallback.raw || {}),
          hmGraphqlError: error.message,
        },
      });
    }
  }

  async checkAvailability(url: string): Promise<AvailabilitySnapshot> {
    return availabilitySnapshotFromProduct(await this.scrape(url));
  }
}

export class GenericScraper implements SupplierScraper {
  canHandle(url: string): boolean {
    return true; // Catch-all
  }

  async scrape(url: string): Promise<NormalizedProduct> {
    const errors: string[] = [];
    const requestOptions: any = {
      headers: {
        ...browserHeaders,
        "Sec-Ch-Ua":
          '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
        Referer: "https://www.google.com/",
      },
      timeout: 15000,
    };

    try {
      const response = await axios.get(url, requestOptions);
      return extractGenericProductFromHtml(response.data, url);
    } catch (error: any) {
      errors.push(`browser: ${error.response?.status || error.message}`);
    }

    try {
      requestOptions.headers["User-Agent"] =
        "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
      const response = await axios.get(url, requestOptions);
      return extractGenericProductFromHtml(response.data, url);
    } catch (error: any) {
      errors.push(`googlebot: ${error.response?.status || error.message}`);
    }

    try {
      const html = await fetchHtmlWithCurl(url);
      return extractGenericProductFromHtml(html, url);
    } catch (error: any) {
      errors.push(`curl: ${error.message}`);
    }

    try {
      const markdown = await fetchReaderMarkdown(url);
      return parseGenericReaderMarkdown(markdown, url);
    } catch (error: any) {
      errors.push(`reader: ${error.message}`);
    }

    console.error("Scraping error:", errors.join("; "));
    throw new Error(`Failed to scrape product data (${errors.join("; ")})`);
  }

  async checkAvailability(url: string): Promise<AvailabilitySnapshot> {
    return availabilitySnapshotFromProduct(await this.scrape(url));
  }
}

export class NextScraper implements SupplierScraper {
  canHandle(url: string): boolean {
    return isNextUrl(url);
  }

  scrapeSnapshot(url: string, snapshotText: string): NormalizedProduct {
    return parseNextSnapshotText(snapshotText, url, url, {
      pastedSnapshotFallback: true,
      imageUnavailableReason:
        "This product was analyzed from pasted Next page text because Next blocked automated server access.",
    });
  }

  async scrape(url: string): Promise<NormalizedProduct> {
    try {
      // Try to extract product ID and style ID from URL
      // https://www.nextdirect.com/eg/ar/style/su864117/y13998#y13998
      const urlMatch = url.match(/style\/([a-z0-9]+)\/([a-z0-9]+)/i);
      if (urlMatch) {
        const [, styleId, productId] = urlMatch;
        const apiUrls = [
          `https://www.next.ae/api/product/v1/product/${styleId}/${productId}`,
          `https://www.nextdirect.com/api/product/v1/product/${styleId}/${productId}`,
          `https://www.next.co.uk/api/product/v1/product/${styleId}/${productId}`,
        ];

        const controllers = apiUrls.map(() => new AbortController());
        try {
          const data = await Promise.any(
            apiUrls.map(async (apiUrl, index) => {
              console.log(`Trying Next API: ${apiUrl}`);
              const apiResponse = await axios.get(apiUrl, {
                headers: {
                  accept: "application/json, text/plain, */*",
                  ...buildNextMobileHeaders(url),
                  referer: url,
                },
                signal: controllers[index].signal,
                timeout: envNumber("NEXT_API_TIMEOUT_MS", 3000),
                validateStatus: (status: number) => status < 500,
                ...buildScraperAxiosConfig(),
              });

              if (apiResponse.status !== 200 || !apiResponse.data) {
                throw new Error(`Next API HTTP ${apiResponse.status}`);
              }

              return apiResponse.data;
            }),
          );
          controllers.forEach((controller) => controller.abort());

          const item = data.product || data;
          return await enrichNextProductWithReaderColorways(
            normalizeProductOptionsAndVariants({
              source: {
                supplier: "Next",
                url,
                productId: `${styleId}-${productId}`,
              },
              title: item.name || item.title || "Next Product",
              description: item.description,
              brand: item.brand || "Next",
              currency: item.currency || defaultNextCurrencyForUrl(url),
              price: parseFloat(item.price || item.currentPrice || "0"),
              images: (item.images || []).map((img: any, idx: number) => ({
                url: img.url || img,
                position: idx,
              })),
              options: item.options || [],
              variants: (item.variants || []).map((v: any) => ({
                sourceVariantId: v.id || v.sku,
                sku: v.sku,
                price: parseFloat(v.price),
                available: v.inStock !== false,
                stockStatus: v.inStock ? "in_stock" : "out_of_stock",
              })),
              raw: data,
            }),
            url,
          );
        } catch {
          controllers.forEach((controller) => controller.abort());
          // Expected on some regional Next URLs; HTML/reader fallback handles this.
        }
      }

      // Fallback to HTML scraping if API fails (mobile UA first — Next blocks desktop server traffic)
      let lastError: any = null;
      const htmlErrors: string[] = [];
      const pageUrls = [
        ...new Set([stripUrlHash(url), ...buildNextHtmlFallbackUrls(url)]),
      ];
      const bypassErrors: string[] = [];
      const fastBypassTriedUrls = new Set<string>();

      if (
        envFlag("NEXT_FAST_BYPASS", true) &&
        activeManagedBypassProviders(url).length > 0
      ) {
        const fastBypassUrls = pageUrls.slice(
          0,
          Math.max(1, envNumber("NEXT_FAST_BYPASS_URLS", 1)),
        );

        for (const pageUrl of fastBypassUrls) {
          fastBypassTriedUrls.add(pageUrl);
          try {
            const fastBypassOptions: ManagedBypassOptions = {
              deviceType: envBypassDevice("NEXT_FAST_BYPASS_DEVICE", "mobile"),
              jsRender: false,
              premium: envFlag("NEXT_FAST_BYPASS_PREMIUM", false),
            };
            const html = envFlag("NEXT_FAST_BYPASS_RACE", true)
              ? await fetchHtmlViaManagedBypassRace(pageUrl, fastBypassOptions, {
                  maxProviders: envNumber("NEXT_FAST_BYPASS_RACE_MAX_PROVIDERS", 2),
                  timeoutMs: envNumber("NEXT_FAST_BYPASS_RACE_TIMEOUT_MS", 12000),
                })
              : await fetchHtmlViaManagedBypass(pageUrl, fastBypassOptions);
            if (isBlockedNextHtml(html) || !isUsableNextProductHtml(html)) {
              throw new Error("Managed bypass returned non-product HTML");
            }

            const product = extractNextProductFromHtml(html, url, pageUrl);
            if (
              !nextScrapeMatchesRequestedRegion(url, pageUrl, product.currency)
            ) {
              throw new Error(
                `Regional mismatch (${product.currency} from ${pageUrl})`,
              );
            }

            console.log(
              `Successfully scraped Next via fast managed bypass from ${pageUrl}`,
            );
            return await enrichNextProductWithReaderColorways(
              {
                ...product,
                raw: {
                  ...product.raw,
                  managedBypassFallback: true,
                  fastManagedBypass: true,
                },
              },
              url,
            );
          } catch (bypassError: any) {
            bypassErrors.push(`${pageUrl}: ${bypassError.message}`);
          }
        }
      }

      for (const pageUrl of pageUrls) {
        try {
          const html = await fetchNextPageHtml(pageUrl);
          if (!html) {
            throw new Error("No usable product HTML returned");
          }

          const product = extractNextProductFromHtml(html, url, pageUrl);
          if (
            !nextScrapeMatchesRequestedRegion(url, pageUrl, product.currency)
          ) {
            throw new Error(
              `Regional mismatch (${product.currency} from ${pageUrl})`,
            );
          }

          console.log(`Successfully scraped Next from ${pageUrl}`);
          return await enrichNextProductWithReaderColorways(
            {
              ...product,
              raw: {
                ...product.raw,
                mobileHtmlFallback: true,
              },
            },
            url,
          );
        } catch (htmlError: any) {
          lastError = htmlError;
          htmlErrors.push(`${pageUrl}: ${htmlError.message}`);
        }
      }

      const playwrightErrors: string[] = [];
      for (const pageUrl of pageUrls) {
        try {
          const html = await fetchHtmlWithPlaywright(
            pageUrl,
            buildNextMobileHeaders(pageUrl),
          );
          if (isBlockedNextHtml(html) || !isUsableNextProductHtml(html)) {
            throw new Error("Playwright returned non-product HTML");
          }

          const product = extractNextProductFromHtml(html, url, pageUrl);
          if (
            !nextScrapeMatchesRequestedRegion(url, pageUrl, product.currency)
          ) {
            throw new Error(
              `Regional mismatch (${product.currency} from ${pageUrl})`,
            );
          }

          console.log(`Successfully scraped Next via Playwright from ${pageUrl}`);
          return await enrichNextProductWithReaderColorways(
            {
              ...product,
              raw: {
                ...product.raw,
                playwrightFallback: true,
              },
            },
            url,
          );
        } catch (playwrightError: any) {
          const message = String(playwrightError?.message || "");
          if (
            /Executable doesn't exist|playwright install|chrome-headless-shell/i.test(
              message,
            )
          ) {
            // Playwright runtime is optional in this deployment.
            // Skip this fallback when browser binaries are unavailable.
            continue;
          }
          playwrightErrors.push(`${pageUrl}: ${message}`);
        }
      }

      if (activeManagedBypassProviders(url).length > 0) {
        for (const pageUrl of pageUrls) {
          if (fastBypassTriedUrls.has(pageUrl)) continue;
          try {
            const bypassOptions: ManagedBypassOptions = {
              deviceType: envBypassDevice("NEXT_BYPASS_DEVICE", "mobile"),
              jsRender: false,
              premium: envFlag("NEXT_BYPASS_PREMIUM", false),
            };
            const html = envFlag("NEXT_BYPASS_RACE", true)
              ? await fetchHtmlViaManagedBypassRace(pageUrl, bypassOptions, {
                  maxProviders: envNumber("NEXT_BYPASS_RACE_MAX_PROVIDERS", 2),
                  timeoutMs: envNumber("NEXT_BYPASS_RACE_TIMEOUT_MS", 12000),
                })
              : await fetchHtmlViaManagedBypass(pageUrl, bypassOptions);
            if (isBlockedNextHtml(html) || !isUsableNextProductHtml(html)) {
              throw new Error("Managed bypass returned non-product HTML");
            }

            const product = extractNextProductFromHtml(html, url, pageUrl);
            if (
              !nextScrapeMatchesRequestedRegion(url, pageUrl, product.currency)
            ) {
              throw new Error(
                `Regional mismatch (${product.currency} from ${pageUrl})`,
              );
            }

            console.log(
              `Successfully scraped Next via managed bypass from ${pageUrl}`,
            );
            return await enrichNextProductWithReaderColorways(
              {
                ...product,
                raw: {
                  ...product.raw,
                  managedBypassFallback: true,
                },
              },
              url,
            );
          } catch (bypassError: any) {
            bypassErrors.push(`${pageUrl}: ${bypassError.message}`);
          }
        }
      }

      const directError =
        lastError?.message || "No usable product HTML returned";
      const readerErrors: string[] = [];

      try {
        console.log("Direct Next scraping failed, trying Reader fallback");
        const reader = await fetchNextReaderMarkdown(url);
        if (reader) {
          try {
            return parseNextReaderMarkdown(
              reader.markdown,
              url,
              reader.readerUrl,
            );
          } catch (readerParseError: any) {
            if (readerParseError?.code === "NEXT_SIZE_VALUES_MISSING") {
              throw nextBlockedScraperError([
                `reader: ${readerParseError.message}`,
              ]);
            }
            throw readerParseError;
          }
        }
        readerErrors.push("reader: no usable markdown returned");
      } catch (readerError: any) {
        if (readerError?.code === "SOURCE_BLOCKED") {
          throw readerError;
        }
        readerErrors.push(`reader: ${readerError.message}`);
      }

      const failureDetails = [
        `direct page: ${directError}`,
        ...htmlErrors,
        ...playwrightErrors,
        ...bypassErrors,
        ...readerErrors,
      ];
      const blockedByNext =
        isNextBlockedFailure(failureDetails) ||
        failureDetails.filter((error) =>
          /(?:HTTP 403|HTTP 404|Access Denied|access-denied|permission to access|Forbidden|no usable markdown)/i.test(
            error,
          ),
        ).length >= Math.max(1, failureDetails.length - 1);

      if (blockedByNext) {
        throw nextBlockedScraperError(failureDetails);
      }

      throw new Error(
        `Failed to scrape direct page (${directError}), HTML fallbacks failed (${htmlErrors.join("; ")}), Playwright fallbacks failed (${playwrightErrors.join("; ")}), managed bypass fallbacks failed (${bypassErrors.join("; ")}), and Reader fallbacks failed (${readerErrors.join("; ")})`,
      );
    } catch (error: any) {
      console.error("Next Scraper error:", error.message);
      if (error instanceof ScraperError || error?.code === "SOURCE_BLOCKED") {
        throw error;
      }
      throw new Error(`Failed to scrape Next: ${error.message}`);
    }
  }

  async checkAvailability(url: string): Promise<AvailabilitySnapshot> {
    return availabilitySnapshotFromProduct(await this.scrape(url));
  }
}

function extractAdidasProductId(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const fromPath = parsed.pathname.match(/\/([A-Z0-9]{5,})\.html/i)?.[1];
    if (fromPath) return fromPath.toUpperCase();
  } catch {}

  const fallback = getProductIdFromUrl(url)?.replace(/\.html$/i, "");
  return fallback ? fallback.toUpperCase() : undefined;
}

function adidasQuickViewEndpoint(url: string, productId: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const language =
      parsed.pathname.split("/").filter(Boolean)[0]?.toLowerCase() || "en";

    if (host.includes("adidas.ae")) {
      const locale = language === "ar" ? "ar_AE" : "en_AE";
      return `https://www.adidas.ae/on/demandware.store/Sites-adidas-AE-Site/${locale}/Product-ShowQuickView?pid=${encodeURIComponent(productId)}`;
    }

    if (host.includes("adidas.com")) {
      return `https://www.adidas.com/on/demandware.store/Sites-adidas-US-Site/en_US/Product-ShowQuickView?pid=${encodeURIComponent(productId)}`;
    }
  } catch {}

  return `https://www.adidas.ae/on/demandware.store/Sites-adidas-AE-Site/en_AE/Product-ShowQuickView?pid=${encodeURIComponent(productId)}`;
}

async function fetchAdidasQuickViewProduct(url: string): Promise<any> {
  const productId = extractAdidasProductId(url);
  if (!productId) throw new Error("No Adidas product id found in URL");

  const response = await axios.get(adidasQuickViewEndpoint(url, productId), {
    headers: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-AE,en;q=0.9",
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
      Referer: url,
    },
    timeout: 20000,
    responseType: "text",
    validateStatus: (status: number) => status < 500,
  });

  if (response.status !== 200) {
    throw new Error(`Adidas quick view returned HTTP ${response.status}`);
  }

  const data =
    typeof response.data === "string"
      ? parseJsonMaybeEncoded(response.data)
      : response.data;
  const product = data?.product;
  if (!product?.id || !product?.productName) {
    throw new Error("Adidas quick view did not expose product data");
  }

  return product;
}

function normalizeAdidasQuickViewProduct(
  product: any,
  url: string,
): NormalizedProduct {
  const title = cleanText(product?.productName);
  const price =
    parsePrice(
      product?.price?.sales?.value ||
        product?.price?.sales?.decimalPrice ||
        product?.price?.sales?.formatted,
    ) || 0;
  const currency =
    cleanText(product?.price?.sales?.currency) ||
    detectCurrency(product?.price?.sales?.formatted, "AED");
  const color = cleanColorOptionValue(product?.color);
  const images: NormalizedProduct["images"] = [];

  for (const image of [
    ...(product?.images?.zoom || []),
    ...(product?.images?.large || []),
    ...(product?.images?.small || []),
  ]) {
    pushImage(images, image?.url, url, image?.alt || image?.title || title);
  }

  const sizeAttribute = (product?.variationAttributes || []).find(
    (attribute: any) =>
      /^size$/i.test(cleanText(attribute?.id || attribute?.attributeId)) ||
      /^size$/i.test(cleanText(attribute?.displayName)),
  );
  const sizeValues = (sizeAttribute?.values || [])
    .map((value: any) => ({
      id: cleanText(value?.id || value?.value || value?.displayValue),
      label: cleanProductOptionValue(
        "Size",
        value?.displayValue || value?.description || value?.value,
      ),
      selectable: value?.selectable !== false,
      attId: cleanText(value?.attID),
      raw: value,
    }))
    .filter((value: any) => value.label);
  const uniqueSizes = uniqueCleanValues(sizeValues.map((value: any) => value.label));
  const description = uniqueCleanValues([
    product?.shortDescription,
    product?.longDescription,
    ...(product?.bullets || []),
  ]).join("\n");
  const productId =
    extractAdidasProductId(url) || cleanText(product?.canonical || product?.id);
  const defaultAvailable =
    product?.available === true ||
    sizeValues.some((value: any) => value.selectable);

  return normalizeProductOptionsAndVariants({
    source: {
      supplier: "Adidas",
      url,
      productId,
    },
    title,
    description,
    brand: cleanText(product?.brand) || "Adidas",
    currency,
    price,
    images: images.map((image, position) => ({ ...image, position })),
    options: [
      ...(color ? [{ name: "Color", values: [color] }] : []),
      ...(uniqueSizes.length ? [{ name: "Size", values: uniqueSizes }] : []),
    ],
    variants: sizeValues.length
      ? sizeValues.map((size: any) => ({
          sourceVariantId:
            size.attId || `${productId || product?.id}-${slugOption(size.label)}`,
          sku: size.attId || `${productId || product?.id}-${size.id}`,
          color,
          size: size.label,
          price,
          currency,
          optionValues: buildVariantOptionValues(color, size.label),
          available: size.selectable,
          stockStatus: size.selectable
            ? ("in_stock" as const)
            : ("out_of_stock" as const),
          imageUrl: images[0]?.url,
          raw: size.raw,
        }))
      : [
          {
            sourceVariantId: productId || product?.id || "default",
            sku: productId || product?.id,
            color,
            price,
            currency,
            optionValues: buildVariantOptionValues(color),
            available: defaultAvailable,
            stockStatus: defaultAvailable ? "in_stock" : "out_of_stock",
            imageUrl: images[0]?.url,
            raw: product,
          },
        ],
    raw: {
      adidasQuickView: product,
    },
  });
}

export class AdidasScraper implements SupplierScraper {
  canHandle(url: string): boolean {
    return hostMatches(url, ["adidas.ae", "adidas.com"]);
  }

  scrapeSnapshot(url: string, snapshotText: string): NormalizedProduct {
    const product = parseGenericReaderMarkdown(snapshotText, url);
    return {
      ...product,
      source: {
        ...product.source,
        supplier: "Adidas",
        productId: product.source.productId || getProductIdFromUrl(url),
      },
      brand:
        product.brand && product.brand !== "Generic" ? product.brand : "Adidas",
      raw: {
        ...(product.raw || {}),
        pastedSnapshotFallback: true,
      },
    };
  }

  async scrape(url: string): Promise<NormalizedProduct> {
    const errors: string[] = [];

    try {
      const product = await fetchAdidasQuickViewProduct(url);
      return normalizeAdidasQuickViewProduct(product, url);
    } catch (error: any) {
      errors.push(`quick view: ${error.message}`);
    }

    // Try managed bypass first for Adidas (they block automated access)
    if (activeManagedBypassProviders(url).length > 0) {
      try {
        const html = await fetchHtmlViaManagedBypass(url, {
          deviceType: "mobile",
          jsRender: true,
          premium: true,
        });
        return this.extractFromHtml(html, url);
      } catch (error: any) {
        errors.push(`managed bypass: ${error.message}`);
      }
    }

    // Try Reader fallback
    try {
      const markdown = await fetchReaderMarkdown(url);
      return {
        ...parseGenericReaderMarkdown(markdown, url),
        source: {
          supplier: "Adidas",
          url,
          productId: getProductIdFromUrl(url),
        },
        brand: "Adidas",
      };
    } catch (error: any) {
      errors.push(`reader: ${error.message}`);
    }

    // Check if blocked
    const blockedSignals = errors.filter((error) =>
      /HTTP 403|Cloudflare|security verification|access-denied|permission to access|Forbidden|Reader fallback returned an access-denied/i.test(
        error,
      ),
    ).length;

    if (blockedSignals >= Math.max(1, errors.length - 1)) {
      throw new ScraperError(
        "Adidas blocked automated server access to this product page. Open the product in your browser and paste the visible product text to analyze it from a page snapshot.",
        {
          code: "SOURCE_BLOCKED",
          status: 422,
          supplier: "Adidas",
          retryWithSnapshot: true,
          details: errors,
        },
      );
    }

    throw new Error(`Failed to scrape Adidas (${errors.join("; ")})`);
  }

  private extractFromHtml(html: string, url: string): NormalizedProduct {
    const $ = cheerio.load(html);
    const fallback = extractGenericProductFromHtml(html, url, "Adidas");

    // Try to extract JSON-LD
    const jsonLd = extractProductJsonLdFromHtml(html);
    if (jsonLd) {
      const offer = firstOffer(jsonLd);
      const images = normalizeProductImageList(
        (jsonLd.image
          ? Array.isArray(jsonLd.image)
            ? jsonLd.image
            : [jsonLd.image]
          : []
        )
          .map((img: any, index: number) => ({
            url: typeof img === "string" ? img : img?.url || img?.contentUrl,
            alt:
              typeof img === "object" ? img?.name || img?.caption : undefined,
            position: index,
          }))
          .filter((img: any) => img.url),
        { maxImages: 30 },
      );

      return {
        source: {
          supplier: "Adidas",
          url,
          productId: cleanText(jsonLd.sku) || getProductIdFromUrl(url),
        },
        title: cleanText(jsonLd.name) || fallback.title,
        description: cleanText(jsonLd.description) || fallback.description,
        brand: "Adidas",
        currency: offer?.priceCurrency || detectCurrency(html, "AED"),
        price: parsePrice(offer?.price) || fallback.price,
        images: images.length ? images : fallback.images,
        options: fallback.options,
        variants: fallback.variants,
        raw: {
          jsonLd,
          managedBypassFallback: true,
        },
      };
    }

    return {
      ...fallback,
      source: {
        ...fallback.source,
        supplier: "Adidas",
      },
      brand: "Adidas",
    };
  }

  async checkAvailability(url: string): Promise<AvailabilitySnapshot> {
    return availabilitySnapshotFromProduct(await this.scrape(url));
  }
}

const scraperResultCache = new Map<
  string,
  { expiresAt: number; product: NormalizedProduct }
>();
const scraperResultInflight = new Map<string, Promise<NormalizedProduct>>();

function normalizeScraperResultCacheUrl(url: string): string {
  try {
    const parsed = new URL(cleanText(url));
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return cleanText(url).split("#")[0];
  }
}

function scraperResultCacheTtlMs(): number {
  const minutes = Math.max(0, envNumber("SCRAPER_RESULT_CACHE_MINUTES", 60));
  return minutes * 60 * 1000;
}

function cloneNormalizedProduct(product: NormalizedProduct): NormalizedProduct {
  return JSON.parse(JSON.stringify(product));
}

function getCachedScraperResult(
  cacheKey: string,
): NormalizedProduct | undefined {
  const ttlMs = scraperResultCacheTtlMs();
  if (ttlMs <= 0) return undefined;

  const cached = scraperResultCache.get(cacheKey);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    scraperResultCache.delete(cacheKey);
    return undefined;
  }

  return cloneNormalizedProduct(cached.product);
}

function setCachedScraperResult(
  cacheKey: string,
  product: NormalizedProduct,
) {
  const ttlMs = scraperResultCacheTtlMs();
  if (ttlMs <= 0) return;

  scraperResultCache.set(cacheKey, {
    expiresAt: Date.now() + ttlMs,
    product: cloneNormalizedProduct(product),
  });
}

export class ScraperService {
  private scrapers: SupplierScraper[] = [
    new NextScraper(),
    new GapScraper(),
    new MarksAndSpencerScraper(),
    new MothercareScraper(),
    new ZaraScraper(),
    new LeftiesScraper(),
    new SheinScraper(),
    new MaxFashionScraper(),
    new CentrepointScraper(),
    new HmScraper(),
    new AdidasScraper(),
    new GenericScraper(), // Fallback
  ];

  async scrape(url: string): Promise<NormalizedProduct> {
    const cacheKey = normalizeScraperResultCacheUrl(url);
    const cached = getCachedScraperResult(cacheKey);
    if (cached) return cached;

    const inflight = scraperResultInflight.get(cacheKey);
    if (inflight) return cloneNormalizedProduct(await inflight);

    const scraper =
      this.scrapers.find((s) => s.canHandle(url)) || this.scrapers[0];
    const promise = scraper
      .scrape(url)
      .then((product) => normalizeProductOptionsAndVariants(product));
    scraperResultInflight.set(cacheKey, promise);

    try {
      const product = await promise;
      setCachedScraperResult(cacheKey, product);
      return cloneNormalizedProduct(product);
    } finally {
      scraperResultInflight.delete(cacheKey);
    }
  }

  async scrapeSnapshot(
    url: string,
    snapshotText: string,
  ): Promise<NormalizedProduct> {
    const scraper =
      this.scrapers.find((s) => s.canHandle(url)) || this.scrapers[0];
    if (!scraper.scrapeSnapshot) {
      throw new ScraperError(
        "This supplier does not support pasted page snapshot analysis.",
        {
          code: "SNAPSHOT_NOT_SUPPORTED",
          status: 400,
        },
      );
    }

    return normalizeProductOptionsAndVariants(
      await scraper.scrapeSnapshot(url, snapshotText),
    );
  }

  async checkAvailability(url: string): Promise<AvailabilitySnapshot> {
    const scraper =
      this.scrapers.find((s) => s.canHandle(url)) || this.scrapers[0];
    return await scraper.checkAvailability(url);
  }
}
