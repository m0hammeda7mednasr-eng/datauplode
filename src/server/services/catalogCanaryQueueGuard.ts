import { prisma } from "../db.js";

function staleRunningJobMinutes() {
  const parsed = Number(process.env.SYNC_JOB_STALE_RUNNING_MINUTES || 10);
  if (!Number.isFinite(parsed)) return 10;
  return Math.max(5, Math.min(1440, Math.trunc(parsed)));
}

function recentFailedJobMinutes() {
  const parsed = Number(process.env.SYNC_JOB_RECENT_FAILURE_MINUTES || 60);
  if (!Number.isFinite(parsed)) return 60;
  return Math.max(5, Math.min(10080, Math.trunc(parsed)));
}

export type CatalogCanaryQueueState = {
  pending: number;
  running: number;
  staleRunning: number;
  recentFailed: number;
  staleThresholdMinutes: number;
  recentFailureThresholdMinutes: number;
};

export async function verifyCatalogCanaryQueueQuiescence(): Promise<CatalogCanaryQueueState> {
  const staleThresholdMinutes = staleRunningJobMinutes();
  const recentFailureThresholdMinutes = recentFailedJobMinutes();
  const staleCutoff = new Date(Date.now() - staleThresholdMinutes * 60_000);
  const recentFailureCutoff = new Date(Date.now() - recentFailureThresholdMinutes * 60_000);

  const [pending, running, staleRunning, recentFailed] = await Promise.all([
    prisma.syncJob.count({ where: { status: "pending" } }),
    prisma.syncJob.count({ where: { status: "running" } }),
    prisma.syncJob.count({
      where: {
        status: "running",
        OR: [{ startedAt: null }, { startedAt: { lt: staleCutoff } }],
      },
    }),
    prisma.syncJob.count({
      where: {
        status: "failed",
        OR: [
          { completedAt: { gte: recentFailureCutoff } },
          { completedAt: null, createdAt: { gte: recentFailureCutoff } },
        ],
      },
    }),
  ]);

  return {
    pending,
    running,
    staleRunning,
    recentFailed,
    staleThresholdMinutes,
    recentFailureThresholdMinutes,
  };
}

export function catalogCanaryQueueIsQuiescent(state: CatalogCanaryQueueState) {
  return (
    state.pending === 0 &&
    state.running === 0 &&
    state.staleRunning === 0 &&
    state.recentFailed === 0
  );
}
