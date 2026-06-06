import { createHash } from "node:crypto";
import { env } from "./config";
import { chooseRequestBodyForStorage } from "./request-body-storage";
import { activeBackend, buildSql, detectBackend } from "./sql-driver";

export const sql = buildSql(env.DATABASE_URL);

/**
 * Re-export the active backend so feature gates ("does the request
 * pipeline have BYO encrypted keys / semantic cache / multi-tenant
 * billing?") can branch on it from a single canonical source.
 */
export const dbBackend = activeBackend();
export { detectBackend };

export type Project = {
  id: string;
  name: string;
  created_at: Date;
};

export type ApiKey = {
  id: string;
  project_id: string;
  /**
   * Owner of the project this key belongs to. NULL for legacy unowned
   * projects (the seeded dev project before any user signed up). When
   * present, the gateway uses it to look up the user's BYO upstream
   * provider keys before falling back to env-configured credentials.
   */
  project_user_id: string | null;
  key: string | null;
  key_hash: string | null;
  key_prefix: string | null;
  key_last4: string | null;
  name: string | null;
  created_at: Date;
  last_used_at: Date | null;
};

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// =========================================================================
// Hot-path read caches — `findApiKey` + `getProjectPlan`
// =========================================================================
//
// Every chat-completion request hits BOTH of these on the way in. On a
// busy agent (OpenClaw long sessions, parallel tool calls) the same API
// key + the same project keep showing up dozens of times within seconds.
// Without caching, that's 2 DB roundtrips per request just for auth and
// plan-tier resolution — 10-200ms wasted depending on Postgres location.
//
// Eventual-consistency contract:
//
//   * API-key delete / rotate from the dashboard becomes visible to this
//     gateway instance within `API_KEY_CACHE_TTL_MS` (60s). A revoked
//     key keeps working for at most that long. Acceptable trade — every
//     other instance also has its own 60s window, so the real
//     consistency bound is "cluster-wide ≤ 60s".
//
//   * Plan upgrade / downgrade (Stripe webhook flips users.plan)
//     becomes visible within the same 60s window. A user paying for Pro
//     might briefly hit Free-tier caps after upgrade, or vice versa.
//
// If those windows are unacceptable for a given deployment, drop the
// TTLs to 5-10s — the speedup is logarithmic in TTL, not linear, so a
// 5s cache still catches the burst-of-tool-calls case which is the
// dominant pattern.
//
// Both caches null-cache as well: a wrong API key or an unowned project
// is cached as `{ value: null }` so a brute-force scanner doesn't slam
// Postgres with the same wrong key 1000 times. Null TTL is short
// (`API_KEY_NULL_TTL_MS` = 10s) so a freshly-minted key isn't shadowed
// by a stale "not found".
//
// Cache size cap protects against unbounded growth in the (unlikely)
// case of a high-cardinality API-key probing attack — when full, the
// LRU eviction drops the oldest insertion.

const API_KEY_CACHE_TTL_MS = 60_000;
const API_KEY_NULL_TTL_MS = 10_000;
const API_KEY_CACHE_MAX = 1024;
const PROJECT_PLAN_CACHE_TTL_MS = 60_000;
const PROJECT_PLAN_CACHE_MAX = 1024;
const ROUTING_RULES_CACHE_TTL_MS = 10_000;
const ROUTING_RULES_CACHE_MAX = 1024;
const USER_PROVIDER_KEY_CACHE_TTL_MS = 60_000;
const USER_PROVIDER_KEY_CACHE_MAX = 4096;
const USER_CUSTOM_PROVIDERS_CACHE_TTL_MS = 60_000;
const USER_CUSTOM_PROVIDERS_CACHE_MAX = 1024;

type CacheEntry<T> = { value: T; expiresAtMs: number };

/**
 * Tiny insertion-order LRU. Map iteration is insertion order; deleting
 * + re-inserting on touch promotes to MRU. Trimmed on insert when over
 * the size cap. Good enough for a few hundred to a few thousand
 * concurrent keys; nothing in this gateway justifies a real LRU lib.
 */
