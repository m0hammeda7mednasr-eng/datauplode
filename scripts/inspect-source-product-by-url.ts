import "dotenv/config";
import { prisma } from "../src/server/db.js";

const url = process.argv[2];
if (!url) throw new Error("URL argument is required");

const product = await prisma.sourceProduct.findFirst({
  where: { OR: [{ url }, { url: { contains: new URL(url).pathname } }] },
  include: {
    variants: true,
    shopifyProduct: { include: { variants: true } },
    auditLogs: { orderBy: { createdAt: "desc" }, take: 10 },
  },
});
console.log(JSON.stringify(product, null, 2));
await prisma.$disconnect();
