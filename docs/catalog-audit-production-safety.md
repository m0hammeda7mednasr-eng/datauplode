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

Checked on 2026-08-11 01:27 Africa/Cairo.

- Latest Railway deployment `fb34aa07-16d7-453d-a8ce-06977458502f` is successful.
- The first-eight-sheet worker is running on revision `cd28855f55258ade9b3ab1b1cfc30727e8bf9bdc`.
- Live target is capped at 5000 unique rows from the first eight configured Google Sheet tabs.
- Current verified progress: 780 / 5000.
- Current Shopify work split: 337 existing products updated, 443 missing products published.
- Current unverified failures: 2762, mostly source-site blocks from Centrepoint, SHEIN, and Next, plus retryable H&M price-validation rows.
- Recent blocked-host fast-skips: 144 rows failed closed after repeated scrape blocks (Centrepoint, Next, and SHEIN).
- Current Google Sheet SKU writeback pending: 533 cells.
- Google Sheet writeback is pending because Google writer credentials are not configured in Railway and the Google Drive connector is not connected in Codex.
- `SYNC_SHEET1_CATALOG_BLOCKED_HOST_FAST_SKIP_THRESHOLD=5` is enabled so repeated blocked source hosts can be failed closed faster without publishing incomplete products.
- The worker now seeds blocked-host fast-skip counts from recent failed-closed issues so deploys and later cycles do not restart known blocked hosts from zero.
- Existing-product variant reconciliation now has a safe SKU-size fallback: it only maps through the current SKU when exactly one fresh source variant matches the SKU size suffix.
- H&M rows that previously failed with `Product source price is invalid` are now eligible for a narrow re-verification retry; the normal price validation still prevents publishing if the source price is not valid.