class TtlLru<K, V> {
  private map = new Map<K, CacheEntry<V>>();
  constructor(private readonly maxEntries: number) {}

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Promote to MRU on hit so the eviction policy is actually LRU
    // rather than FIFO. Re-inserting onto a Map preserves the value
    // and bumps the iteration position to last.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs: number): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAtMs: Date.now() + ttlMs });
    if (this.map.size > this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

const apiKeyCache = new TtlLru<string, ApiKey | null>(API_KEY_CACHE_MAX);
const projectPlanCache = new TtlLru<
  string,
  { user_id: string; plan: string } | null
>(PROJECT_PLAN_CACHE_MAX);
const routingRulesCache = new TtlLru<string, RoutingRule[]>(
  ROUTING_RULES_CACHE_MAX
);
const userProviderKeyCache = new TtlLru<string, StoredProviderKey | null>(
  USER_PROVIDER_KEY_CACHE_MAX
);
const userCustomProvidersCache = new TtlLru<string, StoredCustomProvider[]>(
  USER_CUSTOM_PROVIDERS_CACHE_MAX
);

/**
 * Test-only escape hatch. Production code never imports this — the TTL
 * is the consistency contract.
 */
export function _resetHotPathCachesForTests(): void {
  apiKeyCache.clear();
  projectPlanCache.clear();
  routingRulesCache.clear();
  userProviderKeyCache.clear();
  userCustomProvidersCache.clear();
}

export type RequestStatus =
  | "success"
  | "error"
  | "budget_exceeded"
  | "plan_limit_exceeded"
  | "loop_detected"
  | "timeout";

export type RequestRecord = {
  id: string;
  project_id: string | null;
  api_key_id: string | null;
  provider: string;
  model: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  cost_cents: number;
  cost_micro_cents: number;
  cache_savings_micro_cents: number;
  /**
   * For routed requests (original_model != model), how much the request
   * would have cost at the original model's per-M rate minus what it
   * actually cost. Never negative. Zero for non-routed requests.
   * Written at request completion in routes/chat.ts.
   */
  routing_saving_micro_cents: number;
  latency_ms: number | null;
  status: RequestStatus;
  error: string | null;
  fingerprint: string | null;
  original_model: string | null;
  /**
   * Free-form provenance string written by the gateway on every routed
   * request. For baseline-policy decisions this looks like
   *   `baseline:chat:simple→chat:medium:q=0.83:n=19:eps=0.10`
   * (matches what the gateway logs). For project routing rules:
   *   `rule:<rule_id>:from=<pattern>:to=<model>`
   * NULL when nothing rewrote `body.model`. Surfaced on
   * /requests/[id] for debugging.
   */
  routing_reason: string | null;
  /**
   * Just the resolved (task_type, complexity) bucket the baseline
   * policy actually used — `chat:medium`, `code:hard` etc. NULL for
   * project routing rules (rules are pattern-based, no bucket) and
   * NULL when no routing fired. Indexed; powers the per-bucket
   * breakdown on /routing-quality.
   */
  routing_bucket: string | null;
  streamed: boolean;
  request_body: unknown;
  response_body: unknown;
  /**
   * Customer-supplied attribution tags from the `x-ts-tag` request header.
   * Stored as JSONB; default empty `{}`. The dashboard's "Spend by tag"
   * card aggregates by these. Always an object — never null.
   */
  tags: Record<string, string>;
  created_at: Date;
};

/**
 * Look up an API key by SHA-256 hash, falling back to plaintext for keys
 * issued before v0.2's hashing migration. When a plaintext-only key is hit
 * we opportunistically backfill its hash + display fragments so subsequent
 * lookups go through the indexed hash path.
 *
 * The result joins `projects.user_id` so the request path can route to the
 * right BYO upstream-provider key without a second roundtrip.
 *
 * In-memory cached for `API_KEY_CACHE_TTL_MS` (60s) — see the cache block
 * at the top of this file for the eventual-consistency contract.
 */
export async function findApiKey(rawKey: string): Promise<ApiKey | null> {
  const hash = sha256Hex(rawKey);

  // Hot-path cache: a busy agent reuses the same API key dozens of
  // times within the TTL window. Cache key is the sha256 hash so we
  // never store plaintext. We cache both hits AND misses (with a
  // shorter TTL for misses so a freshly-minted key isn't shadowed by
  // an earlier "not found").
  const cached = apiKeyCache.get(hash);
  if (cached !== undefined) return cached;

  // Honor the soft-rotate grace window (v0.4.x): a key is valid if its
  // `expires_at` is NULL (canonical) OR in the future (grace period not
  // yet elapsed). The condition is expressed with `>= NOW()` instead of
  // `> NOW()` so a rotation scheduled for exactly this moment behaves
  // deterministically on the second-rollover.
  //
  // Expired rows stay in the table — a separate sweep deletes them. We
  // intentionally don't do lazy delete on read because it adds a write
  // to every successful lookup for a savings that basically never
  // matters (an api_keys row is ~200 bytes).
  //
  // The projects.user_id column exists in BOTH backends (Postgres init
  // schema + the SQLite trial schema). Selecting it as `project_user_id`
  // surfaces NULL on SQLite (no users → no ownership) without changing
  // the resolver path.
  const byHash = await sql<ApiKey[]>`
    SELECT k.id, k.project_id, p.user_id AS project_user_id,
           k.key, k.key_hash, k.key_prefix, k.key_last4, k.name,
           k.created_at, k.last_used_at
      FROM api_keys k
      LEFT JOIN projects p ON p.id = k.project_id
     WHERE k.key_hash = ${hash}
       AND (k.expires_at IS NULL OR k.expires_at > NOW())
     LIMIT 1
  `;
  if (byHash[0]) {
    apiKeyCache.set(hash, byHash[0], API_KEY_CACHE_TTL_MS);
    return byHash[0];
  }

  const byPlain = await sql<ApiKey[]>`
    SELECT k.id, k.project_id, p.user_id AS project_user_id,
           k.key, k.key_hash, k.key_prefix, k.key_last4, k.name,
           k.created_at, k.last_used_at
      FROM api_keys k
      LEFT JOIN projects p ON p.id = k.project_id
     WHERE k.key = ${rawKey}
       AND (k.expires_at IS NULL OR k.expires_at > NOW())
     LIMIT 1
  `;
  const row = byPlain[0];
  if (!row) {
    // Negative-cache the miss so brute-force key scans don't slam
    // Postgres. Short TTL so a real key minted right after the probe
    // still works on the next call.
    apiKeyCache.set(hash, null, API_KEY_NULL_TTL_MS);
    return null;
  }

  if (!row.key_hash) {
    const prefix = rawKey.slice(0, 7);
    const last4 = rawKey.slice(-4);
    sql`
      UPDATE api_keys
         SET key_hash   = ${hash},
             key_prefix = COALESCE(key_prefix, ${prefix}),
             key_last4  = COALESCE(key_last4,  ${last4})
       WHERE id = ${row.id}
    `.catch((e) => console.warn("[api-keys] backfill hash failed:", e));
    row.key_hash = hash;
    row.key_prefix = row.key_prefix ?? prefix;
    row.key_last4 = row.key_last4 ?? last4;
  }
  apiKeyCache.set(hash, row, API_KEY_CACHE_TTL_MS);
  return row;
}

// --- BYO provider keys ----------------------------------------------------

export type StoredProviderKey = {
  id: string;
  encrypted_key: string;
  base_url: string | null;
  master_key_fingerprint: string | null;
};

/**
 * Lookup a user's BYO upstream provider credentials. Returns null when the
 * user hasn't uploaded one for this provider; the caller falls back to the
 * env-configured key in that case.
 */
export async function getUserProviderKey(
  userId: string,
  provider: string
): Promise<StoredProviderKey | null> {
  const cacheKey = `${userId}:${provider}`;
  const cached = userProviderKeyCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const rows = await sql<StoredProviderKey[]>`
    SELECT id, encrypted_key, base_url, master_key_fingerprint
      FROM user_provider_keys
     WHERE user_id = ${userId} AND provider = ${provider}
     LIMIT 1
  `;
  const row = rows[0] ?? null;
  userProviderKeyCache.set(
    cacheKey,
    row,
    row ? USER_PROVIDER_KEY_CACHE_TTL_MS : API_KEY_NULL_TTL_MS
  );
  return row;
}

/**
 * Stamp the current master-key fingerprint on a row that doesn't have one
 * yet. Called opportunistically by the resolver after a successful decrypt
 * of a legacy NULL-fingerprint row, so the next rotation can filter it
 * efficiently. Failures are swallowed — backfill is best-effort.
 */
export async function backfillUserProviderKeyFingerprint(
  id: string,
  fingerprint: string
): Promise<void> {
  await sql`
    UPDATE user_provider_keys
       SET master_key_fingerprint = ${fingerprint}
     WHERE id = ${id} AND master_key_fingerprint IS NULL
  `;
}

// --- User-defined custom providers (L4) -----------------------------------

export type StoredCustomProvider = {
  id: string;
  user_id: string;
  name: string;
  base_url: string;
  model_prefix: string;
  encrypted_key: string | null;
  master_key_fingerprint: string | null;
  wire_format: string;
  enabled: boolean;
};

/**
 * Return every enabled custom provider for a user, ordered so longer
 * model prefixes match first (e.g. "groq/mixtral" takes precedence
 * over "groq/"). Empty list is the common case; a user who hasn't
 * registered any custom upstreams just falls through to the static
 * PROVIDER_TEMPLATES scan.
 *
 * Called on the hot path — every request the resolver can't match to
 * a static template ends up here. We lean on the partial index on
 * `(user_id) WHERE enabled = TRUE` + the expectation that most users
 * have 0-3 rows so the prefix sort is cheap.
 */
export async function listUserCustomProviders(
  userId: string
): Promise<StoredCustomProvider[]> {
  const cached = userCustomProvidersCache.get(userId);
  if (cached !== undefined) return cached;

  const rows = await sql<StoredCustomProvider[]>`
    SELECT id, user_id, name, base_url, model_prefix,
           encrypted_key, master_key_fingerprint, wire_format, enabled
    FROM user_custom_providers
    WHERE user_id = ${userId} AND enabled = TRUE
    ORDER BY length(model_prefix) DESC, name ASC
  `;
  userCustomProvidersCache.set(
    userId,
    rows,
    rows.length > 0
      ? USER_CUSTOM_PROVIDERS_CACHE_TTL_MS
      : API_KEY_NULL_TTL_MS
  );
  return rows;
}

// --- L5 rejection telemetry -----------------------------------------------

/**
 * Record a gateway-rejected model attempt. Called from the chat route
 * whenever `resolveProvider` returns `no_template` / `no_credentials`.
 *
 * Aggregate upsert — one row per (model, reason, project) tuple,
 * incremented + `last_seen_at` stamped on each hit. Heavy hitters just
 * bump a counter; first-ever hit inserts. Best-effort: a DB hiccup
 * must not bubble up into the already-failing request response, so
 * the caller wraps in a catch.
 *
 * SQLite-shim safe — its UPSERT syntax is Postgres-compatible via the
 * shim's ON CONFLICT translation. In practice self-host SQLite mode
 * rarely sees these rejections (single operator, single env key).
 */
export async function recordModelRejection(input: {
  model: string;
  reason: "no_template" | "no_credentials";
  providerGuess: string | null;
  projectId: string | null;
}): Promise<void> {
  const model = input.model.toLowerCase().slice(0, 200);
  if (!model) return;
  // ON CONFLICT uses the unique index on (model, reason, COALESCE(project_id)).
  // The `DO UPDATE` path increments + refreshes last_seen_at atomically so
  // a burst of concurrent rejections doesn't lose any counts.
  await sql`
    INSERT INTO ops_model_rejections (
      model, reason, provider_guess, project_id, hit_count,
      first_seen_at, last_seen_at
    ) VALUES (
      ${model}, ${input.reason}, ${input.providerGuess}, ${input.projectId},
      1, NOW(), NOW()
    )
    ON CONFLICT (model, reason, (COALESCE(project_id::text, '')))
    DO UPDATE SET
      hit_count    = ops_model_rejections.hit_count + 1,
      last_seen_at = NOW(),
      -- Backfill provider_guess when we learn it after a previous
      -- NULL insertion (e.g. the first rejection was no_template, the
      -- second was no_credentials with template inferred).
      provider_guess = COALESCE(ops_model_rejections.provider_guess, EXCLUDED.provider_guess)
  `;
}

// --- Operator audit log ---------------------------------------------------

export type OpsAuditInput = {
  userId?: string | null;
  event: string;
  targetType?: string | null;
  targetId?: string | null;
  actor?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
};

/**
 * Append-only system event log. Used for things that are NOT attributable to
 * a signed-in dashboard user — master-key rotation lifecycle, gateway
 * boot/shutdown, schema migration applied, etc. Distinct from
 * `audit_events` which is per-user and surfaced on the /audit page.
 */
export async function logOpsEvent(input: OpsAuditInput): Promise<void> {
  // SQLite single-binary trial doesn't ship the ops_audit_events table —
  // operator-side audit is a hosted-only concern. No-op cleanly so
  // routine boot events (migration applied, key rotation lifecycle)
  // don't spam stderr with "no such table" errors.
  if (dbBackend === "sqlite") return;
  try {
    await sql`
      INSERT INTO ops_audit_events (
        user_id, event, target_type, target_id, actor, metadata, ip
      ) VALUES (
        ${input.userId ?? null},
        ${input.event},
        ${input.targetType ?? null},
        ${input.targetId ?? null},
        ${input.actor ?? null},
        ${sql.json((input.metadata ?? {}) as Parameters<typeof sql.json>[0])},
        ${input.ip ?? null}
      )
    `;
  } catch (err) {
    console.error("[ops-audit] insert failed:", err);
  }
}

/**
 * Plan + user context for a project, used for hosted-tier daily-spend caps.
 * Returns null for unowned projects (self-hosted dev seed) so the plan check
 * becomes a no-op in single-tenant mode.
 *
 * In-memory cached for `PROJECT_PLAN_CACHE_TTL_MS` (60s). Plan changes
 * (Stripe webhook flips `users.plan`) are eventually consistent across
 * gateway replicas within that window — see the cache block at the top
 * of this file for the contract.
 */
export async function getProjectPlan(
  projectId: string
): Promise<{ user_id: string; plan: string } | null> {
  // SQLite single-binary trial mode has no `users` table — plan-tier
  // enforcement is a hosted-only concept. Skip the join entirely so we
  // don't crash on an undefined relation. We don't cache the SQLite
  // null either; it's a constant-time return.
  if (dbBackend === "sqlite") return null;

  const cached = projectPlanCache.get(projectId);
  if (cached !== undefined) return cached;

  const rows = await sql<{ user_id: string | null; plan: string | null }[]>`
    SELECT p.user_id, u.plan
    FROM projects p
    LEFT JOIN users u ON u.id = p.user_id
    WHERE p.id = ${projectId}
    LIMIT 1
  `;
  const row = rows[0];
  const result =
    !row || !row.user_id || !row.plan
      ? null
      : { user_id: row.user_id, plan: row.plan };
  // Both hits and misses go in the cache: an unowned project (self-host
  // seed) doesn't suddenly grow a plan, so the null here is safe. If
  // ownership is later granted, the 60s window is the consistency cost.
  projectPlanCache.set(projectId, result, PROJECT_PLAN_CACHE_TTL_MS);
  return result;
}

/**
 * Rolling 24h micro_cents spend across every project this user owns.
 * Only `status='success'` counts — blocked / errored requests don't bill.
 */
export async function getUserDailyMicroCents(userId: string): Promise<number> {
  const rows = await sql<{ total: string }[]>`
    SELECT COALESCE(SUM(r.cost_micro_cents), 0)::bigint AS total
    FROM requests r
    JOIN projects p ON p.id = r.project_id
    WHERE p.user_id = ${userId}
      AND r.status = 'success'
      AND r.created_at > NOW() - INTERVAL '24 hours'
  `;
  return Number(rows[0]?.total ?? 0);
}

/**
 * Rolling 30-day successful request count across every project this user
 * owns. Mirror of `getUserDailyMicroCents` for the second cap dimension
 * added in v0.2.x ("$X/day OR N requests/month, whichever first").
 *
 * Only `status='success'` counts — bounced (loop / budget / plan / 4xx
 * upstream) requests don't burn the customer's monthly request quota.
 * That's deliberate: blocked requests are TokSuan doing its job,
 * the customer shouldn't pay quota for our protection.
 */
export async function getUserMonthlyRequestCount(userId: string): Promise<number> {
  const rows = await sql<{ total: string }[]>`
    SELECT COUNT(*)::bigint AS total
    FROM requests r
    JOIN projects p ON p.id = r.project_id
    WHERE p.user_id = ${userId}
      AND r.status = 'success'
      AND r.created_at > NOW() - INTERVAL '30 days'
  `;
  return Number(rows[0]?.total ?? 0);
}

export async function touchApiKey(apiKeyId: string): Promise<void> {
  await sql`
    UPDATE api_keys SET last_used_at = NOW() WHERE id = ${apiKeyId}
  `;
}

export type InsertRequest = Omit<
  RequestRecord,
  | "id"
  | "created_at"
  | "streamed"
  | "cache_savings_micro_cents"
  | "routing_saving_micro_cents"
  | "routing_reason"
  | "routing_bucket"
  | "tags"
> & {
  // Newer fields are optional on insert so callers don't have to plumb them
  // through immediately. Defaults match the schema (false / 0 / {} / NULL).
  streamed?: boolean;
  cache_savings_micro_cents?: number;
  routing_saving_micro_cents?: number;
  routing_reason?: string | null;
  routing_bucket?: string | null;
  tags?: Record<string, string>;
  /**
   * Optional caller-supplied row id. When set, the INSERT writes the
   * exact UUID the caller pre-allocated; when null/omitted, the column
   * default (`gen_random_uuid()` on Postgres / shim function on
   * SQLite) chooses the id at write time.
   *
   * Why pre-allocate: the chat handler stamps the request id into the
   * `X-Tokensmart-Request-Id` response header BEFORE the streaming
   * body starts flowing. That header is the only thing a long-running
   * agent (OpenClaw) can use to follow a specific request back to the
   * dashboard's request-detail page; if we generated the id at insert
   * time it wouldn't exist yet when the SSE response opens.
   */
  id?: string;
};

export async function insertRequest(rec: InsertRequest): Promise<RequestRecord> {
  const tagsObj =
    rec.tags && typeof rec.tags === "object" ? rec.tags : {};
  // v0.6.7: apply selective request_body storage. Failures keep their
  // full body in `sample` mode (debugging value); steady-state successes
  // are sampled (or always-truncated under `never`). Operators trade
  // debug visibility for storage cost + privacy posture via
  // TOKENSMART_STORE_FULL_REQUEST_BODY. Centralized here so EVERY
  // insertRequest call site (chat handler success/failure paths, cache
  // hit, semantic-cache fill, dev seed scripts) gets the same policy.
  const storedBody = chooseRequestBodyForStorage(rec.request_body, rec.status);
  if (rec.id) {
    const rows = await sql<RequestRecord[]>`
      INSERT INTO requests (
        id, project_id, api_key_id, provider, model,
        input_tokens, cached_input_tokens, output_tokens,
        cost_cents, cost_micro_cents, cache_savings_micro_cents,
        routing_saving_micro_cents,
        latency_ms, status, error, fingerprint, original_model, streamed,
        request_body, response_body, tags,
        routing_reason, routing_bucket
      ) VALUES (
        ${rec.id}, ${rec.project_id}, ${rec.api_key_id}, ${rec.provider}, ${rec.model},
        ${rec.input_tokens}, ${rec.cached_input_tokens}, ${rec.output_tokens},
        ${rec.cost_cents}, ${rec.cost_micro_cents},
        ${rec.cache_savings_micro_cents ?? 0},
        ${rec.routing_saving_micro_cents ?? 0},
        ${rec.latency_ms}, ${rec.status}, ${rec.error},
        ${rec.fingerprint}, ${rec.original_model},
        ${rec.streamed ?? false},
        ${sql.json(storedBody as Parameters<typeof sql.json>[0])},
        ${rec.response_body ? sql.json(rec.response_body as Parameters<typeof sql.json>[0]) : null},
        ${sql.json(tagsObj as Parameters<typeof sql.json>[0])},
        ${rec.routing_reason ?? null},
        ${rec.routing_bucket ?? null}
      )
      RETURNING *
    `;
    return rows[0]!;
  }
  const rows = await sql<RequestRecord[]>`
    INSERT INTO requests (
      project_id, api_key_id, provider, model,
      input_tokens, cached_input_tokens, output_tokens,
      cost_cents, cost_micro_cents, cache_savings_micro_cents,
      routing_saving_micro_cents,
      latency_ms, status, error, fingerprint, original_model, streamed,
      request_body, response_body, tags,
      routing_reason, routing_bucket
    ) VALUES (
      ${rec.project_id}, ${rec.api_key_id}, ${rec.provider}, ${rec.model},
      ${rec.input_tokens}, ${rec.cached_input_tokens}, ${rec.output_tokens},
      ${rec.cost_cents}, ${rec.cost_micro_cents},
      ${rec.cache_savings_micro_cents ?? 0},
      ${rec.routing_saving_micro_cents ?? 0},
      ${rec.latency_ms}, ${rec.status}, ${rec.error},
      ${rec.fingerprint}, ${rec.original_model},
    ${rec.streamed ?? false},
    ${sql.json(storedBody as Parameters<typeof sql.json>[0])},
    ${rec.response_body ? sql.json(rec.response_body as Parameters<typeof sql.json>[0]) : null},
    ${sql.json(tagsObj as Parameters<typeof sql.json>[0])},
    ${rec.routing_reason ?? null},
    ${rec.routing_bucket ?? null}
  )
  RETURNING *
`;
  return rows[0]!;
}

// --- Budgets ---------------------------------------------------------------

export type BudgetPeriod = "daily" | "monthly";

export type Budget = {
  id: string;
  project_id: string;
  period: BudgetPeriod;
  // 1 cent = 1000 micro_cents. Sub-cent budgets are supported so tiny demo
  // workloads on cheap models can still exercise enforcement.
  limit_micro_cents: number;
  enabled: boolean;
};

export async function getActiveBudgets(projectId: string): Promise<Budget[]> {
  return sql<Budget[]>`
    SELECT id, project_id, period, limit_micro_cents, enabled
    FROM budgets
    WHERE project_id = ${projectId}
      AND enabled = TRUE
  `;
}

/**
 * How many micro_cents this project has spent inside the given period.
 *
 * We use micro_cents (1 cent = 1000 micro_cents) rather than cents because
 * a single Gemini-flash-lite call can be well under 1 cent, so rounding to
 * whole cents would make budgets impossible to exercise with small requests.
 *
 * We only count `status = 'success'` rows — errors and budget_exceeded rows
 * do not represent money actually spent at the upstream provider.
 *
 * Day / month boundaries use the database's current timezone (UTC in the
 * default Postgres container). Good enough for v0 demos; revisit when we
 * support user-local timezones.
 */
export async function getSpendForPeriodMicroCents(
  projectId: string,
  period: BudgetPeriod
): Promise<number> {
  const cutoff = periodStartUtc(period);
  const rows = await sql<{ total: number }[]>`
    SELECT COALESCE(SUM(cost_micro_cents), 0)::bigint AS total
    FROM requests
    WHERE project_id = ${projectId}
      AND status = 'success'
      AND created_at >= ${cutoff}
  `;
  return Number(rows[0]?.total ?? 0);
}

/**
 * Compute the UTC cutoff datetime for a budget period (start of day or
 * start of month). Doing the truncation in JS keeps the SQL portable
 * across Postgres + SQLite without relying on a parameterised
 * `DATE_TRUNC(${unit}, NOW())` rewrite (which the SQLite shim cannot
 * do because the unit isn't a literal at translation time).
 */
function periodStartUtc(period: BudgetPeriod): Date {
  const now = new Date();
  if (period === "daily") {
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export type BudgetReservationAttempt =
  | {
      ok: true;
      reservation_ids: string[];
      reserved_micro_cents: number;
    }
  | {
      ok: false;
      period: BudgetPeriod;
      limit_micro_cents: number;
      spend_micro_cents: number;
      reserved_micro_cents: number;
      requested_micro_cents: number;
    };

function reservationTtlMs(): number {
  const raw = Number(process.env.TOKENSMART_BUDGET_RESERVATION_TTL_SECONDS ?? "900");
  const seconds = Number.isFinite(raw) ? Math.max(60, Math.min(raw, 3600)) : 900;
  return seconds * 1000;
}

/**
 * Atomically reserve budget headroom for an in-flight upstream request.
 *
 * The request ledger only contains finished calls, so checking ledger spend
 * alone lets concurrent agent turns all pass the gate and overshoot together.
 * This writes short-lived pending reservation rows per active budget period
 * and counts those rows during the next reservation attempt. Callers release
 * reservations after the final request row is written; crashed requests age out
 * via `expires_at`.
 */
export async function reserveBudgetForRequest(
  projectId: string,
  requestedMicroCents: number
): Promise<BudgetReservationAttempt> {
  const amount = Math.max(0, Math.ceil(requestedMicroCents));
  if (amount <= 0) {
    return { ok: true, reservation_ids: [], reserved_micro_cents: 0 };
  }

  const expiresAt = new Date(Date.now() + reservationTtlMs());

  return sql.begin(async (tx) => {
    const budgets =
      dbBackend === "postgres"
        ? await tx<Budget[]>`
            SELECT id, project_id, period, limit_micro_cents, enabled
            FROM budgets
            WHERE project_id = ${projectId}
              AND enabled = TRUE
            ORDER BY period
            FOR UPDATE
          `
        : await tx<Budget[]>`
            SELECT id, project_id, period, limit_micro_cents, enabled
            FROM budgets
            WHERE project_id = ${projectId}
              AND enabled = TRUE
            ORDER BY period
          `;

    if (budgets.length === 0) {
      return { ok: true, reservation_ids: [], reserved_micro_cents: 0 };
    }

    const periods = Array.from(new Set(budgets.map((b) => b.period)));
    const spendByPeriod = new Map<BudgetPeriod, number>();
    for (const period of periods) {
      const cutoff = periodStartUtc(period);
      const rows = await tx<{ total: string }[]>`
        SELECT COALESCE(SUM(cost_micro_cents), 0)::bigint AS total
        FROM requests
        WHERE project_id = ${projectId}
          AND status = 'success'
          AND created_at >= ${cutoff}
      `;
      spendByPeriod.set(period, Number(rows[0]?.total ?? 0));
    }

    const reservedRows = await tx<{ period: BudgetPeriod; total: string }[]>`
      SELECT period, COALESCE(SUM(amount_micro_cents), 0)::bigint AS total
      FROM budget_reservations
      WHERE project_id = ${projectId}
        AND status = 'pending'
        AND expires_at > NOW()
      GROUP BY period
    `;
    const reservedByPeriod = new Map<BudgetPeriod, number>(
      reservedRows.map((r) => [r.period, Number(r.total ?? 0)])
    );

    for (const b of budgets) {
      const spendMicro = spendByPeriod.get(b.period) ?? 0;
      const reservedMicro = reservedByPeriod.get(b.period) ?? 0;
      if (spendMicro + reservedMicro + amount > b.limit_micro_cents) {
        return {
          ok: false,
          period: b.period,
          limit_micro_cents: b.limit_micro_cents,
          spend_micro_cents: spendMicro,
          reserved_micro_cents: reservedMicro,
          requested_micro_cents: amount,
        };
      }
    }

    const reservationIds: string[] = [];
    for (const b of budgets) {
      const rows = await tx<{ id: string }[]>`
        INSERT INTO budget_reservations (
          project_id, budget_id, period, amount_micro_cents, expires_at
        ) VALUES (
          ${projectId}, ${b.id}, ${b.period}, ${amount}, ${expiresAt}
        )
        RETURNING id
      `;
      if (rows[0]?.id) reservationIds.push(rows[0].id);
    }

    return {
      ok: true,
      reservation_ids: reservationIds,
      reserved_micro_cents: amount,
    };
  });
}

export async function releaseBudgetReservations(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  for (const id of ids) {
    await sql`
      UPDATE budget_reservations
      SET status = 'released',
          released_at = NOW()
      WHERE id = ${id}
        AND status = 'pending'
    `;
  }
}

// --- Plan-tier reservations -----------------------------------------------

export type PlanReservationAttempt =
  | {
      ok: true;
      reservation_id: string | null;
      reserved_micro_cents: number;
      reserved_requests: number;
    }
  | {
      ok: false;
      trigger: "daily_spend" | "monthly_requests";
      // The cap dimension that would have been blown.
      limit: number;
      // Already-committed usage in the matching dimension.
      committed: number;
      // In-flight reservations summed in the matching dimension.
      reserved: number;
      // What this request is asking to add in the matching dimension.
      requested: number;
    };

/**
 * Atomically reserve a slot under the user's plan-tier caps.
 *
 * Mirrors `reserveBudgetForRequest` for project budgets, but per-USER
 * (plan caps live one level up — they're owned by the user, not the
 * project). Two cap dimensions are checked in a single transaction:
 *
 *   * dailyLimitMicroCents  — rolling-24h spend across every project
 *     this user owns. Reservation amount is the caller-supplied cost
 *     ESTIMATE for this request (worst case from the pricing table);
 *     real cost is reconciled at finalize.
 *   * monthlyRequestLimit   — rolling-30d successful request count
 *     across every project this user owns. Reservation always
 *     consumes 1 request slot.
 *
 * Either limit may be `Number.POSITIVE_INFINITY` — interpreted as
 * "unlimited for this dimension", which is how Team / Scale plans
 * pass through with zero gating cost. The function still records a
 * reservation row in that case so `releasePlanReservations` is a
 * no-op-friendly contract from the caller's perspective.
 *
 * SQLite mode never reaches this function: `getProjectPlan()` returns
 * null without users/plans, and the chat handler skips plan
 * enforcement entirely on SQLite installs.
 */
export async function reservePlanForRequest(
  userId: string,
  estimatedMicroCents: number,
  dailyLimitMicroCents: number,
  monthlyRequestLimit: number,
  // Optional sql client override. The default uses the module-level
  // singleton, which is what every production caller wants. Tests
  // override it to point at a hermetic temp database — the singleton
  // is bound to the gateway's main DATABASE_URL at import time and
  // can't be re-pointed once another module triggered the import.
  // Same pattern would let a future feature (read-only replica gate
  // for plan caps) inject a different connection without rewriting
  // the function body.
  sqlClient: typeof sql = sql
): Promise<PlanReservationAttempt> {
  const amount = Math.max(0, Math.ceil(estimatedMicroCents));
  const expiresAt = new Date(Date.now() + reservationTtlMs());
  const checkDaily = Number.isFinite(dailyLimitMicroCents);
  const checkMonthly = Number.isFinite(monthlyRequestLimit);

  // No caps to enforce → still emit a no-op reservation_id of NULL
  // (callers treat this as "nothing to release").
  if (!checkDaily && !checkMonthly) {
    return {
      ok: true,
      reservation_id: null,
      reserved_micro_cents: amount,
      reserved_requests: 1,
    };
  }

  return sqlClient.begin(async (tx) => {
    // Serialize concurrent reservations for the same user.
    //
    // Without this lock, two concurrent OpenClaw turns owned by the
    // same user both read the same pending+committed total under
    // READ COMMITTED, both pass the limit check, and both INSERT
    // their reservation row — so daily / monthly plan caps quietly
    // overshoot. Project budgets get equivalent serialization from
    // the `SELECT … FOR UPDATE` on the budgets row above; plan caps
    // have no per-row natural anchor (the users row exists but is
    // semantically wrong to lock — we'd be blocking unrelated
    // metadata updates), so we use a transaction-scoped advisory
    // lock keyed on a hash of the user_id.
    //
    // Two userIds that hash-collide just serialize together; the
    // lock auto-releases at COMMIT/ROLLBACK so a crashed reservation
    // doesn't leave a stuck cluster-wide lock. Postgres-only —
    // SQLite mode never reaches this code path because
    // `getProjectPlan()` returns null without a users table.
    if (dbBackend === "postgres") {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
    }

    let committedSpend = 0;
    let reservedSpend = 0;
    if (checkDaily) {
      const spendRows = await tx<{ total: string }[]>`
        SELECT COALESCE(SUM(r.cost_micro_cents), 0)::bigint AS total
        FROM requests r
        JOIN projects p ON p.id = r.project_id
        WHERE p.user_id = ${userId}
          AND r.status = 'success'
          AND r.created_at > NOW() - INTERVAL '24 hours'
      `;
      committedSpend = Number(spendRows[0]?.total ?? 0);
      const reservedRows = await tx<{ total: string }[]>`
        SELECT COALESCE(SUM(amount_micro_cents), 0)::bigint AS total
        FROM plan_reservations
        WHERE user_id = ${userId}
          AND status = 'pending'
          AND expires_at > NOW()
      `;
      reservedSpend = Number(reservedRows[0]?.total ?? 0);

      if (committedSpend + reservedSpend + amount > dailyLimitMicroCents) {
        return {
          ok: false,
          trigger: "daily_spend",
          limit: dailyLimitMicroCents,
          committed: committedSpend,
          reserved: reservedSpend,
          requested: amount,
        };
      }
    }

    let committedRequests = 0;
    let reservedRequests = 0;
    if (checkMonthly) {
      const countRows = await tx<{ total: string }[]>`
        SELECT COUNT(*)::bigint AS total
        FROM requests r
        JOIN projects p ON p.id = r.project_id
        WHERE p.user_id = ${userId}
          AND r.status = 'success'
          AND r.created_at > NOW() - INTERVAL '30 days'
      `;
      committedRequests = Number(countRows[0]?.total ?? 0);
      const reservedReqRows = await tx<{ total: string }[]>`
        SELECT COALESCE(SUM(request_count), 0)::bigint AS total
        FROM plan_reservations
        WHERE user_id = ${userId}
          AND status = 'pending'
          AND expires_at > NOW()
      `;
      reservedRequests = Number(reservedReqRows[0]?.total ?? 0);

      if (committedRequests + reservedRequests + 1 > monthlyRequestLimit) {
        return {
          ok: false,
          trigger: "monthly_requests",
          limit: monthlyRequestLimit,
          committed: committedRequests,
          reserved: reservedRequests,
          requested: 1,
        };
      }
    }

    const inserted = await tx<{ id: string }[]>`
      INSERT INTO plan_reservations (
        user_id, amount_micro_cents, request_count, expires_at
      ) VALUES (
        ${userId}, ${amount}, ${1}, ${expiresAt}
      )
      RETURNING id
    `;
    return {
      ok: true,
      reservation_id: inserted[0]?.id ?? null,
      reserved_micro_cents: amount,
      reserved_requests: 1,
    };
  });
}

export async function releasePlanReservations(
  ids: string[],
  sqlClient: typeof sql = sql
): Promise<void> {
  if (ids.length === 0) return;
  for (const id of ids) {
    await sqlClient`
      UPDATE plan_reservations
      SET status = 'released',
          released_at = NOW()
      WHERE id = ${id}
        AND status = 'pending'
    `;
  }
}

// --- Routing rules ---------------------------------------------------------

export type RoutingMode = "route" | "shadow" | "both";

export type RoutingRule = {
  id: string;
  project_id: string;
  enabled: boolean;
  threshold: number;
  from_pattern: string;
  to_model: string;
  shadow_to_model: string | null;
  mode: RoutingMode;
  /**
   * Probability the rule fires when it would otherwise match. NULL =
   * legacy "fire on every match" behavior; any value in (0, 1] gates
   * the firing on `Math.random() < sample_rate`. Useful for keeping
   * shadow traffic to a small fraction of qualifying requests, so the
   * aggregator gets a steady trickle of A/B observations without
   * doubling the upstream bill. Added in migration 020.
   */
  sample_rate: number | null;
};

export async function getRoutingRules(projectId: string): Promise<RoutingRule[]> {
  const cached = routingRulesCache.get(projectId);
  if (cached !== undefined) return cached;

  const rows = await sql<RoutingRule[]>`
    SELECT id, project_id, enabled, threshold, from_pattern, to_model,
           shadow_to_model, mode, sample_rate
    FROM routing_rules
    WHERE project_id = ${projectId}
      AND enabled = TRUE
    ORDER BY created_at ASC
  `;
  routingRulesCache.set(projectId, rows, ROUTING_RULES_CACHE_TTL_MS);
  return rows;
}

// --- A/B shadow results ---------------------------------------------------

export type AbResultInsert = {
  project_id: string;
  primary_request_id: string | null;
  primary_model: string;
  primary_provider: string;
  primary_input_tokens: number;
  primary_output_tokens: number;
  primary_cost_micro_cents: number;
  primary_latency_ms: number | null;
  shadow_model: string;
  shadow_provider: string;
  shadow_input_tokens: number;
  shadow_output_tokens: number;
  shadow_cost_micro_cents: number;
  shadow_latency_ms: number | null;
  shadow_status: "success" | "error";
  shadow_response_body: unknown;
  shadow_error: string | null;
  fingerprint: string | null;
  /**
   * Cosine similarity of embedded primary vs shadow response text, in
   * [-1, 1]. Null when not computed (embedding disabled, error, or
   * either response was empty / streamed). v0.2.0 addition.
   */
  similarity?: number | null;
};

export async function insertAbResult(rec: AbResultInsert): Promise<void> {
  await sql`
    INSERT INTO ab_results (
      project_id, primary_request_id,
      primary_model, primary_provider,
      primary_input_tokens, primary_output_tokens,
      primary_cost_micro_cents, primary_latency_ms,
      shadow_model, shadow_provider,
      shadow_input_tokens, shadow_output_tokens,
      shadow_cost_micro_cents, shadow_latency_ms,
      shadow_status, shadow_response_body, shadow_error, fingerprint,
      similarity
    ) VALUES (
      ${rec.project_id}, ${rec.primary_request_id},
      ${rec.primary_model}, ${rec.primary_provider},
      ${rec.primary_input_tokens}, ${rec.primary_output_tokens},
      ${rec.primary_cost_micro_cents}, ${rec.primary_latency_ms},
      ${rec.shadow_model}, ${rec.shadow_provider},
      ${rec.shadow_input_tokens}, ${rec.shadow_output_tokens},
      ${rec.shadow_cost_micro_cents}, ${rec.shadow_latency_ms},
      ${rec.shadow_status},
      ${rec.shadow_response_body ? sql.json(rec.shadow_response_body as Parameters<typeof sql.json>[0]) : null},
      ${rec.shadow_error}, ${rec.fingerprint},
      ${rec.similarity ?? null}
    )
  `;
}

// --- Alert rules -----------------------------------------------------------

export type AlertEventType =
  | "budget_exceeded"
  | "loop_detected"
  | "cost_anomaly"
  // Background retrain (cloud cron OR self-host CLI) failed for this
  // project. Surfaces aggregator errors (DB hiccup, sanity check
  // refused the new policy, transaction couldn't commit). The current
  // active policy keeps serving — the alert exists so the operator
  // knows tonight's run didn't improve anything.
  | "retrain_failed";

export const ALERT_EVENT_TYPES: readonly AlertEventType[] = [
  "budget_exceeded",
  "loop_detected",
  "cost_anomaly",
  "retrain_failed",
] as const;

export type AlertRule = {
  id: string;
  project_id: string;
  event_type: AlertEventType;
  webhook_url: string | null;
  email: string | null;
  enabled: boolean;
};

export async function getAlertRules(
  projectId: string,
  eventType: AlertEventType
): Promise<AlertRule[]> {
  return sql<AlertRule[]>`
    SELECT id, project_id, event_type, webhook_url, email, enabled
    FROM alert_rules
    WHERE project_id = ${projectId}
      AND event_type = ${eventType}
      AND enabled = TRUE
  `;
}

/**
 * Single rule by id, scoped to a project. Used by `/internal/test-alert` so
 * the dashboard can verify the operator's rule round-trips through the
 * gateway's actual delivery code (not a parallel implementation).
 *
 * Does NOT filter on `enabled` — testing a temporarily-disabled rule is
 * still useful, and ownership is enforced by `project_id` upstream.
 */
export async function getAlertRuleById(
  id: string,
  projectId: string
): Promise<AlertRule | null> {
  const rows = await sql<AlertRule[]>`
    SELECT id, project_id, event_type, webhook_url, email, enabled
    FROM alert_rules
    WHERE id = ${id} AND project_id = ${projectId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * All projects with at least one enabled alert rule for the given event type.
 * Used by the cost-anomaly background monitor so we only scan projects that
 * have actually subscribed.
 */
export async function listProjectsWithAlerts(
  eventType: AlertEventType
): Promise<Array<{ project_id: string }>> {
  return sql<Array<{ project_id: string }>>`
    SELECT DISTINCT project_id
    FROM alert_rules
    WHERE event_type = ${eventType}
      AND enabled = TRUE
  `;
}
