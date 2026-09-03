import crypto from "crypto";
import { Router, type Request } from "express";
import { prisma } from "../db.js";
import shopifyCatalogLinkRouter from "./shopify-catalog-link.routes.js";

// Production-only maintenance path: exact stale SyncJob IDs, status transition only, never replay.
const router = Router();
router.use(shopifyCatalogLinkRouter);
const REQUIRED_CONFIRM = "QUARANTINE_STALE_RUNNING_NO_REPLAY";
const MAX_ROWS = 20;
const MIN_STALE_MINUTES = 10;
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_AUDIENCE = "dabdoob-stale-job-quarantine";
const GITHUB_REPOSITORY = "m0hammeda7mednasr-eng/datauplode";
const GITHUB_REPOSITORY_ID = "1236020386";
const GITHUB_REF = "refs/heads/stabilize-supabase-railway";
const GITHUB_WORKFLOW_REF = `${GITHUB_REPOSITORY}/.github/workflows/materialize-and-run-stale-job-quarantine.yml@${GITHUB_REF}`;

type GithubOidcClaims = {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  repository?: string;
  repository_id?: string;
  ref?: string;
  workflow_ref?: string;
  event_name?: string;
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function allowedType(type: string) {
  return type === "PUBLISH_TO_SHOPIFY" || type.startsWith("SHEET1_CATALOG_AUTO_SYNC:");
}

function decodeJwtPart(value: string) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

async function verifyGithubActionsOidc(token: string): Promise<boolean> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;

    const header = decodeJwtPart(parts[0]) as { alg?: string; kid?: string; typ?: string };
    const claims = decodeJwtPart(parts[1]) as GithubOidcClaims;
    if (header.alg !== "RS256" || !header.kid || (header.typ && header.typ !== "JWT")) return false;

    const now = Math.floor(Date.now() / 1000);
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const claimsValid =
      claims.iss === GITHUB_OIDC_ISSUER &&
      audience.includes(GITHUB_OIDC_AUDIENCE) &&
      Number.isFinite(claims.exp) &&
      Number(claims.exp) > now - 30 &&
      (!Number.isFinite(claims.nbf) || Number(claims.nbf) <= now + 30) &&
      claims.repository === GITHUB_REPOSITORY &&
      clean(claims.repository_id) === GITHUB_REPOSITORY_ID &&
      claims.ref === GITHUB_REF &&
      claims.workflow_ref === GITHUB_WORKFLOW_REF &&
      (claims.event_name === "push" || claims.event_name === "workflow_dispatch");
    if (!claimsValid) return false;

    const response = await fetch(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;
    const jwks = (await response.json()) as { keys?: Array<Record<string, unknown> & { kid?: string; kty?: string; use?: string }> };
    const jwk = jwks.keys?.find((key) => key.kid === header.kid && key.kty === "RSA" && (!key.use || key.use === "sig"));
    if (!jwk) return false;

    const publicKey = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: "jwk" });
    return crypto.verify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      publicKey,
      Buffer.from(parts[2], "base64url"),
    );
  } catch (error) {
    console.warn("GitHub Actions OIDC verification failed", error);
    return false;
  }
}

async function authorized(req: Request) {
  const configuredToken = clean(process.env.CATALOG_AUDIT_WRITE_TOKEN);
  const suppliedToken = clean(req.header("x-catalog-audit-write-token"));
  if (configuredToken && suppliedToken && safeEqual(configuredToken, suppliedToken)) {
    return true;
  }

  const oidcToken = clean(req.header("x-github-actions-oidc-token"));
  return Boolean(oidcToken) && verifyGithubActionsOidc(oidcToken);
}

