import { env } from "./config";
import { estimateChatTokenUsage } from "./budget";
import { LruTtlCache } from "./lru-ttl-cache";
import { calcCostMicroCents, type ProviderName } from "./pricing";
import type { OpenAIChatRequest } from "./providers/openai";

export type SessionRouteState = {
  landedModel: string;
  provider: ProviderName;
  /**
   * Optional logical turn number from `x-ts-turn`. When present, state updates
   * are monotonic: an older parallel request that finishes late cannot
   * overwrite a newer turn's model/cache observation.
   */
  turnNumber: number | null;
  /** Real prompt-token count from the previous turn's upstream `usage`. */
  observedInputTokens: number;
  /**
   * Real prompt-cache-read token count from the previous turn's `usage`
   * (`prompt_tokens_details.cached_tokens` / `cache_read_input_tokens`).
   * This is the ground truth of how much of the prefix the provider
   * actually served from cache — we use it instead of assuming the whole
   * prefix is warm.
   */
  observedCachedInputTokens: number;
};

export type CacheAwareRouteDecision =
  | {
      action:
        | "disabled"
        | "not_automatic"
        | "no_session"
        | "no_state"
        | "same_model"
        | "no_cache_benefit"
        | "unpriced"
        | "switch";
      finalModel: string;
      previousModel?: string;
      reason: string;
      estimatedInputTokens?: number;
      estimatedOutputTokens?: number;
      warmPrefixTokens?: number;
      stayCostMicroCents?: number;
      switchCostMicroCents?: number;
      savingsMicroCents?: number;
    }
  | {
      action: "stay";
      finalModel: string;
      previousModel: string;
      previousProvider: ProviderName;
      candidateModel: string;
      reason: string;
      estimatedInputTokens: number;
      estimatedOutputTokens: number;
      warmPrefixTokens: number;
      stayCostMicroCents: number;
      switchCostMicroCents: number;
      savingsMicroCents: number;
    };

let routeStateCache: LruTtlCache<SessionRouteState> | null = null;

function cache(): LruTtlCache<SessionRouteState> {
  if (!routeStateCache) {
    const max = Math.max(0, Math.floor(env.TOKENSMART_CACHE_AWARE_MAX_SESSIONS));
    const ttlMs = Math.max(
      0,
      Math.floor(env.TOKENSMART_CACHE_AWARE_SESSION_TTL_MS)
    );
    routeStateCache = new LruTtlCache<SessionRouteState>(max, ttlMs);
  }
  return routeStateCache;
}

function enabled(): boolean {
  return env.TOKENSMART_CACHE_AWARE_ROUTING !== "0";
}

function key(projectId: string, sessionId: string): string {
  return `${projectId}:${sessionId}`;
}

function minimumInputTokens(): number {
  return Math.max(0, Math.floor(env.TOKENSMART_CACHE_AWARE_MIN_INPUT_TOKENS));
}

