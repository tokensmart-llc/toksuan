import { createHash } from "node:crypto";
import { sql } from "./db";
import type { Sql } from "./sql-driver";

export const ANON_TELEMETRY_SCHEMA_VERSION = 1;

export type TelemetryWindow = {
  start: string;
  end: string;
};

export type AnonTelemetryTotals = {
  requests: number;
  routed_requests: number;
  loops_blocked: number;
  budget_blocks: number;
  plan_blocks: number;
  errors: number;
  routing_saving_micro_cents: number;
  cache_saving_micro_cents: number;
};

export type AnonTelemetryRoute = {
  from_model: string;
  to_model: string;
  landed_provider: string;
  routing_bucket: string;
  request_count: number;
  project_count: number;
  routing_saving_micro_cents: number;
  avg_savings_pct: number | null;
};

export type AnonTelemetryPayload = {
  schema_version: 1;
  source: "self_host_opt_in";
  generated_at: string;
  deployment_hash: string;
  window: TelemetryWindow;
  thresholds: {
    min_route_requests: number;
    min_route_projects: number;
  };
  totals: AnonTelemetryTotals;
  routes: AnonTelemetryRoute[];
};

type TotalRow = {
  requests: number | string | null;
  routed_requests: number | string | null;
  loops_blocked: number | string | null;
  budget_blocks: number | string | null;
  plan_blocks: number | string | null;
  errors: number | string | null;
  routing_saving_micro_cents: number | string | null;
  cache_saving_micro_cents: number | string | null;
};

type RouteRow = {
  from_model: string | null;
  to_model: string | null;
  landed_provider: string | null;
  routing_bucket: string | null;
  request_count: number | string | null;
  project_count: number | string | null;
  routing_saving_micro_cents: number | string | null;
  avg_savings_pct: number | string | null;
};

export type CollectAnonTelemetryOptions = {
  start: Date;
  end: Date;
  minRouteRequests?: number;
  minRouteProjects?: number;
  now?: Date;
  sqlClient?: Sql;
};

/**
 * Opt-in switch. Defaults OFF by design — self-hosted installs never phone
 * home unless the operator explicitly asks them to.
 */
export function isAnonTelemetryEnabled(): boolean {
  return process.env.TOKENSMART_ANON_TELEMETRY === "1";
}

export function anonTelemetryEndpoint(): string {
  return (
    process.env.TOKENSMART_ANON_TELEMETRY_ENDPOINT ??
    "https://tokensmt.com/api/telemetry/agent-spend"
  );
}

export function minRouteRequests(): number {
  return Math.max(
    1,
    Number(process.env.TOKENSMART_ANON_TELEMETRY_MIN_ROUTE_REQUESTS ?? "5")
  );
}

export function minRouteProjects(): number {
  return Math.max(
    1,
    Number(process.env.TOKENSMART_ANON_TELEMETRY_MIN_ROUTE_PROJECTS ?? "1")
  );
}

/**
 * Stable deployment identifier without sending a raw hostname / DB URL.
 *
 * Preferred: TOKENSMART_ANON_TELEMETRY_DEPLOYMENT_ID — any operator-chosen
 * random string, never shown in the UI.
 *
 * Fallback: hash DATABASE_URL. This is still opt-in only and sends only a
 * one-way SHA-256 prefix, but the env override exists for operators who don't
 * want even a DB-url-derived fingerprint.
 */
export function deploymentHash(): string {
  const seed = process.env.TOKENSMART_ANON_TELEMETRY_DEPLOYMENT_ID;
  if (!seed) {
    // Avoid deriving a public pseudonymous id from DATABASE_URL (which often
    // contains credentials) and avoid collapsing every unset deployment into a
    // shared "unknown" bucket. The sender catches this and prints an actionable
    // message. Operators can use any random local string; it is hashed before
    // upload and never displayed publicly.
    throw new Error(
      "TOKENSMART_ANON_TELEMETRY_DEPLOYMENT_ID is required when anonymous telemetry is enabled."
    );
  }
  return createHash("sha256").update(seed).digest("hex").slice(0, 24);
}

export function yesterdayWindow(now = new Date()): { start: Date; end: Date } {
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return { start, end };
}

function n(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const out = Number(v);
  return Number.isFinite(out) ? out : 0;
}

