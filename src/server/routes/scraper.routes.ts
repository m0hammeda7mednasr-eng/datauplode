import { Router } from "express";
import { prisma } from "../db.js";
import { productExtractionEngine } from "../scraper/services/ScraperService.js";
import { CategoryDiscoveryService } from "../scraper/services/CategoryDiscoveryService.js";
import type { SourceInput } from "../scraper/types/source.js";

const router = Router();
const discovery = new CategoryDiscoveryService();

function inputFromBody(body: any): SourceInput {
  return {
    url: String(body.url || "").trim(),
    sourceType: body.sourceType || "product_url",
    mode: body.mode || "auto",
    allowedDomains: Array.isArray(body.allowedDomains) ? body.allowedDomains : undefined,
    customSelectors: body.customSelectors || undefined,
    rateLimit: body.rateLimit || undefined,
  };
}

async function persistProducts(products: any[], sourceInput: SourceInput) {
  const saved = [];
  for (const product of products) {
    const source = await prisma.source.upsert({
      where: { domain: product.source.domain },
      update: {
        status: "READY",
        mode: sourceInput.mode || "auto",
        customSelectorsJson: sourceInput.customSelectors ? JSON.stringify(sourceInput.customSelectors) : undefined,
        updatedAt: new Date(),
      },
      create: {
        name: product.source.domain,
        baseUrl: new URL(product.source.url).origin,
        domain: product.source.domain,
        type: sourceInput.sourceType,
        mode: sourceInput.mode || "auto",
        status: "READY",
        rateLimitJson: sourceInput.rateLimit ? JSON.stringify(sourceInput.rateLimit) : null,
        customSelectorsJson: sourceInput.customSelectors ? JSON.stringify(sourceInput.customSelectors) : null,
      },
    });
    const status = product.warnings.some((warning: any) => ["MISSING_TITLE", "MISSING_PRICE", "MISSING_IMAGES", "LOW_CONFIDENCE"].includes(warning.code))
      ? "NEEDS_REVIEW"
      : "READY";
    const savedProduct = await prisma.extractedProduct.upsert({
      where: { sourceUrl: product.source.url },
      update: {
        sourceId: source.id,
        canonicalUrl: product.source.canonicalUrl,
        title: product.identity.title,
        normalizedJson: JSON.stringify(product),
        rawJson: JSON.stringify(product.raw || {}),
        confidence: product.confidence.overall,
        status,
      },
      create: {
        sourceId: source.id,
        sourceUrl: product.source.url,
        canonicalUrl: product.source.canonicalUrl,
        title: product.identity.title,
        normalizedJson: JSON.stringify(product),
        rawJson: JSON.stringify(product.raw || {}),
        confidence: product.confidence.overall,
        status,
      },
    });
    await prisma.productWarning.deleteMany({ where: { extractedProductId: savedProduct.id } });
    if (product.warnings.length) {
      await prisma.productWarning.createMany({
        data: product.warnings.map((warning: any) => ({
          extractedProductId: savedProduct.id,
          code: warning.code,
          message: warning.message,
          field: warning.field,
        })),
      });
    }
    saved.push(savedProduct);
  }
  return saved;
}

router.post("/scraper/test", async (req, res) => {
  const input = inputFromBody(req.body);
  const result = await productExtractionEngine.test(input);
  res.json(result);
});

router.post("/scraper/extract", async (req, res) => {
  const input = inputFromBody(req.body);
  const job = await prisma.crawlJob.create({
    data: { type: "EXTRACT_PRODUCT", status: "running", sourceUrl: input.url, startedAt: new Date(), payloadJson: JSON.stringify(input) },
  });
  try {
    const result = await productExtractionEngine.extract(input);
    const saved = await persistProducts(result.products, input);
    await prisma.crawlJob.update({
      where: { id: job.id },
      data: {
        status: "completed",
        progress: 100,
        finishedAt: new Date(),
        resultJson: JSON.stringify({ ...result, productIds: saved.map((product) => product.id) }),
      },
    });
    res.json({ jobId: job.id, ...result, productIds: saved.map((product) => product.id) });
  } catch (error: any) {
    await prisma.crawlJob.update({
      where: { id: job.id },
      data: { status: "failed", finishedAt: new Date(), errorsJson: JSON.stringify([{ message: error.message, code: error.code }]) },
    });
    res.status(error.status || 422).json({ error: error.message, code: error.code, jobId: job.id });
  }
});

router.post("/scraper/category", async (req, res) => {
  const result = await discovery.discover({
    startUrl: String(req.body.startUrl || req.body.url),
    maxPages: Number(req.body.maxPages || 5),
    maxProducts: Number(req.body.maxProducts || 50),
    includePatterns: req.body.includePatterns,
    excludePatterns: req.body.excludePatterns,
    mode: req.body.mode || "auto",
  });
  res.json(result);
});

router.get("/scraper/jobs/:id", async (req, res) => {
  const job = await prisma.crawlJob.findUnique({ where: { id: req.params.id } });
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

router.get("/extracted-products", async (_req, res) => {
  const products = await prisma.extractedProduct.findMany({
    include: { warnings: true, source: true },
    orderBy: { updatedAt: "desc" },
  });
  res.json(products);
});

router.get("/extracted-products/:id", async (req, res) => {
  const product = await prisma.extractedProduct.findUnique({
    where: { id: req.params.id },
    include: { warnings: true, source: true },
  });
  if (!product) return res.status(404).json({ error: "Product not found" });
  res.json(product);
});

router.patch("/extracted-products/:id", async (req, res) => {
  const product = await prisma.extractedProduct.update({
    where: { id: req.params.id },
    data: {
      status: req.body.status,
      normalizedJson: req.body.normalizedJson ? JSON.stringify(req.body.normalizedJson) : undefined,
      title: req.body.normalizedJson?.identity?.title,
    },
  });
  res.json(product);
});

router.get("/sources", async (_req, res) => {
  const sources = await prisma.source.findMany({ orderBy: { updatedAt: "desc" } });
  res.json(sources);
});

router.post("/sources/:id/test", async (req, res) => {
  const source = await prisma.source.findUnique({ where: { id: req.params.id } });
  if (!source) return res.status(404).json({ error: "Source not found" });
  const result = await productExtractionEngine.test({
    url: source.baseUrl,
    sourceType: source.type as any,
    mode: source.mode as any,
  });
  await prisma.source.update({ where: { id: source.id }, data: { status: result.status } });
  res.json(result);
});

router.patch("/sources/:id", async (req, res) => {
  const source = await prisma.source.update({ where: { id: req.params.id }, data: { status: req.body.status } });
  res.json(source);
});

export default router;
