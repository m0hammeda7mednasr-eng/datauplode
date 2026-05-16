import assert from "node:assert/strict";
import { extractJsonLdProducts } from "./src/server/scraper/extractors/extractJsonLdProducts.js";
import { extractImages } from "./src/server/scraper/extractors/extractImages.js";
import { extractVariants } from "./src/server/scraper/extractors/extractVariants.js";
import { parsePrice } from "./src/server/scraper/extractors/parsePrice.js";
import { scoreConfidence } from "./src/server/scraper/normalization/scoreConfidence.js";
import { generateWarnings } from "./src/server/scraper/normalization/generateWarnings.js";

assert.deepEqual(parsePrice("$1,299.99"), { amount: 1299.99, currency: "USD", raw: "$1,299.99" });
assert.equal(parsePrice("€1.299,99").amount, 1299.99);
assert.equal(parsePrice("١٢٥٠ ج.م").amount, 1250);
assert.equal(parsePrice("AED 250").currency, "AED");

const html = `
  <html><head>
    <meta property="og:image" content="/images/product-large.jpg">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Test Shoe","sku":"SKU1","brand":{"name":"Acme"},"image":["https://example.com/p.jpg"],"offers":{"@type":"Offer","price":"99.50","priceCurrency":"USD"}}</script>
  </head><body>
    <h1>Test Shoe</h1>
    <select name="Size"><option>Select</option><option>42</option><option>43</option></select>
    <img src="/images/product-large.jpg" alt="Product">
    <img src="/logo.svg" alt="Logo">
  </body></html>`;

const jsonLd = extractJsonLdProducts(html);
assert.equal(jsonLd[0].title, "Test Shoe");
assert.equal(jsonLd[0].price, 99.5);
assert.equal(jsonLd[0].brand, "Acme");

const images = extractImages(html, "https://example.com/products/test");
assert.equal(images.length, 1);
assert.equal(images[0].url, "https://example.com/images/product-large.jpg");

const variants = extractVariants(html);
assert.equal(variants.options[0].name, "Size");
assert.deepEqual(variants.options[0].values, ["42", "43"]);

const confidence = scoreConfidence({ ...jsonLd[0], images, options: variants.options });
assert.equal(confidence.overall >= 80, true);
assert.equal(generateWarnings({ title: "", images: [] }, scoreConfidence({ title: "", images: [] })).some((warning) => warning.code === "MISSING_TITLE"), true);

console.log("Extraction engine tests passed");
