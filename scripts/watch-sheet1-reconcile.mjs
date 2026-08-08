import { setTimeout as sleep } from 'node:timers/promises';

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const expectedRevision = String(process.env.EXPECTED_REVISION || '').toLowerCase();
const baseUrl = 'https://datauplode-production.up.railway.app';
const markerType = 'ONE_TIME_SHEET1_RECONCILE:2026-08-09-sheet1-reconcile-v1';
const issueTitle = 'Sheet1 Railway reconcile status';

if (!repo || !token || !/^[0-9a-f]{40}$/.test(expectedRevision)) {
  throw new Error('Watcher is missing repo/token/exact expected revision.');
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

let issue = null;
async function ensureIssue() {
  const issues = await gh(`/repos/${repo}/issues?state=open&per_page=100`);
  issue = issues.find((entry) => !entry.pull_request && entry.title === issueTitle) || null;
  if (!issue) {
    issue = await gh(`/repos/${repo}/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: issueTitle, body: `WATCHER STARTING\n\nExpected Railway revision: \`${expectedRevision}\`` }),
    });
  }
}

async function updateIssue(body) {
  if (!issue) return;
  issue = await gh(`/repos/${repo}/issues/${issue.number}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
}

async function fetchJson(path, timeoutMs = 25000) {
  const response = await fetch(`${baseUrl}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'manual',
    headers: { Accept: 'application/json' },
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 5000) }; }
  return { status: response.status, body };
}

function parseJobResult(job) {
  if (!job?.result) return {};
  try { return JSON.parse(job.result); } catch { return { raw: String(job.result).slice(0, 5000) }; }
}

function renderJob(job) {
  const result = parseJobResult(job);
  const totals = result?.totals || {};
  const statusIcon = job.status === 'completed' ? '✅' : job.status === 'failed' ? '❌' : '🔄';
  return [
    `RAILWAY RECONCILE ${statusIcon}`,
    '',
    `Revision: \`${expectedRevision}\``,
    `Job: \`${job.id}\``,
    `Status: **${job.status}**`,
    `Stage: **${result.stage || 'starting'}**`,
    `Plan groups: ${result.planGroups ?? '-'}`,
    `Batch: ${result.batch ?? '-'} / ${result.totalBatches ?? '-'}`,
    `Verified: ${totals.verified ?? 0}`,
    `Rows processed: ${totals.rows ?? 0}`,
    `Sheet cells written: ${totals.sheetCells ?? 0}`,
    `Missing mappings: ${totals.missing ?? 0}`,
    `Ambiguous: ${totals.ambiguous ?? 0}`,
    `Multiplier conflicts: ${totals.conflicts ?? 0}`,
    `Errors: ${totals.errors ?? 0}`,
    `Create/rebuild products: **0**`,
    result.error ? `Error: ${result.error}` : '',
  ].filter(Boolean).join('\n');
}

await ensureIssue();
await updateIssue(`WAITING FOR RAILWAY DEPLOYMENT\n\nExpected revision: \`${expectedRevision}\`\nWatcher is read-only.`);

let deployed = false;
for (let attempt = 1; attempt <= 90; attempt += 1) {
  try {
    const { body } = await fetchJson('/api/ready');
    const actual = String(body?.deployment?.revision || '').toLowerCase();
    if (
      body?.database?.ok === true &&
      body?.database?.target === 'supabase' &&
      body?.deployment?.revisionVerified === true &&
      actual === expectedRevision &&
      body?.platform?.productionEnvironment === true
    ) {
      deployed = true;
      break;
    }
    if (attempt === 1 || attempt % 12 === 0) {
      await updateIssue(`WAITING FOR RAILWAY DEPLOYMENT\n\nExpected: \`${expectedRevision}\`\nCurrent: \`${actual || '<unknown>'}\`\nDatabase OK: ${body?.database?.ok === true}\nWatcher is read-only.`);
    }
  } catch (error) {
    if (attempt === 1 || attempt % 12 === 0) {
      await updateIssue(`WAITING FOR RAILWAY DEPLOYMENT\n\nExpected: \`${expectedRevision}\`\nRailway read error: ${String(error?.message || error).slice(0, 1000)}\nWatcher is read-only.`);
    }
  }
  await sleep(10000);
}

if (!deployed) {
  await updateIssue(`WATCHER FAILED ❌\n\nRailway never reported exact revision \`${expectedRevision}\`. No watcher writes were made to catalog data.`);
  throw new Error('Railway did not deploy the exact expected revision in time.');
}

await updateIssue(`DEPLOYED ✅\n\nRevision: \`${expectedRevision}\`\nWaiting for one-time reconcile marker \`${markerType}\`.`);

let lastRendered = '';
for (let attempt = 1; attempt <= 360; attempt += 1) {
  const { status, body } = await fetchJson('/api/sync-jobs', 30000);
  if (status >= 200 && status < 300 && Array.isArray(body)) {
    const job = body.find((entry) => String(entry?.type || '') === markerType);
    if (job) {
      const rendered = renderJob(job);
      if (rendered !== lastRendered) {
        await updateIssue(rendered);
        lastRendered = rendered;
      }
      if (job.status === 'completed') process.exit(0);
      if (job.status === 'failed') process.exit(2);
    }
  }
  await sleep(10000);
}

await updateIssue(`WATCHER TIMEOUT ⚠️\n\nRevision: \`${expectedRevision}\`\nThe reconcile job did not reach completed/failed during the watch window.`);
throw new Error('Reconcile watch timed out.');
