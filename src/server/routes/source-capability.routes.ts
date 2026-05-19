import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { scraperLogger } from "../scraper/logger.js";
import { ArabicReportGenerator } from "../scraper/services/ArabicReportGenerator.js";
import { SourceCapabilityScanner } from "../scraper/services/SourceCapabilityScanner.js";
import type { SourceCapabilityReport } from "../scraper/types/capability.js";

const router = Router();
const scanner = new SourceCapabilityScanner();
const reportGenerator = new ArabicReportGenerator();

const ScanRequestSchema = z.object({
  url: z.string().min(1, "URL is required"),
});

const StartExtractionSchema = z.object({
  sourceInput: z
    .object({
      url: z.string().url().optional(),
      sourceType: z
        .enum(["product_url", "category_url", "sitemap", "csv_feed", "xml_feed", "json_feed"])
        .optional(),
      mode: z.enum(["auto", "static_html", "browser_rendered", "feed"]).optional(),
      customSelectors: z
        .object({
          title: z.string().optional(),
          price: z.string().optional(),
          description: z.string().optional(),
          images: z.string().optional(),
          variants: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

router.post("/source-scan", async (req, res) => {
  try {
    const { url } = ScanRequestSchema.parse(req.body);
    const normalizedUrl = normalizeSourceUrl(url);

    const existingScan = await prisma.sourceScan.findFirst({
      where: {
        sourceUrl: normalizedUrl,
        status: "COMPLETED",
        completedAt: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
        },
      },
      include: { warnings: true, limitProfile: true },
      orderBy: { updatedAt: "desc" },
    });

    if (existingScan?.reportJson) {
      const report = JSON.parse(existingScan.reportJson) as SourceCapabilityReport;
      return res.json({
        success: true,
        scanId: existingScan.id,
        report,
        humanReadableReport: reportGenerator.generateHumanReadableReport(report),
        shortSummary: reportGenerator.generateShortSummary(report),
        extractionReadiness: reportGenerator.getExtractionReadiness(report),
        cached: true,
      });
    }

    const sourceScan = await prisma.sourceScan.upsert({
      where: { sourceUrl: normalizedUrl },
      update: {
        status: "PENDING",
        updatedAt: new Date(),
      },
      create: {
        sourceUrl: normalizedUrl,
        domain: new URL(normalizedUrl).hostname,
        status: "PENDING",
      },
    });

    const report = await scanner.scanSourceCapabilities(normalizedUrl);

    await prisma.$transaction(async (tx) => {
      await tx.sourceScan.update({
        where: { id: sourceScan.id },
        data: {
          status: "COMPLETED",
          domain: report.domain,
          brandKey: report.brandKey,
          brandName: report.brandName,
          region: report.region,
          reportJson: JSON.stringify(report),
          completedAt: new Date(),
        },
      });

      await tx.sourceScanWarning.deleteMany({ where: { sourceScanId: sourceScan.id } });
      if (report.warnings.length > 0) {
        await tx.sourceScanWarning.createMany({
          data: report.warnings.map((warning) => ({
            sourceScanId: sourceScan.id,
            code: warning.code,
            message: warning.message,
          })),
        });
      }

      const capabilityReport = await tx.sourceCapabilityReport.upsert({
        where: { sourceScanId: sourceScan.id },
        update: {
          reportJson: JSON.stringify(report),
          updatedAt: new Date(),
        },
        create: {
          sourceScanId: sourceScan.id,
          reportJson: JSON.stringify(report),
        },
      });

      await tx.sourceWarning.deleteMany({
        where: { sourceCapabilityReportId: capabilityReport.id },
      });
      if (report.warnings.length > 0) {
        await tx.sourceWarning.createMany({
          data: report.warnings.map((warning) => ({
            sourceCapabilityReportId: capabilityReport.id,
            code: warning.code,
            message: warning.message,
          })),
        });
      }

      await tx.sourceLimitProfile.upsert({
        where: { sourceScanId: sourceScan.id },
        update: {
          maxConcurrency: report.freeSafeLimits.maxConcurrency,
          minDelayMs: report.freeSafeLimits.minDelayMs,
          maxRequestsPerMinute: report.freeSafeLimits.maxRequestsPerMinute,
          maxProductsPerRun: report.freeSafeLimits.maxProductsPerRun,
          maxPagesPerRun: report.freeSafeLimits.maxPagesPerRun,
          retryCount: report.freeSafeLimits.retryCount,
          timeoutMs: report.freeSafeLimits.timeoutMs,
          updatedAt: new Date(),
        },
        create: {
          sourceScanId: sourceScan.id,
          maxConcurrency: report.freeSafeLimits.maxConcurrency,
          minDelayMs: report.freeSafeLimits.minDelayMs,
          maxRequestsPerMinute: report.freeSafeLimits.maxRequestsPerMinute,
          maxProductsPerRun: report.freeSafeLimits.maxProductsPerRun,
          maxPagesPerRun: report.freeSafeLimits.maxPagesPerRun,
          retryCount: report.freeSafeLimits.retryCount,
          timeoutMs: report.freeSafeLimits.timeoutMs,
        },
      });
    });

    scraperLogger.info({
      event: "source_scan_saved",
      sourceUrl: report.sourceUrl,
      brandDetected: report.brandKey,
      robotsStatus: report.access.robotsStatus,
      sitemapCount: report.discovery.sitemapUrls.length,
      productUrlCount: report.discovery.productUrlsFound,
      extractionSignals: report.extractionSignals,
      restrictionSignals: report.restrictionSignals,
      recommendedStrategy: report.recommendedStrategy,
      safeLimits: report.freeSafeLimits,
    });

    res.json({
      success: true,
      scanId: sourceScan.id,
      report,
      humanReadableReport: reportGenerator.generateHumanReadableReport(report),
      shortSummary: reportGenerator.generateShortSummary(report),
      extractionReadiness: reportGenerator.getExtractionReadiness(report),
      cached: false,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: "Validation error",
        details: error.issues,
      });
    }

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

router.get("/source-scan/:id", async (req, res) => {
  try {
    const scan = await prisma.sourceScan.findUnique({
      where: { id: req.params.id },
      include: { warnings: true, limitProfile: true },
    });

    if (!scan) {
      return res.status(404).json({ success: false, error: "Scan not found" });
    }

    if (scan.status === "PENDING") {
      return res.json({
        success: true,
        scanId: scan.id,
        status: "PENDING",
        message: "Scan in progress...",
      });
    }

    if (scan.status === "FAILED") {
      return res.status(500).json({
        success: false,
        scanId: scan.id,
        status: "FAILED",
        error: scan.reportJson ? JSON.parse(scan.reportJson).error : "Scan failed",
      });
    }

    if (!scan.reportJson) {
      return res.status(500).json({
        success: false,
        error: "Scan completed but report is missing.",
      });
    }

    const report = JSON.parse(scan.reportJson) as SourceCapabilityReport;

    res.json({
      success: true,
      scanId: scan.id,
      report,
      humanReadableReport: reportGenerator.generateHumanReadableReport(report),
      shortSummary: reportGenerator.generateShortSummary(report),
      extractionReadiness: reportGenerator.getExtractionReadiness(report),
      scan: {
        id: scan.id,
        sourceUrl: scan.sourceUrl,
        domain: scan.domain,
        brandKey: scan.brandKey,
        brandName: scan.brandName,
        region: scan.region,
        status: scan.status,
        createdAt: scan.createdAt,
        completedAt: scan.completedAt,
        warnings: scan.warnings,
        limitProfile: scan.limitProfile,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

router.post("/source-scan/:id/start-extraction", async (req, res) => {
  try {
    const body = StartExtractionSchema.parse(req.body ?? {});

    const scan = await prisma.sourceScan.findUnique({
      where: { id: req.params.id },
      include: { limitProfile: true },
    });

    if (!scan?.reportJson || scan.status !== "COMPLETED") {
      return res.status(400).json({
        success: false,
        error: "Scan is not completed yet.",
      });
    }

    const report = JSON.parse(scan.reportJson) as SourceCapabilityReport;

    if (report.recommendedStrategy.mode === "restricted") {
      return res.status(403).json({
        success: false,
        error: "Extraction is blocked for this source.",
        message: "This source needs permission, feed, API, or manual import.",
        reason: report.recommendedStrategy.reason,
      });
    }

    const mode = mapScanModeToExtractionMode(report.recommendedStrategy.mode);
    const sourceType =
      body.sourceInput?.sourceType ||
      inferSourceTypeFromReport(report);
    const targetUrl = body.sourceInput?.url || report.sourceUrl;

    const source = await prisma.source.upsert({
      where: { domain: report.domain },
      update: {
        name: report.brandName || report.domain,
        mode,
        status: "READY",
        rateLimitJson: JSON.stringify({
          requestsPerMinute:
            scan.limitProfile?.maxRequestsPerMinute ?? report.freeSafeLimits.maxRequestsPerMinute,
          concurrency:
            scan.limitProfile?.maxConcurrency ?? report.freeSafeLimits.maxConcurrency,
        }),
        customSelectorsJson: body.sourceInput?.customSelectors
          ? JSON.stringify(body.sourceInput.customSelectors)
          : null,
      },
      create: {
        name: report.brandName || report.domain,
        baseUrl: new URL(report.sourceUrl).origin,
        domain: report.domain,
        type: sourceType,
        mode,
        status: "READY",
        rateLimitJson: JSON.stringify({
          requestsPerMinute: report.freeSafeLimits.maxRequestsPerMinute,
          concurrency: report.freeSafeLimits.maxConcurrency,
        }),
        customSelectorsJson: body.sourceInput?.customSelectors
          ? JSON.stringify(body.sourceInput.customSelectors)
          : null,
      },
    });

    const crawlJob = await prisma.crawlJob.create({
      data: {
        sourceId: source.id,
        type: sourceType,
        status: "pending",
        sourceUrl: targetUrl,
        payloadJson: JSON.stringify({
          scanId: scan.id,
          sourceInput: {
            url: targetUrl,
            sourceType,
            mode,
            customSelectors: body.sourceInput?.customSelectors,
          },
          recommendedStrategy: report.recommendedStrategy,
          safeLimits: report.freeSafeLimits,
        }),
      },
    });

    res.json({
      success: true,
      message: "Extraction job created successfully",
      jobId: crawlJob.id,
      sourceId: source.id,
      recommendedStrategy: report.recommendedStrategy,
      safeLimits: report.freeSafeLimits,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: "Validation error",
        details: error.issues,
      });
    }

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

router.get("/source-scans", async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    const skip = (page - 1) * limit;

    const [scans, total] = await Promise.all([
      prisma.sourceScan.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: { warnings: true, limitProfile: true },
      }),
      prisma.sourceScan.count(),
    ]);

    res.json({
      success: true,
      scans,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

function normalizeSourceUrl(url: string) {
  const value = url.trim();
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const parsed = new URL(withProtocol);
  parsed.hash = "";
  return parsed.toString();
}

function mapScanModeToExtractionMode(
  mode: SourceCapabilityReport["recommendedStrategy"]["mode"],
): "auto" | "static_html" | "browser_rendered" | "feed" {
  if (mode === "browser_rendered" || mode === "sitemap_plus_browser") {
    return "browser_rendered";
  }

  if (mode === "feed_only") {
    return "feed";
  }

  if (mode === "static_html" || mode === "sitemap_plus_static") {
    return "static_html";
  }

  return "auto";
}

function inferSourceTypeFromReport(
  report: SourceCapabilityReport,
): "product_url" | "category_url" | "sitemap" {
  if (report.discovery.canUseSitemap) return "sitemap";
  if (report.discovery.canUseCategoryCrawl) return "category_url";
  return "product_url";
}

export default router;
