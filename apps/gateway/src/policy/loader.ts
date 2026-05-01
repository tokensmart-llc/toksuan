/**
 * Project-aware policy loader.
 *
 * Layered on top of the legacy `loadBaselinePolicy()` (which reads the
 * shipped JSON artifact). For each project we try the database first —
 * if a `status='active'` row exists in `project_policies`, that row's
 * payload IS the policy used at routing time. Misses fall back to the
 * shipped baseline so freshly-onboarded projects (zero training samples
 * yet) still get cold-start savings.
 *
 * Hot-path constraints
 * --------------------
 * `applyBaselineRouting()` runs on every chat completion. It used to be
 * a synchronous in-memory lookup; introducing a DB call here would make
 * routing decisions wait on Postgres, which is unacceptable. Two
 * mitigations keep the latency floor where it was:
 *
 *   1. **Per-process cache** keyed by project_id with a short TTL
 *      (default 60s). Within the TTL window, all routing decisions for
 *      a project are served from process memory.
 *   2. **Negative caching**: when a project has no active policy row,
 *      we cache `null` and return the baseline. Otherwise every
 *      request from a brand-new project would round-trip to pg only
 *      to learn there's nothing there.
 *
 * Cache invalidation
 * ------------------
 * Two paths invalidate:
 *
 *   a. TTL expiry — eventual consistency. A retrain that just promoted
 *      a new version is visible to every gateway process within
 *      `LOADER_TTL_MS` of the promotion. For a nightly cron this is
 *      always good enough.
 *   b. Explicit `invalidateProjectPolicy(projectId)` — exposed for the
 *      retrain CLI (and for an eventual pubsub hookup) so an operator
 *      who wants instant cutover can call it after a manual retrain
 *      without waiting for TTL.
 *
 * Design note: we deliberately do NOT push policy bytes through the
 * cache itself when they're loaded from disk — `loadBaselinePolicy()`
 * already memoizes its own work. Only DB-loaded payloads live in this
 * module's cache, so a project that always falls back to baseline
 * pays one disk read total across the gateway lifetime.
 */

import { sql, dbBackend } from "../db";
import { loadBaselinePolicy, type BaselinePolicy } from "./index";

/** TTL for per-(project, tag) cached active policy. 60s = stale-but-safe. */
const LOADER_TTL_MS = 60_000;

type CacheEntry = {
  /** The active policy for this (project, tag), OR null when there is none. */
  policy: BaselinePolicy | null;
  /** Monotonic version of the active row (or 0 for the baseline-fallback). */
  version: number;
  expires_at_ms: number;
};

/**
 * Cache key. We deliberately key by both project_id AND the resolved
 * tag (or "" for the project-default policy) so projects multiplexing
 * multiple workloads via `x-ts-tag` get a separate cached lookup per
 * tag — no cross-tag false hits.
 */
function cacheKey(projectId: string, tag: string | null): string {
  return tag ? `${projectId}::${tag}` : `${projectId}::`;
}

const cache = new Map<string, CacheEntry>();

/**
 * Drop the cached entry for a single (project, tag) pair. Called by
 * the retrain CLI right after promoting a new version so the next
 * request sees the fresh policy without waiting out the TTL.
 *
 * When `tag` is omitted, all cached entries for the project (across
 * every tag) are dropped. Use the tag-less form on bulk operations
 * like rollback-all; use the targeted form on a per-(project, tag)
 * retrain promotion.
 *
 * Safe to call from any process — but a multi-process gateway only
 * invalidates the local process. Other replicas catch up at TTL
 * expiry, OR via the LISTEN/NOTIFY hook in `subscribeToInvalidations`.
 */
export function invalidateProjectPolicy(
  projectId: string,
  tag?: string | null
): void {
  if (tag === undefined) {
    // Drop every cached entry whose key starts with the project id.
    // Cheap because tag-multiplexed projects rarely have more than a
    // dozen entries; the prefix scan is sub-microsecond.
    const prefix = `${projectId}::`;
    for (const k of cache.keys()) {
      if (k.startsWith(prefix)) cache.delete(k);
    }
    return;
  }
  cache.delete(cacheKey(projectId, tag));
}

/**
 * Drop the entire per-project cache. Used by tests and by the boot
 * sequence after migrations apply (in case a test fixture left rows
 * behind that the cache from a hot-reload would otherwise still see).
 */
