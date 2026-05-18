import { unstable_cache } from "next/cache";
import type { OrgSamlConfig } from "./saml";
import { activeBackend, buildSql, type Sql } from "./sql-driver";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local.");
}

// Reuse the connection across hot-reloads in dev. Single global handle
// regardless of backend — `buildSql` returns a postgres.js client for
// `postgres://` URLs and a SQLite-backed shim that satisfies the same
// surface for `sqlite:` / `:memory:` URLs. Callers in this file talk
// to that single `sql` handle and never branch on backend.
declare global {
  // eslint-disable-next-line no-var
  var __tokensmart_sql: Sql | undefined;
}

export const sql: Sql = global.__tokensmart_sql ?? buildSql(url);

if (process.env.NODE_ENV !== "production") {
  global.__tokensmart_sql = sql;
}

/**
 * Backend the dashboard is reading from. Some queries (LATERAL joins,
 * advanced JSONB-aggregation, generate_series in obscure positions) are
 * Postgres-only and a SQLite-mode dashboard skips those cards rather
 * than render a confusing error. Pages can guard with this and fall back
 * to an empty-state when needed; queries that don't translate cleanly
 * raise a runtime error and the existing per-card try/catch in
 * `app/dashboard/DashboardPage.tsx` keeps the rest of the page rendering.
 */
export { activeBackend };

/**
 * Convention used by every query in this file for multi-tenant scoping.
 *
 *   scope === undefined  → no filter; show every row (self-hosted mode)
 *   scope === []         → never match; the user owns zero projects
 *   scope === [ids...]   → project_id = ANY(scope)
 *
 * Callers get a single source of truth: pass `undefined` when auth is off
 * and the `string[]` of owned project IDs when it's on.
 */
type Scope = string[] | undefined;

const projectScope = (scope: Scope) =>
  scope === undefined
    ? sql`TRUE`
    : scope.length === 0
    ? sql`FALSE`
    : sql`project_id = ANY(${scope}::uuid[])`;

// =========================================================================
// Dashboard read-cache helpers
// =========================================================================
//
// `unstable_cache` (Next 15) memoizes a server-side function across
// requests within a single Vercel function instance, keyed by its
// arguments + the explicit `keyParts` we pass. The TTL we use lines up
// with `<AutoRefresh>` (defaults to ~30s `router.refresh()` cadence) —
// so each refresh triggers ONE cache miss per query, then 30s of hits.
//
// Trade: every cached query trades up to `revalidateSeconds` of
// staleness for a 0-roundtrip read. The dashboard surfaces are
// observational ("what happened over the last 7 days"), not
// transactional, so 30-60s lag is invisible to the user — and the
// wall-clock saved is dramatic when DB latency is non-trivial (cross-
// region Neon, cold-start serverless functions, etc.).
//
// We deliberately DO NOT wrap:
//   * `getBudgetStatus`   — user just changed a budget on /projects/[id],
//                           expects to see it on /dashboard immediately.
//   * `getProjectSpendContext` — drives the live budget-form preview.
//   * Any `listX` (projects, api keys, provider keys) — mutated by
//                           explicit user actions; staleness here would
//                           feel broken.
//   * `getSession`        — uses `cookies()`, can't cache.
//   * Single-row reads    — `getRequestById`, `getFingerprintNeighbors`
//                           are already cheap and deep-linked (not on
//                           the hot dashboard render).
//
// All cached queries share the `dashboard-stats` tag so a future
// mutation path can mass-invalidate via `revalidateTag("dashboard-stats")`
// when fine-grained tags are warranted.

// `Args extends unknown[]` was tighter but poisoned contextual typing
// inside the arrow function literals we pass — TypeScript inferred the
// inner `scope?: Scope` parameter as `unknown` whenever the constraint
// was narrower than what `unstable_cache` itself declares. `any[]`
// matches Next's `Callback` exactly so inference unifies cleanly. We
// still recover full type-safety for the cached function signature
// because Args + R are inferred from the literal we pass in.
function cacheStats<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Args extends any[],
  R,
>(
  fn: (...args: Args) => Promise<R>,
  keyName: string,
  revalidateSeconds = 30
): (...args: Args) => Promise<R> {
  return unstable_cache(fn, [keyName], {
    revalidate: revalidateSeconds,
    tags: ["dashboard-stats"],
  });
}

// --- Requests --------------------------------------------------------------

export type RecentRequest = {
  id: string;
  provider: string;
  model: string;
  original_model: string | null;
  fingerprint: string | null;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  cost_micro_cents: number;
  routing_saving_micro_cents: number;
  cache_savings_micro_cents: number;
  routing_reason: string | null;
  routing_bucket: string | null;
  latency_ms: number | null;
  status: string;
  created_at: Date;
};

