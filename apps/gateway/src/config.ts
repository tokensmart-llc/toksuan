import { z } from "zod";
import type { Provider, ProviderName } from "./pricing";
import { buildKeyPool, registerKeyPool } from "./key-rotator";

const EnvSchema = z.object({
  PORT: z.coerce.number().default(8787),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  // Accept either a postgres URL (production) or a sqlite path
  // (`sqlite:./data/foo.db` / `sqlite:///abs/path.db` / `:memory:`)
  // selected at boot by `sql-driver.detectBackend`. We keep validation
  // permissive here and let the driver itself fail loud on a malformed
  // value at first query.
  DATABASE_URL: z.string().min(1),

  // --- Per-provider credentials (all optional; at least one must be set) --
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  GOOGLE_API_KEY: z.string().min(1).optional(),
  GOOGLE_BASE_URL: z.string().url().optional(),
  DEEPSEEK_API_KEY: z.string().min(1).optional(),
  DEEPSEEK_BASE_URL: z.string().url().optional(),
  QWEN_API_KEY: z.string().min(1).optional(),
  QWEN_BASE_URL: z.string().url().optional(),
  DOUBAO_API_KEY: z.string().min(1).optional(),
  DOUBAO_BASE_URL: z.string().url().optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_BASE_URL: z.string().url().optional(),

  // --- Feature flags ----------------------------------------------------
  /**
   * Auto-inject `cache_control: ephemeral` markers on outbound requests to
   * Anthropic-family models. Default ON — agents almost always benefit and
   * the worst case is no-op for short prompts. Set to "0" to disable.
   */
  TOKENSMART_AUTO_CACHE_CONTROL: z.string().default("1"),

  /**
   * Optional smarter complexity classifier. When set to a model name the
   * gateway will ask that small model to score complexity instead of running
   * the heuristic. Falls back to heuristic on any error.
   *   e.g. TOKENSMART_CLASSIFIER_MODEL=gpt-4o-mini
   */
  TOKENSMART_CLASSIFIER_MODEL: z.string().optional(),
  /**
   * How the optional LLM complexity judge is paid for / selected:
   *   - byo_same_provider (default): use a cheap model from the same provider
   *     family as the caller's requested model, resolved through the user's BYO
   *     key when present. If no same-provider BYO key is available, fall back
   *     to the local heuristic.
   *   - explicit: use TOKENSMART_CLASSIFIER_MODEL as an operator-selected
   *     judge model. This can use gateway env credentials and is appropriate
   *     for self-host/demo installs where the operator accepts the cost.
   *   - heuristic: never make an LLM judge call.
   */
  TOKENSMART_CLASSIFIER_MODE: z
    .enum(["byo_same_provider", "explicit", "heuristic"])
    .default("byo_same_provider"),

  /**
   * Enable the baseline (cold-start) routing policy. When "1" and
   * `src/policy/baseline-policy.json` has real data, the gateway will
   * consult the policy AFTER any user-configured routing_rules. It will
   * downgrade to a cheaper model iff the policy's bucketed quality score
   * stays within `TOKENSMART_BASELINE_POLICY_EPS` of the request's current
   * model. Default ON now that runtime routing filters recommendations through
   * the user's BYO keys / gateway env credentials before rewriting.
   */
  TOKENSMART_BASELINE_POLICY_ENABLED: z.string().default("1"),

  /**
   * How much quality drop we'll accept when the baseline policy offers a
   * cheaper model. Default 0.05 (5%). Set to 0 to require "same quality or
   * better," or higher for more aggressive cost savings.
   */
  TOKENSMART_BASELINE_POLICY_EPS: z.coerce.number().default(0.05),

  /**
   * v0.6.4 — refuse to rewrite caller models the gateway can't otherwise
   * route. When the request comes in with `model="grok-2-latest"` (no
   * built-in template, no policy-bucket entry, and the user has no
   * matching custom upstream registered), the v0.6.0 baseline path
   * USED to anchor on `bucket.max_quality` and silently pick the
   * cheapest-within-eps frontier model — the request would 200 with a
   * COMPLETELY DIFFERENT model than the caller asked for, AND the L5
   * rejection-telemetry table would never see the unsupported name
   * (it got rescued before reaching the resolver). Both bad: surprise
   * model swap for the caller, blind spot in operator visibility for
   * us. Default behavior changes in v0.6.4 — unknown caller models
   * fall through to `resolveProvider` which 400s with `no_template`
   * and stamps the L5 telemetry row.
   *
   * Set to "1" to restore the legacy "rescue any unknown model name"
   * behavior. Only useful for the rare migration window where you're
   * transitioning from v0.6.x to v0.6.4 with a fleet of agents that
   * still hard-code obsolete model strings — flip back to "0" once
   * those agents are updated.
   */
  TOKENSMART_BASELINE_RESCUE_UNKNOWN_MODELS: z.string().default("0"),

  /**
   * v0.6.5 — file-watch hot-reload for `baseline-policy.json`. When
   * enabled (default), the gateway watches the artifact file's
   * directory; a successful rewrite (e.g. by `bench:extract` after
   * `auto-bench-new-models --approve`) triggers a debounced
   * `reloadBaselinePolicy()` within ~300ms. The new policy is
   * effective on the very next request — no gateway restart needed.
   * Pairs with the `tokensmart_baseline_reload` pg_notify channel for
   * multi-replica installs where the bench job runs on a different
   * pod than the gateway.
   *
   * Set to "0" to disable the watcher. The pg_notify subscriber
   * (which is gated on `BASELINE_POLICY_ENABLED`, not this var)
   * still runs; operator can manually
   * `SELECT pg_notify('tokensmart_baseline_reload', '')` to force a
   * reload without a restart. Or restart the gateway, which always
   * re-reads at boot.
   */
  TOKENSMART_BASELINE_POLICY_WATCH: z.string().default("1"),

  /**
   * Override the on-disk path for the baseline-policy artifact.
   * Defaults to `apps/gateway/src/policy/baseline-policy.json`
   * (shipped alongside the source). Set to stage a candidate
   * artifact for blue-green A/B testing or to point at a per-tenant
   * artifact mounted from a sidecar volume. Mirrors the existing
   * `TOKENSMART_EMBEDDING_CLASSIFIER_PATH` for consistency.
   */
  TOKENSMART_BASELINE_POLICY_PATH: z.string().optional(),

  /**
   * Enable the embedding-based task classifier. Replaces the regex
   * heuristic for the (task_type, complexity) decision when an artifact
   * is loaded AND both heads cross their calibrated softmax-confidence
   * thresholds; otherwise the heuristic safety net wins.
   *
   * The artifact comes from `bun run train-embedding-classifier`,
   * which trains a fastText-style hashed-trigram + linear-softmax
   * model from real `requests` traffic — uses the existing heuristic
   * as a weak label and refines complexity from `ab_results.similarity`.
   * Sub-millisecond inference, no per-request LLM cost, no extra deps.
   *
   * Default off so existing self-hosters opt in deliberately. Setting
   * this to "1" without a trained artifact is a safe no-op (the loader
   * silently returns null and routing keeps using the heuristic).
   */
  TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED: z.string().default("0"),

  /**
   * Override the on-disk path for the embedding classifier artifact.
   * Defaults to `apps/gateway/src/policy/embedding-classifier.json` —
   * lives next to the baseline-policy artifact so a deploy ships them
   * together. Set this when you want to test a candidate artifact
   * without overwriting production's, or to point at a per-tenant
   * artifact mounted from a sidecar volume.
   */
  TOKENSMART_EMBEDDING_CLASSIFIER_PATH: z.string().optional(),

  /**
   * Master key for AES-256-GCM encryption of customer-supplied upstream
   * provider keys (the BYO keys table). 32 bytes, either 64-hex-char or
   * base64-encoded. Generate with `openssl rand -hex 32`.
   *
   * When unset, the env-backed BYO provider is disabled. Either this or
   * `TOKENSMART_KMS_KEY_ARN` must be set (or neither, if running in
   * self-hosted single-tenant mode with only env-configured upstream
   * credentials).
   */
  TOKENSMART_PROVIDER_KEY_ENCRYPTION: z.string().optional(),

  /**
   * AWS KMS Customer Master Key ARN for envelope-encrypting customer
   * provider keys. When set, the KMS-backed provider takes priority over
   * env for NEW writes. Decryption still reads both backends based on the
   * per-row `master_key_fingerprint`, which is how env → KMS migration
   * runs without downtime.
   *
   * Example: `arn:aws:kms:us-east-1:123456789012:key/abcd-...`
   *
   * IAM policy attached to the gateway's role needs exactly
   * `kms:GenerateDataKey` + `kms:Decrypt` on this resource. See
   * `apps/gateway/src/kms-provider.ts` for the full policy snippet.
   */
  TOKENSMART_KMS_KEY_ARN: z.string().optional(),

  /**
   * Override the AWS KMS endpoint. Only needed for LocalStack or custom
   * VPC endpoints — leave unset for production AWS.
   */
  TOKENSMART_KMS_ENDPOINT_URL: z.string().url().optional(),

  /**
   * Google Cloud KMS key resource name for envelope-encrypting customer
   * provider keys. Mutually exclusive with TOKENSMART_KMS_KEY_ARN — set
   * exactly one, or neither to fall back to env-master-key crypto.
   *
   * Format: `projects/<proj>/locations/<loc>/keyRings/<ring>/cryptoKeys/<key>`
   *
   * Auth: uses GCP Application Default Credentials. On GKE use Workload
   * Identity; elsewhere set GOOGLE_APPLICATION_CREDENTIALS to point at a
   * service-account JSON. See apps/gateway/src/gcp-kms-provider.ts for the
   * minimum IAM roles required.
   */
  TOKENSMART_GCP_KMS_KEY_NAME: z.string().optional(),

  // --- KMS decryption cache ------------------------------------------------

  /**
   * TTL (ms) for the in-process decrypted-plaintext cache. A value of 0
   * disables caching so every decrypt hits KMS — useful for
   * ultra-paranoid compliance contexts. Default 10 min.
   */
  TOKENSMART_KMS_CACHE_TTL_MS: z.coerce.number().optional(),

  /**
   * Max entries in the decrypted-plaintext LRU. 0 disables. Default 1000.
   * Memory-bounded: each entry is a string (the BYO provider key) +
   * metadata — typically <200 bytes.
   */
  TOKENSMART_KMS_CACHE_MAX_SIZE: z.coerce.number().optional(),

  // --- Body size limit ----------------------------------------------------
  /**
   * Maximum `Content-Length` accepted on any chat completion request,
   * in bytes. Anything larger returns 413 without reading the body,
   * so a malicious client can't OOM the gateway by streaming a giant
   * message array.
   *
   * Default 10 MiB — enough for a 10k-token prompt with multiple
   * vision-mode base64 images, comfortably above real-world agent
   * traffic we see. Set higher (e.g. 50 MiB) if you run a vision-heavy
   * workload with large images inline.
   *
   * Set to `0` to disable the check (not recommended in prod).
   */
  TOKENSMART_MAX_BODY_BYTES: z.coerce.number().default(10 * 1024 * 1024),

  // --- Tool-result compressor (input-token saver) -----------------------
  /**
   * Master switch for the tool-result compressor. When "1", the gateway
   * inspects every `tool` / `function` message in the request body and
   * applies content-aware compression (git status / git diff / stack
   * trace / NDJSON logs / ANSI strip / consecutive-line dedup) BEFORE
   * forwarding to the upstream provider. Reduces billed input tokens.
   *
   * Default OFF. Modifying the request body silently is incompatible
   * with TokSuan's "we record what happened, we don't fudge prompts"
   * trust contract — operators must opt in deliberately. Per-call
   * escape hatch: send `x-ts-tool-compress: off` to bypass for one
   * request even when the master switch is on.
   *
   * The compressor only ever rewrites `tool` / `function` role
   * messages — system/user/assistant content is never touched. See
   * src/tool-result-compressor.ts for the full design.
   */
  TOKENSMART_TOOL_COMPRESS_ENABLED: z.string().default("0"),
  /**
   * Minimum byte length before the compressor considers a single tool
   * message. Below this floor, even a perfect filter can save fewer
   * tokens than the receipt overhead is worth, AND small blobs
   * trigger more false-positive shape detections (a 50-char string
   * that happens to start with "On branch ..." isn't necessarily a
   * git status). Default 500 bytes.
   */
  TOKENSMART_TOOL_COMPRESS_MIN_MESSAGE_CHARS: z.coerce.number().default(500),
  /**
   * Hard upper bound on a per-message compressed length. After
   * shape-specific compression runs, anything still above this cap
   * gets a generic head/tail truncation. Default 4000 chars
   * (~1100 tokens). Raise if you have agents that legitimately
   * need long tool outputs in context.
   */
  TOKENSMART_TOOL_COMPRESS_MAX_COMPRESSED_CHARS: z.coerce.number().default(4000),
  /** Strip ANSI escape codes from tool messages. Almost always safe. */
  TOKENSMART_TOOL_COMPRESS_STRIP_ANSI: z.string().default("1"),
  /**
   * Collapse exact-equal consecutive lines into "<line> (×N)". Hits
   * the dominant savings shape on docker logs / verbose pytest /
   * spammy build output. Default ON when the master switch is on.
   */
  TOKENSMART_TOOL_COMPRESS_DEDUP_LINES: z.string().default("1"),
  /**
   * Comma-separated tool names whose results we never compress —
   * the per-call escape hatch for tools where the agent really does
   * need every byte (e.g. a `vision_describe` tool that returns
   * structured pixel data, or a `search_web` tool whose snippets
   * the agent quotes verbatim). Matched against
   * `messages[i].name` (case-insensitive).
   */
  TOKENSMART_TOOL_COMPRESS_EXCLUDE_TOOLS: z.string().optional(),

  // --- CORS ---------------------------------------------------------------
  /**
   * Comma-separated list of Origins that browsers are allowed to make
   * cross-origin requests from. Unset (default) disables CORS entirely —
   * server-side SDK / backend callers never trigger CORS so this only
   * affects browser-side integrations (Vercel AI SDK `useChat` from the
   * client, web playgrounds, browser extensions).
   *
   * Values:
   *   unset / empty  → CORS disabled (server-to-server only)
   *   "*"            → any origin allowed (permissive, no credentials)
   *   "https://a.example.com,https://b.example.com"
   *                  → exact-match allowlist; wildcards NOT supported for
   *                    credentialed requests
   *
   * We deliberately don't send `Access-Control-Allow-Credentials: true`
   * — the gateway auths via Authorization header, not cookies, so there
   * are no credentials to allow.
   */
  TOKENSMART_CORS_ALLOW_ORIGINS: z.string().optional(),
});

