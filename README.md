# Syncly Product Source Scanner + Extraction Engine

React + Node.js + Prisma app for **legal, brand-aware product source scanning** and public product extraction.

## What this module does
- Scans a source URL before scraping.
- Detects if extraction is allowed and technically possible.
- Uses only public/legal signals:
  - `robots.txt`
  - sitemaps
  - public product pages
  - JSON-LD / OpenGraph / embedded public state
  - static HTML
  - browser rendering (Playwright) only for public pages
- Returns a full `SourceCapabilityReport` with strategy, warnings, and conservative free limits.

## Critical safety rules
- No CAPTCHA bypass.
- No anti-bot bypass.
- No stealth/fingerprint spoofing.
- No private/authenticated APIs.
- Respect `robots.txt`, terms, rate limits, and permissions.
- If blocked/restricted, stop and return restricted/manual status.

## UI
- New page: `/scraper/source-scan`
- Features:
  - URL input + scan
  - brand/access/discovery/signal/restriction cards
  - recommended strategy + safe limits
  - `Start Extraction Using Recommended Strategy`
  - Restricted mode guard:
    - `This source needs permission, feed, API, or manual import.`

### Bulk Excel Import (New)
- New page: `/excel-sheet`
- Upload `.xlsx`, `.xls`, or `.csv`, choose URL column, then run one bulk import.
- Each valid row is analyzed and queued for Shopify publish automatically.
- Rows already linked to Shopify are marked as `Skipped` (not treated as failed issues).
- Failed rows are auto-created in `Manual Review` (`/review`) with the error reason.
- API endpoint: `POST /api/imports/excel/process`
- Optional env: `EXCEL_IMPORT_MAX_ROWS` (default: `300`)

### Google Sheet Link + Auto Sync (New)
- Supported columns in Google Sheet: `link` (or `url`), optional `price`, optional `collection`.
- Manual run from link:
  - `POST /api/imports/excel/process-sheet-link`
- Auto sync controls:
  - `GET /api/imports/excel/auto-sync/status`
  - `POST /api/imports/excel/auto-sync/start`
  - `POST /api/imports/excel/auto-sync/stop`
- Run tracking (professional timeline):
  - `GET /api/imports/excel/runs`
  - `GET /api/imports/excel/runs/:id`
- Each run now reports `published`, `skipped`, `failed`, and manual-review count.
- Auto sync processes only new/changed rows based on `link + price + collection`.
- Optional env:
  - `GOOGLE_SHEET_FETCH_TIMEOUT_MS` (default `20000`)
  - `GOOGLE_SHEET_PROCESSED_ROWS_TTL_HOURS` (default `720`)

## API
- `POST /api/source-scan`
- `GET /api/source-scan/:id`
- `POST /api/source-scan/:id/start-extraction`
- `GET /api/source-scans`

## Core scanner services
- `src/server/scraper/services/SourceCapabilityScanner.ts`
- `BrandDetector.ts`
- `RobotsParser.ts`
- `SitemapDiscovery.ts`
- `RestrictionDetector.ts`
- `ExtractionSignalsDetector.ts`
- `ArabicReportGenerator.ts`

## Prisma models
- `SourceScan`
- `SourceCapabilityReport`
- `SourceWarning`
- `SourceLimitProfile`

## Conservative brand limit profiles
Configured in:
- `src/server/scraper/types/brandLimits.ts`

Supported target brands:
- Next
- Max Fashion
- SHEIN
- H&M
- Lefties
- Centrepoint
- Gap
- Zara
- Marks & Spencer
- Primark
- Mothercare

## Run
```bash
npm install
npm run db:push
npm run dev
```

## Tests
```bash
npm run test:source-scan
npm run test:extraction-engine
npm run test:brand-limits
npm run test:scraper:all
```

## Environment
Copy `.env.example` and set:
- `DATABASE_URL`
- `ENCRYPTION_KEY`
- `APP_URL`
- `FRONTEND_URL`
- optional scraper/log settings

Validate env before running:
```bash
npm run env:check
```