router.post("/admin/quarantine-stale-sync-jobs", async (req, res) => {
  try {
    const confirmation = clean(req.header("x-sync-job-quarantine-confirm") || req.body?.confirm);

    if (!(await authorized(req))) {
      return res.status(403).json({
        success: false,
        code: "SYNC_JOB_QUARANTINE_NOT_AUTHORIZED",
        error: "A valid production write token or repo-bound GitHub Actions OIDC token is required.",
      });
    }
    if (confirmation !== REQUIRED_CONFIRM) {
      return res.status(428).json({
        success: false,
        code: "SYNC_JOB_QUARANTINE_CONFIRMATION_REQUIRED",
        error: "Explicit no-replay quarantine confirmation is required.",
      });
    }

    const ids = Array.isArray(req.body?.ids)
      ? [...new Set(req.body.ids.map((value: unknown) => clean(value)).filter(Boolean))]
      : [];
    if (ids.length < 1 || ids.length > MAX_ROWS) {
      return res.status(400).json({
        success: false,
        code: "SYNC_JOB_QUARANTINE_SCOPE_INVALID",
        error: `Provide between 1 and ${MAX_ROWS} explicit SyncJob IDs.`,
      });
    }

    const staleMinutes = Math.max(
      MIN_STALE_MINUTES,
      Math.min(1440, Number(req.body?.staleMinutes || MIN_STALE_MINUTES) || MIN_STALE_MINUTES),
    );
    const cutoff = new Date(Date.now() - staleMinutes * 60_000);

    const candidates = await prisma.syncJob.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        type: true,
        status: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
      },
      orderBy: { createdAt: "asc" },
    });

    if (candidates.length !== ids.length) {
      return res.status(409).json({
        success: false,
        code: "SYNC_JOB_QUARANTINE_IDENTITY_MISMATCH",
        error: "One or more requested SyncJob IDs no longer exist; nothing was changed.",
      });
    }

    const invalid = candidates.filter(
      (job) =>
        job.status !== "running" ||
        !allowedType(job.type) ||
        (job.startedAt !== null && job.startedAt >= cutoff),
    );
    if (invalid.length > 0) {
      return res.status(409).json({
        success: false,
        code: "SYNC_JOB_QUARANTINE_PRECONDITION_FAILED",
        error: "Every requested job must still be stale, running, and an explicitly supported type; nothing was changed.",
        invalid: invalid.map((job) => ({ id: job.id, type: job.type, status: job.status })),
      });
    }

    const resultMarker = JSON.stringify({
      quarantined: true,
      reason: "stale_running_no_replay",
      source: "api/admin/quarantine-stale-sync-jobs",
    });

    const updated = await prisma.syncJob.updateMany({
      where: {
        id: { in: ids },
        status: "running",
        OR: [{ startedAt: null }, { startedAt: { lt: cutoff } }],
      },
      data: {
        status: "failed",
        completedAt: new Date(),
        result: resultMarker,
      },
    });

    if (updated.count !== ids.length) {
      return res.status(409).json({
        success: false,
        code: "SYNC_JOB_QUARANTINE_RACE_DETECTED",
        error: `Expected ${ids.length} updates but applied ${updated.count}; broad recovery remains blocked.`,
      });
    }

    const readBack = await prisma.syncJob.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        type: true,
        status: true,
        startedAt: true,
        completedAt: true,
        result: true,
      },
      orderBy: { createdAt: "asc" },
    });
    const readBackInvalid = readBack.filter(
      (job) =>
        job.status !== "failed" ||
        !job.completedAt ||
        !String(job.result || "").includes('\"quarantined\":true'),
    );
    if (readBackInvalid.length > 0 || readBack.length !== ids.length) {
      return res.status(500).json({
        success: false,
        code: "SYNC_JOB_QUARANTINE_READBACK_FAILED",
        error: "Quarantine write completed but exact read-back verification failed. Keep all broader writes disabled.",
      });
    }

    return res.json({
      success: true,
      mode: "quarantine-no-replay",
      applied: updated.count,
      readBackVerified: readBack.length,
      shopifyApiCalls: 0,
      googleSheetWrites: 0,
      jobs: readBack.map(({ result: _result, ...job }) => job),
    });
  } catch (error: any) {
    console.error("Stale SyncJob quarantine failed", error);
    return res.status(500).json({
      success: false,
      code: "SYNC_JOB_QUARANTINE_FAILED",
      error: error?.message || String(error),
    });
  }
});

export default router;