type RawEnv = z.infer<typeof EnvSchema>;

/**
 * Minimal configuration needed to call one upstream LLM provider using the
 * OpenAI-compatible chat completions shape.
 */
export type ProviderConfig = {
  /** Either a built-in provider enum value (`"openai"`, `"anthropic"` …)
   *  or a user-registered custom provider namespaced as
   *  `custom:<uuid>` so its key pool and pricing don't alias with the
   *  built-ins. */
  name: ProviderName;
  apiKey: string;
  baseUrl: string;
  matches: (model: string) => boolean;
};

/**
 * Static template for a provider — the bits that don't depend on which
 * customer is asking. The actual `apiKey` (and an optional `baseUrl`
 * override) get layered on at request time, either from gateway env vars
 * (single-tenant / fallback) or from the BYO `user_provider_keys` table
 * (hosted multi-tenant).
 */
export type ProviderTemplate = {
  name: Provider;
  baseUrl: string;
  matches: (model: string) => boolean;
};

/**
 * Built-in per-provider defaults: the base URL we hit when the user didn't
 * override it, and the model-name pattern we use to route each incoming
 * request. Patterns are intentionally permissive — when in doubt, prefer
 * routing too many models to a provider over rejecting a real request, since
 * the upstream will surface a precise error if the specific model is wrong.
 */
