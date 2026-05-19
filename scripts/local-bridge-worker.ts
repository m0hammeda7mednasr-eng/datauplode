import "dotenv/config";
import axios from "axios";
import { chromium } from "playwright";

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

async function capturePageText(url: string, timeoutMs: number, settleMs: number) {
  const browser = await chromium.launch({ headless: envFlag("LOCAL_BRIDGE_HEADLESS", true) });
  try {
    const context = await browser.newContext({
      userAgent:
        envString(
          "LOCAL_BRIDGE_USER_AGENT",
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        ),
      viewport: { width: 1366, height: 920 },
      locale: envString("LOCAL_BRIDGE_LOCALE", "en-US"),
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    if (settleMs > 0) await page.waitForTimeout(settleMs);

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

    await page.close();
    await context.close();
    return compactVisibleText(text);
  } finally {
    await browser.close();
  }
}

async function run() {
  const apiBaseUrl = resolveApiBaseUrl();
  const token = envString("LOCAL_BRIDGE_TOKEN");
  const pollMs = Math.max(1000, envNumber("LOCAL_BRIDGE_POLL_MS", 2500));
  const timeoutMs = Math.max(5000, envNumber("LOCAL_BRIDGE_NAV_TIMEOUT_MS", 30000));
  const settleMs = Math.max(0, envNumber("LOCAL_BRIDGE_CAPTURE_WAIT_MS", 1200));
  const maxChars = Math.max(20000, envNumber("LOCAL_BRIDGE_MAX_TEXT_CHARS", 180000));

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
      const captured = await capturePageText(task.url, timeoutMs, settleMs);
      const pageText = captured.slice(0, maxChars).trim();

      if (!pageText) {
        console.error(`[bridge] empty page text for task ${task.id}`);
        await client.post(`/bridge/tasks/${task.id}/submit`, {
          pageText: "Page opened but no visible text was captured.",
        });
        await sleep(1000);
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
