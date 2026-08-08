# Railway Environment Variables

This file intentionally contains placeholders only. Never commit live database passwords, Supabase service-role keys, Shopify secrets, scraper provider keys, or encryption keys.

## Core runtime

```env
NODE_ENV=production
HOST=0.0.0.0
PORT=3000

APP_URL=https://datauplode-production.up.railway.app
FRONTEND_URL=https://datauplode.vercel.app
CORS_ORIGINS=https://datauplode.vercel.app,https://datauplode-production.up.railway.app

SUPABASE_PROJECT_REF=YOUR_PROJECT_REF
DATABASE_URL=postgresql://postgres.YOUR_PROJECT_REF:URL_ENCODED_PASSWORD@YOUR_SESSION_POOLER_HOST:5432/postgres?sslmode=require&connection_limit=10&pool_timeout=20
ENCRYPTION_KEY=GENERATE_A_PRIVATE_RANDOM_VALUE_32_CHARS_OR_MORE
```

## Safe rollout gates

```env
SYNC_RUNTIME_WRITE_ENABLED=false
SYNC_PRICING_RULE_SEED_ENABLED=false
SYNC_INVENTORY_AUTOSTART=false
SYNC_JOB_RECOVERY_ENABLED=false
SYNC_JOB_RECOVERY_SHOPIFY_WRITES_ENABLED=false
SYNC_SHEET_IMPORT_AUTOSTART_ENABLED=false

CATALOG_AUDIT_DRY_RUN=true
CATALOG_AUDIT_WRITE_ENABLED=false
CATALOG_AUDIT_SHEET_WRITE_ENABLED=false
CATALOG_AUDIT_CANARY_MAX_ROWS=1
```

## Optional integrations

Set Shopify, Google, and scraper-provider credentials only in Railway Variables or another secret manager. Do not put live values in this repository.

## Railway public networking

Use the Railway-provided public domain with target port `3000` when `PORT=3000` is set explicitly. The application binds to `0.0.0.0:$PORT`.

Healthcheck path:

```text
/api/health
```

Readiness diagnostics remain available separately at:

```text
/api/ready
```

## Secret rotation

If a secret was ever committed to Git history, deleting it from the latest file is not enough. Rotate/revoke the exposed credential at its provider and replace the Railway variable with the new value.