export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    name: "openai",
    baseUrl: "https://api.openai.com/v1",
    matches: (m) => /^(gpt-|o1-|o3-|o4-|chatgpt-|text-)/i.test(m),
  },
  {
    name: "anthropic",
    // Native Anthropic /v1/messages — handled by providers/anthropic.ts.
    baseUrl: "https://api.anthropic.com/v1",
    matches: (m) => /^claude-/i.test(m),
  },
  {
    name: "google",
    // Gemini's OpenAI-compatible endpoint.
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    matches: (m) => /^gemini-/i.test(m),
  },
  {
    name: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    matches: (m) => /^deepseek-/i.test(m),
  },
  {
    name: "qwen",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    matches: (m) => /^qwen/i.test(m),
  },
  {
    name: "doubao",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    matches: (m) => /^(doubao-|ep-)/i.test(m),
  },
];

/**
 * The full set of provider names TokSuan knows about, in stable display
 * order. Useful for the dashboard's BYO provider-key dropdown.
 */
export const SUPPORTED_PROVIDERS: readonly Provider[] = PROVIDER_TEMPLATES.map(
  (t) => t.name
);

const PROVIDER_DEFAULTS: Record<
  Provider,
  { baseUrl: string; matches: (m: string) => boolean }
> = Object.fromEntries(
  PROVIDER_TEMPLATES.map((t) => [t.name, { baseUrl: t.baseUrl, matches: t.matches }])
) as Record<Provider, { baseUrl: string; matches: (m: string) => boolean }>;

