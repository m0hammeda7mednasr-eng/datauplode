import { prisma } from "../src/server/db.js";
import { QueueService } from "../src/server/services/queue.js";

const confirmation = "run-linked-price-stock-canary-v1";
if (process.env.PRICE_STOCK_CANARY_CONFIRMATION !== confirmation) {
  throw new Error(`Set PRICE_STOCK_CANARY_CONFIRMATION=${confirmation}`);
}

const url = process.env.PRICE_STOCK_CANARY_URL || "https://www.next.ae/en/style/su769308/g02129";
const product = await prisma.sourceProduct.findUnique({
  where: { url },
  include: { shopifyProduct: true },
});
if (!product?.shopifyProduct) throw new Error("Canary source is not linked to Shopify");

await prisma.$transaction([
  prisma.sourceProduct.update({ where: { id: product.id }, data: { syncStatus: "active" } }),
  prisma.shopifyProduct.update({ where: { id: product.shopifyProduct.id }, data: { syncEnabled: true } }),
]);

const job = await QueueService.addTask("SYNC_PRICE_STOCK", {
  sourceProductId: product.id,
  reason: "verified_link_price_stock_canary",
});
const deadline = Date.now() + 8 * 60 * 1000;
let completed: Awaited<ReturnType<typeof prisma.syncJob.findUnique>> = null;
while (Date.now() < deadline) {
  completed = await prisma.syncJob.findUnique({ where: { id: job.id } });
  if (completed && ["completed", "failed"].includes(completed.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

if (!completed || completed.status !== "completed") {
  await prisma.$transaction([
    prisma.sourceProduct.update({ where: { id: product.id }, data: { syncStatus: "paused" } }),
    prisma.shopifyProduct.update({ where: { id: product.shopifyProduct.id }, data: { syncEnabled: false } }),
  ]);
  throw new Error(`Price/stock canary did not complete: ${completed?.result || completed?.status || "timeout"}`);
}

const result = JSON.parse(completed.result || "{}");
if (result.readbackVerified !== true || result.imagesTouched !== 0 || result.detailsTouched !== 0) {
  await prisma.$transaction([
    prisma.sourceProduct.update({ where: { id: product.id }, data: { syncStatus: "paused" } }),
    prisma.shopifyProduct.update({ where: { id: product.shopifyProduct.id }, data: { syncEnabled: false } }),
  ]);
  throw new Error(`Price/stock canary returned an unsafe result: ${completed.result}`);
}

console.log(JSON.stringify({
  success: true,
  sourceProductId: product.id,
  jobId: job.id,
  readbackVerified: result.readbackVerified,
  priceUpdates: result.priceUpdates,
  inventoryUpdates: result.inventoryUpdates,
  imagesTouched: result.imagesTouched,
  detailsTouched: result.detailsTouched,
}));
await prisma.$disconnect();
