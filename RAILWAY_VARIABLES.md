# Railway production variables

> Security rule: **never commit real API keys, Shopify tokens, database passwords, or encryption keys to this repository.** Set secret values only in Railway Variables / the deployment secret store.

## URLs

```env
APP_URL=https://datauplode-production.up.railway.app
FRONTEND_URL=https://datauplode.vercel.app
CORS_ORIGINS=https://datauplode-production.up.railway.app,https://datauplode.vercel.app
```

## Database and encryption

Set these in Railway only:

```env
DATABASE_URL=<set-in-railway>
DIRECT_URL=<set-in-railway-if-required>
ENCRYPTION_KEY=<set-in-railway>
```

## Shopify

Production Shopify credentials must remain in Railway / the encrypted `ShopifyConnection` record. Do not commit them here.

```env
SHOPIFY_SHOP_DOMAIN=<set-in-railway-if-env-credentials-are-used>
SHOPIFY_ACCESS_TOKEN=<set-in-railway-if-env-credentials-are-used>
```

## ScraperAPI

Rotate any key that has ever been committed to Git history, then store the new value in Railway only.

```env
SCRAPERAPI_KEY=<set-in-railway>
# Or, when intentionally using a pool:
# SCRAPERAPI_KEYS=<set-in-railway>

# Operational slice: keep 20,000 of the 100,000 Hobby credits outside this app.
SCRAPERAPI_MONTHLY_CREDIT_LIMIT=80000
SCRAPERAPI_BILLING_CYCLE_DAY=3

# For the current billing cycle only, set this to credits already consumed
# before the new guard is deployed. Reset to 0 at the next renewal.
SCRAPERAPI_CYCLE_OPENING_USED_CREDITS=0

# Optional explicit daily override. If omitted, the app derives a daily pace
# from the 80,000-credit operational cap and the actual billing-cycle length.
# SCRAPERAPI_DAILY_CREDIT_LIMIT=2667

# Expensive modes should be enabled only for sources that actually need them.
SCRAPERAPI_RENDER=false
SCRAPERAPI_PREMIUM=false
SCRAPERAPI_ULTRA_PREMIUM=false
```

For the Sep 3, 2026 -> Oct 3, 2026 cycle, after rotating the exposed key, set `SCRAPERAPI_CYCLE_OPENING_USED_CREDITS` to the ScraperAPI dashboard usage observed at the moment of rotation so the app cannot consume the reserved 20,000 credits.
