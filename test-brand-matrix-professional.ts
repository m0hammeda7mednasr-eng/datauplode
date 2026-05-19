import { writeFileSync } from "node:fs";
import { ScraperService } from "./src/server/services/scraper";

type BrandCase = {
  brand: string;
  name: string;
  url: string;
  kind: "primary" | "secondary";
};

type Row = {
  brand: string;
  name: string;
  url: string;
  kind: "primary" | "secondary";
  status: "ok" | "manual_snapshot_required" | "low_quality" | "failed";
  durationMs: number;
  title?: string;
  price?: number;
  currency?: string;
  images?: number;
  variants?: number;
  code?: string;
  error?: string;
};

const CASES: BrandCase[] = [
  { brand: "Next", name: "Next A", url: "https://www.next.ae/en/style/su759706/w59264#w59264", kind: "primary" },
  { brand: "Next", name: "Next B", url: "https://www.next.ae/en/style/sv124809/g44412#g44412", kind: "secondary" },

  { brand: "Max Fashion", name: "Max A", url: "https://www.maxfashion.com/ae/en/buy-stitch-embroidered-denim-dungaree-with-tshirt/p/B26KIBFEDTRDUNG147MULTICOLORMEDIUM", kind: "primary" },
  { brand: "Max Fashion", name: "Max B", url: "https://www.maxfashion.com/ae/en/buy-minnie-mouse-print-tshirt-and-short-leggings-set/p/B26KIGFECHAR324AEEXWHITELIGHT", kind: "secondary" },

  { brand: "Marks & Spencer", name: "M&S A", url: "https://www.marksandspencerme.com/en-ae/l/denim-striped-bibshort-with-t-shirt-0-3-yrs-/p/T784681D", kind: "primary" },
  { brand: "Marks & Spencer", name: "M&S B", url: "https://www.marksandspencerme.com/en-ae/l/pure-cotton-romper-with-bib-0-3-yrs-/p/T784671D", kind: "secondary" },

  { brand: "H&M", name: "H&M A", url: "https://eg.hm.com/en/buy-2-piece-cotton-set-light-blue-cream", kind: "primary" },
  { brand: "H&M", name: "H&M B", url: "https://ae.hm.com/en/buy-2-piece-set-light-blue-white-striped", kind: "secondary" },

  { brand: "Lefties", name: "Lefties A", url: "https://www.lefties.com/xe/kids/girl/new-in/embroidered-textured-dress-c1030267676p732631353.html?colorId=653&parentId=732634941", kind: "primary" },
  { brand: "Lefties", name: "Lefties B", url: "https://www.lefties.com/ae/woman/shoes/minimalist-chunky-sole-sneaker-c1030267545p730276495.html", kind: "secondary" },

  { brand: "Centrepoint", name: "Centrepoint A", url: "https://www.centrepointstores.com/ae/en/buy-juniors-round-neck-short-sleeve-tshirt-and-dungaree-set-with-alligator-applique/p/K31-A15-13-427MULTICOLORMULTISHADE", kind: "primary" },
  { brand: "Centrepoint", name: "Centrepoint B", url: "https://www.centrepointstores.com/ae/en/buy-juniors-round-neck-short-sleeve-tshirt-and-dungaree-set-with-alligator-applique/p/K31-A15-13-427MULTICOLORMULTISHADE#secondary", kind: "secondary" },

  { brand: "Gap", name: "Gap A", url: "https://www.gap.ae/product/218613975", kind: "primary" },
  { brand: "Gap", name: "Gap B", url: "https://www.gap.ae/product/218849564", kind: "secondary" },

  { brand: "Zara", name: "Zara A", url: "https://www.zara.com/ae/en/-p01473692.html?v1=511134201", kind: "primary" },
  { brand: "Zara", name: "Zara B", url: "https://www.zara.com/ae/en/-p01473692.html?v1=511134201#secondary", kind: "secondary" },

  { brand: "Adidas", name: "Adidas A", url: "https://www.adidas.ae/en/adidas-disney-sl-72-rs-elastic-lace-shoes/IH1707.html", kind: "primary" },
  { brand: "Adidas", name: "Adidas B", url: "https://www.adidas.ae/en/clot-samba-by-edison-chen-trainers/KJ0274.html", kind: "secondary" },

  { brand: "Primark", name: "Primark A", url: "https://www.primark.com/en-us/p/0-36mths-shirred-top-and-shorts-set-blue-991167715505", kind: "primary" },
  { brand: "Primark", name: "Primark B", url: "https://www.primark.com/en-us/p/0-36mths-shirred-top-and-shorts-set-blue-991167715505#secondary", kind: "secondary" },

  { brand: "Mothercare", name: "Mothercare A", url: "https://www.mothercare.ae/en/buy-3-pack-mothercare-newborn-bibs-4", kind: "primary" },
  { brand: "Mothercare", name: "Mothercare B", url: "https://www.mothercare.ae/en/buy-3-pack-mothercare-newborn-bibs-4#secondary", kind: "secondary" },

  { brand: "SHEIN", name: "SHEIN A", url: "https://ar.shein.com/SHEIN-3pcs-Set-Unisex-Baby-Boy-Girl-Cute-Bear-Pattern-Blue-Sleeveless-Vest-White-Short-Sleeve-Shirt-And-Navy-Blue-Shorts-Set-Spring-Summer-Baby-Boy-Clothes-Outfits-Easter-Gift-Sthings-For-Baby-Toddler-Summer-Outfits-Toddler-Two-Piece-Set-p-380067052.html", kind: "primary" },
  { brand: "SHEIN", name: "SHEIN B", url: "https://ar.shein.com/SHEIN-3pcs-Set-Unisex-Baby-Boy-Girl-Cute-Bear-Pattern-Blue-Sleeveless-Vest-White-Short-Sleeve-Shirt-And-Navy-Blue-Shorts-Set-Spring-Summer-Baby-Boy-Clothes-Outfits-Easter-Gift-Sthings-For-Baby-Toddler-Summer-Outfits-Toddler-Two-Piece-Set-p-380067052.html?variant=secondary", kind: "secondary" },

  { brand: "Other", name: "Other A", url: "https://ae.carters.com/purelysoft-baby-girls-flamingo-print-dress-ivory-1u662210/", kind: "primary" },
  { brand: "Other", name: "Other B", url: "https://ae.carters.com/purelysoft-baby-girls-flamingo-print-dress-ivory-1u662210/#secondary", kind: "secondary" },
];

