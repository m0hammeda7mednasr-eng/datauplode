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

  const writeEnabled = enabled(process.env.CATALOG_AUDIT_WRITE_ENABLED);
  const requestedWrite = req.body?.dryRun === false;

  if (!writeEnabled || !requestedWrite) {
    req.body = { ...req.body, dryRun: true, writeSheet: false };
    res.setHeader("X-Catalog-Audit-Mode", "dry-run");
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

  const configuredCanary = Number(process.env.CATALOG_AUDIT_CANARY_MAX_ROWS || 5);
  const canaryMaxRows = Number.isFinite(configuredCanary)
    ? Math.max(1, Math.min(25, Math.floor(configuredCanary)))
    : 5;
  const requestedRows = Number(req.body?.maxRows || canaryMaxRows);

  req.body = {
    ...req.body,
    dryRun: false,
    writeSheet: req.body?.writeSheet === true,
    maxRows: Math.max(1, Math.min(canaryMaxRows, Number.isFinite(requestedRows) ? Math.floor(requestedRows) : canaryMaxRows)),
  };
  res.setHeader("X-Catalog-Audit-Mode", "canary-write");
  res.setHeader("X-Catalog-Audit-Max-Rows", String(req.body.maxRows));
  return next();
}
