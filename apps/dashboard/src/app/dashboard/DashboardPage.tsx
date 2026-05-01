import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getScope, getSession, isAuthEnabled } from "@/lib/auth";
import {
  getAbExperimentSummary,
  getBlockedCount,
  getBudgetStatus,
  getCacheSavingsMicroCents,
  getCachedInputTokens,
  getDailyStats,
  getLoopCount,
  getPlanLimitBlockedCount,
  getQualityProofSummary,
  getRecentRequests,
  getRecommendations,
  getRoutedCount,
  getSavingsBreakdown,
  getSpendByModel,
  getSpendByTag,
  getTopLoops,
  getTopRoutedPairs,
  getTotalSpendMicroCents,
  listProviderKeysForUser,
  listProjectsForUser,
  type AbExperimentSummary,
  type BudgetStatus,
  type DailyStats,
  type Project,
  type QualityProofSummary,
  type RecentRequest,
  type Recommendation,
  type SavingsBreakdown,
  type SpendByTag,
  type TopLoop,
  type TopRoutedPair,
  type UserProviderKeyRow,
} from "@/lib/db";
import { AutoRefresh } from "@/components/AutoRefresh";
import { DailyBars, type DailyBar } from "@/components/DailyBars";
import { ShareBar } from "@/components/ShareBar";
import { Sparkline } from "@/components/Sparkline";
import { QuickBudgetCTA } from "@/components/QuickBudgetCTA";
import { detectSpendAnomaly, type AnomalyVerdict } from "@/lib/anomaly";
import {
  getPublicGatewayChatUrl,
} from "@/lib/public-url";
import { getDocsUrl } from "@/lib/docs-url";
import { isHostedMode } from "@/lib/mode";
import { getDictionary } from "@/lib/i18n.server";
import type { Dictionary } from "@/i18n/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MICRO_PER_USD = 100_000;
const COLLAPSE_THRESHOLD = 3;

function fmtMicroAsUsd(microCents: number, digits = 4): string {
  return `$${(microCents / MICRO_PER_USD).toFixed(digits)}`;
}

/**
 * "Smart" USD formatter for the savings hero: picks decimals by magnitude so
 * sub-cent savings stay visible but $1234.56 doesn't turn into $1234.5678.
 */
function fmtSavingsUsd(microCents: number): string {
  const usd = microCents / MICRO_PER_USD;
  if (usd === 0) return "$0";
  if (usd >= 100) return `$${usd.toFixed(2)}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(6)}`;
}

function fmtSavingsPercent(saved: number, spent: number): string | null {
  const baseline = saved + spent;
  if (baseline <= 0) return null;
  return `${((saved / baseline) * 100).toFixed(0)}%`;
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtLatency(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 10_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function fmtTime(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(d));
}

function periodLabel(
  period: BudgetStatus["period"],
  t: Dictionary["dashboard"]
): string {
  return period === "daily" ? t.budgetPeriodToday : t.budgetPeriodThisMonth;
}

/**
 * Single recommendation card. Each rec kind has its own evidence sentence
 * and a CTA (a Link to the relevant page or anchor). Server-rendered —
 * no client JS needed.
 */
function RecommendationItem({
  rec,
  t,
}: {
  rec: Recommendation;
  t: Dictionary["dashboard"];
}): ReactNode {
  // Project-name fallback comes from the dictionary so an empty / null
  // project label localises along with the rest of the card.
  const projectName = rec.project_name ?? t.recProjectFallback;

  switch (rec.kind) {
    case "wasteful_pattern": {
      const saved = fmtSavingsUsd(rec.potential_saving_micro_cents);
      const body = t.recWastefulPattern
        .replace("{n}", String(rec.request_count))
        .replace("{fromModel}", rec.from_model)
        .replace("{project}", projectName)
        .replace("{saved}", saved)
        .replace("{toModel}", rec.to_model);
      return (
        <div className="recommendation">
          <div className="recommendation-icon">$</div>
          <div className="recommendation-body">
            <div className="recommendation-title">{body}</div>
          </div>
          <Link
            href={`/projects/${rec.project_id}#routing`}
            className="btn btn-sm btn-primary"
          >
            {t.recAddRoutingRule}
          </Link>
        </div>
      );
    }
    case "loop_spike": {
      const body = t.recLoopSpike
        .replace("{project}", projectName)
        .replace("{n}", String(rec.loop_count_24h));
      return (
        <div className="recommendation">
          <div className="recommendation-icon recommendation-icon-warn">⟲</div>
          <div className="recommendation-body">
            <div className="recommendation-title">{body}</div>
          </div>
          <Link
            href={`/projects/${rec.project_id}#alerts`}
            className="btn btn-sm btn-primary"
          >
            {t.recSetAlert}
          </Link>
        </div>
      );
    }
    case "undersized_budget": {
      const avg = `$${(rec.avg_daily_spend_micro_cents / MICRO_PER_USD).toFixed(2)}`;
      const limit = `$${(rec.current_daily_limit_micro_cents / MICRO_PER_USD).toFixed(2)}`;
      const body = t.recUndersizedBudget
        .replace("{project}", projectName)
        .replace("{avg}", avg)
        .replace("{limit}", limit);
      return (
        <div className="recommendation">
          <div className="recommendation-icon recommendation-icon-warn">↑</div>
          <div className="recommendation-body">
            <div className="recommendation-title">{body}</div>
          </div>
          <Link
            href={`/projects/${rec.project_id}#budgets`}
            className="btn btn-sm btn-primary"
          >
            {t.recEditBudget}
          </Link>
        </div>
      );
    }
    case "no_budget_yet": {
      const spend = `$${(rec.spend_7d_micro_cents / MICRO_PER_USD).toFixed(4)}`;
      const body = t.recNoBudget
        .replace("{project}", projectName)
        .replace("{spend}", spend);
      return (
        <div className="recommendation">
          <div className="recommendation-icon">!</div>
          <div className="recommendation-body">
            <div className="recommendation-title">{body}</div>
          </div>
          <Link
            href={`/projects/${rec.project_id}#budgets`}
            className="btn btn-sm btn-primary"
          >
            {t.recSetBudget}
          </Link>
        </div>
      );
    }
  }
}

type CollapsedLoopGroup = {
  kind: "collapsed";
  fingerprint: string;
  model: string;
  count: number;
  newest: RecentRequest;
  oldest: RecentRequest;
};

type RowGroup = { kind: "row"; row: RecentRequest } | CollapsedLoopGroup;

function collapseLoops(rows: RecentRequest[]): RowGroup[] {
  const out: RowGroup[] = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (r.status === "loop_detected" && r.fingerprint) {
      let j = i;
      while (
        j < rows.length &&
        rows[j].status === "loop_detected" &&
        rows[j].fingerprint === r.fingerprint
      ) {
        j++;
      }
      const count = j - i;
      if (count >= COLLAPSE_THRESHOLD) {
        out.push({
          kind: "collapsed",
          fingerprint: r.fingerprint,
          model: r.model,
          count,
          newest: rows[i],
          oldest: rows[j - 1],
        });
        i = j;
        continue;
      }
    }
    out.push({ kind: "row", row: r });
    i++;
  }
  return out;
}

function humanRoutingReason(
  r: RecentRequest,
  t: Dictionary["dashboard"]
): string {
  if (r.status === "loop_detected") return t.reasonLoopDetected;
  if (r.status === "budget_exceeded") return t.reasonBudgetExceeded;
  if (r.status === "plan_limit_exceeded") return t.reasonPlanLimitExceeded;
  if (!r.routing_reason || r.routing_reason === "none") {
    return r.original_model && r.original_model !== r.model
      ? t.reasonOlderRewriteUnknown
      : t.reasonNoRewrite;
  }
  if (r.routing_reason.startsWith("baseline:")) {
    // Bucket fragment is only included when the gateway actually classified
    // the request into a (task_type, complexity) bucket; otherwise we drop
    // the prefix entirely so the sentence still parses naturally.
    const bucket = r.routing_bucket
      ? `${t.reasonBaselineBucketPrefix}${r.routing_bucket.replace(":", " / ")}`
      : "";
    return t.reasonBaseline.replace("{bucket}", bucket);
  }
  if (r.routing_reason.startsWith("rule:")) return t.reasonRule;
  if (r.routing_reason.includes("fallback")) return t.reasonFallback;
  const skipMatch = /^(no_cheaper|no_callable_cheaper):([\w-]+):([\w-]+)$/.exec(
    r.routing_reason
  );
  if (skipMatch) {
    const [, kind, taskType, complexity] = skipMatch;
    const tpl =
      kind === "no_callable_cheaper" ? t.reasonNoCallableCheaper : t.reasonNoCheaper;
    return tpl
      .replace("{taskType}", taskType)
      .replace("{complexity}", complexity);
  }
  if (r.routing_reason === "unknown_caller_model") return t.reasonUnknownCallerModel;
  if (r.routing_reason === "no_artifact" || r.routing_reason === "disabled") {
    return t.reasonDisabled;
  }
  if (r.routing_reason === "no_model") return t.reasonNoModel;
  return r.routing_reason;
}

