# Brand Limit Profile System

## Overview

The Brand Limit Profile System provides per-brand rate limiting, concurrency control, and request thresholds to ensure ethical and sustainable web scraping. Each brand has conservative default profiles that can be automatically adjusted based on runtime restriction signals.

## Architecture

### Components

1. **BrandLimitProfile Type** (`src/server/scraper/types/brandLimits.ts`)
   - Type definition for brand limit configurations
   - Default profiles for 11+ supported brands
   - Utilities for applying restricted limits

2. **BrandLimitManager Service** (`src/server/scraper/services/BrandLimitManager.ts`)
   - Singleton service managing brand limits
   - Rate limit tracking and enforcement
   - Restriction signal handling
   - Request delay calculation

3. **Integration Utilities** (`src/server/scraper/services/BrandLimitIntegration.ts`)
   - Ready-to-use helper functions
   - Integration patterns for the extraction pipeline
   - Examples and documentation

## BrandLimitProfile Type

```typescript
type BrandLimitProfile = {
  brandKey: string;
  defaultMode: "static_html" | "browser_rendered" | "auto" | "restricted";
  maxConcurrency: number;
  minDelayMs: number;
  maxRequestsPerMinute: number;
  maxProductsPerRun: number;
  maxPagesPerRun: number;
  notes: string[];
};
```

### Profile Properties

- **brandKey**: Unique identifier for the brand (e.g., "next", "zara")
- **defaultMode**: Recommended extraction strategy
  - `static_html`: Use static HTML parsing only
  - `browser_rendered`: Requires JavaScript rendering
  - `auto`: Automatically choose based on content
  - `restricted`: Brand is heavily restricted or blocked
- **maxConcurrency**: Maximum concurrent requests (0 = disabled)
- **minDelayMs**: Minimum milliseconds between requests
- **maxRequestsPerMinute**: Maximum requests allowed per minute
- **maxProductsPerRun**: Maximum products to extract in one run
- **maxPagesPerRun**: Maximum pages to process in one run
- **notes**: Human-readable notes about restrictions and recommendations

## Default Brand Profiles

### Tier 1: Permissive (Auto Mode)

Brands with moderate restrictions that support auto mode extraction:

- **next**: mode=auto, 10 req/min, 80 products/run
- **gap**: mode=auto, 8 req/min, 60 products/run
- **marks_and_spencer**: mode=auto, 8 req/min, 60 products/run
- **primark**: mode=auto, 8 req/min, 60 products/run
- **mothercare**: mode=auto, 8 req/min, 60 products/run

### Tier 2: Moderate (Browser Rendered)

Brands requiring JavaScript rendering with moderate restrictions:

- **max**: mode=browser_rendered, 6 req/min, 40 products/run
- **hm**: mode=browser_rendered, 5 req/min, 35 products/run
- **lefties**: mode=browser_rendered, 5 req/min, 35 products/run
- **centrepoint**: mode=browser_rendered, 6 req/min, 40 products/run

### Tier 3: Restrictive (Browser Rendered)

Brands with strict restrictions requiring careful handling:

- **zara**: mode=browser_rendered, 4 req/min, 30 products/run
  - Note: Inditex group with aggressive anti-scraping

### Tier 4: Restricted (Manual/Feed Only)

Brands requiring alternative approaches:

- **shein**: mode=restricted, 0 concurrency
  - Note: Use public product pages, feeds, or manual import only
  - Use this only when explicitly allowed by terms of service

## Usage

### Basic Usage

```typescript
import { brandLimitManager } from "./services/BrandLimitManager.js";

// Get the profile for a brand
const profile = brandLimitManager.getProfile("next");
console.log(profile.maxRequestsPerMinute); // 10

// Get recommended extraction mode
const mode = brandLimitManager.getRecommendedMode("zara");
console.log(mode); // "browser_rendered"
```

### Rate Limiting

```typescript
import { waitForBrandRateLimit } from "./services/BrandLimitIntegration.js";

// Before making a request
await waitForBrandRateLimit("next");
// ... make your request here ...
```

### Handling Restriction Signals

```typescript
import { handleRestrictionSignals } from "./services/BrandLimitIntegration.js";
import { RestrictionDetector } from "./services/RestrictionDetector.js";

const detector = new RestrictionDetector();
const signals = detector.detectRestrictionSignals(html, statusCode);

if (signals.captchaDetected || signals.loginRequired) {
  handleRestrictionSignals("zara", signals);
  // Limits automatically adjusted to be more conservative
}
```

### Checking Extraction Limits

```typescript
import { checkExtractionLimits } from "./services/BrandLimitIntegration.js";

const { canContinue, reason } = checkExtractionLimits(
  "next",
  extractedCount,
  processedPages,
);

if (!canContinue) {
  console.log(`Stopping: ${reason}`);
}
```

### Complete Extraction Flow

```typescript
import { extractProductsWithBrandLimits } from "./services/BrandLimitIntegration.js";

const products = await extractProductsWithBrandLimits(
  "next",
  productUrls,
  async (url) => {
    // Your extraction function
    const response = await fetch(url);
    const html = await response.text();
    return extractProduct(html);
  },
);
```

