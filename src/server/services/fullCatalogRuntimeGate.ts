function clean(value: unknown) {
  return String(value ?? "").trim();
}

function exactRevision(value: unknown) {
  const revision = clean(value).toLowerCase();
  return /^[0-9a-f]{40}$/.test(revision) ? revision : "";
}

function enabled(value: unknown, defaultValue = false) {
  const normalized = clean(value).toLowerCase();
  if (!normalized) return defaultValue;
  return normalized === "true";
}

export function getFullCatalogRevisionGateState() {
  const expectedRevision = exactRevision(process.env.SYNC_FULL_CATALOG_REVISION);
  const deployedRevision = exactRevision(
    process.env.RAILWAY_GIT_COMMIT_SHA ||
      process.env.VERCEL_GIT_COMMIT_SHA ||
      process.env.GIT_COMMIT_SHA,
  );
  const railwayBranch = clean(process.env.RAILWAY_GIT_BRANCH).toLowerCase();
  const railwayEnvironment = clean(
    process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT,
  ).toLowerCase();
  const runningOnRailway = Boolean(
    clean(process.env.RAILWAY_PROJECT_ID) && clean(process.env.RAILWAY_SERVICE_ID),
  );
  const followMain = enabled(process.env.SYNC_FULL_CATALOG_FOLLOW_MAIN, true);
  const exactMatch = Boolean(expectedRevision) && expectedRevision === deployedRevision;
  const approvedMainLineage =
    followMain &&
    Boolean(expectedRevision) &&
    Boolean(deployedRevision) &&
    runningOnRailway &&
    railwayEnvironment === "production" &&
    railwayBranch === "main";

  return {
    authorized: exactMatch || approvedMainLineage,
    exactMatch,
    approvedMainLineage,
    followMain,
    railwayBranch,
    railwayEnvironment,
    expectedRevisionPrefix: expectedRevision.slice(0, 8) || null,
    deployedRevisionPrefix: deployedRevision.slice(0, 8) || null,
  };
}
