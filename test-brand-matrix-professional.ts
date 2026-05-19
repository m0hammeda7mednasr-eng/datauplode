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
  { brand: "Other", name: "Other A", url: "https://ae.carters.com/purelysoft-baby-girls-flamingo-print-dress-ivory-1u662210/", kind: "primary" },
  { brand: "Other", name: "Other B", url: "https://ae.carters.com/baby-girls-polar-bear-jumpsuit-1r102510/", kind: "secondary" },

  { brand: "Next", name: "Next A", url: "https://www.next.ae/en/style/su759706/w59264#w59264", kind: "primary" },
  { brand: "Next", name: "Next B", url: "https://www.next.ae/en/style/sv124809/g44412#g44412", kind: "secondary" },

  { brand: "Max Fashion", name: "Max A", url: "https://www.maxfashion.com/ae/en/buy-stitch-embroidered-denim-dungaree-with-tshirt/p/B26KIBFEDTRDUNG147MULTICOLORMEDIUM", kind: "primary" },
  { brand: "Max Fashion", name: "Max B", url: "https://www.maxfashion.com/ae/en/buy-minnie-mouse-print-tshirt-and-short-leggings-set/p/B26KIGFECHAR324AEEXWHITELIGHT", kind: "secondary" },

  { brand: "SHEIN", name: "SHEIN A", url: "https://ar.shein.com/SHEIN-3pcs-Set-Unisex-Baby-Boy-Girl-Cute-Bear-Pattern-Blue-Sleeveless-Vest-White-Short-Sleeve-Shirt-And-Navy-Blue-Shorts-Set-Spring-Summer-Baby-Boy-Clothes-Outfits-Easter-Gift-Sthings-For-Baby-Toddler-Summer-Outfits-Toddler-Two-Piece-Set-p-380067052.html", kind: "primary" },
  { brand: "SHEIN", name: "SHEIN B", url: "https://ar.shein.com/SHEIN-3pcs-Set-Unisex-Baby-Boy-Girl-Cute-Bear-Pattern-Blue-Sleeveless-Vest-White-Short-Sleeve-Shirt-And-Navy-Blue-Shorts-Set-Spring-Summer-Baby-Boy-Clothes-Outfits-Easter-Gift-Sthings-For-Baby-Toddler-Summer-Outfits-Toddler-Two-Piece-Set-p-380067052.html?variant=secondary", kind: "secondary" },
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
