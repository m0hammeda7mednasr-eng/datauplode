import { PrismaClient } from '@prisma/client';
import { isProduction } from './config/env.js';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isProduction() ? ['error'] : ['query', 'error', 'warn'],
  });

if (!isProduction()) globalForPrisma.prisma = prisma;
