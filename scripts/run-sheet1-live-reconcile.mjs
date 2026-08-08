import { setTimeout as sleep } from 'node:timers/promises';

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const baseUrl = String(process.env.BASE_URL || '').replace(/\/$/, '');
const writeToken = String(process.env.WRITE_TOKEN || '');
const revision = String(process.env.EXPECTED_REVISION || '').toLowerCase();
const confirmation = String(process.env.RUN_CONFIRMATION || '2026-08-09-sheet1-reconcile-v1');
const allowFullReconcile = String(process.env.ALLOW_FULL_RECONCILE || '').toLowerCase() === 'true';
const sheetCsv = String(process.env.SHEET_CSV || 'https://docs.google.com/spreadsheets/d/1fCbPajWL3nukX0TdoN1m2X8LV3pfPsxSMLBb0yWug2w/export?format=csv&gid=0');
const issueTitle = 'Sheet1 live reconcile status';

if (!repo || !token || !baseUrl || !writeToken || !/^[0-9a-f]{40}$/.test(revision)) {
  throw new Error('Missing required runner environment (repo/token/base URL/write token/exact revision).');
}

async function gh(path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  return body;
}

let statusIssue = null;
async function ensureIssue() {
  const issues = await gh(`/repos/${repo}/issues?state=open&per_page=100`);
  statusIssue = issues.find((issue) => !issue.pull_request && issue.title === issueTitle) || null;
  if (!statusIssue) {
    statusIssue = await gh(`/repos/${repo}/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: issueTitle, body: `STARTING\n\nRevision: \`${revision}\`\nNo writes attempted yet.` }),
    });
  } else {
    await updateIssue(`STARTING\n\nRevision: \`${revision}\`\nNo writes attempted yet.`);
  }
}

async function updateIssue(body) {
  if (!statusIssue) return;
  statusIssue = await gh(`/repos/${repo}/issues/${statusIssue.number}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
}

async function requestJson(path, { method = 'GET', body, write = false, timeoutMs = 300000 } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(write ? {
        'x-catalog-audit-write-token': writeToken,
        'x-sheet1-reconcile-run': confirmation,
      } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'manual',
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 5000) }; }
  if (!response.ok) {
    throw new Error(`${path} HTTP ${response.status}: ${parsed?.error || parsed?.raw || text.slice(0, 1000)}`);
  }
  return parsed;
}

async function waitForDeployment() {
  for (let attempt = 1; attempt <= 90; attempt += 1) {
    try {
      const ready = await requestJson('/api/ready', { timeoutMs: 20000 });
      const actual = String(ready?.deployment?.revision || '').toLowerCase();
      if (
        ready?.database?.ok === true &&
        ready?.database?.target === 'supabase' &&
        ready?.deployment?.revisionVerified === true &&
        actual === revision &&
        ready?.platform?.productionEnvironment === true
      ) {
        const config = await requestJson('/api/sheet1-reconcile/config', { timeoutMs: 30000 });
        if (config?.createProducts !== false || config?.rebuildProducts !== false) {
          throw new Error('Live reconcile config is not existing-products-only.');
        }
        return { ready, config };
      }
    } catch (error) {
      if (attempt === 90) throw error;
    }
    await sleep(10000);
  }
  throw new Error(`Railway did not reach exact revision ${revision}.`);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"') {
      if (quoted && next === '"') { cell += '"'; i += 1; } else { quoted = !quoted; }
      continue;
    }
    if (char === ',' && !quoted) { row.push(cell); cell = ''; continue; }
    if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = ''; continue;
    }
    cell += char;
  }
  row.push(cell);
  if (row.some((value) => String(value || '').trim())) rows.push(row);
  return rows;
}

function normalizeUrl(value) {
  const input = String(value || '').replace(/[\t\r\n]+/g, '').trim();
  try {
    const url = new URL(input);
    url.hash = '';
    url.search = '';
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/$/, '');
  } catch { return input; }
}

async function buildPlan() {
  const response = await fetch(sheetCsv, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Sheet CSV HTTP ${response.status}`);
  const cells = parseCsv(await response.text());
  const rows = [];
  cells.forEach((line, index) => {
    const url = String(line[0] || '').trim();
    const multiplier = Number(String(line[1] || '').trim().replace(',', '.'));
    const sku = String(line[3] || '').trim();
    if (!/^https?:\/\//i.test(url) || !Number.isFinite(multiplier) || multiplier < 1 || multiplier > 100) return;
    rows.push({ row: index + 1, url: normalizeUrl(url), multiplier, sku });
  });

  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.url)) groups.set(row.url, []);
    groups.get(row.url).push(row);
  }
  const missingGroups = [];
  for (const [url, group] of groups) {
    if (!group.some((row) => !row.sku)) continue;
    missingGroups.push({
      url,
      rows: group.map((row) => row.row),
      multipliers: [...new Set(group.map((row) => row.multiplier))].sort((a, b) => a - b),
    });
  }
  const batches = [];
  for (let i = 0; i < missingGroups.length; i += 10) batches.push(missingGroups.slice(i, i + 10));
  return { validRows: rows.length, missingGroups, batches };
}

