const CONFIRMATION = "ENFORCE_NEXT_CENTREPOINT_ACTIVE_SYNC";

let started = false;
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function positiveInt(name: string, fallback: number, min: number, max: number) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function endpoint() {
  const configuredBase = String(process.env.ACTIVE_SYNC_COLLECTION_POLICY_BASE_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (configuredBase) {
    return `${configuredBase}/api/shopify/catalog/enforce-active-sync-collections`;
  }
  const railwayDomain = String(process.env.RAILWAY_PUBLIC_DOMAIN || "").trim();
  if (railwayDomain) {
    return `https://${railwayDomain}/api/shopify/catalog/enforce-active-sync-collections`;
  }
  const port = Number(process.env.PORT || 8080);
  return `http://127.0.0.1:${port}/api/shopify/catalog/enforce-active-sync-collections`;
}

async function postPolicy(body: Record<string, unknown>, token?: string) {
  const response = await fetch(endpoint(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-catalog-audit-write-token": token } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(payload?.error || `Collection policy HTTP ${response.status}`));
  }
  return payload;
}

async function runCycle() {
  if (running) return;
  running = true;
  const startedAt = Date.now();
  console.log("[active-sync-policy] cycle started");
  try {
    const token = String(process.env.CATALOG_AUDIT_WRITE_TOKEN || "").trim();
    if (!token) throw new Error("CATALOG_AUDIT_WRITE_TOKEN is not configured");

    const plan = await postPolicy({ dryRun: true });
    const toEnable = Number(plan?.toEnable || 0);
    const toDisable = Number(plan?.toDisable || 0);
    let applied = null;
    if (toEnable > 0 || toDisable > 0) {
      applied = await postPolicy({
        dryRun: false,
        confirm: CONFIRMATION,
        expectedPlanHash: plan.planHash,
        expectedToEnable: toEnable,
        expectedToDisable: toDisable,
      }, token);
    }

    console.log(JSON.stringify({
      worker: "active-sync-collection-policy-worker",
      allowedCollectionProducts: Number(plan?.allowedCollectionProducts || 0),
      allowedLinkedActiveProducts: Number(plan?.allowedLinkedActiveProducts || 0),
      toEnable,
      toDisable,
      applied: Boolean(applied),
      activeAllowedAfter: Number(applied?.activeAllowedAfter ?? plan?.currentlyActiveAllowed ?? 0),
      activeOutsideAfter: Number(applied?.activeOutsideAfter ?? plan?.currentlyActiveOutside ?? 0),
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
    }));
  } catch (error: any) {
    console.error("[active-sync-policy] cycle failed:", String(error?.message || error));
  } finally {
    running = false;
  }
}

function scheduleNext(delayMs: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    await runCycle();
    const minutes = positiveInt("ACTIVE_SYNC_COLLECTION_POLICY_INTERVAL_MINUTES", 10, 2, 1440);
    scheduleNext(minutes * 60_000);
  }, delayMs);
  timer.unref?.();
}

export function startActiveSyncCollectionPolicyWorker() {
  if (started) return;
  started = true;
  if (process.env.ACTIVE_SYNC_COLLECTION_POLICY_AUTOSTART !== "true") {
    console.log("[active-sync-policy] autostart disabled");
    return;
  }
  console.log("[active-sync-policy] enabled for Next + Centrepoint");
  scheduleNext(20_000);
}

startActiveSyncCollectionPolicyWorker();
