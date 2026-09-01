import { prisma } from "../src/server/db.js";
import { syncFullProductCatalog } from "../src/server/services/fullCatalogSync.js";

const sourceProductId = "cmsno039f03i3nq108no5p9yw";
const confirmation = "2026-09-01-product-set-canary-v1";
if (process.env.CONFIRM_FULL_CATALOG_CANARY !== confirmation) {
  throw new Error("Exact full-catalog canary confirmation is required");
}

const result = await syncFullProductCatalog({ prisma, sourceProductId });
console.log(JSON.stringify(result, null, 2));
await prisma.$disconnect();
