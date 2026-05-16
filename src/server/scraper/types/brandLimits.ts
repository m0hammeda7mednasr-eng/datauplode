export type BrandLimitProfile = {
  brandKey: string;
  defaultMode:
    | "static_html"
    | "browser_rendered"
    | "auto"
    | "restricted"
    | "manual_review_or_feed";
  maxConcurrency: number;
  minDelayMs: number;
  maxRequestsPerMinute: number;
  maxProductsPerRun: number;
  maxPagesPerRun: number;
  notes: string[];
};

const FALLBACK_PROFILE: BrandLimitProfile = {
  brandKey: "unknown",
  defaultMode: "auto",
  maxConcurrency: 1,
  minDelayMs: 5000,
  maxRequestsPerMinute: 8,
  maxProductsPerRun: 50,
  maxPagesPerRun: 20,
  notes: [
    "Conservative default profile for unknown brands.",
    "Automatically tightened when restriction signals appear.",
  ],
};

export const DEFAULT_BRAND_PROFILES: Record<string, BrandLimitProfile> = {
  next: {
    brandKey: "next",
    defaultMode: "auto",
    maxConcurrency: 1,
    minDelayMs: 4000,
    maxRequestsPerMinute: 10,
    maxProductsPerRun: 80,
    maxPagesPerRun: 20,
    notes: ["Conservative free profile for Next."],
  },
  max: {
    brandKey: "max",
    defaultMode: "browser_rendered",
    maxConcurrency: 1,
    minDelayMs: 6000,
    maxRequestsPerMinute: 6,
    maxProductsPerRun: 40,
    maxPagesPerRun: 15,
    notes: ["Prefer public browser-rendered pages with strict pacing."],
  },
  shein: {
    brandKey: "shein",
    defaultMode: "manual_review_or_feed",
    maxConcurrency: 1,
    minDelayMs: 9000,
    maxRequestsPerMinute: 4,
    maxProductsPerRun: 20,
    maxPagesPerRun: 10,
    notes: [
      "Use only public product pages, supplier feeds, or manual import when allowed.",
      "If restriction signals appear, scanner must switch to restricted mode.",
    ],
  },
  hm: {
    brandKey: "hm",
    defaultMode: "browser_rendered",
    maxConcurrency: 1,
    minDelayMs: 7000,
    maxRequestsPerMinute: 5,
    maxProductsPerRun: 35,
    maxPagesPerRun: 15,
    notes: ["Conservative browser profile for H&M public pages."],
  },
  lefties: {
    brandKey: "lefties",
    defaultMode: "browser_rendered",
    maxConcurrency: 1,
    minDelayMs: 7000,
    maxRequestsPerMinute: 5,
    maxProductsPerRun: 35,
    maxPagesPerRun: 15,
    notes: ["Conservative browser profile for Lefties public pages."],
  },
  centrepoint: {
    brandKey: "centrepoint",
    defaultMode: "browser_rendered",
    maxConcurrency: 1,
    minDelayMs: 6000,
    maxRequestsPerMinute: 6,
    maxProductsPerRun: 40,
    maxPagesPerRun: 15,
    notes: ["Conservative browser profile for Centrepoint public pages."],
  },
  gap: {
    brandKey: "gap",
    defaultMode: "auto",
    maxConcurrency: 1,
    minDelayMs: 5000,
    maxRequestsPerMinute: 8,
    maxProductsPerRun: 60,
    maxPagesPerRun: 20,
    notes: ["Auto mode with conservative free limits."],
  },
  zara: {
    brandKey: "zara",
    defaultMode: "browser_rendered",
    maxConcurrency: 1,
    minDelayMs: 8000,
    maxRequestsPerMinute: 4,
    maxProductsPerRun: 30,
    maxPagesPerRun: 12,
    notes: ["Strict conservative pacing for Zara public pages."],
  },
  marks_and_spencer: {
    brandKey: "marks_and_spencer",
    defaultMode: "auto",
    maxConcurrency: 1,
    minDelayMs: 5000,
    maxRequestsPerMinute: 8,
    maxProductsPerRun: 60,
    maxPagesPerRun: 20,
    notes: ["Auto mode with conservative free limits."],
  },
  primark: {
    brandKey: "primark",
    defaultMode: "auto",
    maxConcurrency: 1,
    minDelayMs: 5000,
    maxRequestsPerMinute: 8,
    maxProductsPerRun: 60,
    maxPagesPerRun: 20,
    notes: ["Auto mode with conservative free limits."],
  },
  mothercare: {
    brandKey: "mothercare",
    defaultMode: "auto",
    maxConcurrency: 1,
    minDelayMs: 5000,
    maxRequestsPerMinute: 8,
    maxProductsPerRun: 60,
    maxPagesPerRun: 20,
    notes: ["Auto mode with conservative free limits."],
  },
};

export function getBrandLimitProfile(brandKey: string): BrandLimitProfile {
  return (
    DEFAULT_BRAND_PROFILES[brandKey] ?? {
      ...FALLBACK_PROFILE,
      brandKey,
    }
  );
}

export function applyRestrictedLimits(
  profile: BrandLimitProfile,
): BrandLimitProfile {
  return {
    ...profile,
    defaultMode: "restricted",
    maxConcurrency: 0,
    minDelayMs: Math.max(profile.minDelayMs, 10000),
    maxRequestsPerMinute: 0,
    maxProductsPerRun: 0,
    maxPagesPerRun: 0,
    notes: [
      ...profile.notes,
      "Restricted profile activated due to robots/rate-limit/security signals.",
    ],
  };
}
