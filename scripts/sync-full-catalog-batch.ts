import { appendFile } from "node:fs/promises";
import { prisma } from "../src/server/db.js";
import { syncFullProductCatalog } from "../src/server/services/fullCatalogSync.js";
import { ShopifyService } from "../src/server/services/shopify.js";

const confirmation = "2026-09-01-full-catalog-batch-v1";
if (process.env.CONFIRM_FULL_CATALOG_BATCH !== confirmation) {
  throw new Error("Exact full-catalog batch confirmation is required");
}

const requestedLimit = Number(process.env.FULL_CATALOG_BATCH_LIMIT || 5);
if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 5) {
  throw new Error("FULL_CATALOG_BATCH_LIMIT must be an integer from 1 to 5");
}
const checkpointPath = process.env.FULL_CATALOG_CHECKPOINT || "C:/tmp/full-catalog-sync.jsonl";

const candidates = await prisma.sourceProduct.findMany({
  where: {
    url: { contains: "centrepointstores.com", mode: "insensitive" },
    shopifyProduct: { is: { syncEnabled: true } },
    raw: { contains: "sheetPriceMultiplier" },
    createdAt: { lt: new Date("2026-09-01T00:00:00.000Z") },
  },
  orderBy: { updatedAt: "asc" },
  take: requestedLimit,
  select: { id: true, title: true, url: true },
});

const client = await ShopifyService.getClientFromDb(prisma);
const location = await ShopifyService.getInventoryLocation(client);
let completed = 0;
let failed = 0;

for (const [index, candidate] of candidates.entries()) {
  try {
    const result = await syncFullProductCatalog({
      prisma,
      sourceProductId: candidate.id,
      client,
      location,
    });
    completed += 1;
    const row = { at: new Date().toISOString(), index: index + 1, outcome: "verified", ...result };
    await appendFile(checkpointPath, `${JSON.stringify(row)}\n`, "utf8");
    console.log(JSON.stringify(row));
  } catch (error: any) {
    failed += 1;
    const row = {
      at: new Date().toISOString(),
      index: index + 1,
      outcome: "failed",
      sourceProductId: candidate.id,
      title: candidate.title,
      url: candidate.url,
      error: String(error?.message || error),
    };
    await appendFile(checkpointPath, `${JSON.stringify(row)}\n`, "utf8");
    console.error(JSON.stringify(row));
    break;
  }
}

console.log(JSON.stringify({
  success: failed === 0 && completed === candidates.length,
  selected: candidates.length,
  completed,
  failed,
  checkpointPath,
}));
await prisma.$disconnect();
if (failed > 0) process.exitCode = 1;
