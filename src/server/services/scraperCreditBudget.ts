import { prisma } from "../db.js";

const ACTION = "SCRAPERAPI_CREDIT_RESERVED";
const DEFAULT_MONTHLY_OPERATIONAL_LIMIT = 80_000;
const DEFAULT_BILLING_CYCLE_DAY = 3;
const ADVISORY_LOCK_ID = 739_184_221;

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

function creditsFromDetails(details: string | null) {
  try {
    const parsed = JSON.parse(details || "{}");
    const value = Number(parsed.requestedCredits || parsed.credits);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

async function usedSince(client: any, createdAt: Date) {
  let total = 0;
  let cursor: string | undefined;

  while (true) {
    const rows = await client.auditLog.findMany({
      where: { action: ACTION, createdAt: { gte: createdAt } },
      select: { id: true, details: true },
      orderBy: { id: "asc" },
      take: 1000,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    for (const row of rows) total += creditsFromDetails(row.details);
    if (rows.length < 1000) break;
    cursor = rows[rows.length - 1]?.id;
    if (!cursor) break;
  }

  return total;
}

function defaultDailyLimit(monthlyLimit: number, now = new Date()) {
  if (!monthlyLimit) return 0;
  const { start, end } = billingCycleBounds(now);
  const cycleDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000));
  return Math.ceil(monthlyLimit / cycleDays);
}

export async function reserveScraperApiCredits(url: string, credits: number) {
  const now = new Date();
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

    const [dailyUsed, appCycleUsed] = await Promise.all([
      dailyLimit ? usedSince(tx, dayStart) : Promise.resolve(0),
      monthlyLimit ? usedSince(tx, cycleStart) : Promise.resolve(0),
    ]);
    const cycleUsed = openingCycleUsage + appCycleUsed;

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
  });
}
