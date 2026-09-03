const REQUIRED_CLOSED_GATES = [
  'SYNC_RUNTIME_WRITE_ENABLED',
  'SYNC_INVENTORY_AUTOSTART',
  'SYNC_JOB_RECOVERY_ENABLED',
  'SYNC_JOB_RECOVERY_SHOPIFY_WRITES_ENABLED',
  'SYNC_SHEET_IMPORT_AUTOSTART_ENABLED',
  'SYNC_FIRST5_RECONCILE_ENABLED',
  'CATALOG_AUDIT_WRITE_ENABLED',
  'CATALOG_AUDIT_SHEET_WRITE_ENABLED',
] as const;

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled']);

function normalize(value: string | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

function enabled(name: string): boolean {
  return TRUE_VALUES.has(normalize(process.env[name]));
}

function exactRevision(value: string | undefined): string {
  const revision = String(value ?? '').trim();
  return /^[0-9a-f]{40}$/i.test(revision) ? revision.toLowerCase() : '';
}

function catalogWorkerRevisionAuthorized(): boolean {
  const expected = exactRevision(process.env.SYNC_SHEET1_CATALOG_REVISION);
  const deployed = exactRevision(process.env.SYNC_SHEET1_CATALOG_DEPLOYED_REVISION);
  return Boolean(
    expected &&
      deployed &&
      expected === deployed &&
      enabled('SYNC_RUNTIME_WRITE_ENABLED') &&
      enabled('SYNC_POST_CANARY_BROAD_WRITES_ENABLED') &&
      enabled('SYNC_SHEET1_CATALOG_AUTOSTART_ENABLED') &&
      !enabled('SYNC_SHEET1_CATALOG_AUTOSTART_DISABLED'),
  );
}

function isSupabaseHost(host: string): boolean {
  const normalizedHost = host.trim().toLowerCase().replace(/\.$/, '');
  return normalizedHost.endsWith('.supabase.com') || normalizedHost.endsWith('.supabase.co');
}

function deriveSupabaseProjectRef(url: URL): string | null {
  const host = url.hostname.trim().toLowerCase().replace(/\.$/, '');
  const direct = host.match(/^db\.([a-z0-9-]+)\.supabase\.(?:co|com)$/);
  if (direct) return direct[1];

  if (/\.pooler\.supabase\.(?:co|com)$/.test(host)) {
    const username = decodeURIComponent(url.username || '').trim().toLowerCase();
    const separator = username.lastIndexOf('.');
    if (separator >= 0 && separator < username.length - 1) {
      return username.slice(separator + 1);
    }
  }

  return null;
}

function validateSupabaseDatabaseUrl(raw: string | undefined, expectedProjectRefRaw: string | undefined) {
  const value = String(raw ?? '').trim();
  const expectedProjectRef = normalize(expectedProjectRefRaw);
  if (!expectedProjectRef) {
    return {
      ok: false,
      reason: 'SUPABASE_PROJECT_REF is required to pin the dedicated Dabdoob database project',
      target: 'missing-project-pin',
    } as const;
  }
  if (!value) {
    return { ok: false, reason: 'DATABASE_URL is required', target: 'missing' } as const;
  }

  try {
    const url = new URL(value);
    const protocol = url.protocol.replace(':', '').toLowerCase();
    const host = url.hostname.toLowerCase();
    const port = url.port || '5432';
    const sslMode = String(url.searchParams.get('sslmode') || '').toLowerCase();
    const connectionLimit = Number(url.searchParams.get('connection_limit'));
    const poolTimeout = Number(url.searchParams.get('pool_timeout'));

    if (!['postgres', 'postgresql'].includes(protocol)) {
      return { ok: false, reason: 'DATABASE_URL must use PostgreSQL', target: 'invalid' } as const;
    }
    if (!isSupabaseHost(host)) {
      return { ok: false, reason: 'Production DATABASE_URL must target an official Supabase hostname', target: 'non-supabase' } as const;
    }

    const projectRef = deriveSupabaseProjectRef(url);
    if (!projectRef) {
      return {
        ok: false,
        reason: 'Could not derive Supabase project ref from DATABASE_URL',
        target: 'supabase',
      } as const;
    }
    if (projectRef !== expectedProjectRef) {
      return {
        ok: false,
        reason: 'DATABASE_URL Supabase project does not match SUPABASE_PROJECT_REF',
        target: 'supabase',
      } as const;
    }
    if (port !== '5432') {
      return { ok: false, reason: 'Supabase Session pooler must use port 5432', target: 'supabase' } as const;
    }
    if (sslMode !== 'require') {
      return { ok: false, reason: 'Supabase DATABASE_URL must include sslmode=require', target: 'supabase' } as const;
    }
    if (!Number.isInteger(connectionLimit) || connectionLimit < 1 || connectionLimit > 20) {
      return { ok: false, reason: 'connection_limit must be an integer from 1 to 20', target: 'supabase' } as const;
    }
    if (!Number.isInteger(poolTimeout) || poolTimeout < 1 || poolTimeout > 60) {
      return { ok: false, reason: 'pool_timeout must be an integer from 1 to 60', target: 'supabase' } as const;
    }

    return {
      ok: true,
      target: 'supabase',
      projectRefPinned: true,
      projectRefMatched: true,
      port,
      sslMode,
      connectionLimit,
      poolTimeout,
    } as const;
  } catch {
    return { ok: false, reason: 'DATABASE_URL is not a valid URL', target: 'invalid' } as const;
  }
}

function main() {
  const nodeEnv = normalize(process.env.NODE_ENV);
  if (nodeEnv !== 'production') {
    console.log(JSON.stringify({
      ok: true,
      skipped: true,
      reason: 'Safe-mode deployment preflight only applies to NODE_ENV=production',
    }));
    return;
  }

  const missing: string[] = [];
  const invalid: Array<{ name: string; value: string }> = [];
  const open: string[] = [];
  const catalogRevisionAuthorized = catalogWorkerRevisionAuthorized();

  for (const name of REQUIRED_CLOSED_GATES) {
    const raw = process.env[name];
    const value = normalize(raw);

    if (!value) {
      missing.push(name);
      continue;
    }

    if (TRUE_VALUES.has(value)) {
      if (name === 'SYNC_RUNTIME_WRITE_ENABLED' && catalogRevisionAuthorized) {
        continue;
      }
      open.push(name);
      continue;
    }

    if (!FALSE_VALUES.has(value)) {
      invalid.push({ name, value });
    }
  }

  const first5Revision = String(process.env.SYNC_FIRST5_RECONCILE_REVISION ?? '').trim();
  if (first5Revision) {
    invalid.push({
      name: 'SYNC_FIRST5_RECONCILE_REVISION',
      value: 'must be empty in production safe mode',
    });
  }

  const canaryMaxRowsRaw = normalize(process.env.CATALOG_AUDIT_CANARY_MAX_ROWS);
  const canaryMaxRows = Number(canaryMaxRowsRaw);
  if (!canaryMaxRowsRaw) {
    missing.push('CATALOG_AUDIT_CANARY_MAX_ROWS');
  } else if (!Number.isInteger(canaryMaxRows) || canaryMaxRows !== 1) {
    invalid.push({ name: 'CATALOG_AUDIT_CANARY_MAX_ROWS', value: canaryMaxRowsRaw });
  }

  const dryRunRaw = normalize(process.env.CATALOG_AUDIT_DRY_RUN);
  if (!dryRunRaw) {
    missing.push('CATALOG_AUDIT_DRY_RUN');
  } else if (!TRUE_VALUES.has(dryRunRaw)) {
    invalid.push({ name: 'CATALOG_AUDIT_DRY_RUN', value: dryRunRaw });
  }

  const database = validateSupabaseDatabaseUrl(
    process.env.DATABASE_URL,
    process.env.SUPABASE_PROJECT_REF,
  );
  if (!database.ok) {
    invalid.push({ name: 'DATABASE_URL', value: database.reason });
  }

  const report = {
    ok: missing.length === 0 && invalid.length === 0 && open.length === 0,
    mode: 'production-safe-mode',
    requiredClosedGateCount: REQUIRED_CLOSED_GATES.length,
    first5RevisionAuthorized: Boolean(first5Revision),
    catalogRevisionAuthorized,
    missing,
    invalid,
    open,
    database,
    canaryMaxRows: Number.isInteger(canaryMaxRows) ? canaryMaxRows : null,
    catalogAuditDryRun: TRUE_VALUES.has(dryRunRaw),
    shopifyMutationsPerformed: 0,
    googleSheetWritesPerformed: 0,
  };

  console.log(JSON.stringify(report, null, 2));

  if (!report.ok) {
    throw new Error(
      'Railway production deployment blocked: write gates must be explicitly closed, first-five reconcile revision authorization must be empty, the dedicated Supabase project must be pinned and match DATABASE_URL, Session pooler configuration must be valid, dry-run enabled, and canary limited to one row.',
    );
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
