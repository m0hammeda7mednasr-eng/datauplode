# Catalog audit production safety

The catalog audit endpoint is safe-by-default in this branch.

## Default behavior

`POST /api/catalog-audit/run` is forced to dry-run mode unless all write conditions below are met. Dry-run also forces `writeSheet=false`.

## Canary write requirements

Set these Railway variables:

```env
CATALOG_AUDIT_WRITE_ENABLED=false
CATALOG_AUDIT_WRITE_TOKEN=generate-a-long-random-secret
CATALOG_AUDIT_CANARY_MAX_ROWS=5
```

To enable a controlled canary:

1. Set `CATALOG_AUDIT_WRITE_ENABLED=true`.
2. Send JSON with `dryRun:false` and a positive `maxRows`.
3. Send the secret in the `x-catalog-audit-write-token` request header.

The server caps writes to `CATALOG_AUDIT_CANARY_MAX_ROWS`, with a hard maximum of 25 rows. A missing or incorrect token returns HTTP 403. Full-catalog writes are intentionally not available through this endpoint.

## Recommended rollout

1. Deploy with `CATALOG_AUDIT_WRITE_ENABLED=false`.
2. Verify `/health` and run dry-run for 5 rows.
3. Review matches and source extraction results.
4. Enable write mode and run a 1-row canary.
5. Verify Shopify read-back and the sheet result.
6. Increase to 5 rows only after the 1-row canary is correct.

## Current first-eight sheet auto-sync note

Checked on 2026-08-11 01:47 Africa/Cairo.

- Latest Railway deployment `a4e5fa96-b82b-4190-a9b9-c45caeef6103` is successful.
- The first-eight-sheet worker is running on revision `d301219189fa71e22bda02e61658751a9c179996`.
- Live target is capped at 5000 unique rows from the first eight configured Google Sheet tabs.
- Current verified progress: 788 / 5000.
- Current Shopify work split: 338 existing products updated, 450 missing products published.
- Current running marker is cycle 62 in `publish_missing_products` with no marker-level `lastError`.
- Current safe/retryable candidate set is 3007 rows; this is not the 5000-row business target, because many older processed-but-unverified rows remain failed closed behind source-site blocks or non-retryable validation failures.
- Historical unverified failures are mostly source-site blocks from Centrepoint, SHEIN, and Next; current H&M price-validation retries are no longer producing fresh `Product source price is invalid` issues in the active marker.
- Current Google Sheet SKU writeback still cannot complete from Railway/Codex because Google writer credentials are not configured in Railway and the Google Drive connector is not connected in Codex.
- `SYNC_SHEET1_CATALOG_BLOCKED_HOST_FAST_SKIP_THRESHOLD=5` is enabled so repeated blocked source hosts can be failed closed faster without publishing incomplete products.
- The worker now seeds blocked-host fast-skip counts from recent failed-closed issues so deploys and later cycles do not restart known blocked hosts from zero.
- Blocked-host fast-skip now resets a host after a non-blocked row-level failure, so variant/data validation errors (for example unsafe Next variant structure) do not keep the whole source host closed.
- Previously failed blocked-source rows can now be re-verified through a bounded fingerprint-tracked recovery path, capped by `SYNC_SHEET1_CATALOG_BLOCKED_HOST_RETRY_ROWS_PER_CYCLE` (default 20).
- Existing-product variant reconciliation now has a safe SKU-size fallback: it only maps through the current SKU when exactly one fresh source variant matches the SKU size suffix.
- H&M rows that previously failed with `Product source price is invalid` are now eligible for a narrow re-verification retry; the normal price validation still prevents publishing if the source price is not valid.
- H&M price-validation recovery is now bounded by row fingerprint so an unrecovered H&M row is retried once for that exact sheet state, then fails closed again until the row changes.
- H&M price-validation recovery is also capped per worker cycle through `SYNC_SHEET1_CATALOG_HM_PRICE_RETRY_ROWS_PER_CYCLE` (default 10) so it cannot monopolize progress on other source hosts.
