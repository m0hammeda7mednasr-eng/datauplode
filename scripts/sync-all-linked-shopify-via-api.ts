import "dotenv/config";
import { appendFile, readFile } from "node:fs/promises";

type LinkStateItem = {
  sourceProductId?: string | null;
  title?: string | null;
  vendor?: string | null;
  sourceUrl?: string | null;
  syncEnabled?: boolean;
  syncStatus?: string | null;
};

type SyncJob = {
  id: string;
  status: string;
  result?: string | null;
};

const apiBase = String(
  process.env.SYNC_ALL_API_BASE || "https://datauplode-production.up.railway.app/api",
).replace(/\/$/, "");
const checkpointPath = String(
  process.env.SYNC_ALL_CHECKPOINT || "C:/tmp/all-shopify-sync-2026-09-23.jsonl",
);
const batchSize = positiveInt("SYNC_ALL_BATCH_SIZE", 20, 1, 30);
const queueConcurrency = positiveInt("SYNC_ALL_QUEUE_CONCURRENCY", 5, 1, 10);
const pollSeconds = positiveInt("SYNC_ALL_POLL_SECONDS", 3, 2, 30);
const batchTimeoutMinutes = positiveInt("SYNC_ALL_BATCH_TIMEOUT_MINUTES", 20, 2, 60);

function positiveInt(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clean(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseResult(value: string | null | undefined) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: init?.signal || AbortSignal.timeout(60_000),
  });
  const body = await response.text();
  let parsed: any = {};
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    parsed = { error: body.slice(0, 500) };
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${clean(parsed.error || parsed.message || body)}`);
  }
  return parsed as T;
}

async function fetchJsonRead<T>(url: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetchJson<T>(url);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  throw lastError;
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

async function loadCatalog() {
  const pageSize = 250;
  const first = await fetchJsonRead<any>(`${apiBase}/shopify-catalog/link-state?offset=0&limit=${pageSize}`);
  const total = Number(first.filteredTotal || first.counts?.shopifyTotal || 0);
  const pages = [first];
  for (let offset = pageSize; offset < total; offset += pageSize * 2) {
    const offsets: number[] = [];
    for (let pageOffset = offset; pageOffset < Math.min(total, offset + pageSize * 2); pageOffset += pageSize) {
      offsets.push(pageOffset);
    }
    pages.push(...await mapConcurrent(offsets, 2, (pageOffset) =>
      fetchJsonRead<any>(`${apiBase}/shopify-catalog/link-state?offset=${pageOffset}&limit=${pageSize}`),
    ));
    console.log(JSON.stringify({ event: "catalog_snapshot", loaded: Math.min(total, offset + pageSize * 2), total }));
  }

  const unique = new Map<string, LinkStateItem>();
  for (const item of pages.flatMap((page) => page.items || []) as LinkStateItem[]) {
    const sourceProductId = clean(item.sourceProductId);
    if (
      sourceProductId &&
      item.syncEnabled === true &&
      clean(item.syncStatus).toLowerCase() === "active" &&
      clean(item.sourceUrl) &&
      !unique.has(sourceProductId)
    ) {
      unique.set(sourceProductId, item);
    }
  }
  return [...unique.entries()].map(([sourceProductId, item]) => ({ sourceProductId, ...item }));
}

async function completedFromCheckpoint() {
  const completed = new Set<string>();
  try {
    const text = await readFile(checkpointPath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row.sourceProductId && ["completed", "failed", "queue_failed"].includes(row.status)) {
          completed.add(String(row.sourceProductId));
        }
      } catch {}
    }
  } catch {}
  return completed;
}

async function waitForBatch(queued: Array<{ sourceProductId: string; title: string; jobId: string }>) {
  const pending = new Map(queued.map((row) => [row.jobId, row]));
  const terminal = new Map<string, SyncJob>();
  const deadline = Date.now() + batchTimeoutMinutes * 60 * 1000;

  while (pending.size > 0 && Date.now() < deadline) {
    const jobs = await fetchJsonRead<SyncJob[]>(`${apiBase}/sync-jobs`);
    for (const job of jobs) {
      if (!pending.has(job.id)) continue;
      if (job.status === "completed" || job.status === "failed") {
        terminal.set(job.id, job);
        pending.delete(job.id);
      }
    }
    if (pending.size > 0) await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
  }

  return { terminal, pending };
}

async function main() {
  const catalog = await loadCatalog();
  const alreadyDone = await completedFromCheckpoint();
  const remaining = catalog.filter((item) => !alreadyDone.has(item.sourceProductId));
  const totals = {
    catalog: catalog.length,
    resumed: alreadyDone.size,
    queued: 0,
    completed: 0,
    failed: 0,
    queueFailed: 0,
    timedOut: 0,
    variantsChecked: 0,
    pricesUpdated: 0,
    variantsUpdated: 0,
    inStock: 0,
    outOfStock: 0,
  };

  console.log(JSON.stringify({ event: "start", ...totals, remaining: remaining.length }));

  for (let offset = 0; offset < remaining.length; offset += batchSize) {
    const batch = remaining.slice(offset, offset + batchSize);
    const queued = (await mapConcurrent(batch, queueConcurrency, async (item) => {
      try {
        const response = await fetchJson<{ jobId: string }>(
          `${apiBase}/products/${encodeURIComponent(item.sourceProductId)}/sync`,
          { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        );
        totals.queued += 1;
        return { sourceProductId: item.sourceProductId, title: clean(item.title), jobId: response.jobId };
      } catch (error: any) {
        totals.queueFailed += 1;
        await appendFile(checkpointPath, `${JSON.stringify({
          at: new Date().toISOString(),
          sourceProductId: item.sourceProductId,
          title: clean(item.title),
          status: "queue_failed",
          error: clean(error?.message || error),
        })}\n`, "utf8");
        return null;
      }
    })).filter((value): value is { sourceProductId: string; title: string; jobId: string } => Boolean(value));

    const { terminal, pending } = await waitForBatch(queued);
    for (const row of queued) {
      const job = terminal.get(row.jobId);
      if (!job) continue;
      const result = parseResult(job.result);
      if (job.status === "completed") {
        totals.completed += 1;
        totals.variantsChecked += Number(result.variantsChecked || 0);
        totals.pricesUpdated += Number(result.pricesUpdated || 0);
        totals.variantsUpdated += Number(result.variantsUpdated || 0);
        totals.inStock += Number(result.inStock || 0);
        totals.outOfStock += Number(result.outOfStock || 0);
      } else {
        totals.failed += 1;
      }
      await appendFile(checkpointPath, `${JSON.stringify({
        at: new Date().toISOString(),
        sourceProductId: row.sourceProductId,
        title: row.title,
        jobId: row.jobId,
        status: job.status,
        result,
      })}\n`, "utf8");
    }

    for (const [jobId, row] of pending) {
      totals.timedOut += 1;
      await appendFile(checkpointPath, `${JSON.stringify({
        at: new Date().toISOString(),
        sourceProductId: row.sourceProductId,
        title: row.title,
        jobId,
        status: "timeout",
      })}\n`, "utf8");
    }

    console.log(JSON.stringify({
      event: "batch",
      processed: Math.min(offset + batch.length, remaining.length),
      remaining: Math.max(0, remaining.length - offset - batch.length),
      ...totals,
    }));
  }

  console.log(JSON.stringify({ event: "complete", ...totals, checkpointPath }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
