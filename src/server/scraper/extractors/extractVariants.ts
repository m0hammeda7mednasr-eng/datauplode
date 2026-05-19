import * as cheerio from "cheerio";
import type { NormalizedProduct } from "../types/product.js";
import { cleanText, unique } from "./utils.js";

function optionNameFromText(text: string) {
  if (/size|waist|shoe/i.test(text)) return "Size";
  if (/colo(?:u)?r|black|white|blue|red|green|beige|pink|grey|gray/i.test(text)) return "Color";
  if (/material|cotton|leather|polyester/i.test(text)) return "Material";
  return "Option";
}

export function extractVariants(html: string): {
  options: NormalizedProduct["options"];
  variants: NormalizedProduct["variants"];
} {
  const $ = cheerio.load(html);
  const optionMap = new Map<string, Set<string>>();
  const variants: NormalizedProduct["variants"] = [];

  $("select").each((_, select) => {
    const label =
      cleanText($(select).attr("name")) ||
      cleanText($(`label[for="${$(select).attr("id")}"]`).text()) ||
      "Option";
    const name = optionNameFromText(label);
    $(select)
      .find("option")
      .each((__, option) => {
        const value = cleanText($(option).text() || $(option).attr("value"));
        if (!value || /^select|choose|pick/i.test(value)) return;
        if (!optionMap.has(name)) optionMap.set(name, new Set());
        optionMap.get(name)!.add(value);
        variants.push({
          title: value,
          sku: cleanText($(option).attr("data-sku")) || undefined,
          optionValues: { [name]: value },
          inStock: !$(option).is("[disabled]"),
          raw: { value: $(option).attr("value") },
        });
      });
  });

  $("input[type='radio'], button, [data-variant], [data-variant-id], [data-sku]").each((_, element) => {
    const node = $(element);
    const text = cleanText(node.text() || node.attr("aria-label") || node.attr("value") || node.attr("data-option"));
    if (!text || text.length > 80) return;
    const name = optionNameFromText(`${node.attr("name") || ""} ${text}`);
    if (!optionMap.has(name)) optionMap.set(name, new Set());
    optionMap.get(name)!.add(text);
    const sku = cleanText(node.attr("data-sku") || node.attr("sku"));
    if (sku || node.attr("data-variant") || node.attr("data-variant-id")) {
      variants.push({
        title: text,
        sku: sku || undefined,
        optionValues: { [name]: text },
        inStock: !node.is("[disabled], [aria-disabled='true']") && !/sold out|out of stock/i.test(text),
        raw: {
          variantId: node.attr("data-variant") || node.attr("data-variant-id"),
        },
      });
    }
  });

  const options = [...optionMap.entries()]
    .map(([name, values]) => ({ name, values: unique([...values]) }))
    .filter((option) => option.values.length > 0);

  return {
    options,
    variants: variants.length ? variants.slice(0, 250) : [],
  };
}
