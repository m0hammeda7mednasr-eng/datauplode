import fs from "node:fs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const source = fs.readFileSync("scripts/watch-sheet1-reconcile.mjs", "utf8");

assert(
  source.includes("const DEPLOYMENT_MARKER_GRACE_MS = 120_000"),
  "Watcher must keep a bounded deployment-marker grace window.",
);
assert(
  source.includes("deploymentObservedAt = Date.now()"),
  "Watcher must record when the exact Railway revision is observed live.",
);
assert(
  source.includes("const minimumMarkerTime = deploymentObservedAt - DEPLOYMENT_MARKER_GRACE_MS"),
  "Watcher must derive a minimum marker timestamp from the verified deployment.",
);
assert(
  source.includes("markerBelongsToDeployment(entry, minimumMarkerTime)"),
  "Watcher must filter reconcile markers by deployment provenance.",
);
assert(
  source.includes("if (revision) return revision === expectedRevision"),
  "A marker with an explicit revision must exactly match the expected Railway revision.",
);
assert(
  source.includes("startedAt >= minimumMarkerTime"),
  "Legacy markers without an explicit revision must be bounded to the current deployment window.",
);
assert(
  !source.includes("const job = selectNewestMarker(body);"),
  "Watcher must never select a reconcile marker without deployment provenance.",
);
assert(
  source.includes("Legacy markers from older deployments are ignored"),
  "Watcher status must explicitly report that older deployment markers are ignored.",
);
assert(
  source.includes("Diagnostics:"),
  "Watcher must surface bounded failed-group diagnostics for actionable read-only triage.",
);
assert(
  source.includes("body?.database?.target === 'supabase'") &&
    source.includes("body?.deployment?.revisionVerified === true") &&
    source.includes("actual === expectedRevision"),
  "Watcher must continue proving Supabase readiness and exact Railway revision before inspecting jobs.",
);

console.log("Sheet 1 watcher deployment-provenance safety contract passed.");