export const getRecentRequests = cacheStats(
  async (limit = 50, scope?: Scope): Promise<RecentRequest[]> => {
    // `routing_saving_micro_cents` is BIGINT in the schema, and postgres.js
    // hands BIGINT columns back as STRING (see migration 005). Without an
    // explicit cast the consumer reads it as `string` despite the typed
    // declaration, and then `cost_micro_cents + routing_saving_micro_cents`
    // does string-concat instead of integer addition — turning a $0.04
    // routing saving into a "$45.40 asked-would-be" line on the savings
    // receipt because "45" + "39550" = "4539550". Per-request values fit
    // in INT4 with room to spare ($21,474 ceiling), so casting is safe.
    return sql<RecentRequest[]>`
      SELECT id, provider, model, original_model, fingerprint,
             input_tokens, cached_input_tokens, output_tokens,
             cost_micro_cents,
             routing_saving_micro_cents::int AS routing_saving_micro_cents,
             cache_savings_micro_cents, routing_reason, routing_bucket,
             latency_ms, status, created_at
      FROM requests
      WHERE ${projectScope(scope)}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  },
  "getRecentRequests"
);

export type RequestDetail = {
  id: string;
  project_id: string | null;
  api_key_id: string | null;
  provider: string;
  model: string;
  original_model: string | null;
  fingerprint: string | null;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  cost_micro_cents: number;
  routing_saving_micro_cents: number;
  cache_savings_micro_cents: number;
  latency_ms: number | null;
  status: string;
  error: string | null;
  request_body: unknown;
  response_body: unknown;
  created_at: Date;
  project_name: string | null;
  api_key_name: string | null;
};

export async function getRequestById(
  id: string,
  scope?: Scope
): Promise<RequestDetail | null> {
  // Same BIGINT-as-string issue as `getRecentRequests` — explicit ::int
  // cast keeps `routing_saving_micro_cents` a Number on read, so JS math
  // in the request detail page doesn't fall into the string-concat trap.
  const rows = await sql<RequestDetail[]>`
    SELECT
      r.id, r.project_id, r.api_key_id, r.provider, r.model,
      r.original_model, r.fingerprint,
      r.input_tokens, r.cached_input_tokens, r.output_tokens,
      r.cost_micro_cents,
      r.routing_saving_micro_cents::int AS routing_saving_micro_cents,
      r.cache_savings_micro_cents,
      r.latency_ms, r.status, r.error,
      r.request_body, r.response_body, r.created_at,
      p.name AS project_name,
      k.name AS api_key_name
    FROM requests r
    LEFT JOIN projects p ON p.id = r.project_id
    LEFT JOIN api_keys k ON k.id = r.api_key_id
    WHERE r.id = ${id}
      AND (${projectScopeForAlias(scope, "r")})
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export type FingerprintNeighbor = {
  id: string;
  created_at: Date;
  status: string;
  cost_micro_cents: number;
};

/**
 * All requests in the last `sinceHours` window that share `fingerprint`,
 * scoped to the current user. Used by the request detail page to render a
 * loop timeline with the current request highlighted.
 */
export async function getFingerprintNeighbors(
  fingerprint: string,
  sinceHours = 24,
  limit = 500,
  scope?: Scope
): Promise<FingerprintNeighbor[]> {
  return sql<FingerprintNeighbor[]>`
    SELECT id, created_at, status, cost_micro_cents
    FROM requests
    WHERE fingerprint = ${fingerprint}
      AND (${projectScope(scope)})
      AND created_at > NOW() - (${sinceHours} || ' hours')::INTERVAL
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;
}

// Aliased variant for joined queries — matches project_id on the given table alias.
function projectScopeForAlias(scope: Scope, alias: string) {
  if (scope === undefined) return sql`TRUE`;
  if (scope.length === 0) return sql`FALSE`;
  if (alias === "r") return sql`r.project_id = ANY(${scope}::uuid[])`;
  if (alias === "b") return sql`b.project_id = ANY(${scope}::uuid[])`;
  // `projects` table — its primary key IS the project id, not project_id.
  if (alias === "p") return sql`p.id = ANY(${scope}::uuid[])`;
  return sql`project_id = ANY(${scope}::uuid[])`;
}

export type SpendByModel = {
  model: string;
  call_count: number;
  total_cost_micro_cents: number;
};

export const getSpendByModel = cacheStats(
  async (sinceDays = 7, scope?: Scope): Promise<SpendByModel[]> => {
    const rows = await sql<
      { model: string; call_count: number; total_cost_micro_cents: string }[]
    >`
      SELECT model,
             COUNT(*)::int AS call_count,
             COALESCE(SUM(cost_micro_cents), 0)::bigint AS total_cost_micro_cents
      FROM requests
      WHERE (${projectScope(scope)})
        AND created_at > NOW() - (${sinceDays} || ' days')::INTERVAL
      GROUP BY model
      ORDER BY total_cost_micro_cents DESC
    `;
    return rows.map((r) => ({
      model: r.model,
      call_count: r.call_count,
      total_cost_micro_cents: Number(r.total_cost_micro_cents),
    }));
  },
  "getSpendByModel"
);

export const getTotalSpendMicroCents = cacheStats(
  async (sinceDays = 7, scope?: Scope): Promise<number> => {
    const rows = await sql<{ total: string }[]>`
      SELECT COALESCE(SUM(cost_micro_cents), 0)::bigint AS total
      FROM requests
      WHERE (${projectScope(scope)})
        AND created_at > NOW() - (${sinceDays} || ' days')::INTERVAL
    `;
    return Number(rows[0]?.total ?? 0);
  },
  "getTotalSpendMicroCents"
);

// --- Daily time series (for charts + sparklines) ---------------------------

export type DailyStats = {
  day: string; // ISO date yyyy-mm-dd (UTC day boundary, matches DB)
  cost_micro_cents: number;
  call_count: number;
  loop_count: number;
  blocked_count: number;
  routed_count: number;
};

/**
 * Per-day rollup of the last `days` days including empty days (so the chart
 * always has the right number of buckets). Timezone follows the DB — UTC in
 * the default container; revisit when we support user timezones.
 */
export const getDailyStats = cacheStats(
  async (days = 7, scope?: Scope): Promise<DailyStats[]> => {
    // The Postgres-only `generate_series` lets us emit a row per day
    // even when no traffic landed that day. SQLite has no such function
    // (its date-series equivalent is a recursive CTE — different
    // syntax + different result shape). Rather than maintain two
    // dialects, we do the zero-day fill in JavaScript: aggregate
    // by `date(created_at)` (which `DATE_TRUNC('day', col)` translates
    // to under SQLite), then walk the N-day window in JS and stamp
    // zeros for any missing days. Works on both backends, no
    // branching, no recursive CTEs.
    const scopeFilter =
      scope === undefined
        ? sql`TRUE`
        : scope.length === 0
        ? sql`FALSE`
        : sql`r.project_id = ANY(${scope}::uuid[])`;

    const rows = await sql<
      {
        day: Date | string;
        cost_micro_cents: string;
        call_count: number;
        loop_count: number;
        blocked_count: number;
        routed_count: number;
      }[]
    >`
      SELECT
        DATE_TRUNC('day', r.created_at) AS day,
        COALESCE(SUM(r.cost_micro_cents), 0)::bigint AS cost_micro_cents,
        COALESCE(COUNT(r.id), 0)::int AS call_count,
        COALESCE(SUM(CASE WHEN r.status = 'loop_detected' THEN 1 ELSE 0 END), 0)::int
          AS loop_count,
        COALESCE(SUM(CASE WHEN r.status IN ('budget_exceeded', 'plan_limit_exceeded') THEN 1 ELSE 0 END), 0)::int
          AS blocked_count,
        COALESCE(
          SUM(CASE
                WHEN r.original_model IS NOT NULL AND r.original_model <> r.model
                THEN 1 ELSE 0
              END),
          0
        )::int AS routed_count
      FROM requests r
      WHERE r.created_at > NOW() - (${days} || ' days')::INTERVAL
        AND (${scopeFilter})
      GROUP BY DATE_TRUNC('day', r.created_at)
      ORDER BY day ASC
    `;

    // Index the aggregated rows by ISO date string so the JS-side fill
    // is O(1) per day. `new Date(r.day)` handles both Postgres
    // (returns a Date object) and SQLite (returns "YYYY-MM-DD" text
    // from `date(created_at)`).
    const byDay = new Map<
      string,
      Omit<DailyStats, "day">
    >();
    for (const r of rows) {
      const iso = new Date(r.day as string | Date).toISOString().slice(0, 10);
      byDay.set(iso, {
        cost_micro_cents: Number(r.cost_micro_cents),
        call_count: r.call_count,
        loop_count: r.loop_count,
        blocked_count: r.blocked_count,
        routed_count: r.routed_count,
      });
    }

    // Walk the N-day window backward from today (UTC, to match the
    // DB's UTC day boundary) so the bar chart always has exactly
    // `days` buckets. Missing days fill with zeros — same shape the
    // old generate_series LEFT-JOIN path produced.
    const out: DailyStats[] = [];
    const todayUtc = new Date();
    todayUtc.setUTCHours(0, 0, 0, 0);
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(todayUtc);
      d.setUTCDate(d.getUTCDate() - i);
      const iso = d.toISOString().slice(0, 10);
      const found = byDay.get(iso);
      out.push({
        day: iso,
        cost_micro_cents: found?.cost_micro_cents ?? 0,
        call_count: found?.call_count ?? 0,
        loop_count: found?.loop_count ?? 0,
        blocked_count: found?.blocked_count ?? 0,
        routed_count: found?.routed_count ?? 0,
      });
    }
    return out;
  },
  "getDailyStats"
);

// --- Budgets ---------------------------------------------------------------

export type BudgetStatus = {
  project_id: string;
  project_name: string;
  period: "daily" | "monthly";
  limit_micro_cents: number;
  spend_micro_cents: number;
  enabled: boolean;
};

export async function getBudgetStatus(scope?: Scope): Promise<BudgetStatus[]> {
  const rows = await sql<
    {
      project_id: string;
      project_name: string;
      period: "daily" | "monthly";
      limit_micro_cents: number;
      enabled: boolean;
      spend_micro_cents: string;
    }[]
  >`
    SELECT
      b.project_id,
      p.name AS project_name,
      b.period::TEXT AS period,
      b.limit_micro_cents,
      b.enabled,
      COALESCE((
        SELECT SUM(r.cost_micro_cents)::bigint
        FROM requests r
        WHERE r.project_id = b.project_id
          AND r.status = 'success'
          AND r.created_at >= (
            -- "Start of the current period". The Postgres path uses
            -- DATE_TRUNC with a CASE expression for the unit, which my
            -- SQLite shim's regex translator can't rewrite (it expects
            -- a literal 'day' / 'month'). Expanded into a CASE that
            -- picks between two pre-translated patterns — works on
            -- both backends without runtime branching.
            CASE b.period
              WHEN 'daily'
                THEN DATE_TRUNC('day', NOW())
              ELSE DATE_TRUNC('month', NOW())
            END
          )
      ), 0) AS spend_micro_cents
    FROM budgets b
    JOIN projects p ON p.id = b.project_id
    WHERE b.enabled = TRUE
      AND (${projectScopeForAlias(scope, "b")})
    ORDER BY
      CASE b.period WHEN 'daily' THEN 0 ELSE 1 END,
      p.name
  `;
  return rows.map((r) => ({
    project_id: r.project_id,
    project_name: r.project_name,
    period: r.period,
    limit_micro_cents: r.limit_micro_cents,
    enabled: r.enabled,
    spend_micro_cents: Number(r.spend_micro_cents),
  }));
}

// --- Hero-row stats --------------------------------------------------------

export const getBlockedCount = cacheStats(
  async (sinceHours = 24, scope?: Scope): Promise<number> => {
    const rows = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM requests
      WHERE (${projectScope(scope)})
        AND status IN ('budget_exceeded', 'plan_limit_exceeded')
        AND created_at > NOW() - (${sinceHours} || ' hours')::INTERVAL
    `;
    return rows[0]?.count ?? 0;
  },
  "getBlockedCount"
);

/**
 * Plan-tier blocks ONLY (NOT project-budget blocks). Used to surface a
 * targeted "your Free tier cap fired" banner on /, separately from the
 * generic blocked count which lumps both kinds. Distinct from
 * getBlockedCount because the remediation is different: project budgets
 * are user-controlled, plan caps are hosted-tier upgrade prompts.
 */
export const getPlanLimitBlockedCount = cacheStats(
  async (sinceHours = 24, scope?: Scope): Promise<number> => {
    const rows = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM requests
      WHERE (${projectScope(scope)})
        AND status = 'plan_limit_exceeded'
        AND created_at > NOW() - (${sinceHours} || ' hours')::INTERVAL
    `;
    return rows[0]?.count ?? 0;
  },
  "getPlanLimitBlockedCount"
);

export const getCachedInputTokens = cacheStats(
  async (sinceHours = 24, scope?: Scope): Promise<number> => {
    const rows = await sql<{ total: string }[]>`
      SELECT COALESCE(SUM(cached_input_tokens), 0)::bigint AS total
      FROM requests
      WHERE (${projectScope(scope)})
        AND created_at > NOW() - (${sinceHours} || ' hours')::INTERVAL
    `;
    return Number(rows[0]?.total ?? 0);
  },
  "getCachedInputTokens"
);

export const getRoutedCount = cacheStats(
  async (sinceHours = 24, scope?: Scope): Promise<number> => {
    const rows = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM requests
      WHERE (${projectScope(scope)})
        AND original_model IS NOT NULL
        AND original_model <> model
        AND created_at > NOW() - (${sinceHours} || ' hours')::INTERVAL
    `;
    return rows[0]?.count ?? 0;
  },
  "getRoutedCount"
);

export const getLoopCount = cacheStats(
  async (sinceHours = 24, scope?: Scope): Promise<number> => {
    const rows = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM requests
      WHERE (${projectScope(scope)})
        AND status = 'loop_detected'
        AND created_at > NOW() - (${sinceHours} || ' hours')::INTERVAL
    `;
    return rows[0]?.count ?? 0;
  },
  "getLoopCount"
);

// --- Per-project spend context (powers budget UI live previews + forecast) ---

export type ProjectSpendContext = {
  spend_24h_micro_cents: number;
  spend_7d_micro_cents: number;
  spend_30d_micro_cents: number;
  /**
   * Recent burn rate ($/hour) — averaged over the last 4 hours of activity
   * for responsiveness without single-spike instability. 0 when no recent
   * traffic. Used to forecast "you'll hit your daily budget in N hours."
   */
  recent_hourly_burn_micro_cents: number;
  recent_call_count_24h: number;
};

export async function getProjectSpendContext(
  projectId: string
): Promise<ProjectSpendContext> {
  const rows = await sql<
    Array<{
      spend_24h: string;
      spend_7d: string;
      spend_30d: string;
      spend_4h: string;
      hours_with_activity: number;
      calls_24h: number;
    }>
  >`
    SELECT
      COALESCE(SUM(CASE WHEN created_at > NOW() - INTERVAL '24 hours'
                        THEN cost_micro_cents ELSE 0 END), 0)::bigint AS spend_24h,
      COALESCE(SUM(CASE WHEN created_at > NOW() - INTERVAL '7 days'
                        THEN cost_micro_cents ELSE 0 END), 0)::bigint AS spend_7d,
      COALESCE(SUM(CASE WHEN created_at > NOW() - INTERVAL '30 days'
                        THEN cost_micro_cents ELSE 0 END), 0)::bigint AS spend_30d,
      COALESCE(SUM(CASE WHEN created_at > NOW() - INTERVAL '4 hours'
                        THEN cost_micro_cents ELSE 0 END), 0)::bigint AS spend_4h,
      COALESCE(COUNT(DISTINCT DATE_TRUNC('hour', created_at))
               FILTER (WHERE created_at > NOW() - INTERVAL '4 hours'), 0)::int
        AS hours_with_activity,
      COALESCE(COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours'), 0)::int
        AS calls_24h
    FROM requests
    WHERE project_id = ${projectId}
  `;
  const r = rows[0];
  // Burn-rate denominator: how many hours of the last 4 actually saw traffic.
  // 0 hours-of-activity → no recent burn (don't divide by zero, don't infer
  // a forecast from a quiet window).
  const hours = r?.hours_with_activity ?? 0;
  const burn = hours > 0 ? Number(r?.spend_4h ?? 0) / hours : 0;
  return {
    spend_24h_micro_cents: Number(r?.spend_24h ?? 0),
    spend_7d_micro_cents: Number(r?.spend_7d ?? 0),
    spend_30d_micro_cents: Number(r?.spend_30d ?? 0),
    recent_hourly_burn_micro_cents: burn,
    recent_call_count_24h: r?.calls_24h ?? 0,
  };
}

// --- Routing rule "would have matched" preview ----------------------------
//
// Given a regex `from_pattern`, count requests in the last `sinceHours` for
// the project that the pattern would match (regardless of routing/threshold
// — pure model-name match). Lets the routing-rule UI show the user
// "this rule would have matched 47 requests in the last 7 days" before they
// commit. We deliberately don't apply the threshold here because we don't
// have the persisted complexity score per request — the UI shows a separate
// "of those, ~N% are below your threshold" estimate based on last-N samples.

export type RoutingMatchPreview = {
  matched_request_count: number;
  matched_total_cost_micro_cents: number;
  /** Sample of distinct model names that matched, capped at 5. */
  sample_models: string[];
};

export async function previewRoutingMatch(
  projectId: string,
  fromPattern: string,
  sinceHours = 24 * 7
): Promise<RoutingMatchPreview> {
  // Validate regex up front so we don't push garbage into Postgres.
  try {
    // eslint-disable-next-line no-new
    new RegExp(fromPattern);
  } catch {
    return {
      matched_request_count: 0,
      matched_total_cost_micro_cents: 0,
      sample_models: [],
    };
  }
  // Postgres POSIX regex via the ~ operator. We compute ORIGINAL model
  // (the name the user actually requested), so this preview tells the user
  // which historical requests their NEW rule would have rewritten — not
  // which were already rewritten by some other rule.
  const rows = await sql<
    Array<{
      model_used: string;
      cnt: number;
      total_cost: string;
    }>
  >`
    SELECT
      COALESCE(original_model, model) AS model_used,
      COUNT(*)::int AS cnt,
      COALESCE(SUM(cost_micro_cents), 0)::bigint AS total_cost
    FROM requests
    WHERE project_id = ${projectId}
      AND created_at > NOW() - (${sinceHours} || ' hours')::INTERVAL
      AND COALESCE(original_model, model) ~ ${fromPattern}
    GROUP BY COALESCE(original_model, model)
    ORDER BY cnt DESC
    LIMIT 50
  `;
  const matched_request_count = rows.reduce((a, r) => a + r.cnt, 0);
  const matched_total_cost_micro_cents = rows.reduce(
    (a, r) => a + Number(r.total_cost),
    0
  );
  const sample_models = rows.slice(0, 5).map((r) => r.model_used);
  return {
    matched_request_count,
    matched_total_cost_micro_cents,
    sample_models,
  };
}

// --- Recommendations engine (B2) ------------------------------------------
//
// Surfaces concrete, actionable suggestions derived from real request data.
// Each recommendation has:
//   - an evidence sentence (numbers, never adjectives)
//   - a one-click `action` payload that the UI converts into a CTA
//
// The engine is intentionally conservative — every recommendation requires
// a measurable threshold to be met (counts, dollar amounts, ratios) so we
// don't generate noise for users with empty databases.

export type Recommendation =
  | {
      kind: "wasteful_pattern";
      project_id: string;
      project_name: string | null;
      from_model: string;
      to_model: string;
      request_count: number;
      potential_saving_micro_cents: number;
    }
  | {
      kind: "loop_spike";
      project_id: string;
      project_name: string | null;
      loop_count_24h: number;
    }
  | {
      kind: "undersized_budget";
      project_id: string;
      project_name: string | null;
      avg_daily_spend_micro_cents: number;
      current_daily_limit_micro_cents: number;
    }
  | {
      kind: "no_budget_yet";
      project_id: string;
      project_name: string | null;
      spend_7d_micro_cents: number;
    };

export const getRecommendations = cacheStats(
  async (scope?: Scope): Promise<Recommendation[]> => {
  const recs: Recommendation[] = [];
  const ROUTING_TARGET_MODEL = "gpt-4o-mini";
  const MIN_ROUTING_REQUESTS = 20;
  const MIN_ROUTING_SAVING_MICRO_CENTS = 5_000; // $0.05
  const MIN_NO_BUDGET_SPEND_MICRO_CENTS = 100_000; // $1.00

  // ---- 1. Wasteful pattern: short prompts on expensive models -----------
  // Heuristic: requests in the last 7d where short prompts went to a
  // model we know is expensive (cost > $0.0010 / call, ~tier-frontier
  // pricing). The "to" model in the recommendation is fixed at
  // gpt-4o-mini, the safest default downgrade target — UI will let the
  // user adjust if they want.
  //
  // Fires once per (project, expensive-model) pair where count AND potential
  // savings cross meaningful POC thresholds. We deliberately hide same-model
  // and near-zero "save $0.0005" opportunities, but keep $0.05+ signals so a
  // new demo account can still see the product learning from real traffic.
  const wastefulRows = await sql<
    Array<{
      project_id: string;
      project_name: string | null;
      from_model: string;
      request_count: number;
      total_cost_micro_cents: string;
    }>
  >`
    SELECT
      r.project_id,
      MAX(p.name) AS project_name,
      COALESCE(r.original_model, r.model) AS from_model,
      COUNT(*)::int AS request_count,
      COALESCE(SUM(r.cost_micro_cents), 0)::bigint AS total_cost_micro_cents
    FROM requests r
    LEFT JOIN projects p ON p.id = r.project_id
    WHERE (${projectScopeForAlias(scope, "r")})
      AND r.status = 'success'
      AND r.created_at > NOW() - INTERVAL '7 days'
      AND COALESCE(r.original_model, r.model) ~ '^(gpt-4|gpt-5|claude-3-5-sonnet|claude-3-7-sonnet|o1-)'
      AND COALESCE(r.original_model, r.model) <> ${ROUTING_TARGET_MODEL}
      AND r.input_tokens < 200
    GROUP BY r.project_id, COALESCE(r.original_model, r.model)
    HAVING COUNT(*) >= ${MIN_ROUTING_REQUESTS}
       AND COALESCE(SUM(r.cost_micro_cents), 0) * 0.8 >= ${MIN_ROUTING_SAVING_MICRO_CENTS}
    ORDER BY total_cost_micro_cents DESC
    LIMIT 3
  `;
  for (const row of wastefulRows) {
    // Conservative savings: assume we'd save ~80% by routing to gpt-4o-mini.
    // Real ratio depends on model + token mix; 80% is the floor we've seen
    // in public coding-eval and internal route-pair checks.
    const cost = Number(row.total_cost_micro_cents);
    recs.push({
      kind: "wasteful_pattern",
      project_id: row.project_id,
      project_name: row.project_name,
      from_model: row.from_model,
      to_model: ROUTING_TARGET_MODEL,
      request_count: row.request_count,
      potential_saving_micro_cents: Math.round(cost * 0.8),
    });
  }

  // ---- 2. Loop spike: > 20 loop_detected events in last 24h on one project
  const loopSpikes = await sql<
    Array<{
      project_id: string;
      project_name: string | null;
      loop_count: number;
    }>
  >`
    SELECT
      r.project_id,
      MAX(p.name) AS project_name,
      COUNT(*)::int AS loop_count
    FROM requests r
    LEFT JOIN projects p ON p.id = r.project_id
    WHERE (${projectScopeForAlias(scope, "r")})
      AND r.status = 'loop_detected'
      AND r.created_at > NOW() - INTERVAL '24 hours'
    GROUP BY r.project_id
    HAVING COUNT(*) >= 20
    ORDER BY loop_count DESC
    LIMIT 3
  `;
  for (const row of loopSpikes) {
    recs.push({
      kind: "loop_spike",
      project_id: row.project_id,
      project_name: row.project_name,
      loop_count_24h: row.loop_count,
    });
  }

  // ---- 3. Undersized budget: 7d avg daily spend > current daily limit ----
  // Surfaced when there's an enabled daily budget AND the rolling 7d
  // average daily spend exceeds it (so the user is hitting the cap
  // routinely). We DO NOT recommend if there's no budget — that's a
  // separate "no_budget_yet" case below.
  const undersized = await sql<
    Array<{
      project_id: string;
      project_name: string | null;
      avg_daily_spend: string;
      limit_micro_cents: string;
    }>
  >`
    SELECT
      b.project_id,
      MAX(p.name) AS project_name,
      COALESCE(SUM(r.cost_micro_cents) / 7.0, 0)::bigint AS avg_daily_spend,
      MAX(b.limit_micro_cents)::bigint AS limit_micro_cents
    FROM budgets b
    JOIN projects p ON p.id = b.project_id
    LEFT JOIN requests r
      ON r.project_id = b.project_id
      AND r.created_at > NOW() - INTERVAL '7 days'
    WHERE b.period = 'daily'
      AND b.enabled = TRUE
      AND (${projectScopeForAlias(scope, "p")})
    GROUP BY b.project_id
    HAVING COALESCE(SUM(r.cost_micro_cents) / 7.0, 0) > MAX(b.limit_micro_cents)
    LIMIT 3
  `;
  for (const row of undersized) {
    recs.push({
      kind: "undersized_budget",
      project_id: row.project_id,
      project_name: row.project_name,
      avg_daily_spend_micro_cents: Number(row.avg_daily_spend),
      current_daily_limit_micro_cents: Number(row.limit_micro_cents),
    });
  }

  // ---- 4. No budget yet but real traffic happening ---------------------
  // Counter to the home-page CTA which is project-agnostic; this rec
  // surfaces a SPECIFIC project that's spending without protection.
  const noBudget = await sql<
    Array<{
      project_id: string;
      project_name: string | null;
      spend_7d: string;
    }>
  >`
    SELECT
      p.id AS project_id,
      p.name AS project_name,
      COALESCE(SUM(r.cost_micro_cents), 0)::bigint AS spend_7d
    FROM projects p
    LEFT JOIN requests r
      ON r.project_id = p.id
      AND r.created_at > NOW() - INTERVAL '7 days'
    LEFT JOIN budgets b ON b.project_id = p.id AND b.enabled = TRUE
    WHERE (${projectScopeForAlias(scope, "p")})
      AND b.id IS NULL
    GROUP BY p.id, p.name
    HAVING COALESCE(SUM(r.cost_micro_cents), 0) >= ${MIN_NO_BUDGET_SPEND_MICRO_CENTS}
    ORDER BY spend_7d DESC
    LIMIT 3
  `;
  for (const row of noBudget) {
    recs.push({
      kind: "no_budget_yet",
      project_id: row.project_id,
      project_name: row.project_name,
      spend_7d_micro_cents: Number(row.spend_7d),
    });
  }

  const priority: Record<Recommendation["kind"], number> = {
    loop_spike: 0,
    undersized_budget: 1,
    no_budget_yet: 2,
    wasteful_pattern: 3,
  };
  return recs
    .sort((a, b) => {
      const p = priority[a.kind] - priority[b.kind];
      if (p !== 0) return p;
      const av =
        a.kind === "wasteful_pattern"
          ? a.potential_saving_micro_cents
          : a.kind === "no_budget_yet"
            ? a.spend_7d_micro_cents
            : a.kind === "loop_spike"
              ? a.loop_count_24h
              : a.avg_daily_spend_micro_cents - a.current_daily_limit_micro_cents;
      const bv =
        b.kind === "wasteful_pattern"
          ? b.potential_saving_micro_cents
          : b.kind === "no_budget_yet"
            ? b.spend_7d_micro_cents
            : b.kind === "loop_spike"
              ? b.loop_count_24h
              : b.avg_daily_spend_micro_cents - b.current_daily_limit_micro_cents;
      return bv - av;
    })
    .slice(0, 3);
  },
  "getRecommendations",
  60
);

// --- Cache savings ---------------------------------------------------------

export const getCacheSavingsMicroCents = cacheStats(
  async (sinceHours = 24, scope?: Scope): Promise<number> => {
    const rows = await sql<{ total: string }[]>`
      SELECT COALESCE(SUM(cache_savings_micro_cents), 0)::bigint AS total
      FROM requests
      WHERE (${projectScope(scope)})
        AND created_at > NOW() - (${sinceHours} || ' hours')::INTERVAL
    `;
    return Number(rows[0]?.total ?? 0);
  },
  "getCacheSavingsMicroCents"
);

// --- Unified savings breakdown (routing + cache + tool-compress) ---------
//
// The "saved $X" hero on the dashboard home. Combines THREE distinct
// dimensions of dollars-actually-not-spent:
//
//   1. routing_saving_micro_cents — the request was downgraded to a
//      cheaper model than the caller asked for; what it would have
//      cost on the asked-model minus what it actually cost.
//   2. cache_savings_micro_cents — provider-side prompt-cache hits
//      (anthropic ephemeral / OpenAI cached_tokens) that got billed
//      at the cached rate vs the full input rate.
//   3. tool_compress_micro_cents_saved_est — input tokens stripped
//      from `tool` / `function` messages before forwarding upstream
//      (TOKENSMART_TOOL_COMPRESS_ENABLED=1). Read from the `tags`
//      JSONB column because it doesn't have a dedicated requests
//      column — the compressor stamps it as a tag-string and we
//      coerce back to bigint here.
//
// Loop-prevented and budget-blocked counts are NOT folded into the
// dollar total because those are counterfactual: we never called
// upstream so we don't actually know what would have been spent.
// Shown separately as counts.

export type SavingsBreakdown = {
  total_saving_micro_cents: number;
  routing_saving_micro_cents: number;
  cache_saving_micro_cents: number;
  /**
   * Estimated dollar value of input tokens stripped by the tool-result
   * compressor (TOKENSMART_TOOL_COMPRESS_ENABLED). Zero when the
   * compressor is off or no eligible tool messages were seen in the
   * window. The estimate is conservative — see the compressor module
   * for the chars/token ratio used.
   */
  tool_compress_saving_micro_cents: number;
  /** Total spend over the same window — lets the UI show "saved X of Y total". */
  total_spend_micro_cents: number;
  /** Requests that got downgraded to a cheaper model. */
  routing_request_count: number;
  /** Requests with at least one cached input token. */
  cache_hit_count: number;
  /** Requests where the compressor rewrote at least one tool message. */
  tool_compress_request_count: number;
  /** Blocked-before-upstream, counted separately (not in dollar total). */
  loops_prevented_count: number;
  budget_blocked_count: number;
};

export const getSavingsBreakdown = cacheStats(
  async (sinceHours = 168, scope?: Scope): Promise<SavingsBreakdown> => {
    const rows = await sql<
      Array<{
        routing_saving: string;
        cache_saving: string;
        tool_compress_saving: string;
        total_spend: string;
        routing_request_count: number;
        cache_hit_count: number;
        tool_compress_request_count: number;
        loops_prevented_count: number;
        budget_blocked_count: number;
      }>
    >`
      SELECT
        COALESCE(SUM(routing_saving_micro_cents), 0)::bigint AS routing_saving,
        COALESCE(SUM(cache_savings_micro_cents), 0)::bigint AS cache_saving,
        -- Tool-result compressor savings live in the JSONB tags column
        -- because they don't have a dedicated numeric column. The cast
        -- chain (text -> bigint) silently drops any malformed value
        -- and we COALESCE the row-level sum so a single bad row never
        -- nukes the breakdown card. NULLIF guards the empty-string
        -- case where the tag was set to "" by a future caller.
        COALESCE(
          SUM(
            CASE
              WHEN tags ? 'tool_compress_micro_cents_saved_est'
                THEN COALESCE(
                  NULLIF(tags->>'tool_compress_micro_cents_saved_est', '')::bigint,
                  0
                )
              ELSE 0
            END
          ),
          0
        )::bigint AS tool_compress_saving,
        COALESCE(SUM(cost_micro_cents), 0)::bigint AS total_spend,
        COALESCE(SUM(CASE WHEN routing_saving_micro_cents > 0 THEN 1 ELSE 0 END), 0)::int
          AS routing_request_count,
        COALESCE(SUM(CASE WHEN cached_input_tokens > 0 THEN 1 ELSE 0 END), 0)::int
          AS cache_hit_count,
        COALESCE(SUM(CASE WHEN tags->>'tool_compress_applied' = '1' THEN 1 ELSE 0 END), 0)::int
          AS tool_compress_request_count,
        COALESCE(SUM(CASE WHEN status = 'loop_detected' THEN 1 ELSE 0 END), 0)::int
          AS loops_prevented_count,
        COALESCE(SUM(CASE WHEN status IN ('budget_exceeded', 'plan_limit_exceeded') THEN 1 ELSE 0 END), 0)::int
          AS budget_blocked_count
      FROM requests
      WHERE (${projectScope(scope)})
        AND created_at > NOW() - (${sinceHours} || ' hours')::INTERVAL
    `;

    const row = rows[0];
    const routing = Number(row?.routing_saving ?? 0);
    const cache = Number(row?.cache_saving ?? 0);
    const toolCompress = Number(row?.tool_compress_saving ?? 0);
    return {
      total_saving_micro_cents: routing + cache + toolCompress,
      routing_saving_micro_cents: routing,
      cache_saving_micro_cents: cache,
      tool_compress_saving_micro_cents: toolCompress,
      total_spend_micro_cents: Number(row?.total_spend ?? 0),
      routing_request_count: row?.routing_request_count ?? 0,
      cache_hit_count: row?.cache_hit_count ?? 0,
      tool_compress_request_count: row?.tool_compress_request_count ?? 0,
      loops_prevented_count: row?.loops_prevented_count ?? 0,
      budget_blocked_count: row?.budget_blocked_count ?? 0,
    };
  },
  "getSavingsBreakdown"
);

// --- Public aggregate proof -------------------------------------------------
//
// Public marketing proof is intentionally privacy-thresholded. It combines:
//   1. Hosted traffic in `requests` for user/org-owned projects.
//   2. Explicitly opt-in self-host daily aggregates in
//      `anonymous_telemetry_daily`.
//
// It never reads prompts/responses and never returns per-customer rows. If the
// DB is missing the telemetry table (older self-host) or the thresholds are not
// met, callers get a conservative "warming up" state instead of an error.

export type PublicAggregateProof = {
  visible: boolean;
  /** 0 means all-time; kept numeric for simple serialization. */
  window_days: number;
  total_saving_micro_cents: number;
  routing_saving_micro_cents: number;
  cache_saving_micro_cents: number;
  request_count: number;
  routed_request_count: number;
  loops_blocked_count: number;
  participant_count: number;
  hosted_project_count: number;
  self_host_deployment_count: number;
  thresholds: {
    min_participants: number;
    min_requests: number;
    min_routed_requests: number;
  };
};

const PUBLIC_PROOF_MIN_PARTICIPANTS = 5;
const PUBLIC_PROOF_MIN_REQUESTS = 1_000;
const PUBLIC_PROOF_MIN_ROUTED_REQUESTS = 100;

type PublicProofHostedRow = {
  request_count: number | string | null;
  routed_request_count: number | string | null;
  loops_blocked_count: number | string | null;
  routing_saving_micro_cents: number | string | null;
  cache_saving_micro_cents: number | string | null;
  hosted_project_count: number | string | null;
  participant_count: number | string | null;
};

type PublicProofTelemetryRow = {
  request_count: number | string | null;
  routed_request_count: number | string | null;
  loops_blocked_count: number | string | null;
  routing_saving_micro_cents: number | string | null;
  cache_saving_micro_cents: number | string | null;
  deployment_count: number | string | null;
};

function publicProofNumber(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const out = Number(v);
  return Number.isFinite(out) ? out : 0;
}

const emptyPublicAggregateProof = (): PublicAggregateProof => ({
  visible: false,
  window_days: 0,
  total_saving_micro_cents: 0,
  routing_saving_micro_cents: 0,
  cache_saving_micro_cents: 0,
  request_count: 0,
  routed_request_count: 0,
  loops_blocked_count: 0,
  participant_count: 0,
  hosted_project_count: 0,
  self_host_deployment_count: 0,
  thresholds: {
    min_participants: PUBLIC_PROOF_MIN_PARTICIPANTS,
    min_requests: PUBLIC_PROOF_MIN_REQUESTS,
    min_routed_requests: PUBLIC_PROOF_MIN_ROUTED_REQUESTS,
  },
});

export const getPublicAggregateProof = cacheStats(
  async (): Promise<PublicAggregateProof> => {
    try {
      const hostedRows = await sql<PublicProofHostedRow[]>`
        SELECT
          COUNT(*)::int AS request_count,
          COUNT(*) FILTER (
            WHERE r.original_model IS NOT NULL AND r.original_model <> r.model
          )::int AS routed_request_count,
          COUNT(*) FILTER (WHERE r.status = 'loop_detected')::int
            AS loops_blocked_count,
          COALESCE(SUM(r.routing_saving_micro_cents), 0)::bigint
            AS routing_saving_micro_cents,
          COALESCE(SUM(r.cache_savings_micro_cents), 0)::bigint
            AS cache_saving_micro_cents,
          COUNT(DISTINCT r.project_id)::int AS hosted_project_count,
          COUNT(DISTINCT COALESCE(
            p.organization_id::text,
            p.user_id::text
          ))::int AS participant_count
        FROM requests r
        JOIN projects p ON p.id = r.project_id
        WHERE p.user_id IS NOT NULL OR p.organization_id IS NOT NULL
      `;

      const telemetryRows = await sql<PublicProofTelemetryRow[]>`
        SELECT
          COALESCE(SUM(request_count), 0)::bigint AS request_count,
          COALESCE(SUM(routed_request_count), 0)::bigint AS routed_request_count,
          COALESCE(SUM(loops_blocked_count), 0)::bigint AS loops_blocked_count,
          COALESCE(SUM(routing_saving_micro_cents), 0)::bigint
            AS routing_saving_micro_cents,
          COALESCE(SUM(cache_saving_micro_cents), 0)::bigint
            AS cache_saving_micro_cents,
          COUNT(DISTINCT deployment_hash)::int AS deployment_count
        FROM anonymous_telemetry_daily
      `;

      const hosted = hostedRows[0];
      const telemetry = telemetryRows[0];
      const routingSaving =
        publicProofNumber(hosted?.routing_saving_micro_cents) +
        publicProofNumber(telemetry?.routing_saving_micro_cents);
      const cacheSaving =
        publicProofNumber(hosted?.cache_saving_micro_cents) +
        publicProofNumber(telemetry?.cache_saving_micro_cents);
      const requestCount =
        publicProofNumber(hosted?.request_count) +
        publicProofNumber(telemetry?.request_count);
      const routedRequestCount =
        publicProofNumber(hosted?.routed_request_count) +
        publicProofNumber(telemetry?.routed_request_count);
      const loopsBlockedCount =
        publicProofNumber(hosted?.loops_blocked_count) +
        publicProofNumber(telemetry?.loops_blocked_count);
      const selfHostDeploymentCount = publicProofNumber(telemetry?.deployment_count);
      const hostedProjectCount = publicProofNumber(hosted?.hosted_project_count);
      const participantCount =
        publicProofNumber(hosted?.participant_count) + selfHostDeploymentCount;
      const totalSaving = routingSaving + cacheSaving;

      return {
        visible:
          participantCount >= PUBLIC_PROOF_MIN_PARTICIPANTS &&
          requestCount >= PUBLIC_PROOF_MIN_REQUESTS &&
          routedRequestCount >= PUBLIC_PROOF_MIN_ROUTED_REQUESTS &&
          totalSaving > 0,
        window_days: 0,
        total_saving_micro_cents: totalSaving,
        routing_saving_micro_cents: routingSaving,
        cache_saving_micro_cents: cacheSaving,
        request_count: requestCount,
        routed_request_count: routedRequestCount,
        loops_blocked_count: loopsBlockedCount,
        participant_count: participantCount,
        hosted_project_count: hostedProjectCount,
        self_host_deployment_count: selfHostDeploymentCount,
        thresholds: emptyPublicAggregateProof().thresholds,
      };
    } catch (err) {
      console.warn(
        "[public-proof] aggregate proof unavailable:",
        err instanceof Error ? err.message : String(err)
      );
      return emptyPublicAggregateProof();
    }
  },
  "getPublicAggregateProof",
  300
);

// --- Weekly digest helpers (used by scripts/send-weekly-savings.ts) -------

export type DigestRecipient = {
  user_id: string;
  email: string;
  name: string | null;
  /** uuid[] of projects this user owns. May be empty (skip the digest). */
  project_ids: string[];
  /** Preferred locale for email body. NULL = use DEFAULT_LOCALE. */
  preferred_locale: string | null;
};

/**
 * All OPT-IN hosted users with at least one project. Filters by
 * `weekly_digest_enabled = TRUE` so cold-emailing every signed-up user
 * (CAN-SPAM / GDPR violation) doesn't happen accidentally.
 *
 * Migration 008 adds the `weekly_digest_enabled` column. On legacy DBs
 * without the column applied the WHERE clause would error — auto-migrate
 * at gateway boot makes this safe in practice (Postgres applies migration
 * 008 before the dashboard query path can fire).
 *
 * `preferred_locale` (migration 033) is selected with `COALESCE(... , NULL)`
 * inside the query so the row reads cleanly even on installs that haven't
 * applied 033 yet — Postgres errors with "column does not exist" otherwise,
 * and we don't want a bookkeeping migration to break the cron.
 */
export async function listDigestRecipients(): Promise<DigestRecipient[]> {
  // Belt-and-suspenders for installs that haven't applied migration 033 yet:
  // the column exists everywhere we run today, but a self-host operator on
  // a stale DB would otherwise see this query crash. Catch the missing-
  // column error once and fall back to NULL preferred_locale for everyone.
  try {
    const rows = await sql<
      Array<{
        user_id: string;
        email: string;
        name: string | null;
        project_ids: string[];
        preferred_locale: string | null;
      }>
    >`
      SELECT u.id AS user_id,
             u.email,
             u.name,
             u.preferred_locale,
             COALESCE(ARRAY_AGG(p.id) FILTER (WHERE p.id IS NOT NULL), '{}'::uuid[]) AS project_ids
        FROM users u
        LEFT JOIN projects p ON p.user_id = u.id
       WHERE u.weekly_digest_enabled = TRUE
       GROUP BY u.id, u.email, u.name, u.preferred_locale
      HAVING COUNT(p.id) > 0
       ORDER BY u.created_at ASC
    `;
    return rows.map((r) => ({
      user_id: r.user_id,
      email: r.email,
      name: r.name,
      project_ids: r.project_ids ?? [],
      preferred_locale: r.preferred_locale,
    }));
  } catch (err) {
    // If `preferred_locale` is missing (migration 033 not applied), fall
    // back to the schema-007 query and pretend everyone is on the default.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/preferred_locale/i.test(msg)) throw err;
    console.warn(
      "[db] users.preferred_locale missing — apply migration 033 to enable per-user email locale; falling back to default."
    );
    const rows = await sql<
      Array<{
        user_id: string;
        email: string;
        name: string | null;
        project_ids: string[];
      }>
    >`
      SELECT u.id AS user_id,
             u.email,
             u.name,
             COALESCE(ARRAY_AGG(p.id) FILTER (WHERE p.id IS NOT NULL), '{}'::uuid[]) AS project_ids
        FROM users u
        LEFT JOIN projects p ON p.user_id = u.id
       WHERE u.weekly_digest_enabled = TRUE
       GROUP BY u.id, u.email, u.name
      HAVING COUNT(p.id) > 0
       ORDER BY u.created_at ASC
    `;
    return rows.map((r) => ({
      user_id: r.user_id,
      email: r.email,
      name: r.name,
      project_ids: r.project_ids ?? [],
      preferred_locale: null,
    }));
  }
}

/**
 * Persist a user's preferred email locale. Called whenever the
 * `<LanguageToggle>` server action fires for a logged-in user, so the
 * cron-driven email path picks the same language as their browser.
 *
 * Same migration-033 fallback as `listDigestRecipients` — silently no-op
 * if the column hasn't landed yet.
 */
export async function setUserPreferredLocale(
  userId: string,
  locale: string
): Promise<void> {
  try {
    await sql`
      UPDATE users
         SET preferred_locale = ${locale}
       WHERE id = ${userId}
    `;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/preferred_locale/i.test(msg)) throw err;
    // Migration 033 not yet applied — silent no-op so users can still
    // switch the cookie even on stale schemas.
  }
}

/** Read a single user's preferred locale (used by `sendInviteEmail`). */
export async function getUserPreferredLocale(
  userId: string
): Promise<string | null> {
  try {
    const rows = await sql<{ preferred_locale: string | null }[]>`
      SELECT preferred_locale FROM users WHERE id = ${userId} LIMIT 1
    `;
    return rows[0]?.preferred_locale ?? null;
  } catch {
    // Either the user doesn't exist or migration 033 isn't applied —
    // either way `null` (fall back to default locale) is correct.
    return null;
  }
}

/**
 * Stamp `weekly_digest_last_sent_at = NOW()` on a user. Called by the
 * cron sender after a successful send so the dashboard can show
 * "last sent X ago".
 */
export async function markWeeklyDigestSent(userId: string): Promise<void> {
  await sql`
    UPDATE users
       SET weekly_digest_last_sent_at = NOW()
     WHERE id = ${userId}
  `;
}

export type WeeklyDigestPrefs = {
  enabled: boolean;
  last_sent_at: Date | null;
};

/**
 * Read the current user's digest opt-in state for the /settings toggle.
 */
export async function getWeeklyDigestPrefs(
  userId: string
): Promise<WeeklyDigestPrefs> {
  const rows = await sql<
    { weekly_digest_enabled: boolean; weekly_digest_last_sent_at: Date | null }[]
  >`
    SELECT weekly_digest_enabled, weekly_digest_last_sent_at
      FROM users
     WHERE id = ${userId}
     LIMIT 1
  `;
  const r = rows[0];
  return {
    enabled: r?.weekly_digest_enabled ?? false,
    last_sent_at: r?.weekly_digest_last_sent_at ?? null,
  };
}

/**
 * Set the user's digest opt-in flag. Returns the new state for echo-back.
 */
export async function setWeeklyDigestEnabled(
  userId: string,
  enabled: boolean
): Promise<void> {
  await sql`
    UPDATE users
       SET weekly_digest_enabled = ${enabled}
     WHERE id = ${userId}
  `;
}

export type TopRoutedPair = {
  from_model: string;
  to_model: string;
  request_count: number;
  saved_micro_cents: number;
};

/**
 * Top (original_model → model) pairs by routing savings over the window.
 * Drives the "Top routed pairs" section of the weekly digest email.
 *
 * Filters: only rows where routing actually fired (`original_model IS NOT NULL`
 * AND `original_model <> model`) AND where it saved nonzero micro_cents
 * (skips degenerate rows where the routed model happened to cost the same).
 */
export const getTopRoutedPairs = cacheStats(
  async (
    sinceHours = 168,
    limit = 5,
    scope?: Scope
  ): Promise<TopRoutedPair[]> => {
    const rows = await sql<
      Array<{
        from_model: string;
        to_model: string;
        request_count: number;
        saved: string;
      }>
    >`
      SELECT
        original_model AS from_model,
        model          AS to_model,
        COUNT(*)::int  AS request_count,
        COALESCE(SUM(routing_saving_micro_cents), 0)::bigint AS saved
      FROM requests
      WHERE original_model IS NOT NULL
        AND original_model <> model
        AND routing_saving_micro_cents > 0
        AND (${projectScope(scope)})
        AND created_at > NOW() - (${sinceHours} || ' hours')::INTERVAL
      GROUP BY original_model, model
      ORDER BY saved DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      from_model: r.from_model,
      to_model: r.to_model,
      request_count: r.request_count,
      saved_micro_cents: Number(r.saved),
    }));
  },
  "getTopRoutedPairs"
);