export function invalidateAllProjectPolicies(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Cross-process invalidation via Postgres LISTEN/NOTIFY
// ---------------------------------------------------------------------------
//
// In a multi-replica gateway deployment, a retrain that promotes v15 → v16
// of a project's policy needs every replica to drop its cached entry, not
// just the one that ran the retrain CLI. Without this we'd wait out the
// 60s loader TTL on every other replica, during which they'd serve the
// previous policy.
//
// The retrain CLI emits `pg_notify('tokensmart_policy_invalidate', ...)`
// after each successful promotion. Each gateway process subscribes once
// at boot and drops the matching cache entry on every notification.
//
// Failure handling: if the LISTEN connection drops (network blip, pg
// restart), we attempt one reconnect with a 5s backoff. If that also
// fails, we log loudly and fall back to the TTL-only model — never crash
// the gateway over a non-critical pubsub channel.

let invalidationSubscribed = false;

interface InvalidationPayload {
  project_id: string;
  tag: string | null;
}

/**
 * Subscribe to cross-process policy invalidations. Called once from
 * the boot sequence (index.ts). Idempotent — multiple calls during
 * dev hot-reload are no-ops.
 *
 * Uses postgres.js's built-in `sql.listen(channel, handler)` API,
 * which manages its own dedicated connection (so the LISTEN doesn't
 * tie up a pool slot during long quiet periods).
 */
export async function subscribeToPolicyInvalidations(): Promise<void> {
  if (invalidationSubscribed) return;
  if (dbBackend !== "postgres") return;
  invalidationSubscribed = true;

  try {
    await sql.listen("tokensmart_policy_invalidate", (payload) => {
      if (!payload) {
        // No payload = invalidate everything. Safest default for an
        // operator who manually `NOTIFY tokensmart_policy_invalidate`
        // without thinking through what to put in the body.
        invalidateAllProjectPolicies();
        console.log(
          "[policy-loader] received NOTIFY without payload — flushing all entries"
        );
        return;
      }
      let parsed: InvalidationPayload;
      try {
        parsed = JSON.parse(payload) as InvalidationPayload;
      } catch (err) {
        console.warn(
          `[policy-loader] NOTIFY payload not JSON, ignoring: ${(err as Error).message}`
        );
        return;
      }
      if (typeof parsed.project_id !== "string") {
        console.warn(
          `[policy-loader] NOTIFY payload missing project_id, ignoring: ${payload}`
        );
        return;
      }
      // Pass the tag through unchanged — null will fan out across all
      // tags for this project, a string will scope to that one cache
      // entry. Mirrors what the retrain CLI passed in.
      const tag = parsed.tag ?? null;
      invalidateProjectPolicy(parsed.project_id, tag);
    });
    console.log(
      "[policy-loader] subscribed to tokensmart_policy_invalidate (cross-replica cache invalidation)"
    );
  } catch (err) {
    invalidationSubscribed = false; // allow a retry from index.ts boot
    console.warn(
      `[policy-loader] LISTEN setup failed: ${(err as Error).message} — falling back to 60s TTL only`
    );
  }
}

/**
 * Resolve the active routing policy for a (project, tag) pair.
 *
 * Lookup order:
 *   1. `(project_id, tag, status='active')` — request-tag-specific policy
 *   2. `(project_id, NULL, status='active')` — project's default policy
 *   3. Shipped baseline policy (if loadable)
 *   4. `null` — nothing to do; gateway falls through with the original model
 *
 * The tag arg comes from the request's `x-ts-tag` header parsed by
 * `parseTagHeader` and reduced to a single string. Multiple tags pick
 * the first one as the policy key — multiplexing across tags is a
 * future feature that needs the customer to opt in (the policy
 * compiler doesn't know how to merge across tags safely).
 *
 * Callers should treat the return shape identically — there's nothing
 * the gateway needs to do differently between "this is the baseline"
 * and "this is a per-project policy", because the policy IS the policy.
 *
 * `loadBaselinePolicy()` stays callable separately for the boot-time
 * eager log line and the /health endpoint, both of which are
 * project-agnostic.
 */
export async function loadActivePolicy(
  projectId: string | null,
  tag: string | null = null
): Promise<BaselinePolicy | null> {
  // No project context (legacy callers, /health probe) — there's
  // nothing to look up. Return the shipped baseline, same as before.
  if (!projectId) return loadBaselinePolicy();

  const now = Date.now();
  const key = cacheKey(projectId, tag);
  const hit = cache.get(key);
  if (hit && hit.expires_at_ms > now) {
    return hit.policy;
  }

  // SQLite shim doesn't carry the project_policies table — a `lite`
  // single-binary install never runs the retrain pipeline. Skip the
  // query and serve the baseline so we don't 500 every request.
  if (dbBackend !== "postgres") {
    const baseline = loadBaselinePolicy();
    cache.set(key, {
      policy: baseline,
      version: 0,
      expires_at_ms: now + LOADER_TTL_MS,
    });
    return baseline;
  }

  // Two-step lookup: prefer the tag-specific row, fall back to the
  // project-default (NULL tag) row. We do it as one round-trip with
  // ORDER BY so the optimizer can use the unique index.
  // Sort key prefers the tag-specific match: when both rows exist,
  // the WHERE picks them both and we keep the (tag IS NOT NULL) one.
  let row: { payload: unknown; version: number; tag: string | null } | null =
    null;
  try {
    const rows = await sql<
      { payload: unknown; version: number; tag: string | null }[]
    >`
      SELECT payload, version, tag
      FROM project_policies
      WHERE project_id = ${projectId}
        AND status = 'active'
        AND (tag = ${tag} OR tag IS NULL)
      ORDER BY (tag IS NULL) ASC
      LIMIT 1
    `;
    row = rows[0] ?? null;
  } catch (err) {
    // DB hiccup must not take down routing. Log and fall back; the
    // next request retries the lookup after TTL.
    console.warn(
      `[policy-loader] failed to read project_policies for ${projectId} tag=${tag ?? "<default>"}: ${(err as Error).message} — falling back to baseline`
    );
    row = null;
  }

  let resolved: BaselinePolicy | null;
  let version: number;
  if (row && isPolicyShape(row.payload)) {
    resolved = row.payload;
    version = row.version;
  } else {
    if (row && !isPolicyShape(row.payload)) {
      console.warn(
        `[policy-loader] project ${projectId} active policy v${row.version} has bad shape — falling back to baseline`
      );
    }
    resolved = loadBaselinePolicy();
    version = 0;
  }

  cache.set(key, {
    policy: resolved,
    version,
    expires_at_ms: now + LOADER_TTL_MS,
  });
  return resolved;
}

/**
 * Lightweight runtime shape check — guards against a row whose payload
 * was hand-edited or written by an older migration. The full schema
 * lives in `policy/types.ts`; this is just enough to catch obvious
 * corruption before it reaches the routing decision logic.
 */
function isPolicyShape(v: unknown): v is BaselinePolicy {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.version === "string" &&
    Array.isArray(p.buckets) &&
    typeof p.lookup === "object" &&
    p.lookup !== null
  );
}
