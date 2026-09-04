import { prisma } from "../src/server/db.js";
import { installVerifiedOverrideGuard } from "../src/server/catalog-verified-override-guard.js";

await installVerifiedOverrideGuard();
await prisma.$disconnect();