// --- A/B shadow results ----------------------------------------------------

export type AbExperimentSummary = {
  primary_model: string;
  shadow_model: string;
  trials: number;
  primary_total_micro_cents: number;
  shadow_total_micro_cents: number;
  // Positive = primary cost > shadow cost = shadow is cheaper.
  delta_micro_cents: number;
  shadow_errors: number;
  primary_avg_latency_ms: number | null;
  shadow_avg_latency_ms: number | null;
};

export const getAbExperimentSummary = cacheStats(
  async (sinceHours = 168, scope?: Scope): Promise<AbExperimentSummary[]> => {
    const rows = await sql<
      {
        primary_model: string;
        shadow_model: string;
        trials: number;
        primary_total: string;
        shadow_total: string;
        shadow_errors: number;
        primary_avg_latency: number | null;
        shadow_avg_latency: number | null;
      }[]
    >`
      SELECT
        primary_model,
        shadow_model,
        COUNT(*)::int AS trials,
        COALESCE(SUM(primary_cost_micro_cents), 0)::bigint AS primary_total,
        COALESCE(SUM(shadow_cost_micro_cents), 0)::bigint AS shadow_total,
        SUM(CASE WHEN shadow_status <> 'success' THEN 1 ELSE 0 END)::int AS shadow_errors,
        AVG(NULLIF(primary_latency_ms, 0))::int AS primary_avg_latency,
        AVG(NULLIF(shadow_latency_ms, 0))::int AS shadow_avg_latency
      FROM ab_results
      WHERE (${projectScope(scope)})
        AND created_at > NOW() - (${sinceHours} || ' hours')::INTERVAL
      GROUP BY primary_model, shadow_model
      ORDER BY trials DESC
      LIMIT 20
    `;
    return rows.map((r) => {
      const primaryTotal = Number(r.primary_total);
      const shadowTotal = Number(r.shadow_total);
      return {
        primary_model: r.primary_model,
        shadow_model: r.shadow_model,
        trials: r.trials,
        primary_total_micro_cents: primaryTotal,
        shadow_total_micro_cents: shadowTotal,
        delta_micro_cents: primaryTotal - shadowTotal,
        shadow_errors: r.shadow_errors,
        primary_avg_latency_ms: r.primary_avg_latency,
        shadow_avg_latency_ms: r.shadow_avg_latency,
      };
    });
  },
  "getAbExperimentSummary",
  60
);

// --- Quality proof (shadow A/B → did the cheap model actually work?) -----

export type QualityProofSummary = {
  /**
   * Total shadow-routed trials over the window.
   */
  total_trials: number;
  /**
   * Trials where the shadow call returned 2xx — the cheaper model produced
   * a response without erroring out.
   */
  shadow_success: number;
  /**
   * Trials where the cheaper model finished faster than the primary
   * (shadow_latency < primary_latency). Latency parity is rough quality
   * signal, but for chat/code workloads >50% faster on a cheap model is
   * a strong "you should switch" hint.
   */
  shadow_faster: number;
  /**
   * Aggregate cost difference: positive = shadow cheaper than primary.
   * Useful for the "saved $X had you used shadow" framing.
   */
  delta_micro_cents: number;
  /**
   * Distinct (primary, shadow) model pairings tested.
   */
  experiment_count: number;
  /**
   * Trials with a computed similarity score — the embedding-based quality
   * signal. Null on rows where embedding was disabled or failed.
   */
  trials_with_similarity: number;
  /**
   * Mean cosine similarity between primary and shadow responses for trials
   * that have one. Range [0,1]. Null when no trials have similarity yet.
   * - 0.95+ : almost certainly equivalent
   * - 0.85-0.95 : same answer worded differently
   * - 0.70-0.85 : same topic, different conclusion
   * - <0.70 : meaningfully different output
   */
  avg_similarity: number | null;
  /**
   * Trials where similarity >= 0.85 — "good enough to switch" signal.
   */
  high_similarity_count: number;
};

/**
 * Single-card summary across all A/B shadow experiments. Used by the
 * "Quality proof" card on the dashboard home — answers the question
 * customers always have but rarely ask explicitly: "is the cheaper
 * model actually working, or is it secretly producing garbage?"
 *
 * Note: shadow status is a coarse signal — a 2xx response doesn't mean
 * the *content* was good, just that the model didn't crash. The next
 * iteration will add embedding-similarity comparison between primary
 * and shadow responses for a real quality score.
 */
