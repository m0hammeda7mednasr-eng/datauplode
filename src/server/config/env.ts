type NodeEnv = "development" | "production" | "test";

type RuntimeValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;

  const startsWithSingle = trimmed.startsWith("'");
  const endsWithSingle = trimmed.endsWith("'");
  if (startsWithSingle && endsWithSingle) {
    return trimmed.slice(1, -1).trim();
  }

  const startsWithDouble = trimmed.startsWith('"');
  const endsWithDouble = trimmed.endsWith('"');
  if (startsWithDouble && endsWithDouble) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function normalizeProcessEnvInPlace() {
  for (const [key, rawValue] of Object.entries(process.env)) {
    if (rawValue == null) continue;
    process.env[key] = stripWrappingQuotes(String(rawValue));
  }

  // Legacy typo compatibility
  if (!process.env.FRONTEND_URL && process.env.FRONTEND_UR) {
    process.env.FRONTEND_URL = stripWrappingQuotes(process.env.FRONTEND_UR);
  }
}

normalizeProcessEnvInPlace();

function readRawEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value == null) return undefined;
  const normalized = stripWrappingQuotes(String(value));
  return normalized.length ? normalized : undefined;
}

export function envString(name: string, fallback = ""): string {
  return readRawEnv(name) ?? fallback;
}

export function envBoolean(name: string, fallback = false): boolean {
  const value = readRawEnv(name);
  if (!value) return fallback;
  const lowered = value.toLowerCase();
  if (TRUE_VALUES.has(lowered)) return true;
  if (FALSE_VALUES.has(lowered)) return false;
  return fallback;
}

export function envNumber(name: string, fallback: number): number {
  const value = readRawEnv(name);
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function nodeEnv(): NodeEnv {
  const value = envString("NODE_ENV", "development");
  if (value === "production" || value === "test") return value;
  return "development";
}

export function isProduction() {
  return nodeEnv() === "production";
}

function isLikelyPlaceholder(value: string) {
  return /^(YOUR_|MY_|REPLACE_|CHANGE_ME|CHANGEME|example\.com|<)/i.test(value);
}

function isValidHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateRuntimeEnv(): RuntimeValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const databaseUrl = envString("DATABASE_URL");
  if (!databaseUrl) {
    errors.push("DATABASE_URL is required.");
  } else {
    if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
      errors.push(
        "DATABASE_URL must start with postgresql:// or postgres://.",
      );
    }
    if (/\s/.test(databaseUrl)) {
      errors.push("DATABASE_URL must not contain spaces or newlines.");
    }
  }

  const encryptionKey = envString("ENCRYPTION_KEY");
  if (!encryptionKey) {
    if (isProduction()) {
      errors.push("ENCRYPTION_KEY is required in production.");
    } else {
      warnings.push(
        "ENCRYPTION_KEY is missing in non-production; a local dev key will be derived.",
      );
    }
  } else if (encryptionKey.length < 24) {
    warnings.push(
      "ENCRYPTION_KEY is short. Use a long random secret (32+ characters).",
    );
  }

  const appUrl = envString("APP_URL");
  if (appUrl && !isValidHttpUrl(appUrl)) {
    errors.push("APP_URL must be a valid http(s) URL.");
  }
  if (appUrl && isLikelyPlaceholder(appUrl)) {
    warnings.push("APP_URL looks like a placeholder value.");
  }

  const frontendUrl = envString("FRONTEND_URL");
  if (frontendUrl && !isValidHttpUrl(frontendUrl)) {
    errors.push("FRONTEND_URL must be a valid http(s) URL.");
  }
  if (frontendUrl && isLikelyPlaceholder(frontendUrl)) {
    warnings.push("FRONTEND_URL looks like a placeholder value.");
  }

  const bypassMode = envString("SCRAPER_BYPASS_MODE", "never").toLowerCase();
  if (!["never", "auto", "always"].includes(bypassMode)) {
    errors.push("SCRAPER_BYPASS_MODE must be one of: never, auto, always.");
  }

  const shopifyApiVersion = envString("SHOPIFY_API_VERSION", "2026-04");
  if (!/^\d{4}-\d{2}$/.test(shopifyApiVersion)) {
    warnings.push(
      "SHOPIFY_API_VERSION should follow YYYY-MM format, e.g. 2026-04.",
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function printRuntimeValidation(result = validateRuntimeEnv()) {
  for (const warning of result.warnings) {
    console.warn(`[env:warning] ${warning}`);
  }
  for (const error of result.errors) {
    console.error(`[env:error] ${error}`);
  }
}

