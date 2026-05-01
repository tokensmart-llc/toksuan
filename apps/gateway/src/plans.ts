/**
 * Plan definitions — kept in lockstep with `apps/dashboard/src/lib/plans.ts`.
 * Edit in both places when you add a tier.
 *
 * Each plan caps two dimensions on hosted accounts:
 *   - dailyMicroCentsLimit — rolling-24h tracked LLM spend (the existing cap)
 *   - monthlyRequestLimit  — rolling-30d successful request count (new in v0.2.x
 *     as part of the 4-tier pricing rework). Whichever cap hits first wins.
 *
 * `Number.POSITIVE_INFINITY` = no enforcement on that dimension. Self-hosted
 * single-tenant installs always have unlimited everything.
 */
export type PlanId = "free" | "pro" | "team" | "scale";

export type PlanLimits = {
  /** Cap on LLM spend we'll track through the gateway per 24h, in micro_cents. */
  dailyMicroCentsLimit: number;
  /** Cap on successful requests in the rolling 30-day window. */
  monthlyRequestLimit: number;
};

const USD = 100_000;

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  // Free is "real evaluation, not production" — lowered from $10/day to $1/day
  // so prospective customers can complete a meaningful POC but can't run a
  // production agent. Monthly request cap added at 10k to align with the rest
  // of the LLM-gateway market (Helicone/LiteLLM/Portkey all give 10k req/mo).
  free: {
    dailyMicroCentsLimit: 1 * USD,
    monthlyRequestLimit: 10_000,
  },
  // Pro stays at $500/day (no change for existing customers). Added a 1M
  // request/month cap as a sanity check — abusive request floods still get
  // capped before they can cost the operator (or upstream providers) real money.
  pro: {
    dailyMicroCentsLimit: 500 * USD,
    monthlyRequestLimit: 1_000_000,
  },
  // Team stays unlimited on $ (no change for existing customers).
  team: {
    dailyMicroCentsLimit: Number.POSITIVE_INFINITY,
    monthlyRequestLimit: Number.POSITIVE_INFINITY,
  },
  // Scale (new in v0.2.x): same $/req limits as Team, but unlocks the
  // features that justify the higher cap on the Q3 metered model
  // (SSO/SAML, RBAC, multi-region failover, priority Slack channel).
  // Enforcement-wise it's identical to Team — the differentiation is the
  // feature gates and the metered cap ceiling.
  scale: {
    dailyMicroCentsLimit: Number.POSITIVE_INFINITY,
    monthlyRequestLimit: Number.POSITIVE_INFINITY,
  },
};

export function limitsForPlan(plan: string | null | undefined): PlanLimits {
  if (plan === "pro" || plan === "team" || plan === "scale") return PLAN_LIMITS[plan];
  return PLAN_LIMITS.free;
}