export const getQualityProofSummary = cacheStats(
  async (
    sinceHours = 168,
    scope?: Scope
  ): Promise<QualityProofSummary> => {
    const rows = await sql<
      {
        total_trials: number;
        shadow_success: number;
        shadow_faster: number;
        delta: string;
        experiment_count: number;
        trials_with_similarity: number;
        avg_similarity: number | null;
        high_similarity_count: number;
      }[]
    >`
      SELECT
        COUNT(*)::int AS total_trials,
        SUM(CASE WHEN shadow_status = 'success' THEN 1 ELSE 0 END)::int
          AS shadow_success,
        SUM(
          CASE WHEN shadow_latency_ms IS NOT NULL
                AND primary_latency_ms IS NOT NULL
                AND shadow_latency_ms < primary_latency_ms
               THEN 1 ELSE 0 END
        )::int AS shadow_faster,
        COALESCE(
          SUM(primary_cost_micro_cents - shadow_cost_micro_cents),
          0
        )::bigint AS delta,
        COUNT(DISTINCT (primary_model || '::' || shadow_model))::int AS experiment_count,
        COUNT(similarity)::int AS trials_with_similarity,
        AVG(similarity)::real AS avg_similarity,
        SUM(CASE WHEN similarity IS NOT NULL AND similarity >= 0.85 THEN 1 ELSE 0 END)::int
          AS high_similarity_count
      FROM ab_results
      WHERE (${projectScope(scope)})
        AND created_at > NOW() - (${sinceHours} || ' hours')::INTERVAL
    `;
    const r = rows[0] ?? {
      total_trials: 0,
      shadow_success: 0,
      shadow_faster: 0,
      delta: "0",
      experiment_count: 0,
      trials_with_similarity: 0,
      avg_similarity: null,
      high_similarity_count: 0,
    };
    return {
      total_trials: r.total_trials,
      shadow_success: r.shadow_success,
      shadow_faster: r.shadow_faster,
      delta_micro_cents: Number(r.delta),
      experiment_count: r.experiment_count,
      trials_with_similarity: r.trials_with_similarity,
      avg_similarity:
        r.avg_similarity != null ? Number(r.avg_similarity) : null,
      high_similarity_count: r.high_similarity_count,
    };
  },
  "getQualityProofSummary",
  60
);

// --- Spend by tag (cost attribution from x-ts-tag header) -----------------

export type SpendByTag = {
  /** e.g. "feature" */
  tag_key: string;
  /** e.g. "summarization" */
  tag_value: string;
  call_count: number;
  total_cost_micro_cents: number;
};

/**
 * Per-(tag_key, tag_value) spend rollup over the last `sinceDays` days.
 * Powers the "Spend by tag" card on the dashboard home.
 *
 * Implementation note: we expand the JSONB `tags` object via
 * `jsonb_each_text` so each request contributes one row per tag. A request
 * with `{feature: "x", team: "y"}` shows up under both `feature=x` and
 * `team=y` — the totals across the table won't sum to total spend, by design
 * (a request is multi-tagged). The card explains this in its subtitle.
 *
 * Skips the empty-tags case via the `WHERE tags <> '{}'::jsonb` filter so
 * Postgres can use the partial GIN index from migration 006.
 */
export const getSpendByTag = cacheStats(
  async (
    sinceDays = 7,
    limit = 30,
    scope?: Scope
  ): Promise<SpendByTag[]> => {
    // Postgres can fan out tags with `CROSS JOIN LATERAL
    // jsonb_each_text(r.tags) kv`. SQLite's JSON1 extension has
    // an equivalent table-valued function `json_each(r.tags)` whose
    // syntax is `... FROM requests r, json_each(r.tags) kv ...` —
    // structurally different enough that a regex translator can't
    // bridge it. Branch on the active backend instead.
    if (activeBackend() === "sqlite") {
      const rows = await sql<
        {
          tag_key: string;
          tag_value: string;
          call_count: number;
          total_cost_micro_cents: string;
        }[]
      >`
        SELECT
          kv.key   AS tag_key,
          kv.value AS tag_value,
          COUNT(*) AS call_count,
          COALESCE(SUM(r.cost_micro_cents), 0) AS total_cost_micro_cents
        FROM requests r, json_each(r.tags) kv
        WHERE r.tags <> '{}'
          AND (${projectScope(scope)})
          AND r.created_at > NOW() - (${sinceDays} || ' days')::INTERVAL
        GROUP BY kv.key, kv.value
        ORDER BY total_cost_micro_cents DESC
        LIMIT ${limit}
      `;
      return rows.map((r) => ({
        tag_key: r.tag_key,
        tag_value: String(r.tag_value),
        call_count: Number(r.call_count),
        total_cost_micro_cents: Number(r.total_cost_micro_cents),
      }));
    }
    const rows = await sql<
      {
        tag_key: string;
        tag_value: string;
        call_count: number;
        total_cost_micro_cents: string;
      }[]
    >`
      SELECT
        kv.key   AS tag_key,
        kv.value AS tag_value,
        COUNT(*)::int AS call_count,
        COALESCE(SUM(r.cost_micro_cents), 0)::bigint AS total_cost_micro_cents
      FROM requests r
      CROSS JOIN LATERAL jsonb_each_text(r.tags) kv
      WHERE r.tags <> '{}'::jsonb
        AND (${projectScope(scope)})
        AND r.created_at > NOW() - (${sinceDays} || ' days')::INTERVAL
      GROUP BY kv.key, kv.value
      ORDER BY total_cost_micro_cents DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      tag_key: r.tag_key,
      tag_value: r.tag_value,
      call_count: r.call_count,
      total_cost_micro_cents: Number(r.total_cost_micro_cents),
    }));
  },
  "getSpendByTag",
  60
);

// --- Agent session aggregation --------------------------------------------
//
// "Agent session" = the unit of grouping that long-running agents
// (OpenClaw, AutoGPT-style loops, LangGraph multi-step pipelines)
// actually want to see in a dashboard. Two well-known tags carry the
// dimensions:
//
//   tags->>'agent'    — which agent binary made the call ("openclaw")
//   tags->>'session'  — caller-defined session/conversation id
//   tags->>'turn'     — caller-defined turn id within the session
//
// The gateway promotes the request headers `x-ts-agent`, `x-ts-session`,
// `x-ts-turn` into these tag keys verbatim (see apps/gateway/src/tags.ts).
// We query against the JSONB column directly so callers don't need a
// new table.

export type AgentSessionSummary = {
  agent: string;
  session: string;
  turn_count: number;
  request_count: number;
  total_cost_micro_cents: number;
  total_input_tokens: number;
  total_output_tokens: number;
  /** Requests whose body declared `tools: [...]` (tool-capable turns). */
  tool_capable_count: number;
  /** Requests where the gateway observed a tool call in the model response. */
  tool_call_observed_count: number;
  error_count: number;
  loop_blocked_count: number;
  budget_blocked_count: number;
  /** Hosted plan-tier cap (Free / Pro / Team daily-spend or monthly-request). */
  plan_blocked_count: number;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  first_seen_at: Date;
  last_seen_at: Date;
};

/**
 * Per-(agent, session) rollup over the last `sinceDays` days, sorted by
 * recency by default. The query intentionally only considers rows that
 * carry BOTH `agent` and `session` in their `tags` JSONB — partial
 * tagging would produce noisy buckets like (NULL, "s_42") and confuse
 * the operator more than help them.
 *
 * `tool_capable_count` reads the gateway-stamped `tools_declared_count`
 * tag (with a legacy fallback to request_body->'tools'). Actual tool-call
 * observation reads `tool_calls_observed`; streaming responses only mark
 * that a tool-call finish reason happened, not the arguments.
 */
export async function getAgentSessions(
  sinceDays = 7,
  limit = 50,
  scope?: Scope
): Promise<AgentSessionSummary[]> {
  const rows = await sql<
    Array<{
      agent: string;
      session: string;
      turn_count: number;
      request_count: number;
      total_cost_micro_cents: string;
      total_input_tokens: string;
      total_output_tokens: string;
      tool_capable_count: number;
      tool_call_observed_count: number;
      error_count: number;
      loop_blocked_count: number;
      budget_blocked_count: number;
      plan_blocked_count: number;
      p50_latency_ms: number | null;
      p95_latency_ms: number | null;
      first_seen_at: Date;
      last_seen_at: Date;
    }>
  >`
    SELECT
      tags->>'agent'   AS agent,
      tags->>'session' AS session,
      COUNT(DISTINCT tags->>'turn')::int AS turn_count,
      COUNT(*)::int                       AS request_count,
      COALESCE(SUM(cost_micro_cents), 0)::bigint  AS total_cost_micro_cents,
      COALESCE(SUM(input_tokens), 0)::bigint      AS total_input_tokens,
      COALESCE(SUM(output_tokens), 0)::bigint     AS total_output_tokens,
      SUM(CASE
        WHEN tags ? 'tools_declared_count'
          OR (
            jsonb_typeof(request_body->'tools') = 'array'
            AND jsonb_array_length(request_body->'tools') > 0
          )
        THEN 1 ELSE 0 END)::int AS tool_capable_count,
      SUM(CASE WHEN tags ? 'tool_calls_observed'
               THEN 1 ELSE 0 END)::int AS tool_call_observed_count,
      -- Anything that isn't success and isn't one of the explicit
      -- gateway-block statuses we surface separately. Without
      -- plan_limit_exceeded in this NOT IN, hosted plan-cap hits
      -- would silently inflate error_count and you would lose the
      -- "is the agent broken vs is the user out of quota" signal.
      SUM(CASE WHEN status NOT IN ('success', 'loop_detected', 'budget_exceeded', 'plan_limit_exceeded')
               THEN 1 ELSE 0 END)::int AS error_count,
      SUM(CASE WHEN status = 'loop_detected'       THEN 1 ELSE 0 END)::int AS loop_blocked_count,
      SUM(CASE WHEN status = 'budget_exceeded'     THEN 1 ELSE 0 END)::int AS budget_blocked_count,
      SUM(CASE WHEN status = 'plan_limit_exceeded' THEN 1 ELSE 0 END)::int AS plan_blocked_count,
      PERCENTILE_DISC(0.5)  WITHIN GROUP (ORDER BY latency_ms)::int AS p50_latency_ms,
      PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY latency_ms)::int AS p95_latency_ms,
      MIN(created_at) AS first_seen_at,
      MAX(created_at) AS last_seen_at
    FROM requests
    WHERE (${projectScope(scope)})
      AND tags ? 'agent'
      AND tags ? 'session'
      AND created_at > NOW() - (${sinceDays} || ' days')::INTERVAL
    GROUP BY tags->>'agent', tags->>'session'
    ORDER BY MAX(created_at) DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    agent: r.agent,
    session: r.session,
    turn_count: r.turn_count,
    request_count: r.request_count,
    total_cost_micro_cents: Number(r.total_cost_micro_cents),
    total_input_tokens: Number(r.total_input_tokens),
    total_output_tokens: Number(r.total_output_tokens),
    tool_capable_count: r.tool_capable_count,
    tool_call_observed_count: r.tool_call_observed_count,
    error_count: r.error_count,
    loop_blocked_count: r.loop_blocked_count,
    budget_blocked_count: r.budget_blocked_count,
    plan_blocked_count: r.plan_blocked_count,
    p50_latency_ms: r.p50_latency_ms,
    p95_latency_ms: r.p95_latency_ms,
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
  }));
}

export type AgentSessionTurn = {
  request_id: string;
  turn: string | null;
  model: string;
  status: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  cost_micro_cents: number;
  latency_ms: number | null;
  has_tools: boolean;
  tool_calls_observed: boolean;
  declared_tool_names: string | null;
  tool_call_names: string | null;
  error: string | null;
  created_at: Date;
};

/**
 * Per-turn (or per-request, when turn isn't tagged) detail for one
 * specific (agent, session) pair. Ordered by created_at so the
 * timeline reads top-to-bottom in chronological order. Limited to
 * keep the page responsive on a long-lived agent session.
 */
