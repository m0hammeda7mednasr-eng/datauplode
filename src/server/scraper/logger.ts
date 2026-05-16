import pino from "pino";

export const scraperLogger = pino({
  name: "product-extraction-engine",
  level: process.env.SCRAPER_LOG_LEVEL || "info",
});
