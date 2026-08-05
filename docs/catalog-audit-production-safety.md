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
