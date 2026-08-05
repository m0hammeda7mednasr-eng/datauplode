# Fast Production Path: Existing App + Supabase + Railway

This is the supported fast path for the existing Node/React/Prisma application. The .NET rebuild is not required for this deployment.

## Architecture

- Frontend: existing Vercel app
- API + background sync jobs: existing Node/Express application on Railway
- Database: a dedicated Supabase Postgres project
- ORM/schema: existing Prisma schema
- Shopify: existing Shopify Admin integration
- Google Sheet: service-account access to `dap_data`

## 1. Supabase

Create a dedicated project named `dabdoob-product-sync` in an EU region.

Open **Connect** and copy the **Supavisor Session pooler** connection string. Use port `5432` for the long-running Railway server.

Set it as `DATABASE_URL` in Railway and append:

```text
?sslmode=require&connection_limit=10&pool_timeout=20
```

Do not use a different existing project's database.

## 2. Railway service

Create one Railway service from:

- Repository: `m0hammeda7mednasr-eng/datauplode`
- Branch during testing: `stabilize-supabase-railway`
- Builder: Dockerfile (auto-detected by `railway.json`)
- Pre-deploy: `npx prisma db push`
- Start: Docker `CMD`, which runs `npm start`
- Healthcheck: `/health`

Generate a public domain after the first successful deployment.

Paste the variables from `.env.railway.example` into Railway's Variables editor and replace placeholders.

## 3. Required credentials

Store secrets in Railway only:

- `DATABASE_URL`
- `ENCRYPTION_KEY`
- `SHOPIFY_SHOP_DOMAIN`
- `SHOPIFY_ACCESS_TOKEN`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY_BASE64`

Share the Google Sheet with the service-account email as Editor.

## 4. Safe activation

Start with:

```text
CATALOG_AUDIT_DRY_RUN=true
```

Verify:

1. `/health` returns HTTP 200 and `database: ok`.
2. The UI can reach the Railway API without a CORS error.
3. The Sheet importer reads rows and creates jobs.
4. Shopify lookup resolves exact existing ACTIVE products/variants.
5. A canary report shows intended price/SKU/inventory changes without applying them.

Only after the canary is correct, set:

```text
CATALOG_AUDIT_DRY_RUN=false
```

Deploy the staged Railway variable change, run a five-product canary, and verify Shopify read-back before widening the batch.

## 5. Rollback

If a deployment fails its healthcheck, Railway keeps the previous deployment active. If a canary fails, immediately restore `CATALOG_AUDIT_DRY_RUN=true` and redeploy the variable change.
