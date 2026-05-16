import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { productExtractionEngine } from "../services/ScraperService.js";
import { CategoryDiscoveryService } from "../services/CategoryDiscoveryService.js";
import type { SourceInput } from "../types/source.js";
import { scraperLogger } from "../logger.js";

export const SCRAPER_QUEUE_NAME = "product-extraction";

function connection() {
  const url = process.env.REDIS_URL;
  return url ? new IORedis(url, { maxRetriesPerRequest: null }) : new IORedis({ maxRetriesPerRequest: null });
}

export function createScraperQueue() {
  return new Queue(SCRAPER_QUEUE_NAME, { connection: connection() });
}

export async function enqueueScraperJob(name: string, payload: unknown) {
  const queue = createScraperQueue();
  return queue.add(name, payload, {
    attempts: 2,
    backoff: { type: "exponential", delay: 3000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 250 },
  });
}

export function startScraperWorker() {
  const discovery = new CategoryDiscoveryService();
  return new Worker(
    SCRAPER_QUEUE_NAME,
    async (job: Job) => {
      scraperLogger.info({ jobId: job.id, name: job.name }, "scraper job started");
      switch (job.name) {
        case "TEST_SOURCE":
          return productExtractionEngine.test(job.data as SourceInput);
        case "EXTRACT_PRODUCT":
        case "NORMALIZE_PRODUCT":
        case "VALIDATE_PRODUCT":
        case "PREPARE_IMPORT":
          return productExtractionEngine.extract(job.data as SourceInput);
        case "DISCOVER_PRODUCT_URLS":
        case "EXTRACT_CATEGORY":
          return discovery.discover(job.data);
        default:
          throw new Error(`Unknown scraper job type: ${job.name}`);
      }
    },
    { connection: connection(), concurrency: Number(process.env.SCRAPER_WORKER_CONCURRENCY || 2) },
  );
}
