# Fast Production Path: Existing App + Supabase + Railway

This is the supported production path for the existing Node/React/Prisma application. The closed .NET rebuild is not part of this deployment.

## Architecture

- Frontend: existing Vercel app
- API and controlled background jobs: Node/Express on Railway
- Database: a dedicated Supabase Postgres project
- ORM/schema: Prisma
- Shopify: existing Shopify Admin integration
- Google Sheet: service-account access to the Dabdoob catalog sheet

## 1. Supabase

Create a dedicated project for Dabdoob. Do not reuse another application's database.

Use the Supavisor **Session pooler** connection string on port `5432` for the long-running Railway service. The Railway `DATABASE_URL` must include TLS and bounded pool settings, for example:

```text
?sslmode=require&connection_limit=10&pool_timeout=20
```

## 2. Railway service

Create one Railway service from:

- Repository: `m0hammeda7mednasr-eng/datauplode`
- Test branch: `stabilize-supabase-railway`
- Builder: Dockerfile, selected by `railway.json`
- Pre-deploy command: `npm run db:deploy:verified`
- Start command: Docker `CMD`, which runs `npm start`
- Healthcheck: `/api/ready`

The verified pre-deploy command applies the Prisma schema and then performs a database preflight. A deployment must fail before traffic is accepted when PostgreSQL is unreachable or required tables are missing.

Paste `.env.railway.example` into Railway Variables and replace every placeholder. Keep all write gates disabled for the first deployment.

## 3. Required credentials

Store secrets in Railway only:

- `DATABASE_URL`
- `ENCRYPTION_KEY`
- `SHOPIFY_SHOP_DOMAIN`
- `SHOPIFY_ACCESS_TOKEN`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY_BASE64`

Share the Google Sheet with the service-account email. Do not enable Sheet writes during the first smoke test.

## 4. Initial safe deployment

Keep these values disabled:

```env
SYNC_RUNTIME_WRITE_ENABLED=false
SYNC_INVENTORY_AUTOSTART=false
SYNC_JOB_RECOVERY_ENABLED=false
SYNC_SHEET_IMPORT_AUTOSTART_ENABLED=false
CATALOG_AUDIT_DRY_RUN=true
CATALOG_AUDIT_WRITE_ENABLED=false
CATALOG_AUDIT_CANARY_MAX_ROWS=1
CATALOG_AUDIT_SHEET_WRITE_ENABLED=false
```

Verify in this order:

1. `GET /health` returns HTTP 200 with `database: "ok"`.
2. `GET /api/ready` returns HTTP 200, `database.ok=true`, and `configuration.safeMode=true`.
3. The frontend reaches the Railway API without a CORS error.
4. Run the production smoke workflow. It forces `dryRun=true`, `writeSheet=false`, and `maxRows=1` and supplies no write token.
5. Review the one-product audit result. HTTP 403, CAPTCHA, timeout, or blocked-source responses must remain blocked/unknown and must never be converted to out-of-stock.

Do not start recovery, inventory monitoring, or automatic Sheet import during this phase.

## 5. One-product Shopify canary

Only after CI, live readiness, and the one-product dry run succeed:

1. Keep runtime jobs and Sheet writes disabled.
2. Set `CATALOG_AUDIT_WRITE_ENABLED=true`.
3. Configure a long random `CATALOG_AUDIT_WRITE_TOKEN`.
4. Keep `CATALOG_AUDIT_CANARY_MAX_ROWS=1`.
5. Submit one request with `dryRun:false`, `maxRows:1`, `writeSheet:false`, and the correct `x-catalog-audit-write-token` header.
6. Read the product and variants back from Shopify and compare the persisted values with the intended canary result.
7. Immediately close `CATALOG_AUDIT_WRITE_ENABLED` if the request or read-back is not exact.

A successful request without successful Shopify read-back is not a successful canary.

## 6. Gradual activation

After the one-product canary and read-back succeed, enable only one additional capability at a time:

1. Optional Sheet result write.
2. Job recovery.
3. Inventory monitor.
4. Automatic Sheet import.

Each startup capability requires both `SYNC_RUNTIME_WRITE_ENABLED=true` and its own specific gate. Do not enable all startup gates in one deployment.

## 7. Rollback

For any unexpected write, failed read-back, source-block classification regression, or rising failed-job count:

1. Set all write gates to `false`.
2. Redeploy the variable-only rollback.
3. Confirm `/api/ready` reports `configuration.safeMode=true`.
4. Inspect failed and running jobs before retrying.

Do not merge the PR into `main` until Railway deployment, dry run, one-product canary, and Shopify read-back have all been directly verified.