/**
 * Find the provider TEMPLATE responsible for a given model name. Unlike
 * `pickProvider`, this works against the static catalog — so even if the
 * gateway's env doesn't have an `OPENAI_API_KEY`, we can still resolve a
 * `gpt-4o` request to "openai" and then look for a BYO key.
 */
export function findProviderTemplate(model: string): ProviderTemplate | null {
  return PROVIDER_TEMPLATES.find((t) => t.matches(model)) ?? null;
}

/**
 * Best-effort host → provider mapping. Used only to migrate the legacy
 * OPENAI_BASE_URL/OPENAI_API_KEY pair when the user actually pointed it at
 * a non-OpenAI host (e.g. DeepSeek).
 */
function providerFromHost(url: string | undefined): Provider {
  if (!url) return "openai";
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "openai";
  }
  if (host.endsWith("openai.com")) return "openai";
  if (host.endsWith("anthropic.com")) return "anthropic";
  if (host.includes("googleapis.com")) return "google";
  if (host.endsWith("deepseek.com")) return "deepseek";
  if (host.includes("dashscope") || host.includes("aliyuncs")) return "qwen";
  if (host.includes("volces") || host.includes("volcengine") || host.includes("doubao"))
    return "doubao";
  return "openai";
}

function buildRegistry(raw: RawEnv): ProviderConfig[] {
  const reg: ProviderConfig[] = [];
  const seen = new Set<Provider>();

  const add = (name: Provider, apiKey: string, baseUrl?: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const def = PROVIDER_DEFAULTS[name];
    // Register a key pool from the comma-separated env value. Single-key
    // installs get a 1-element pool — same behavior as before. Multi-key
    // installs get round-robin + 429-cooldown for free.
    const pool = buildKeyPool(apiKey);
    registerKeyPool(name, pool);
    // The first key is what the registered ProviderConfig carries by default.
    // Per-request rotation happens in providers/* via pickKey() before fetch.
    reg.push({
      name,
      apiKey: pool.keys[0] ?? apiKey,
      baseUrl: baseUrl ?? def.baseUrl,
      matches: def.matches,
    });
  };

  // Back-compat: v0.0.1 used a single OPENAI_* pair regardless of actual
  // upstream. If the user pointed it at a non-OpenAI host, re-interpret the
  // credentials as that provider's and emit a one-time deprecation note so
  // they can rename their env var at their own pace.
  if (raw.OPENAI_API_KEY) {
    const inferred = providerFromHost(raw.OPENAI_BASE_URL);
    if (inferred !== "openai") {
      console.warn(
        `[tokensmart] OPENAI_BASE_URL points at ${inferred}. Treating OPENAI_API_KEY as ${inferred.toUpperCase()}_API_KEY. Rename it in apps/gateway/.env to silence this.`
      );
      add(inferred, raw.OPENAI_API_KEY, raw.OPENAI_BASE_URL);
    } else {
      add("openai", raw.OPENAI_API_KEY, raw.OPENAI_BASE_URL);
    }
  }

  if (raw.GOOGLE_API_KEY) add("google", raw.GOOGLE_API_KEY, raw.GOOGLE_BASE_URL);
  if (raw.DEEPSEEK_API_KEY)
    add("deepseek", raw.DEEPSEEK_API_KEY, raw.DEEPSEEK_BASE_URL);
  if (raw.QWEN_API_KEY) add("qwen", raw.QWEN_API_KEY, raw.QWEN_BASE_URL);
  if (raw.DOUBAO_API_KEY) add("doubao", raw.DOUBAO_API_KEY, raw.DOUBAO_BASE_URL);
  if (raw.ANTHROPIC_API_KEY)
    add("anthropic", raw.ANTHROPIC_API_KEY, raw.ANTHROPIC_BASE_URL);

  return reg;
}

