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

Checked on 2026-08-11 05:40 Africa/Cairo.

- Latest Railway deployment `a1d151ce-5129-4480-9eb4-257b78589939` is successful.
- The first-eight-sheet worker is running on revision `7e60d004b3b3b209fa8dab00aecad75dc38d1e70`.
- Live target is capped at 5000 unique rows from the first eight configured Google Sheet tabs.
- Current verified progress: 877 / 5000.
- Current Shopify work split: 344 existing products updated, 533 missing products published.
- Current active Shopify catalog count: 792 active/sync-enabled products.
- Current running marker is cycle 104 in `publish_missing_products` with no marker-level `lastError`.
- Current safe/retryable candidate set is 191 rows after raising the blocked-source recovery cap.
- Historical unverified failures are mostly source-site blocks from Next and SHEIN, plus price/data-quality failures from H&M and Centrepoint. The worker now fails these closed instead of publishing incomplete products.
- A previously published SHEIN rate-limit page (`You have too many requests, which exceeds our limit.`) was quarantined: Shopify status set to `draft`, local sync disabled, and source status set to `error`.
- Latest suspicious-active audit returned zero active products matching the known bad-price / wrong-currency / SHEIN challenge patterns.
- Current Google Sheet SKU writeback still cannot complete from Railway/Codex because Google writer credentials are not configured in Railway (`googleWriter=false`) and the Google Drive connector is not connected in Codex.
- `SYNC_POST_CANARY_BROAD_WRITES_ENABLED=true` is enabled after the SHEIN guard passed production smoke testing.
- `SYNC_SHEET1_CATALOG_BLOCKED_HOST_FAST_SKIP_THRESHOLD=3`, `SYNC_SHEET1_CATALOG_BLOCKED_HOST_PROBES_PER_CYCLE=1`, `SYNC_SHEET1_CATALOG_BLOCKED_HOST_RETRY_ROWS_PER_CYCLE=250`, `SYNC_SHEET1_CATALOG_HM_PRICE_RETRY_ROWS_PER_CYCLE=20`, and `SYNC_SHEET1_CATALOG_CONCURRENCY=4` are enabled so repeated blocked source hosts can be failed closed faster while newly recoverable rows are retried at a practical pace.
- The worker now seeds blocked-host fast-skip counts from recent failed-closed issues so deploys and later cycles do not restart known blocked hosts from zero.
- Blocked-host fast-skip now resets a host after a non-blocked row-level failure, so variant/data validation errors (for example unsafe Next variant structure) do not keep the whole source host closed.
- Previously failed blocked-source rows can now be re-verified through a bounded fingerprint-tracked recovery path, capped by `SYNC_SHEET1_CATALOG_BLOCKED_HOST_RETRY_ROWS_PER_CYCLE` (default 20).
- Blocked hosts also get bounded live probes per cycle through `SYNC_SHEET1_CATALOG_BLOCKED_HOST_PROBES_PER_CYCLE`, which matters when a supplier has mixed URLs where some are blocked and some scrape correctly.
- Existing-product variant reconciliation now has a safe SKU-size fallback: it only maps through the current SKU when exactly one fresh source variant matches the SKU size suffix.
- H&M rows that previously failed with `Product source price is invalid` are now eligible for a narrow re-verification retry; the normal price validation still prevents publishing if the source price is not valid.
- H&M price-validation recovery is now bounded by row fingerprint so an unrecovered H&M row is retried once for that exact sheet state, then fails closed again until the row changes.
- H&M price-validation recovery is also capped per worker cycle through `SYNC_SHEET1_CATALOG_HM_PRICE_RETRY_ROWS_PER_CYCLE` (default 10) so it cannot monopolize progress on other source hosts.
- Centrepoint bridge snapshots now extract product state from the page state and prefer the current active variant AED price, which restored safe publishing for many Centrepoint rows.
- Centrepoint private-use currency glyphs in local bridge snapshots (for example the visible `AED` glyph before a number) are normalized to explicit `AED` before parsing, and currency-token detection no longer misreads words like `Title` as `TL/TRY`.
- SHEIN snapshots are rejected when the captured page is a challenge/rate-limit page, uses an untrusted currency, or has no product images.
- Bridge `Reader fallback returned an access-denied or missing page` errors are now classified as blocked-source failures, so Next/SHEIN access-denied rows feed the fast-skip/recovery logic instead of being retried as ordinary unknown errors.
