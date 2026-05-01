/**
 * Read-side helpers for the per-project policy changelog.
 *
 * All queries here go through the existing project-scoped sql client.
 * Authorization happens at the page layer (only the project's owner +
 * org admins can see a project, so reading its policy history is the
 * same security boundary). We intentionally don't return the full
 * payload by default — a single policy JSON is several KB and the
 * changelog page only needs the metadata + notes summary. The version
 * detail page asks for `payload` explicitly.
 */

import { sql } from "./db";

export type PolicyStatus = "pending" | "active" | "superseded" | "rejected";
export type PolicySource = "retrain" | "manual" | "rollback" | "baseline";

export type ProjectPolicyRow = {
  id: string;
  project_id: string;
  version: number;
  status: PolicyStatus;
  source: PolicySource;
  sample_count: number;
  notes: string | null;
  generated_at: Date;
  activated_at: Date | null;
};

export type ProjectPolicyDetail = ProjectPolicyRow & {
  payload: unknown;
};

/**
 * List the most recent N policy versions for a project, newest first.
 * Default 50 — generous for a 6-month-old project on a daily cron and
 * still cheap to render in one table.
 */
export async function listProjectPolicies(
  projectId: string,
  limit = 50
): Promise<ProjectPolicyRow[]> {
  return sql<ProjectPolicyRow[]>`
    SELECT id, project_id, version, status, source, sample_count, notes,
           generated_at, activated_at
    FROM project_policies
    WHERE project_id = ${projectId}
    ORDER BY version DESC
    LIMIT ${limit}
  `;
}

/**
 * Fetch one policy version including the full payload. Used by the
 * detail / diff page — never on a list view because the JSON gets
 * fat as the policy grows.
 */
