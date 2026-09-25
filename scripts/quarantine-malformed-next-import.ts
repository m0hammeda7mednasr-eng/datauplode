import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/server/db.js";
import { ShopifyService } from "../src/server/services/shopify.js";

const startedAt = new Date("2026-09-25T12:00:00Z");
const malformedTitle = /<script|personalisation|metadata|attention required/i;

async function main() {
  const products = await prisma.sourceProduct.findMany({
    where: {
      createdAt: { gte: startedAt },
      url: { contains: "next.ae" },
      shopifyProduct: { isNot: null },
    },
    select: {
      id: true,
      url: true,
      title: true,
      shopifyProduct: { select: { id: true, shopifyId: true, status: true } },
    },
  });
  const candidates = products.filter((product) => malformedTitle.test(product.title));
  const client = await ShopifyService.getClientFromDb(prisma);
  const report = { startedAt: new Date().toISOString(), candidates: candidates.length, drafted: [] as any[], failed: [] as any[] };

  for (let offset = 0; offset < candidates.length; offset += 8) {
    const batch = candidates.slice(offset, offset + 8);
    await Promise.all(batch.map(async (product) => {
      const shopify = product.shopifyProduct!;
      try {
        const response: any = await ShopifyService.updateProductStatus(client, shopify.shopifyId, "DRAFT");
        const result = response?.productUpdate;
        if (result?.userErrors?.length || result?.product?.status !== "DRAFT") {
          throw new Error(JSON.stringify(result?.userErrors || response));
        }
        const live = await ShopifyService.getProductBasic(client, shopify.shopifyId);
        if (String(live?.status || "").toUpperCase() !== "DRAFT") {
          throw new Error("Shopify readback did not confirm DRAFT");
        }
        await prisma.shopifyProduct.update({ where: { id: shopify.id }, data: { status: "draft", syncEnabled: false } });
        report.drafted.push({ sourceProductId: product.id, shopifyId: shopify.shopifyId, url: product.url });
      } catch (error: any) {
        report.failed.push({ sourceProductId: product.id, shopifyId: shopify.shopifyId, url: product.url, error: String(error?.message || error) });
      }
    }));
    console.log(`Quarantined ${report.drafted.length}/${candidates.length}; failed ${report.failed.length}`);
  }

  report["completedAt" as keyof typeof report] = new Date().toISOString() as never;
  fs.mkdirSync("reports", { recursive: true });
  const reportPath = path.join("reports", `quarantine-malformed-next-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ reportPath, candidates: candidates.length, drafted: report.drafted.length, failed: report.failed.length }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
