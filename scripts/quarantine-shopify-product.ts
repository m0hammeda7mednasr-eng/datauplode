import "dotenv/config";
import { prisma } from "../src/server/db.js";
import { ShopifyService } from "../src/server/services/shopify.js";

const shopifyId = process.argv[2];
const reason = process.argv.slice(3).join(" ") || "Manual safety quarantine";
if (!/^gid:\/\/shopify\/Product\/\d+$/.test(shopifyId || "")) {
  throw new Error("A Shopify product GID is required");
}

const client = await ShopifyService.getClientFromDb(prisma);
const before = await ShopifyService.getProductBasic(client, shopifyId);
const response: any = await ShopifyService.updateProductStatus(client, shopifyId, "DRAFT");
const errors = response?.productUpdate?.userErrors || [];
if (errors.length) throw new Error(JSON.stringify(errors));
const after = await ShopifyService.getProductBasic(client, shopifyId);
if (String(after?.status || "").toUpperCase() !== "DRAFT") {
  throw new Error("Shopify readback did not confirm DRAFT");
}
const linked = await prisma.shopifyProduct.findUnique({ where: { shopifyId } });
if (linked) {
  await prisma.shopifyProduct.update({
    where: { id: linked.id },
    data: { status: "draft", syncEnabled: false },
  });
  await prisma.auditLog.create({
    data: {
      sourceProductId: linked.sourceProductId,
      action: "SHOPIFY_PRODUCT_SAFETY_QUARANTINE",
      details: JSON.stringify({ shopifyId, reason, beforeStatus: before?.status, afterStatus: after?.status }),
    },
  });
}
console.log(JSON.stringify({ shopifyId, title: before?.title, beforeStatus: before?.status, afterStatus: after?.status, reason }));
await prisma.$disconnect();
