import { prisma } from "./db.js";

const ALLOWED_DOMAINS = ["next.ae", "centrepointstores.com"];

const ALLOWED_SOURCE_SQL = `(
  LOWER(COALESCE(source."url", '')) LIKE '%next.ae%'
  OR LOWER(COALESCE(source."url", '')) LIKE '%centrepointstores.com%'
)`;

type PolicyCounts = {
  allowed: number | bigint;
  toEnable: number | bigint;
  toDisable: number | bigint;
};

let started = false;
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function positiveInt(name: string, fallback: number, min: number, max: number) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

async function runCycle() {
  if (running) return;
  running = true;
  const startedAt = Date.now();
  console.log("[active-sync-policy] cycle started");
  try {
    const result = await prisma.$transaction(async (tx) => {
      const beforeRows = await tx.$queryRawUnsafe<PolicyCounts[]>(`
        SELECT
          COUNT(*) FILTER (
            WHERE LOWER(COALESCE(sp."status", '')) = 'active'
              AND ${ALLOWED_SOURCE_SQL}
          )::int AS "allowed",
          COUNT(*) FILTER (
            WHERE LOWER(COALESCE(sp."status", '')) = 'active'
              AND ${ALLOWED_SOURCE_SQL}
              AND (
                sp."syncEnabled" = FALSE
                OR sp."syncPrice" = FALSE
                OR sp."syncInventory" = FALSE
                OR sp."syncImages" = FALSE
                OR source."syncStatus" <> 'active'
              )
          )::int AS "toEnable",
          COUNT(*) FILTER (
            WHERE NOT (
              LOWER(COALESCE(sp."status", '')) = 'active'
              AND ${ALLOWED_SOURCE_SQL}
            )
              AND sp."syncEnabled" = TRUE
              AND source."syncStatus" = 'active'
          )::int AS "toDisable"
        FROM "ShopifyProduct" sp
        JOIN "SourceProduct" source ON source."id" = sp."sourceProductId"
      `);
      const before = beforeRows[0] || { allowed: 0, toEnable: 0, toDisable: 0 };

      await tx.$executeRawUnsafe(`
        UPDATE "ShopifyProduct" sp
        SET "syncEnabled" = TRUE,
            "syncPrice" = TRUE,
            "syncInventory" = TRUE,
            "syncImages" = TRUE,
            "updatedAt" = NOW()
        FROM "SourceProduct" source
        WHERE source."id" = sp."sourceProductId"
          AND LOWER(COALESCE(sp."status", '')) = 'active'
          AND ${ALLOWED_SOURCE_SQL}
          AND (
            sp."syncEnabled" = FALSE
            OR sp."syncPrice" = FALSE
            OR sp."syncInventory" = FALSE
            OR sp."syncImages" = FALSE
          )
      `);
      await tx.$executeRawUnsafe(`
        UPDATE "SourceProduct" source
        SET "syncStatus" = 'active', "updatedAt" = NOW()
        WHERE source."syncStatus" <> 'active'
          AND ${ALLOWED_SOURCE_SQL}
          AND EXISTS (
            SELECT 1
            FROM "ShopifyProduct" sp
            WHERE sp."sourceProductId" = source."id"
              AND LOWER(COALESCE(sp."status", '')) = 'active'
          )
      `);
      await tx.$executeRawUnsafe(`
        UPDATE "ShopifyProduct" sp
        SET "syncEnabled" = FALSE, "updatedAt" = NOW()
        FROM "SourceProduct" source
        WHERE source."id" = sp."sourceProductId"
          AND sp."syncEnabled" = TRUE
          AND NOT (
            LOWER(COALESCE(sp."status", '')) = 'active'
            AND ${ALLOWED_SOURCE_SQL}
          )
      `);
      await tx.$executeRawUnsafe(`
        UPDATE "SourceProduct" source
        SET "syncStatus" = 'paused', "updatedAt" = NOW()
        WHERE source."syncStatus" = 'active'
          AND EXISTS (
            SELECT 1
            FROM "ShopifyProduct" sp
            WHERE sp."sourceProductId" = source."id"
              AND NOT (
                LOWER(COALESCE(sp."status", '')) = 'active'
                AND ${ALLOWED_SOURCE_SQL}
              )
          )
      `);

      const afterRows = await tx.$queryRawUnsafe<Array<{
        activeAllowed: number | bigint;
        activeOutside: number | bigint;
      }>>(`
        SELECT
          COUNT(*) FILTER (
            WHERE LOWER(COALESCE(sp."status", '')) = 'active'
              AND ${ALLOWED_SOURCE_SQL}
              AND sp."syncEnabled" = TRUE
              AND source."syncStatus" = 'active'
          )::int AS "activeAllowed",
          COUNT(*) FILTER (
            WHERE NOT (
              LOWER(COALESCE(sp."status", '')) = 'active'
              AND ${ALLOWED_SOURCE_SQL}
            )
              AND sp."syncEnabled" = TRUE
              AND source."syncStatus" = 'active'
          )::int AS "activeOutside"
        FROM "ShopifyProduct" sp
        JOIN "SourceProduct" source ON source."id" = sp."sourceProductId"
      `);
      const after = afterRows[0] || { activeAllowed: 0, activeOutside: 0 };

      await tx.auditLog.create({
        data: {
          action: "ENFORCE_ACTIVE_SYNC_DOMAIN_POLICY",
          userId: "System",
          details: JSON.stringify({
            allowedDomains: ALLOWED_DOMAINS,
            enabled: Number(before.toEnable),
            disabled: Number(before.toDisable),
            activeAllowedAfter: Number(after.activeAllowed),
            activeOutsideAfter: Number(after.activeOutside),
          }),
        },
      });

      return {
        allowed: Number(before.allowed),
        toEnable: Number(before.toEnable),
        toDisable: Number(before.toDisable),
        activeAllowedAfter: Number(after.activeAllowed),
        activeOutsideAfter: Number(after.activeOutside),
      };
    }, { timeout: 60_000 });

    console.log(JSON.stringify({
      worker: "active-sync-collection-policy-worker",
      allowedLinkedActiveProducts: result.allowed,
      toEnable: result.toEnable,
      toDisable: result.toDisable,
      activeAllowedAfter: result.activeAllowedAfter,
      activeOutsideAfter: result.activeOutsideAfter,
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
