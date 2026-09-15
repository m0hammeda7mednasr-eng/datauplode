import assert from "node:assert/strict";
import { extractNextProductFromHtml } from "./src/server/services/scraper";

const url = "https://www.next.ae/en/style/su903054/v26184";
const embeddedProduct = {
  styleNumber: "su903054",
  itemNumber: "v26184",
  title: "Black/Blue Lightning Bolt Baseball Cap (3-16yrs)",
  productCode: "V26-184",
  brand: "Next",
  colour: "Black/Blue Lightning Bolt",
  currencyCode: "AED",
  price: "AED38 - AED54",
  priceData: {
    price: { minPrice: 38, maxPrice: 54 },
    priceOptions: [
      { optionNumber: "12", price: 38 },
      { optionNumber: "13", price: 38 },
      { optionNumber: "14", price: 44 },
      { optionNumber: "15", price: 49 },
      { optionNumber: "16", price: 54 },
    ],
  },
  itemDescription: {
    toneOfVoice: "<p>Comfortable lightning bolt cap.</p>",
    washingInstructions: "Machine washable.",
    composition: "Main 100% Polyester.",
  },
  options: {
    options: [
      { name: "3 - 4 Years (98 - 104cm)", value: "12", priceUnformatted: 38, stockStatus: "InStock" },
      { name: "5 - 6 Years (110 - 116cm)", value: "13", priceUnformatted: 38, stockStatus: "InStock" },
      { name: "7 - 10 Years (122 - 140cm)", value: "14", priceUnformatted: 44, stockStatus: "InStock" },
      { name: "11 - 13 Years (146 - 158cm)", value: "15", priceUnformatted: 49, stockStatus: "InStock" },
      { name: "14 - 16 Years (164 - 176cm)", value: "16", priceUnformatted: 54, stockStatus: "SoldOut" },
    ],
  },
};

const nextData = {
  props: {
    pageProps: {
      dehydratedState: {
        queries: [{ state: { data: embeddedProduct } }],
      },
    },
  },
};

const html = `
  <html>
    <head>
      <script type="application/ld+json">
        {"@type":"Product","name":"Selected size only","sku":"V26-184","offers":{"price":38,"priceCurrency":"AED"}}
      </script>
    </head>
    <body>
      <img src="https://xcdn.next.co.uk/common/items/default/default/itemimages/3_4Ratio/product/lge/V26184s.jpg" />
      <div data-testid="item-form-size-control"><div data-testid="size-select">Choose Size</div></div>
      <script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>
    </body>
  </html>
`;

const product = extractNextProductFromHtml(html, url);
assert.equal(product.title, embeddedProduct.title);
assert.equal(product.source.productId, "V26-184");
assert.equal(product.currency, "AED");
assert.equal(product.price, 38);
assert.ok(product.description?.includes("Machine washable."));
assert.ok(product.description?.includes("100% Polyester"));
assert.equal(product.variants.length, 5);
assert.deepEqual(
  product.variants.map((variant) => variant.price),
  [38, 38, 44, 49, 54],
);
assert.deepEqual(
  product.variants.map((variant) => variant.available),
  [true, true, true, true, false],
);
assert.deepEqual(product.options.find((option) => option.name === "Size")?.values, [
  "3 - 4 Years (98 - 104cm)",
  "5 - 6 Years (110 - 116cm)",
  "7 - 10 Years (122 - 140cm)",
  "11 - 13 Years (146 - 158cm)",
  "14 - 16 Years (164 - 176cm)",
]);
assert.equal(product.raw.embeddedNextData, true);

const jsonLdUrl = "https://www.next.ae/en/style/su591439/w69416";
const jsonLdProducts = [
  {
    "@context": "http://schema.org",
    "@type": "ProductGroup",
    "@id": jsonLdUrl,
    name: "adidas Tensaur Comfort Infant Trainers",
    productGroupID: "su591439",
    variesBy: ["size", "color"],
  },
  ...[
    ["02", "EU 20 (UK 4)", "SoldOut"],
    ["04", "EU 21.5 (UK 5)", "InStock"],
    ["05", "EU 22 (UK 5.5)", "SoldOut"],
  ].map(([code, size, availability]) => ({
    "@context": "http://schema.org",
    "@type": "Product",
    "@id": `${jsonLdUrl}#size${code}`,
    isVariantOf: { "@id": jsonLdUrl, "@type": "ProductGroup" },
    name: `adidas Pink Tensaur Comfort Infant Trainers - Size ${size}`,
    sku: `W69-416-${code}`,
    color: "Pink",
    size,
    image: [
      "https://xcdn.next.co.uk/common/items/default/default/itemimages/3_4Ratio/product/lge/W69416s.jpg",
    ],
    offers: {
      "@type": "Offer",
      price: "156",
      priceCurrency: "AED",
      availability: `http://schema.org/${availability}`,
    },
  })),
];

const jsonLdHtml = `
  <html>
    <head>
      <title>Buy adidas Pink Tensaur Comfort Infant Trainers from Next United Arab Emirates</title>
      <script type="application/ld+json">${JSON.stringify(jsonLdProducts)}</script>
      <meta property="og:title" content="adidas Pink Tensaur Comfort Infant Trainers" />
    </head>
    <body>
      <h1>adidas Pink Tensaur Comfort Infant Trainers</h1>
      <img src="https://xcdn.next.co.uk/common/items/default/default/itemimages/3_4Ratio/product/lge/W69416s.jpg" />
    </body>
  </html>
`;

const jsonLdProduct = extractNextProductFromHtml(jsonLdHtml, jsonLdUrl);
console.log("Next JSON-LD variant fixture", {
  count: jsonLdProduct.variants.length,
  rawCount: jsonLdProduct.raw.nextJsonLdVariantCount,
  variants: jsonLdProduct.variants.map((variant) => ({
    sku: variant.sku,
    size: variant.size,
    available: variant.available,
  })),
});
assert.equal(jsonLdProduct.source.productId, "W69-416");
assert.equal(jsonLdProduct.price, 156);
assert.equal(jsonLdProduct.variants.length, 3);
assert.deepEqual(
  jsonLdProduct.variants.map((variant) => variant.size),
  ["EU 20 (UK 4)", "EU 21.5 (UK 5)", "EU 22 (UK 5.5)"],
);
assert.deepEqual(
  jsonLdProduct.variants.map((variant) => variant.available),
  [false, true, false],
);
assert.equal(jsonLdProduct.raw.nextJsonLdVariantCount, 3);

console.log("Next embedded product state test passed", {
  title: product.title,
  variants: product.variants.length,
  prices: product.variants.map((variant) => variant.price),
  available: product.variants.map((variant) => variant.available),
});
