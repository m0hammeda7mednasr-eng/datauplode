import { prisma } from "../db.js";

const ACTION = "SCRAPERAPI_CREDIT_RESERVED";

function positiveLimit(name: string) {
  const value = Number(process.env[name] || 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function startOfUtcDay() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfUtcMonth() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function creditsFromDetails(details: string | null) {
  try {
    const value = Number(JSON.parse(details || "{}").credits);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

async function usedSince(createdAt: Date) {
  const rows = await prisma.auditLog.findMany({
    where: { action: ACTION, createdAt: { gte: createdAt } },
    select: { details: true },
    take: 5000,
  });
  return rows.reduce((total, row) => total + creditsFromDetails(row.details), 0);
}

export async function reserveScraperApiCredits(url: string, credits: number) {
  const requested = Math.max(1, Math.floor(credits));
  const dailyLimit = positiveLimit("SCRAPERAPI_DAILY_CREDIT_LIMIT");
  const monthlyLimit = positiveLimit("SCRAPERAPI_MONTHLY_CREDIT_LIMIT");
  if (!dailyLimit && !monthlyLimit) return;

  const [dailyUsed, monthlyUsed] = await Promise.all([
    dailyLimit ? usedSince(startOfUtcDay()) : Promise.resolve(0),
    monthlyLimit ? usedSince(startOfUtcMonth()) : Promise.resolve(0),
  ]);
  if (dailyLimit && dailyUsed + requested > dailyLimit) {
    throw new Error(`ScraperAPI daily credit budget reached (${dailyUsed}/${dailyLimit})`);
  }
  if (monthlyLimit && monthlyUsed + requested > monthlyLimit) {
    throw new Error(`ScraperAPI monthly credit budget reached (${monthlyUsed}/${monthlyLimit})`);
  }

  let hostname = "unknown";
  try { hostname = new URL(url).hostname.toLowerCase(); } catch {}
  await prisma.auditLog.create({
    data: {
      action: ACTION,
      details: JSON.stringify({ credits: requested, hostname, reservedAt: new Date().toISOString() }),
    },
  });
}
