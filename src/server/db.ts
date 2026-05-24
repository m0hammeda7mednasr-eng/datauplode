import "dotenv/config";
import { PrismaClient } from '@prisma/client';
import { isProduction } from './config/env.js';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function normalizeDatabaseUrlForRuntime() {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl || !/^postgres(?:ql)?:\/\//i.test(rawUrl)) return;

  try {
    const url = new URL(rawUrl);
    const limit = process.env.PRISMA_CONNECTION_LIMIT || (isProduction() ? "2" : "3");
    if (!url.searchParams.has("connection_limit")) {
      url.searchParams.set("connection_limit", limit);
    }

    if (/pooler\.supabase\.com$/i.test(url.hostname)) {
      if (!url.searchParams.has("pgbouncer")) {
        url.searchParams.set("pgbouncer", "true");
      }
      if (url.port === "5432" || !url.port) {
        url.port = "6543";
      }
    }

    process.env.DATABASE_URL = url.toString();
  } catch {
    // Runtime env validation will report malformed DATABASE_URL values.
  }
}

normalizeDatabaseUrlForRuntime();

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isProduction() ? ['error'] : ['query', 'error', 'warn'],
  });

if (!isProduction()) globalForPrisma.prisma = prisma;