function minimumSavingsRatio(): number {
  const raw = env.TOKENSMART_CACHE_AWARE_MIN_SAVINGS_RATIO;
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function upgradeCostRatio(): number {
  const raw = env.TOKENSMART_CACHE_AWARE_UPGRADE_COST_RATIO;
  // Must be > 1 to be meaningful; fall back to the default if misconfigured.
  return Number.isFinite(raw) && raw > 1 ? raw : 1.15;
}

function parseTurnNumber(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  const n =
    typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function recordSessionRouteState(args: {
  projectId: string;
  sessionId: string | null | undefined;
  turnId?: string | number | null;
  landedModel: string;
  provider: ProviderName;
  inputTokens: number;
  cachedInputTokens: number;
}): void {
  if (!enabled()) return;
  const sessionId = String(args.sessionId ?? "").trim();
  if (!sessionId) return;
  if (!args.landedModel || args.inputTokens <= 0) return;
  const observedInputTokens = Math.max(1, Math.floor(args.inputTokens));
  const observedCachedInputTokens = Math.max(
    0,
    Math.min(observedInputTokens, Math.floor(args.cachedInputTokens))
  );
  const stateKey = key(args.projectId, sessionId);
  const turnNumber = parseTurnNumber(args.turnId);
  const existing = cache().get(stateKey);
  if (
    existing &&
    existing.turnNumber != null &&
    turnNumber != null &&
    turnNumber < existing.turnNumber
  ) {
    return;
  }
  cache().set(stateKey, {
    landedModel: args.landedModel,
    provider: args.provider,
    turnNumber,
    observedInputTokens,
    observedCachedInputTokens,
  });
}

export function evaluateCacheAwareRouting(args: {
  projectId: string;
  sessionId: string | null | undefined;
  body: OpenAIChatRequest;
  candidateModel: string;
  candidateProvider: ProviderName;
  automaticRouting: boolean;
}): CacheAwareRouteDecision {
  const candidateModel = String(args.candidateModel ?? "");
  if (!enabled()) {
    return {
      action: "disabled",
      finalModel: candidateModel,
      reason: "cache_aware_disabled",
    };
  }
  if (!args.automaticRouting) {
    return {
      action: "not_automatic",
      finalModel: candidateModel,
      reason: "not_automatic_routing",
    };
  }

  const sessionId = String(args.sessionId ?? "").trim();
  if (!sessionId) {
    return {
      action: "no_session",
      finalModel: candidateModel,
      reason: "no_session",
    };
  }

  const previous = cache().get(key(args.projectId, sessionId));
  if (!previous) {
    return {
      action: "no_state",
      finalModel: candidateModel,
      reason: "no_session_route_state",
    };
  }
  if (previous.landedModel === candidateModel) {
    return {
      action: "same_model",
      finalModel: candidateModel,
      previousModel: previous.landedModel,
      reason: "same_model",
    };
  }

  // Use the PREVIOUS turn's MEASURED cache-hit ratio rather than assuming
  // the whole prefix is warm. If the provider served 90% of last turn's
  // prompt from cache, this session is genuinely cache-heavy on that model
  // and the prefix is worth protecting. If it served ~0% (cold, or the
  // model/provider simply isn't caching this prompt), there is no cache
  // benefit to defend and we let the cheaper candidate win.
  //
  // Self-correcting caveat: the first turn that WRITES a fresh cache reports
  // ~0 reads, so the immediately following switch is under-protected by one
  // turn. Once any turn actually reads from cache, the ratio reflects reality.
  const observedHitRatio =
    previous.observedInputTokens > 0
      ? previous.observedCachedInputTokens / previous.observedInputTokens
      : 0;
  if (observedHitRatio <= 0) {
    return {
      action: "no_cache_benefit",
      finalModel: candidateModel,
      previousModel: previous.landedModel,
      reason: "no_observed_cache_benefit",
      warmPrefixTokens: 0,
    };
  }

  const {
    estimated_input_tokens: estimatedInputTokens,
    estimated_output_tokens: estimatedOutputTokens,
  } = estimateChatTokenUsage(args.body);

  const warmPrefixTokens = Math.max(
    0,
    Math.min(
      estimatedInputTokens,
      Math.round(estimatedInputTokens * observedHitRatio)
    )
  );
  if (warmPrefixTokens < minimumInputTokens()) {
    return {
      action: "no_cache_benefit",
      finalModel: candidateModel,
      previousModel: previous.landedModel,
      reason: "no_observed_cache_benefit",
      estimatedInputTokens,
      estimatedOutputTokens,
      warmPrefixTokens,
    };
  }

  const stayCostMicroCents = calcCostMicroCents(
    previous.provider,
    previous.landedModel,
    estimatedInputTokens,
    estimatedOutputTokens,
    warmPrefixTokens
  );
  const switchCostMicroCents = calcCostMicroCents(
    args.candidateProvider,
    candidateModel,
    estimatedInputTokens,
    estimatedOutputTokens,
    0
  );
  const previousFreshCostMicroCents = calcCostMicroCents(
    previous.provider,
    previous.landedModel,
    estimatedInputTokens,
    estimatedOutputTokens,
    0
  );

  if (
    stayCostMicroCents <= 0 ||
    switchCostMicroCents <= 0 ||
    previousFreshCostMicroCents <= 0
  ) {
    return {
      action: "unpriced",
      finalModel: candidateModel,
      previousModel: previous.landedModel,
      reason: "unpriced_model",
      estimatedInputTokens,
      estimatedOutputTokens,
      warmPrefixTokens,
      stayCostMicroCents,
      switchCostMicroCents,
      savingsMicroCents: stayCostMicroCents - switchCostMicroCents,
    };
  }

  // Treat a materially more expensive candidate as an intentional quality
  // upgrade and do not let cache economics block it. The guard's main job is
  // to stop marginal downgrades that lose a hot prompt prefix.
  if (switchCostMicroCents > previousFreshCostMicroCents * upgradeCostRatio()) {
    return {
      action: "switch",
      finalModel: candidateModel,
      previousModel: previous.landedModel,
      reason: "candidate_upgrade",
      estimatedInputTokens,
      estimatedOutputTokens,
      warmPrefixTokens,
      stayCostMicroCents,
      switchCostMicroCents,
      savingsMicroCents: stayCostMicroCents - switchCostMicroCents,
    };
  }

  const savingsMicroCents = stayCostMicroCents - switchCostMicroCents;
  const minSavingsMicroCents = Math.max(
    1,
    Math.ceil(stayCostMicroCents * minimumSavingsRatio())
  );
  if (savingsMicroCents >= minSavingsMicroCents) {
    return {
      action: "switch",
      finalModel: candidateModel,
      previousModel: previous.landedModel,
      reason: "net_savings",
      estimatedInputTokens,
      estimatedOutputTokens,
      warmPrefixTokens,
      stayCostMicroCents,
      switchCostMicroCents,
      savingsMicroCents,
    };
  }

  return {
    action: "stay",
    finalModel: previous.landedModel,
    previousModel: previous.landedModel,
    previousProvider: previous.provider,
    candidateModel,
    reason: "cache_cold_start_not_worth_switching",
    estimatedInputTokens,
    estimatedOutputTokens,
    warmPrefixTokens,
    stayCostMicroCents,
    switchCostMicroCents,
    savingsMicroCents,
  };
}

export function _resetSessionRouteGuardForTests(): void {
  routeStateCache?.clear();
  routeStateCache = null;
}
