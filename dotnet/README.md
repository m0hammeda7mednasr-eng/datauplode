# Dabdoob Product Sync — .NET Rebuild

A clean rebuild of the product import and continuous synchronization system using **.NET 10 LTS**, ASP.NET Core, a dedicated Worker Service, PostgreSQL, EF Core 10, Google Workspace notifications, and Shopify Admin GraphQL.

> This folder is isolated from the existing Node.js application. The old production service must remain untouched until this rebuild passes CI, integration tests, a Shopify dry run, and a controlled production canary.

## Why this architecture

The system treats every import/update as a durable job instead of a long in-memory loop. API restarts, worker restarts, temporary source failures, and duplicate webhook deliveries do not lose progress or create duplicate Shopify mutations.

### Services

- `Dabdoob.Sync.Api`
  - health endpoints
  - manual enqueue endpoint
  - Google Drive webhook receiver
  - run/status API
- `Dabdoob.Sync.Worker`
  - atomically claims jobs with PostgreSQL `FOR UPDATE SKIP LOCKED`
  - leases jobs so another worker can recover them after a crash
  - exponential retries with jitter
  - dead-letter state after the configured attempt limit
- `Dabdoob.Sync.Infrastructure`
  - EF Core/PostgreSQL persistence
  - unique idempotency keys
  - sheet-row and source identity indexes
- `Dabdoob.Sync.Domain`
  - catalog state
  - source-blocked/manual-review states
  - job lifecycle

## Non-negotiable sync rules

1. Match Shopify products and variants using canonical source identity, SKU, color, size, and option signature. Never match by title alone.
2. Only mutate an existing `ACTIVE` Shopify product/variant unless a separate, explicitly approved create-product job is used.
3. Price = current source price for the exact option × the row multiplier, rounded to two decimals.
4. Confirmed source availability maps to inventory `10`; confirmed out-of-stock maps to `0`.
5. HTTP 403, CAPTCHA, blocked JavaScript, timeout, stale cache, or unavailable source data is **not** proof of out-of-stock. Preserve the last verified Shopify price/inventory and mark the item `SourceBlocked`.
6. Every Shopify mutation must use an idempotency key and must be followed by a read-back verification.
7. A row is `Verified` only after source, exact variant, price, SKU, and inventory all match after read-back.
8. Every change and failure remains auditable in PostgreSQL.

## Automatic update flow

1. Google Drive sends a webhook when the spreadsheet file changes.
2. The API stores an idempotent reconciliation job.
3. The Worker reads the changed rows and hashes their meaningful values.
4. Only new/changed rows create catalog reconciliation jobs.
5. A source adapter reads the current exact product/variant data.
6. A Shopify GraphQL client finds the exact active variant.
7. The worker calculates a mutation plan.
8. The worker applies price/SKU/inventory mutations with idempotency.
9. The worker reads the Shopify variant again and stores the verified result.
10. A periodic fallback reconciliation runs even when a webhook is delayed or missed.

## Source access policy

A framework cannot make a blocked source reliable by itself. For sources that reject server/cloud traffic, production must use one of these permitted inputs:

- an official API or product feed;
- a merchant/brand-authorized integration;
- public HTML that the source allows automated access to;
- an authorized local worker operated from the merchant environment.

The system must not bypass CAPTCHA, anti-bot protections, authentication, or access controls. Restricted sources remain `SourceBlocked` and are retried safely without changing Shopify data.

## Local run

```bash
cp .env.example .env
docker compose up --build
```

Endpoints:

- API: `http://localhost:8080`
- live: `http://localhost:8080/health/live`
- ready: `http://localhost:8080/health/ready`
- status: `http://localhost:8080/api/sync/status`

## Railway deployment shape

Create three Railway services from the same repository and `dotnet` root directory:

1. PostgreSQL
2. API using `Dockerfile.api`
3. Worker using `Dockerfile.worker`

Set the same `ConnectionStrings__Postgres` value on API and Worker. Store Google and Shopify credentials only as Railway secrets; never commit them.

## Current rebuild status

Foundation implemented:

- domain entities and explicit states;
- durable PostgreSQL job queue;
- unique idempotency keys;
- atomic multi-worker job claiming;
- leases, retries, jitter, and dead-letter handling;
- API health/status/enqueue endpoints;
- Google Drive webhook ingestion;
- isolated API and Worker containers;
- local PostgreSQL stack.

Still required before production activation:

- Google Sheets reader and Drive watch renewal handler;
- canonical URL normalizer and row-change hashing;
- source adapters, starting with Next;
- Shopify GraphQL exact-variant lookup, mutation, inventory compare-and-set, and read-back;
- sheet color/note writer;
- integration tests against a Shopify development store;
- canary run, metrics, and alerts.
