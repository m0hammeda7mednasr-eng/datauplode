import "dotenv/config";
import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import apiRouter from "./src/server/api.js";
import { prisma } from "./src/server/db.js";
import cors from "cors";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const startedAt = new Date();

function normalizeOrigin(value?: string | null) {
  if (!value) return null;

  try {
    const trimmed = value.trim();
    const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function getAllowedOrigins() {
  const configuredOrigins = [
    process.env.FRONTEND_URL,
    process.env.APP_URL,
    ...(process.env.CORS_ORIGINS || "").split(","),
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

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3000);
  const HOST = process.env.HOST || "0.0.0.0";
  const allowedOrigins = getAllowedOrigins();

  app.set("trust proxy", 1);

  app.use(
    cors({
      origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl)
        if (!origin) return callback(null, true);
        if (allowedOrigins.has(origin)) {
          callback(null, true);
        } else {
          callback(null, false);
        }
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  );

  app.use(express.json({ limit: "2mb" }));

  app.get(["/health", "/api/health"], async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({
        ok: true,
        service: "syncly-api",
        database: "ok",
        environment: process.env.NODE_ENV || "development",
        startedAt: startedAt.toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
      });
    } catch (error: any) {
      res.status(503).json({
        ok: false,
        service: "syncly-api",
        database: "error",
        error: error.message,
      });
    }
  });

  // API routes
  app.use("/api", apiRouter);

  // Seed default pricing rules if none exist
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

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);

    // Serve index.html as a fallback
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
          frontend: process.env.FRONTEND_URL || "https://datauplode.vercel.app",
          health: "/health",
        });
      });
    }
  }

  app.listen(PORT, HOST, () => {
    console.log(`Server running at http://${HOST}:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
    console.log(`Allowed origins: ${[...allowedOrigins].join(", ")}`);
  });
}

startServer().catch(console.error);
