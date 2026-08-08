import "dotenv/config";
import { PrismaClient } from '@prisma/client';
import { isProduction } from './config/env.js';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * Keep runtime DATABASE_URL aligned with the exact production database target
 * that passed the Railway pre-deploy checks.
 *
 * In particular, do not rewrite a Supabase Session Pooler URL (5432) to the
 * Transaction Pooler (6543). Doing so makes pre-deploy/schema checks run
 * against one connection mode while the application runs against another.
 */
function normalizeDatabaseUrlForRuntime() {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl || !/^postgres(?:ql)?:\/\//i.test(rawUrl)) return;

  try {
    const url = new URL(rawUrl);
    const limit = process.env.PRISMA_CONNECTION_LIMIT || (isProduction() ? "2" : "3");

    if (!url.searchParams.has("connection_limit")) {
      url.searchParams.set("connection_limit", limit);
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
