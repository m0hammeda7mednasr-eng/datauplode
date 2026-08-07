const REQUIRED_CLOSED_GATES = [
  'SYNC_RUNTIME_WRITE_ENABLED',
  'SYNC_INVENTORY_AUTOSTART',
  'SYNC_JOB_RECOVERY_ENABLED',
  'SYNC_SHEET_IMPORT_AUTOSTART_ENABLED',
  'CATALOG_AUDIT_WRITE_ENABLED',
  'CATALOG_AUDIT_SHEET_WRITE_ENABLED',
] as const;

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled']);

function normalize(value: string | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

function validateSupabaseDatabaseUrl(raw: string | undefined) {
  const value = String(raw ?? '').trim();
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
    if (!host.includes('supabase')) {
      return { ok: false, reason: 'Production DATABASE_URL must target Supabase', target: 'non-supabase' } as const;
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

  for (const name of REQUIRED_CLOSED_GATES) {
    const raw = process.env[name];
    const value = normalize(raw);

    if (!value) {
      missing.push(name);
      continue;
    }

    if (TRUE_VALUES.has(value)) {
      open.push(name);
      continue;
    }

    if (!FALSE_VALUES.has(value)) {
      invalid.push({ name, value });
    }
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

  const database = validateSupabaseDatabaseUrl(process.env.DATABASE_URL);
  if (!database.ok) {
    invalid.push({ name: 'DATABASE_URL', value: database.reason });
  }

  const report = {
    ok: missing.length === 0 && invalid.length === 0 && open.length === 0,
    mode: 'production-safe-mode',
    requiredClosedGateCount: REQUIRED_CLOSED_GATES.length,
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
      'Railway production deployment blocked: write gates must be explicitly closed, Supabase Session pooler configuration must be valid, dry-run enabled, and canary limited to one row.',
    );
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
