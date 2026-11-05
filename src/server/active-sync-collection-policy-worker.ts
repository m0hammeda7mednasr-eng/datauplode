import { prisma } from "./db.js";

const ALLOWED_DOMAINS = ["next.ae", "centrepointstores.com"];

let started = false;
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function positiveInt(name: string, fallback: number, min: number, max: number) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function allowedSource(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ALLOWED_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

async function runCycle() {
  if (running) return;
  running = true;
  const startedAt = Date.now();
  console.log("[active-sync-policy] cycle started");
  try {
    const links = await prisma.shopifyProduct.findMany({
      select: {
        id: true,
        sourceProductId: true,
        status: true,
        syncEnabled: true,
        syncPrice: true,
        syncInventory: true,
        syncImages: true,
        sourceProduct: { select: { syncStatus: true, url: true } },
      },
    });
    const allowedLinks = links.filter((link) => (
      String(link.status || "").toLowerCase() === "active"
      && allowedSource(link.sourceProduct.url)
    ));
    const allowedIds = new Set(allowedLinks.map((link) => link.id));
    const outsideLinks = links.filter((link) => !allowedIds.has(link.id));
    const isActive = (link: typeof links[number]) => (
      link.syncEnabled && link.sourceProduct.syncStatus === "active"
    );
    const toEnable = allowedLinks.filter((link) => (
      !isActive(link) || !link.syncPrice || !link.syncInventory || !link.syncImages
    ));
    const toDisable = outsideLinks.filter(isActive);

    if (toEnable.length > 0 || toDisable.length > 0) {
      const enabledLinkIds = allowedLinks.map((link) => link.id);
      const enabledSourceIds = allowedLinks.map((link) => link.sourceProductId);
      const disabledLinkIds = outsideLinks.map((link) => link.id);
      const disabledSourceIds = outsideLinks.map((link) => link.sourceProductId);
      await prisma.$transaction(async (tx) => {
        if (enabledLinkIds.length > 0) {
          await tx.shopifyProduct.updateMany({
            where: { id: { in: enabledLinkIds } },
            data: { syncEnabled: true, syncPrice: true, syncInventory: true, syncImages: true },
          });
          await tx.sourceProduct.updateMany({
            where: { id: { in: enabledSourceIds } },
            data: { syncStatus: "active" },
          });
        }
        if (disabledLinkIds.length > 0) {
          await tx.shopifyProduct.updateMany({
            where: { id: { in: disabledLinkIds } },
            data: { syncEnabled: false },
          });
          await tx.sourceProduct.updateMany({
            where: { id: { in: disabledSourceIds } },
            data: { syncStatus: "paused" },
          });
        }
        await tx.auditLog.create({
          data: {
            action: "ENFORCE_ACTIVE_SYNC_DOMAIN_POLICY",
            userId: "System",
            details: JSON.stringify({
              allowedDomains: ALLOWED_DOMAINS,
              enabled: toEnable.length,
              disabled: toDisable.length,
            }),
          },
        });
      }, { timeout: 60_000 });
    }

    const activeOutsideAfter = links.filter((link) => (
      isActive(link) && !allowedSource(link.sourceProduct.url)
    )).length - toDisable.length;
    console.log(JSON.stringify({
      worker: "active-sync-collection-policy-worker",
      allowedLinkedActiveProducts: allowedLinks.length,
      toEnable: toEnable.length,
      toDisable: toDisable.length,
      activeAllowedAfter: allowedLinks.length,
      activeOutsideAfter: Math.max(0, activeOutsideAfter),
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
