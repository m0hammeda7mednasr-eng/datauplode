const normalize = (value: string | undefined) =>
  String(value ?? '').trim().toLowerCase();

function isSupabaseHost(host: string): boolean {
  const normalizedHost = host.trim().toLowerCase().replace(/\.$/, '');
  return (
    normalizedHost.endsWith('.supabase.com') ||
    normalizedHost.endsWith('.supabase.co')
  );
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

function validateDatabaseTarget() {
  const raw = String(process.env.DATABASE_URL || '').trim();
  const expectedProjectRef = normalize(process.env.SUPABASE_PROJECT_REF);

  if (!expectedProjectRef) {
    return { ok: false, reason: 'SUPABASE_PROJECT_REF is required' } as const;
  }
  if (!raw) {
    return { ok: false, reason: 'DATABASE_URL is required' } as const;
  }

  try {
    const url = new URL(raw);
    const protocol = url.protocol.replace(':', '').toLowerCase();
    const host = url.hostname.toLowerCase();
    const port = url.port || '5432';
    const sslMode = String(url.searchParams.get('sslmode') || '').toLowerCase();
    const connectionLimit = Number(url.searchParams.get('connection_limit'));
    const poolTimeout = Number(url.searchParams.get('pool_timeout'));

    if (!['postgres', 'postgresql'].includes(protocol)) {
      return { ok: false, reason: 'DATABASE_URL must use PostgreSQL' } as const;
    }
    if (!isSupabaseHost(host)) {
      return { ok: false, reason: 'DATABASE_URL must target an official Supabase hostname' } as const;
    }

    const projectRef = deriveSupabaseProjectRef(url);
    if (!projectRef) {
      return { ok: false, reason: 'Could not derive Supabase project ref from DATABASE_URL' } as const;
    }
    if (projectRef !== expectedProjectRef) {
      return { ok: false, reason: 'DATABASE_URL project does not match SUPABASE_PROJECT_REF' } as const;
    }
    if (port !== '5432') {
      return { ok: false, reason: 'Supabase Session pooler must use port 5432' } as const;
    }
    if (sslMode !== 'require') {
      return { ok: false, reason: 'Supabase DATABASE_URL must include sslmode=require' } as const;
    }
    if (!Number.isInteger(connectionLimit) || connectionLimit < 1 || connectionLimit > 20) {
      return { ok: false, reason: 'connection_limit must be an integer from 1 to 20' } as const;
    }
    if (!Number.isInteger(poolTimeout) || poolTimeout < 1 || poolTimeout > 60) {
      return { ok: false, reason: 'pool_timeout must be an integer from 1 to 60' } as const;
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
    return { ok: false, reason: 'DATABASE_URL is not a valid URL' } as const;
  }
}

function main() {
  if (normalize(process.env.NODE_ENV) !== 'production') {
    console.log(JSON.stringify({
      ok: true,
      skipped: true,
      mode: 'database-target-preflight',
      reason: 'Only enforced for NODE_ENV=production',
    }));
    return;
  }

  const database = validateDatabaseTarget();
  const report = {
    ok: database.ok,
    mode: 'production-database-target',
    database,
    databaseSchemaWritesPerformed: 0,
    shopifyMutationsPerformed: 0,
    googleSheetWritesPerformed: 0,
  };

  console.log(JSON.stringify(report, null, 2));

  if (!database.ok) {
    throw new Error(
      'Railway database target preflight blocked schema deployment: the dedicated Supabase project, Session pooler, TLS, and bounded pool settings must match the production contract.',
    );
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
