import type { SourceCapabilityReport } from "../types/capability.js";

export class ArabicReportGenerator {
  generateHumanReadableReport(report: SourceCapabilityReport): string {
    const restricted = report.recommendedStrategy.mode === "restricted";

    const lines = [
      "????? ??? ??????",
      "",
      `???????: ${report.brandName || "??? ?????"}${report.brandKey ? ` (${report.brandKey})` : ""}`,
      `???????: ${report.domain}`,
      `?? ?????? ${this.renderAllowed(report)}`,
      `?? ??? sitemap? ${report.discovery.canUseSitemap ? "???" : "??"} (${report.discovery.sitemapUrls.length})`,
      `?? ??? JSON-LD? ${report.extractionSignals.hasJsonLdProduct || report.extractionSignals.hasJsonLdProductGroup ? "???" : "??"}`,
      `?? ????? Playwright? ${report.extractionSignals.needsBrowserRendering ? "???" : "??"}`,
      `?? ??? security block? ${this.hasSecurityBlock(report) ? "???" : "??"}`,
      `???? ????? ???: ${this.translateMode(report.recommendedStrategy.mode)}`,
      `??? ???????: ${report.recommendedStrategy.reason}`,
      "",
      "?????? ???????? ??????:",
      `- maxConcurrency: ${report.freeSafeLimits.maxConcurrency}`,
      `- minDelayMs: ${report.freeSafeLimits.minDelayMs}`,
      `- maxRequestsPerMinute: ${report.freeSafeLimits.maxRequestsPerMinute}`,
      `- maxProductsPerRun: ${report.freeSafeLimits.maxProductsPerRun}`,
      `- maxPagesPerRun: ${report.freeSafeLimits.maxPagesPerRun}`,
      `- retryCount: ${report.freeSafeLimits.retryCount}`,
      `- timeoutMs: ${report.freeSafeLimits.timeoutMs}`,
    ];

    if (restricted) {
      lines.push("", "??? ????? ?? ???: ?????? ???? ?? ??? ????? ??? ????????/robots.");
    }

    if (report.warnings.length > 0) {
      lines.push("", "???????:");
      for (const warning of report.warnings) {
        lines.push(`- [${warning.code}] ${warning.message}`);
      }
    }

    return lines.join("\n");
  }

  generateShortSummary(report: SourceCapabilityReport): string {
    if (report.recommendedStrategy.mode === "restricted") {
      return "????: ????? ??? ?? feed/API ?? ??????? ????.";
    }

    if (report.recommendedStrategy.confidence < 55) {
      return `??? ?????? (${report.recommendedStrategy.confidence}%) - ???? ?????? ?????.`;
    }

    return `???? (${report.recommendedStrategy.confidence}%) - ${this.translateMode(report.recommendedStrategy.mode)}.`;
  }

  getExtractionReadiness(report: SourceCapabilityReport): {
    ready: boolean;
    status: "ready" | "warning" | "restricted";
    message: string;
  } {
    if (report.recommendedStrategy.mode === "restricted") {
      return {
        ready: false,
        status: "restricted",
        message: "This source needs permission, feed, API, or manual import.",
      };
    }

    if (report.recommendedStrategy.confidence < 55) {
      return {
        ready: false,
        status: "warning",
        message: "Low confidence. Manual review is recommended before extraction.",
      };
    }

    return {
      ready: true,
      status: "ready",
      message: `Ready for extraction with ${this.translateMode(report.recommendedStrategy.mode)}.`,
    };
  }

  private renderAllowed(report: SourceCapabilityReport) {
    if (
      report.access.robotsStatus === "disallowed" ||
      report.recommendedStrategy.mode === "restricted"
    ) {
      return "??";
    }

    return "???";
  }

  private hasSecurityBlock(report: SourceCapabilityReport) {
    const s = report.restrictionSignals;
    return (
      s.captchaDetected ||
      s.loginRequired ||
      s.accessDenied ||
      s.botProtectionPage ||
      s.geoBlocked ||
      s.rateLimited
    );
  }

  private translateMode(mode: SourceCapabilityReport["recommendedStrategy"]["mode"]) {
    const labels: Record<SourceCapabilityReport["recommendedStrategy"]["mode"], string> = {
      static_html: "Static HTML",
      browser_rendered: "Browser Rendered",
      sitemap_plus_static: "Sitemap + Static",
      sitemap_plus_browser: "Sitemap + Browser",
      feed_only: "Feed Only",
      manual_review: "Manual Review",
      restricted: "Restricted",
    };

    return labels[mode];
  }
}

export function generateHumanReadableReport(report: SourceCapabilityReport) {
  return new ArabicReportGenerator().generateHumanReadableReport(report);
}
