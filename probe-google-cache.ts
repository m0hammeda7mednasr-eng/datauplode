import axios from "axios";
import * as cheerio from "cheerio";

async function probe(url: string) {
  const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
  const r = await axios.get(cacheUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36" },
    timeout: 30000,
    validateStatus: () => true,
  });
  const html = String(r.data);
  console.log(url, "status", r.status, "len", html.length);
  const $ = cheerio.load(html);
  console.log("title", $('[data-testid="pdp-title"]').first().text().trim() || $("h1").first().text().trim().slice(0, 80));
  console.log("price", $('[data-testid="product-price"]').first().text().trim());
  console.log("ld+json", html.includes('"@type":"Product"') || html.includes("@type\":\"Product\""));
}

async function main() {
  const url = "https://www.next.ae/en/style/su759706/w59264";
  const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
  const r = await axios.get(cacheUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36" },
    timeout: 30000,
  });
  const html = String(r.data);
  const fs = await import("fs");
  fs.writeFileSync("cache-sample.html", html);
  console.log("White Strawberry", html.includes("White Strawberry"));
  console.log("AED", html.includes("AED"));
  console.log("xcdn", html.includes("xcdn"));
  console.log("price match", html.match(/AED\s*[\d,.]+/)?.[0]);
  await probe("https://www.next.ae/en/style/su759706/w59264");
  await probe("https://www.next.ae/en/style/sv124809/g44412");
}

main();
