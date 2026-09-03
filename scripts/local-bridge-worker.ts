import "dotenv/config";
import axios from "axios";
import { chromium } from "playwright";
import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";

type BridgeTask = {
  id: string;
  url: string;
  status: "pending" | "claimed" | "completed" | "failed";
  createdAt: string;
};

function envString(name: string, fallback = ""): string {
  const raw = String(process.env[name] || "").trim();
  return raw || fallback;
}

function envNumber(name: string, fallback: number): number {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envFlag(name: string, fallback = false): boolean {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveApiBaseUrl(): string {
  const explicit = envString("LOCAL_BRIDGE_API_BASE_URL");
  const appUrl = envString("APP_URL", "http://localhost:3000");
  const source = explicit || appUrl;
  const normalized = source.replace(/\/+$/, "");
  return normalized.endsWith("/api") ? normalized : `${normalized}/api`;
}

function compactVisibleText(input: string): string {
  return input
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isBlockedSnapshotText(text: string): boolean {
  return /Title:\s*(Access Denied|404|Page Not Found)|Target URL returned error\s+(403|404)|You don't have permission to access|404\s*\|\s*Page Not Found|Oops[,'’]?\s+something(?:'s|\s+has)?\s+gone\s+wrong|technical problem while browsing Next|security verification|captcha|access-denied|forbidden/i.test(
    text,
  );
}

function nextCookieSeed(url: string) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();

    if (host.includes("next.ae")) {
      return { country: "ae", language: path.includes("/ar/") ? "ar" : "en" };
    }
    if (host.includes("nextdirect.com")) {
      if (path.includes("/eg/ar/")) return { country: "eg", language: "ar" };
      if (path.includes("/eg/")) return { country: "eg", language: "en" };
    }
    if (host.includes("next.co.uk")) return { country: "gb", language: "en" };
    if (host.includes("next.us")) return { country: "us", language: "en" };
  } catch {
    return null;
  }

  return null;
}

