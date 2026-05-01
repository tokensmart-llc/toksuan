import { Hono } from "hono";
import { dbBackend, sql } from "../db";
import { env } from "../config";
import { getFailoverMap } from "../failover";
import { poolStats } from "../key-rotator";
import { getAlertEmailFrom, isAlertEmailConfigured } from "../alerts";
import {
  anonTelemetryEndpoint,
  isAnonTelemetryEnabled,
  minRouteProjects,
  minRouteRequests,
} from "../anon-telemetry";
import type { ProviderName } from "../pricing";

export const healthRoutes = new Hono();

/**
 * Health endpoint — also serves as the dashboard's read-only "system
 * integrations status" backing query (added v0.2.x).
 *
 * Unauthenticated by design — no secrets returned, only "is X enabled and
 * what's the broad shape of its config" (e.g. "OTel active, 12 keys
 * configured for openai" — never the actual key material).
 *
 * Caching: dashboard polls this on /settings page render. We don't bother
 * caching server-side; the queries are constant-time / pure-env reads
 * except for the DB ping, which Postgres handles fine at any rate.
 */
healthRoutes.get("/health", async (c) => {
  // 1. DB ping — required for the basic ok=true gate.
  let dbOk = false;
  try {
    await sql`SELECT 1`;
    dbOk = true;
  } catch {
    dbOk = false;
  }

  // 2. Cross-provider failover map — env-driven, may be empty.
  const failoverMap = getFailoverMap();
  const failover = {
    enabled: failoverMap.size > 0,
    rules: [...failoverMap.entries()].map(([from, to]) => ({ from, to })),
  };

  // 3. Per-provider key pool stats — round-robin + 429 cooldown introspection.
  // We surface counts ONLY (no key material). Iterates the configured providers
  // we know about so the dashboard doesn't have to hardcode the list.
  const keyPools: Array<{
    provider: ProviderName;
    total: number;
    available: number;
  }> = [];
  for (const cfg of env.providers) {
    const stats = poolStats(cfg.name);
    if (stats.total > 0) {
      keyPools.push({
        provider: cfg.name,
        total: stats.total,
        available: stats.available,
      });
    }
  }

  // 4. OpenTelemetry — env-driven; we report the configured endpoint host
  // (NOT auth headers) so the dashboard can show "shipping to langfuse / datadog / ...".
  const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null;
  let otelHost: string | null = null;
  if (otelEndpoint) {
    try {
      otelHost = new URL(otelEndpoint).host;
    } catch {
      otelHost = otelEndpoint.slice(0, 40); // fallback
    }
  }
  const otel = {
    enabled: otelEndpoint != null,
    endpoint_host: otelHost,
    service_name: process.env.OTEL_SERVICE_NAME ?? "tokensmart-gateway",
  };

  // 5. Quality embedding (shadow A/B similarity) — env-driven.
  const quality = {
    enabled: process.env.TOKENSMART_QUALITY_EMBED_MODEL != null,
    model: process.env.TOKENSMART_QUALITY_EMBED_MODEL ?? null,
    provider: (
      process.env.TOKENSMART_QUALITY_EMBED_PROVIDER ?? "openai"
    ).toLowerCase(),
  };

  // 6. KMS / BYO-key envelope crypto — which backend is active?
  const crypto = {
    backend: process.env.TOKENSMART_KMS_KEY_ARN
      ? "aws-kms"
      : process.env.TOKENSMART_GCP_KMS_KEY_NAME
        ? "gcp-kms"
        : process.env.TOKENSMART_PROVIDER_KEY_ENCRYPTION
          ? "env-master-key"
          : "disabled",
  };

  // 7. Semantic cache — env-driven master switch.
  const semanticCache = {
    enabled: process.env.TOKENSMART_CACHE_ENABLED === "1",
    max_entries: Number(process.env.TOKENSMART_CACHE_MAX_ENTRIES ?? "1000"),
    ttl_seconds: Number(process.env.TOKENSMART_CACHE_TTL_SECONDS ?? "600"),
    similarity_threshold: Number(
      process.env.TOKENSMART_CACHE_SIMILARITY_THRESHOLD ?? "0"
    ),
  };

  // 7b. Privacy / internal operator posture. These are booleans / enum values
  // only; no secret material is exposed.
  const requestBodyStorage = {
    mode: process.env.TOKENSMART_STORE_FULL_REQUEST_BODY ?? "sample",
  };
  const internalReplay = {
    enabled:
      process.env.TOKENSMART_INTERNAL_REPLAY_ENABLED === "1" &&
      process.env.TOKENSMART_INTERNAL_TOKEN != null,
  };

  // 7c. Alert email delivery — surfaces whether RESEND_API_KEY is set on
  // this gateway process. The dashboard's project Alerts panel reads
  // this so it can show "Email delivery: enabled (Resend)" instead of
  // a stale "doesn't send" warning. Never exposes the API key itself.
  const alertEmail = {
    provider: isAlertEmailConfigured() ? ("resend" as const) : null,
    configured: isAlertEmailConfigured(),
    from: getAlertEmailFrom(),
  };

  let anonTelemetryEndpointHost: string | null = null;
  try {
    anonTelemetryEndpointHost = new URL(anonTelemetryEndpoint()).host;
  } catch {
    anonTelemetryEndpointHost = anonTelemetryEndpoint().slice(0, 80);
  }
  const anonTelemetry = {
    enabled: isAnonTelemetryEnabled(),
    endpoint_host: anonTelemetryEndpointHost,
    min_route_requests: minRouteRequests(),
    min_route_projects: minRouteProjects(),
  };

  // 8. Baseline routing policy — surface the loaded version + bucket count
  // by reading the artifact directly (cheap fs read; cached by node).
  let baselinePolicy: {
    enabled: boolean;
    version: string | null;
    buckets: number;
  } = { enabled: false, version: null, buckets: 0 };
  try {
    const enabled = process.env.TOKENSMART_BASELINE_POLICY_ENABLED !== "0";
    if (enabled) {
      // Lazy require so the health endpoint doesn't pull the policy module if
      // it ever moves — this stays decoupled from the runtime hot path.
      const { loadBaselinePolicy } = await import("../policy");
      const policy = loadBaselinePolicy();
      baselinePolicy = {
        enabled: true,
        version: policy?.version ?? null,
        buckets: policy?.buckets?.length ?? 0,
      };
    }
  } catch {
    /* ignore */
  }

  // 9. Embedding-based task classifier — surface enabled state, loaded
  // artifact version, training provenance, and per-head confidence
  // thresholds. Dashboard's "System integrations" panel reads this to
  // confirm a trained artifact is in-path after an operator runs
  // `bun run train-embedding-classifier`.
  //
  // Shape matches the other integrations: `enabled` (env flag), then
  // either `loaded: true` with the artifact metadata or `loaded: false`
  // with a reason hint. All numeric fields come straight from the
  // artifact's own `trained_on` / `validation` blocks — no extra
  // computation at health-check time.
  // Anonymous /health redacts identifying training metadata (project_id,
  // row counts, validation counts, lookback). Self-hosters who want the
  // full block back can set `TOKENSMART_HEALTH_DETAILED=1`. Hosted SaaS
  // leaves it off so an anonymous probe can't enumerate per-tenant
  // training posture from the public internet.
  const detailedHealth =
    process.env.TOKENSMART_HEALTH_DETAILED === "1";
  type EmbeddingClassifierHealth = {
    enabled: boolean;
    loaded: boolean;
    model_version: string | null;
    schema_version: number | null;
    rows: number | null;
    lookback_days: number | null;
    project_id: string | null;
    task_type_accuracy: number | null;
    complexity_accuracy: number | null;
    n_validation: number | null;
    task_type_threshold: number | null;
    complexity_threshold: number | null;
    encoder: {
      num_buckets: number;
      ngram_size: number;
      max_chars: number;
      v2: boolean;
    } | null;
  };
  let embeddingClassifier: EmbeddingClassifierHealth = {
    enabled: process.env.TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED === "1",
    loaded: false,
    model_version: null,
    schema_version: null,
    rows: null,
    lookback_days: null,
    project_id: null,
    task_type_accuracy: null,
    complexity_accuracy: null,
    n_validation: null,
    task_type_threshold: null,
    complexity_threshold: null,
    encoder: null,
  };
  if (embeddingClassifier.enabled) {
    try {
      const { loadEmbeddingClassifier } = await import("../policy");
      const artifact = loadEmbeddingClassifier();
      if (artifact) {
        // v2 encoder = any of the multilingual preprocessing flags
        // explicitly enabled. An old schema_version=1 artifact without
        // those fields reports v2=false (back-compat signal).
        const enc = artifact.encoder;
        const v2 =
          enc.normalize_nfkc === true ||
          enc.strip_zero_width_and_control === true ||
          enc.collapse_whitespace === true ||
          enc.cjk_bigrams === true;
        embeddingClassifier = {
          enabled: true,
          loaded: true,
          model_version: artifact.model_version,
          schema_version: artifact.schema_version,
          rows: detailedHealth ? artifact.trained_on.rows : null,
          lookback_days: detailedHealth
            ? artifact.trained_on.lookback_days
            : null,
          project_id: detailedHealth ? artifact.trained_on.project_id : null,
          task_type_accuracy: detailedHealth
            ? artifact.validation.task_type_accuracy
            : null,
          complexity_accuracy: detailedHealth
            ? artifact.validation.complexity_accuracy
            : null,
          n_validation: detailedHealth
            ? artifact.validation.n_validation
            : null,
          task_type_threshold: artifact.task_type.confidence_threshold,
          complexity_threshold: artifact.complexity.confidence_threshold,
          encoder: {
            num_buckets: enc.num_buckets,
            ngram_size: enc.ngram_size,
            max_chars: enc.max_chars,
            v2,
          },
        };
      }
    } catch {
      /* leave defaults — classifier is an optional integration */
    }
  }

  return c.json({
    ok: dbOk,
    version: "0.0.1",
    db: dbOk ? "up" : "down",
    backend: dbBackend,
    integrations: {
      failover,
      key_pools: keyPools,
      otel,
      quality,
      crypto,
      semantic_cache: semanticCache,
      baseline_policy: baselinePolicy,
      request_body_storage: requestBodyStorage,
      internal_replay: internalReplay,
      alert_email: alertEmail,
      anon_telemetry: anonTelemetry,
      embedding_classifier: embeddingClassifier,
    },
  });
});

