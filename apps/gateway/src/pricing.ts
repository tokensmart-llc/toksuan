// Cost calculation per model.
//
// All prices in USD per 1 million tokens, sourced from public pricing pages.
// Unit on disk: micro_cents (1 cent = 1000 micro_cents) for sub-cent precision.
//
// SOURCE OF TRUTH: `apps/gateway/data/pricing.json`. This file is loaded at
// boot and replaces the embedded `EMBEDDED_FALLBACK` table. To refresh prices:
//
//   bun run check-pricing-freshness   # which entries are stale?
//   bun run refresh-pricing           # interactive review + verified bump
//
// The embedded fallback below is a SAFETY NET — it guarantees the gateway
// boots even if `data/pricing.json` is missing or malformed. It deliberately
// only carries the few models the test suite + dev seed depend on; trust
// the JSON file for everything else.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export type Provider =
  | "openai"
  | "anthropic"
  | "google"
  | "deepseek"
  | "qwen"
  | "doubao";

/**
 * Runtime-resolved provider identifier. Either a built-in `Provider`
 * or a user-scoped custom provider namespace of the form
 * `custom:<uuid>`. Used by the resolver / key-rotator / logging paths
 * where a custom user-registered upstream (L4) needs its own pool +
 * pricing lookup isolation from the built-in providers.
 *
 * The pricing table is keyed by the narrower `Provider` only — custom
 * providers skip the exact-lookup path and fall back to the family_max
 * safety budget. That's deliberate: we can't know an arbitrary
 * upstream's price without the operator telling us.
 */
export type CustomProviderName = `custom:${string}`;
export type ProviderName = Provider | CustomProviderName;

/**
 * Type guard: narrows a ProviderName to the built-in enum. Everything
 * past this check is a user-scoped custom provider and should be
 * handled via the family_max fallback path (reservation + pricing).
 */
export function isBuiltInProvider(name: ProviderName): name is Provider {
  return !name.startsWith("custom:");
}

export type ModelPricing = {
  provider: Provider;
  model: string;
  // USD per 1M tokens. Multiplied by tokens / 1_000_000 to get cost in USD.
  inputUsdPerM: number;
  outputUsdPerM: number;
  // Discounted input rate for tokens the provider served from its prompt
  // cache. When omitted, we fall back to 50% of `inputUsdPerM`, which
  // matches OpenAI's public policy and is close enough for other providers.
  cachedInputUsdPerM?: number;
  // Provenance metadata (optional, populated when the entry comes from
  // pricing.json). Surfaced by the freshness check; not used at hot path.
  source_url?: string;
  last_verified_at?: string; // YYYY-MM-DD
  notes?: string;
};

const PROVIDER_ENUM = z.enum([
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "qwen",
  "doubao",
]);

const PricingEntrySchema = z.object({
  provider: PROVIDER_ENUM,
  model: z.string().min(1),
  inputUsdPerM: z.number().nonnegative(),
  outputUsdPerM: z.number().nonnegative(),
  cachedInputUsdPerM: z.number().nonnegative().optional(),
  source_url: z.string().url().optional(),
  last_verified_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
    .optional(),
  notes: z.string().optional(),
});

export const PricingFileSchema = z.object({
  generated_at: z.string().optional(),
  notes: z.string().optional(),
  entries: z.array(PricingEntrySchema).min(1),
});

export type PricingFile = z.infer<typeof PricingFileSchema>;

/**
 * Bare-minimum pricing table compiled into the binary. Used ONLY as a
 * fallback when `data/pricing.json` is missing or malformed at boot, so
 * the gateway never refuses to start because of a misplaced data file.
 *
 * Only carries models the test suite + dev seed actually depend on —
 * everyone else needs the JSON. The freshness check + refresh script
 * operate against the JSON, never this list.
 */
