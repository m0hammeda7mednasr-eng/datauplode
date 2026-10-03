import assert from "node:assert/strict";
import {
  CentrepointScraper,
  isLikelyProductImageSource,
  parseCentrepointHtml,
} from "../src/server/services/scraper.js";

assert.equal(
  isLikelyProductImageSource("https://static.example.com/product/front.jpg?width=1200", "Product front"),
  true,
);
assert.equal(
  isLikelyProductImageSource("https://static.example.com/product/spin/video.mp4?ts=123", "Product video"),
  false,
);
assert.equal(
  isLikelyProductImageSource("https://static.example.com/assets/payment/visa.png", "Visa"),
  false,
);

const centrepointFixture = `<!doctype html><html><head>
  <meta property="product:color" content="K31-F11-02-004YELLOWDARK">
  <script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org/",
    "@type": "Product",
    name: "Fixture shirt",
    image: "https://media.centrepointstores.com/i/centrepoint/FIXTURE_01-2100.jpg",
    color: "",
    brand: { "@type": "Brand", name: "Juniors" },
    offers: {
      "@type": "Offer",
      price: "55",
      priceCurrency: "AED",
      availability: "https://schema.org/OutOfStock",
    },
  })}</script>
</head><body></body></html>`;
const centrepoint = parseCentrepointHtml(
  centrepointFixture,
  "https://www.centrepointstores.com/ae/en/buy-fixture-shirt/p/K31-F11-02-004YELLOWDARK",
);
assert.equal(centrepoint.variants[0]?.color, "Yellow");
assert.equal(centrepoint.variants[0]?.stockStatus, "out_of_stock");
assert.throws(
  () => new CentrepointScraper().scrapeSnapshot(
    "https://www.centrepointstores.com/ae/en/buy-fixture/p/FIXTURE",
    "<!doctype html><title>Just a moment...</title><script src='/cdn-cgi/challenge-platform/test'></script>",
  ),
  /Cloudflare challenge/,
);

console.log("Product media filter safety contract passed");
