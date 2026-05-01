
/**
 * Read-only fetch of the gateway's `/health` endpoint, which (since v0.2.x)
 * also exposes the "system integrations" snapshot the dashboard's Settings
 * page surfaces.
 *
 * No auth — the gateway returns no secrets, only "feature X is enabled / what
 * shape its config has". Tolerant of failure: if the gateway is down, we
 * return a `{ ok: false, error }` shape and the UI shows "gateway not
 * reachable" instead of breaking the entire page.
 *
 * Cached for 30s in-process to avoid hammering the gateway when many users
 * load /settings simultaneously.
 */

const GATEWAY_URL =
  process.env.GATEWAY_URL ?? "http://localhost:8787";

const CACHE_TTL_MS = 30_000;

export type IntegrationsSnapshot = {
  failover: {
    enabled: boolean;
    rules: Array<{ from: string; to: string }>;
  };
  key_pools: Array<{
    provider: string;
    total: number;
    available: number;
  }>;
  otel: {
    enabled: boolean;
    endpoint_host: string | null;
    service_name: string;
  };
  quality: {
    enabled: boolean;
    model: string | null;
    provider: string;
  };
  crypto: {
    backend: "aws-kms" | "gcp-kms" | "env-master-key" | "disabled";
  };
  semantic_cache?: {
    enabled: boolean;
    max_entries: number;
    ttl_seconds: number;
    similarity_threshold: number;
  };
  baseline_policy: {
    enabled: boolean;
    version: string | null;
    buckets: number;
  };
  request_body_storage?: {
    mode: "sample" | "never" | "always" | string;
  };
  internal_replay?: {
    enabled: boolean;
  };
  /** Whether the gateway has RESEND_API_KEY set, so alert emails are
   *  actually delivered (vs logged to the gateway console). Surfaced to
   *  the dashboard's project Alerts panel — that panel used to claim
   *  "email never sends today" unconditionally; now it can show the
   *  truthful state and the operator's RESEND_FROM address. */
  alert_email?: {
    provider: "resend" | null;
    configured: boolean;
    from: string | null;
  };
  /** Gateway-side anonymous aggregate telemetry posture. This comes from the
   * gateway process, not the dashboard env, because the sender script runs from
   * apps/gateway and may have different env values than the dashboard. */
  anon_telemetry?: {
    enabled: boolean;
    endpoint_host: string | null;
    min_route_requests: number;
    min_route_projects: number;
  };
};

export type GatewayHealth = {
  ok: boolean;
  version: string;
  db: string;
  integrations: IntegrationsSnapshot;
};

export type FetchResult =
  | { ok: true; data: GatewayHealth }
  | { ok: false; error: string };

let _cache: { ts: number; result: FetchResult } | null = null;

export async function fetchGatewayHealth(): Promise<FetchResult> {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) {
    return _cache.result;
  }
  let result: FetchResult;
  try {
    // 1500ms is enough for a warm gateway anywhere on the same continent;
    // 3s used to be the default, but the dashboard /settings render
    // BLOCKS on this fetch — when the gateway was cold-starting on
    // Render, all 3s got burned and users saw the page hang. Going under
    // 2s caps the worst-case TTFB at ~1.5s + Postgres → still feels
    // alive even when the gateway is genuinely down. The catch arm
    // returns the LAST cached snapshot (or { ok:false }), so a missed
    // refresh degrades to slightly stale data, never a broken page.
    const res = await fetch(`${GATEWAY_URL.replace(/\/$/, "")}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(1500),
      cache: "no-store",
    });
    if (!res.ok) {
      result = { ok: false, error: `Gateway HTTP ${res.status}` };
    } else {
      const data = (await res.json()) as GatewayHealth;
      result = { ok: true, data };
    }
  } catch (err) {
    result = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  _cache = { ts: Date.now(), result };
  return result;
}
