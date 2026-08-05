export type ScraperErrorCode =
  | "INVALID_URL"
  | "ROBOTS_DISALLOWED"
  | "SOURCE_RESTRICTED"
  | "PERMISSION_REQUIRED"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "JS_RENDER_REQUIRED"
  | "NO_PRODUCT_DATA_FOUND"
  | "PRICE_PARSE_FAILED"
  | "INVALID_PRODUCT_DATA";

export class ScraperError extends Error {
  code: ScraperErrorCode;
  details?: unknown;
  status: number;

  constructor(code: ScraperErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ScraperError";
    this.code = code;
    this.details = details;
    this.status =
      code === "RATE_LIMITED"
        ? 429
        : code === "INVALID_URL" || code === "INVALID_PRODUCT_DATA"
          ? 400
          : code === "ROBOTS_DISALLOWED" ||
              code === "SOURCE_RESTRICTED" ||
              code === "PERMISSION_REQUIRED"
            ? 422
            : 500;
  }
}
