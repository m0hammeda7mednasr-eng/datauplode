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
    const title = document.title?.trim();
    if (title) chunks.push(`Title: ${title}`);

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
      if (content) chunks.push(content);
    }

    const bodyText = document.body?.innerText || "";
    if (bodyText.trim()) chunks.push(bodyText);
    return chunks.join("\n\n");
  });

  return compactVisibleText(text);
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
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    const page = await context.newPage();
    await page.setExtraHTTPHeaders({
      "accept-language": envString("LOCAL_BRIDGE_ACCEPT_LANGUAGE", "en-AE,en;q=0.9,ar;q=0.8"),
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    if (settleMs > 0) await page.waitForTimeout(settleMs);

    let text = await collectVisibleText(page);
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
        text = await collectVisibleText(page);
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
