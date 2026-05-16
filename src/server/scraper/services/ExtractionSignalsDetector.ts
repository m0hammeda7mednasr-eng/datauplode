import * as cheerio from "cheerio";
import type { ExtractionSignals } from "../types/capability.js";

const PRICE_PATTERN =
  /(\$|usd|eur|gbp|aed|sar|egp|inr)\s?\d+[\d,]*(?:\.\d{1,2})?|\d+[\d,]*(?:\.\d{1,2})?\s?(\$|usd|eur|gbp|aed|sar|egp|inr)/i;

export class ExtractionSignalsDetector {
  detectExtractionSignals(html: string): ExtractionSignals {
    const safeHtml = String(html || "");
    const $ = cheerio.load(safeHtml);

    const embeddedStateTypes = this.getEmbeddedStateTypes(safeHtml);
    const hasProductTitle = this.hasProductTitle($);
    const hasProductPrice = this.hasProductPrice($);
    const hasProductImages = this.hasProductImages($);
    const hasVariantSignals = this.hasVariantSignals($, safeHtml);
    const hasStaticProductHtml =
      (hasProductTitle && hasProductPrice) ||
      (hasProductTitle && hasProductImages) ||
      this.hasProductStructuredBlocks($);

    const needsBrowserRendering =
      this.looksLikeAppShell($, safeHtml) &&
      !hasStaticProductHtml &&
      !this.detectJsonLdProduct(safeHtml);

    return {
      hasJsonLdProduct: this.detectJsonLdProduct(safeHtml),
      hasJsonLdProductGroup: this.detectJsonLdProductGroup(safeHtml),
      hasOpenGraph: this.detectOpenGraph($),
      hasProductPriceMeta: this.detectProductPriceMeta($),
      hasEmbeddedState: embeddedStateTypes.length > 0,
      embeddedStateTypes,
      hasStaticProductHtml,
      needsBrowserRendering,
      hasVariantSignals,
      hasImageSignals: hasProductImages,
    };
  }