async function chooseCanary(plan) {
  const probes = plan.batches.slice(0, 20).flat().slice(0, 100);
  for (const group of probes) {
    try {
      const body = await requestJson('/api/sheet1-reconcile/run', {
        method: 'POST',
        body: { dryRun: true, writeSheet: false, rowNumbers: group.rows },
        timeoutMs: 300000,
      });
      const summary = body?.summary || {};
      const good = (body?.results || []).filter((result) =>
        result?.status === 'verified' && result?.readbackVerified === true && result?.expectedSku,
      );
      if (
        Number(summary.errors || 0) === 0 &&
        Number(summary.ambiguous || 0) === 0 &&
        Number(summary.conflicts || 0) === 0 &&
        good.length
      ) {
        return { result: good[0], batchId: body.batchId };
      }
    } catch {}
  }
  throw new Error('No clean missing-SKU canary candidate was found in the first 100 groups.');
}

async function runCanary(canary) {
  const row = canary.result.rows[0];
  const expectedSku = canary.result.expectedSku;
  const body = await requestJson('/api/sheet1-reconcile/run', {
    method: 'POST',
    body: { dryRun: false, writeSheet: false, rowNumbers: [row] },
    write: true,
    timeoutMs: 360000,
  });
  const results = body?.results || [];
  if (
    body?.success !== true ||
    !results.length ||
    !results.every((result) => result.status === 'verified' && result.readbackVerified === true) ||
    !results.some((result) => result.expectedSku === expectedSku)
  ) {
    throw new Error(`Canary read-back failed: ${JSON.stringify(body).slice(0, 5000)}`);
  }
  return body;
}

async function runFull(plan) {
  if (!allowFullReconcile) {
    throw new Error('Broad Sheet 1 reconcile is blocked: ALLOW_FULL_RECONCILE must be explicitly true.');
  }

  const totals = {
    batches: 0, units: 0, rows: 0, verified: 0,
    missing: 0, ambiguous: 0, conflicts: 0, errors: 0, sheetCells: 0,
  };
  const issues = [];

  for (let index = 0; index < plan.batches.length; index += 1) {
    const batch = plan.batches[index];
    const rowNumbers = batch.flatMap((group) => group.rows);
    let response;
    try {
      response = await requestJson('/api/sheet1-reconcile/run', {
        method: 'POST',
        body: { dryRun: false, writeSheet: true, rowNumbers },
        write: true,
        timeoutMs: 900000,
      });
    } catch (error) {
      const message = String(error?.message || error);
      throw new Error(
        `Broad reconcile batch ${index + 1} has an uncertain mutation outcome; automatic retry is disabled. ` +
        `Stop and verify persisted/Shopify/Sheet read-back before any manual recovery. ${message}`,
      );
    }

    const s = response.summary || {};
    totals.batches += 1;
    totals.units += Number(s.unitsProcessed || 0);
    totals.rows += Number(s.rowsProcessed || 0);
    for (const key of ['verified', 'missing', 'ambiguous', 'conflicts', 'errors']) totals[key] += Number(s[key] || 0);
    totals.sheetCells += Number(s?.sheetWrite?.cellsWritten || 0);
    for (const result of response.results || []) {
      if (result.status !== 'verified') issues.push({ batch: index + 1, ...result });
    }

    if (index === 0 || (index + 1) % 5 === 0 || index + 1 === plan.batches.length) {
      await updateIssue(
        `FULL RUN ${totals.errors === 0 ? '✅' : '⚠️'}\n\n` +
        `Revision: \`${revision}\`\n` +
        `Batch: ${index + 1}/${plan.batches.length}\n` +
        `Verified: ${totals.verified}\n` +
        `Sheet cells written: ${totals.sheetCells}\n` +
        `Missing mappings: ${totals.missing}\n` +
        `Ambiguous: ${totals.ambiguous}\n` +
        `Multiplier conflicts: ${totals.conflicts}\n` +
        `Errors: ${totals.errors}\n` +
        `Product creation/rebuild: 0`,
      );
    }
  }

  return { totals, issues };
}

