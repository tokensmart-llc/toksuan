import { NextResponse, type NextRequest } from "next/server";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type TelemetryTotals = {
  requests: number;
  routed_requests: number;
  loops_blocked: number;
  budget_blocks: number;
  plan_blocks: number;
  errors: number;
  routing_saving_micro_cents: number;
  cache_saving_micro_cents: number;
};

type TelemetryRoute = {
  from_model: string;
  to_model: string;
  landed_provider: string;
  routing_bucket: string;
  request_count: number;
  project_count: number;
  routing_saving_micro_cents: number;
  avg_savings_pct: number | null;
};

type TelemetryPayload = {
  schema_version: 1;
  source: "self_host_opt_in";
  generated_at: string;
  deployment_hash: string;
  window: { start: string; end: string };
  thresholds: {
    min_route_requests: number;
    min_route_projects: number;
  };
  totals: TelemetryTotals;
  routes: TelemetryRoute[];
};

const MAX_BODY_BYTES = 128 * 1024;
const MAX_COUNT = 1_000_000_000;
const MAX_MICRO_CENTS = 10_000_000_000_000;

function isNonNegativeInteger(v: unknown, max = MAX_COUNT): v is number {
  return (
    typeof v === "number" &&
    Number.isInteger(v) &&
    Number.isFinite(v) &&
    v >= 0 &&
    v <= max
  );
}

function isShortText(v: unknown, max = 160): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}

function parseDate(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

function validateTotals(v: unknown): v is TelemetryTotals {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const t = v as Record<string, unknown>;
  return [
    "requests",
    "routed_requests",
    "loops_blocked",
    "budget_blocks",
    "plan_blocks",
    "errors",
    "routing_saving_micro_cents",
    "cache_saving_micro_cents",
  ].every((k) =>
    k.endsWith("_micro_cents")
      ? isNonNegativeInteger(t[k], MAX_MICRO_CENTS)
      : isNonNegativeInteger(t[k])
  );
}

function validateRoute(v: unknown): v is TelemetryRoute {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    isShortText(r.from_model) &&
    isShortText(r.to_model) &&
    isShortText(r.landed_provider, 64) &&
    isShortText(r.routing_bucket, 80) &&
    isNonNegativeInteger(r.request_count) &&
    isNonNegativeInteger(r.project_count) &&
    isNonNegativeInteger(r.routing_saving_micro_cents, MAX_MICRO_CENTS) &&
    (r.avg_savings_pct === null ||
      (typeof r.avg_savings_pct === "number" &&
        Number.isFinite(r.avg_savings_pct) &&
        r.avg_savings_pct >= 0 &&
        r.avg_savings_pct <= 100))
  );
}

function validatePayload(v: unknown): {
  ok: true;
  payload: TelemetryPayload;
  windowStart: Date;
  windowEnd: Date;
} | { ok: false; error: string } {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return { ok: false, error: "Body must be a JSON object." };
  }
  const p = v as Record<string, unknown>;
  if (p.schema_version !== 1) {
    return { ok: false, error: "Unsupported schema_version." };
  }
  if (p.source !== "self_host_opt_in") {
    return { ok: false, error: "Unsupported source." };
  }
  if (
    !isShortText(p.deployment_hash, 64) ||
    !/^[a-f0-9]{16,64}$/i.test(p.deployment_hash)
  ) {
    return { ok: false, error: "Invalid deployment_hash." };
  }
  if (!isShortText(p.generated_at, 64) || !parseDate(p.generated_at)) {
    return { ok: false, error: "Invalid generated_at." };
  }
  const windowObj = p.window as Record<string, unknown> | undefined;
  const windowStart = parseDate(windowObj?.start);
  const windowEnd = parseDate(windowObj?.end);
  if (!windowStart || !windowEnd || windowStart >= windowEnd) {
    return { ok: false, error: "Invalid window." };
  }
  const maxWindowMs = 32 * 24 * 60 * 60 * 1000;
  if (windowEnd.getTime() - windowStart.getTime() > maxWindowMs) {
    return { ok: false, error: "Window too large." };
  }
  if (!validateTotals(p.totals)) {
    return { ok: false, error: "Invalid totals." };
  }
  const thresholds = p.thresholds as Record<string, unknown> | undefined;
  if (
    !thresholds ||
    !isNonNegativeInteger(thresholds.min_route_requests) ||
    !isNonNegativeInteger(thresholds.min_route_projects) ||
    thresholds.min_route_requests < 1 ||
    thresholds.min_route_projects < 1
  ) {
    return { ok: false, error: "Invalid thresholds." };
  }
  if (!Array.isArray(p.routes) || p.routes.length > 100) {
    return { ok: false, error: "Invalid routes array." };
  }
  if (!p.routes.every(validateRoute)) {
    return { ok: false, error: "Invalid route row." };
  }
  return {
    ok: true,
    payload: p as TelemetryPayload,
    windowStart,
    windowEnd,
  };
}

/**
 * Public collector endpoint for opt-in self-host aggregate telemetry.
 *
 * Authentication is intentionally NOT required: self-hosted deployments don't
 * have a hosted TokSuan account/session. The privacy boundary is enforced
 * by accepting only a narrow aggregate schema and storing the raw payload only
 * after validation. Abuse surface is low (small JSON, idempotent upsert by
 * deployment_hash+window); WAF/rate-limit can be added at the platform edge.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json(
      { ok: false, error: "Payload too large." },
      { status: 413 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Body must be JSON." }, { status: 400 });
  }

  const parsed = validatePayload(body);
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  }
  const { payload, windowStart, windowEnd } = parsed;
  const totals = payload.totals;

  try {
    await sql`
      INSERT INTO anonymous_telemetry_daily (
        schema_version,
        source,
        deployment_hash,
        window_start,
        window_end,
        request_count,
        routed_request_count,
        loops_blocked_count,
        budget_block_count,
        plan_block_count,
        error_count,
        routing_saving_micro_cents,
        cache_saving_micro_cents,
        route_row_count,
        payload
      ) VALUES (
        ${payload.schema_version},
        ${payload.source},
        ${payload.deployment_hash},
        ${windowStart},
        ${windowEnd},
        ${totals.requests},
        ${totals.routed_requests},
        ${totals.loops_blocked},
        ${totals.budget_blocks},
        ${totals.plan_blocks},
        ${totals.errors},
        ${totals.routing_saving_micro_cents},
        ${totals.cache_saving_micro_cents},
        ${payload.routes.length},
        ${sql.json(payload)}
      )
      ON CONFLICT (deployment_hash, window_start, window_end, schema_version)
      DO UPDATE SET
        source = EXCLUDED.source,
        request_count = EXCLUDED.request_count,
        routed_request_count = EXCLUDED.routed_request_count,
        loops_blocked_count = EXCLUDED.loops_blocked_count,
        budget_block_count = EXCLUDED.budget_block_count,
        plan_block_count = EXCLUDED.plan_block_count,
        error_count = EXCLUDED.error_count,
        routing_saving_micro_cents = EXCLUDED.routing_saving_micro_cents,
        cache_saving_micro_cents = EXCLUDED.cache_saving_micro_cents,
        route_row_count = EXCLUDED.route_row_count,
        payload = EXCLUDED.payload,
        updated_at = NOW()
    `;
  } catch (err) {
    console.error("[anon-telemetry] collector insert failed:", err);
    return NextResponse.json(
      { ok: false, error: "Collector storage is not ready." },
      { status: 503 }
    );
  }

  return NextResponse.json({
    ok: true,
    received: {
      requests: totals.requests,
      routes: payload.routes.length,
      window: payload.window,
    },
  });
}

