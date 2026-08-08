import "dotenv/config";
import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createServer as createHttpServer } from "http";
import { createServer as createViteServer } from "vite";
import {
  envNumber,
  envString,
  isProduction,
  printRuntimeValidation,
  validateRuntimeEnv,
} from "./src/server/config/env.js";
import apiRouter from "./src/server/api.js";
import catalogAuditRouter from "./src/server/routes/catalog-audit.routes.js";
import sheet1ReconcileRouter from "./src/server/routes/sheet1-reconcile.routes.js";
import readinessRouter from "./src/server/routes/readiness.routes.js";
import { catalogAuditSafety } from "./src/server/middleware/catalogAuditSafety.js";
import { prisma } from "./src/server/db.js";
import { QueueService } from "./src/server/services/queue.js";
import { startOneTimeSheetImport } from "./src/server/oneTimeSheetImport.js";
import { startOneTimeSheet1Reconcile } from "./src/server/oneTimeSheet1Reconcile.js";
import cors from "cors";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const startedAt = new Date();

function normalizeOrigin(value?: string | null) {
  if (!value) return null;

  try {
    const trimmed = value.trim();
    if (!trimmed || /^(MY_|YOUR[_-])/i.test(trimmed)) return null;
    const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function getAllowedOrigins() {
  const configuredOrigins = [
    envString("FRONTEND_URL"),
    envString("APP_URL"),
    ...envString("CORS_ORIGINS", "").split(","),
  ];

  const defaults = [
    "https://datauplode.vercel.app",
    "http://localhost:5173",
    "http://localhost:3000",
  ];

  return new Set(
    [...configuredOrigins, ...defaults]
      .map((origin) => normalizeOrigin(origin?.trim()))
      .filter(Boolean) as string[],
  );
}

function getListenHost() {
  const configuredHost = envString("HOST", "0.0.0.0");
  const isRailway = Boolean(
    envString("RAILWAY_ENVIRONMENT") || envString("RAILWAY_PUBLIC_DOMAIN"),
  );

  if (isRailway && ["127.0.0.1", "localhost", "::1"].includes(configuredHost)) {
    return "0.0.0.0";
  }

  return configuredHost;
}

function envFlag(name: string, defaultValue = false) {
  const fallback = defaultValue ? "true" : "false";
  return envString(name, fallback).trim().toLowerCase() === "true";
}

function runtimeWritesEnabled() {
  return envFlag("SYNC_RUNTIME_WRITE_ENABLED");
}

function pricingRuleSeedEnabled() {
  return runtimeWritesEnabled() && envFlag("SYNC_PRICING_RULE_SEED_ENABLED");
}

function jobRecoveryConfigured() {
  return envFlag("SYNC_JOB_RECOVERY_ENABLED");
}

function jobRecoveryShopifyWritesEnabled() {
  return envFlag("SYNC_JOB_RECOVERY_SHOPIFY_WRITES_ENABLED");
}

function jobRecoveryEnabled() {
  return (
    runtimeWritesEnabled() &&
    envFlag("SYNC_JOB_RECOVERY_ENABLED") &&
    jobRecoveryShopifyWritesEnabled()
  );
}

function inventoryAutostartEnabled() {
  return runtimeWritesEnabled() && envFlag("SYNC_INVENTORY_AUTOSTART");
}

function sheetImportAutostartEnabled() {
  return runtimeWritesEnabled() && envFlag("SYNC_SHEET_IMPORT_AUTOSTART_ENABLED");
}

function isDatabaseUnavailableError(error: any) {
  const message = String(error?.message || "");
  return (
    error?.code === "P1001" ||
    message.includes("Can't reach database server") ||
    message.includes("Error validating datasource `db`") ||
    message.includes("URL must start with `postgresql://` or `postgres://`") ||
    message.includes("Environment variable not found: DATABASE_URL")
  );
}

async function seedDefaultPricingRules() {
  try {
    const ruleCount = await prisma.pricingRule.count();
    if (ruleCount === 0) {
      await prisma.pricingRule.createMany({
        data: [
          { name: "Standard (1.5x)", multiplier: 1.5, isDefault: true },
          { name: "Egypt Market (24x)", multiplier: 24.0, rounding: ".99" },
          { name: "Luxury (2x)", multiplier: 2.0, fixedMarkup: 10.0 },
        ],
      });
      console.log("Seeded default pricing rules");
    }
  } catch (error: any) {
    console.error("Failed to seed pricing rules:", error.message);
  }
}

async function startServer() {
  const envValidation = validateRuntimeEnv();
  printRuntimeValidation(envValidation);
  if (!envValidation.ok) {
    console.error(
      "[env] validation failed. Starting server in degraded mode to keep UI reachable.",
    );
  }

  const app = express();
  const httpServer = createHttpServer(app);
  const PORT = envNumber("PORT", 3000);
  const HOST = getListenHost();
  const allowedOrigins = getAllowedOrigins();

  console.log("🚀 Starting server...");
  console.log("Environment:", envString("NODE_ENV", "development"));
  console.log("Port:", PORT);
  console.log("Host:", HOST);

  app.set("trust proxy", 1);

  const corsOptions: cors.CorsOptions = {
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) {
        callback(null, true);
      } else {
        console.log("❌ Blocked origin:", origin);
        callback(null, false);
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Catalog-Audit-Write-Token",
      "X-Sheet1-Reconcile-Run",
    ],
  };

  app.use((req, res, next) => {
    const requestOrigin = normalizeOrigin(req.get("origin"));
    if (!requestOrigin || !allowedOrigins.has(requestOrigin)) {
      return next();
    }

    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");

    if (req.method === "OPTIONS") {
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET,POST,PUT,DELETE,PATCH,OPTIONS",
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        req.get("access-control-request-headers") ||
          "Content-Type,Authorization,X-Catalog-Audit-Write-Token,X-Sheet1-Reconcile-Run",
      );
      return res.sendStatus(204);
    }

    next();
  });

  app.use(cors(corsOptions));
  app.options("*", cors(corsOptions));

  app.use(express.json({ limit: "10mb" }));

  app.get(["/health", "/api/health"], async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({
        ok: true,
        service: "syncly-api",
        database: "ok",
        environment: envString("NODE_ENV", "development"),
        startedAt: startedAt.toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
      });
    } catch (error: any) {
      console.error("❌ Health check failed:", error);
      res.status(503).json({
        ok: false,
        service: "syncly-api",
        database: "error",
        error: isDatabaseUnavailableError(error)
          ? "Database is currently unavailable or DATABASE_URL is invalid. Check DATABASE_URL format and database reachability."
          : error.message,
        code: isDatabaseUnavailableError(error)
          ? "DB_UNAVAILABLE"
          : "HEALTH_CHECK_FAILED",
      });
    }
  });

  app.use("/api", readinessRouter);
  app.use("/api", catalogAuditSafety);
  app.use("/api", catalogAuditRouter);
  app.use("/api", sheet1ReconcileRouter);
  app.use("/api", apiRouter);

  console.log("✅ API routes mounted");

  if (!isProduction()) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr:
          envString("DISABLE_HMR") === "true" ? false : { server: httpServer },
      },
      appType: "spa",
    });
    app.use(vite.middlewares);

    app.use("*", async (req, res, next) => {
      const url = req.originalUrl;
      if (url.startsWith("/api")) return next();

      try {
        let template = fs.readFileSync(
          path.resolve(__dirname, "index.html"),
          "utf-8",
        );
        template = await vite.transformIndexHtml(url, template);
        res.status(200).set({ "Content-Type": "text/html" }).end(template);
      } catch (e) {
        vite.ssrFixStacktrace(e as Error);
        next(e);
      }
    });
  } else {
    const distPath = path.join(process.cwd(), "dist");
    const indexPath = path.join(distPath, "index.html");

    if (fs.existsSync(indexPath)) {
      app.use(express.static(distPath));
      app.get("*", (_req, res) => {
        res.sendFile(indexPath);
      });
    } else {
      app.get("*", (_req, res) => {
        res.json({
          service: "Syncly API",
          frontend: envString("FRONTEND_URL", "https://datauplode.vercel.app"),
          health: "/health",
          readiness: "/api/ready",
        });
      });
    }
  }

  httpServer.listen(PORT, HOST, () => {
    console.log(`Server running at http://${HOST}:${PORT}`);
    console.log(`Environment: ${envString("NODE_ENV", "development")}`);
    console.log(`Allowed origins: ${[...allowedOrigins].join(", ")}`);

    // Explicit one-time production operation. It is independently guarded by
    // an exact run key, a DB marker, a dry-run, and a one-product read-back.
    // It never creates/rebuilds products and does not require broad runtime writes.
    startOneTimeSheet1Reconcile(PORT);

    if (!runtimeWritesEnabled()) {
      console.log(
        "Runtime sync writes disabled (safe mode). Set SYNC_RUNTIME_WRITE_ENABLED=true only after live dry run, canary, and read-back succeed.",
      );
      return;
    }

    console.warn("Runtime sync writes ENABLED by SYNC_RUNTIME_WRITE_ENABLED=true");

    if (pricingRuleSeedEnabled()) {
      console.warn("Default pricing-rule seed ENABLED");
      void seedDefaultPricingRules();
    } else {
      console.log("Default pricing-rule seed disabled by SYNC_PRICING_RULE_SEED_ENABLED=false");
    }

    if (jobRecoveryEnabled()) {
      console.warn(
        "Interrupted-job recovery Shopify writes ENABLED by explicit recovery gate",
      );
      void QueueService.recoverInterruptedJobs();
    } else if (!jobRecoveryConfigured()) {
      console.log("Interrupted-job recovery disabled by SYNC_JOB_RECOVERY_ENABLED=false");
    } else if (!jobRecoveryShopifyWritesEnabled()) {
      console.log(
        "Interrupted-job recovery blocked: SYNC_JOB_RECOVERY_SHOPIFY_WRITES_ENABLED=false",
      );
    } else {
      console.log("Interrupted-job recovery blocked because runtime writes are disabled");
    }

    if (inventoryAutostartEnabled()) {
      console.warn("Inventory monitor autostart ENABLED");
      QueueService.startInventoryMonitor();
    } else {
      console.log("Inventory monitor autostart disabled by SYNC_INVENTORY_AUTOSTART=false");
    }

    if (sheetImportAutostartEnabled()) {
      console.warn("One-time Google Sheet import autostart ENABLED");
      startOneTimeSheetImport(PORT);
    } else {
      console.log(
        "One-time Google Sheet import autostart disabled by SYNC_SHEET_IMPORT_AUTOSTART_ENABLED=false",
      );
    }
  });
}

startServer().catch(console.error);
