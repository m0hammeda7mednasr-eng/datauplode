import type { NextFunction, Request, Response } from "express";
import axios from "axios";
import crypto from "crypto";
import { prisma } from "../db.js";
import { runWithCatalogCanaryMutationGuard } from "../services/catalogCanaryMutationGuard.js";

function enabled(value: unknown) {
  return String(value ?? "").trim().toLowerCase() === "true";
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function spreadsheetId(value: unknown) {
  const match = clean(value).match(/\/spreadsheets\/d\/([^/?#]+)/i);
  return match?.[1] || "";
}

function canonicalSourceUrl(value: unknown) {
  const input = clean(value).replace(/[\t\r\n]+/g, "");
  try {
    const parsed = new URL(input);
    parsed.hash = "";
    parsed.search = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return input;
  }
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"') {
      if (quoted && next === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }

  row.push(cell);
  if (row.length > 1 || row.some((value) => clean(value))) rows.push(row);
  return rows;
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function canaryDryRunMaxAgeMinutes() {
  const configured = Number(process.env.CATALOG_AUDIT_CANARY_DRY_RUN_MAX_AGE_MINUTES || 30);
  if (!Number.isFinite(configured)) return 30;
  return Math.min(120, Math.max(1, Math.floor(configured)));
}

async function verifyCurrentCanarySource(
  configuredSheetId: string,
  verifiedResult: any,
  expectedShopifyProductId: string,
) {
  const expectedSheetId = Number(verifiedResult?.sheetId);
  const expectedRowNumber = Number(verifiedResult?.rowNumber);
  const expectedSourceUrl = canonicalSourceUrl(verifiedResult?.url);
  if (
    !Number.isSafeInteger(expectedSheetId) ||
    expectedSheetId < 0 ||
    !Number.isSafeInteger(expectedRowNumber) ||
    expectedRowNumber < 1 ||
    !expectedSourceUrl
  ) {
    return { ok: false as const, code: "CATALOG_AUDIT_CANARY_DRY_RUN_IDENTITY_INVALID" };
  }

  const exportUrl = `https://docs.google.com/spreadsheets/d/${configuredSheetId}/export?format=csv&gid=${expectedSheetId}`;
  let csv = "";
  try {
    const response = await axios.get(exportUrl, {
      timeout: Number(process.env.GOOGLE_SHEET_FETCH_TIMEOUT_MS || 30000),
      responseType: "text",
    });
    csv = String(response.data || "");
  } catch {
    return { ok: false as const, code: "CATALOG_AUDIT_CANARY_SOURCE_REVALIDATION_UNAVAILABLE" };
  }

  const currentRow = parseCsv(csv)[expectedRowNumber - 1] || [];
  const rowStillMatches = currentRow.some(
    (cell) => canonicalSourceUrl(cell) === expectedSourceUrl,
  );
  if (!rowStillMatches) {
    return { ok: false as const, code: "CATALOG_AUDIT_CANARY_SOURCE_CHANGED" };
  }

  const sourceProducts = await prisma.sourceProduct.findMany({
    where: {
      shopifyProduct: { isNot: null },
      OR: [
        { url: { equals: clean(verifiedResult?.url), mode: "insensitive" } },
        { url: { equals: expectedSourceUrl, mode: "insensitive" } },
      ],
    } as any,
    include: { shopifyProduct: true },
    take: 10,
  });
  const exactMappings = sourceProducts.filter(
    (product) => canonicalSourceUrl(product.url) === expectedSourceUrl,
  );
  if (exactMappings.length !== 1) {
    return { ok: false as const, code: "CATALOG_AUDIT_CANARY_PRODUCT_MAPPING_NOT_UNIQUE" };
  }

  const currentShopifyProductId = clean(exactMappings[0]?.shopifyProduct?.shopifyId);
  if (!currentShopifyProductId || currentShopifyProductId !== expectedShopifyProductId) {
    return { ok: false as const, code: "CATALOG_AUDIT_CANARY_PRODUCT_IDENTITY_CHANGED" };
  }

  return {
    ok: true as const,
    expectedSourceUrl,
    expectedSheetId,
    expectedRowNumber,
    expectedShopifyProductId,
  };
}

async function verifyCanaryDryRunBatch(req: Request, res: Response, configuredSheetId: string) {
  const dryRunBatchId = clean(
    req.header("x-catalog-audit-dry-run-batch-id") || req.body?.dryRunBatchId,
  );
  if (!dryRunBatchId) {
    res.status(428).json({
      success: false,
      code: "CATALOG_AUDIT_CANARY_DRY_RUN_REQUIRED",
      error: "Shopify canary requires the batch ID from a successful production dry run.",
    });
    return false;
  }

  const batch = await prisma.importBatch.findUnique({ where: { id: dryRunBatchId } });
  if (!batch || batch.target !== "catalog_audit" || batch.status !== "COMPLETED") {
    res.status(412).json({
      success: false,
      code: "CATALOG_AUDIT_CANARY_DRY_RUN_INVALID",
      error: "The supplied dry-run batch is missing, incomplete, or not a catalog audit.",
    });
    return false;
  }

  const maxAgeMinutes = canaryDryRunMaxAgeMinutes();
  const ageMs = Date.now() - new Date(batch.createdAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > maxAgeMinutes * 60_000) {
    res.status(412).json({
      success: false,
      code: "CATALOG_AUDIT_CANARY_DRY_RUN_EXPIRED",
      error: `The production dry run must be no older than ${maxAgeMinutes} minutes before canary.`,
    });
    return false;
  }

  let payload: any = {};
  try {
    payload = JSON.parse(batch.payloadJson || "{}");
  } catch {
    payload = {};
  }

  const summary = payload?.summary || {};
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const verifiedResults = results.filter(
    (entry: any) => entry?.status === "verified" && clean(entry?.shopifyProductId),
  );
  const verifiedProducts = new Set(
    verifiedResults.map((entry: any) => clean(entry.shopifyProductId)),
  );
  const batchSheetId = spreadsheetId(payload?.spreadsheetUrl);
  const valid =
    summary.dryRun === true &&
    summary.writeSheet === false &&
    Number(summary.uniqueProductsProcessed) === 1 &&
    Number(summary.verified) === 1 &&
    Number(summary.missing) === 0 &&
    Number(summary.ambiguous) === 0 &&
    Number(summary.errors) === 0 &&
    verifiedResults.length === 1 &&
    verifiedProducts.size === 1 &&
    batchSheetId === configuredSheetId;

  if (!valid) {
    res.status(412).json({
      success: false,
      code: "CATALOG_AUDIT_CANARY_DRY_RUN_NOT_CANARY_READY",
      error: "The supplied dry-run batch did not prove one verified existing product on the configured production sheet.",
    });
    return false;
  }

  const verifiedResult = verifiedResults[0];
  const expectedShopifyProductId = clean(verifiedResult.shopifyProductId);
  const identity = await verifyCurrentCanarySource(
    configuredSheetId,
    verifiedResult,
    expectedShopifyProductId,
  );
  if (!identity.ok) {
    const unavailable = identity.code === "CATALOG_AUDIT_CANARY_SOURCE_REVALIDATION_UNAVAILABLE";
    res.status(unavailable ? 503 : 412).json({
      success: false,
      code: identity.code,
      error: unavailable
        ? "Canary source revalidation is unavailable; no Shopify write was attempted."
        : "The current production source no longer proves the exact dry-run product identity; no Shopify write was attempted.",
    });
    return false;
  }

  req.body = {
    ...req.body,
    dryRunBatchId,
    canaryExpectedShopifyProductId: identity.expectedShopifyProductId,
  };
  res.setHeader("X-Catalog-Audit-Dry-Run-Batch", dryRunBatchId);
  res.setHeader("X-Catalog-Audit-Canary-Product", identity.expectedShopifyProductId);
  res.setHeader("X-Catalog-Audit-Canary-Source-Row", String(identity.expectedRowNumber));
  return true;
}

export async function catalogAuditSafety(req: Request, res: Response, next: NextFunction) {
  if (req.method !== "POST" || req.path !== "/catalog-audit/run") {
    return next();
  }

  const production = clean(process.env.NODE_ENV).toLowerCase() === "production";
  let configuredSheetId = "";
  if (production) {
    const configuredSheetUrl = clean(process.env.CATALOG_AUDIT_SHEET_URL);
    configuredSheetId = spreadsheetId(configuredSheetUrl);
    if (!configuredSheetId) {
      return res.status(503).json({
        success: false,
        code: "CATALOG_AUDIT_PRODUCTION_SHEET_NOT_CONFIGURED",
        error: "Production catalog audit requires a valid CATALOG_AUDIT_SHEET_URL.",
      });
    }

    const requestedSheetUrl = clean(req.body?.spreadsheetUrl);
    if (requestedSheetUrl && spreadsheetId(requestedSheetUrl) !== configuredSheetId) {
      return res.status(400).json({
        success: false,
        code: "CATALOG_AUDIT_PRODUCTION_SHEET_OVERRIDE_REJECTED",
        error: "Production catalog audit is locked to CATALOG_AUDIT_SHEET_URL.",
      });
    }

    if (req.body?.sheets !== undefined) {
      return res.status(400).json({
        success: false,
        code: "CATALOG_AUDIT_PRODUCTION_SHEETS_OVERRIDE_REJECTED",
        error: "Production catalog audit does not allow request-level sheet configuration overrides.",
      });
    }

    req.body = {
      ...req.body,
      spreadsheetUrl: configuredSheetUrl,
    };
  }

  const catalogWriteEnabled = enabled(process.env.CATALOG_AUDIT_WRITE_ENABLED);
  const requestedWrite = req.body?.dryRun === false;

  if (!catalogWriteEnabled || !requestedWrite) {
    req.body = { ...req.body, dryRun: true, writeSheet: false };
    res.setHeader("X-Catalog-Audit-Mode", "dry-run");
    res.setHeader("X-Catalog-Audit-Sheet-Write", "disabled");
    return next();
  }

  const configuredToken = String(process.env.CATALOG_AUDIT_WRITE_TOKEN || "").trim();
  const suppliedToken = String(req.header("x-catalog-audit-write-token") || "").trim();
  if (!configuredToken || !suppliedToken || !safeEqual(configuredToken, suppliedToken)) {
    return res.status(403).json({
      success: false,
      code: "CATALOG_AUDIT_WRITE_NOT_AUTHORIZED",
      error: "Catalog audit write mode requires a valid x-catalog-audit-write-token header.",
    });
  }

  if (production && !(await verifyCanaryDryRunBatch(req, res, configuredSheetId))) {
    return;
  }

  // The first live Shopify write is a strict single-product canary. Keep the
  // audited product pinned to the same first-row scope used by production smoke:
  // offset=0 and maxRows=1. Broad writes remain unavailable until canary read-back.
  const suppliedMaxRows = req.body?.maxRows;
  if (suppliedMaxRows !== undefined && suppliedMaxRows !== null) {
    const numericMaxRows = Number(suppliedMaxRows);
    if (!Number.isSafeInteger(numericMaxRows) || numericMaxRows !== 1) {
      return res.status(400).json({
        success: false,
        code: "CATALOG_AUDIT_CANARY_REQUIRES_ONE_PRODUCT",
        error: "Shopify canary write mode requires maxRows=1 exactly.",
      });
    }
  }

  const suppliedOffset = req.body?.offset;
  if (suppliedOffset !== undefined && suppliedOffset !== null && Number(suppliedOffset) !== 0) {
    return res.status(400).json({
      success: false,
      code: "CATALOG_AUDIT_CANARY_REQUIRES_FIRST_PRODUCT",
      error: "Shopify canary write mode requires offset=0 so it matches the production dry run.",
    });
  }

  // The first Shopify canary must be isolated from Google Sheet writes. Sheet mutation
  // is a separate rollout stage and remains unavailable from this endpoint until the
  // canary and Shopify read-back have succeeded and a dedicated rollout gate exists.
  const writeSheet = false;

  req.body = {
    ...req.body,
    dryRun: false,
    writeSheet,
    offset: 0,
    maxRows: 1,
  };
  res.setHeader("X-Catalog-Audit-Mode", "canary-write");
  res.setHeader("X-Catalog-Audit-Offset", "0");
  res.setHeader("X-Catalog-Audit-Max-Rows", "1");
  res.setHeader("X-Catalog-Audit-Sheet-Write", "disabled");

  if (production) {
    const expectedShopifyProductId = clean(req.body?.canaryExpectedShopifyProductId);
    try {
      return runWithCatalogCanaryMutationGuard(expectedShopifyProductId, () => next());
    } catch (error: any) {
      return res.status(error?.statusCode || 412).json({
        success: false,
        code: error?.code || "CATALOG_AUDIT_CANARY_MUTATION_GUARD_INVALID",
        error: error?.message || "Catalog canary mutation guard could not be established.",
      });
    }
  }

  return next();
}
