import fs from "node:fs";

const path = "scripts/quarantine-stale-sync-jobs.ts";
const source = fs.readFileSync(path, "utf8");

function requireMatch(pattern: RegExp, message: string) {
  if (!pattern.test(source)) throw new Error(message);
}

function forbidMatch(pattern: RegExp, message: string) {
  if (pattern.test(source)) throw new Error(message);
}

requireMatch(
  /SYNC_JOB_QUARANTINE_APPLY[\s\S]*===\s*["']true["']/,
  "Quarantine must require an explicit apply flag",
);
requireMatch(
  /QUARANTINE_STALE_RUNNING_NO_REPLAY/,
  "Quarantine must require the no-replay confirmation token",
);
requireMatch(
  /Math\.min\(20,/,
  "Quarantine must keep a hard maximum of 20 rows",
);
requireMatch(
  /type\s*===\s*["']PUBLISH_TO_SHOPIFY["']/,
  "Quarantine must explicitly allow only the known Shopify publish job type",
);
requireMatch(
  /type\.startsWith\(["']SHEET1_CATALOG_AUTO_SYNC:/,
  "Quarantine must explicitly scope Sheet 1 auto-sync jobs",
);
requireMatch(
  /status:\s*["']running["']/,
  "Quarantine candidates must be running jobs only",
);
requireMatch(
  /startedAt:\s*\{\s*lt:\s*cutoff\s*\}/,
  "Quarantine must enforce a stale startedAt cutoff",
);
requireMatch(
  /prisma\.syncJob\.updateMany\(/,
  "Quarantine must mutate only SyncJob state through Prisma",
);
requireMatch(
  /status:\s*["']failed["'][\s\S]*completedAt:\s*new Date\(\)[\s\S]*result:\s*resultMarker/,
  "Quarantine must terminally fail jobs with a timestamp and marker",
);
requireMatch(
  /result\.count\s*!==\s*ids\.length/,
  "Quarantine must fail closed on update-count races",
);
requireMatch(
  /readBack[\s\S]*job\.status\s*!==\s*["']failed["']/,
  "Quarantine must read back and verify terminal status",
);
requireMatch(
  /stale_running_no_replay/,
  "Quarantine result must preserve the no-replay marker",
);

forbidMatch(
  /shopify.*(?:client|graphql|rest)|(?:client|graphql|rest).*shopify/i,
  "Quarantine tool must not instantiate or call a Shopify client",
);
forbidMatch(
  /\bfetch\s*\(|\baxios\b|got\s*\(|undici/i,
  "Quarantine tool must not perform outbound HTTP requests",
);
forbidMatch(
  /SYNC_JOB_RECOVERY|recoverInterruptedJobs|enqueue|publishProduct/i,
  "Quarantine tool must not recover, enqueue, or replay jobs",
);

console.log("Stale SyncJob quarantine safety contract passed");
