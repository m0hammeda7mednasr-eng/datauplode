import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/server/db.js";
import { ShopifyService } from "../src/server/services/shopify.js";

const CONFIRMATION = "DRAFT_ACTIVE_UNLINKED_UNDER_2000";
const confirmed = process.env.CONFIRM_DRAFT_UNLINKED_CATALOG === CONFIRMATION
  || process.argv.includes(`--confirm=${CONFIRMATION}`);
const maxCandidates = Math.max(1, Number(process.env.CATALOG_DRAFT_MAX || 2000));
const batchSize = Math.max(1, Math.min(15, Number(process.env.CATALOG_DRAFT_BATCH_SIZE || 10)));
const reportsDir = path.resolve("reports");

type Candidate = {
  shopifyId: string;
  title: string;
  status: string;
  matchStatus: string;
  matchMethod: string | null;
  reason: string | null;
};

function clean(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseResult(value: unknown) {
  if (!value || typeof value !== "object") return {} as Record<string, any>;
  return value as Record<string, any>;
}

async function requestWithBackoff(client: any, query: string, variables: Record<string, any>) {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      return await client.request(query, variables);
    } catch (error: any) {
      const message = clean(error?.message || error);
      if (!/throttled|429|502|503|504|timeout|ECONNRESET|socket hang up/i.test(message) || attempt === 8) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(20_000, 750 * (2 ** attempt))));
    }
  }
  throw new Error("Shopify request retries exhausted");
}

async function draftBatch(client: any, batch: Candidate[]) {
  const declarations = batch.map((_, index) => `$id${index}: ID!`).join(", ");
  const operations = batch.map((_, index) => `
    p${index}: productUpdate(product: { id: $id${index}, status: DRAFT }) {
      product { id status }
      userErrors { field message }
    }
  `).join("\n");
  const variables = Object.fromEntries(batch.map((candidate, index) => [`id${index}`, candidate.shopifyId]));
  const mutationResult = parseResult(await requestWithBackoff(client, `mutation DraftUnlinkedProducts(${declarations}) { ${operations} }`, variables));
  const accepted = batch.filter((candidate, index) => {
    const result = mutationResult[`p${index}`];
    return result?.product?.id === candidate.shopifyId
      && String(result?.product?.status || "").toUpperCase() === "DRAFT"
      && (!Array.isArray(result?.userErrors) || result.userErrors.length === 0);
  });
  if (accepted.length === 0) return { verified: [] as Candidate[], failed: batch };

  const readback: any = await requestWithBackoff(client, `
    query VerifyDraftProducts($ids: [ID!]!) {
      nodes(ids: $ids) { ... on Product { id status } }
    }
  `, { ids: accepted.map((candidate) => candidate.shopifyId) });
  const verifiedIds = new Set((readback?.nodes || [])
    .filter((node: any) => String(node?.status || "").toUpperCase() === "DRAFT")
    .map((node: any) => clean(node.id)));
  return {
    verified: accepted.filter((candidate) => verifiedIds.has(candidate.shopifyId)),
    failed: batch.filter((candidate) => !verifiedIds.has(candidate.shopifyId)),
  };
}

async function main() {
  const candidates = await prisma.$queryRawUnsafe<Candidate[]>(`
    SELECT "shopifyId", "title", "status", "matchStatus", "matchMethod", "reason"
    FROM "ShopifyCatalogIndexV2"
    WHERE UPPER(COALESCE("status", '')) = 'ACTIVE'
      AND "matchStatus" IN ('needs_link', 'needs_review')
    ORDER BY "matchStatus" ASC, "shopifyId" ASC
  `);
  if (candidates.length > maxCandidates) {
    throw new Error(`Safety stop: ${candidates.length} candidates exceeds maximum ${maxCandidates}.`);
  }

  fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportsDir, `draft-unlinked-shopify-${stamp}.json`);
  const report: any = {
    generatedAt: new Date().toISOString(),
    confirmationRequired: CONFIRMATION,
    dryRun: !confirmed,
    candidateCount: candidates.length,
    maxCandidates,
    candidates,
    verifiedDraft: [],
    failed: [],
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Candidates: ${candidates.length}; snapshot: ${reportPath}`);
  if (!confirmed || candidates.length === 0) {
    console.log(confirmed ? "No active unlinked products remain." : `Dry run only. Set CONFIRM_DRAFT_UNLINKED_CATALOG=${CONFIRMATION} to execute.`);
    return;
  }

  const client = await ShopifyService.getClientFromDb(prisma);
  for (let offset = 0; offset < candidates.length; offset += batchSize) {
    const batch = candidates.slice(offset, offset + batchSize);
    const result = await draftBatch(client, batch);
    report.verifiedDraft.push(...result.verified);
    report.failed.push(...result.failed);
    if (result.verified.length > 0) {
      const ids = result.verified.map((candidate) => candidate.shopifyId);
      await prisma.$executeRawUnsafe(`
        UPDATE "ShopifyCatalogIndexV2"
        SET "status"='DRAFT', "updatedAt"=NOW()
        WHERE "shopifyId" = ANY($1::text[])
      `, ids);
    }
    report.updatedAt = new Date().toISOString();
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`Verified ${report.verifiedDraft.length}/${candidates.length}; failed ${report.failed.length}`);
  }

  await prisma.auditLog.create({
    data: {
      action: "DRAFT_UNLINKED_ACTIVE_SHOPIFY_CATALOG",
      details: JSON.stringify({
        candidateCount: candidates.length,
        verifiedDraft: report.verifiedDraft.length,
        failed: report.failed.length,
        reportFile: path.basename(reportPath),
        readbackVerified: report.failed.length === 0,
      }),
      userId: "System",
    },
  });
  console.log(`Complete: ${report.verifiedDraft.length} verified DRAFT; ${report.failed.length} failed.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
