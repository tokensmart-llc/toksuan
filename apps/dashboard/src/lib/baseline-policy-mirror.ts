/**
 * Server-side fetch of the gateway's `/baseline-policy` mirror endpoint.
 *
 * We use this on the project page to drive the "first-receipt" smoke curl
 * away from a hardcoded frontier-model table and toward an
 * (asked, expected_route_to) pair that ACTUALLY exists in the live policy
 * artifact AND is callable with the user's BYO keys (or this gateway's
 * env credentials). The previous hardcoded list could suggest a model
 * absent from every bucket, which made the demo receipt say
 * "no rewrite happened" forever and confused first-time users.
 *
 * Failure mode: if the gateway is unreachable, return `null` and let the
 * caller render a graceful fallback. We intentionally cache the last
 * good response in-process for 60s so a flaky gateway doesn't repeatedly
 * stall the project-page render — the policy artifact only changes on a
 * deliberate retrain anyway.
 */

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:8787";

const CACHE_TTL_MS = 60_000;

export type PolicyModelMirror = {
  model: string;
  provider: string;
  avg_cost_micro_cents: number;
  quality_score: number;
};

export type PolicyBucketMirror = {
  task_type: string;
  complexity: string;
  max_quality: number;
  models: PolicyModelMirror[];
};

export type BaselinePolicyMirror = {
  enabled: boolean;
  version: string | null;
  buckets: PolicyBucketMirror[];
  /** Provider names this gateway has env credentials for. */
  env_providers: string[];
};

let cached: { snap: BaselinePolicyMirror; ts: number } | null = null;

export async function fetchBaselinePolicyMirror(): Promise<BaselinePolicyMirror | null> {
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.snap;
  }
  try {
    // 1500ms timeout matches gateway-status.ts. The project page blocks
    // on this fetch to compute the smoke-curl pair; a cold-starting
    // gateway used to burn the full 3s before the page-render gave up
    // and fell back. Snappier failure mode → quicker fallback to the
    // last-cached policy snapshot, which the artifact only changes on
    // deliberate retrains so 60s of staleness here is harmless.
    const res = await fetch(
      `${GATEWAY_URL.replace(/\/$/, "")}/baseline-policy`,
      {
        method: "GET",
        signal: AbortSignal.timeout(1500),
        cache: "no-store",
      }
    );
    if (!res.ok) {
      // Gateway up but endpoint missing (older deploy) — fall through to
      // last cached value if any so a rolling deploy doesn't blank the UI.
      return cached?.snap ?? null;
    }
    const snap = (await res.json()) as BaselinePolicyMirror;
    if (!snap || !Array.isArray(snap.buckets)) {
      return cached?.snap ?? null;
    }
    cached = { snap, ts: Date.now() };
    return snap;
  } catch {
    return cached?.snap ?? null;
  }
}
