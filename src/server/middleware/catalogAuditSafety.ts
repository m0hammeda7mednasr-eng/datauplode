import type { NextFunction, Request, Response } from "express";
import crypto from "crypto";
import { prisma } from "../db.js";

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
  const verifiedProducts = new Set(
    results
      .filter((entry: any) => entry?.status === "verified" && clean(entry?.shopifyProductId))
      .map((entry: any) => clean(entry.shopifyProductId)),
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

  req.body = { ...req.body, dryRunBatchId };
  res.setHeader("X-Catalog-Audit-Dry-Run-Batch", dryRunBatchId);
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
  return next();
}