await ensureIssue();
try {
  await updateIssue(`CODE DEPLOY CHECK\n\nRevision: \`${revision}\`\nWaiting for exact Railway revision; no writes yet.`);
  await waitForDeployment();
  await updateIssue(`DEPLOYED + READY ✅\n\nRevision: \`${revision}\`\nSupabase healthy\nNew reconcile route live\nNext: frozen missing-SKU snapshot + dry-run.`);

  const plan = await buildPlan();
  if (!plan.missingGroups.length) {
    await updateIssue(`COMPLETED ✅\n\nRevision: \`${revision}\`\nNo missing-SKU groups remain.\nProduct creation/rebuild: 0`);
    process.exit(0);
  }

  const canary = await chooseCanary(plan);
  await updateIssue(
    `DRY RUN ✅\n\nRevision: \`${revision}\`\n` +
    `Missing URL groups snapshot: ${plan.missingGroups.length}\n` +
    `Canary row: \`${canary.result.rows[0]}\`\n` +
    `Expected SKU: \`${canary.result.expectedSku}\`\n` +
    `Product: \`${canary.result.shopifyProductId}\`\n` +
    `Dry-run batch: \`${canary.batchId}\`\n` +
    `No write yet.`,
  );

  await runCanary(canary);
  await updateIssue(
    `CANARY + SHOPIFY READ-BACK ✅\n\nRevision: \`${revision}\`\n` +
    `Row: \`${canary.result.rows[0]}\`\nSKU: \`${canary.result.expectedSku}\`\n` +
    `Product: \`${canary.result.shopifyProductId}\`\nFull snapshot run starting.`,
  );

  const full = await runFull(plan);
  const problemCount = full.totals.missing + full.totals.ambiguous + full.totals.conflicts + full.totals.errors;
  const state = problemCount === 0 ? 'COMPLETED ✅' : 'COMPLETED_WITH_ISSUES ⚠️';
  await updateIssue(
    `${state}\n\nRevision: \`${revision}\`\n` +
    `Snapshot missing groups: ${plan.missingGroups.length}\n` +
    `Batches completed: ${full.totals.batches}/${plan.batches.length}\n` +
    `Verified: ${full.totals.verified}\nRows processed: ${full.totals.rows}\n` +
    `Sheet SKU cells written: ${full.totals.sheetCells}\n` +
    `Missing mappings: ${full.totals.missing}\nAmbiguous: ${full.totals.ambiguous}\n` +
    `Multiplier conflicts: ${full.totals.conflicts}\nErrors: ${full.totals.errors}\n` +
    `Product creation/rebuild: 0`,
  );
  console.log(JSON.stringify({ state, plan: { missingGroups: plan.missingGroups.length, batches: plan.batches.length }, ...full }, null, 2));
} catch (error) {
  const message = String(error?.stack || error?.message || error).slice(0, 12000);
  await updateIssue(`FAILED ❌\n\nRevision: \`${revision}\`\n\n${message}\n\nFull run stops on canary/deployment failures.`);
  throw error;
}