/**
 * Read-only mirror of the loaded baseline-policy artifact, plus the list of
 * providers this gateway has env credentials for.
 *
 * Why it exists: the dashboard needs to pick a smoke-test model that is
 * (a) inside the live policy artifact and (b) callable by the user's BYO
 * keys (or this gateway's env credentials). Without that data it ends up
 * suggesting models that are not in any bucket — the receipt then says
 * "no rewrite" forever and the demo looks broken. We deliberately ship
 * the policy in OSS, so there's nothing private to redact.
 *
 * Cheap: one in-memory dump of the cached artifact. No DB / network.
 * Falls back to `enabled:false` when the operator disables baseline policy.
 */
healthRoutes.get("/baseline-policy", async (c) => {
  if (process.env.TOKENSMART_BASELINE_POLICY_ENABLED === "0") {
    return c.json({
      enabled: false,
      version: null,
      buckets: [],
      env_providers: [],
    });
  }
  const { loadBaselinePolicy } = await import("../policy");
  const policy = loadBaselinePolicy();
  const env_providers = env.providers.map((p) => p.name);
  if (!policy) {
    return c.json({
      enabled: true,
      version: null,
      buckets: [],
      env_providers,
    });
  }
  return c.json({
    enabled: true,
    version: policy.version,
    env_providers,
    buckets: policy.buckets.map((b) => ({
      task_type: b.task_type,
      complexity: b.complexity,
      max_quality: b.max_quality,
      models: b.models.map((m) => ({
        model: m.model,
        provider: m.provider,
        avg_cost_micro_cents: m.avg_cost_micro_cents,
        quality_score: m.quality_score,
      })),
    })),
  });
});
