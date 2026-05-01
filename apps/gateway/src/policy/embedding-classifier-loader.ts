/**
 * Project-aware embedding classifier loader.
 *
 * Layered on top of the file-based `loadEmbeddingClassifier()` in
 * `embedding-classifier.ts`. For each project we try the database first —
 * if a `status='active'` row exists in `project_embedding_classifiers`,
 * that row's JSONB payload IS the classifier used at routing time.
 * Misses fall back to the shipped global artifact (file on disk) so
 * freshly-onboarded projects still get the classifier's benefit if
 * the operator has a global artifact.
 *
 * Hot-path constraints
 * --------------------
 * `classifyTask()` runs on every chat completion. An unconditional DB
 * query per request would add tens of ms. Two mitigations keep the
 * latency floor where it was:
 *
 *   1. **Per-(project) cache** keyed by project_id with a short TTL
 *      (default 60s). Within the TTL window, all classifications for
 *      a project are served from process memory.
 *   2. **Negative caching**: when a project has no active artifact row,
 *      we cache `null` (or the global fallback, if one loaded) and
 *      return it directly. No round-trip to pg just to learn there's
 *      nothing per-project.
 *
 * Cache invalidation
 * ------------------
 * Two paths invalidate:
 *
 *   a. TTL expiry — eventual consistency. A retrain that promoted
 *      a new version is visible within `LOADER_TTL_MS` of the
 *      promotion.
 *   b. Explicit pg_notify — `tokensmart_embedding_reload` channel, same
 *      channel the training CLI emits on. Payload is
 *      `{project_id, version}`; when `project_id` is present we drop
 *      just that entry. When payload is empty, we drop everything
 *      (matches the global-reload behavior of `reloadEmbeddingClassifier`).
 *
 * Why DB rows over disk
 * ---------------------
 * Multi-replica cloud. A per-tenant file-on-disk approach requires a
 * shared PV or S3 sync; DB rows are multi-replica-native, transactional
 * promote gives us atomic cutover, and pg_notify gives us sub-second
 * fan-out for free. Same architectural reasoning as `project_policies`.
 * The ~70KB-per-artifact JSONB cost is trivial for postgres — we're
 * already storing per-request JSON bodies dozens of times that size.
 */

import { sql, dbBackend } from "../db";
import {
  ARTIFACT_SCHEMA_VERSION,
  describeStaleArtifactReason,
  loadEmbeddingClassifier,
  type ClassifierArtifact,
} from "./embedding-classifier";

/** TTL for per-project cached classifier artifact. 60s matches the
 *  routing-policy loader so operators have one TTL to reason about. */
const LOADER_TTL_MS = 60_000;

/** Sentinel to distinguish "cache has a null result" from "cache miss". */
type CacheEntry = {
  /** The active classifier for this project, or null when the project
   *  has no active row AND no global fallback is configured. */
  artifact: ClassifierArtifact | null;
  /** Monotonic version of the DB row (0 when we fell back to the
   *  global artifact or to null). Used by logs + metrics only. */
  version: number;
  /** Whether this entry came from the DB (project-specific) vs the
   *  file (global) vs nothing. Lets the caller distinguish for
   *  observability. */
  source: "project" | "global" | "none";
  expires_at_ms: number;
};

const cache = new Map<string, CacheEntry>();

/**
 * Drop the cached entry for a single project. Called by the retrain
 * CLI after a successful promotion, and by the pg_notify subscriber
 * after a cross-replica notify.
 */
export function invalidateProjectEmbeddingClassifier(
  projectId: string
): void {
  cache.delete(projectId);
}

/**
 * Drop the entire cache. Used by tests, by the retrain CLI when it
 * fans out a global update, and by the pg_notify subscriber when it
 * receives an empty payload (operator-issued "flush everything"
 * escape hatch).
 */
export function invalidateAllProjectEmbeddingClassifiers(): void {
  cache.clear();
}

/**
 * Resolve the active embedding classifier for a project. Returns null
 * when neither a DB row nor a global artifact is available — the
 * caller falls back to the regex heuristic.
 *
 * Lookup order (first hit wins):
 *   1. `project_embedding_classifiers` WHERE project_id=X AND status='active'
 *   2. Global artifact (file on disk, loaded by `loadEmbeddingClassifier`)
 *   3. `null`
 *
 * Single process-local cache entry per project. SQLite backend
 * short-circuits to the global artifact (the SQLite shim ships the
 * table for symmetry but none of our orchestration writes to it).
 */