### Pro Bypass Routing (Optional)
- Configure global bypass mode via `SCRAPER_BYPASS_MODE` (`never` / `auto` / `always`).
- Split routing into two lanes:
  - `Brand Lane` (direct scraping): set brand mode to `never`.
  - `Default Lane` (hard domains): keep `default:auto` (or `default:always`) so API pool is used only when needed.
- Override per brand with `SCRAPER_BRAND_BYPASS_MODE_MAP`.
- Configure provider pool order via `SCRAPER_BYPASS_PROVIDERS`.
- Set monthly provider token budgets via `SCRAPER_BYPASS_PROVIDER_MONTHLY_LIMITS`.
- Enable provider racing for hard Next pages with `NEXT_FAST_BYPASS_RACE=true`.
  This races only the first `SCRAPER_BYPASS_RACE_MAX_PROVIDERS` available providers, so cold requests can return from the fastest provider while quotas still cap usage.
- Keep import responses warm across local/server restarts with `SCRAPE_ANALYZE_PERSISTENT_CACHE=true`.
- Use `ANALYZE_PREWARM_WAIT_MS` so an Analyze click waits briefly for an in-flight prewarm instead of starting a duplicate scrape.
- Add provider keys for hard domains (`SCRAPERAPI_KEY`, `ZENROWS_API_KEY`, `SCRAPINGBEE_API_KEY`, `SCRAPINGANT_API_KEY`, `SCRAPEDO_TOKEN`).

Example:
```env
SCRAPER_BYPASS_MODE=auto
SCRAPER_BRAND_BYPASS_MODE_MAP=mothercare:never,marks_spencer:never,centrepoint:never,lefties:never,adidas:never,next:auto,max_fashion:auto,shein:always,default:auto
SCRAPER_BYPASS_PROVIDERS=scraperapi,zenrows,scrapingbee,scrapingant,scrapedo
SCRAPER_BYPASS_PROVIDER_MONTHLY_LIMITS=scraperapi:50000,zenrows:30000,scrapingbee:20000,scrapingant:20000,scrapedo:20000
SCRAPE_ANALYZE_PERSISTENT_CACHE=true
ANALYZE_PREWARM_WAIT_MS=2500
NEXT_LISTING_FAST_BYPASS=true
NEXT_LISTING_CACHE_MINUTES=60
NEXT_LISTING_BYPASS_RACE=true
NEXT_FAST_BYPASS_DEVICE=mobile
NEXT_FAST_BYPASS_PREMIUM=false
NEXT_FAST_BYPASS_RACE=true
SCRAPER_BYPASS_RACE_MAX_PROVIDERS=2
```

### Local Scraping Only (No external bypass or site APIs)
If you want to run only your in-house scrapers and avoid external bypass/API calls:

```env
SCRAPER_LOCAL_ONLY_MODE=true
SCRAPER_BYPASS_MODE=never
SCRAPER_READER_FALLBACK=false
NEXT_SITE_API_ENABLED=false
```

This keeps extraction on direct HTML/browser-rendered scraping and falls back to pasted page snapshots when blocked.

### Local Worker Bridge (Free alternative to paid bypass)
If a source blocks cloud/server IPs (for example `next.ae` returning `403`), keep production API running on Railway and run a small local worker on your machine:

```env
LOCAL_BRIDGE_ENABLED=true
LOCAL_BRIDGE_REQUIRE_TOKEN=true
LOCAL_BRIDGE_TOKEN=your-strong-random-token
```

Run the worker locally:

```bash
npm run bridge:worker
```

For challenge-heavy domains, run the worker with a visible browser and allow interactive solve:

```env
LOCAL_BRIDGE_HEADLESS=false
LOCAL_BRIDGE_ALLOW_INTERACTIVE_SOLVE=true
LOCAL_BRIDGE_INTERACTIVE_WAIT_MS=90000
LOCAL_BRIDGE_PROMPT_ON_BLOCKED=true
```

How it works:
- Production returns a blocked response and creates a local bridge task.
- Your local worker claims the task, opens the URL with Playwright from your local IP, captures visible page text, and submits it back.
- Import Product page can then re-analyze automatically using that snapshot result.
