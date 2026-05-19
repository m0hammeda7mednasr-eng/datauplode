import axios from "axios";
import type { RobotsInfo } from "../types/capability.js";

export type ParsedRobotsResult = RobotsInfo & {
  sitemapUrls: string[];
  disallowRules: string[];
  allowRules: string[];
  rawContent?: string;
};

const SCANNER_USER_AGENT =
  "Mozilla/5.0 (compatible; SynclySourceCapabilityScanner/1.0; +https://example.com/scanner)";

export class RobotsParser {
  private static readonly TIMEOUT_MS = 12000;

  async parseRobotsTxt(domain: string): Promise<ParsedRobotsResult> {
    const robotsTxtUrl = `https://${domain}/robots.txt`;

    try {
      const response = await axios.get<string>(robotsTxtUrl, {
        timeout: RobotsParser.TIMEOUT_MS,
        headers: { "User-Agent": SCANNER_USER_AGENT },
        responseType: "text",
        validateStatus: () => true,
      });

      if (response.status === 404) {
        return {
          robotsTxtUrl,
          robotsStatus: "missing",
          reason: "robots.txt missing (404)",
          sitemapUrls: [],
          disallowRules: [],
          allowRules: [],
        };
      }

      if (response.status >= 500 || response.status === 0) {
        return {
          robotsTxtUrl,
          robotsStatus: "unreachable",
          reason: `robots.txt unreachable (HTTP ${response.status || 0})`,
          sitemapUrls: [],
          disallowRules: [],
          allowRules: [],
        };
      }

      if (response.status >= 400) {
        return {
          robotsTxtUrl,
          robotsStatus: "unknown",
          reason: `robots.txt returned HTTP ${response.status}`,
          sitemapUrls: [],
          disallowRules: [],
          allowRules: [],
          rawContent: response.data,
        };
      }

      const parsed = this.parseRobotsContent(response.data);
      const status: ParsedRobotsResult["robotsStatus"] = parsed.globalDisallow
        ? "disallowed"
        : "allowed";
      const parsedForPaths: ParsedRobotsResult = {
        robotsTxtUrl,
        robotsStatus: status,
        reason: "",
        sitemapUrls: parsed.sitemapUrls,
        disallowRules: parsed.disallowRules,
        allowRules: parsed.allowRules,
      };
      const productPathAllowed = this.isPathAllowed("/product", parsedForPaths);
      const categoryPathAllowed = this.isPathAllowed("/category", parsedForPaths);

      return {
        robotsTxtUrl,
        robotsStatus: status,
        productPathAllowed,
        categoryPathAllowed,
        reason: parsed.globalDisallow
          ? "robots.txt contains global disallow (/)."
          : "robots.txt allows crawling for standard paths.",
        sitemapUrls: parsed.sitemapUrls,
        disallowRules: parsed.disallowRules,
        allowRules: parsed.allowRules,
        rawContent: response.data,
      };
    } catch (error) {
      return {
        robotsTxtUrl,
        robotsStatus: "unreachable",
        reason: error instanceof Error ? error.message : "Network error",
        sitemapUrls: [],
        disallowRules: [],
        allowRules: [],
      };
    }
  }

  isPathAllowed(path: string, parsed: ParsedRobotsResult): boolean {
    if (parsed.robotsStatus === "disallowed") return false;

    const normalizedPath = path.startsWith("/") ? path : `/${path}`;

    const matchedAllowRule = this.getBestMatchingRule(
      normalizedPath,
      parsed.allowRules,
    );
    const matchedDisallowRule = this.getBestMatchingRule(
      normalizedPath,
      parsed.disallowRules,
    );

    if (!matchedAllowRule && !matchedDisallowRule) {
      return true;
    }

    if (!matchedDisallowRule) {
      return true;
    }

    if (!matchedAllowRule) {
      return false;
    }

    return matchedAllowRule.length >= matchedDisallowRule.length;
  }

  private parseRobotsContent(content: string) {
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*/, "").trim())
      .filter(Boolean);

    let currentAgent = "";
    let activeForUs = false;

    const disallowRules: string[] = [];
    const allowRules: string[] = [];
    const sitemapUrls = new Set<string>();

    for (const line of lines) {
      const separatorIndex = line.indexOf(":");
      if (separatorIndex === -1) continue;

      const directive = line.slice(0, separatorIndex).trim().toLowerCase();
      const value = line.slice(separatorIndex + 1).trim();
      if (!value) continue;

      if (directive === "user-agent") {
        currentAgent = value.toLowerCase();
        activeForUs = currentAgent === "*";
        continue;
      }

      if (directive === "sitemap") {
        const normalized = this.tryNormalizeAbsoluteUrl(value);
        if (normalized) sitemapUrls.add(normalized);
        continue;
      }

      if (!activeForUs) continue;

      if (directive === "disallow") {
        disallowRules.push(value);
      } else if (directive === "allow") {
        allowRules.push(value);
      }
    }

    const globalDisallow = disallowRules.some((rule) => rule === "/");

    return {
      sitemapUrls: Array.from(sitemapUrls),
      disallowRules,
      allowRules,
      globalDisallow,
    };
  }

  private getBestMatchingRule(path: string, rules: string[]): string | undefined {
    let best: string | undefined;

    for (const rule of rules) {
      if (rule === "") continue;
      if (this.pathMatchesRule(path, rule)) {
        if (!best || rule.length > best.length) {
          best = rule;
        }
      }
    }

    return best;
  }

  private pathMatchesRule(path: string, rawRule: string): boolean {
    const rule = rawRule.replace(/\*/g, "");

    if (rule === "/") return true;
    if (rule.endsWith("$") && !path.endsWith(rule.slice(0, -1))) return false;

    return path.startsWith(rule.replace(/\$$/, ""));
  }

  private tryNormalizeAbsoluteUrl(url: string): string | null {
    try {
      return new URL(url).toString();
    } catch {
      return null;
    }
  }
}
