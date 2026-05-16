# Product Extraction Engine

Professional, review-first extraction for permitted supplier sources.

## What Is Included

- Source adapters for static HTML, browser-rendered pages, sitemap discovery, CSV, XML, JSON feeds, and manual product URLs.
- Extraction priority: URL/domain checks, robots.txt, restricted-page detection, JSON-LD, embedded public app state, Open Graph, DOM selectors, then browser fallback.
- Zod validated normalized product schema, confidence scoring, warnings, review statuses, and import preparation records.
- Prisma models for `Source`, `CrawlJob`, `ProductUrl`, `ExtractedProduct`, `ProductWarning`, `ExtractionLog`, and `ImportBatch`.
- React pages at `/scraper`, `/scraper/jobs/:id`, `/products/review`, `/products/review/:id`, and `/sources`.

## Safety Rules

The engine does not implement CAPTCHA bypass, anti-bot bypass, stealth plugins, fingerprint spoofing, or private API access. If a source blocks crawling, requires login, or disallows crawling in robots.txt, extraction stops and returns a restricted status for review.

## Setup

```bash
npm install
npm run db:push
npm run test:extraction-engine
npm run lint
npm run dev
```

For BullMQ processing, configure `REDIS_URL` and run a dedicated process that imports `startScraperWorker()` from `src/server/scraper/workers/scraperWorker.ts`.
