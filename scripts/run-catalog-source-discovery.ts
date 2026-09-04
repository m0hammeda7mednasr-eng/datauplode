import { prisma } from "../src/server/db.js";
import { runCatalogSourceDiscoveryBatch } from "../src/server/services/catalogSourceDiscovery.js";

try {
  const result = await runCatalogSourceDiscoveryBatch();
  console.log(JSON.stringify(result));
} finally {
  await prisma.$disconnect();
}