export async function getAgentSessionTurns(
  agent: string,
  session: string,
  limit = 200,
  scope?: Scope
): Promise<AgentSessionTurn[]> {
  const rows = await sql<
    Array<{
      request_id: string;
      turn: string | null;
      model: string;
      status: string;
      input_tokens: number;
      cached_input_tokens: number;
      output_tokens: number;
      cost_micro_cents: string;
      latency_ms: number | null;
      has_tools: boolean;
      tool_calls_observed: boolean;
      declared_tool_names: string | null;
      tool_call_names: string | null;
      error: string | null;
      created_at: Date;
    }>
  >`
    SELECT
      id          AS request_id,
      tags->>'turn' AS turn,
      model,
      status,
      input_tokens,
      cached_input_tokens,
      output_tokens,
      cost_micro_cents,
      latency_ms,
      -- COALESCE around the whole expression because
      -- jsonb_typeof(NULL) = 'array' evaluates to NULL (not FALSE),
      -- which then propagates through AND. Without this the column
      -- comes back as NULL whenever the request body lacks a tools
      -- key, but the TypeScript type says boolean. The Postgres
      -- integration test catches this; keep the COALESCE.
      COALESCE(
        tags ? 'tools_declared_count'
          OR (
            jsonb_typeof(request_body->'tools') = 'array'
              AND jsonb_array_length(request_body->'tools') > 0
          ),
        FALSE
      ) AS has_tools,
      tags ? 'tool_calls_observed' AS tool_calls_observed,
      tags->>'tools_declared_names' AS declared_tool_names,
      tags->>'tool_call_names' AS tool_call_names,
      error,
      created_at
    FROM requests
    WHERE (${projectScope(scope)})
      AND tags->>'agent'   = ${agent}
      AND tags->>'session' = ${session}
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    request_id: r.request_id,
    turn: r.turn,
    model: r.model,
    status: r.status,
    input_tokens: r.input_tokens,
    cached_input_tokens: r.cached_input_tokens,
    output_tokens: r.output_tokens,
    cost_micro_cents: Number(r.cost_micro_cents),
    latency_ms: r.latency_ms,
    has_tools: r.has_tools,
    tool_calls_observed: r.tool_calls_observed,
    declared_tool_names: r.declared_tool_names,
    tool_call_names: r.tool_call_names,
    error: r.error,
    created_at: r.created_at,
  }));
}

// --- Routing quality (post-downgrade success rate) ------------------------
//
// "TokSuan auto-downgraded my expensive model to a cheaper one. Did
// the cheap model actually succeed at the task, or am I trading dollars
// for hidden errors and retries?"
//
// The cheapest signal we can produce without human eval: success rate
// per (asked_model, effective_model) pair, with a comparison baseline
// of the same effective_model when asked natively (no rewrite). If the
// rewrite group's success rate is meaningfully worse than the native
// group on the SAME landing model, that's strong evidence the routing
// is over-aggressive on the prompts it picked up.
//
// Honest caveats:
//   - "success" here means the gateway recorded status='success' (200
//     from upstream + ledger row written). It does NOT mean the answer
//     was high-quality — model could have given a confident wrong
//     response. Quality measurement is a separate problem (shadow A/B,
//     LLM judge, human eval).
//   - Sample sizes vary wildly. A pair with 5 requests and 1 error
//     looks like 80% success but isn't statistically meaningful.
//     The page surfaces `total` next to every percent so an operator
//     can judge.

export type RoutingPairStats = {
  /** What the caller put in `body.model`. */
  asked: string;
  /** What the gateway actually called upstream after routing. */
  landed: string;
  /** True iff the gateway rewrote `model` (asked != landed via routing rule or baseline policy). */
  rewritten: boolean;
  /** All ledger rows for this pair, including blocks. */
  total: number;
  success: number;
  upstream_errors: number;
  loop_blocked: number;
  quota_blocked: number;
  /**
   * Success rate as % over rows that ACTUALLY REACHED UPSTREAM —
   * i.e. denominator is `success + upstream_errors`. Loop / budget /
   * plan blocks are explicitly EXCLUDED because they fire BEFORE the
   * upstream call and don't reflect on the routing decision's
   * quality (they're TokSuan's protection layer doing its job).
   * Surfaced as raw counts in `loop_blocked` / `quota_blocked` so an
   * operator reading the page still sees them.
   * `null` when no rows reached upstream (everything was blocked).
   */
  success_rate_pct: number | null;
  total_cost_micro_cents: number;
  avg_latency_ms: number | null;
};

export type RoutingQualityRewrite = RoutingPairStats & {
  /**
   * Success rate of `landed` model when asked NATIVELY (no rewrite),
   * within the same window + scope. Null when no native traffic
   * exists to compare against — operator should then read the rewrite
   * stats absolute, not relative.
   */
  baseline_success_rate_pct: number | null;
  baseline_total: number;
  /**
   * Signed delta: rewrite success% − baseline success%. Negative
   * means the rewrite is worse than asking the same model natively.
   * Null when baseline is null. Surface this as the headline number.
   */
  success_rate_delta_pct: number | null;
};

/**
 * Per-bucket aggregation. The bucket string is `<task_type>:<complexity>`
 * exactly as the gateway writes it on the `requests.routing_bucket`
 * column (only set for baseline-policy decisions; project routing
 * rules and non-routed calls have NULL bucket and don't appear here).
 *
 * Sample question this answers: "When the classifier said this turn
 * was code:hard and the policy downgraded, did the cheap model handle
 * it as well as it does on chat:medium?"
 */
export type RoutingBucketStats = {
  bucket: string;
  total: number;
  success: number;
  upstream_errors: number;
  loop_blocked: number;
  quota_blocked: number;
  success_rate_pct: number | null;
  total_cost_micro_cents: number;
  /** Average dollar saving per request in this bucket (vs original_model). */
  avg_routing_saving_micro_cents: number;
};

export type RoutingQuality = {
  rewrites: RoutingQualityRewrite[];
  natives: RoutingPairStats[];
  by_bucket: RoutingBucketStats[];
};

/**
 * Per-(asked, landed) success-rate rollup over the last `sinceDays`
 * days. Returns rewrites (auto-downgraded by routing rule or baseline
 * policy) separated from natives (asked = landed). For each rewrite
 * we also stitch in the baseline success rate of the SAME landing
 * model when asked natively, so the page can show a delta.
 */
export async function getRoutingQuality(
  sinceDays = 7,
  scope?: Scope
): Promise<RoutingQuality> {
  const rows = await sql<
    Array<{
      asked: string;
      landed: string;
      rewritten: boolean;
      total: number;
      success: number;
      upstream_errors: number;
      loop_blocked: number;
      quota_blocked: number;
      total_cost_micro_cents: string;
      avg_latency_ms: number | null;
    }>
  >`
    SELECT
      COALESCE(original_model, model) AS asked,
      model                            AS landed,
      (original_model IS NOT NULL AND original_model <> model) AS rewritten,
      COUNT(*)::int                    AS total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)::int       AS success,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)::int         AS upstream_errors,
      SUM(CASE WHEN status = 'loop_detected' THEN 1 ELSE 0 END)::int AS loop_blocked,
      SUM(CASE WHEN status IN ('budget_exceeded', 'plan_limit_exceeded')
               THEN 1 ELSE 0 END)::int AS quota_blocked,
      COALESCE(SUM(cost_micro_cents), 0)::bigint AS total_cost_micro_cents,
      AVG(latency_ms)::int             AS avg_latency_ms
    FROM requests
    WHERE (${projectScope(scope)})
      AND created_at > NOW() - (${sinceDays} || ' days')::INTERVAL
      AND model IS NOT NULL
    GROUP BY COALESCE(original_model, model), model,
             (original_model IS NOT NULL AND original_model <> model)
    HAVING COUNT(*) > 0
  `;

  const upstreamReached = (r: { success: number; upstream_errors: number }): number =>
    r.success + r.upstream_errors;

  const toStats = (r: (typeof rows)[number]): RoutingPairStats => {
    const reached = upstreamReached(r);
    return {
      asked: r.asked,
      landed: r.landed,
      rewritten: r.rewritten,
      total: r.total,
      success: r.success,
      upstream_errors: r.upstream_errors,
      loop_blocked: r.loop_blocked,
      quota_blocked: r.quota_blocked,
      success_rate_pct:
        reached > 0
          ? Math.round((1000 * r.success) / reached) / 10 // one decimal
          : null,
      total_cost_micro_cents: Number(r.total_cost_micro_cents),
      avg_latency_ms: r.avg_latency_ms,
    };
  };

  const all = rows.map(toStats);
  const rewrites = all.filter((r) => r.rewritten);
  const natives = all.filter((r) => !r.rewritten);

  // Index natives by landed model so each rewrite can look up its
  // direct-call baseline cheaply. We track BOTH the upstream-reached
  // denominator (for the rate) AND the raw `total` (for the
  // "n=" hint shown in the UI tooltip). If multiple natives map to
  // the same landed model (shouldn't, but defensively) we sum them.
  const nativeByLanded = new Map<
    string,
    { success: number; reached: number; total: number }
  >();
  for (const n of natives) {
    const cur = nativeByLanded.get(n.landed) ?? {
      success: 0,
      reached: 0,
      total: 0,
    };
    cur.success += n.success;
    cur.reached += n.success + n.upstream_errors;
    cur.total += n.total;
    nativeByLanded.set(n.landed, cur);
  }

  const rewritesWithBaseline: RoutingQualityRewrite[] = rewrites
    .map((r) => {
      const baseline = nativeByLanded.get(r.landed);
      const baseline_success_rate_pct =
        baseline && baseline.reached > 0
          ? Math.round((1000 * baseline.success) / baseline.reached) / 10
          : null;
      const success_rate_delta_pct =
        baseline_success_rate_pct == null || r.success_rate_pct == null
          ? null
          : Math.round(
              10 * (r.success_rate_pct - baseline_success_rate_pct)
            ) / 10;
      return {
        ...r,
        baseline_success_rate_pct,
        baseline_total: baseline?.total ?? 0,
        success_rate_delta_pct,
      };
    })
    // Sort by largest sample first, then biggest negative delta — those
    // are the cases an operator most wants to look at.
    .sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      const ad = a.success_rate_delta_pct ?? 0;
      const bd = b.success_rate_delta_pct ?? 0;
      return ad - bd; // most negative delta first
    });

  // Per-bucket aggregation. Only baseline-policy routes carry a
  // `routing_bucket` value, so this query naturally excludes:
  //   - non-routed traffic (caller's model went straight to upstream)
  //   - project routing_rules matches (they're regex-based, not bucket-based)
  // The gateway writes routing_bucket in the same TX as the requests
  // row, so every row that has it is guaranteed to also have a
  // matching original_model (rewrite happened) and routing_reason.
  const bucketRows = await sql<
    Array<{
      bucket: string;
      total: number;
      success: number;
      upstream_errors: number;
      loop_blocked: number;
      quota_blocked: number;
      total_cost_micro_cents: string;
      total_routing_saving_micro_cents: string;
    }>
  >`
    SELECT
      routing_bucket                   AS bucket,
      COUNT(*)::int                    AS total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)::int       AS success,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)::int         AS upstream_errors,
      SUM(CASE WHEN status = 'loop_detected' THEN 1 ELSE 0 END)::int AS loop_blocked,
      SUM(CASE WHEN status IN ('budget_exceeded', 'plan_limit_exceeded')
               THEN 1 ELSE 0 END)::int AS quota_blocked,
      COALESCE(SUM(cost_micro_cents), 0)::bigint AS total_cost_micro_cents,
      COALESCE(SUM(routing_saving_micro_cents), 0)::bigint AS total_routing_saving_micro_cents
    FROM requests
    WHERE (${projectScope(scope)})
      AND created_at > NOW() - (${sinceDays} || ' days')::INTERVAL
      AND routing_bucket IS NOT NULL
    GROUP BY routing_bucket
    HAVING COUNT(*) > 0
    ORDER BY COUNT(*) DESC
  `;

  const by_bucket: RoutingBucketStats[] = bucketRows.map((r) => {
    const reached = r.success + r.upstream_errors;
    const total = r.total;
    return {
      bucket: r.bucket,
      total,
      success: r.success,
      upstream_errors: r.upstream_errors,
      loop_blocked: r.loop_blocked,
      quota_blocked: r.quota_blocked,
      success_rate_pct:
        reached > 0 ? Math.round((1000 * r.success) / reached) / 10 : null,
      total_cost_micro_cents: Number(r.total_cost_micro_cents),
      avg_routing_saving_micro_cents:
        total > 0
          ? Math.round(Number(r.total_routing_saving_micro_cents) / total)
          : 0,
    };
  });

  return {
    rewrites: rewritesWithBaseline,
    natives: natives.sort((a, b) => b.total - a.total),
    by_bucket,
  };
}

// --- Top loops -------------------------------------------------------------

export type TopLoop = {
  fingerprint: string;
  model: string;
  total_attempts: number;
  blocked_attempts: number;
  last_seen_at: Date;
};

export const getTopLoops = cacheStats(
  async (
    sinceHours = 24,
    limit = 5,
    scope?: Scope
  ): Promise<TopLoop[]> => {
    // The "model" picked is the most recently seen model for this
    // fingerprint inside the time window. Postgres can express that
    // compactly with `(ARRAY_AGG(model ORDER BY created_at DESC))[1]`,
    // but SQLite has no ARRAY_AGG and no ordered aggregate syntax.
    // A correlated subquery picking ORDER BY ... LIMIT 1 works on
    // BOTH backends and the planner handles it efficiently because
    // `fingerprint` is indexed.
    return sql<TopLoop[]>`
      SELECT
        r.fingerprint,
        (
          SELECT r2.model
            FROM requests r2
           WHERE r2.fingerprint = r.fingerprint
             AND r2.created_at > NOW() - (${sinceHours} || ' hours')::INTERVAL
           ORDER BY r2.created_at DESC
           LIMIT 1
        ) AS model,
        COUNT(*)::int AS total_attempts,
        SUM(CASE WHEN r.status = 'loop_detected' THEN 1 ELSE 0 END)::int
          AS blocked_attempts,
        MAX(r.created_at) AS last_seen_at
      FROM requests r
      WHERE r.fingerprint IS NOT NULL
        AND (${projectScope(scope)})
        AND r.created_at > NOW() - (${sinceHours} || ' hours')::INTERVAL
      GROUP BY r.fingerprint
      HAVING COUNT(*) >= 3
      ORDER BY total_attempts DESC, last_seen_at DESC
      LIMIT ${limit}
    `;
  },
  "getTopLoops"
);

// --- Projects & API keys (hosted-mode self-service CRUD) -------------------

export type Project = {
  id: string;
  user_id: string | null;
  name: string;
  created_at: Date;
};

export type ApiKey = {
  id: string;
  project_id: string;
  /**
   * Plaintext key. NULL for keys created after the v0.2 hashing migration —
   * once minted, we can never display them again. Use `key_prefix` + `key_last4`
   * for human display in that case.
   */
  key: string | null;
  key_hash: string | null;
  key_prefix: string | null;
  key_last4: string | null;
  name: string | null;
  created_at: Date;
  last_used_at: Date | null;
  /**
   * Soft-rotate grace window end (v0.4.x). NULL = canonical key.
   * Non-NULL = this row is the "old half" of a rotation; the gateway
   * accepts it until this timestamp passes.
   */
  expires_at: Date | null;
};

/**
 * Projects the user can actively work with in the dashboard.
 *
 * Personal projects are included for their owner. Org projects are included
 * for non-viewer members because migration 011 defines `member` as able to
 * mutate per-project resources (budgets, routing, alerts, templates). Org
 * viewers still see ledger data through `getScope()` but do not get the
 * project control surface.
 */
export async function listProjectsForUser(userId: string): Promise<Project[]> {
  return sql<Project[]>`
    SELECT DISTINCT p.id, p.user_id, p.name, p.created_at
    FROM projects p
    LEFT JOIN organization_members m
      ON m.organization_id = p.organization_id
     AND m.user_id = ${userId}
    WHERE p.user_id = ${userId}
       OR (m.role IS NOT NULL AND m.role <> 'viewer')
    ORDER BY p.created_at ASC
  `;
}

/** Same access contract as `listProjectsForUser`, scoped to one project. */
export async function getProjectForUser(
  userId: string,
  projectId: string
): Promise<Project | null> {
  const rows = await sql<Project[]>`
    SELECT p.id, p.user_id, p.name, p.created_at
    FROM projects p
    LEFT JOIN organization_members m
      ON m.organization_id = p.organization_id
     AND m.user_id = ${userId}
    WHERE p.id = ${projectId}
      AND (
        p.user_id = ${userId}
        OR (m.role IS NOT NULL AND m.role <> 'viewer')
      )
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function createProject(
  userId: string,
  name: string
): Promise<Project> {
  // Carry the user's current learning entitlement onto the new
  // project. Pro/Team/Scale → learning_enabled=TRUE so the cloud
  // cron picks the project up tonight without a manual flip;
  // Free → FALSE so we don't silently start training for someone
  // who isn't paying for it.
  //
  // This is a snapshot of the plan at creation time. The Stripe
  // webhook's syncProjectLearningFlag fixes it on subscription
  // changes, so this just makes the steady state right immediately
  // instead of waiting for the next billing event.
  const rows = await sql<Project[]>`
    INSERT INTO projects (user_id, name, learning_enabled)
    VALUES (
      ${userId},
      ${name},
      COALESCE(
        (SELECT plan IN ('pro','team','scale') FROM users WHERE id = ${userId}),
        FALSE
      )
    )
    RETURNING id, user_id, name, created_at
  `;
  return rows[0]!;
}

export async function deleteProject(
  projectId: string,
  userId: string
): Promise<void> {
  await sql`
    DELETE FROM projects
     WHERE id = ${projectId}
       AND user_id = ${userId}
  `;
}

export async function listApiKeysForProject(projectId: string): Promise<ApiKey[]> {
  return sql<ApiKey[]>`
    SELECT id, project_id, key, key_hash, key_prefix, key_last4,
           name, created_at, last_used_at, expires_at
    FROM api_keys
    WHERE project_id = ${projectId}
    ORDER BY created_at ASC
  `;
}

/**
 * Insert a new API key. We persist the SHA-256 hash + a small visible prefix
 * and last-4 for display. The plaintext key is NEVER stored — the caller is
 * expected to flash it back to the user once via a one-time toast.
 */
export async function createApiKey(
  projectId: string,
  name: string,
  rawKey: string,
  keyHash: string
): Promise<ApiKey> {
  const prefix = rawKey.slice(0, 7);
  const last4 = rawKey.slice(-4);
  const rows = await sql<ApiKey[]>`
    INSERT INTO api_keys (project_id, name, key_hash, key_prefix, key_last4)
    VALUES (${projectId}, ${name}, ${keyHash}, ${prefix}, ${last4})
    RETURNING id, project_id, key, key_hash, key_prefix, key_last4,
              name, created_at, last_used_at, expires_at
  `;
  return rows[0]!;
}

export async function deleteApiKey(id: string, projectId: string): Promise<void> {
  await sql`DELETE FROM api_keys WHERE id = ${id} AND project_id = ${projectId}`;
}

/**
 * Soft rotate (v0.4.x): mint a replacement key and put the old one on
 * a 24h expiry clock, all inside one TX. Both keys are valid during
 * the grace window so a rolling deploy can swap secrets without any
 * single request 401-ing. The old key stops working the instant
 * `NOW() >= expires_at` — gateway `findApiKey` enforces that, so the
 * customer doesn't need to run a cleanup job for correctness.
 *
 * Argument: `graceMs` (default 24h) — set to 0 for immediate cutover
 * (matches the v0.3 behavior). Capped at 7 days for safety; longer
 * windows encourage customers to forget a key is still live.
 *
 * Returns the new ApiKey so the caller can stash its plaintext for
 * the one-time reveal cookie. The caller holds the plaintext; this
 * function only takes the hash + prefix/last4.
 */
export async function rotateApiKey(args: {
  oldId: string;
  projectId: string;
  newRawKey: string;
  newKeyHash: string;
  graceMs?: number;
}): Promise<{ newKey: ApiKey; oldExpiresAt: Date | null } | null> {
  const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;
  const MAX_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
  const graceMs = Math.min(
    Math.max(args.graceMs ?? DEFAULT_GRACE_MS, 0),
    MAX_GRACE_MS
  );

  return sql.begin(async (tx) => {
    const existing = await tx<{ id: string; name: string }[]>`
      SELECT id, name FROM api_keys
       WHERE id = ${args.oldId} AND project_id = ${args.projectId}
       LIMIT 1
    `;
    const old = existing[0];
    if (!old) return null;

    const prefix = args.newRawKey.slice(0, 7);
    const last4 = args.newRawKey.slice(-4);
    const inserted = await tx<ApiKey[]>`
      INSERT INTO api_keys (project_id, name, key_hash, key_prefix, key_last4)
      VALUES (
        ${args.projectId}, ${old.name},
        ${args.newKeyHash}, ${prefix}, ${last4}
      )
      RETURNING id, project_id, key, key_hash, key_prefix, key_last4,
                name, created_at, last_used_at, expires_at
    `;
    const newKey = inserted[0];
    if (!newKey) return null;

    let oldExpiresAt: Date | null = null;
    if (graceMs === 0) {
      // Immediate cutover — matches pre-v0.4 behavior for callers that
      // explicitly ask for it (e.g. compromised-key rotation).
      await tx`
        DELETE FROM api_keys
         WHERE id = ${args.oldId} AND project_id = ${args.projectId}
      `;
    } else {
      const expiresAt = new Date(Date.now() + graceMs);
      await tx`
        UPDATE api_keys
           SET expires_at = ${expiresAt}
         WHERE id = ${args.oldId} AND project_id = ${args.projectId}
      `;
      oldExpiresAt = expiresAt;
    }
    return { newKey, oldExpiresAt };
  });
}

/**
 * Sweep: hard-delete all api_keys rows where `expires_at` has elapsed.
 * Safe to call from a cron, a one-shot script, or on-demand; each
 * row is already un-usable (gateway `findApiKey` filters on
 * `expires_at > NOW()`), so late sweeps don't affect correctness.
 * Returns the count deleted so operators can observe sweep health.
 */
export async function sweepExpiredApiKeys(): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    DELETE FROM api_keys
     WHERE expires_at IS NOT NULL AND expires_at < NOW()
    RETURNING id
  `;
  return rows.length;
}

// --- Budgets (CRUD) -------------------------------------------------------

export type BudgetPeriod = "daily" | "monthly";

export type BudgetRow = {
  id: string;
  project_id: string;
  period: BudgetPeriod;
  limit_micro_cents: number;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

export async function listBudgetsForProject(
  projectId: string
): Promise<BudgetRow[]> {
  return sql<BudgetRow[]>`
    SELECT id, project_id, period, limit_micro_cents, enabled, created_at, updated_at
    FROM budgets
    WHERE project_id = ${projectId}
    ORDER BY CASE period WHEN 'daily' THEN 0 ELSE 1 END
  `;
}

/**
 * Upsert a budget for (project, period). One row per period — the unique
 * constraint in 001_init.sql guarantees this.
 */
export async function upsertBudget(
  projectId: string,
  period: BudgetPeriod,
  limitMicroCents: number,
  enabled = true
): Promise<BudgetRow> {
  const rows = await sql<BudgetRow[]>`
    INSERT INTO budgets (project_id, period, limit_micro_cents, enabled)
    VALUES (${projectId}, ${period}, ${limitMicroCents}, ${enabled})
    ON CONFLICT (project_id, period)
    DO UPDATE SET
      limit_micro_cents = EXCLUDED.limit_micro_cents,
      enabled           = EXCLUDED.enabled,
      updated_at        = NOW()
    RETURNING id, project_id, period, limit_micro_cents, enabled, created_at, updated_at
  `;
  return rows[0]!;
}

export async function deleteBudget(
  id: string,
  projectId: string
): Promise<void> {
  await sql`DELETE FROM budgets WHERE id = ${id} AND project_id = ${projectId}`;
}

// --- Routing rules (CRUD) -------------------------------------------------

export type RoutingMode = "route" | "shadow" | "both";

export type RoutingRuleRow = {
  id: string;
  project_id: string;
  enabled: boolean;
  threshold: number;
  from_pattern: string;
  to_model: string;
  shadow_to_model: string | null;
  mode: RoutingMode;
  /**
   * Probability (0..1) the rule fires when the pattern + threshold
   * already matched. NULL = legacy "fire on every match" behavior.
   * Surfaced in the rule editor so users can configure shadow A/B
   * sampling without dropping to the CLI. Schema: migration 020.
   */
  sample_rate: number | null;
  created_at: Date;
  updated_at: Date;
};

export async function listRoutingRulesForProject(
  projectId: string
): Promise<RoutingRuleRow[]> {
  return sql<RoutingRuleRow[]>`
    SELECT id, project_id, enabled, threshold, from_pattern, to_model,
           shadow_to_model, mode, sample_rate, created_at, updated_at
    FROM routing_rules
    WHERE project_id = ${projectId}
    ORDER BY created_at ASC
  `;
}

/**
 * Upsert by (project_id, from_pattern). Mirrors the CLI script's behavior so
 * editing a rule doesn't double-insert.
 */
export async function upsertRoutingRule(
  projectId: string,
  rule: {
    fromPattern: string;
    toModel: string;
    threshold: number;
    mode: RoutingMode;
    shadowToModel: string | null;
    enabled: boolean;
    /**
     * Optional sampling rate in [0, 1]. NULL/undefined keeps the legacy
     * "always fire on match" behavior. Sub-1 values gate firing on
     * `Math.random() < sample_rate` so a shadow rule can drip-feed
     * `ab_results` without doubling the upstream bill.
     */
    sampleRate?: number | null;
  }
): Promise<RoutingRuleRow> {
  const rows = await sql<RoutingRuleRow[]>`
    INSERT INTO routing_rules (
      project_id, enabled, threshold, from_pattern, to_model,
      shadow_to_model, mode, sample_rate
    )
    VALUES (
      ${projectId}, ${rule.enabled}, ${rule.threshold}, ${rule.fromPattern},
      ${rule.toModel}, ${rule.shadowToModel}, ${rule.mode},
      ${rule.sampleRate ?? null}
    )
    ON CONFLICT (project_id, from_pattern)
    DO UPDATE SET
      enabled         = EXCLUDED.enabled,
      threshold       = EXCLUDED.threshold,
      to_model        = EXCLUDED.to_model,
      shadow_to_model = EXCLUDED.shadow_to_model,
      mode            = EXCLUDED.mode,
      sample_rate     = EXCLUDED.sample_rate,
      updated_at      = NOW()
    RETURNING id, project_id, enabled, threshold, from_pattern, to_model,
              shadow_to_model, mode, sample_rate, created_at, updated_at
  `;
  return rows[0]!;
}

export async function deleteRoutingRule(
  id: string,
  projectId: string
): Promise<void> {
  await sql`DELETE FROM routing_rules WHERE id = ${id} AND project_id = ${projectId}`;
}

// --- Alert rules (CRUD) ---------------------------------------------------

export type AlertEventType =
  | "budget_exceeded"
  | "loop_detected"
  | "cost_anomaly"
  | "retrain_failed";

export const ALERT_EVENT_TYPES: readonly AlertEventType[] = [
  "budget_exceeded",
  "loop_detected",
  "cost_anomaly",
  "retrain_failed",
] as const;

export type AlertRuleRow = {
  id: string;
  project_id: string;
  event_type: AlertEventType;
  webhook_url: string | null;
  email: string | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

export async function listAlertRulesForProject(
  projectId: string
): Promise<AlertRuleRow[]> {
  return sql<AlertRuleRow[]>`
    SELECT id, project_id, event_type, webhook_url, email, enabled,
           created_at, updated_at
    FROM alert_rules
    WHERE project_id = ${projectId}
    ORDER BY created_at ASC
  `;
}

/**
 * Fetch a single alert rule by id, scoped to a project the caller owns.
 * Used by the test-alert action.
 */
export async function getAlertRuleById(
  id: string,
  projectId: string
): Promise<AlertRuleRow | null> {
  const rows = await sql<AlertRuleRow[]>`
    SELECT id, project_id, event_type, webhook_url, email, enabled,
           created_at, updated_at
    FROM alert_rules
    WHERE id = ${id} AND project_id = ${projectId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function createAlertRule(
  projectId: string,
  rule: {
    eventType: AlertEventType;
    webhookUrl: string | null;
    email: string | null;
    enabled: boolean;
  }
): Promise<AlertRuleRow> {
  const rows = await sql<AlertRuleRow[]>`
    INSERT INTO alert_rules (project_id, event_type, webhook_url, email, enabled)
    VALUES (${projectId}, ${rule.eventType}, ${rule.webhookUrl}, ${rule.email}, ${rule.enabled})
    RETURNING id, project_id, event_type, webhook_url, email, enabled,
              created_at, updated_at
  `;
  return rows[0]!;
}

export async function deleteAlertRule(
  id: string,
  projectId: string
): Promise<void> {
  await sql`DELETE FROM alert_rules WHERE id = ${id} AND project_id = ${projectId}`;
}

// --- BYO upstream provider keys (CRUD) -----------------------------------

export const SUPPORTED_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "qwen",
  "doubao",
] as const;

