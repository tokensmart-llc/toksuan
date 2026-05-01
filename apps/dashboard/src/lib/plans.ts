/**
 * Plan definitions — kept in lockstep with `apps/gateway/src/plans.ts`.
 * Edit in both places when you add a tier.
 *
 * `dailyMicroCentsLimit` is the cap on LLM spend we will TRACK per 24h
 * (rolling, by the user's clock). Going over it blocks further requests
 * through the gateway.
 *
 * `monthlyRequestLimit` (added in v0.2.x) is the parallel rolling-30d
 * successful-request count cap — whichever cap hits first wins.
 *
 * `priceCapUsdPerMonth` is what the customer pays under the Q3 2026
 * outcome-aligned `max(floor, min(% × monthly_savings, cap))` model.
 * `priceFloorUsdPerMonth` is the per-month minimum (covers our hosting cost
 * for that customer). Both are SHOWN today (predeclaration); enforcement
 * goes live in Q3 2026.
 *
 * Annual pricing offers a 17% discount (industry standard) — listed on
 * the billing page as a sister option to monthly.
 */
export type PlanId = "free" | "pro" | "team" | "scale";

export type Plan = {
  id: PlanId;
  name: string;
  /** Today: flat monthly fee. Q3 2026 onward: max-cap on the metered formula. */
  priceUsdPerMonth: number;
  /** Annual price per month equivalent (≈17% discount). */
  priceUsdPerMonthAnnual: number;
  /** Q3 2026 metered floor (the minimum monthly fee, covers hosting cost). */
  priceFloorUsdPerMonth: number;
  /** Q3 2026 metered savings-share rate. Pro/Team 10%, Scale 12%. */
  meteredRatePercent: number;
  /** Display value: "$10/day" / "Unlimited". */
  dailyLimitUsd: number;
  dailyMicroCentsLimit: number;
  /** Display value: "10,000/mo" / "Unlimited". */
  monthlyRequestLimit: number;
  /** Tier display order on the billing page (low = leftmost). */
  rank: number;
  // Short user-facing blurb for the billing page.
  tagline: string;
  features: string[];
  /** When true, the tier card shows a "Contact us" CTA instead of an upgrade button. */
  contactSales?: boolean;
};

const USD = 100_000;
const ANNUAL_DISCOUNT = 0.83; // 17% off → 83% of monthly

function mo(monthly: number): number {
  return Math.round(monthly * ANNUAL_DISCOUNT);
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    priceUsdPerMonth: 0,
    priceUsdPerMonthAnnual: 0,
    priceFloorUsdPerMonth: 0,
    meteredRatePercent: 0,
    dailyLimitUsd: 1,
    dailyMicroCentsLimit: 1 * USD,
    monthlyRequestLimit: 10_000,
    rank: 0,
    tagline: "Evaluate end-to-end. Not for production.",
    features: [
      "$1/day OR 10,000 requests/month (whichever first)",
      "Unlimited projects + API keys",
      "Savings receipts on real traffic",
      "Budget enforcement + loop detection + semantic router",
      "Shipped baseline policy (no per-workload learning)",
      "Self-host unrestricted (Apache 2.0) — run nightly retrain yourself",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceUsdPerMonth: 29,
    priceUsdPerMonthAnnual: mo(29),
    priceFloorUsdPerMonth: 9,
    meteredRatePercent: 10,
    dailyLimitUsd: 500,
    dailyMicroCentsLimit: 500 * USD,
    monthlyRequestLimit: 1_000_000,
    rank: 1,
    tagline: "Real workloads. Weekly proof, zero ops.",
    features: [
      "$500/day + 1M requests/month",
      "Everything in Free",
      "Weekly value report: saved $, top downgrades, quality proof",
      "Background-trained routing policy (nightly, per-project)",
      "Judge LLM cost included — your routing gets smarter as you use it",
      "Hosted scheduled jobs + provider/pricing maintenance",
      "Email support",
    ],
  },
  team: {
    id: "team",
    name: "Team",
    priceUsdPerMonth: 99,
    priceUsdPerMonthAnnual: mo(99),
    priceFloorUsdPerMonth: 29,
    meteredRatePercent: 10,
    dailyLimitUsd: Number.POSITIVE_INFINITY,
    dailyMicroCentsLimit: Number.POSITIVE_INFINITY,
    monthlyRequestLimit: Number.POSITIVE_INFINITY,
    rank: 2,
    tagline: "Production agents, multiple projects.",
    features: [
      "Unlimited tracked spend + unlimited requests",
      "Everything in Pro",
      "Per-project policy versioning + rollback",
      "Per-tag policy isolation (one project, multiple workloads)",
      "Audit log CSV export (compliance)",
      "Multi-seat orgs + RBAC (admin / member / viewer)",
      "Up to 5 seats per org",
      "Slack / WeChat support channel",
    ],
  },
  scale: {
    id: "scale",
    name: "Scale",
    priceUsdPerMonth: 499,
    priceUsdPerMonthAnnual: mo(499),
    priceFloorUsdPerMonth: 99,
    meteredRatePercent: 12,
    dailyLimitUsd: Number.POSITIVE_INFINITY,
    dailyMicroCentsLimit: Number.POSITIVE_INFINITY,
    monthlyRequestLimit: Number.POSITIVE_INFINITY,
    rank: 3,
    tagline: "Heavy agent fleets, mid-market eng orgs.",
    features: [
      "Unlimited tracked spend + unlimited requests",
      "Everything in Team",
      "Unlimited seats per org + RBAC",
      "SSO / SAML 2.0 (Okta, Azure AD, Google Workspace, etc.)",
      "Security-review friendly trust package",
      "Priority Slack support channel (4h business-hour response)",
      "Multi-region failover endpoint (planned, target Q1 2027)",
    ],
  },
};