/**
 * Collect anonymized DAILY aggregates from the local requests ledger.
 *
 * What we include:
 *   - counts, sums, route pairs, provider/model names, routing bucket
 *   - project_count only as a k-anonymity input
 *
 * What we never include:
 *   - prompts / responses / request_body / response_body
 *   - API keys, user emails, project names, request ids, exact per-row times
 *   - low-count route rows below the local threshold
 */
export async function collectAnonTelemetry(
  opts: CollectAnonTelemetryOptions
): Promise<AnonTelemetryPayload> {
  const client = opts.sqlClient ?? sql;
  const minRequests = opts.minRouteRequests ?? minRouteRequests();
  const minProjects = opts.minRouteProjects ?? minRouteProjects();

  const totalsRows = await client<TotalRow[]>`
    SELECT
      COUNT(*)::int AS requests,
      COUNT(*) FILTER (
        WHERE original_model IS NOT NULL AND original_model <> model
      )::int AS routed_requests,
      COUNT(*) FILTER (WHERE status = 'loop_detected')::int AS loops_blocked,
      COUNT(*) FILTER (WHERE status = 'budget_exceeded')::int AS budget_blocks,
      COUNT(*) FILTER (WHERE status = 'plan_limit_exceeded')::int AS plan_blocks,
      COUNT(*) FILTER (WHERE status = 'error')::int AS errors,
      COALESCE(SUM(routing_saving_micro_cents), 0)::bigint
        AS routing_saving_micro_cents,
      COALESCE(SUM(cache_savings_micro_cents), 0)::bigint
        AS cache_saving_micro_cents
    FROM requests
    WHERE created_at >= ${opts.start}
      AND created_at < ${opts.end}
  `;
  const totalsRow = totalsRows[0];

  const routeRows = await client<RouteRow[]>`
    SELECT
      original_model AS from_model,
      model AS to_model,
      provider AS landed_provider,
      COALESCE(routing_bucket, 'unknown') AS routing_bucket,
      COUNT(*)::int AS request_count,
      COUNT(DISTINCT project_id)::int AS project_count,
      COALESCE(SUM(routing_saving_micro_cents), 0)::bigint
        AS routing_saving_micro_cents,
      AVG(
        CASE
          WHEN routing_saving_micro_cents > 0
           AND (routing_saving_micro_cents + cost_micro_cents) > 0
          THEN routing_saving_micro_cents * 1.0
             / ((routing_saving_micro_cents + cost_micro_cents) * 1.0)
             * 100.0
          ELSE NULL
        END
      )::real AS avg_savings_pct
    FROM requests
    WHERE created_at >= ${opts.start}
      AND created_at < ${opts.end}
      AND original_model IS NOT NULL
      AND original_model <> model
    GROUP BY original_model, model, provider, COALESCE(routing_bucket, 'unknown')
    HAVING COUNT(*) >= ${minRequests}
       AND COUNT(DISTINCT project_id) >= ${minProjects}
    ORDER BY routing_saving_micro_cents DESC
    LIMIT 50
  `;

  return {
    schema_version: ANON_TELEMETRY_SCHEMA_VERSION,
    source: "self_host_opt_in",
    generated_at: (opts.now ?? new Date()).toISOString(),
    deployment_hash: deploymentHash(),
    window: {
      start: opts.start.toISOString(),
      end: opts.end.toISOString(),
    },
    thresholds: {
      min_route_requests: minRequests,
      min_route_projects: minProjects,
    },
    totals: {
      requests: n(totalsRow?.requests),
      routed_requests: n(totalsRow?.routed_requests),
      loops_blocked: n(totalsRow?.loops_blocked),
      budget_blocks: n(totalsRow?.budget_blocks),
      plan_blocks: n(totalsRow?.plan_blocks),
      errors: n(totalsRow?.errors),
      routing_saving_micro_cents: n(totalsRow?.routing_saving_micro_cents),
      cache_saving_micro_cents: n(totalsRow?.cache_saving_micro_cents),
    },
    routes: routeRows.map((row) => ({
      from_model: row.from_model ?? "unknown",
      to_model: row.to_model ?? "unknown",
      landed_provider: row.landed_provider ?? "unknown",
      routing_bucket: row.routing_bucket ?? "unknown",
      request_count: n(row.request_count),
      project_count: n(row.project_count),
      routing_saving_micro_cents: n(row.routing_saving_micro_cents),
      avg_savings_pct:
        row.avg_savings_pct == null ? null : Number(row.avg_savings_pct),
    })),
  };
}