/**
 * Find the first provider that claims this model name. Returns null when the
 * model does not match any configured provider — the route handler turns that
 * into a 400 so the caller gets a clear error instead of a silent misroute.
 */
export function pickProvider(
  model: string,
  registry: ProviderConfig[]
): ProviderConfig | null {
  return registry.find((p) => p.matches(model)) ?? null;
}

export type Env = RawEnv & { providers: ProviderConfig[] };

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("❌ Invalid environment variables:");
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    console.error(
      "\nDid you forget to copy apps/gateway/.env.example to apps/gateway/.env?"
    );
    process.exit(1);
  }

  const providers = buildRegistry(parsed.data);
  const envCryptoEnabled = !!parsed.data.TOKENSMART_PROVIDER_KEY_ENCRYPTION;
  const awsKmsEnabled = !!parsed.data.TOKENSMART_KMS_KEY_ARN;
  const gcpKmsEnabled = !!parsed.data.TOKENSMART_GCP_KMS_KEY_NAME;
  const byoEnabled = envCryptoEnabled || awsKmsEnabled || gcpKmsEnabled;

  if (awsKmsEnabled && gcpKmsEnabled) {
    console.error(
      "❌ TOKENSMART_KMS_KEY_ARN (AWS) and TOKENSMART_GCP_KMS_KEY_NAME (GCP) are both set. Pick one backend for new writes."
    );
    process.exit(1);
  }

  if (providers.length === 0 && !byoEnabled) {
    console.error(
      "❌ No upstream providers configured. Either:\n" +
        "  1. Set at least one of OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_API_KEY / DEEPSEEK_API_KEY / QWEN_API_KEY / DOUBAO_API_KEY in this gateway's env, OR\n" +
        "  2. Set TOKENSMART_PROVIDER_KEY_ENCRYPTION (32 random bytes, hex or base64) for env-master-key BYO, OR\n" +
        "  3. Set TOKENSMART_KMS_KEY_ARN (AWS KMS) OR TOKENSMART_GCP_KMS_KEY_NAME (GCP KMS) for envelope-encrypted BYO."
    );
    process.exit(1);
  }

  if (providers.length > 0) {
    const names = providers.map((p) => p.name).join(", ");
    console.log(`[tokensmart] env-configured providers: ${names}`);
  }
  if (awsKmsEnabled) {
    console.log(
      `[tokensmart] BYO provider keys via AWS KMS ENABLED (${parsed.data.TOKENSMART_KMS_KEY_ARN})`
    );
  } else if (gcpKmsEnabled) {
    console.log(
      `[tokensmart] BYO provider keys via GCP KMS ENABLED (${parsed.data.TOKENSMART_GCP_KMS_KEY_NAME})`
    );
  }
  if ((awsKmsEnabled || gcpKmsEnabled) && envCryptoEnabled) {
    console.log(
      "[tokensmart]   env master key ALSO present — dual-backend mode. Run `bun run migrate-to-kms` once to sweep env rows to KMS."
    );
  } else if (envCryptoEnabled && !awsKmsEnabled && !gcpKmsEnabled) {
    console.log(
      "[tokensmart] BYO provider keys ENABLED (env master key — consider migrating to KMS for production)"
    );
  }

  return { ...parsed.data, providers };
}

export const env = loadEnv();
