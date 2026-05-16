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
```

## Environment
Copy `.env.example` and set:
- `DATABASE_URL`
- `APP_URL`
- `FRONTEND_URL`
- optional scraper/log settings
