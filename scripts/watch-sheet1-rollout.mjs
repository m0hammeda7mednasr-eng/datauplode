import { setTimeout as sleep } from 'node:timers/promises';

const expectedRevision = String(process.env.EXPECTED_REVISION || '').trim().toLowerCase();
const baseUrl = 'https://datauplode-production.up.railway.app';
// Rollout probe: harmless source-only change used to verify Railway deploys this exact branch head.

if (!/^[0-9a-f]{40}$/.test(expectedRevision)) {
  throw new Error('Rollout watcher requires an exact 40-char EXPECTED_REVISION.');
}

async function readiness() {
  const response = await fetch(`${baseUrl}/api/ready`, {
    signal: AbortSignal.timeout(25_000),
    redirect: 'manual',
    headers: { Accept: 'application/json' },
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 1000) };
  }
  return { status: response.status, body };
}

let observed = null;
for (let attempt = 1; attempt <= 90; attempt += 1) {
  try {
    const current = await readiness();
    const actualRevision = String(current.body?.deployment?.revision || '').trim().toLowerCase();
    const exactDeployment =
      current.body?.database?.ok === true &&
      current.body?.database?.target === 'supabase' &&
      current.body?.database?.projectRefPinned === true &&
      current.body?.database?.projectRefMatched === true &&
      current.body?.deployment?.revisionVerified === true &&
      actualRevision === expectedRevision &&
      current.body?.platform?.productionEnvironment === true;

    if (exactDeployment) {
      observed = current.body;
      break;
    }

    if (attempt === 1 || attempt % 12 === 0) {
      console.log('[sheet1-rollout] waiting for exact Railway deployment', {
        attempt,
        expectedRevision,
        actualRevision: actualRevision || '<unknown>',
        status: current.status,
        databaseOk: current.body?.database?.ok === true,
        databaseTarget: current.body?.database?.target || '<unknown>',
      });
    }
  } catch (error) {
    if (attempt === 1 || attempt % 12 === 0) {
      console.log('[sheet1-rollout] readiness probe retry', {
        attempt,
        error: String(error?.message || error).slice(0, 500),
      });
    }
  }
  await sleep(10_000);
}

if (!observed) {
  throw new Error(`Railway did not report exact revision ${expectedRevision} with verified Supabase binding in time.`);
}

const runtimeWritesEnabled = observed?.configuration?.runtimeWriteGateEnabled === true;
const writeSafetyReady = observed?.platform?.writeSafetyReady === true;
const safeMode = observed?.configuration?.safeMode === true;

if (!runtimeWritesEnabled) {
  if (!writeSafetyReady || !safeMode) {
    throw new Error('Runtime writes are closed, but Railway readiness did not confirm production write safety/safe mode.');
  }
  console.log('[sheet1-rollout] exact Railway/Supabase deployment verified; runtime writes are intentionally closed. Reconcile worker must remain stopped until dry run + canary + read-back gates are satisfied.');
  process.exit(0);
}

console.log('[sheet1-rollout] runtime writes are explicitly enabled for this revision; delegating to reconcile marker watcher.');
await import('./watch-sheet1-reconcile.mjs');