export async function getProjectPolicy(
  projectId: string,
  version: number
): Promise<ProjectPolicyDetail | null> {
  const rows = await sql<ProjectPolicyDetail[]>`
    SELECT id, project_id, version, status, source, sample_count, notes,
           generated_at, activated_at, payload
    FROM project_policies
    WHERE project_id = ${projectId} AND version = ${version}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Quick boolean — does this project have any policy history yet?
 * Used to show a friendly "you haven't trained anything yet" empty
 * state without rendering an empty table.
 */
export async function projectHasPolicyHistory(
  projectId: string
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM project_policies WHERE project_id = ${projectId}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

/**
 * Aggregate the upstream cost spent on shadow A/B calls for this
 * project, broken into "current calendar month" and "current 30-day
 * window" totals — both surfaces matter to a finance-aware buyer:
 *
 *   - Calendar-month total maps to a Stripe-style invoice period.
 *   - 30-day rolling shows trend independent of where in the month
 *     we currently are.
 *
 * The sample-count returns alongside so the dashboard can show a
 * "X shadow calls last month, $Y total" snippet — i.e. a unit-cost
 * estimate that helps the operator sanity-check whether learning
 * mode is paying for itself.
 *
 * Costs come from `ab_results.shadow_cost_micro_cents`, which is
 * exactly what we (the gateway) computed from the upstream provider's
 * usage block at the time the shadow call returned. Same units the
 * existing routing-savings card uses, so the operator's mental model
 * stays consistent across cards.
 */
export type LearningCostSummary = {
  /** Sum of shadow cost in micro_cents this calendar month. */
  month_to_date_uc: bigint;
  month_to_date_calls: number;
  /** Sum of shadow cost in micro_cents over the trailing 30 days. */
  trailing_30d_uc: bigint;
  trailing_30d_calls: number;
  /** Most recent shadow row, for "last activity" surfacing. */
  last_shadow_at: Date | null;
  /**
   * Daily shadow cost (in micro_cents) over the trailing 30 days,
   * oldest → newest. Always exactly 30 entries — gap-filled with 0
   * on quiet days so the sparkline draws a continuous line. The
   * dashboard renders this as the trend strip in `LearningCostCard`.
   */
  trailing_30d_daily_uc: number[];
};

export async function getLearningCostSummary(
  projectId: string
): Promise<LearningCostSummary> {
  // Two windows in one round-trip via FILTER, so the dashboard card
  // doesn't pay for two separate seq scans of ab_results.
  // Note bigint — 30 days × millions of shadow calls × hundreds of
  // micro_cents each can overflow JS numbers. postgres.js returns
  // bigint here when the SQL declares it, which we explicitly do
  // via `::bigint` so a value inside JS Number's safe range still
  // arrives as bigint for shape-stability.
  const summaryRowsP = sql<
    {
      month_to_date_uc: string | null;
      month_to_date_calls: string | null;
      trailing_30d_uc: string | null;
      trailing_30d_calls: string | null;
      last_shadow_at: Date | null;
    }[]
  >`
    SELECT
      COALESCE(
        SUM(shadow_cost_micro_cents)
          FILTER (WHERE created_at >= date_trunc('month', NOW())),
        0
      )::bigint AS month_to_date_uc,
      COALESCE(
        COUNT(*)
          FILTER (WHERE created_at >= date_trunc('month', NOW())),
        0
      )::bigint AS month_to_date_calls,
      COALESCE(
        SUM(shadow_cost_micro_cents)
          FILTER (WHERE created_at > NOW() - INTERVAL '30 days'),
        0
      )::bigint AS trailing_30d_uc,
      COALESCE(
        COUNT(*)
          FILTER (WHERE created_at > NOW() - INTERVAL '30 days'),
        0
      )::bigint AS trailing_30d_calls,
      MAX(created_at) AS last_shadow_at
    FROM ab_results
    WHERE project_id = ${projectId}
  `;

  // Daily breakdown for the sparkline. We `generate_series()` a 30-day
  // calendar and LEFT JOIN ab_results, so quiet days emit a literal 0
  // instead of being missing — keeps the sparkline a continuous line.
  // Day key uses date_trunc so DST transitions don't create 25-hour or
  // 23-hour days (everything's UTC at the storage layer anyway).
  const dailyRowsP = sql<{ day: Date; cost_uc: string | null }[]>`
    WITH days AS (
      SELECT generate_series(
        date_trunc('day', NOW() - INTERVAL '29 days'),
        date_trunc('day', NOW()),
        INTERVAL '1 day'
      ) AS day
    )
    SELECT
      d.day,
      COALESCE(SUM(ab.shadow_cost_micro_cents), 0)::bigint AS cost_uc
    FROM days d
    LEFT JOIN ab_results ab
      ON ab.project_id = ${projectId}
     AND date_trunc('day', ab.created_at) = d.day
    GROUP BY d.day
    ORDER BY d.day ASC
  `;

  const [summaryRows, dailyRows] = await Promise.all([
    summaryRowsP,
    dailyRowsP,
  ]);

  const r = summaryRows[0];
  // bigint → number for the sparkline. Even on a heavy day a single
  // project's daily shadow cost won't exceed Number.MAX_SAFE_INTEGER
  // (which is ~$90B in micro_cents). The bigint is for SUM precision
  // in pg, not for value range here.
  const trailing_30d_daily_uc = dailyRows.map((row) =>
    Number(row.cost_uc ?? 0)
  );
  return {
    month_to_date_uc: BigInt(r?.month_to_date_uc ?? 0),
    month_to_date_calls: Number(r?.month_to_date_calls ?? 0),
    trailing_30d_uc: BigInt(r?.trailing_30d_uc ?? 0),
    trailing_30d_calls: Number(r?.trailing_30d_calls ?? 0),
    last_shadow_at: r?.last_shadow_at ?? null,
    trailing_30d_daily_uc,
  };
}

/**
 * One-glance summary of a project's policy state, intended for the
 * project home page mini-card. Returns ALL the data the card needs in
 * one round-trip so a user opening their project doesn't pay for two
 * sequential queries on the critical above-the-fold path.
 *
 * Shape choices:
 *   - `active_version` is null for a fresh project that's never been
 *     trained — the card uses that to render an "shipped baseline"
 *     state instead of a "v?" stub.
 *   - `routing_savings_30d_uc` and `cache_savings_30d_uc` come straight
 *     from the `requests` ledger (not ab_results). They tell the
 *     "what did this policy actually save me" story; the cost card on
 *     /projects/<id>/policy still owns the "what did training itself
 *     cost" half.
 *   - `learning_enabled` rides along so the card can render
 *     "(paused)" / "(learning)" without a second query.
 */
export type ProjectPolicySummary = {
  active_version: number | null;
  active_sample_count: number;
  active_activated_at: Date | null;
  /** Has any per-project policy ever been promoted? Distinguishes "fresh project" from "learning paused". */
  has_history: boolean;
  learning_enabled: boolean;
  /** Sum of routing-saved micro_cents over the trailing 30 days. */
  routing_savings_30d_uc: bigint;
  /** Sum of cache-saved micro_cents over the trailing 30 days. */
  cache_savings_30d_uc: bigint;
};

export async function getProjectPolicySummary(
  projectId: string
): Promise<ProjectPolicySummary> {
  const policyRowsP = sql<
    {
      version: number | null;
      sample_count: number | null;
      activated_at: Date | null;
      has_history: boolean;
    }[]
  >`
    SELECT
      (SELECT version       FROM project_policies WHERE project_id = ${projectId} AND status = 'active' AND tag IS NULL LIMIT 1) AS version,
      (SELECT sample_count  FROM project_policies WHERE project_id = ${projectId} AND status = 'active' AND tag IS NULL LIMIT 1) AS sample_count,
      (SELECT activated_at  FROM project_policies WHERE project_id = ${projectId} AND status = 'active' AND tag IS NULL LIMIT 1) AS activated_at,
      EXISTS (SELECT 1 FROM project_policies WHERE project_id = ${projectId}) AS has_history
  `;
  const flagP = sql<{ learning_enabled: boolean | null }[]>`
    SELECT learning_enabled FROM projects WHERE id = ${projectId}
  `;
  // Routing + cache savings columns are already on the requests table
  // (see migration 005 + 002). One scan, two SUMs — partial index
  // `idx_requests_routing_saving_created` handles the routing one.
  const savingsP = sql<
    {
      routing_savings_30d: string | null;
      cache_savings_30d: string | null;
    }[]
  >`
    SELECT
      COALESCE(SUM(routing_saving_micro_cents), 0)::bigint AS routing_savings_30d,
      COALESCE(SUM(cache_savings_micro_cents),  0)::bigint AS cache_savings_30d
    FROM requests
    WHERE project_id = ${projectId}
      AND created_at > NOW() - INTERVAL '30 days'
  `;

  const [policyRows, flagRows, savingsRows] = await Promise.all([
    policyRowsP,
    flagP,
    savingsP,
  ]);

  const p = policyRows[0];
  const s = savingsRows[0];
  return {
    active_version: p?.version ?? null,
    active_sample_count: Number(p?.sample_count ?? 0),
    active_activated_at: p?.activated_at ?? null,
    has_history: Boolean(p?.has_history),
    learning_enabled: Boolean(flagRows[0]?.learning_enabled),
    routing_savings_30d_uc: BigInt(s?.routing_savings_30d ?? 0),
    cache_savings_30d_uc: BigInt(s?.cache_savings_30d ?? 0),
  };
}

/**
 * Render a micro_cents value (`bigint`) as a US-dollar string with
 * the right precision for the magnitude. Tiny totals (< $1) get
 * 4 decimals so an operator sees the actual fraction; everything
 * else rounds to 2.
 */
export function fmtMicroCentsUsd(uc: bigint): string {
  // 1 USD = 100,000 micro_cents (1 cent = 1000 micro_cents).
  // Convert via Number — JS Number is precise enough up to ~$90B,
  // which we'll never approach for a per-project monthly bill.
  const usd = Number(uc) / 100_000;
  if (usd === 0) return "$0.00";
  if (Math.abs(usd) < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