export type ProviderName = (typeof SUPPORTED_PROVIDERS)[number];

export type UserProviderKeyRow = {
  id: string;
  user_id: string;
  provider: ProviderName;
  base_url: string | null;
  key_last4: string;
  master_key_fingerprint: string | null;
  created_at: Date;
  updated_at: Date;
};

export async function listProviderKeysForUser(
  userId: string
): Promise<UserProviderKeyRow[]> {
  return sql<UserProviderKeyRow[]>`
    SELECT id, user_id, provider, base_url, key_last4,
           master_key_fingerprint, created_at, updated_at
    FROM user_provider_keys
    WHERE user_id = ${userId}
    ORDER BY provider ASC
  `;
}

// ---------------------------------------------------------------------------
// L4 custom providers (user-registered OpenAI-compatible upstreams)
// ---------------------------------------------------------------------------

export type CustomProviderRow = {
  id: string;
  user_id: string;
  name: string;
  base_url: string;
  model_prefix: string;
  key_last4: string | null;
  master_key_fingerprint: string | null;
  wire_format: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

/**
 * List every custom provider a user has registered, newest first.
 * Returns metadata only — `encrypted_key` never leaves the DB boundary.
 */
export async function listCustomProvidersForUser(
  userId: string
): Promise<CustomProviderRow[]> {
  return sql<CustomProviderRow[]>`
    SELECT id, user_id, name, base_url, model_prefix, key_last4,
           master_key_fingerprint, wire_format, enabled,
           created_at, updated_at
    FROM user_custom_providers
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
  `;
}

export type UpsertCustomProviderInput = {
  userId: string;
  name: string;
  baseUrl: string;
  modelPrefix: string;
  /** AES-256-GCM ciphertext of the API key, or null for "no auth". */
  encryptedKey: string | null;
  keyLast4: string | null;
  masterKeyFingerprint: string | null;
  wireFormat?: string;
};

/**
 * Insert a new custom provider. ON CONFLICT (user_id, name) updates the
 * row in place — the natural key is (user, name), so re-submitting the
 * same name overwrites the previous definition. This matches how the
 * built-in `user_provider_keys` upsert behaves and keeps the UI simple
 * (no "edit" vs "create" branch at the action layer).
 */
export async function upsertCustomProvider(
  input: UpsertCustomProviderInput
): Promise<{ id: string }> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO user_custom_providers (
      user_id, name, base_url, model_prefix,
      encrypted_key, key_last4, master_key_fingerprint, wire_format
    ) VALUES (
      ${input.userId}, ${input.name}, ${input.baseUrl}, ${input.modelPrefix},
      ${input.encryptedKey}, ${input.keyLast4}, ${input.masterKeyFingerprint},
      ${input.wireFormat ?? "openai_chat"}
    )
    ON CONFLICT (user_id, name) DO UPDATE SET
      base_url               = EXCLUDED.base_url,
      model_prefix           = EXCLUDED.model_prefix,
      encrypted_key          = EXCLUDED.encrypted_key,
      key_last4              = EXCLUDED.key_last4,
      master_key_fingerprint = EXCLUDED.master_key_fingerprint,
      wire_format            = EXCLUDED.wire_format,
      updated_at             = NOW()
    RETURNING id
  `;
  return { id: rows[0]!.id };
}

export async function deleteCustomProvider(
  userId: string,
  id: string
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    DELETE FROM user_custom_providers
    WHERE id = ${id} AND user_id = ${userId}
    RETURNING id
  `;
  return rows.length > 0;
}

export async function setCustomProviderEnabled(
  userId: string,
  id: string,
  enabled: boolean
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE user_custom_providers
    SET enabled = ${enabled}, updated_at = NOW()
    WHERE id = ${id} AND user_id = ${userId}
    RETURNING id
  `;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// L5 — Model rejection telemetry (aggregate)
// ---------------------------------------------------------------------------

export type ModelRejectionRow = {
  model: string;
  reason: "no_template" | "no_credentials";
  provider_guess: string | null;
  hit_count: number;
  first_seen_at: Date;
  last_seen_at: Date;
  /** Count of DISTINCT projects that hit this rejection — tells an
   *  operator whether a rejection is concentrated in one user's traffic
   *  or broadly across the fleet. */
  project_count: number;
};

/**
 * Top-N models that the gateway has rejected within the given window.
 * Aggregated across ALL projects since the operator view is "what
 * unsupported models are users asking for, overall". Scoped to a
 * single user's projects is a future refinement when we add a
 * per-tenant view.
 */
export async function listTopModelRejections(
  opts: { sinceDays: number; limit?: number } = { sinceDays: 7 }
): Promise<ModelRejectionRow[]> {
  const sinceDays = Math.max(1, Math.min(opts.sinceDays, 90));
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 100));
  return sql<ModelRejectionRow[]>`
    SELECT
      model,
      reason,
      MAX(provider_guess)              AS provider_guess,
      SUM(hit_count)::bigint           AS hit_count,
      MIN(first_seen_at)               AS first_seen_at,
      MAX(last_seen_at)                AS last_seen_at,
      COUNT(DISTINCT project_id)::int  AS project_count
    FROM ops_model_rejections
    WHERE last_seen_at > NOW() - (${sinceDays}::int || ' days')::interval
    GROUP BY model, reason
    ORDER BY hit_count DESC, last_seen_at DESC
    LIMIT ${limit}
  `;
}

/**
 * Fetch the encrypted blob + fingerprint for a single user-owned provider
 * key. Used by the "Test this key" server action which needs to decrypt
 * and call the upstream provider with the plaintext for one ping.
 */
export type StoredUserProviderKey = {
  id: string;
  user_id: string;
  provider: ProviderName;
  encrypted_key: string;
  master_key_fingerprint: string | null;
  base_url: string | null;
};

export async function getStoredProviderKeyForUser(
  userId: string,
  id: string
): Promise<StoredUserProviderKey | null> {
  const rows = await sql<StoredUserProviderKey[]>`
    SELECT id, user_id, provider, encrypted_key,
           master_key_fingerprint, base_url
    FROM user_provider_keys
    WHERE id = ${id} AND user_id = ${userId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

// --- Per-user, per-provider 30d usage (Settings page) ---------------------
//
// Joins requests → projects → user, then groups by the gateway's
// canonical provider name. Used by the Settings page to show "this key
// has handled $X.XX worth of traffic in the last 30 days" so users can see
// which BYO keys are actually doing work.

export type ProviderUsageSummary = {
  provider: string;
  request_count: number;
  total_cost_micro_cents: number;
  /** Most recent successful upstream call against this provider. */
  last_used_at: Date | null;
  /** Most recent error against this provider, useful for "key dead?" hints. */
  last_error_at: Date | null;
};

export async function getProviderUsageForUser(
  userId: string,
  sinceHours = 24 * 30
): Promise<ProviderUsageSummary[]> {
  const rows = await sql<
    Array<{
      provider: string;
      request_count: number;
      total_cost_micro_cents: string;
      last_used_at: Date | null;
      last_error_at: Date | null;
    }>
  >`
    SELECT
      r.provider AS provider,
      COUNT(*)::int AS request_count,
      COALESCE(SUM(r.cost_micro_cents), 0)::bigint AS total_cost_micro_cents,
      MAX(CASE WHEN r.status = 'success' THEN r.created_at END) AS last_used_at,
      MAX(CASE WHEN r.status NOT IN ('success', 'loop_detected', 'budget_exceeded', 'plan_limit_exceeded')
               THEN r.created_at END) AS last_error_at
    FROM requests r
    JOIN projects p ON p.id = r.project_id
    WHERE p.user_id = ${userId}
      AND r.created_at > NOW() - (${sinceHours} || ' hours')::INTERVAL
    GROUP BY r.provider
  `;
  return rows.map((row) => ({
    provider: row.provider,
    request_count: row.request_count,
    total_cost_micro_cents: Number(row.total_cost_micro_cents),
    last_used_at: row.last_used_at,
    last_error_at: row.last_error_at,
  }));
}

/**
 * Upsert by (user_id, provider). The CIPHERTEXT + FINGERPRINT are generated
 * by the caller using `lib/crypto.ts` so the plaintext key never leaves
 * their server action stack frame. Fingerprint is the short identifier of
 * the master key used to produce the ciphertext — persisted alongside so
 * future rotation passes can filter by it.
 */
export async function upsertUserProviderKey(
  userId: string,
  provider: ProviderName,
  encryptedKey: string,
  fingerprint: string,
  keyLast4: string,
  baseUrl: string | null
): Promise<UserProviderKeyRow> {
  const rows = await sql<UserProviderKeyRow[]>`
    INSERT INTO user_provider_keys (
      user_id, provider, encrypted_key, master_key_fingerprint,
      key_last4, base_url
    )
    VALUES (
      ${userId}, ${provider}, ${encryptedKey}, ${fingerprint},
      ${keyLast4}, ${baseUrl}
    )
    ON CONFLICT (user_id, provider)
    DO UPDATE SET
      encrypted_key          = EXCLUDED.encrypted_key,
      master_key_fingerprint = EXCLUDED.master_key_fingerprint,
      key_last4              = EXCLUDED.key_last4,
      base_url               = EXCLUDED.base_url,
      updated_at             = NOW()
    RETURNING id, user_id, provider, base_url, key_last4,
              master_key_fingerprint, created_at, updated_at
  `;
  return rows[0]!;
}

export async function deleteUserProviderKey(
  userId: string,
  id: string
): Promise<void> {
  await sql`
    DELETE FROM user_provider_keys WHERE id = ${id} AND user_id = ${userId}
  `;
}

// --- Referral commission program (migration 009) --------------------------

export type ReferralProfile = {
  /** Stable per-user code, NULL until first asked for. Caller mints if needed. */
  referral_code: string | null;
  /** The user who referred us (set once on signup, immutable). */
  referred_by_user_id: string | null;
  /** Email of the referrer, joined for display. */
  referred_by_email: string | null;
};

export async function getReferralProfile(
  userId: string
): Promise<ReferralProfile> {
  const rows = await sql<
    {
      referral_code: string | null;
      referred_by_user_id: string | null;
      referred_by_email: string | null;
    }[]
  >`
    SELECT
      u.referral_code,
      u.referred_by_user_id,
      ref.email AS referred_by_email
      FROM users u
      LEFT JOIN users ref ON ref.id = u.referred_by_user_id
     WHERE u.id = ${userId}
     LIMIT 1
  `;
  const r = rows[0];
  return {
    referral_code: r?.referral_code ?? null,
    referred_by_user_id: r?.referred_by_user_id ?? null,
    referred_by_email: r?.referred_by_email ?? null,
  };
}

/**
 * Mint a referral code if the user doesn't have one yet. Idempotent — if
 * called twice in parallel, the UNIQUE constraint on `referral_code` plus
 * the WHERE-NULL guard means the loser's UPDATE is a no-op and we read
 * back whatever stuck.
 *
 * Code shape: 8 lowercase alphanumerics, ~$10^12 keyspace before any
 * collision risk matters. `gen_random_uuid()::text` gives uniformly random
 * bytes; we slice + lowercase for a friendly URL token.
 */
export async function ensureReferralCode(userId: string): Promise<string> {
  const existing = await sql<{ referral_code: string | null }[]>`
    SELECT referral_code FROM users WHERE id = ${userId} LIMIT 1
  `;
  const have = existing[0]?.referral_code;
  if (have) return have;

  // Try up to 5 random codes — collisions are astronomically unlikely
  // but the loop closes the door on production-grade paranoia.
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = (
      await sql<{ c: string }[]>`SELECT REPLACE(gen_random_uuid()::text, '-', '') AS c`
    )[0]!.c
      .slice(0, 8)
      .toLowerCase();
    try {
      const updated = await sql<{ referral_code: string }[]>`
        UPDATE users
           SET referral_code = ${candidate}
         WHERE id = ${userId}
           AND referral_code IS NULL
        RETURNING referral_code
      `;
      if (updated[0]) return updated[0].referral_code;
      // Lost the race — re-read.
      const re = await sql<{ referral_code: string | null }[]>`
        SELECT referral_code FROM users WHERE id = ${userId} LIMIT 1
      `;
      if (re[0]?.referral_code) return re[0].referral_code;
    } catch {
      // collision on UNIQUE — try another candidate
      continue;
    }
  }
  throw new Error("Failed to mint a unique referral code after 5 attempts");
}

/**
 * Resolve `?ref=<code>` → user_id. Returns NULL on any miss (unknown
 * code, deleted user) so the caller can silently skip attribution rather
 * than failing the signup flow.
 */
export async function findUserIdByReferralCode(
  code: string
): Promise<string | null> {
  if (!code) return null;
  const normalized = code.trim().toLowerCase();
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM users WHERE referral_code = ${normalized} LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

/**
 * Set `referred_by_user_id` exactly once. No-op if already set or if the
 * referrer is the same user (self-referral). Returns true on the actual
 * set, false on the no-op — useful for logging.
 */
export async function setReferredBy(
  userId: string,
  referrerUserId: string
): Promise<boolean> {
  if (userId === referrerUserId) return false;
  const result = await sql<{ id: string }[]>`
    UPDATE users
       SET referred_by_user_id = ${referrerUserId}
     WHERE id = ${userId}
       AND referred_by_user_id IS NULL
    RETURNING id
  `;
  return result.length > 0;
}

export type ReferralCreditRow = {
  id: string;
  referrer_user_id: string;
  referee_user_id: string | null;
  referee_email: string | null;
  referee_invoice_id: string;
  referee_invoice_subtotal_micro_cents: number;
  credit_micro_cents: number;
  stripe_balance_txn_id: string | null;
  applied_at: Date | null;
  created_at: Date;
};

export async function listReferralCreditsForUser(
  userId: string,
  limit = 100
): Promise<ReferralCreditRow[]> {
  const rows = await sql<
    {
      id: string;
      referrer_user_id: string;
      referee_user_id: string | null;
      referee_email: string | null;
      referee_invoice_id: string;
      referee_invoice_subtotal_micro_cents: string;
      credit_micro_cents: string;
      stripe_balance_txn_id: string | null;
      applied_at: Date | null;
      created_at: Date;
    }[]
  >`
    SELECT
      rc.id,
      rc.referrer_user_id,
      rc.referee_user_id,
      ru.email AS referee_email,
      rc.referee_invoice_id,
      rc.referee_invoice_subtotal_micro_cents,
      rc.credit_micro_cents,
      rc.stripe_balance_txn_id,
      rc.applied_at,
      rc.created_at
    FROM referral_credits rc
    LEFT JOIN users ru ON ru.id = rc.referee_user_id
    WHERE rc.referrer_user_id = ${userId}
    ORDER BY rc.created_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    id: r.id,
    referrer_user_id: r.referrer_user_id,
    referee_user_id: r.referee_user_id,
    referee_email: r.referee_email,
    referee_invoice_id: r.referee_invoice_id,
    referee_invoice_subtotal_micro_cents: Number(
      r.referee_invoice_subtotal_micro_cents
    ),
    credit_micro_cents: Number(r.credit_micro_cents),
    stripe_balance_txn_id: r.stripe_balance_txn_id,
    applied_at: r.applied_at,
    created_at: r.created_at,
  }));
}

export type ReferralStats = {
  /** People who signed up with this user's referral code. */
  referee_count: number;
  /** Of those, how many have at least one paid invoice. */
  paying_referee_count: number;
  /** Sum of credits granted to this referrer (applied + pending). */
  total_credit_micro_cents: number;
  /** Pending = NULL applied_at. UI shows "$X waiting to be applied". */
  pending_credit_micro_cents: number;
};

export async function getReferralStats(userId: string): Promise<ReferralStats> {
  // Four scalar subqueries — all parameterised on the same userId. Each
  // returns exactly one row, no GROUP BY needed. Postgres can plan them
  // as four cheap index lookups on `users(referred_by_user_id)` +
  // `referral_credits(referrer_user_id)`.
  //
  // Previously this used a LEFT JOIN with mixed scalar + aggregate
  // columns and no GROUP BY — Postgres correctly rejected it with
  // "column rcount.c must appear in the GROUP BY clause", which made
  // the entire /referrals page fall into its dbError branch (and the
  // "Generate my referral code" button look broken because the post-
  // submit page render kept hitting the same error).
  const rows = await sql<
    {
      referee_count: number;
      paying_referee_count: number;
      total_credit: string;
      pending_credit: string;
    }[]
  >`
    SELECT
      (SELECT COUNT(*)::int
         FROM users
        WHERE referred_by_user_id = ${userId}) AS referee_count,
      (SELECT COUNT(DISTINCT referee_user_id)::int
         FROM referral_credits
        WHERE referrer_user_id = ${userId}) AS paying_referee_count,
      COALESCE((
        SELECT SUM(credit_micro_cents)
          FROM referral_credits
         WHERE referrer_user_id = ${userId}
      ), 0)::bigint AS total_credit,
      COALESCE((
        SELECT SUM(credit_micro_cents)
          FROM referral_credits
         WHERE referrer_user_id = ${userId} AND applied_at IS NULL
      ), 0)::bigint AS pending_credit
  `;
  const r = rows[0];
  return {
    referee_count: r?.referee_count ?? 0,
    paying_referee_count: r?.paying_referee_count ?? 0,
    total_credit_micro_cents: Number(r?.total_credit ?? 0),
    pending_credit_micro_cents: Number(r?.pending_credit ?? 0),
  };
}

/**
 * Insert a credit row. UNIQUE on `referee_invoice_id` makes this idempotent
 * against duplicate webhook deliveries — ON CONFLICT DO NOTHING and return
 * whether we actually inserted.
 */
export async function insertReferralCreditIfNew(args: {
  referrerUserId: string;
  refereeUserId: string;
  refereeInvoiceId: string;
  refereeInvoiceSubtotalMicroCents: number;
  creditMicroCents: number;
}): Promise<boolean> {
  const result = await sql<{ id: string }[]>`
    INSERT INTO referral_credits (
      referrer_user_id, referee_user_id, referee_invoice_id,
      referee_invoice_subtotal_micro_cents, credit_micro_cents
    ) VALUES (
      ${args.referrerUserId}, ${args.refereeUserId}, ${args.refereeInvoiceId},
      ${args.refereeInvoiceSubtotalMicroCents}, ${args.creditMicroCents}
    )
    ON CONFLICT (referee_invoice_id) DO NOTHING
    RETURNING id
  `;
  return result.length > 0;
}

/**
 * Stamp `applied_at` + `stripe_balance_txn_id` after the periodic settle
 * job successfully grants the credit on the referrer's Stripe customer.
 */
export async function markReferralCreditApplied(
  id: string,
  stripeBalanceTxnId: string
): Promise<void> {
  await sql`
    UPDATE referral_credits
       SET stripe_balance_txn_id = ${stripeBalanceTxnId},
           applied_at = NOW()
     WHERE id = ${id}
       AND applied_at IS NULL
  `;
}

export type PendingReferralCredit = {
  id: string;
  referrer_user_id: string;
  /** The referrer's Stripe customer (we credit this account). NULL if the
   *  referrer never started a subscription — in that case we hold the
   *  credit until they do. */
  referrer_stripe_customer_id: string | null;
  credit_micro_cents: number;
  referee_invoice_id: string;
};

export async function listPendingReferralCredits(
  limit = 200
): Promise<PendingReferralCredit[]> {
  const rows = await sql<
    {
      id: string;
      referrer_user_id: string;
      referrer_stripe_customer_id: string | null;
      credit_micro_cents: string;
      referee_invoice_id: string;
    }[]
  >`
    SELECT
      rc.id,
      rc.referrer_user_id,
      u.stripe_customer_id AS referrer_stripe_customer_id,
      rc.credit_micro_cents,
      rc.referee_invoice_id
    FROM referral_credits rc
    JOIN users u ON u.id = rc.referrer_user_id
    WHERE rc.applied_at IS NULL
    ORDER BY rc.created_at ASC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    id: r.id,
    referrer_user_id: r.referrer_user_id,
    referrer_stripe_customer_id: r.referrer_stripe_customer_id,
    credit_micro_cents: Number(r.credit_micro_cents),
    referee_invoice_id: r.referee_invoice_id,
  }));
}