function isLowQuality(product: any): boolean {
  const title = String(product?.title || "").trim();
  const price = Number(product?.price || 0);
  const images = Number(product?.images?.length || 0);

  return (
    !title ||
    /(access denied|challenge|captcha|metadata|just a moment)/i.test(title) ||
    !Number.isFinite(price) ||
    price <= 0 ||
    images <= 0
  );
}

async function main() {
  const scraper = new ScraperService();
  const rows: Row[] = [];

  for (const c of CASES) {
    const start = Date.now();
    try {
      const product: any = await scraper.scrape(c.url);
      const lowQuality = isLowQuality(product);
      rows.push({
        brand: c.brand,
        name: c.name,
        url: c.url,
        kind: c.kind,
        status: lowQuality ? "low_quality" : "ok",
        durationMs: Date.now() - start,
        title: product?.title,
        price: product?.price,
        currency: product?.currency,
        images: product?.images?.length || 0,
        variants: product?.variants?.length || 0,
      });
    } catch (error: any) {
      const snapshot =
        error?.retryWithSnapshot === true || error?.code === "SOURCE_BLOCKED";
      rows.push({
        brand: c.brand,
        name: c.name,
        url: c.url,
        kind: c.kind,
        status: snapshot ? "manual_snapshot_required" : "failed",
        durationMs: Date.now() - start,
        code: error?.code,
        error: error?.message || String(error),
      });
    }
  }

  const brands = [...new Set(rows.map((r) => r.brand))];
  const summary = brands.map((brand) => {
    const list = rows.filter((r) => r.brand === brand);
    const ok = list.filter((r) => r.status === "ok").length;
    const lowQuality = list.filter((r) => r.status === "low_quality").length;
    const snapshotRequired = list.filter(
      (r) => r.status === "manual_snapshot_required",
    ).length;
    const failed = list.filter((r) => r.status === "failed").length;
    return {
      brand,
      ok,
      lowQuality,
      snapshotRequired,
      failed,
      total: list.length,
      professionalReady: failed === 0 && lowQuality === 0,
    };
  });

  const output = {
    generatedAt: new Date().toISOString(),
    totalCases: rows.length,
    summary,
    rows,
  };

  writeFileSync(
    "brand-matrix-results.json",
    JSON.stringify(output, null, 2),
    "utf8",
  );
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

