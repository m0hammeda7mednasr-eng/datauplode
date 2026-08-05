# Catalog Audit — Existing Products Only

This workflow is intentionally separate from Excel/Google Sheet import.

## Safety rules

- **Never creates a Shopify product.**
- **Never deletes or rebuilds a Shopify product.**
- Updates only variants that already exist on an existing Shopify product.
- A row is green only after Shopify read-back verifies the expected price and SKU.
- A row is red only when the product cannot be found in Shopify.
- Ambiguous matches, blocked sources, and verification failures are orange and are not treated as missing products.

## Price rule

For each source variant:

```text
Shopify price = current source price × row multiplier
```

When the same normalized source URL appears more than once in the selected sheets, the audit uses the lowest valid multiplier and applies the same verified result to all duplicate rows.

## SKU rule

Every existing Shopify variant receives a deterministic, unique SKU:

```text
DAB-BRAND-PRODUCTCODE-OPTIONS-HASH
```

The SKU remains stable across repeated runs and can be used to find the product quickly in Shopify.

## Default sheets

The route is preconfigured for:

- الورقة1
- الورقة2
- الورقة15
- الورقة10
- الورقة6
- الورقة7
- الورقة8
- الورقة20
- الورقة9
- الورقة11

It detects the product URL, multiplier, and collection even when columns are shifted.

## API

### Read configuration

```http
GET /api/catalog-audit/config
```

### Run a batch

```http
POST /api/catalog-audit/run
Content-Type: application/json

{
  "spreadsheetUrl": "https://docs.google.com/spreadsheets/d/1fCbPajWL3nukX0TdoN1m2X8LV3pfPsxSMLBb0yWug2w/edit",
  "offset": 0,
  "maxRows": 100,
  "dryRun": false,
  "writeSheet": true
}
```

Use `summary.nextOffset` for the next batch while `summary.hasMore` is true.

### Previous runs

```http
GET /api/catalog-audit/runs?take=10
```

## Required environment

```env
DATABASE_URL=postgresql://...
ENCRYPTION_KEY=...
CATALOG_AUDIT_SHEET_URL=https://docs.google.com/spreadsheets/d/1fCbPajWL3nukX0TdoN1m2X8LV3pfPsxSMLBb0yWug2w/edit
GOOGLE_SERVICE_ACCOUNT_EMAIL=...
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=...
```

Share the Google Sheet with `GOOGLE_SERVICE_ACCOUNT_EMAIL` as an editor. A temporary `GOOGLE_SHEETS_ACCESS_TOKEN` may be used instead.

The existing Shopify connection stored in the database is used for Shopify reads and updates.