export async function loadActiveEmbeddingClassifier(
  projectId: string | null
): Promise<ClassifierArtifact | null> {
  // No project context → no DB lookup to do. Just the global.
  if (!projectId) return loadEmbeddingClassifier();

  const now = Date.now();
  const hit = cache.get(projectId);
  if (hit && hit.expires_at_ms > now) {
    return hit.artifact;
  }

  // SQLite mode: per-project classifier machinery isn't wired to
  // SQLite at the training-orchestration layer. Serve the global
  // artifact straight through so we don't pay a pointless query
  // on every request.
  if (dbBackend !== "postgres") {
    const global = loadEmbeddingClassifier();
    cache.set(projectId, {
      artifact: global,
      version: 0,
      source: global ? "global" : "none",
      expires_at_ms: now + LOADER_TTL_MS,
    });
    return global;
  }

  // Postgres path. Single round-trip: read the active payload for
  // this project, plus its version + accuracies so downstream
  // observability (health endpoint, dashboard) doesn't need to
  // re-parse the blob.
  let row: { payload: unknown; version: number } | null = null;
  try {
    const rows = await sql<{ payload: unknown; version: number }[]>`
      SELECT payload, version
      FROM project_embedding_classifiers
      WHERE project_id = ${projectId}
        AND status = 'active'
      LIMIT 1
    `;
    row = rows[0] ?? null;
  } catch (err) {
    // DB hiccup must not take down classification. Log + fall back to
    // global; next request retries the lookup after TTL.
    console.warn(
      `[embedding-loader] failed to read project_embedding_classifiers for ${projectId}: ${(err as Error).message} — falling back to global`
    );
    row = null;
  }

  let resolved: ClassifierArtifact | null;
  let version = 0;
  let source: CacheEntry["source"];
  if (row && isArtifactShape(row.payload)) {
    resolved = row.payload;
    version = row.version;
    source = "project";
  } else {
    if (row) {
      // v0.6.7: distinguish "bad shape" (corrupt JSON) from "stale
      // schema" (legitimate v1 artifact pre-dating the multi-modal
      // extractor migration) so the operator knows which CLI to run.
      const stale = describeStaleArtifactReason(row.payload);
      if (stale) {
        console.warn(
          `[embedding-loader] project ${projectId} active classifier v${row.version}: ${stale} Falling back to global / heuristic.`
        );
      } else {
        console.warn(
          `[embedding-loader] project ${projectId} active classifier v${row.version} has bad shape — falling back to global`
        );
      }
    }
    resolved = loadEmbeddingClassifier();
    source = resolved ? "global" : "none";
  }

  cache.set(projectId, {
    artifact: resolved,
    version,
    source,
    expires_at_ms: now + LOADER_TTL_MS,
  });
  return resolved;
}

/**
 * Lightweight shape check for a payload pulled back from JSONB.
 * Kept narrow on purpose — the classifier code itself defends against
 * missing fields (treats undefined weights as 0 → low confidence →
 * falls back to heuristic), so we only reject shapes too broken to
 * execute at all. Full validation happens at training time in
 * `scripts/train-embedding-classifier.ts` before the row is ever
 * inserted.
 */
function isArtifactShape(v: unknown): v is ClassifierArtifact {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  // v0.6.7 schema bump: enforce the current artifact schema_version.
  // Stale v1 rows are flagged with a helpful "force retrain" message
  // at the call site (see resolveProjectClassifier above) and the
  // loader falls back to the global / heuristic path.
  if (a.schema_version !== ARTIFACT_SCHEMA_VERSION) return false;
  if (typeof a.model_version !== "string") return false;
  if (!a.encoder || typeof a.encoder !== "object") return false;
  if (!a.task_type || typeof a.task_type !== "object") return false;
  if (!a.complexity || typeof a.complexity !== "object") return false;
  return true;
}

// ===========================================================================
// Cross-process invalidation via Postgres LISTEN/NOTIFY
// ===========================================================================
//
// The training CLI emits `pg_notify('tokensmart_embedding_reload', ...)`
// after each successful promotion. Payload shape:
//   - `{ project_id: string, version: number }` → invalidate that project
//   - `{}` or empty → invalidate everything (fallback / dev escape hatch)
//   - `{ model_version: string, project_id: null }` → GLOBAL reload
//     (the file-watcher path already handles this; we're idempotent
//     with that channel handler in `embedding-classifier.ts`)
//
// Uses postgres.js's built-in `sql.listen(channel, handler)` API. Failure
// to subscribe is non-fatal — degrades to TTL-only cache refresh.

let invalidationSubscribed = false;

interface ReloadPayload {
  project_id?: string | null;
  version?: number;
  model_version?: string;
}

export async function subscribeToProjectEmbeddingInvalidations(): Promise<void> {
  if (invalidationSubscribed) return;
  if (dbBackend !== "postgres") return;
  invalidationSubscribed = true;

  try {
    await sql.listen("tokensmart_embedding_reload", (payload) => {
      if (!payload) {
        invalidateAllProjectEmbeddingClassifiers();
        console.log(
          "[embedding-loader] received NOTIFY without payload — flushing all per-project entries"
        );
        return;
      }
      let parsed: ReloadPayload;
      try {
        parsed = JSON.parse(payload) as ReloadPayload;
      } catch (err) {
        console.warn(
          `[embedding-loader] NOTIFY payload not JSON, ignoring: ${(err as Error).message}`
        );
        return;
      }
      // Only act on project-scoped payloads here. Global-scoped
      // (project_id absent / null) payloads are the domain of the
      // file-watch + global reload path in embedding-classifier.ts,
      // which listens on the same channel via its own subscriber.
      if (typeof parsed.project_id === "string" && parsed.project_id.length > 0) {
        invalidateProjectEmbeddingClassifier(parsed.project_id);
        console.log(
          `[embedding-loader] invalidated cache for project=${parsed.project_id}${
            parsed.version != null ? ` (v${parsed.version})` : ""
          }`
        );
      }
    });
    console.log(
      "[embedding-loader] subscribed to tokensmart_embedding_reload (per-project cache invalidation)"
    );
  } catch (err) {
    invalidationSubscribed = false;
    console.warn(
      `[embedding-loader] LISTEN setup failed: ${(err as Error).message} — falling back to 60s TTL only`
    );
  }
}

/**
 * Test-only reset hooks. Same pattern as the rest of this module.
 */
export function _resetEmbeddingClassifierLoader(): void {
  cache.clear();
  invalidationSubscribed = false;
}
