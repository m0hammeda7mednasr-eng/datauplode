import assert from "node:assert/strict";
import { ScraperService, type NormalizedProduct } from "./src/server/services/scraper";

const scraper = new ScraperService();

const liveCases = [
  {
    name: "Max Fashion dungaree set",
    url: "https://www.maxfashion.com/ae/en/buy-stitch-embroidered-denim-dungaree-with-tshirt/p/B26KIBFEDTRDUNG147MULTICOLORMEDIUM",
    supplier: "Max Fashion",
    currency: "AED",
    minImages: 4,
    minVariants: 5,
  },
  {
    name: "Marks & Spencer bibshort set",
    url: "https://www.marksandspencerme.com/en-ae/l/denim-striped-bibshort-with-t-shirt-0-3-yrs-/p/T784681D",
    supplier: "Marks & Spencer",
    currency: "AED",
    minImages: 2,
    minVariants: 7,
  },
  {
    name: "H&M 2-piece set",
    url: "https://ae.hm.com/en/buy-2-piece-set-light-blue-white-striped",
    supplier: "H&M",
    currency: "AED",
    minImages: 2,
    minVariants: 7,
  },
  {
    name: "Mothercare bibs",
    url: "https://www.mothercare.ae/en/buy-3-pack-mothercare-newborn-bibs-4",
    supplier: "Mothercare",
    currency: "AED",
    minImages: 2,
    minVariants: 1,
  },
  {
    name: "Zara crab knit playsuit",
    url: "https://www.zara.com/ae/en/-p01473692.html?v1=511134201",
    supplier: "Zara",
    currency: "AED",
    minImages: 4,
    minVariants: 4,
  },
  {
    name: "Centrepoint dungaree set",
    url: "https://www.centrepointstores.com/ae/en/buy-juniors-round-neck-short-sleeve-tshirt-and-dungaree-set-with-alligator-applique/p/K31-A15-13-427MULTICOLORMULTISHADE",
    supplier: "Centrepoint",
    currency: "AED",
    minImages: 4,
    minVariants: 7,
  },
];

const nextBabyDressSnapshot = `
# White Strawberry Baby Short Sleeve Dresse 2 Pack (0mths-3yrs)

AED91 - AED102

Product Code: W59-264

Colour:White Strawberry

Size:

Choose Size

Add to Bag

## Description

Dress your little one in these lovely white strawberry dresses, a perfect choice for their everyday adventures. Made with super soft jersey fabric, this 2 pack includes a pink dress and a multi-coloured design. The short sleeves and comfortable fit ensure easy movement and all-day comfort. Super soft jersey fabric Mix print design Short sleeves 2 pack Crew neckline with button fastening Machine washable. 2 x Dress 95% Cotton, 5% Elastane. Country of Origin: India Warning: Keep away from fire and flames.

![Image: White Strawberry Baby Short Sleeve Dresse 2 Pack (0mths-3yrs) - Image 1 of 9](https://xcdn.next.co.uk/common/items/default/default/itemimages/3_4Ratio/product/lge/W59264s.jpg?im=Resize,width=750)
![Image: White Strawberry Baby Short Sleeve Dresse 2 Pack (0mths-3yrs) - Image 2 of 9](https://xcdn.next.co.uk/common/items/default/default/itemimages/3_4Ratio/product/lge/W59264s2.jpg?im=Resize,width=750)
![Image: White Strawberry Baby Short Sleeve Dresse 2 Pack (0mths-3yrs) - Image 3 of 9](https://xcdn.next.co.uk/common/items/default/default/itemimages/3_4Ratio/product/lge/W59264s3.jpg?im=Resize,width=750)
![Image: White Strawberry Baby Short Sleeve Dresse 2 Pack (0mths-3yrs) - Image 4 of 9](https://xcdn.next.co.uk/common/items/default/default/itemimages/3_4Ratio/product/lge/W59264s4.jpg?im=Resize,width=750)
`;

const blockedNextSnapshot = `
# River Island Pink Stripe Puff Sleeve Top & Bow Wide Leg Set

AED186

Product Code: G44-412

* * *

Size:

Choose Size

Add to Bag

## Description

Abbie Rosie collection • 2 piece set • Stripe • Top • Short puff sleeves • Bow details • Button back fastening • Trousers • Wide leg • Elasticated waistband Machine washable. 100% Cotton. Country of Origin: India

![Image: River Island Pink Stripe Puff Sleeve Top & Bow Wide Leg Set - Image 1 of 5](https://xcdn.next.co.uk/common/items/default/default/itemimages/3_4Ratio/product/lge/G44412s.jpg?im=Resize,width=750)
![Image: River Island Pink Stripe Puff Sleeve Top & Bow Wide Leg Set - Image 2 of 5](https://xcdn.next.co.uk/common/items/default/default/itemimages/3_4Ratio/product/lge/G44412s2.jpg?im=Resize,width=750)
`;

function assertProduct(caseName: string, product: NormalizedProduct, expected: {
  supplier: string;
  currency: string;
  minImages: number;
  minVariants: number;
}) {
  assert.equal(product.source.supplier, expected.supplier, `${caseName}: supplier`);
  assert.equal(product.currency, expected.currency, `${caseName}: currency`);
  assert.ok(product.title.length > 3, `${caseName}: title`);
  assert.ok(product.price > 0, `${caseName}: price`);
  assert.ok(product.images.length >= expected.minImages, `${caseName}: images ${product.images.length}`);
  assert.ok(product.variants.length >= expected.minVariants, `${caseName}: variants ${product.variants.length}`);
  assert.ok(product.variants.every(variant => variant.price && variant.price > 0), `${caseName}: variant prices`);
  assert.ok(product.variants.every(variant => variant.currency === product.currency), `${caseName}: variant currency`);
}

for (const testCase of liveCases) {
  const product = await scraper.scrape(testCase.url);
  assertProduct(testCase.name, product, testCase);
  console.log("Live regression passed", {
    name: testCase.name,
    title: product.title,
    price: product.price,
    currency: product.currency,
    images: product.images.length,
    variants: product.variants.length,
  });
}

const nextBabyDress = await scraper.scrapeSnapshot(
  "https://www.next.ae/en/style/su759706/w59264#w59264",
  nextBabyDressSnapshot,
);
assertProduct("Next baby dress snapshot", nextBabyDress, {
  supplier: "Next",
  currency: "AED",
  minImages: 4,
  minVariants: 8,
});
console.log("Snapshot regression passed", {
  name: "Next baby dress snapshot",
  title: nextBabyDress.title,
  price: nextBabyDress.price,
  currency: nextBabyDress.currency,
  images: nextBabyDress.images.length,
  variants: nextBabyDress.variants.length,
});

await assert.rejects(
  () => scraper.scrapeSnapshot(
    "https://www.next.ae/en/style/sv124809/g44412#g44412",
    blockedNextSnapshot,
  ),
  (error: any) => error?.code === "NEXT_SIZE_VALUES_MISSING",
);
console.log("Snapshot regression passed", {
  name: "Next blocked snapshot",
  result: "refused missing size values instead of publishing One Size",
});
