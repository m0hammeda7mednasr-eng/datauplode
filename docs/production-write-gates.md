# Production write gates

The application starts in safe mode by default. Deploying the service, applying the Prisma schema, and passing `/api/ready` must not automatically resume old jobs or start inventory writes.

## Initial Railway deployment

Keep these values disabled during the first live deployment and production smoke test:

```env
SYNC_RUNTIME_WRITE_ENABLED=false
SYNC_INVENTORY_AUTOSTART=false
CATALOG_AUDIT_WRITE_ENABLED=false
```

With `SYNC_RUNTIME_WRITE_ENABLED=false`, server startup does **not**:

- recover and execute interrupted sync jobs;
- start the scheduled inventory monitor;
- start the one-time Google Sheet import.

`GET /api/ready` exposes the runtime and catalog write gates and reports `safeMode: true` while either gate remains closed.

## Required activation order

1. Deploy with all write gates disabled.
2. Verify `/health` and `/api/ready`.
3. Run the production smoke test with one product and no write token.
4. Complete a catalog Dry Run.
5. Enable only the catalog audit write gate for a one-product Canary and verify Shopify read-back.
6. Review the stored audit result and Google Sheet result.
7. Only then set `SYNC_RUNTIME_WRITE_ENABLED=true` to permit job recovery, scheduled inventory sync, and sheet import.

Keep `SYNC_INVENTORY_AUTOSTART=false` until scheduled inventory updates are explicitly approved. Enabling `SYNC_RUNTIME_WRITE_ENABLED` alone permits recovery and sheet import, but the inventory monitor still respects its own autostart flag.

## Source failures

HTTP 403, CAPTCHA, timeout, and other source-access failures are treated as blocked or unknown states. They must never be translated into out-of-stock inventory.