function qualityProofLabel(
  q: QualityProofSummary,
  /**
   * Where the "Add shadow rule" / "Review routing quality" CTA should land.
   * Computed at the top of the page from `userProjects[0]?.id` so the link
   * deep-links into the project's `#routing` section instead of bouncing the
   * user to the projects-list (which prominently surfaces "Create a project"
   * — confusing when they already have one).
   */
  shadowRuleHref: string,
  t: Dictionary["dashboard"]
): {
  label: string;
  tone: "success" | "warning" | "danger" | "muted";
  body: string;
  actionLabel: string;
  actionHref: string;
} {
  // Number formatting stays locale-neutral here; the dictionary templates
  // only need the placeholder substituted, not number-format-aware. Using
  // `en-US` keeps the comma-grouping consistent with the rest of the
  // dashboard (which formats numbers via `fmtNum`). A future CN-aware
  // number formatter can be wired in centrally instead of here.
  const fmtN = (n: number) => n.toLocaleString("en-US");
  if (q.trials_with_similarity > 0 && q.avg_similarity != null) {
    const pct =
      q.trials_with_similarity > 0
        ? Math.round((q.high_similarity_count / q.trials_with_similarity) * 100)
        : 0;
    if (q.avg_similarity < 0.7) {
      return {
        label: t.qualityDoNotRoute,
        tone: "danger",
        body: t.qualityBodyDangerSimilarity
          .replace("{n}", fmtN(q.trials_with_similarity))
          .replace("{sim}", q.avg_similarity.toFixed(3)),
        actionLabel: t.qualityActionReviewRouting,
        actionHref: "/routing-quality",
      };
    }
    return {
      label: q.avg_similarity >= 0.85 ? t.qualityChecked : t.qualityHttpSafe,
      tone: q.avg_similarity >= 0.85 ? "success" : "warning",
      body: t.qualityBodyOkSimilarity
        .replace("{n}", fmtN(q.trials_with_similarity))
        .replace("{sim}", q.avg_similarity.toFixed(3))
        .replace("{pct}", String(pct)),
      actionLabel:
        q.avg_similarity >= 0.85
          ? t.qualityActionReviewProof
          : t.qualityActionReviewBorderline,
      actionHref: "/routing-quality",
    };
  }
  if (q.total_trials > 0) {
    const successPct = Math.round((q.shadow_success / q.total_trials) * 100);
    if (successPct < 90) {
      return {
        label: t.qualityDoNotRoute,
        tone: "danger",
        body: t.qualityBodyDangerSuccess
          .replace("{n}", fmtN(q.total_trials))
          .replace("{pct}", String(successPct)),
        actionLabel: t.qualityActionReviewFailures,
        actionHref: "/routing-quality",
      };
    }
    return {
      label: t.qualityHttpSafe,
      tone: successPct >= 95 ? "success" : "warning",
      body: t.qualityBodyOkSuccess
        .replace("{n}", fmtN(q.total_trials))
        .replace("{pct}", String(successPct)),
      actionLabel: t.qualityActionEnableScoring,
      actionHref: "/settings",
    };
  }
  return {
    label: t.qualityBaselineOnly,
    tone: "muted",
    body: t.qualityBodyBaselineOnly,
    actionLabel: t.qualityActionAddShadow,
    actionHref: shadowRuleHref,
  };
}

function SavingsReceiptCard({
  request,
  qualityProof,
  shadowRuleHref,
  t,
}: {
  request: RecentRequest;
  qualityProof: QualityProofSummary;
  shadowRuleHref: string;
  t: Dictionary["dashboard"];
}) {
  const routed =
    request.original_model != null && request.original_model !== request.model;
  const saved =
    request.routing_saving_micro_cents + request.cache_savings_micro_cents;
  const landedOnCustom = request.provider.startsWith("custom:");
  const baselineCost = request.cost_micro_cents + saved;
  const savedPct =
    baselineCost > 0 ? Math.round((saved / baselineCost) * 100) : null;
  const quality = qualityProofLabel(qualityProof, shadowRuleHref, t);
  const qualityColor =
    quality.tone === "success"
      ? "var(--success)"
      : quality.tone === "warning"
        ? "var(--warning)"
        : quality.tone === "danger"
          ? "var(--danger)"
        : "var(--text-muted)";

  return (
    <section
      className="card card-accent savings-receipt-card"
      style={{
        marginBottom: 24,
        borderLeftWidth: 4,
        borderLeftStyle: "solid",
        borderLeftColor: saved > 0 ? "var(--success)" : "var(--accent)",
      }}
    >
      <div className="card-header">
        <h2>{t.receiptCardTitle}</h2>
        <div className="card-header-spacer" />
        <Link
          href={`/requests/${request.id}`}
          style={{ color: "var(--accent)", fontSize: 12 }}
        >
          {t.receiptOpenRequest}
        </Link>
      </div>

      <div
        className="savings-receipt-layout"
      >
        <div className="savings-receipt-main">
          <div
            className="savings-receipt-metrics"
          >
            <div>
              <div className="stat-label">{t.receiptAskedModel}</div>
              <div className="stat-value savings-receipt-model">
                <code className="code-inline break-code">
                  {request.original_model ?? request.model}
                </code>
              </div>
            </div>
            <div>
              <div className="stat-label">{t.receiptLandedModel}</div>
              <div className="stat-value savings-receipt-model">
                <code className="code-inline break-code">{request.model}</code>
              </div>
            </div>
            <div>
              <div className="stat-label">{t.receiptSavedOnThis}</div>
              <div
                className={`stat-value ${saved > 0 ? "stat-tone-success" : "stat-value-zero"}`}
                style={{ fontSize: 22 }}
              >
                {fmtSavingsUsd(saved)}
              </div>
              {savedPct != null && saved > 0 && (
                <div className="stat-value-sub">
                  {savedPct}
                  {t.receiptVsAskedSuffix}
                </div>
              )}
            </div>
            <div>
              <div className="stat-label">
                {landedOnCustom ? t.receiptTrackedApiCost : t.receiptActualCost}
              </div>
              <div className="stat-value" style={{ fontSize: 22 }}>
                {fmtSavingsUsd(request.cost_micro_cents)}
              </div>
              {landedOnCustom ? (
                <div className="stat-value-sub">{t.receiptCustomNote}</div>
              ) : baselineCost > request.cost_micro_cents && (
                <div className="stat-value-sub">
                  {t.receiptAskedWouldBe} {fmtSavingsUsd(baselineCost)}
                </div>
              )}
            </div>
          </div>

          <div
            style={{
              fontSize: 13,
              color: "var(--text-secondary)",
              lineHeight: 1.6,
            }}
          >
            <strong style={{ color: "var(--text)" }}>{t.receiptWhyHappened}</strong>{" "}
            {humanRoutingReason(request, t)}
            {landedOnCustom && (
              <>
                {" "}
                <strong style={{ color: "var(--text)" }}>
                  {t.receiptSelfHostNote}
                </strong>{" "}
                {t.receiptSelfHostBody}
              </>
            )}
          </div>

          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              fontSize: 12,
            }}
          >
            <span className={`status-${request.status}`}>{request.status}</span>
            {routed && (
              <span className="pill pill-accent">{t.receiptStatusRoutedDown}</span>
            )}
            {request.cache_savings_micro_cents > 0 && (
              <span className="pill pill-neutral">{t.receiptStatusCacheSaved}</span>
            )}
            {request.routing_bucket && (
              <span className="pill pill-neutral">{request.routing_bucket}</span>
            )}
          </div>
        </div>

        <div
          className="savings-receipt-quality"
        >
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {t.receiptQualityRisk}
          </div>
          <div style={{ fontSize: 18, fontWeight: 600, color: qualityColor }}>
            {quality.label}
          </div>
          <div
            style={{
              fontSize: 13,
              color: "var(--text-secondary)",
              lineHeight: 1.55,
            }}
          >
            {quality.body}
          </div>
          <Link
            href={quality.actionHref}
            style={{ color: "var(--accent)", fontSize: 12 }}
          >
            {quality.actionLabel} →
          </Link>
        </div>
      </div>
    </section>
  );
}