async function collectVisibleText(page: import("playwright").Page) {
  const text = await page.evaluate(() => {
    const chunks: string[] = [];
    const seen = new Set<string>();
    const pushChunk = (value: unknown) => {
      const text = String(value || "").trim();
      if (!text || seen.has(text)) return;
      seen.add(text);
      chunks.push(text);
    };
    const absoluteUrl = (value: unknown) => {
      const raw = String(value || "").trim();
      if (!raw) return "";
      try {
        return new URL(raw, location.href).toString();
      } catch {
        return raw;
      }
    };
    const title = document.title?.trim();
    if (title) pushChunk(`Title: ${title}`);

    for (const script of Array.from(
      document.querySelectorAll('script[type="application/ld+json"]'),
    )) {
      try {
        const parsed = JSON.parse(script.textContent || "null");
        const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
        while (queue.length) {
          const item = queue.shift();
          if (!item || typeof item !== "object") continue;
          if (Array.isArray((item as any)["@graph"])) {
            queue.push(...(item as any)["@graph"]);
          }
          const type = (Array.isArray((item as any)["@type"])
            ? (item as any)["@type"].join(" ")
            : (item as any)["@type"] || ""
          ).toString();
          if (!/Product/i.test(type)) continue;

          pushChunk((item as any).name ? `# ${(item as any).name}` : "");
          pushChunk((item as any).sku ? `Product ID: ${(item as any).sku}` : "");
          pushChunk((item as any).productID ? `Product Code: ${(item as any).productID}` : "");
          pushChunk((item as any).description);

          const offers = Array.isArray((item as any).offers)
            ? (item as any).offers
            : (item as any).offers
              ? [(item as any).offers]
              : [];
          for (const offer of offers) {
            const price = (offer as any)?.price || (offer as any)?.lowPrice;
            const currency = (offer as any)?.priceCurrency;
            if (price) pushChunk(`Price: ${currency || ""} ${price}`.trim());
          }

          const images = Array.isArray((item as any).image)
            ? (item as any).image
            : (item as any).image
              ? [(item as any).image]
              : [];
          for (const image of images.slice(0, 16)) {
            const imageUrl =
              typeof image === "string"
                ? image
                : (image as any)?.url || (image as any)?.contentUrl;
            const resolved = absoluteUrl(imageUrl);
            if (resolved) pushChunk(`![${(item as any).name || "Product image"}](${resolved})`);
          }
        }
      } catch {}
    }

    const metaSelectors = [
      'meta[property="og:title"]',
      'meta[property="og:description"]',
      'meta[name="description"]',
    ];

    for (const selector of metaSelectors) {
      const content = document
        .querySelector(selector)
        ?.getAttribute("content")
        ?.trim();
      if (content) pushChunk(content);
    }

    const metaPrice =
      document
        .querySelector(
          'meta[property="product:price:amount"], meta[property="product:price-amount"], meta[name="product:price:amount"], meta[name="product:price-amount"], meta[property="og:price:amount"], meta[property="og:price-amount"], meta[name="price"]',
        )
        ?.getAttribute("content")
        ?.trim() || "";
    const metaCurrency =
      document
        .querySelector(
          'meta[property="product:price:currency"], meta[property="product:price-currency"], meta[name="product:price:currency"], meta[name="product:price-currency"], meta[property="og:price:currency"], meta[property="og:price-currency"], meta[name="currency"]',
        )
        ?.getAttribute("content")
        ?.trim() || "";
    if (metaPrice) pushChunk(`Price: ${metaCurrency} ${metaPrice}`.trim());

    const extractCentrepointState = () => {
      if (!location.hostname.toLowerCase().includes("centrepointstores.com")) {
        return null;
      }
      for (const script of Array.from(document.scripts)) {
        const raw = script.textContent || "";
        if (!raw.includes("initialState")) continue;
        try {
          const parsed = JSON.parse(raw);
          const encoded = parsed?.props?.initialState;
          if (!encoded || typeof encoded !== "string") continue;
          const decoded = JSON.parse(
            decodeURIComponent(
              Array.prototype.map
                .call(atob(encoded), (char: string) =>
                  `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
                )
                .join(""),
            ),
          );
          const product = decoded?.productPageReducerBL?.data;
          if (product?.id || product?.sku || product?.name) return product;
        } catch {}
      }
      return null;
    };

    const centrepointProduct = extractCentrepointState();
    if (centrepointProduct) {
      pushChunk(centrepointProduct.name ? `# ${centrepointProduct.name}` : "");
      pushChunk(
        centrepointProduct.sku ? `Product Code: ${centrepointProduct.sku}` : "",
      );
      const variants = Array.isArray(centrepointProduct.variants)
        ? centrepointProduct.variants
        : [];
      const variantPrices = variants
        .map((variant: any) => ({
          amount: Number(variant?.priceInfo?.price?.amount),
          currency:
            variant?.priceInfo?.price?.currency ||
            variant?.priceInfo?.priceTypeDetails?.salePrice?.bestPrice
              ?.currency ||
            variant?.priceInfo?.priceTypeDetails?.basePrice?.bestPrice
              ?.currency,
        }))
        .filter(
          (price: any) =>
            Number.isFinite(price.amount) &&
            price.amount > 0 &&
            String(price.currency || "AED").toUpperCase() === "AED",
        );
      const lowestVariantPrice = variantPrices.length
        ? Math.min(...variantPrices.map((price: any) => price.amount))
        : 0;
      const statePrice =
        lowestVariantPrice ||
        centrepointProduct?.priceInfo?.price?.amount ||
        centrepointProduct?.price?.amount ||
        centrepointProduct?.priceInfo?.priceTypeDetails?.salePrice?.bestPrice
          ?.amount ||
        centrepointProduct?.priceInfo?.priceTypeDetails?.basePrice?.bestPrice
          ?.amount;
      const stateCurrency =
        centrepointProduct?.priceInfo?.price?.currency ||
        centrepointProduct?.price?.currency ||
        centrepointProduct?.currency ||
        "AED";
      if (statePrice) pushChunk(`Price: ${stateCurrency} ${statePrice}`.trim());
      const basePrice =
        centrepointProduct?.priceInfo?.priceTypeDetails?.basePrice?.bestPrice
          ?.amount ||
        Math.max(
          0,
          ...variants
            .map(
              (variant: any) =>
                Number(
                  variant?.priceInfo?.priceTypeDetails?.basePrice?.bestPrice
                    ?.amount,
                ) || 0,
            )
            .filter((price: number) => price > 0),
        );
      if (basePrice && basePrice !== statePrice) {
        pushChunk(`Original price: ${stateCurrency} ${basePrice}`.trim());
      }
      const options = Array.isArray(centrepointProduct.options)
        ? centrepointProduct.options
        : [];
      for (const option of options) {
        const optionName = String(
          option?.label || option?.attributeChoice?.attributeName || "",
        );
        const values = Array.isArray(option?.attributeChoice?.allowedValues)
          ? option.attributeChoice.allowedValues
          : [];
        for (const value of values) {
          const label = String(value?.label || value?.value || "").trim();
          if (!label) continue;
          if (/size/i.test(optionName)) pushChunk(label);
          else if (/colou?r/i.test(optionName)) pushChunk(`Color: ${label}`);
        }
      }
      for (const variant of variants.slice(0, 40)) {
        const size = String(variant?.optionValues?.Size || "").trim();
        if (size) pushChunk(size);
        const variantPrice = variant?.priceInfo?.price?.amount;
        const variantCurrency =
          variant?.priceInfo?.price?.currency || stateCurrency;
        if (variantPrice) {
          pushChunk(`Price: ${variantCurrency} ${variantPrice}`.trim());
        }
      }
    }

    const bodyText = document.body?.innerText || "";
    if (bodyText.trim()) pushChunk(bodyText);

    const pushImageUrl = (rawUrl: unknown, alt = "Product image") => {
      const resolved = absoluteUrl(rawUrl);
      if (resolved && /^https?:\/\//i.test(resolved)) {
        pushChunk(`![${alt}](${resolved})`);
      }
    };

    const firstSrcsetUrl = (value: unknown) =>
      String(value || "")
        .split(",")
        .map((part) => part.trim().split(/\s+/)[0])
        .find(Boolean) || "";

    for (const image of Array.from(document.images).slice(0, 120)) {
      const alt = image.alt || "Product image";
      pushImageUrl(image.currentSrc || image.src, alt);
      pushImageUrl(image.getAttribute("data-src"), alt);
      pushImageUrl(image.getAttribute("data-original"), alt);
      pushImageUrl(image.getAttribute("data-lazy-src"), alt);
      pushImageUrl(image.getAttribute("data-image"), alt);
      pushImageUrl(firstSrcsetUrl(image.getAttribute("srcset")), alt);
      pushImageUrl(firstSrcsetUrl(image.getAttribute("data-srcset")), alt);
    }

    for (const node of Array.from(document.querySelectorAll<HTMLElement>("*")).slice(
      0,
      2000,
    )) {
      const style = getComputedStyle(node);
      const background = style.backgroundImage || "";
      for (const match of background.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) {
        pushImageUrl(match[1], node.getAttribute("aria-label") || "Product image");
      }
    }
    return chunks.join("\n\n");
  });

  return compactVisibleText(text);
}

async function warmUpLazyAssets(page: import("playwright").Page, settleMs: number) {
  const passes = Math.max(0, envNumber("LOCAL_BRIDGE_SCROLL_PASSES", 4));
  if (passes <= 0) return;
  const stepMs = Math.max(100, envNumber("LOCAL_BRIDGE_SCROLL_STEP_MS", 450));

  for (let pass = 0; pass < passes; pass += 1) {
    try {
      await page.evaluate(() => {
        window.scrollBy(0, Math.max(500, Math.floor(window.innerHeight * 0.85)));
      });
    } catch (error: any) {
      if (/Execution context was destroyed|navigation/i.test(String(error?.message || error))) {
        await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
      } else {
        throw error;
      }
    }
    await page.waitForTimeout(stepMs);
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch((error: any) => {
    if (!/Execution context was destroyed|navigation/i.test(String(error?.message || error))) {
      throw error;
    }
  });
  if (settleMs > 0) await page.waitForTimeout(Math.min(settleMs, 2000));
}

async function collectVisibleTextWithRetry(
  page: import("playwright").Page,
  settleMs: number,
) {
  const attempts = Math.max(1, envNumber("LOCAL_BRIDGE_CAPTURE_RETRIES", 3));
  let lastError: any = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (attempt > 0) {
        await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
        if (settleMs > 0) await page.waitForTimeout(Math.min(settleMs, 2000));
      }
      return await collectVisibleText(page);
    } catch (error: any) {
      lastError = error;
      const message = String(error?.message || error);
      if (!/Execution context was destroyed|navigation/i.test(message)) throw error;
      await page.waitForTimeout(750);
    }
  }
  throw lastError;
}

async function waitForCentrepointProductState(page: import("playwright").Page) {
  if (!page.url().toLowerCase().includes("centrepointstores.com")) return;
  const waitMs = Math.max(
    0,
    Math.min(30000, envNumber("LOCAL_BRIDGE_CENTREPOINT_STATE_WAIT_MS", 10000)),
  );
  if (waitMs <= 0) return;

  await page
    .waitForFunction(
      () => {
        if (!location.hostname.toLowerCase().includes("centrepointstores.com")) {
          return true;
        }
        for (const script of Array.from(document.scripts)) {
          const raw = script.textContent || "";
          if (!raw.includes("initialState")) continue;
          try {
            const parsed = JSON.parse(raw);
            const encoded = parsed?.props?.initialState;
            if (!encoded || typeof encoded !== "string") continue;
            const decoded = JSON.parse(
              decodeURIComponent(
                Array.prototype.map
                  .call(atob(encoded), (char: string) =>
                    `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
                  )
                  .join(""),
              ),
            );
            const product = decoded?.productPageReducerBL?.data;
            const price =
              product?.priceInfo?.price?.amount ||
              product?.price?.amount ||
              product?.priceInfo?.priceTypeDetails?.salePrice?.bestPrice
                ?.amount ||
              product?.priceInfo?.priceTypeDetails?.basePrice?.bestPrice
                ?.amount ||
              (Array.isArray(product?.variants)
                ? product.variants.find(
                    (variant: any) =>
                      Number(variant?.priceInfo?.price?.amount) > 0,
                  )?.priceInfo?.price?.amount
                : 0);
            const currency =
              product?.priceInfo?.price?.currency ||
              product?.price?.currency ||
              product?.currency ||
              "AED";
            return (
              (product?.id || product?.sku || product?.name) &&
              Number(price) > 0 &&
              String(currency || "").toUpperCase() === "AED"
            );
          } catch {}
        }
        return false;
      },
      null,
      { timeout: waitMs, polling: 500 },
    )
    .catch(() => {});
}

async function capturePageText(url: string, timeoutMs: number, settleMs: number) {
  const headless = envFlag("LOCAL_BRIDGE_HEADLESS", true);
  const browser = await chromium.launch({
    headless,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    const context = await browser.newContext({
      userAgent:
        envString(
          "LOCAL_BRIDGE_USER_AGENT",
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        ),
      viewport: { width: 390, height: 844 },
      locale: envString("LOCAL_BRIDGE_LOCALE", "en-AE"),
    });
    const nextSeed = nextCookieSeed(url);
    if (nextSeed) {
      const parsed = new URL(url);
      const domain = `.${parsed.hostname.replace(/^www\./i, "")}`;
      await context.addCookies([
        {
          name: "Country",
          value: nextSeed.country,
          domain,
          path: "/",
        },
        {
          name: "Language",
          value: nextSeed.language,
          domain,
          path: "/",
        },
        {
          name: "OptanonAlertBoxClosed",
          value: "2024-01-01T00:00:00.000Z",
          domain,
          path: "/",
        },
      ]);
    }
    await context.addInitScript(
      "window.__name = window.__name || function(target) { return target; };",
    );
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    const page = await context.newPage();
    await page.setExtraHTTPHeaders({
      "accept-language": envString("LOCAL_BRIDGE_ACCEPT_LANGUAGE", "en-AE,en;q=0.9,ar;q=0.8"),
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: 7000 }).catch(() => {});
    await waitForCentrepointProductState(page);
    if (settleMs > 0) await page.waitForTimeout(settleMs);
    await warmUpLazyAssets(page, settleMs);

    let text = await collectVisibleTextWithRetry(page, settleMs);
    const allowInteractiveSolve = envFlag("LOCAL_BRIDGE_ALLOW_INTERACTIVE_SOLVE", true);
    const interactiveWaitMs = Math.max(
      10000,
      envNumber("LOCAL_BRIDGE_INTERACTIVE_WAIT_MS", 90000),
    );
    const interactivePollMs = Math.max(
      2000,
      envNumber("LOCAL_BRIDGE_INTERACTIVE_POLL_MS", 5000),
    );

    if (!headless && allowInteractiveSolve && isBlockedSnapshotText(text)) {
      console.warn(
        `[bridge] blocked page detected for ${url}. Solve challenge in the opened browser window (if shown). Waiting up to ${Math.round(
          interactiveWaitMs / 1000,
        )}s...`,
      );

      const start = Date.now();
      while (Date.now() - start < interactiveWaitMs) {
        await page.waitForTimeout(interactivePollMs);
        await warmUpLazyAssets(page, settleMs);
        text = await collectVisibleTextWithRetry(page, settleMs);
        if (!isBlockedSnapshotText(text)) break;
      }
    }

    if (isBlockedSnapshotText(text)) {
      const finalUrl = page.url();
      throw Object.assign(
        new Error(
          `Blocked snapshot page after interactive wait (url: ${finalUrl}).`,
        ),
        { code: "BRIDGE_BLOCKED_SNAPSHOT", status: 422 },
      );
    }

    await page.close();
    await context.close();
    return text;
  } finally {
    await browser.close();
  }
}

async function promptForManualSnapshot(taskUrl: string): Promise<string> {
  console.log(
    `[bridge] manual fallback: open this URL in your normal browser and copy all visible product text:\n${taskUrl}`,
  );
  console.log(
    `[bridge] paste the copied text below. Type ::end on a new line when done.`,
  );

  const rl = createInterface({ input, output });
  const lines: string[] = [];

  return await new Promise<string>((resolve) => {
    rl.on("line", (line) => {
      if (line.trim() === "::end") {
        rl.close();
        resolve(compactVisibleText(lines.join("\n")));
        return;
      }
      lines.push(line);
    });
  });
}

async function run() {
  const apiBaseUrl = resolveApiBaseUrl();
  const token = envString("LOCAL_BRIDGE_TOKEN");
  const pollMs = Math.max(1000, envNumber("LOCAL_BRIDGE_POLL_MS", 2500));
  const timeoutMs = Math.max(5000, envNumber("LOCAL_BRIDGE_NAV_TIMEOUT_MS", 30000));
  const settleMs = Math.max(0, envNumber("LOCAL_BRIDGE_CAPTURE_WAIT_MS", 1200));
  const maxChars = Math.max(20000, envNumber("LOCAL_BRIDGE_MAX_TEXT_CHARS", 180000));
  const promptOnBlocked = envFlag("LOCAL_BRIDGE_PROMPT_ON_BLOCKED", true);

  const client = axios.create({
    baseURL: apiBaseUrl,
    timeout: Math.max(10000, envNumber("LOCAL_BRIDGE_HTTP_TIMEOUT_MS", 45000)),
    validateStatus: () => true,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "x-bridge-token": token } : {}),
    },
  });

  console.log(`[bridge] worker started -> ${apiBaseUrl}`);
  console.log(`[bridge] poll=${pollMs}ms timeout=${timeoutMs}ms headless=${envFlag("LOCAL_BRIDGE_HEADLESS", true)}`);

  while (true) {
    try {
      const claimResponse = await client.post("/bridge/tasks/claim", {});

      if (claimResponse.status === 204) {
        await sleep(pollMs);
        continue;
      }

      if (claimResponse.status === 404) {
        console.warn("[bridge] disabled on server. Enable LOCAL_BRIDGE_ENABLED=true.");
        await sleep(Math.max(5000, pollMs));
        continue;
      }

      if (claimResponse.status === 401 || claimResponse.status === 503) {
        console.error(
          `[bridge] auth/config error (${claimResponse.status}): ${
            claimResponse.data?.error || "check LOCAL_BRIDGE_TOKEN"
          }`,
        );
        await sleep(Math.max(7000, pollMs));
        continue;
      }

      if (claimResponse.status < 200 || claimResponse.status >= 300) {
        console.error(
          `[bridge] claim failed (${claimResponse.status}): ${
            claimResponse.data?.error || claimResponse.statusText
          }`,
        );
        await sleep(pollMs);
        continue;
      }

      const task = claimResponse.data as BridgeTask;
      if (!task?.id || !task?.url) {
        await sleep(pollMs);
        continue;
      }

      console.log(`[bridge] claimed ${task.id} -> ${task.url}`);
      let pageText = "";
      try {
        const captured = await capturePageText(task.url, timeoutMs, settleMs);
        pageText = captured.slice(0, maxChars).trim();
      } catch (captureError: any) {
        if (captureError?.code === "BRIDGE_BLOCKED_SNAPSHOT" && promptOnBlocked) {
          const manualText = await promptForManualSnapshot(task.url);
          pageText = manualText.slice(0, maxChars).trim();
        } else if (captureError?.code === "BRIDGE_BLOCKED_SNAPSHOT") {
          pageText = compactVisibleText(
            [
              "Title: Access Denied",
              `Source URL: ${task.url}`,
              captureError?.message || "Blocked snapshot page.",
            ].join("\n"),
          );
        } else {
          throw captureError;
        }
      }

      if (!pageText) {
        console.error(`[bridge] empty page text for task ${task.id}; waiting for task reclaim`);
        await sleep(pollMs);
        continue;
      }

      const submitResponse = await client.post(`/bridge/tasks/${task.id}/submit`, { pageText });
      if (submitResponse.status >= 200 && submitResponse.status < 300) {
        console.log(`[bridge] completed ${task.id}`);
      } else {
        console.error(
          `[bridge] submit failed (${submitResponse.status}) for ${task.id}: ${
            submitResponse.data?.error || submitResponse.statusText
          }`,
        );
      }
    } catch (error: any) {
      console.error(`[bridge] runtime error: ${error?.message || String(error)}`);
    }

    await sleep(pollMs);
  }
}

run().catch((error) => {
  console.error("[bridge] fatal error:", error);
  process.exit(1);
});
