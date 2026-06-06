import {
  getActiveBudgets,
  getSpendForPeriodMicroCents,
  releaseBudgetReservations,
  reserveBudgetForRequest,
  type Budget,
  type BudgetReservationAttempt,
  type BudgetPeriod,
} from "./db";
import {
  estimateMicroCentsForReservation,
  type ReservationPricingBasis,
} from "./pricing";
import type { ProviderName } from "./pricing";
import type { OpenAIChatRequest } from "./providers/openai";

export type BudgetCheck =
  | { ok: true }
  | {
      ok: false;
      period: BudgetPeriod;
      limit_micro_cents: number;
      spend_micro_cents: number;
    };

export type BudgetReservationCheck = BudgetReservationAttempt & {
  estimated_input_tokens?: number;
  estimated_output_tokens?: number;
  pricing_basis?: ReservationPricingBasis;
};

/**
 * Check every enabled budget for this project. If any budget's current-period
 * spend is already at or above its limit, block. Returns the first blocking
 * budget so the caller can surface a clear error body.
 *
 * Both limit and spend are in micro_cents (1 cent = 1000 micro_cents) so that
 * cheap models and small budgets can be exercised without rounding to zero.
 *
 * This is the v0 enforcement rule and it errs on the side of strictness:
 * once you're at 100% of a period budget, the next request is refused. We
 * do not pre-deduct the next request's estimated cost — that requires
 * reliable cost prediction which we don't have yet.
 */
export async function checkBudget(projectId: string): Promise<BudgetCheck> {
  const budgets = await getActiveBudgets(projectId);
  if (budgets.length === 0) return { ok: true };

  // Query spend per distinct period once, not per budget row.
  const periods = Array.from(new Set(budgets.map((b) => b.period)));
  const spendByPeriod = new Map<BudgetPeriod, number>();
  await Promise.all(
    periods.map(async (p) => {
      spendByPeriod.set(p, await getSpendForPeriodMicroCents(projectId, p));
    })
  );

  for (const b of budgets) {
    const spendMicro = spendByPeriod.get(b.period) ?? 0;
    if (spendMicro >= b.limit_micro_cents) {
      return {
        ok: false,
        period: b.period,
        limit_micro_cents: b.limit_micro_cents,
        spend_micro_cents: spendMicro,
      };
    }
  }

  return { ok: true };
}

const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const MAX_ESTIMATED_OUTPUT_TOKENS = 128_000;

function estimateTokensFromValue(value: unknown): number {
  let text = "";
  try {
    text = JSON.stringify(value ?? "");
  } catch {
    text = String(value ?? "");
  }
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

function numericBodyField(body: OpenAIChatRequest, key: string): number | null {
  const raw = body[key];
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function estimateOutputTokens(body: OpenAIChatRequest): number {
  const explicit =
    numericBodyField(body, "max_completion_tokens") ??
    numericBodyField(body, "max_tokens");
  const perChoice = Math.min(
    Math.ceil(explicit ?? DEFAULT_MAX_OUTPUT_TOKENS),
    MAX_ESTIMATED_OUTPUT_TOKENS
  );
  const n = Math.max(1, Math.ceil(numericBodyField(body, "n") ?? 1));
  return perChoice * n;
}

export function estimateChatTokenUsage(body: OpenAIChatRequest): {
  estimated_input_tokens: number;
  estimated_output_tokens: number;
} {
  const promptShape = {
    messages: body.messages,
    tools: body.tools,
    tool_choice: body.tool_choice,
    response_format: body.response_format,
    parallel_tool_calls: body.parallel_tool_calls,
  };
  return {
    estimated_input_tokens: estimateTokensFromValue(promptShape),
    estimated_output_tokens: estimateOutputTokens(body),
  };
}

export function estimateChatCostMicroCents(
  provider: ProviderName | null,
  model: string,
  body: OpenAIChatRequest
): {
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  estimated_micro_cents: number;
  pricing_basis: ReservationPricingBasis;
} {
  const {
    estimated_input_tokens: estimatedInputTokens,
    estimated_output_tokens: estimatedOutputTokens,
  } = estimateChatTokenUsage(body);
  const reservation = estimateMicroCentsForReservation(
    provider,
    model,
    estimatedInputTokens,
    estimatedOutputTokens,
    0
  );
  return {
    estimated_input_tokens: estimatedInputTokens,
    estimated_output_tokens: estimatedOutputTokens,
    estimated_micro_cents: reservation.estimated_micro_cents,
    pricing_basis: reservation.basis,
  };
}

export async function checkAndReserveBudget(
  projectId: string,
  provider: ProviderName,
  model: string,
  body: OpenAIChatRequest
): Promise<BudgetReservationCheck> {
  const estimate = estimateChatCostMicroCents(provider, model, body);
  const reservation = await reserveBudgetForRequest(
    projectId,
    estimate.estimated_micro_cents
  );
  return {
    ...reservation,
    estimated_input_tokens: estimate.estimated_input_tokens,
    estimated_output_tokens: estimate.estimated_output_tokens,
    pricing_basis: estimate.pricing_basis,
  };
}

export { releaseBudgetReservations };
export type { Budget, BudgetPeriod };