  calculateExtractionConfidence(signals: ExtractionSignals): number {
    let score = 0;
    score += signals.hasJsonLdProduct ? 30 : 0;
    score += signals.hasJsonLdProductGroup ? 10 : 0;
    score += signals.hasOpenGraph ? 15 : 0;
    score += signals.hasProductPriceMeta ? 10 : 0;
    score += signals.hasStaticProductHtml ? 20 : 0;
    score += signals.hasEmbeddedState ? 5 : 0;
    score += signals.hasVariantSignals ? 5 : 0;
    score += signals.hasImageSignals ? 5 : 0;

    if (signals.needsBrowserRendering) {
      score = Math.max(20, score - 15);
    }

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  private detectJsonLdProduct(html: string): boolean {
    for (const node of this.extractJsonLdNodes(html)) {
      if (this.findJsonLdType(node, ["product"])) {
        return true;
      }
    }

    return false;
  }

  private detectJsonLdProductGroup(html: string): boolean {
    for (const node of this.extractJsonLdNodes(html)) {
      if (this.findJsonLdType(node, ["productgroup", "productcollection"])) {
        return true;
      }
    }

    return false;
  }

  private detectOpenGraph($: cheerio.CheerioAPI): boolean {
    const props = [
      "og:title",
      "og:description",
      "og:image",
      "product:price:amount",
      "product:price:currency",
    ];

    return props.some((prop) => $(`meta[property='${prop}']`).length > 0);
  }

  private detectProductPriceMeta($: cheerio.CheerioAPI): boolean {
    const selectors = [
      "meta[itemprop='price']",
      "meta[property*='price']",
      "meta[name*='price']",
      "[itemprop='price']",
      "[data-price]",
      ".price",
      ".product-price",
      "[class*='price']",
    ];

    if (selectors.some((selector) => $(selector).length > 0)) {
      return true;
    }

    const bodyText = $("body").text().slice(0, 2000);
    return PRICE_PATTERN.test(bodyText);
  }

  private getEmbeddedStateTypes(html: string): string[] {
    const types: string[] = [];

    if (html.includes("__NEXT_DATA__")) types.push("__NEXT_DATA__");
    if (html.includes("__NUXT__")) types.push("__NUXT__");
    if (html.includes("__APOLLO_STATE__")) types.push("__APOLLO_STATE__");
    if (html.includes("__INITIAL_STATE__")) types.push("__INITIAL_STATE__");

    if (/<script[^>]+type=["']application\/json["'][^>]*>/i.test(html)) {
      types.push("application/json");
    }

    return types;
  }

  private hasProductTitle($: cheerio.CheerioAPI): boolean {
    const selectors = [
      "h1[itemprop='name']",
      "h1.product-title",
      "h1[class*='product']",
      "[data-testid*='product-title']",
      "h1",
    ];

    return selectors.some((selector) => {
      const node = $(selector).first();
      return node.length > 0 && node.text().trim().length > 3;
    });
  }

  private hasProductPrice($: cheerio.CheerioAPI): boolean {
    const selectors = [
      "[itemprop='price']",
      ".price",
      ".product-price",
      "[class*='price']",
      "[data-price]",
    ];

    for (const selector of selectors) {
      const text = $(selector)
        .first()
        .text()
        .trim();
      if (text && PRICE_PATTERN.test(text)) {
        return true;
      }
    }

    return false;
  }

  private hasProductImages($: cheerio.CheerioAPI): boolean {
    const selectors = [
      "img[itemprop='image']",
      ".product-image img",
      ".product-gallery img",
      "[data-testid*='product-image'] img",
      "figure img",
      "img[src*='product']",
    ];

    return selectors.some((selector) => $(selector).length > 0);
  }

  private hasVariantSignals($: cheerio.CheerioAPI, html: string): boolean {
    const selectors = [
      "select[name*='size']",
      "select[name*='color']",
      "select[name*='variant']",
      "[data-option]",
      "[data-variant]",
      "[class*='size-selector']",
      "[class*='color-selector']",
      "[class*='variant']",
      "input[type='radio'][name*='size']",
      "input[type='radio'][name*='color']",
    ];

    if (selectors.some((selector) => $(selector).length > 0)) {
      return true;
    }

    return /"(?:size|color|variant|option)"\s*:/i.test(html);
  }

  private hasProductStructuredBlocks($: cheerio.CheerioAPI): boolean {
    const selectors = [
      "[itemtype*='schema.org/Product']",
      "[data-product-id]",
      "[class*='product-detail']",
      "[class*='product-info']",
      "[class*='add-to-cart']",
      "button[name*='add']",
    ];

    return selectors.some((selector) => $(selector).length > 0);
  }

  private looksLikeAppShell($: cheerio.CheerioAPI, html: string): boolean {
    const hasSpaRoot =
      $("#root, #app, #__next, #__nuxt, [data-reactroot]").length > 0;
    const hasManyScripts = $("script").length > 8;
    const visibleTextLength = $("body").text().replace(/\s+/g, " ").trim().length;

    const hasLoadingOnly = /loading|please wait|initializing/i.test(
      $("body").text().slice(0, 400),
    );

    const hasEmbeddedState =
      html.includes("__NEXT_DATA__") ||
      html.includes("__NUXT__") ||
      html.includes("__INITIAL_STATE__");

    return (
      (hasSpaRoot && hasManyScripts && visibleTextLength < 800) ||
      (hasEmbeddedState && visibleTextLength < 500) ||
      hasLoadingOnly
    );
  }

  private extractJsonLdNodes(html: string): unknown[] {
    const matches = html.match(
      /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    );

    if (!matches) return [];

    const nodes: unknown[] = [];
    for (const scriptTag of matches) {
      const raw = scriptTag
        .replace(/<script[^>]*>/i, "")
        .replace(/<\/script>/i, "")
        .trim();

      if (!raw) continue;

      try {
        nodes.push(JSON.parse(raw));
      } catch {
        // Ignore broken blocks.
      }
    }

    return nodes;
  }

  private findJsonLdType(node: unknown, types: string[]): boolean {
    if (Array.isArray(node)) {
      return node.some((item) => this.findJsonLdType(item, types));
    }

    if (!node || typeof node !== "object") return false;

    const typedNode = node as Record<string, unknown>;
    const typeValue = typedNode["@type"] ?? typedNode.type;

    const matchesType = (value: unknown) => {
      if (typeof value === "string") {
        return types.includes(value.toLowerCase());
      }
      if (Array.isArray(value)) {
        return value.some((item) => typeof item === "string" && types.includes(item.toLowerCase()));
      }
      return false;
    };

    if (matchesType(typeValue)) return true;

    if (typedNode["@graph"]) {
      return this.findJsonLdType(typedNode["@graph"], types);
    }

    return false;
  }
}

export function detectExtractionSignals(html: string) {
  return new ExtractionSignalsDetector().detectExtractionSignals(html);
}