/**
 * How many months of paid invoices a referee has accumulated. Drives the
 * "first 12 months only" cap rule in the webhook handler.
 */
export async function countRefereePaidInvoices(
  refereeUserId: string
): Promise<number> {
  const rows = await sql<{ c: number }[]>`
    SELECT COUNT(*)::int AS c
      FROM referral_credits
     WHERE referee_user_id = ${refereeUserId}
  `;
  return rows[0]?.c ?? 0;
}

// --- Prompt templates (migration 010) ------------------------------------

export type PromptTemplateRow = {
  id: string;
  project_id: string;
  name: string;
  current_version: number;
  description: string | null;
  /** The body of the *current* version, joined for one-shot reads. */
  current_body: string | null;
  created_at: Date;
  updated_at: Date;
  /** How many versions exist total (one per save). */
  version_count: number;
};

export type PromptTemplateVersionRow = {
  id: string;
  template_id: string;
  version: number;
  body: string;
  note: string | null;
  created_by_user_id: string | null;
  created_by_email: string | null;
  created_at: Date;
};

export async function listPromptTemplatesForProject(
  projectId: string
): Promise<PromptTemplateRow[]> {
  const rows = await sql<
    {
      id: string;
      project_id: string;
      name: string;
      current_version: number;
      description: string | null;
      current_body: string | null;
      created_at: Date;
      updated_at: Date;
      version_count: number;
    }[]
  >`
    SELECT
      t.id, t.project_id, t.name, t.current_version, t.description,
      cv.body AS current_body,
      t.created_at, t.updated_at,
      COALESCE(vc.c, 0)::int AS version_count
      FROM prompt_templates t
      LEFT JOIN prompt_template_versions cv
        ON cv.template_id = t.id AND cv.version = t.current_version
      LEFT JOIN (
        SELECT template_id, COUNT(*)::int AS c
          FROM prompt_template_versions
         GROUP BY template_id
      ) vc ON vc.template_id = t.id
     WHERE t.project_id = ${projectId}
     ORDER BY t.updated_at DESC
  `;
  return rows;
}

