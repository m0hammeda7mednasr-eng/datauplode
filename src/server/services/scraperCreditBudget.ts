import { prisma } from "../db.js";

const ACTION = "SCRAPERAPI_CREDIT_RESERVED";
const DEFAULT_MONTHLY_OPERATIONAL_LIMIT = 80_000;
const DEFAULT_BILLING_CYCLE_DAY = 3;
const ADVISORY_LOCK_ID = 739_184_221;
const ACCOUNT_USAGE_CACHE_MS = 15_000;

type ScraperApiAccountUsage = {
  creditsUsed: number;
  creditLimit: number;
  concurrentRequests: number;
  concurrencyLimit: number;
  sampledAt: Date;
};

let accountUsageCache: ScraperApiAccountUsage | null = null;
let accountUsagePromise: Promise<ScraperApiAccountUsage | null> | null = null;

function positiveLimit(name: string, fallback = 0) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function billingCycleDay() {
  const value = positiveLimit("SCRAPERAPI_BILLING_CYCLE_DAY", DEFAULT_BILLING_CYCLE_DAY);
  return Math.min(28, Math.max(1, value || DEFAULT_BILLING_CYCLE_DAY));
}

function billingCycleBounds(now = new Date()) {
  const day = billingCycleDay();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const currentStart = new Date(Date.UTC(year, month, day));
  const start = now >= currentStart
    ? currentStart
    : new Date(Date.UTC(year, month - 1, day));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, day));
  return { start, end };
}

function startOfUtcDay(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function configuredKeys() {
  const pooled = String(process.env.SCRAPERAPI_KEYS || "").split(/[\s,;]+/);
  const legacy = String(process.env.SCRAPERAPI_KEY || "");
  return [...new Set([...pooled, legacy].map((value) => value.trim()).filter(Boolean))];
}

export async function getScraperApiAccountUsage() {
  if (accountUsageCache && Date.now() - accountUsageCache.sampledAt.getTime() < ACCOUNT_USAGE_CACHE_MS) {
    return accountUsageCache;
  }
  if (accountUsagePromise) return accountUsagePromise;

  accountUsagePromise = (async () => {
    const keys = configuredKeys();
    if (!keys.length) return null;
    const accounts = await Promise.all(keys.map(async (apiKey) => {
      const response = await fetch(`https://api.scraperapi.com/account?api_key=${encodeURIComponent(apiKey)}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`ScraperAPI account HTTP ${response.status}`);
      return await response.json() as Record<string, unknown>;
    }));
    accountUsageCache = {
      creditsUsed: accounts.reduce((sum, account) => sum + Math.max(0, Number(account.requestCount || 0)), 0),
      creditLimit: accounts.reduce((sum, account) => sum + Math.max(0, Number(account.requestLimit || 0)), 0),
      concurrentRequests: accounts.reduce((sum, account) => sum + Math.max(0, Number(account.concurrentRequests || 0)), 0),
      concurrencyLimit: accounts.reduce((sum, account) => sum + Math.max(0, Number(account.concurrencyLimit || 0)), 0),
      sampledAt: new Date(),
    };
    return accountUsageCache;
  })().catch(() => accountUsageCache).finally(() => { accountUsagePromise = null; });
  return accountUsagePromise;
}

async function usedSince(client: any, createdAt: Date) {
  const rows = await client.$queryRawUnsafe(`
    SELECT COALESCE(SUM(
      CASE
        WHEN ("details"::jsonb ->> 'accountingVersion') = '2'
          THEN GREATEST(0, COALESCE(
            NULLIF("details"::jsonb ->> 'requestedCredits', '')::numeric,
            NULLIF("details"::jsonb ->> 'credits', '')::numeric,
            0
          ))
        ELSE 0
      END
    ), 0)::text AS "total"
    FROM "AuditLog"
    WHERE "action" = $1 AND "createdAt" >= $2
  `, ACTION, createdAt) as Array<{ total: string }>;
  const total = Number(rows[0]?.total || 0);
  return Number.isFinite(total) && total > 0 ? total : 0;
}

function defaultDailyLimit(monthlyLimit: number, now = new Date()) {
  if (!monthlyLimit) return 0;
  const { start, end } = billingCycleBounds(now);
  const cycleDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000));
  return Math.ceil(monthlyLimit / cycleDays);
}

export async function reserveScraperApiCredits(url: string, credits: number) {
  const now = new Date();
  const providerUsage = await getScraperApiAccountUsage();
  const monthlyLimit = positiveLimit(
    "SCRAPERAPI_MONTHLY_CREDIT_LIMIT",
    DEFAULT_MONTHLY_OPERATIONAL_LIMIT,
  );
  const dailyLimit = positiveLimit(
    "SCRAPERAPI_DAILY_CREDIT_LIMIT",
    defaultDailyLimit(monthlyLimit, now),
  );
  const openingCycleUsage = positiveLimit("SCRAPERAPI_CYCLE_OPENING_USED_CREDITS", 0);
  const requested = Math.max(1, Math.floor(credits));
  const accounted = requested;
  const { start: cycleStart, end: cycleEnd } = billingCycleBounds(now);
  const dayStart = startOfUtcDay(now);

  let hostname = "unknown";
  try { hostname = new URL(url).hostname.toLowerCase(); } catch {}

  await prisma.$transaction(async (tx) => {
    // Serialize reservations across concurrent workers so 20 simultaneous
    // threads cannot all pass the same budget check and overshoot the reserve.
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_ID})`);

    const [dailyUsed, appCycleUsed, reservationsSinceProviderSample] = await Promise.all([
      dailyLimit ? usedSince(tx, dayStart) : Promise.resolve(0),
      monthlyLimit ? usedSince(tx, cycleStart) : Promise.resolve(0),
      providerUsage ? usedSince(tx, providerUsage.sampledAt) : Promise.resolve(0),
    ]);
    const cycleUsed = providerUsage
      ? providerUsage.creditsUsed + reservationsSinceProviderSample
      : openingCycleUsage + appCycleUsed;

    if (dailyLimit && dailyUsed + accounted > dailyLimit) {
      throw new Error(
        `ScraperAPI daily operational budget reached (${dailyUsed}/${dailyLimit}; next=${accounted})`,
      );
    }
    if (monthlyLimit && cycleUsed + accounted > monthlyLimit) {
      throw new Error(
        `ScraperAPI billing-cycle operational budget reached (${cycleUsed}/${monthlyLimit}; next=${accounted})`,
      );
    }

    await tx.auditLog.create({
      data: {
        action: ACTION,
        details: JSON.stringify({
          credits: accounted,
          requestedCredits: requested,
          accountingVersion: 2,
          hostname,
          billingCycleStart: cycleStart.toISOString(),
          billingCycleEnd: cycleEnd.toISOString(),
          openingCycleUsage,
          reservedAt: now.toISOString(),
        }),
      },
    });
  }, { maxWait: 10_000, timeout: 30_000 });
}