/**
 * Synthetic tier displayed on the billing page only — no Stripe price,
 * no PlanId, just a "talk to us" card. Real enterprise deals are
 * negotiated bilaterally (BAA, dedicated infra, custom SLA).
 */
export type EnterpriseDisplayTier = {
  name: string;
  tagline: string;
  contactHref: string;
  features: string[];
};

export const ENTERPRISE_DISPLAY: EnterpriseDisplayTier = {
  name: "Enterprise",
  tagline: "Regulated industries, dedicated infra, custom SLA.",
  contactHref: "https://github.com/tokensmart-llc/toksuan/issues/new/choose",
  features: [
    "Everything in Scale",
    "Dedicated single-tenant deployment (your VPC or ours)",
    "BAA / DPA / custom security review",
    "Custom SLA (99.9% available with multi-region)",
    "Named technical contact + quarterly reviews",
    "Custom pricing — typically $1k+ / month",
  ],
};

export function planFromId(id: string | null | undefined): Plan {
  if (id === "pro" || id === "team" || id === "scale") return PLANS[id];
  return PLANS.free;
}

// --- Entitlements ---------------------------------------------------------
//
// Centralised answer to "is this thing allowed on this plan?". Every
// server action that gates a paid feature looks up the entitlement by
// name here; the actual tier-cutoff logic lives in this file alone, so
// changing "Team is 5 seats" to "Team is 10 seats" is a one-line edit.
//
// Values MUST stay in lockstep with the billing-page marketing copy in
// the `features: [...]` arrays above. If you lift a feature into a
// higher tier here, update the blurb there and vice versa.

/**
 * Named entitlements the dashboard enforces. Keep this enum narrow — if
 * a feature is universal (free + all paid), it doesn't belong here.
 */
export type Entitlement =
  | "create_organization"
  | "invite_org_member"
  | "configure_saml"
  | "audit_csv_export"
  | "background_policy_training";

const ENTITLEMENT_MIN_RANK: Record<Entitlement, number> = {
  // Orgs + multi-seat land at Team. Free/Pro users can still be INVITED
  // to an org (they consume a seat on the inviter's org, not their own
  // plan); they just can't HOST one.
  create_organization: PLANS.team.rank,
  invite_org_member: PLANS.team.rank,
  // SAML SSO / IdP-driven auth is a Scale feature per marketing copy.
  configure_saml: PLANS.scale.rank,
  // CSV export of audit events is a B-end compliance ask; Team+.
  audit_csv_export: PLANS.team.rank,
  // Background nightly retraining of per-project routing policy is the
  // headline paid value-prop. Pro+. (OSS users get the schema + the CLI;
  // they just have to wire their own cron.)
  background_policy_training: PLANS.pro.rank,
};

/**
 * Returns true when the given plan is allowed to use the entitlement.
 * Intended call site: server actions ("can this user do this?") + UI
 * gating ("show the upgrade card instead of the form?"). Never called
 * on the gateway hot path — plan_limits.ts handles request-level caps.
 */
export function planAllows(
  plan: PlanId | string | null | undefined,
  entitlement: Entitlement
): boolean {
  const p = planFromId(plan);
  return p.rank >= ENTITLEMENT_MIN_RANK[entitlement];
}

/**
 * Returns the required plan's name for a given entitlement — handy for
 * inline upsell messaging ("Upgrade to Team to invite a member").
 */
export function minPlanForEntitlement(entitlement: Entitlement): Plan {
  const requiredRank = ENTITLEMENT_MIN_RANK[entitlement];
  return (
    Object.values(PLANS)
      .sort((a, b) => a.rank - b.rank)
      .find((p) => p.rank >= requiredRank) ?? PLANS.scale
  );
}

/**
 * How many total members (including the owner) an org on this plan
 * may have. Returns `Number.POSITIVE_INFINITY` for unlimited tiers so
 * callers can compare with `>=` without special-casing.
 */
export function seatLimitFor(plan: PlanId | string | null | undefined): number {
  const p = planFromId(plan);
  if (p.id === "scale") return Number.POSITIVE_INFINITY;
  if (p.id === "team") return 5;
  // Free + Pro don't host orgs — they only consume seats on someone
  // else's org. This value matters only if they somehow have one
  // (legacy / pre-entitlement-enforcement); treat as 1.
  return 1;
}

export function stripePriceIdForPlan(plan: PlanId): string | null {
  if (plan === "pro") return process.env.STRIPE_PRICE_PRO ?? null;
  if (plan === "team") return process.env.STRIPE_PRICE_TEAM ?? null;
  if (plan === "scale") return process.env.STRIPE_PRICE_SCALE ?? null;
  return null;
}

/** Annual price ID counterparts. Optional — many operators only list monthly. */
export function stripePriceIdForPlanAnnual(plan: PlanId): string | null {
  if (plan === "pro") return process.env.STRIPE_PRICE_PRO_ANNUAL ?? null;
  if (plan === "team") return process.env.STRIPE_PRICE_TEAM_ANNUAL ?? null;
  if (plan === "scale") return process.env.STRIPE_PRICE_SCALE_ANNUAL ?? null;
  return null;
}