function SevenDayValueReportCard({
  breakdown,
  topRoutes,
  topLoops,
  qualityProof,
  shadowRuleHref,
  t,
}: {
  breakdown: SavingsBreakdown;
  topRoutes: TopRoutedPair[];
  topLoops: TopLoop[];
  qualityProof: QualityProofSummary;
  shadowRuleHref: string;
  t: Dictionary["dashboard"];
}) {
  const saved = breakdown.total_saving_micro_cents;
  const proFeeMicroCents = 29 * MICRO_PER_USD;
  const paybackRatio = proFeeMicroCents > 0 ? saved / proFeeMicroCents : 0;
  const quality = qualityProofLabel(qualityProof, shadowRuleHref, t);
  const bestRoute = topRoutes[0];
  const blocked =
    breakdown.loops_prevented_count + breakdown.budget_blocked_count;
  const nextAction =
    qualityProof.total_trials === 0
      ? {
          body: t.weekBodyAddShadow,
          href: shadowRuleHref,
          cta: t.weekActionAddShadow,
        }
      : saved < proFeeMicroCents
        ? {
            body: t.weekBodyMoreTraffic,
            href: shadowRuleHref,
            cta: t.weekActionMoreTraffic,
          }
        : {
            body: t.weekBodyUpgrade,
            href: "/billing",
            cta: t.weekActionUpgrade,
          };

  return (
    <section className="card" style={{ marginBottom: 24 }}>
      <div className="card-header">
        <h2>{t.weekTitle}</h2>
        <div className="card-header-spacer" />
        <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
          {t.weekUpgradeSignal}
        </span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 12,
          marginBottom: 14,
        }}
      >
        <div>
          <div className="stat-label">{t.weekSavedThisWeek}</div>
          <div
            className={`stat-value ${saved > 0 ? "stat-tone-success" : "stat-value-zero"}`}
          >
            {fmtSavingsUsd(saved)}
          </div>
          <div className="stat-value-sub">
            {paybackRatio >= 1
              ? t.weekProFeeRatio.replace("{ratio}", paybackRatio.toFixed(1))
              : t.weekProFeePct.replace(
                  "{pct}",
                  String(Math.round(paybackRatio * 100))
                )}
          </div>
        </div>
        <div>
          <div className="stat-label">{t.weekTopDowngrade}</div>
          <div className="stat-value" style={{ fontSize: 22 }}>
            {bestRoute ? (
              fmtSavingsUsd(bestRoute.saved_micro_cents)
            ) : (
              <span className="stat-value-zero">{t.weekNoneYet}</span>
            )}
          </div>
          {bestRoute && (
            <div className="stat-value-sub">
              {t.weekOverNRequests.replace(
                "{n}",
                fmtNum(bestRoute.request_count)
              )}
            </div>
          )}
        </div>
        <div>
          <div className="stat-label">{t.weekPrevented}</div>
          <div
            className={`stat-value ${blocked > 0 ? "stat-tone-warning" : "stat-value-zero"}`}
          >
            {fmtNum(blocked)}
          </div>
          <div className="stat-value-sub">
            {t.weekPreventedNote
              .replace("{loops}", fmtNum(breakdown.loops_prevented_count))
              .replace("{budget}", fmtNum(breakdown.budget_blocked_count))}
          </div>
        </div>
        <div>
          <div className="stat-label">{t.weekQualityProof}</div>
          <div
            className={`stat-value ${
              quality.tone === "success"
                ? "stat-tone-success"
                : quality.tone === "warning"
                  ? "stat-tone-warning"
                  : quality.tone === "danger"
                    ? "stat-tone-danger"
                  : "stat-value-zero"
            }`}
            style={{ fontSize: 18 }}
          >
            {quality.label}
          </div>
          <div className="stat-value-sub">
            {qualityProof.total_trials > 0
              ? t.weekShadowTrials.replace(
                  "{n}",
                  fmtNum(qualityProof.total_trials)
                )
              : t.weekNoShadowYet}
          </div>
        </div>
      </div>
      {bestRoute && (
        <div
          style={{
            marginBottom: 14,
            padding: "10px 12px",
            border: "1px solid var(--border)",
            borderRadius: 10,
            background: "var(--surface)",
            fontSize: 13,
            color: "var(--text-secondary)",
            lineHeight: 1.6,
          }}
        >
          <strong style={{ color: "var(--text)" }}>{t.weekTopDowngradeLabel}</strong>{" "}
          <code className="code-inline" style={{ overflowWrap: "anywhere" }}>
            {bestRoute.from_model}
          </code>{" "}
          <span style={{ color: "var(--text-muted)" }}>→</span>{" "}
          <code className="code-inline" style={{ overflowWrap: "anywhere" }}>
            {bestRoute.to_model}
          </code>
        </div>
      )}
      <div
        style={{
          padding: 12,
          border: "1px solid var(--border)",
          borderRadius: 10,
          background: "var(--surface)",
          fontSize: 13,
          color: "var(--text-secondary)",
          lineHeight: 1.55,
        }}
      >
        <strong style={{ color: "var(--text)" }}>{t.weekRecommendedNextStep}</strong>{" "}
        {nextAction.body}
        {topLoops.length > 0 && (
          <>
            {t.weekNoisiestPrefix}
            <code className="code-inline">{topLoops[0].fingerprint}</code>
            {t.weekNoisiestMid}
            <code className="code-inline">{topLoops[0].model}</code>
            {t.weekNoisiestSuffix}
          </>
        )}
        <div style={{ marginTop: 10 }}>
          <Link href={nextAction.href} className="btn btn-sm btn-primary">
            {nextAction.cta} →
          </Link>
        </div>
      </div>
    </section>
  );
}


