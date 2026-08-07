import type { NextFunction, Request, Response } from "express";
import crypto from "crypto";

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

export function catalogAuditSafety(req: Request, res: Response, next: NextFunction) {
  if (req.method !== "POST" || req.path !== "/catalog-audit/run") {
    return next();
  }

  const production = clean(process.env.NODE_ENV).toLowerCase() === "production";
  if (production) {
    const configuredSheetUrl = clean(process.env.CATALOG_AUDIT_SHEET_URL);
    const configuredSheetId = spreadsheetId(configuredSheetUrl);
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