export async function getPromptTemplate(
  projectId: string,
  templateId: string
): Promise<PromptTemplateRow | null> {
  const rows = await sql<
    {
      id: string;
      project_id: string;
      name: string;
      current_version: number;
      description: string | null;
      current_body: string | null;
      created_at: Date;
      updated_at: Date;
      version_count: number;
    }[]
  >`
    SELECT
      t.id, t.project_id, t.name, t.current_version, t.description,
      cv.body AS current_body,
      t.created_at, t.updated_at,
      COALESCE(vc.c, 0)::int AS version_count
      FROM prompt_templates t
      LEFT JOIN prompt_template_versions cv
        ON cv.template_id = t.id AND cv.version = t.current_version
      LEFT JOIN (
        SELECT template_id, COUNT(*)::int AS c
          FROM prompt_template_versions
         GROUP BY template_id
      ) vc ON vc.template_id = t.id
     WHERE t.id = ${templateId} AND t.project_id = ${projectId}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listPromptTemplateVersions(
  templateId: string
): Promise<PromptTemplateVersionRow[]> {
  return sql<PromptTemplateVersionRow[]>`
    SELECT
      v.id, v.template_id, v.version, v.body, v.note,
      v.created_by_user_id, u.email AS created_by_email, v.created_at
      FROM prompt_template_versions v
      LEFT JOIN users u ON u.id = v.created_by_user_id
     WHERE v.template_id = ${templateId}
     ORDER BY v.version DESC
  `;
}

/**
 * Create a new template OR append a new version to an existing one in the
 * same project. Returns (template_id, version) — the caller redirects to
 * a detail page with these.
 *
 * The flow inside a single transaction:
 *   1. Upsert by (project_id, name). On INSERT we set current_version=1.
 *   2. Compute next version = MAX(version) + 1 (or 1 if first version).
 *   3. INSERT into prompt_template_versions.
 *   4. UPDATE current_version = new version + bump updated_at.
 *
 * `pg-promise`-style serialisation is provided by `sql.begin`.
 */
export async function upsertPromptTemplateVersion(args: {
  projectId: string;
  name: string;
  body: string;
  description: string | null;
  note: string | null;
  createdByUserId: string | null;
}): Promise<{ templateId: string; version: number }> {
  return sql.begin(async (tx) => {
    const existing = await tx<{ id: string }[]>`
      SELECT id FROM prompt_templates
       WHERE project_id = ${args.projectId} AND name = ${args.name}
       LIMIT 1
    `;
    let templateId: string;
    if (existing[0]) {
      templateId = existing[0].id;
      if (args.description != null) {
        await tx`
          UPDATE prompt_templates
             SET description = ${args.description}, updated_at = NOW()
           WHERE id = ${templateId}
        `;
      }
    } else {
      const created = await tx<{ id: string }[]>`
        INSERT INTO prompt_templates (project_id, name, description, current_version)
        VALUES (${args.projectId}, ${args.name}, ${args.description}, 1)
        RETURNING id
      `;
      templateId = created[0]!.id;
    }

    const maxV = await tx<{ m: number | null }[]>`
      SELECT MAX(version)::int AS m FROM prompt_template_versions
       WHERE template_id = ${templateId}
    `;
    const nextVersion = (maxV[0]?.m ?? 0) + 1;

    await tx`
      INSERT INTO prompt_template_versions (
        template_id, version, body, note, created_by_user_id
      ) VALUES (
        ${templateId}, ${nextVersion}, ${args.body}, ${args.note},
        ${args.createdByUserId}
      )
    `;
    await tx`
      UPDATE prompt_templates
         SET current_version = ${nextVersion}, updated_at = NOW()
       WHERE id = ${templateId}
    `;
    return { templateId, version: nextVersion };
  });
}

/**
 * Pin a template's `current_version` to an older version. Used for one-
 * click rollback from the version-history UI.
 */
export async function pinPromptTemplateVersion(
  projectId: string,
  templateId: string,
  version: number
): Promise<void> {
  await sql`
    UPDATE prompt_templates
       SET current_version = ${version}, updated_at = NOW()
     WHERE id = ${templateId} AND project_id = ${projectId}
       AND EXISTS (
         SELECT 1 FROM prompt_template_versions
          WHERE template_id = ${templateId} AND version = ${version}
       )
  `;
}

export async function deletePromptTemplate(
  projectId: string,
  templateId: string
): Promise<void> {
  await sql`
    DELETE FROM prompt_templates
     WHERE id = ${templateId} AND project_id = ${projectId}
  `;
}

// --- Organizations + RBAC + invitations (migration 011) ------------------

export type OrgRole = "owner" | "admin" | "member" | "viewer";
export type InviteRole = Exclude<OrgRole, "owner">;

export const ORG_ROLES: readonly OrgRole[] = [
  "owner",
  "admin",
  "member",
  "viewer",
] as const;
export const INVITE_ROLES: readonly InviteRole[] = [
  "admin",
  "member",
  "viewer",
] as const;

/** Capability matrix used by the dashboard's RBAC checks. */
export function canRoleManageMembers(role: OrgRole): boolean {
  return role === "owner" || role === "admin";
}
export function canRoleMutateResources(role: OrgRole): boolean {
  return role !== "viewer";
}
export function canRoleCreateProjects(role: OrgRole): boolean {
  return role === "owner" || role === "admin" || role === "member";
}

export type OrganizationRow = {
  id: string;
  name: string;
  slug: string | null;
  created_by_user_id: string;
  created_at: Date;
};

export type OrganizationMembershipRow = OrganizationRow & {
  role: OrgRole;
  joined_at: Date;
  member_count: number;
};

/** Memberships across all orgs the user belongs to (used by /organization picker). */
export async function listOrganizationsForUser(
  userId: string
): Promise<OrganizationMembershipRow[]> {
  return sql<OrganizationMembershipRow[]>`
    SELECT
      o.id, o.name, o.slug, o.created_by_user_id, o.created_at,
      m.role, m.joined_at,
      (SELECT COUNT(*)::int FROM organization_members
        WHERE organization_id = o.id) AS member_count
      FROM organizations o
      JOIN organization_members m ON m.organization_id = o.id
     WHERE m.user_id = ${userId}
     ORDER BY o.created_at ASC
  `;
}

/** Single-org variant — also asserts the user is a member. */
export async function getOrganizationForUser(
  userId: string,
  orgId: string
): Promise<OrganizationMembershipRow | null> {
  const rows = await sql<OrganizationMembershipRow[]>`
    SELECT
      o.id, o.name, o.slug, o.created_by_user_id, o.created_at,
      m.role, m.joined_at,
      (SELECT COUNT(*)::int FROM organization_members
        WHERE organization_id = o.id) AS member_count
      FROM organizations o
      JOIN organization_members m ON m.organization_id = o.id
     WHERE o.id = ${orgId} AND m.user_id = ${userId}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * UUID[] of organizations the user is a member of. Caller passes this to
 * the project-scope helper so org-shared projects are visible alongside
 * legacy user_id-owned ones.
 */
export async function listOrgIdsForUser(userId: string): Promise<string[]> {
  const rows = await sql<{ organization_id: string }[]>`
    SELECT organization_id FROM organization_members WHERE user_id = ${userId}
  `;
  return rows.map((r) => r.organization_id);
}

export type OrganizationMemberRow = {
  id: string;
  organization_id: string;
  user_id: string;
  email: string;
  name: string | null;
  role: OrgRole;
  invited_by_user_id: string | null;
  joined_at: Date;
};

export async function listOrganizationMembers(
  orgId: string
): Promise<OrganizationMemberRow[]> {
  return sql<OrganizationMemberRow[]>`
    SELECT m.id, m.organization_id, m.user_id, u.email, u.name,
           m.role, m.invited_by_user_id, m.joined_at
      FROM organization_members m
      JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = ${orgId}
     ORDER BY
       CASE m.role
         WHEN 'owner'  THEN 0
         WHEN 'admin'  THEN 1
         WHEN 'member' THEN 2
         WHEN 'viewer' THEN 3
       END,
       m.joined_at ASC
  `;
}

// --- Plan usage (read-only mirror of gateway's enforcement math) ----------
//
// The gateway does the real enforcement on every request via
// `getUserDailyMicroCents` + `getUserMonthlyRequestCount` (see
// apps/gateway/src/db.ts). These dashboard-side functions compute the
// same two numbers for the /billing usage meter — showing the customer
// what the gateway would see if a request landed right now.
//
// Kept intentionally separate from the gateway helpers (rather than
// reused via a shared module) because this path doesn't share the hot-
// path postgres connection and because its failure mode is different:
// if this returns 0 because the DB flaked, the billing page gracefully
// degrades; if the gateway-side helper failed the request would 500.

export async function getUserPlanUsageSnapshot(userId: string): Promise<{
  daily_spent_micro_cents: number;
  monthly_request_count: number;
}> {
  const [spendRows, countRows] = await Promise.all([
    sql<{ total: string }[]>`
      SELECT COALESCE(SUM(r.cost_micro_cents), 0)::bigint AS total
        FROM requests r
        JOIN projects p ON p.id = r.project_id
       WHERE p.user_id = ${userId}
         AND r.status = 'success'
         AND r.created_at > NOW() - INTERVAL '24 hours'
    `,
    sql<{ total: string }[]>`
      SELECT COUNT(*)::bigint AS total
        FROM requests r
        JOIN projects p ON p.id = r.project_id
       WHERE p.user_id = ${userId}
         AND r.status = 'success'
         AND r.created_at > NOW() - INTERVAL '30 days'
    `,
  ]);
  return {
    daily_spent_micro_cents: Number(spendRows[0]?.total ?? 0),
    monthly_request_count: Number(countRows[0]?.total ?? 0),
  };
}

/**
 * Look up the plan of the user who currently holds the `owner` role on
 * an org. Used by entitlement gates (seat limit, SAML configure) where
 * the payer-of-record is the owner, not the caller — a Team-plan admin
 * inviting a new member is bounded by the owner's 5-seat Team tier,
 * not the admin's own plan.
 *
 * Returns `null` when the org has no owner (shouldn't happen — we
 * prevent removing the last owner at the DB layer — but the caller
 * should treat null as "Free tier" for safety).
 */
export async function getOrgOwnerPlan(
  orgId: string
): Promise<string | null> {
  const rows = await sql<{ plan: string | null }[]>`
    SELECT u.plan
      FROM organization_members m
      JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = ${orgId} AND m.role = 'owner'
     LIMIT 1
  `;
  return rows[0]?.plan ?? null;
}

/**
 * Count of members + unexpired pending invitations combined — the
 * "seats already committed" number an entitlement gate compares against
 * the owner's plan's seat limit. Counting pending invites is the
 * correct behavior: a 4-member org that has issued 3 more invites has
 * effectively consumed 7 of its Team 5-seat limit.
 */
export async function countOrgSeatsInUse(orgId: string): Promise<number> {
  const rows = await sql<{ total: number }[]>`
    SELECT
      ((SELECT COUNT(*) FROM organization_members
         WHERE organization_id = ${orgId}) +
       (SELECT COUNT(*) FROM organization_invitations
         WHERE organization_id = ${orgId}
           AND accepted_at IS NULL
           AND expires_at > NOW()))::int AS total
  `;
  return rows[0]?.total ?? 0;
}

/** Create a new org owned by `userId` (transactionally). */
export async function createOrganization(
  userId: string,
  name: string
): Promise<OrganizationRow> {
  return sql.begin(async (tx) => {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    const created = await tx<OrganizationRow[]>`
      INSERT INTO organizations (name, slug, created_by_user_id)
      VALUES (${name}, ${slug || null}, ${userId})
      RETURNING id, name, slug, created_by_user_id, created_at
    `;
    const org = created[0]!;
    await tx`
      INSERT INTO organization_members (organization_id, user_id, role, invited_by_user_id)
      VALUES (${org.id}, ${userId}, 'owner', ${userId})
    `;
    return org;
  });
}

export async function getMemberRole(
  userId: string,
  orgId: string
): Promise<OrgRole | null> {
  const rows = await sql<{ role: OrgRole }[]>`
    SELECT role FROM organization_members
     WHERE user_id = ${userId} AND organization_id = ${orgId}
     LIMIT 1
  `;
  return rows[0]?.role ?? null;
}

/**
 * Update a member's role. Refuses to demote the owner (only owners can
 * transfer ownership via a separate transferOrganizationOwnership flow).
 */
export async function updateMemberRole(
  orgId: string,
  memberId: string,
  newRole: InviteRole
): Promise<void> {
  await sql`
    UPDATE organization_members
       SET role = ${newRole}
     WHERE id = ${memberId}
       AND organization_id = ${orgId}
       AND role <> 'owner'
  `;
}

/** Remove a member. Refuses to remove the owner. */
export async function removeOrganizationMember(
  orgId: string,
  memberId: string
): Promise<void> {
  await sql`
    DELETE FROM organization_members
     WHERE id = ${memberId}
       AND organization_id = ${orgId}
       AND role <> 'owner'
  `;
}

// --- Billing-transfer intents (A5 follow-up) ------------------------------
//
// State machine:
//   created → completed (Stripe webhook when new owner subs)
//   created → cancelled (UI button on either side)
//   created → (silently inert at expires_at)

export type BillingTransferIntentRow = {
  id: string;
  organization_id: string;
  organization_name: string;
  from_user_id: string;
  from_email: string;
  to_user_id: string;
  to_email: string;
  note: string | null;
  created_at: Date;
  expires_at: Date;
  completed_at: Date | null;
  cancelled_at: Date | null;
  cancelled_by_user_id: string | null;
  from_stripe_subscription_id: string | null;
};

export async function createBillingTransferIntent(args: {
  organizationId: string;
  fromUserId: string;
  toUserId: string;
  note?: string | null;
  fromStripeSubscriptionId?: string | null;
}): Promise<{ ok: true; intent: BillingTransferIntentRow } | { ok: false; reason: "already_pending" }> {
  // Migration 016 can't put `expires_at > NOW()` in the partial-unique
  // predicate (NOW() isn't IMMUTABLE — Postgres rejects it). So the
  // DB sees any un-completed, un-cancelled row as "pending", even if
  // it's effectively stale. Before inserting a new intent we flip
  // any stale row (expired AND untouched) to cancelled so the user
  // can always make a fresh attempt. `cancelled_by_user_id = NULL`
  // flags this as a system-side cancellation (distinct from a human
  // clicking the Cancel button).
  await sql`
    UPDATE billing_transfer_intents
       SET cancelled_at = NOW(),
           cancelled_by_user_id = NULL
     WHERE organization_id = ${args.organizationId}
       AND completed_at IS NULL
       AND cancelled_at IS NULL
       AND expires_at <= NOW()
  `;

  try {
    const rows = await sql<BillingTransferIntentRow[]>`
      INSERT INTO billing_transfer_intents (
        organization_id, from_user_id, to_user_id, note,
        from_stripe_subscription_id
      ) VALUES (
        ${args.organizationId}, ${args.fromUserId}, ${args.toUserId},
        ${args.note ?? null}, ${args.fromStripeSubscriptionId ?? null}
      )
      RETURNING
        id, organization_id,
        ${""} AS organization_name,
        from_user_id,
        ${""} AS from_email,
        to_user_id,
        ${""} AS to_email,
        note, created_at, expires_at, completed_at, cancelled_at,
        cancelled_by_user_id, from_stripe_subscription_id
    `;
    return { ok: true as const, intent: rows[0]! };
  } catch (err) {
    // Unique constraint violation = there's a still-live pending
    // intent (not yet expired OR expired but not yet stale-cancelled
    // above because a concurrent caller got there first).
    if (err instanceof Error && /duplicate key|unique/i.test(err.message)) {
      return { ok: false as const, reason: "already_pending" as const };
    }
    throw err;
  }
}

export async function listBillingTransferIntentsForUser(
  userId: string
): Promise<BillingTransferIntentRow[]> {
  return sql<BillingTransferIntentRow[]>`
    SELECT i.id, i.organization_id, o.name AS organization_name,
           i.from_user_id, fu.email AS from_email,
           i.to_user_id,   tu.email AS to_email,
           i.note, i.created_at, i.expires_at, i.completed_at,
           i.cancelled_at, i.cancelled_by_user_id,
           i.from_stripe_subscription_id
      FROM billing_transfer_intents i
      JOIN organizations o ON o.id = i.organization_id
      LEFT JOIN users fu ON fu.id = i.from_user_id
      LEFT JOIN users tu ON tu.id = i.to_user_id
     WHERE (i.from_user_id = ${userId} OR i.to_user_id = ${userId})
       AND i.completed_at IS NULL
       AND i.cancelled_at IS NULL
       AND i.expires_at > NOW()
     ORDER BY i.created_at DESC
  `;
}

export async function cancelBillingTransferIntent(args: {
  intentId: string;
  byUserId: string;
}): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE billing_transfer_intents
       SET cancelled_at = NOW(),
           cancelled_by_user_id = ${args.byUserId}
     WHERE id = ${args.intentId}
       AND (from_user_id = ${args.byUserId} OR to_user_id = ${args.byUserId})
       AND completed_at IS NULL
       AND cancelled_at IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

/**
 * Atomic ownership transfer. The current owner becomes `admin`; the
 * designated successor (must already be a member) becomes `owner`.
 *
 * This is the in-product path that replaces the old "CLI-only" note
 * and removes the 2am-enterprise-support landmine where the sole
 * owner leaves and nobody can touch the org. Safety guardrails:
 *
 *   - Both rows are mutated inside one TX so there's never a moment
 *     with zero or two owners.
 *   - Successor must exist in this org AND not already be the owner.
 *   - The billing-of-record stays on the OLD owner's user row (their
 *     Stripe subscription IS the one paying for the org). Changing
 *     who Stripe bills is a separate "update payment method" step
 *     the new owner would do via the billing portal — we don't try
 *     to do it implicitly here.
 *
 * Returns:
 *   - { ok: true }                       on success
 *   - { ok: false, reason: "not_owner" } caller is not the owner
 *   - { ok: false, reason: "no_successor" } successor not a member here
 *   - { ok: false, reason: "same_user" } successor IS the current owner
 */
export async function transferOrganizationOwnership(args: {
  orgId: string;
  currentOwnerUserId: string;
  successorUserId: string;
}): Promise<
  | { ok: true }
  | { ok: false; reason: "not_owner" | "no_successor" | "same_user" }
> {
  if (args.currentOwnerUserId === args.successorUserId) {
    return { ok: false, reason: "same_user" };
  }
  return sql.begin(async (tx) => {
    const ownerRows = await tx<{ role: OrgRole }[]>`
      SELECT role FROM organization_members
       WHERE organization_id = ${args.orgId}
         AND user_id = ${args.currentOwnerUserId}
       LIMIT 1
    `;
    if (ownerRows[0]?.role !== "owner") {
      return { ok: false, reason: "not_owner" as const };
    }
    const successorRows = await tx<{ role: OrgRole }[]>`
      SELECT role FROM organization_members
       WHERE organization_id = ${args.orgId}
         AND user_id = ${args.successorUserId}
       LIMIT 1
    `;
    if (!successorRows[0]) {
      return { ok: false, reason: "no_successor" as const };
    }

    // Demote current owner to admin first (so the `role <> 'owner'`
    // safeguards elsewhere still hold during the swap), then promote
    // the successor. Both writes inside the same tx.
    await tx`
      UPDATE organization_members
         SET role = 'admin'
       WHERE organization_id = ${args.orgId}
         AND user_id = ${args.currentOwnerUserId}
    `;
    await tx`
      UPDATE organization_members
         SET role = 'owner'
       WHERE organization_id = ${args.orgId}
         AND user_id = ${args.successorUserId}
    `;
    return { ok: true as const };
  });
}

export type OrganizationInvitationRow = {
  id: string;
  organization_id: string;
  organization_name: string;
  email: string;
  role: InviteRole;
  token: string;
  invited_by_user_id: string | null;
  invited_by_email: string | null;
  expires_at: Date;
  accepted_at: Date | null;
  created_at: Date;
};

/** All pending (un-accepted, un-expired) invitations for an org — admin UI. */
export async function listOrganizationInvitations(
  orgId: string
): Promise<OrganizationInvitationRow[]> {
  return sql<OrganizationInvitationRow[]>`
    SELECT i.id, i.organization_id, o.name AS organization_name,
           i.email, i.role, i.token,
           i.invited_by_user_id, u.email AS invited_by_email,
           i.expires_at, i.accepted_at, i.created_at
      FROM organization_invitations i
      JOIN organizations o ON o.id = i.organization_id
      LEFT JOIN users u ON u.id = i.invited_by_user_id
     WHERE i.organization_id = ${orgId}
       AND i.accepted_at IS NULL
       AND i.expires_at > NOW()
     ORDER BY i.created_at DESC
  `;
}

/** Pending invitations the current viewer can accept (by email). */
export async function listPendingInvitationsForEmail(
  email: string
): Promise<OrganizationInvitationRow[]> {
  return sql<OrganizationInvitationRow[]>`
    SELECT i.id, i.organization_id, o.name AS organization_name,
           i.email, i.role, i.token,
           i.invited_by_user_id, u.email AS invited_by_email,
           i.expires_at, i.accepted_at, i.created_at
      FROM organization_invitations i
      JOIN organizations o ON o.id = i.organization_id
      LEFT JOIN users u ON u.id = i.invited_by_user_id
     WHERE LOWER(i.email) = LOWER(${email})
       AND i.accepted_at IS NULL
       AND i.expires_at > NOW()
     ORDER BY i.created_at DESC
  `;
}

export async function findInvitationByToken(
  token: string
): Promise<OrganizationInvitationRow | null> {
  const rows = await sql<OrganizationInvitationRow[]>`
    SELECT i.id, i.organization_id, o.name AS organization_name,
           i.email, i.role, i.token,
           i.invited_by_user_id, u.email AS invited_by_email,
           i.expires_at, i.accepted_at, i.created_at
      FROM organization_invitations i
      JOIN organizations o ON o.id = i.organization_id
      LEFT JOIN users u ON u.id = i.invited_by_user_id
     WHERE i.token = ${token}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Refresh an existing unused invitation: bump `expires_at` to now+TTL,
 * leave the `token` untouched so previously-emailed accept links keep
 * working. Returns the updated row so the caller can re-send the email
 * with the same token.
 *
 * Used by the "Resend invitation" button on /organization/[id]. Sending
 * the same token again is safer than rotating — if the invitee already
 * clicked the original link they're in-flight on it, and a new token
 * would 404 them.
 *
 * Only operates on unexpired-and-unaccepted invites; a caller asking
 * to resend an already-accepted or deleted invite gets `null`.
 */
export async function refreshInvitationExpiry(args: {
  orgId: string;
  invitationId: string;
  ttlDays: number;
}): Promise<OrganizationInvitationRow | null> {
  const rows = await sql<OrganizationInvitationRow[]>`
    UPDATE organization_invitations
       SET expires_at = NOW() + (${args.ttlDays} || ' days')::INTERVAL
     WHERE id = ${args.invitationId}
       AND organization_id = ${args.orgId}
       AND accepted_at IS NULL
    RETURNING id, organization_id, ${""} AS organization_name, email, role,
              token, invited_by_user_id, ${""} AS invited_by_email,
              expires_at, accepted_at, created_at
  `;
  return rows[0] ?? null;
}

export async function createOrganizationInvitation(args: {
  orgId: string;
  email: string;
  role: InviteRole;
  invitedByUserId: string;
  token: string;
  ttlDays: number;
}): Promise<OrganizationInvitationRow> {
  const rows = await sql<OrganizationInvitationRow[]>`
    INSERT INTO organization_invitations (
      organization_id, email, role, token,
      invited_by_user_id, expires_at
    ) VALUES (
      ${args.orgId}, ${args.email.trim().toLowerCase()}, ${args.role}, ${args.token},
      ${args.invitedByUserId},
      NOW() + (${args.ttlDays} || ' days')::INTERVAL
    )
    RETURNING id, organization_id, ${""} AS organization_name, email, role,
              token, invited_by_user_id, ${""} AS invited_by_email,
              expires_at, accepted_at, created_at
  `;
  return rows[0]!;
}

export async function deleteInvitation(
  orgId: string,
  invitationId: string
): Promise<void> {
  await sql`
    DELETE FROM organization_invitations
     WHERE id = ${invitationId}
       AND organization_id = ${orgId}
       AND accepted_at IS NULL
  `;
}

/**
 * Atomically: stamp accepted_at + insert a member row. Idempotent — if
 * the user is already a member, we just stamp and skip the insert (no
 * duplicate row).
 */
export async function acceptInvitation(args: {
  invitationId: string;
  userId: string;
}): Promise<{ orgId: string; role: InviteRole } | null> {
  return sql.begin(async (tx) => {
    const rows = await tx<
      { id: string; organization_id: string; role: InviteRole; email: string }[]
    >`
      SELECT id, organization_id, role, email
        FROM organization_invitations
       WHERE id = ${args.invitationId}
         AND accepted_at IS NULL
         AND expires_at > NOW()
       FOR UPDATE
    `;
    const inv = rows[0];
    if (!inv) return null;

    await tx`
      INSERT INTO organization_members (organization_id, user_id, role, invited_by_user_id)
      VALUES (${inv.organization_id}, ${args.userId}, ${inv.role}, NULL)
      ON CONFLICT (organization_id, user_id) DO NOTHING
    `;
    await tx`
      UPDATE organization_invitations
         SET accepted_at = NOW()
       WHERE id = ${inv.id}
    `;
    return { orgId: inv.organization_id, role: inv.role };
  });
}

/**
 * Transfer a project's ownership from a personal user to an organization.
 * Caller verifies the user owns the project + is an org admin/owner.
 */
export async function attachProjectToOrganization(
  projectId: string,
  orgId: string
): Promise<void> {
  await sql`
    UPDATE projects
       SET organization_id = ${orgId}, user_id = NULL
     WHERE id = ${projectId}
  `;
}

// --- SSO / SAML (migration 012) ------------------------------------------
// (import for OrgSamlConfig hoisted to the top of this file)

/**
 * Org SAML config + the user-facing org name in one query — used by
 * every /sso/saml/* endpoint to either render an error ("SAML disabled
 * for this org") or hand off to samlify.
 */
export async function getOrgSamlConfig(
  orgId: string
): Promise<OrgSamlConfig | null> {
  // Pre-validate UUID shape so a garbled `?org=不存在的id` is treated as
  // "not found" instead of crashing the route with Postgres'
  // `invalid input syntax for type uuid`. This keeps the SAML metadata
  // / login routes returning clean 404s for any unrecognised ID.
  if (!UUID_RE.test(orgId)) return null;
  const rows = await sql<
    Array<{
      id: string;
      name: string;
      saml_idp_metadata_xml: string | null;
      saml_idp_entity_id: string | null;
      saml_idp_sso_url: string | null;
      saml_idp_x509_cert: string | null;
      saml_email_domain: string | null;
      saml_enforcement_mode: "off" | "optional" | "required" | null;
      saml_default_role: "admin" | "member" | "viewer" | null;
    }>
  >`
    SELECT id, name,
           saml_idp_metadata_xml, saml_idp_entity_id, saml_idp_sso_url,
           saml_idp_x509_cert, saml_email_domain, saml_enforcement_mode,
           saml_default_role
      FROM organizations
     WHERE id = ${orgId}
     LIMIT 1
  `;
  const r = rows[0];
  if (!r) return null;
  return {
    organization_id: r.id,
    organization_name: r.name,
    saml_idp_metadata_xml: r.saml_idp_metadata_xml,
    saml_idp_entity_id: r.saml_idp_entity_id,
    saml_idp_sso_url: r.saml_idp_sso_url,
    saml_idp_x509_cert: r.saml_idp_x509_cert,
    saml_email_domain: r.saml_email_domain,
    saml_enforcement_mode: r.saml_enforcement_mode ?? "off",
    saml_default_role: r.saml_default_role ?? "member",
  };
}

/**
 * UUID v4-shape regex (8-4-4-4-12 hex). Used to pre-validate caller-
 * supplied `org` query params on the SAML routes so a garbled value
 * doesn't reach Postgres and trip its strict UUID cast.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Domain-based lookup driving the /login redirect. When a user types
 * `alice@acme.com` and Acme has SAML configured + enforcement >= 'optional',
 * we route them through SSO instead of mailing an OTP.
 */
export async function findOrgByEmailDomain(
  domain: string
): Promise<OrgSamlConfig | null> {
  const lc = domain.trim().toLowerCase();
  if (!lc) return null;
  const rows = await sql<
    Array<{
      id: string;
      name: string;
      saml_idp_metadata_xml: string | null;
      saml_idp_entity_id: string | null;
      saml_idp_sso_url: string | null;
      saml_idp_x509_cert: string | null;
      saml_email_domain: string | null;
      saml_enforcement_mode: "off" | "optional" | "required" | null;
      saml_default_role: "admin" | "member" | "viewer" | null;
    }>
  >`
    SELECT id, name,
           saml_idp_metadata_xml, saml_idp_entity_id, saml_idp_sso_url,
           saml_idp_x509_cert, saml_email_domain, saml_enforcement_mode,
           saml_default_role
      FROM organizations
     WHERE LOWER(saml_email_domain) = ${lc}
       AND saml_enforcement_mode IN ('optional', 'required')
     LIMIT 1
  `;
  const r = rows[0];
  if (!r) return null;
  return {
    organization_id: r.id,
    organization_name: r.name,
    saml_idp_metadata_xml: r.saml_idp_metadata_xml,
    saml_idp_entity_id: r.saml_idp_entity_id,
    saml_idp_sso_url: r.saml_idp_sso_url,
    saml_idp_x509_cert: r.saml_idp_x509_cert,
    saml_email_domain: r.saml_email_domain,
    saml_enforcement_mode: r.saml_enforcement_mode ?? "off",
    saml_default_role: r.saml_default_role ?? "member",
  };
}

/**
 * Persist (or wipe) an org's IdP configuration. Called from the org
 * admin UI; `clearXml` lets the admin remove a stale metadata blob in
 * favor of manual entity_id/sso_url/cert.
 */
export async function updateOrgSamlConfig(
  orgId: string,
  patch: Partial<{
    saml_enforcement_mode: "off" | "optional" | "required";
    saml_email_domain: string | null;
    saml_default_role: "admin" | "member" | "viewer";
    saml_idp_metadata_xml: string | null;
    saml_idp_entity_id: string | null;
    saml_idp_sso_url: string | null;
    saml_idp_x509_cert: string | null;
  }>
): Promise<void> {
  // Build dynamic SET clause to only touch fields the caller specified
  // (distinguishes "unset to null" from "leave unchanged"). Postgres.js
  // tagged template doesn't support direct dynamic SETs, so we shell out
  // to sql.unsafe for the column list (safe because keys come from the
  // hardcoded type union, not user input).
  const updates: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!ALLOWED_SAML_COLS.has(k)) continue;
    params.push(v);
    updates.push(`${k} = $${params.length}`);
  }
  if (updates.length === 0) return;
  params.push(orgId);
  const stmt = `
    UPDATE organizations SET ${updates.join(", ")}, updated_at = NOW()
     WHERE id = $${params.length}
  `;
  await sql.unsafe(stmt, params as Parameters<typeof sql.unsafe>[1]);
}

const ALLOWED_SAML_COLS = new Set([
  "saml_enforcement_mode",
  "saml_email_domain",
  "saml_default_role",
  "saml_idp_metadata_xml",
  "saml_idp_entity_id",
  "saml_idp_sso_url",
  "saml_idp_x509_cert",
]);

/**
 * Attempt to record a SAMLResponse's assertion ID. Returns true on
 * insert (first time we've seen this ID), false on duplicate (replay).
 * The unique index does the heavy lifting; we swallow the duplicate-key
 * error.
 */
export async function recordConsumedAssertion(
  orgId: string,
  assertionId: string,
  notOnOrAfter: Date
): Promise<boolean> {
  try {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO saml_consumed_assertions
        (organization_id, assertion_id, not_on_or_after)
      VALUES (${orgId}, ${assertionId}, ${notOnOrAfter.toISOString()})
      ON CONFLICT (organization_id, assertion_id) DO NOTHING
      RETURNING id
    `;
    return rows.length > 0;
  } catch (err) {
    console.error("[saml] recordConsumedAssertion failed:", err);
    return false;
  }
}

/**
 * Find-or-create the user, link them to the org via SSO subject, mint
 * an `organization_members` row at the configured default role on first
 * login. Idempotent — repeated SSO logins update sso_last_login_at + the
 * sso_organization_id pointer without touching the membership row.
 *
 * Returns the user (existing or freshly created) so the caller can mint
 * a session cookie.
 */
export async function provisionSsoUser(args: {
  email: string;
  ssoSubject: string;
  organizationId: string;
  defaultRole: "admin" | "member" | "viewer";
}): Promise<{ id: string; email: string; created: boolean; promotedToMember: boolean }> {
  return sql.begin(async (tx) => {
    // 1. Find-or-create user.
    const existing = await tx<{ id: string; email: string }[]>`
      SELECT id, email FROM users WHERE LOWER(email) = ${args.email.toLowerCase()}
       LIMIT 1
    `;
    let userId: string;
    let created = false;
    if (existing[0]) {
      userId = existing[0].id;
    } else {
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO users (email) VALUES (${args.email})
        RETURNING id
      `;
      userId = inserted[0]!.id;
      created = true;
    }

    // 2. Stamp SSO linkage.
    await tx`
      UPDATE users
         SET sso_subject = ${args.ssoSubject},
             sso_organization_id = ${args.organizationId},
             sso_last_login_at = NOW()
       WHERE id = ${userId}
    `;

    // 3. JIT membership at the org's default role. ON CONFLICT keeps
    // the existing role intact so an admin can elevate a user without
    // SSO undoing it on the next login.
    const existingMember = await tx<{ role: string }[]>`
      SELECT role FROM organization_members
       WHERE organization_id = ${args.organizationId} AND user_id = ${userId}
    `;
    let promotedToMember = false;
    if (!existingMember[0]) {
      await tx`
        INSERT INTO organization_members (organization_id, user_id, role)
        VALUES (${args.organizationId}, ${userId}, ${args.defaultRole})
      `;
      promotedToMember = true;
    }
    return {
      id: userId,
      email: args.email,
      created,
      promotedToMember,
    };
  });
}