export async function DashboardPage() {
  const session = isAuthEnabled() ? await getSession() : null;
  if (isAuthEnabled() && !session) {
    redirect("/login?next=/dashboard");
  }

  let totalSpendMicroCents = 0;
  let totalCalls = 0;
  let blockedCount = 0;
  let planLimitBlockedCount = 0;
  let loopCount = 0;
  let routedCount = 0;
  let cachedInputTokens = 0;
  let spendByModel: Awaited<ReturnType<typeof getSpendByModel>> = [];
  let recent: RecentRequest[] = [];
  let budgets: BudgetStatus[] = [];
  let topLoops: TopLoop[] = [];
  let daily: DailyStats[] = [];
  let anomaly: AnomalyVerdict | null = null;
  let cacheSavings = 0;
  let abExperiments: AbExperimentSummary[] = [];
  let qualityProof: QualityProofSummary = {
    total_trials: 0,
    shadow_success: 0,
    shadow_faster: 0,
    delta_micro_cents: 0,
    experiment_count: 0,
    trials_with_similarity: 0,
    avg_similarity: null,
    high_similarity_count: 0,
  };
  let spendByTag: SpendByTag[] = [];
  let savings: SavingsBreakdown = {
    total_saving_micro_cents: 0,
    routing_saving_micro_cents: 0,
    cache_saving_micro_cents: 0,
    total_spend_micro_cents: 0,
    routing_request_count: 0,
    cache_hit_count: 0,
    loops_prevented_count: 0,
    budget_blocked_count: 0,
  };
  // For the "no budget yet" CTA we need a list of projects the current user
  // can attach a budget to. Single-tenant mode has no `session.user.id` so
  // the CTA simply doesn't render — the user already sees all projects in
  // the budgets card and can navigate from there.
  let userProjects: Project[] = [];
  let userProviderKeys: UserProviderKeyRow[] = [];
  let recommendations: Recommendation[] = [];
  let savings7d: SavingsBreakdown = {
    total_saving_micro_cents: 0,
    routing_saving_micro_cents: 0,
    cache_saving_micro_cents: 0,
    total_spend_micro_cents: 0,
    routing_request_count: 0,
    cache_hit_count: 0,
    loops_prevented_count: 0,
    budget_blocked_count: 0,
  };
  let topRoutes7d: TopRoutedPair[] = [];
  let dbError: string | null = null;

  try {
    const scope = await getScope();
    [
      totalSpendMicroCents,
      spendByModel,
      recent,
      budgets,
      blockedCount,
      planLimitBlockedCount,
      loopCount,
      routedCount,
      cachedInputTokens,
      topLoops,
      daily,
      anomaly,
      cacheSavings,
      abExperiments,
      savings,
      savings7d,
      topRoutes7d,
    ] = await Promise.all([
      getTotalSpendMicroCents(7, scope),
      getSpendByModel(7, scope),
      getRecentRequests(50, scope),
      getBudgetStatus(scope),
      getBlockedCount(24, scope),
      getPlanLimitBlockedCount(24, scope),
      getLoopCount(24, scope),
      getRoutedCount(24, scope),
      getCachedInputTokens(24, scope),
      getTopLoops(24, 5, scope),
      getDailyStats(7, scope),
      detectSpendAnomaly(scope),
      getCacheSavingsMicroCents(24, scope),
      getAbExperimentSummary(168, scope),
      getSavingsBreakdown(24 * 30, scope), // 30d window for the headline number
      getSavingsBreakdown(168, scope),
      getTopRoutedPairs(168, 3, scope),
    ]);

    // The two queries below depend on schema additions (migrations 006 + 007).
    // Run them OUTSIDE the main Promise.all so a missing column (e.g. an
    // operator who hasn't applied migrations yet) gracefully degrades to
    // "card hidden" instead of taking down the whole dashboard. Reasonable
    // engineering hygiene any time we add a new column.
    qualityProof = await getQualityProofSummary(168, scope).catch((err) => {
      console.warn(
        "[dashboard] getQualityProofSummary failed (apply migration 007 to enable):",
        err instanceof Error ? err.message : err
      );
      return qualityProof;
    });
    spendByTag = await getSpendByTag(7, 30, scope).catch((err) => {
      console.warn(
        "[dashboard] getSpendByTag failed (apply migration 006 to enable):",
        err instanceof Error ? err.message : err
      );
      return [];
    });
    totalCalls = spendByModel.reduce((acc, r) => acc + r.call_count, 0);

    // Owned-project list for the zero-budget CTA. Only available in
    // multi-tenant mode where there's an authenticated user.
    if (session) {
      [userProjects, userProviderKeys] = await Promise.all([
        listProjectsForUser(session.user.id),
        listProviderKeysForUser(session.user.id),
      ]);
    }

    // Recommendations engine — fast (<10ms) so we run it inline. Yields 0
    // results on empty databases, which the UI treats as "no card shown."
    recommendations = await getRecommendations(scope);
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  // Resolve the dictionary once per render so every section below shares
  // the same locale snapshot. The deep analytics cards (recommendations
  // body text, anomaly explanations, A/B experiment commentary) are
  // intentionally still English — they're operator-grade copy with
  // dozens of conditional branches and translating them risks drifting
  // out of sync with the policy/recommendation logic.
  const { locale, t } = await getDictionary();
  const tDash = t.dashboard;

  // Timestamp captured on the server the moment this render started. Used by
  // the client-side <AutoRefresh> to show a hydration-safe "updated Xs ago"
  // label. Kept here (not inside the JSX) so a single value is shared across
  // every refresh-indicator on the page.
  const renderedAt = Date.now();

  // Derived: weekday labels for the daily bar chart (Mon / Tue / ... in
  // English, 周一 / 周二 / ... in Chinese). The locale is sourced from the
  // request cookie so the chart matches the rest of the rendered page.
  const weekdayFmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
  const dailyBars: DailyBar[] = daily.map((d) => {
    const date = new Date(`${d.day}T00:00:00Z`);
    const callWord =
      d.call_count === 1 ? tDash.dailyCallSingular : tDash.dailyCallPlural;
    return {
      key: d.day,
      label: weekdayFmt.format(date),
      value: d.cost_micro_cents,
      tooltip: `${d.day} · ${(d.cost_micro_cents / MICRO_PER_USD).toFixed(
        4
      )} USD · ${d.call_count} ${callWord}`,
    };
  });
  const dailySparkValues = daily.map((d) => d.cost_micro_cents);
  const peakDay = daily.reduce<DailyStats | null>((best, d) => {
    if (!best || d.cost_micro_cents > best.cost_micro_cents) return d;
    return best;
  }, null);

  // Tier 3c: budget reference line for the 7d chart.
  // Sum all enabled DAILY budgets in the user's scope — represents the
  // total daily allowance the user has granted across their projects.
  // Null when no daily budget is set; chart renders without overlay.
  const dailyBudgetSumMicroCents = budgets
    .filter((b) => b.period === "daily" && b.enabled)
    .reduce((acc, b) => acc + b.limit_micro_cents, 0);
  const dailyBudgetReference =
    dailyBudgetSumMicroCents > 0
      ? {
          value: dailyBudgetSumMicroCents,
          label: `${tDash.dailyBudgetCapPrefix}${(dailyBudgetSumMicroCents / MICRO_PER_USD).toFixed(2)}`,
        }
      : undefined;
  const receiptRequest =
    recent.find(
      (r) =>
        r.routing_saving_micro_cents > 0 ||
        r.cache_savings_micro_cents > 0 ||
        (r.original_model != null && r.original_model !== r.model)
    ) ?? recent[0];
  const firstSetupProject = userProjects[0] ?? null;
  const firstSetupHref = firstSetupProject
    ? `/projects/${firstSetupProject.id}`
    : "/projects";
  // Deep-link the "Add shadow rule" CTA into the first project's routing
  // section. Without this, every "Add shadow rule" button on the dashboard
  // landed on `/projects`, which prominently surfaces "Create a project" —
  // confusing for a user who already has one and just wants to open the
  // routing-rule form.
  const shadowRuleHref = firstSetupProject
    ? `/projects/${firstSetupProject.id}#routing`
    : "/projects";
  const firstSetupCta =
    userProviderKeys.length === 0
      ? {
          href: "/settings#provider-keys",
          label: tDash.firstSetupAddProviderLabel,
          body: tDash.firstSetupAddProviderBody,
        }
      : userProjects.length === 0
        ? {
            href: "/projects",
            label: tDash.firstSetupCreateProjectLabel,
            body: tDash.firstSetupCreateProjectBody,
          }
        : {
            href: firstSetupHref,
            label: tDash.firstSetupOpenProjectLabel,
            body: tDash.firstSetupOpenProjectBody,
          };

  return (
    <main>
      <header className="brand-hero">
        <div className="brand-hero-copy">
          <div className="brand-hero-eyebrow">{tDash.heroEyebrow}</div>
          <h1 className="brand-hero-title">{tDash.heroTitle}</h1>
          <p className="brand-hero-subtitle">{tDash.heroSubtitle}</p>
        </div>
        <div className="brand-hero-steps" aria-label={tDash.heroPillsAriaLabel}>
          <span>{tDash.heroPillSee}</span>
          <span>{tDash.heroPillCap}</span>
          <span>{tDash.heroPillShrink}</span>
          <span className="brand-hero-result">
            <em aria-hidden="true">→</em>
            {tDash.heroPillKeep}
          </span>
        </div>
      </header>

      {/* Plan-tier-block banner. Distinct from project-budget blocks
          (which are user-controlled and surface elsewhere). When the
          gateway returns 402 plan_limit_exceeded, the agent calling
          this account is being throttled by the hosted-tier ceiling
          and the only fix is upgrade — so the banner has to lead
          straight at /billing. Multi-tenant only (no /billing in
          single-tenant mode). */}
      {planLimitBlockedCount > 0 && isAuthEnabled() && (
        <div
          className="card"
          style={{
            background: "var(--warning-weak, var(--surface))",
            borderColor: "var(--warning)",
            borderLeftWidth: 4,
            borderLeftStyle: "solid",
            marginBottom: 16,
            display: "flex",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: "1 1 320px", minWidth: 240 }}>
            <div
              style={{
                fontWeight: 600,
                fontSize: 14,
                color: "var(--warning)",
                marginBottom: 2,
              }}
            >
              {tDash.planCapTitlePrefix}
              {fmtNum(planLimitBlockedCount)}
              {tDash.planCapTitleSuffix}
            </div>
            <div
              style={{
                fontSize: 12.5,
                color: "var(--text-secondary)",
                lineHeight: 1.5,
              }}
            >
              {tDash.planCapBody}
            </div>
          </div>
          <Link
            href="/billing"
            className="btn btn-primary"
            style={{ flexShrink: 0 }}
          >
            {tDash.planCapCta}
          </Link>
        </div>
      )}

      {dbError && (() => {
        // Discriminate between three failure modes for a useful message:
        //   1. "column ... does not exist" → a migration wasn't applied.
        //      Tell the user exactly which command to run.
        //   2. "relation ... does not exist" → table missing (init never ran).
        //      Tell them to bring postgres up and re-init.
        //   3. anything else → generic "database not reachable" fallback.
        const colMatch = /column "?([\w.]+)"? does not exist/i.exec(dbError);
        const tblMatch = /relation "?(\w+)"? does not exist/i.exec(dbError);
        if (colMatch) {
          return (
            <div className="card card-danger">
              <strong>{tDash.dbErrColumnTitle}</strong>
              {tDash.dbErrColumnBody}
              <pre
                className="code-block"
                style={{ marginTop: 8, fontSize: 11 }}
              >
                {`for f in migrations/*.sql; do
  docker exec -i tokensmart-postgres psql -U tokensmart -d tokensmart < "$f"
done`}
              </pre>
              <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                {tDash.dbErrColumnMissing}{" "}
                <code className="code-inline">{colMatch[1]}</code>
                {tDash.dbErrColumnHint}
              </span>
            </div>
          );
        }
        if (tblMatch) {
          return (
            <div className="card card-danger">
              <strong>{tDash.dbErrTableTitle}</strong>
              {tDash.dbErrTableBodyPrefix}
              <code className="code-inline">docker compose down -v && docker compose up -d</code>
              {tDash.dbErrTableBodyMid}
              <code className="code-inline">migrations/001_init.sql</code>
              {tDash.dbErrTableBodySuffix}
              <br />
              <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                {tDash.dbErrTableMissing}{" "}
                <code className="code-inline">{tblMatch[1]}</code>
              </span>
            </div>
          );
        }
        return (
          <div className="card card-danger">
            <strong>{tDash.dbErrUnreachableTitle}</strong>
            {tDash.dbErrUnreachableBody}
            <br />
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
              {dbError}
            </span>
          </div>
        );
      })()}

      {!dbError && anomaly?.flagged && (
        <div className="card card-warning">
          <h3 style={{ color: "var(--warning)" }}>{tDash.spikeTitle}</h3>
          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            {anomaly.reason}{" "}
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
              (z={anomaly.zScore.toFixed(1)} over {anomaly.sampleCount}
              {tDash.spikeBaselineSuffix})
            </span>
          </div>
        </div>
      )}

      {/* First-run onboarding card — shown only on completely empty
          accounts (no requests ever landed). Gives the user a single
          concrete copy-paste that produces a tangible result, so they
          don't stare at a wall of zero-filled cards wondering what to
          do. Disappears the moment the first request lands.
          Hosted vs self-host paths differ in ONE axis: where the
          upstream provider credential comes from (Settings → BYO key
          on hosted, gateway env var on self-host). Everything else
          (mint a TokSuan key, send the curl) is identical. */}
      {!dbError && recent.length === 0 && (() => {
        const hosted = isHostedMode();
        return (
          <section
            className="card card-accent"
            style={{
              marginBottom: 24,
              borderLeftWidth: 4,
              borderLeftStyle: "solid",
              borderLeftColor: "var(--accent)",
            }}
          >
            <div className="card-header">
              <h2>{tDash.sectionFirstRequest}</h2>
              <div className="card-header-spacer" />
              <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
                {tDash.firstReqHeaderHint}
              </span>
            </div>
            <div
              style={{
                fontSize: 13,
                color: "var(--text-secondary)",
                lineHeight: 1.6,
                marginBottom: 12,
              }}
            >
              {tDash.firstReqIntro}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: 10,
                marginBottom: 12,
              }}
            >
              {[
                {
                  label: hosted
                    ? tDash.firstReqStepProviderKey
                    : tDash.firstReqStepProviderEnv,
                  done: hosted ? userProviderKeys.length > 0 : true,
                  href: hosted ? "/settings#provider-keys" : null,
                  action: hosted ? tDash.firstReqActionManage : null,
                },
                {
                  label: tDash.firstReqStepCreateProject,
                  done: userProjects.length > 0,
                  href: "/projects",
                  action:
                    userProjects.length > 0
                      ? tDash.firstReqActionManage
                      : tDash.firstReqActionOpen,
                },
                {
                  label: tDash.firstReqStepCreateApiKey,
                  done: false,
                  href: firstSetupHref,
                  action: tDash.firstReqActionOpenProject,
                },
                {
                  label: tDash.firstReqStepCopyCurl,
                  done: false,
                  href: firstSetupHref,
                  action: tDash.firstReqActionOpenSetup,
                },
                {
                  label: tDash.firstReqStepReadReceipt,
                  done: false,
                  href: null,
                  action: null,
                },
              ].map((step, i) => (
                <div
                  key={step.label}
                  style={{
                    padding: 10,
                    border: `1px solid ${step.done ? "var(--success)" : "var(--border)"}`,
                    borderRadius: 8,
                    background: "var(--surface)",
                    fontSize: 12,
                    color: "var(--text-secondary)",
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                  }}
                >
                  <span
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: "50%",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "var(--accent-weak)",
                      color: "var(--accent)",
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      flexShrink: 0,
                    }}
                  >
                    {step.done ? "✓" : i + 1}
                  </span>
                  <span>
                    {step.label}
                    {step.href && step.action && (
                      <>
                        {" · "}
                        <Link href={step.href} style={{ color: "var(--accent)" }}>
                          {step.action}
                        </Link>
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>
            <div
              style={{
                padding: 12,
                border: "1px solid var(--border)",
                borderRadius: 10,
                background: "var(--surface)",
                marginBottom: 12,
                fontSize: 13,
                color: "var(--text-secondary)",
                lineHeight: 1.55,
              }}
            >
              <strong style={{ color: "var(--text)" }}>{tDash.firstReqNextStep}</strong>{" "}
              {firstSetupCta.body}
              <div style={{ marginTop: 10 }}>
                <Link href={firstSetupCta.href} className="btn btn-sm btn-primary">
                  {firstSetupCta.label} →
                </Link>
              </div>
            </div>
            <div
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                marginTop: 10,
                lineHeight: 1.55,
              }}
            >
              {tDash.firstReqFooter}
            </div>
          </section>
        );
      })()}

      {!dbError && (
        <>
          {/* Savings hero — the headline number a hosted customer should
              see first every time they log in. Routing + cache savings only;
              loop-prevented and budget-blocked are counterfactual so we
              surface them as counts, not dollars. */}
          {(() => {
            const hasSavings = savings.total_saving_micro_cents > 0;
            const pct = fmtSavingsPercent(
              savings.total_saving_micro_cents,
              savings.total_spend_micro_cents
            );
            return (
              <section className="savings-hero">
                <div>
                  <div className="savings-hero-label">
                    <span>{tDash.savingsHeroLabel}</span>
                    <AutoRefresh renderedAt={renderedAt} t={t.common.autoRefresh} />
                  </div>
                  <div
                    className={`savings-hero-value ${hasSavings ? "" : "savings-hero-value-zero"}`}
                  >
                    {fmtSavingsUsd(savings.total_saving_micro_cents)}
                  </div>
                  <div className="savings-hero-sub">
                    {hasSavings ? (
                      <>
                        {(() => {
                          // Splice the bold percentage into the localised
                          // sub-sentence template so the visual emphasis
                          // (the `<strong>` tag) survives translation.
                          const parts = tDash.savingsHeroSubWithPct.split("{pct}");
                          return (
                            <>
                              {parts[0]}
                              {pct && <strong>{pct}</strong>}
                              {parts[1] ?? ""}
                            </>
                          );
                        })()}
                      </>
                    ) : (
                      tDash.savingsHeroSubEmpty
                    )}
                  </div>
                </div>

                {hasSavings && (
                  <div className="savings-hero-breakdown">
                    <div className="savings-hero-breakdown-item">
                      <div className="savings-hero-breakdown-label">
                        {tDash.savingsHeroBreakdownRouting}
                      </div>
                      <div className="savings-hero-breakdown-value">
                        {fmtSavingsUsd(savings.routing_saving_micro_cents)}
                      </div>
                      <div className="savings-hero-breakdown-note">
                        {tDash.savingsHeroRoutingNote.replace(
                          "{n}",
                          fmtNum(savings.routing_request_count)
                        )}
                      </div>
                    </div>
                    <div className="savings-hero-breakdown-item">
                      <div className="savings-hero-breakdown-label">
                        {tDash.savingsHeroBreakdownCache}
                      </div>
                      <div className="savings-hero-breakdown-value">
                        {fmtSavingsUsd(savings.cache_saving_micro_cents)}
                      </div>
                      <div className="savings-hero-breakdown-note">
                        {tDash.savingsHeroCacheNote.replace(
                          "{n}",
                          fmtNum(savings.cache_hit_count)
                        )}
                      </div>
                    </div>
                    {(savings.loops_prevented_count > 0 ||
                      savings.budget_blocked_count > 0) && (
                      <div className="savings-hero-breakdown-item">
                        <div className="savings-hero-breakdown-label">
                          {tDash.savingsHeroBreakdownPrevented}
                        </div>
                        <div className="savings-hero-breakdown-value">
                          {fmtNum(
                            savings.loops_prevented_count +
                              savings.budget_blocked_count
                          )}
                        </div>
                        <div className="savings-hero-breakdown-note">
                          {tDash.savingsHeroPreventedNote
                            .replace(
                              "{loops}",
                              fmtNum(savings.loops_prevented_count)
                            )
                            .replace(
                              "{budget}",
                              fmtNum(savings.budget_blocked_count)
                            )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </section>
            );
          })()}

          {receiptRequest && (
            <SavingsReceiptCard
              request={receiptRequest}
              qualityProof={qualityProof}
              shadowRuleHref={shadowRuleHref}
              t={tDash}
            />
          )}

          {(savings7d.total_spend_micro_cents > 0 ||
            savings7d.total_saving_micro_cents > 0) && (
            <SevenDayValueReportCard
              breakdown={savings7d}
              topRoutes={topRoutes7d}
              topLoops={topLoops}
              qualityProof={qualityProof}
              shadowRuleHref={shadowRuleHref}
              t={tDash}
            />
          )}

          {/* Tier 2: zero-budget CTA — only when the user owns projects
              but has zero budgets. Single-tenant mode skips it entirely. */}
          {budgets.length === 0 && userProjects.length > 0 && (
            <QuickBudgetCTA
              projects={userProjects.map((p) => ({ id: p.id, name: p.name }))}
              t={t.forms.quickBudget}
            />
          )}

          {/* B2: Recommendations — proactive insight cards derived from real
              traffic data. Each rec has an evidence sentence and a one-click
              action target. Card is hidden entirely when there's nothing to
              say (empty DB / single quiet user). */}
          {recommendations.length > 0 && (
            <div className="recommendations-card">
            <div className="recommendations-header">
                <h2>{tDash.recommendationsTitle}</h2>
                <span className="recommendations-count">
                  {recommendations.length}
                </span>
              </div>
              <div className="recommendations-list">
                {recommendations.map((r, i) => (
                  <RecommendationItem key={`${r.kind}-${i}`} rec={r} t={tDash} />
                ))}
              </div>
            </div>
          )}

          {/* Hero stats */}
          <div className="stat-grid">
            <div className="stat stat-featured">
              <div>
                <div className="stat-label">{tDash.statGridSpend7d}</div>
                <div className="stat-value">
                  {fmtMicroAsUsd(totalSpendMicroCents)}
                </div>
              </div>
              {dailySparkValues.some((v) => v > 0) && (
                <div className="spark-wrap">
                  <Sparkline values={dailySparkValues} width={140} height={30} />
                </div>
              )}
            </div>
            <div className="stat">
              <div className="stat-label">{tDash.statGridCalls7d}</div>
              <div
                className={`stat-value ${totalCalls === 0 ? "stat-value-zero" : ""}`}
              >
                {fmtNum(totalCalls)}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">{tDash.statGridBlocked24h}</div>
              <div
                className={`stat-value ${
                  blockedCount > 0 ? "stat-tone-warning" : "stat-value-zero"
                }`}
              >
                {fmtNum(blockedCount)}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">{tDash.statGridLoops24h}</div>
              <div
                className={`stat-value ${
                  loopCount > 0 ? "stat-tone-purple" : "stat-value-zero"
                }`}
              >
                {fmtNum(loopCount)}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">{tDash.statGridRouted24h}</div>
              <div
                className={`stat-value ${
                  routedCount > 0 ? "stat-tone-accent" : "stat-value-zero"
                }`}
              >
                {fmtNum(routedCount)}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">{tDash.statGridCached24h}</div>
              <div
                className={`stat-value ${
                  cachedInputTokens > 0 ? "stat-tone-success" : "stat-value-zero"
                }`}
              >
                {fmtNum(cachedInputTokens)}
              </div>
              {cacheSavings > 0 && (
                <div className="stat-value-sub">
                  {tDash.statGridCachedSavedPrefix}
                  {fmtMicroAsUsd(cacheSavings)}
                </div>
              )}
            </div>
          </div>

          {/* Spend over time */}
          <div className="card">
            <div className="card-header">
              <h2>{tDash.sectionDailySpend}</h2>
              <div className="card-header-spacer" />
              {peakDay && peakDay.cost_micro_cents > 0 && (
                <span
                  style={{
                    color: "var(--text-muted)",
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {tDash.dailyPeakPrefix}
                  {fmtMicroAsUsd(peakDay.cost_micro_cents)} · {peakDay.day}
                </span>
              )}
            </div>
            <DailyBars
              data={dailyBars}
              tone="accent"
              height={160}
              referenceLine={dailyBudgetReference}
            />
          </div>

          {/* Budgets */}
          <div className="card">
            <div className="card-header">
              <h2>{tDash.sectionBudgets}</h2>
              <div className="card-header-spacer" />
              <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                {budgets.length}
                {tDash.budgetActiveSuffix}
              </span>
            </div>
            {budgets.length === 0 ? (
              <div className="empty">
                {tDash.budgetEmptyPrefix}
                <code className="code-inline">{tDash.budgetEmptyCommand}</code>
              </div>
            ) : (
              <div style={{ display: "grid", gap: 18 }}>
                {budgets.map((b) => {
                  const pct =
                    b.limit_micro_cents > 0
                      ? Math.min(
                          100,
                          Math.round(
                            (b.spend_micro_cents / b.limit_micro_cents) * 100
                          )
                        )
                      : 0;
                  const exceeded =
                    b.limit_micro_cents > 0 &&
                    b.spend_micro_cents >= b.limit_micro_cents;
                  const color = exceeded
                    ? "var(--danger)"
                    : pct >= 80
                    ? "var(--warning)"
                    : "var(--success)";
                  return (
                    <div
                      key={`${b.project_id}-${b.period}`}
                      style={{ display: "grid", gap: 8 }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          fontSize: 13,
                        }}
                      >
                        <strong>{b.project_name}</strong>
                        <span style={{ color: "var(--text-muted)" }}>·</span>
                        <span style={{ color: "var(--text-secondary)" }}>
                          {periodLabel(b.period, tDash)}
                        </span>
                        <div style={{ flex: 1 }} />
                        <span
                          style={{
                            fontVariantNumeric: "tabular-nums",
                            fontFamily: "var(--font-mono)",
                            fontSize: 12,
                            color: exceeded
                              ? "var(--danger)"
                              : "var(--text)",
                          }}
                        >
                          {fmtMicroAsUsd(b.spend_micro_cents)} /{" "}
                          {fmtMicroAsUsd(b.limit_micro_cents)}
                        </span>
                        <span
                          style={{
                            color: "var(--text-muted)",
                            fontSize: 12,
                            fontVariantNumeric: "tabular-nums",
                            minWidth: 38,
                            textAlign: "right",
                          }}
                        >
                          {pct}%
                        </span>
                      </div>
                      <div className="progress">
                        <div
                          className="progress-fill"
                          style={{ width: `${pct}%`, background: color }}
                        />
                      </div>
                      {exceeded && (
                        <div
                          style={{
                            fontSize: 12,
                            color: "var(--warning)",
                            marginTop: 2,
                          }}
                        >
                          {tDash.budgetOverLimitPrefix}
                          <code className="code-inline">
                            {tDash.budgetOverLimitHttpCode}
                          </code>
                          {tDash.budgetOverLimitSuffix}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Top repeating patterns */}
          <div className="card">
            <div className="card-header">
              <h2>{tDash.sectionTopLoops}</h2>
            </div>
            {topLoops.length === 0 ? (
              <div className="empty">{tDash.emptyLoops}</div>
            ) : (() => {
              const maxAttempts = Math.max(
                ...topLoops.map((l) => l.total_attempts),
                1
              );
              const renderLoopTable = (rows: TopLoop[]) => (
                <div style={{ overflowX: "auto" }}>
                  <table
                    className="data-table"
                    style={{ minWidth: 720, width: "100%" }}
                  >
                    <thead>
                      <tr>
                        <th>{tDash.loopColFingerprint}</th>
                        <th>{tDash.loopColModel}</th>
                        <th className="numeric">{tDash.loopColAttempts}</th>
                        <th>{tDash.loopColShare}</th>
                        <th className="numeric">{tDash.loopColBlocked}</th>
                        <th>{tDash.loopColLastSeen}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((l) => (
                        <tr key={l.fingerprint}>
                          <td style={{ whiteSpace: "nowrap" }}>
                            <code className="code-inline">{l.fingerprint}</code>
                          </td>
                          <td style={{ whiteSpace: "nowrap" }}>{l.model}</td>
                          <td className="numeric">{fmtNum(l.total_attempts)}</td>
                          <td>
                            <ShareBar
                              value={l.total_attempts}
                              max={maxAttempts}
                              tone={l.blocked_attempts > 0 ? "purple" : "accent"}
                              width={120}
                            />
                          </td>
                          <td
                            className="numeric"
                            style={{
                              color:
                                l.blocked_attempts > 0
                                  ? "var(--purple)"
                                  : "var(--text-muted)",
                            }}
                          >
                            {fmtNum(l.blocked_attempts)}
                          </td>
                          <td className="muted" style={{ whiteSpace: "nowrap" }}>
                            {fmtTime(new Date(l.last_seen_at))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
              const top = topLoops[0];
              const rest = topLoops.slice(1);
              return (
                <>
                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      alignItems: "center",
                      flexWrap: "wrap",
                      fontSize: 13,
                      color: "var(--text-secondary)",
                      marginBottom: rest.length > 0 ? 10 : 0,
                    }}
                  >
                    <strong style={{ color: "var(--text)" }}>{tDash.topPattern}</strong>
                    <code className="code-inline">{top.fingerprint}</code>
                    <span>
                      {fmtNum(top.total_attempts)} {tDash.attempts}
                    </span>
                    <span style={{ color: "var(--text-muted)" }}>·</span>
                    <code className="code-inline">{top.model}</code>
                  </div>
                  {rest.length > 0 && (
                    <details className="inline-details">
                      <summary>
                        {tDash.loopShowMore
                          .replace("{n}", String(rest.length))
                          .replace("{s}", rest.length === 1 ? "" : "s")}
                      </summary>
                      {renderLoopTable(rest)}
                    </details>
                  )}
                </>
              );
            })()}
          </div>

          {/* Spend by model */}
          <div className="card">
            <div className="card-header">
              <h2>{tDash.sectionSpendByModel}</h2>
            </div>
            {spendByModel.length === 0 ? (
              <div className="empty">{tDash.emptySpendByModel}</div>
            ) : (() => {
              const maxSpend = Math.max(
                ...spendByModel.map((r) => r.total_cost_micro_cents),
                1
              );
              const renderModelTable = (
                rows: Awaited<ReturnType<typeof getSpendByModel>>
              ) => (
                <div style={{ overflowX: "auto" }}>
                  <table
                    className="data-table"
                    style={{ minWidth: 520, width: "100%" }}
                  >
                    <thead>
                      <tr>
                        <th>{tDash.modelColModel}</th>
                        <th className="numeric">{tDash.modelColCalls}</th>
                        <th className="numeric">{tDash.modelColSpend}</th>
                        <th>{tDash.modelColShare}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.model}>
                          <td style={{ whiteSpace: "nowrap" }}>{r.model}</td>
                          <td className="numeric">{fmtNum(r.call_count)}</td>
                          <td className="numeric">
                            {fmtMicroAsUsd(r.total_cost_micro_cents)}
                          </td>
                          <td>
                            <ShareBar
                              value={r.total_cost_micro_cents}
                              max={maxSpend}
                              tone="accent"
                              width={160}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
              const preview = spendByModel.slice(0, 3);
              const rest = spendByModel.slice(3);
              return (
                <>
                  {renderModelTable(preview)}
                  {rest.length > 0 && (
                    <details className="inline-details">
                      <summary>
                        {tDash.modelShowMore
                          .replace("{n}", String(rest.length))
                          .replace("{s}", rest.length === 1 ? "" : "s")}
                      </summary>
                      {renderModelTable(rest)}
                    </details>
                  )}
                </>
              );
            })()}
          </div>

          {/* A/B experiments */}
          {abExperiments.length > 0 && (
            <div className="card">
              <div className="card-header">
                <h2>{tDash.abTitle}</h2>
                <div className="card-header-spacer" />
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                  {tDash.abSubtitle}
                </span>
              </div>
              {/* 8 columns including two model names — wide enough that
                  it always overflows on tablet-class viewports. Wrap +
                  minWidth for clean horizontal scroll. */}
              <div style={{ overflowX: "auto" }}>
              <table
                className="data-table"
                style={{ minWidth: 980, width: "100%" }}
              >
                <thead>
                  <tr>
                    <th>{tDash.abColPrimary}</th>
                    <th>{tDash.abColShadow}</th>
                    <th className="numeric">{tDash.abColTrials}</th>
                    <th className="numeric">{tDash.abColPrimaryCost}</th>
                    <th className="numeric">{tDash.abColShadowCost}</th>
                    <th className="numeric">{tDash.abColDelta}</th>
                    <th className="numeric">{tDash.abColLatency}</th>
                    <th className="numeric">{tDash.abColErrors}</th>
                  </tr>
                </thead>
                <tbody>
                  {abExperiments.map((e) => {
                    const saved = e.delta_micro_cents > 0;
                    return (
                      <tr key={`${e.primary_model}::${e.shadow_model}`}>
                        <td>
                          <code className="code-inline">{e.primary_model}</code>
                        </td>
                        <td>
                          <code className="code-inline">{e.shadow_model}</code>
                        </td>
                        <td className="numeric">{fmtNum(e.trials)}</td>
                        <td className="numeric">
                          {fmtMicroAsUsd(e.primary_total_micro_cents)}
                        </td>
                        <td className="numeric">
                          {fmtMicroAsUsd(e.shadow_total_micro_cents)}
                        </td>
                        <td
                          className="numeric"
                          style={{
                            color: saved
                              ? "var(--success)"
                              : e.delta_micro_cents < 0
                                ? "var(--warning)"
                                : "var(--text-muted)",
                          }}
                        >
                          {saved ? "+" : ""}
                          {fmtMicroAsUsd(e.delta_micro_cents)}
                        </td>
                        <td className="numeric muted">
                          {e.primary_avg_latency_ms ?? "—"}ms →{" "}
                          {e.shadow_avg_latency_ms ?? "—"}ms
                        </td>
                        <td
                          className="numeric"
                          style={{
                            color:
                              e.shadow_errors > 0
                                ? "var(--danger)"
                                : "var(--text-muted)",
                          }}
                        >
                          {e.shadow_errors}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </div>
          )}

          {/* Quality proof — answers "is the cheaper model actually working?"
              by aggregating shadow A/B results into a single trust signal.
              When zero trials, show an educational empty state nudging the
              user to set up a shadow rule (chicken-and-egg fix added
              2026-04-23 — without this, users never discover the feature). */}
          {qualityProof.total_trials === 0 && (
            <div className="card">
              <div className="card-header">
                <h2>{tDash.qpTitle}</h2>
                <div className="card-header-spacer" />
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                  {tDash.qpEmptyHeader}
                </span>
              </div>
              <p
                style={{
                  fontSize: 13,
                  color: "var(--text-secondary)",
                  lineHeight: 1.55,
                  margin: "0 0 12px 0",
                }}
              >
                {tDash.qpEmptyBody}
              </p>
              <ul
                style={{
                  fontSize: 13,
                  color: "var(--text-secondary)",
                  lineHeight: 1.6,
                  margin: "0 0 14px 18px",
                  padding: 0,
                }}
              >
                <li>
                  <strong>{tDash.qpEmptyBullet1Title}</strong>
                  {" — "}
                  {tDash.qpEmptyBullet1}
                </li>
                <li>
                  <strong>{tDash.qpEmptyBullet2Title}</strong>
                  {" — "}
                  {tDash.qpEmptyBullet2}
                </li>
                <li>
                  <strong>{tDash.qpEmptyBullet3Title}</strong>
                  {" — "}
                  {tDash.qpEmptyBullet3}
                </li>
                <li>
                  <strong>{tDash.qpEmptyBullet4Title}</strong>
                  {" — "}
                  {tDash.qpEmptyBullet4Prefix}
                  <code className="code-inline">
                    TOKENSMART_QUALITY_EMBED_MODEL
                  </code>
                  {tDash.qpEmptyBullet4Suffix}
                </li>
              </ul>
              <div
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                {userProjects.length > 0 ? (
                  <Link
                    href={`/projects/${userProjects[0].id}#routing`}
                    className="btn btn-sm btn-primary"
                  >
                    {tDash.qpEmptyAddShadow}
                  </Link>
                ) : (
                  <Link href="/projects" className="btn btn-sm btn-primary">
                    {tDash.qpEmptyCreateProject}
                  </Link>
                )}
                <span
                  style={{ fontSize: 11, color: "var(--text-muted)" }}
                >
                  {tDash.qpEmptyHintPrefix}
                  <strong>{tDash.qpEmptyHintMode1}</strong>
                  {tDash.qpEmptyHintConn}
                  <strong>{tDash.qpEmptyHintMode2}</strong>
                </span>
              </div>
            </div>
          )}
          {qualityProof.total_trials > 0 && (
            <div className="card">
              <div className="card-header">
                <h2>{tDash.qpTitle}</h2>
                <div className="card-header-spacer" />
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                  {tDash.qpHeaderCounts
                    .replace("{e}", fmtNum(qualityProof.experiment_count))
                    .replace("{t}", fmtNum(qualityProof.total_trials))}
                </span>
              </div>
              {(() => {
                const successPct =
                  qualityProof.total_trials > 0
                    ? Math.round(
                        (qualityProof.shadow_success /
                          qualityProof.total_trials) *
                          100
                      )
                    : 0;
                const fasterPct =
                  qualityProof.total_trials > 0
                    ? Math.round(
                        (qualityProof.shadow_faster /
                          qualityProof.total_trials) *
                          100
                      )
                    : 0;
                const successTone =
                  successPct >= 95
                    ? "var(--success)"
                    : successPct >= 80
                      ? "var(--warning)"
                      : "var(--danger)";
                const cheaperUsd = qualityProof.delta_micro_cents / MICRO_PER_USD;
                return (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(180px, 1fr))",
                      gap: 14,
                    }}
                  >
                    <div className="stat">
                      <div className="stat-label">{tDash.qpStatSuccess}</div>
                      <div
                        className="stat-value"
                        style={{ color: successTone }}
                      >
                        {successPct}%
                      </div>
                      <div
                        style={{ color: "var(--text-muted)", fontSize: 12 }}
                      >
                        {tDash.qpStatSuccessNote
                          .replace("{n}", fmtNum(qualityProof.shadow_success))
                          .replace("{total}", fmtNum(qualityProof.total_trials))}
                      </div>
                      <div
                        style={{
                          color:
                            successPct < 90
                              ? "var(--danger)"
                              : "var(--text-muted)",
                          fontSize: 11,
                          marginTop: 4,
                        }}
                      >
                        {successPct < 90
                          ? tDash.qpStatSuccessDangerNote
                          : tDash.qpStatSuccessOkNote}
                      </div>
                    </div>
                    <div className="stat">
                      <div className="stat-label">{tDash.qpStatFaster}</div>
                      <div className="stat-value">{fasterPct}%</div>
                      <div
                        style={{ color: "var(--text-muted)", fontSize: 12 }}
                      >
                        {tDash.qpStatFasterNote.replace(
                          "{n}",
                          fmtNum(qualityProof.shadow_faster)
                        )}
                      </div>
                    </div>
                    <div className="stat">
                      <div className="stat-label">{tDash.qpStatCostDiff}</div>
                      <div
                        className="stat-value"
                        style={{
                          color:
                            cheaperUsd > 0
                              ? "var(--success)"
                              : "var(--text-muted)",
                        }}
                      >
                        {cheaperUsd > 0 ? "+" : ""}
                        {fmtSavingsUsd(qualityProof.delta_micro_cents)}
                      </div>
                      <div
                        style={{ color: "var(--text-muted)", fontSize: 12 }}
                      >
                        {tDash.qpStatCostDiffNote}
                      </div>
                    </div>
                  </div>
                );
              })()}
              {qualityProof.trials_with_similarity > 0 &&
                qualityProof.avg_similarity != null && (
                  <div
                    style={{
                      marginTop: 16,
                      padding: 14,
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        gap: 24,
                        alignItems: "center",
                        flexWrap: "wrap",
                      }}
                    >
                      <div>
                        <div
                          style={{
                            fontSize: 11,
                            color: "var(--text-muted)",
                            letterSpacing: "0.05em",
                            textTransform: "uppercase",
                            marginBottom: 4,
                          }}
                        >
                          {tDash.qpAvgSimilarity}
                        </div>
                        <div
                          style={{
                            fontSize: 22,
                            fontFamily: "var(--font-mono)",
                            fontWeight: 600,
                            color:
                              qualityProof.avg_similarity >= 0.85
                                ? "var(--success)"
                                : qualityProof.avg_similarity >= 0.7
                                  ? "var(--warning)"
                                  : "var(--danger)",
                          }}
                        >
                          {qualityProof.avg_similarity.toFixed(3)}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: "var(--text-muted)",
                            marginTop: 2,
                          }}
                        >
                          {tDash.qpSwitchSafeAcrossPrefix}
                          {qualityProof.trials_with_similarity}
                          {tDash.qpSwitchSafeAcrossSuffix.replace(
                            "{s}",
                            qualityProof.trials_with_similarity === 1 ? "" : "s"
                          )}
                        </div>
                      </div>
                      <div>
                        <div
                          style={{
                            fontSize: 11,
                            color: "var(--text-muted)",
                            letterSpacing: "0.05em",
                            textTransform: "uppercase",
                            marginBottom: 4,
                          }}
                        >
                          {tDash.qpSwitchSafeLabel}
                        </div>
                        <div
                          style={{
                            fontSize: 22,
                            fontFamily: "var(--font-mono)",
                            fontWeight: 600,
                          }}
                        >
                          {qualityProof.trials_with_similarity > 0
                            ? Math.round(
                                (qualityProof.high_similarity_count /
                                  qualityProof.trials_with_similarity) *
                                  100
                              )
                            : 0}
                          %
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: "var(--text-muted)",
                            marginTop: 2,
                          }}
                        >
                          {tDash.qpSwitchSafeOfPrefix}
                          {fmtNum(qualityProof.high_similarity_count)}
                          {tDash.qpSwitchSafeOfMid}
                          {fmtNum(qualityProof.trials_with_similarity)}
                          {tDash.qpSwitchSafeOfSuffix}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  marginTop: 12,
                  lineHeight: 1.5,
                }}
              >
                {tDash.qpFooterBody}
              </div>
            </div>
          )}

          {/* Spend by tag — only renders when at least one tagged request
              exists. Customers who haven't started using x-ts-tag won't see
              the noise. */}
          {spendByTag.length > 0 && (
            <div className="card">
              <div className="card-header">
                <h2>{tDash.sectionSpendByTag}</h2>
                <div className="card-header-spacer" />
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                  {tDash.tagSourceLabel}
                </span>
              </div>
              {(() => {
                const maxSpend = Math.max(
                  ...spendByTag.map((r) => r.total_cost_micro_cents),
                  1
                );
                const renderTagTable = (rows: SpendByTag[]) => (
                  <div style={{ overflowX: "auto" }}>
                    <table
                      className="data-table"
                      style={{ minWidth: 520, width: "100%" }}
                    >
                      <thead>
                        <tr>
                          <th>{tDash.tagColTag}</th>
                          <th className="numeric">{tDash.tagColCalls}</th>
                          <th className="numeric">{tDash.tagColSpend}</th>
                          <th>{tDash.tagColShare}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={`${r.tag_key}::${r.tag_value}`}>
                            <td style={{ whiteSpace: "nowrap" }}>
                              <code
                                className="code-inline"
                                style={{ marginRight: 6 }}
                              >
                                {r.tag_key}
                              </code>
                              <span style={{ color: "var(--text-secondary)" }}>
                                =
                              </span>
                              <span style={{ marginLeft: 4 }}>
                                {r.tag_value}
                              </span>
                            </td>
                            <td className="numeric">{fmtNum(r.call_count)}</td>
                            <td className="numeric">
                              {fmtMicroAsUsd(r.total_cost_micro_cents)}
                            </td>
                            <td>
                              <ShareBar
                                value={r.total_cost_micro_cents}
                                max={maxSpend}
                                tone="accent"
                                width={160}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
                const preview = spendByTag.slice(0, 3);
                const rest = spendByTag.slice(3);
                return (
                  <>
                    {renderTagTable(preview)}
                    {rest.length > 0 && (
                      <details className="inline-details">
                        <summary>
                          {tDash.tagShowMore
                            .replace("{n}", String(rest.length))
                            .replace("{s}", rest.length === 1 ? "" : "s")}
                        </summary>
                        {renderTagTable(rest)}
                      </details>
                    )}
                  </>
                );
              })()}
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  marginTop: 10,
                  lineHeight: 1.5,
                }}
              >
                {tDash.tagFooter}
              </div>
            </div>
          )}

          {/* Recent requests */}
          <div className="card">
            <div className="card-header">
              <h2>{tDash.sectionRecent}</h2>
              <div className="card-header-spacer" />
              <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                {tDash.recentLatestPrefix}
                {recent.length}
              </span>
            </div>
            {recent.length === 0 ? (
              <div className="empty">
                {tDash.recentEmptyPrefix}
                <code className="code-inline">{getPublicGatewayChatUrl()}</code>
                {tDash.recentEmptySuffix}
              </div>
            ) : (
              (() => {
                const groups = collapseLoops(recent);
                const renderRequestTable = (rows: RowGroup[]) => (
                  <div style={{ overflowX: "auto" }}>
                    <table
                      className="data-table clickable"
                      style={{ minWidth: 960, width: "100%" }}
                    >
                      <thead>
                        <tr>
                          <th>{tDash.recentColTime}</th>
                          <th>{tDash.recentColProvider}</th>
                          <th>{tDash.recentColModel}</th>
                          <th className="numeric">{tDash.recentColInput}</th>
                          <th className="numeric">{tDash.recentColOutput}</th>
                          <th className="numeric">{tDash.recentColCost}</th>
                          <th className="numeric">{tDash.recentColSaved}</th>
                          <th className="numeric">{tDash.recentColLatency}</th>
                          <th>{tDash.recentColStatus}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((group) => {
                    if (group.kind === "collapsed") {
                      const href = `/requests/${group.newest.id}`;
                      return (
                        <tr key={`collapsed-${group.newest.id}`} className="loop-row">
                          <td colSpan={9}>
                            <Link href={href} className="row-link">
                              <span className="pill pill-purple">
                                × {fmtNum(group.count)}
                              </span>
                              <span style={{ color: "var(--text-muted)" }}>
                                {fmtTime(group.oldest.created_at)}
                                <span style={{ margin: "0 6px" }}>–</span>
                                {fmtTime(group.newest.created_at)}
                              </span>
                              <span style={{ color: "var(--text-secondary)" }}>
                                <code className="code-inline" style={{ marginRight: 10 }}>
                                  {group.fingerprint}
                                </code>
                                {group.model}
                              </span>
                              <span className="status-loop_detected">
                                loop_detected
                              </span>
                            </Link>
                          </td>
                        </tr>
                      );
                    }
                    const r = group.row;
                    const href = `/requests/${r.id}`;
                    const cell = (
                      content: ReactNode,
                      opts?: { numeric?: boolean; dim?: boolean }
                    ) => (
                      <td className={opts?.numeric ? "numeric" : undefined}>
                        <Link
                          href={href}
                          className="row-link"
                          style={{
                            color: opts?.dim
                              ? "var(--text-secondary)"
                              : undefined,
                          }}
                        >
                          {content}
                        </Link>
                      </td>
                    );
                    const routed =
                      r.original_model != null &&
                      r.original_model !== r.model;
                    // whiteSpace:nowrap on the wrapper keeps the routing
                    // arrow from wrapping (`gpt-` on one line, then
                    // `5.2 → flash-lite` on the next) — the surrounding
                    // table-wrap div lets the row scroll horizontally
                    // when the viewport can't fit.
                    const modelCell: ReactNode = routed ? (
                      <span style={{ whiteSpace: "nowrap" }}>
                        <span style={{ color: "var(--text-muted)" }}>
                          {r.original_model}
                        </span>
                        <span
                          style={{
                            color: "var(--accent)",
                            padding: "0 6px",
                          }}
                        >
                          →
                        </span>
                        {r.model}
                      </span>
                    ) : (
                      <span style={{ whiteSpace: "nowrap" }}>{r.model}</span>
                    );
                    return (
                      <tr key={r.id}>
                        {cell(fmtTime(r.created_at), { dim: true })}
                        {cell(
                          <span className="pill pill-neutral">{r.provider}</span>
                        )}
                        {cell(modelCell)}
                        {cell(fmtNum(r.input_tokens), { numeric: true })}
                        {cell(fmtNum(r.output_tokens), { numeric: true })}
                        {cell(fmtMicroAsUsd(r.cost_micro_cents), {
                          numeric: true,
                        })}
                        {cell(
                          fmtSavingsUsd(
                            r.routing_saving_micro_cents +
                              r.cache_savings_micro_cents
                          ),
                          {
                            numeric: true,
                            dim:
                              r.routing_saving_micro_cents +
                                r.cache_savings_micro_cents ===
                              0,
                          }
                        )}
                        {cell(fmtLatency(r.latency_ms), {
                          numeric: true,
                          dim: true,
                        })}
                        {cell(
                          <span className={`status-${r.status}`}>
                            {r.status}
                          </span>
                        )}
                      </tr>
                    );
                        })}
                      </tbody>
                    </table>
                  </div>
                );
                const preview = groups.slice(0, 5);
                const rest = groups.slice(5);
                return (
                  <>
                    {renderRequestTable(preview)}
                    {rest.length > 0 && (
                      <details className="inline-details">
                        <summary>
                          {tDash.recentShowOlder
                            .replace("{n}", String(rest.length))
                            .replace("{s}", rest.length === 1 ? "" : "s")}
                        </summary>
                        {renderRequestTable(rest)}
                      </details>
                    )}
                  </>
                );
              })()
            )}
          </div>
        </>
      )}

      <footer>
        TokSuan · open source ·{" "}
        <a href="https://tokensmt.com" target="_blank" rel="noreferrer">
          tokensmt.com
        </a>
      </footer>
    </main>
  );
}