const EMBEDDED_FALLBACK: ModelPricing[] = [
  { provider: "openai", model: "gpt-4o", inputUsdPerM: 2.5, outputUsdPerM: 10.0, cachedInputUsdPerM: 1.25 },
  { provider: "openai", model: "gpt-4o-mini", inputUsdPerM: 0.15, outputUsdPerM: 0.6, cachedInputUsdPerM: 0.075 },
  { provider: "openai", model: "o1-preview", inputUsdPerM: 15.0, outputUsdPerM: 60.0, cachedInputUsdPerM: 7.5 },
  { provider: "anthropic", model: "claude-3-5-sonnet-latest", inputUsdPerM: 3.0, outputUsdPerM: 15.0, cachedInputUsdPerM: 0.3 },
];

/**
 * Search for `data/pricing.json` in the locations that make sense in
 * dev (running from apps/gateway), in the Docker image (where WORKDIR
 * is /app and data/ is mounted alongside src/), and behind an explicit
 * env override (operator with non-standard layout). Returns the first
 * existing path or null.
 */
export function findPricingFile(): string | null {
  const explicit = process.env.TOKENSMART_PRICING_FILE;
  if (explicit) return existsSync(explicit) ? explicit : null;
  const candidates = [
    // Dev: bun run from apps/gateway
    path.resolve(process.cwd(), "data/pricing.json"),
    // Repo root
    path.resolve(process.cwd(), "apps/gateway/data/pricing.json"),
    // Source-relative — works in Bun even when cwd is somewhere weird
    typeof import.meta.dir === "string"
      ? path.resolve(import.meta.dir, "../data/pricing.json")
      : null,
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Load + validate the pricing file. Returns null on any failure (caller
 * decides fallback). All failure paths log a single line so an operator
 * can grep `[pricing]` to see why we're on the embedded table.
 */
export function loadPricingFile(filePath: string): ModelPricing[] | null {
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    const parsed = PricingFileSchema.parse(raw);
    return parsed.entries.map((e) => ({
      provider: e.provider as Provider,
      model: e.model,
      inputUsdPerM: e.inputUsdPerM,
      outputUsdPerM: e.outputUsdPerM,
      cachedInputUsdPerM: e.cachedInputUsdPerM,
      source_url: e.source_url,
      last_verified_at: e.last_verified_at,
      notes: e.notes,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[pricing] failed to load ${filePath} (${msg}); using embedded fallback`
    );
    return null;
  }
}

function resolveTable(): ModelPricing[] {
  const file = findPricingFile();
  if (!file) {
    console.warn(
      "[pricing] data/pricing.json not found; using embedded fallback (only common models priced). " +
        "Set TOKENSMART_PRICING_FILE if it lives elsewhere."
    );
    return EMBEDDED_FALLBACK;
  }
  const loaded = loadPricingFile(file);
  if (!loaded) return EMBEDDED_FALLBACK;
  console.log(
    `[pricing] loaded ${loaded.length} model price(s) from ${file}`
  );
  return loaded;
}

const TABLE: ModelPricing[] = resolveTable();

const lookup = new Map<string, ModelPricing>(TABLE.map((p) => [`${p.provider}:${p.model}`, p]));

export function findPricing(provider: Provider, model: string): ModelPricing | null {
  return lookup.get(`${provider}:${model}`) ?? null;
}

/**
 * Effective cached rate for a model, falling back to 50% of input rate when
 * the table doesn't list an explicit cached rate. 50% mirrors OpenAI's
 * published policy and is close enough for the providers we care about.
 */
function effectiveCachedRate(p: ModelPricing): number {
  return p.cachedInputUsdPerM ?? p.inputUsdPerM * 0.5;
}

/**
 * Calculate the cost of a request in micro_cents (1 cent = 1000 micro_cents).
 * Returns 0 if the model is not in our pricing table — we still log the call.
 *
 * `cachedInputTokens` is optional and defaults to 0. When present, those
 * tokens are billed at the model's cached rate (usually 25-50% of input),
 * and the remaining `inputTokens - cachedInputTokens` are billed at the
 * full input rate.
 */
export function calcCostMicroCents(
  providerName: ProviderName,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0
): number {
  // Custom providers (L4) have no pricing data → treat as $0 cost.
  // The reservation path already stamped a family_max / global_max
  // safety budget, so this zero just prevents double-counting.
  if (!isBuiltInProvider(providerName)) return 0;
  const provider = providerName;
  const p = findPricing(provider, model);
  if (!p) return 0;

  const cached = Math.max(0, Math.min(cachedInputTokens, inputTokens));
  const fresh = Math.max(0, inputTokens - cached);

  const toMicroCents = (tokens: number, usdPerM: number): number =>
    (tokens * usdPerM * 100 * 1000) / 1_000_000;

  const inputMicroCents = toMicroCents(fresh, p.inputUsdPerM);
  const cachedMicroCents = toMicroCents(cached, effectiveCachedRate(p));
  const outputMicroCents = toMicroCents(outputTokens, p.outputUsdPerM);

  return Math.round(inputMicroCents + cachedMicroCents + outputMicroCents);
}

/**
 * Safety multiplier applied when we can't price a model exactly and have
 * to fall back to family-max or global-max. Makes the reservation
 * deliberately too pessimistic so a never-before-seen model name CAN'T
 * silently bypass budget gating; the worst that can happen is we
 * temporarily over-reserve and then release back at finalize.
 */
const UNKNOWN_MODEL_SAFETY_MULTIPLIER = 1.5;

/**
 * Worst-case input/output rate within a provider — used when we don't
 * recognise the specific model name. We don't memoise: TABLE is small
 * (a few dozen entries) and this only fires on the cold path of a
 * never-before-seen model id, which is rare enough that the per-call
 * scan is cheaper than a Map keyed on (provider) we'd have to maintain.
 */
function familyMax(provider: Provider): {
  inputUsdPerM: number;
  outputUsdPerM: number;
} | null {
  let inputMax = 0;
  let outputMax = 0;
  let found = false;
  for (const p of TABLE) {
    if (p.provider !== provider) continue;
    found = true;
    if (p.inputUsdPerM > inputMax) inputMax = p.inputUsdPerM;
    if (p.outputUsdPerM > outputMax) outputMax = p.outputUsdPerM;
  }
  return found ? { inputUsdPerM: inputMax, outputUsdPerM: outputMax } : null;
}

/**
 * Worst-case input/output rate across ALL providers. Last-resort
 * fallback when the provider isn't even in our table — covers the case
 * where a customer routes through TokSuan to an upstream we've never
 * heard of (custom on-prem endpoint named "openai-compat", say). Still
 * better than estimating 0 and silently bypassing the gate.
 */
function globalMax(): { inputUsdPerM: number; outputUsdPerM: number } {
  let inputMax = 0;
  let outputMax = 0;
  for (const p of TABLE) {
    if (p.inputUsdPerM > inputMax) inputMax = p.inputUsdPerM;
    if (p.outputUsdPerM > outputMax) outputMax = p.outputUsdPerM;
  }
  return { inputUsdPerM: inputMax, outputUsdPerM: outputMax };
}

export type ReservationPricingBasis = "exact" | "family_max" | "global_max";

export type ReservationEstimate = {
  estimated_micro_cents: number;
  basis: ReservationPricingBasis;
};

/**
 * Cost estimate suitable for PRE-FLIGHT reservation gating.
 *
 * The contract differs from `calcCostMicroCents` in two ways:
 *
 *   1. Never returns 0 when the model is unknown. Instead falls back to
 *      the most expensive (input, output) rate observed within the
 *      provider's family, then to the global worst case. Multiplied by
 *      a safety factor so we err toward over-reserving — a budget cap
 *      that lets a never-before-seen model name through with $0
 *      reservation defeats the purpose of having budget caps at all.
 *
 *   2. Returns the basis of the estimate so the caller can surface
 *      "estimated via family_max fallback" to operators reading the
 *      ledger or the dashboard. This is OPS-grade transparency: the
 *      operator should know when the reservation amount was a guess.
 *
 * `cachedInputTokens` is treated as "fresh" tokens for fallback paths
 * (we don't have a cached-rate guess for unknown models), which is the
 * most pessimistic interpretation.
 */
export function estimateMicroCentsForReservation(
  providerName: ProviderName | null,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0
): ReservationEstimate {
  // Custom providers (L4) have no pricing in our table — narrow to
  // null so the family_max / global_max fallback path picks up from
  // here and stamps `basis: "global_max"` on the reservation. The
  // upshot: user's custom Groq / vLLM / etc. upstreams still get a
  // safety-budget reservation; they just don't benefit from the
  // precise pricing we ship for built-ins.
  const provider =
    providerName != null && isBuiltInProvider(providerName)
      ? providerName
      : null;
  if (provider != null) {
    const exact = findPricing(provider, model);
    if (exact) {
      return {
        estimated_micro_cents: calcCostMicroCents(
          provider,
          model,
          inputTokens,
          outputTokens,
          cachedInputTokens
        ),
        basis: "exact",
      };
    }
    const fam = familyMax(provider);
    if (fam) {
      const toMicroCents = (tokens: number, usdPerM: number): number =>
        (tokens * usdPerM * 100 * 1000) / 1_000_000;
      const raw =
        toMicroCents(inputTokens, fam.inputUsdPerM) +
        toMicroCents(outputTokens, fam.outputUsdPerM);
      return {
        estimated_micro_cents: Math.round(
          raw * UNKNOWN_MODEL_SAFETY_MULTIPLIER
        ),
        basis: "family_max",
      };
    }
  }
  const g = globalMax();
  const toMicroCents = (tokens: number, usdPerM: number): number =>
    (tokens * usdPerM * 100 * 1000) / 1_000_000;
  const raw =
    toMicroCents(inputTokens, g.inputUsdPerM) +
    toMicroCents(outputTokens, g.outputUsdPerM);
  return {
    estimated_micro_cents: Math.round(raw * UNKNOWN_MODEL_SAFETY_MULTIPLIER),
    basis: "global_max",
  };
}

/**
 * How many micro_cents we saved by routing a request from `originalModel`
 * (under `originalProvider`) down to the model that actually handled it
 * (`actualCostMicroCents`). Uses the routed model's actual token counts as
 * a conservative counterfactual — this slightly underestimates savings for
 * models with heavier tokenizers but never inflates them, which is the
 * only posture a "we saved you $X" claim can defensibly take.
 *
 * Returns 0 when:
 *   - Not a routed request (originalModel null or equals current)
 *   - Unknown original model in the pricing table
 *   - Counterfactual cost is somehow lower than actual (pathological;
 *     clamped to 0 to avoid "negative savings" confusing the UI)
 */
export function calcRoutingSavingMicroCents(
  originalProvider: Provider | null,
  originalModel: string | null,
  currentModel: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  actualCostMicroCents: number
): number {
  if (!originalProvider || !originalModel) return 0;
  if (originalModel === currentModel) return 0;
  const wouldHaveCost = calcCostMicroCents(
    originalProvider,
    originalModel,
    inputTokens,
    outputTokens,
    cachedInputTokens
  );
  if (wouldHaveCost <= 0) return 0; // unpriced original model → can't claim a saving
  return Math.max(0, wouldHaveCost - actualCostMicroCents);
}

/**
 * How many micro_cents we saved by serving `cachedInputTokens` from the
 * provider's prompt cache instead of paying the full input rate. Returns 0
 * if the model isn't priced.
 */
export function calcCacheSavingsMicroCents(
  providerName: ProviderName,
  model: string,
  cachedInputTokens: number
): number {
  if (!isBuiltInProvider(providerName)) return 0;
  const provider = providerName;
  const p = findPricing(provider, model);
  if (!p || cachedInputTokens <= 0) return 0;

  const freshCost = (cachedInputTokens * p.inputUsdPerM * 100 * 1000) / 1_000_000;
  const cachedCost =
    (cachedInputTokens * effectiveCachedRate(p) * 100 * 1000) / 1_000_000;
  return Math.round(freshCost - cachedCost);
}

/**
 * Convert micro_cents to whole cents, rounded down (we never round cost up to user).
 */
export function microCentsToCents(microCents: number): number {
  return Math.floor(microCents / 1000);
}
