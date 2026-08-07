import type { NextFunction, Request, Response } from "express";
import crypto from "crypto";

function enabled(value: unknown) {
  return String(value ?? "").trim().toLowerCase() === "true";
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

  // The first live Shopify write is a strict single-product canary. Do not make this
  // configurable: broad writes remain unavailable until the canary and read-back have
  // succeeded and a separate, deliberate production rollout mechanism is implemented.
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

  // Google Sheet writes are an independent side effect. A Shopify canary must not
  // alter the sheet unless this second gate is explicitly enabled.
  const sheetWriteEnabled = enabled(process.env.CATALOG_AUDIT_SHEET_WRITE_ENABLED);
  const writeSheet = sheetWriteEnabled && req.body?.writeSheet === true;

  req.body = {
    ...req.body,
    dryRun: false,
    writeSheet,
    maxRows: 1,
  };
  res.setHeader("X-Catalog-Audit-Mode", "canary-write");
  res.setHeader("X-Catalog-Audit-Max-Rows", "1");
  res.setHeader("X-Catalog-Audit-Sheet-Write", writeSheet ? "enabled" : "disabled");
  return next();
}