## Automatic Restriction Detection

The system automatically detects and responds to:

- **Robots.txt blocks**: Checked during capability scan
- **HTTP 403 (Forbidden)**: Limits immediately reduced
- **HTTP 429 (Too Many Requests)**: Rate limits tightened
- **CAPTCHA**: Mode switched to restricted
- **Login required**: Mode switched to restricted
- **Access denied pages**: Limits reduced
- **Bot protection pages**: Limits reduced

When restrictions are detected, `applyRestrictedLimits()` is called:

```typescript
export function applyRestrictedLimits(
  profile: BrandLimitProfile,
): BrandLimitProfile {
  return {
    ...profile,
    defaultMode: "restricted",
    maxConcurrency: 0,
    minDelayMs: Math.max(profile.minDelayMs, 10000),
    maxRequestsPerMinute: Math.max(
      1,
      Math.floor(profile.maxRequestsPerMinute / 3),
    ),
    maxProductsPerRun: Math.max(5, Math.floor(profile.maxProductsPerRun / 3)),
    maxPagesPerRun: Math.max(1, Math.floor(profile.maxPagesPerRun / 3)),
    notes: [
      ...profile.notes,
      "RESTRICTED: Limits reduced due to anti-scraping signals",
    ],
  };
}
```

## Integration Points

### 1. Before Request Execution

In your adapter or fetcher:

```typescript
async fetch(url: string) {
  const brandKey = extractBrandKey(url);
  await waitForBrandRateLimit(brandKey);

  const response = await fetch(url);
  return response;
}
```

### 2. After Response Received

In your response handler:

```typescript
async handleResponse(brandKey: string, response: Response, html: string) {
  const detector = new RestrictionDetector();
  const signals = detector.detectRestrictionSignals(html, response.status);

  handleRestrictionSignals(brandKey, signals);
}
```

### 3. During Extraction Loop

In your extraction pipeline:

```typescript
for (const url of urls) {
  const { canContinue } = checkExtractionLimits(
    brandKey,
    productCount,
    pageCount,
  );

  if (!canContinue) break;

  await waitForBrandRateLimit(brandKey);
  const product = await extractProduct(url);
}
```

## Adding New Brands

To add a new brand profile:

1. Update `DEFAULT_BRAND_PROFILES` in `src/server/scraper/types/brandLimits.ts`:

```typescript
export const DEFAULT_BRAND_PROFILES: Record<string, BrandLimitProfile> = {
  // ... existing profiles ...

  new_brand: {
    brandKey: "new_brand",
    defaultMode: "auto",
    maxConcurrency: 1,
    minDelayMs: 5000,
    maxRequestsPerMinute: 8,
    maxProductsPerRun: 60,
    maxPagesPerRun: 8,
    notes: ["Brand-specific notes here"],
  },
};
```

2. The new profile will automatically be available via `getBrandLimitProfile("new_brand")`

## Testing

```typescript
import { brandLimitManager } from "./services/BrandLimitManager.js";

// Check profile
const profile = brandLimitManager.getProfile("test_brand");
console.log(profile);

// Test rate limiting
await waitForBrandRateLimit("test_brand");

// Simulate restriction
const restrictedSignals = {
  captchaDetected: true,
  loginRequired: false,
  accessDenied: false,
  botProtectionPage: false,
  geoBlocked: false,
  rateLimited: false,
  httpStatus: 200,
};

brandLimitManager.updateProfileFromSignals("test_brand", restrictedSignals);
const updated = brandLimitManager.getProfile("test_brand");
console.log(updated.defaultMode); // "restricted"
```

## Best Practices

1. **Always respect robots.txt**: Check before any extraction attempt
2. **Use appropriate delays**: Never request faster than `minDelayMs` allows
3. **Monitor HTTP status codes**: Respond appropriately to 403, 429, etc.
4. **Reduce on first restriction**: Don't wait for multiple failures
5. **Use browser rendering only when necessary**: Static HTML is faster and lighter
6. **Test with small datasets first**: Always test with a few products before full extraction
7. **Implement exponential backoff**: For repeated 429 responses
8. **Respect noindex/nofollow**: Check meta tags before scraping
9. **Use appropriate User-Agent**: Identify your application properly
10. **Cache results**: Don't re-scrape products unnecessarily

## Monitoring and Logging

The system provides utilities for monitoring:

```typescript
// Get summary for a brand
console.log(brandLimitManager.getProfileSummary("zara"));
// Output: [zara] Mode: browser_rendered, Concurrency: 1, Delay: 8000ms,
//         RateLimit: 4/min, Products: 30, Pages: 4

// Get all active profiles
const allProfiles = brandLimitManager.getAllProfiles();

// Log extraction info
console.log(getBrandLimitInfo("next"));
```

## Future Enhancements

- Persistent limit history for machine learning-based adjustments
- Per-region profile variations (e.g., Zara UK vs Zara US)
- Dynamic profile adjustment based on time of day
- User-configurable profile overrides (for premium tiers)
- A/B testing framework for safe limit increases
- Integration with analytics for success rate monitoring
- Automatic profile sharing community (opt-in)
