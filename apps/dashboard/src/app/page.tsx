import type { ReactNode } from "react";
import Link from "next/link";
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
  getPublicAggregateProof,
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
  type PublicAggregateProof,
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
import { Logo } from "@/components/Logo";
import { ShareBar } from "@/components/ShareBar";
import { Sparkline } from "@/components/Sparkline";
import { QuickBudgetCTA } from "@/components/QuickBudgetCTA";
import { detectSpendAnomaly, type AnomalyVerdict } from "@/lib/anomaly";
import {
  getPublicGatewayChatUrl,
} from "@/lib/public-url";
import { getDocsUrl } from "@/lib/docs-url";
import { getDictionary } from "@/lib/i18n.server";
import type { Locale } from "@/lib/i18n";
import type { Dictionary } from "@/i18n/types";
import { LanguageToggle } from "@/components/LanguageToggle";
import { isHostedMode } from "@/lib/mode";

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

function fmtParticipantCount(proof: PublicAggregateProof): string {
  const total =
    proof.hosted_project_count + proof.self_host_deployment_count;
  if (total <= 0) return "0";
  return fmtNum(total);
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

function periodLabel(period: BudgetStatus["period"]): string {
  return period === "daily" ? "Today" : "This month";
}

/**
 * Single recommendation card. Each rec kind has its own evidence sentence
 * and a CTA (a Link to the relevant page or anchor). Server-rendered —
 * no client JS needed.
 */
function RecommendationItem({ rec }: { rec: Recommendation }): ReactNode {
  switch (rec.kind) {
    case "wasteful_pattern": {
      const saved = fmtSavingsUsd(rec.potential_saving_micro_cents);
      return (
        <div className="recommendation">
          <div className="recommendation-icon">$</div>
          <div className="recommendation-body">
            <div className="recommendation-title">
              {rec.request_count} short prompts on{" "}
              <code className="code-inline">{rec.from_model}</code> last 7d
              in <strong>{rec.project_name ?? "(unnamed project)"}</strong>{" "}
              — worth testing. Estimated savings: ~{saved} routing them to{" "}
              <code className="code-inline">{rec.to_model}</code>.
            </div>
          </div>
          <Link
            href={`/projects/${rec.project_id}#routing`}
            className="btn btn-sm btn-primary"
          >
            Add routing rule
          </Link>
        </div>
      );
    }
    case "loop_spike":
      return (
        <div className="recommendation">
          <div className="recommendation-icon recommendation-icon-warn">⟲</div>
          <div className="recommendation-body">
            <div className="recommendation-title">
              <strong>{rec.project_name ?? "(unnamed project)"}</strong>{" "}
              caught {rec.loop_count_24h} runaway loop attempts in the last
              24h. Worth tightening the loop threshold or adding an alert.
            </div>
          </div>
          <Link
            href={`/projects/${rec.project_id}#alerts`}
            className="btn btn-sm btn-primary"
          >
            Set alert
          </Link>
        </div>
      );
    case "undersized_budget": {
      const avg = `$${(rec.avg_daily_spend_micro_cents / MICRO_PER_USD).toFixed(2)}`;
      const limit = `$${(rec.current_daily_limit_micro_cents / MICRO_PER_USD).toFixed(2)}`;
      return (
        <div className="recommendation">
          <div className="recommendation-icon recommendation-icon-warn">↑</div>
          <div className="recommendation-body">
            <div className="recommendation-title">
              <strong>{rec.project_name ?? "(unnamed project)"}</strong> averages{" "}
              {avg}/day over the past 7d but its daily budget is {limit}.
              Requests are getting blocked routinely — bump the cap.
            </div>
          </div>
          <Link
            href={`/projects/${rec.project_id}#budgets`}
            className="btn btn-sm btn-primary"
          >
            Edit budget
          </Link>
        </div>
      );
    }
    case "no_budget_yet": {
      const spend = `$${(rec.spend_7d_micro_cents / MICRO_PER_USD).toFixed(4)}`;
      return (
        <div className="recommendation">
          <div className="recommendation-icon">!</div>
          <div className="recommendation-body">
            <div className="recommendation-title">
              <strong>{rec.project_name ?? "(unnamed project)"}</strong> spent{" "}
              {spend} in the past 7d with no daily budget set. One runaway
              loop could turn that into $1000s — set a cap.
            </div>
          </div>
          <Link
            href={`/projects/${rec.project_id}#budgets`}
            className="btn btn-sm btn-primary"
          >
            Set budget
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

function humanRoutingReason(r: RecentRequest): string {
  if (r.status === "loop_detected") {
    return "Loop detector blocked a repeated fingerprint before it hit upstream.";
  }
  if (r.status === "budget_exceeded") {
    return "Project budget stopped this request before upstream spend.";
  }
  if (r.status === "plan_limit_exceeded") {
    return "Plan cap stopped this request before upstream spend.";
  }
  if (!r.routing_reason || r.routing_reason === "none") {
    return r.original_model && r.original_model !== r.model
      ? "The gateway rewrote the model, but this older row did not store a routing reason."
      : "No model rewrite happened; TokSuan logged and priced the request as-is.";
  }
  if (r.routing_reason.startsWith("baseline:")) {
    const bucket = r.routing_bucket
      ? ` as ${r.routing_bucket.replace(":", " / ")}`
      : "";
    return `Baseline policy classified this request${bucket} and chose the cheaper landed model within the policy tolerance.`;
  }
  if (r.routing_reason.startsWith("rule:")) {
    return "A project routing rule matched this request and rewrote the model.";
  }
  if (r.routing_reason.includes("fallback")) {
    return "The gateway recovered from a model-resolution failure and fell back automatically.";
  }
  return r.routing_reason;
}

function qualityProofLabel(q: QualityProofSummary): {
  label: string;
  tone: "success" | "warning" | "danger" | "muted";
  body: string;
  actionLabel: string;
  actionHref: string;
} {
  if (q.trials_with_similarity > 0 && q.avg_similarity != null) {
    const pct =
      q.trials_with_similarity > 0
        ? Math.round((q.high_similarity_count / q.trials_with_similarity) * 100)
        : 0;
    if (q.avg_similarity < 0.7) {
      return {
        label: "Do not route yet",
        tone: "danger",
        body: `Shadow A/B has ${q.trials_with_similarity.toLocaleString("en-US")} similarity-scored trial${q.trials_with_similarity === 1 ? "" : "s"}; avg similarity is ${q.avg_similarity.toFixed(3)}. Keep the expensive model until you review failures.`,
        actionLabel: "Review routing quality",
        actionHref: "/routing-quality",
      };
    }
    return {
      label: q.avg_similarity >= 0.85 ? "Quality-checked" : "HTTP-safe",
      tone: q.avg_similarity >= 0.85 ? "success" : "warning",
      body: `Shadow A/B has ${q.trials_with_similarity.toLocaleString("en-US")} similarity-scored trial${q.trials_with_similarity === 1 ? "" : "s"}; avg similarity ${q.avg_similarity.toFixed(3)}, ${pct}% switch-safe.`,
      actionLabel:
        q.avg_similarity >= 0.85 ? "Review proof" : "Review borderline trials",
      actionHref: "/routing-quality",
    };
  }
  if (q.total_trials > 0) {
    const successPct = Math.round((q.shadow_success / q.total_trials) * 100);
    if (successPct < 90) {
      return {
        label: "Do not route yet",
        tone: "danger",
        body: `Shadow A/B has ${q.total_trials.toLocaleString("en-US")} trial${q.total_trials === 1 ? "" : "s"}; only ${successPct}% of shadow calls returned 2xx. Primary responses were still served, but do not promote this route yet.`,
        actionLabel: "Review failures",
        actionHref: "/routing-quality",
      };
    }
    return {
      label: "HTTP-safe",
      tone: successPct >= 95 ? "success" : "warning",
      body: `Shadow A/B has ${q.total_trials.toLocaleString("en-US")} trial${q.total_trials === 1 ? "" : "s"}; ${successPct}% of shadow calls returned 2xx. Primary responses were still served. Enable content quality scoring before promoting broadly.`,
      actionLabel: "Enable quality scoring",
      actionHref: "/settings",
    };
  }
  return {
    label: "Baseline only",
    tone: "muted",
    body: "This cost receipt is based on routing policy and ledger math. Add a shadow rule to prove answer quality on your own traffic before widening routes.",
    actionLabel: "Add shadow rule",
    actionHref: "/projects",
  };
}

function SavingsReceiptCard({
  request,
  qualityProof,
}: {
  request: RecentRequest;
  qualityProof: QualityProofSummary;
}) {
  const routed =
    request.original_model != null && request.original_model !== request.model;
  const saved =
    request.routing_saving_micro_cents + request.cache_savings_micro_cents;
  const landedOnCustom = request.provider.startsWith("custom:");
  const baselineCost = request.cost_micro_cents + saved;
  const savedPct =
    baselineCost > 0 ? Math.round((saved / baselineCost) * 100) : null;
  const quality = qualityProofLabel(qualityProof);
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
        <h2>Latest savings receipt</h2>
        <div className="card-header-spacer" />
        <Link
          href={`/requests/${request.id}`}
          style={{ color: "var(--accent)", fontSize: 12 }}
        >
          Open request →
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
              <div className="stat-label">Asked model</div>
              <div className="stat-value savings-receipt-model">
                <code className="code-inline break-code">
                  {request.original_model ?? request.model}
                </code>
              </div>
            </div>
            <div>
              <div className="stat-label">Landed model</div>
              <div className="stat-value savings-receipt-model">
                <code className="code-inline break-code">{request.model}</code>
              </div>
            </div>
            <div>
              <div className="stat-label">Saved on this request</div>
              <div
                className={`stat-value ${saved > 0 ? "stat-tone-success" : "stat-value-zero"}`}
                style={{ fontSize: 22 }}
              >
                {fmtSavingsUsd(saved)}
              </div>
              {savedPct != null && saved > 0 && (
                <div className="stat-value-sub">{savedPct}% vs asked model</div>
              )}
            </div>
            <div>
              <div className="stat-label">
                {landedOnCustom ? "Tracked API cost" : "Actual cost"}
              </div>
              <div className="stat-value" style={{ fontSize: 22 }}>
                {fmtSavingsUsd(request.cost_micro_cents)}
              </div>
              {landedOnCustom ? (
                <div className="stat-value-sub">
                  custom/self-host infra cost not included
                </div>
              ) : baselineCost > request.cost_micro_cents && (
                <div className="stat-value-sub">
                  asked would be {fmtSavingsUsd(baselineCost)}
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
            <strong style={{ color: "var(--text)" }}>Why this happened:</strong>{" "}
            {humanRoutingReason(request)}
            {landedOnCustom && (
              <>
                {" "}
                <strong style={{ color: "var(--text)" }}>
                  Self-host/custom note:
                </strong>{" "}
                TokSuan can prove this request moved off the asked model,
                but dollar savings do not include your GPU/infra cost unless
                you add pricing metadata for that endpoint.
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
            {routed && <span className="pill pill-accent">routed down</span>}
            {request.cache_savings_micro_cents > 0 && (
              <span className="pill pill-neutral">cache saved</span>
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
            Quality risk
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
}: {
  breakdown: SavingsBreakdown;
  topRoutes: TopRoutedPair[];
  topLoops: TopLoop[];
  qualityProof: QualityProofSummary;
}) {
  const saved = breakdown.total_saving_micro_cents;
  const proFeeMicroCents = 29 * MICRO_PER_USD;
  const paybackRatio = proFeeMicroCents > 0 ? saved / proFeeMicroCents : 0;
  const quality = qualityProofLabel(qualityProof);
  const bestRoute = topRoutes[0];
  const blocked =
    breakdown.loops_prevented_count + breakdown.budget_blocked_count;
  const nextAction =
    qualityProof.total_trials === 0
      ? {
          body: "Add a shadow rule to prove answer quality before routing more traffic.",
          href: "/projects",
          cta: "Add shadow rule",
        }
      : saved < proFeeMicroCents
        ? {
            body: "Keep running real traffic until the receipt clears the $29 Pro fee.",
            href: "/projects",
            cta: "Send more traffic",
          }
        : {
            body: "Upgrade to Pro when you want hosted retraining and zero-ops maintenance.",
            href: "/billing",
            cta: "Upgrade to Pro",
          };

  return (
    <section className="card" style={{ marginBottom: 24 }}>
      <div className="card-header">
        <h2>7-day value report</h2>
        <div className="card-header-spacer" />
        <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
          upgrade signal
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
          <div className="stat-label">Saved this week</div>
          <div
            className={`stat-value ${saved > 0 ? "stat-tone-success" : "stat-value-zero"}`}
          >
            {fmtSavingsUsd(saved)}
          </div>
          <div className="stat-value-sub">
            {paybackRatio >= 1
              ? `${paybackRatio.toFixed(1)}x the $29 Pro fee`
              : `${Math.round(paybackRatio * 100)}% of the $29 Pro fee`}
          </div>
        </div>
        <div>
          <div className="stat-label">Top downgrade</div>
          <div className="stat-value" style={{ fontSize: 22 }}>
            {bestRoute ? (
              fmtSavingsUsd(bestRoute.saved_micro_cents)
            ) : (
              <span className="stat-value-zero">none yet</span>
            )}
          </div>
          {bestRoute && (
            <div className="stat-value-sub">
              over {fmtNum(bestRoute.request_count)} request
              {bestRoute.request_count === 1 ? "" : "s"}
            </div>
          )}
        </div>
        <div>
          <div className="stat-label">Prevented</div>
          <div
            className={`stat-value ${blocked > 0 ? "stat-tone-warning" : "stat-value-zero"}`}
          >
            {fmtNum(blocked)}
          </div>
          <div className="stat-value-sub">
            {fmtNum(breakdown.loops_prevented_count)} loops ·{" "}
            {fmtNum(breakdown.budget_blocked_count)} budget/plan blocks
          </div>
        </div>
        <div>
          <div className="stat-label">Quality proof</div>
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
              ? `${fmtNum(qualityProof.total_trials)} shadow trials`
              : "no shadow data yet"}
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
          <strong style={{ color: "var(--text)" }}>Top downgrade:</strong>{" "}
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
        <strong style={{ color: "var(--text)" }}>Recommended next step:</strong>{" "}
        {nextAction.body}
        {topLoops.length > 0 && (
          <>
            {" "}
            Your noisiest repeated pattern is{" "}
            <code className="code-inline">{topLoops[0].fingerprint}</code> on{" "}
            <code className="code-inline">{topLoops[0].model}</code>.
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


function PublicLandingPage({
  signedIn = false,
  locale,
  t,
  aggregateProof,
}: {
  signedIn?: boolean;
  locale: Locale;
  t: Dictionary["landing"];
  aggregateProof: PublicAggregateProof;
}): React.ReactElement {
  const gatewayUrl = getPublicGatewayChatUrl().replace(/\/v1\/chat\/completions$/, "/v1");
  const appHref = signedIn ? "/dashboard" : "/login?next=/dashboard";
  const appLabel = signedIn ? t.ctaSignedIn : t.ctaAnonymous;
  const heroPrimary = signedIn ? t.heroPrimarySignedIn : t.heroPrimaryAnonymous;
  const finalCta = signedIn ? t.finalCtaSignedIn : t.finalCtaAnonymous;

  // Section-card data driven from the dictionary so each card stays a
  // single key pair instead of hand-mapping inline arrays.
  const hostedCards: ReadonlyArray<readonly [string, string]> = [
    [t.hostedCard1Title, t.hostedCard1Body],
    [t.hostedCard2Title, t.hostedCard2Body],
    [t.hostedCard3Title, t.hostedCard3Body],
  ];
  const whyCards: ReadonlyArray<readonly [string, string]> = [
    [t.why1Title, t.why1Body],
    [t.why2Title, t.why2Body],
    [t.why3Title, t.why3Body],
  ];
  const trustBand: ReadonlyArray<readonly [string, string]> = [
    [t.trustBand1Title, t.trustBand1Body],
    [t.trustBand2Title, t.trustBand2Body],
    [t.trustBand3Title, t.trustBand3Body],
  ];
  const faq: ReadonlyArray<readonly [string, string]> = [
    [t.faq1Q, t.faq1A],
    [t.faq2Q, t.faq2A],
    [t.faq3Q, t.faq3A],
    [t.faq4Q, t.faq4A],
    [t.faq5Q, t.faq5A],
    [t.faq6Q, t.faq6A],
  ];

  return (
    <main className="landing-main">
      <nav className="landing-nav" aria-label={t.publicNavAriaLabel}>
        <Link
          href="/"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            color: "var(--text)",
            fontWeight: 700,
            textDecoration: "none",
          }}
        >
          <Logo size={30} markOnly={false} />
        </Link>
        <div style={{ flex: 1 }} />
        <Link href="/state-of-agent-spend" className="app-nav-link">
          {t.navStateOfSpend}
        </Link>
        <Link href="/estimate" className="app-nav-link">
          {t.navEstimate}
        </Link>
        <Link href="/trust" className="app-nav-link">
          {t.navTrust}
        </Link>
        <a
          href={getDocsUrl("examples/openclaw/README.md")}
          target="_blank"
          rel="noopener noreferrer"
          className="app-nav-link"
        >
          {t.navOpenClaw}
        </a>
        <a
          href={getDocsUrl("examples/hermes-agent/README.md")}
          target="_blank"
          rel="noopener noreferrer"
          className="app-nav-link"
        >
          {t.navHermes}
        </a>
        <LanguageToggle locale={locale} variant="landing" />
        <Link href={appHref} className="btn btn-primary">
          {appLabel}
        </Link>
      </nav>

      <header className="landing-hero">
        <div>
          <div className="brand-hero-eyebrow">{t.heroEyebrow}</div>
          <h1 className="brand-hero-title" style={{ maxWidth: 720 }}>
            {t.heroTitle}
          </h1>
          <p className="brand-hero-subtitle" style={{ maxWidth: 680 }}>
            {t.heroSubtitle}
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
            <Link href={appHref} className="btn btn-primary">
              {heroPrimary}
            </Link>
            <Link href="/estimate" className="btn">
              {t.heroSecondaryEstimate}
            </Link>
            <Link href="/state-of-agent-spend" className="btn">
              {t.heroSecondaryRoutingWins}
            </Link>
            <a
              href={getDocsUrl("examples/openclaw/README.md")}
              target="_blank"
              rel="noopener noreferrer"
              className="btn"
            >
              {t.heroSecondaryOpenClaw}
            </a>
            <a
              href={getDocsUrl("examples/hermes-agent/README.md")}
              target="_blank"
              rel="noopener noreferrer"
              className="btn"
            >
              {t.heroSecondaryHermes}
            </a>
            <a
              href={getDocsUrl("QUICKSTART.md#self-host--production")}
              target="_blank"
              rel="noopener noreferrer"
              className="btn"
            >
              {t.heroSecondarySelfHost}
            </a>
          </div>
          <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 14 }}>
            {t.heroFinePrint}
          </p>
        </div>

        <section className="landing-receipt-card">
          <div className="landing-receipt-topbar">
            <span style={{ color: "var(--success)" }}>{t.receiptHeader}</span>
            <span style={{ color: "var(--text-muted)" }}>{t.receiptSession}</span>
          </div>
          <div style={{ padding: 18 }}>
            <div style={{ display: "grid", gap: 12 }}>
              <div>
                <div className="stat-label">{t.receiptAskedModel}</div>
                <code className="code-inline">gpt-5.5</code>
              </div>
              <div>
                <div className="stat-label">{t.receiptLandedModel}</div>
                <code className="code-inline">gemini-2.5-flash-lite</code>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                  gap: 12,
                }}
              >
                <div>
                  <div className="stat-label">{t.receiptCheaperRoute}</div>
                  <div className="stat-value stat-tone-success">89×</div>
                  <div className="stat-value-sub">{t.receiptCheaperRouteSub}</div>
                </div>
                <div>
                  <div className="stat-label">{t.receiptQualityProof}</div>
                  <div className="stat-value" style={{ fontSize: 18 }}>
                    {t.receiptQualityProofValue}
                  </div>
                </div>
              </div>
              <div
                style={{
                  padding: 12,
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  color: "var(--text-secondary)",
                  fontSize: 13,
                  lineHeight: 1.55,
                  background: "var(--surface-inset)",
                }}
              >
                {t.receiptDescription}
              </div>
            </div>
          </div>
        </section>
      </header>

      {aggregateProof.visible && (
        <section className="landing-aggregate-proof">
          <div>
            <div className="brand-hero-eyebrow">{t.aggregateEyebrow}</div>
            <h2>{t.aggregateTitleVisible}</h2>
            <p>{t.aggregateBodyVisible}</p>
          </div>
          <div className="landing-proof-strip">
            <div>
              <strong>{fmtSavingsUsd(aggregateProof.total_saving_micro_cents)}</strong>
              <span>{t.aggregateSavingsLabel}</span>
            </div>
            <div>
              <strong>{fmtNum(aggregateProof.request_count)}</strong>
              <span>{t.aggregateRequestsLabel}</span>
            </div>
            <div>
              <strong>{fmtNum(aggregateProof.loops_blocked_count)}</strong>
              <span>{t.aggregateLoopsLabel}</span>
            </div>
            <div>
              <strong>{fmtParticipantCount(aggregateProof)}</strong>
              <span>{t.aggregateParticipantsLabel}</span>
            </div>
          </div>
          <p className="landing-aggregate-note">{t.aggregatePrivacyNote}</p>
        </section>
      )}

      <section className="landing-quickstart" aria-label={t.quickstartAriaLabel}>
        <div className="landing-quickstart-copy">
          <div className="brand-hero-eyebrow">{t.quickstartEyebrow}</div>
          <h2>{t.quickstartTitle}</h2>
          <p>{t.quickstartSubtitle}</p>
        </div>
        <div className="landing-flow">
          {[
            ["01", t.quickstartStep1],
            ["02", t.quickstartStep2],
            ["03", t.quickstartStep3],
            ["04", t.quickstartStep4],
          ].map(([step, label]) => (
            <div key={step} className="landing-flow-node">
              <span>{step}</span>
              <strong>{label}</strong>
            </div>
          ))}
        </div>
        <div className="landing-flow-diagram" aria-hidden="true">
          <div className="flow-box">{t.flowAgentSdk}</div>
          <div className="flow-line">
            <span />
          </div>
          <div className="flow-box flow-box-accent">{t.flowGateway}</div>
          <div className="flow-line">
            <span />
          </div>
          <div className="flow-box">{t.flowProvider}</div>
          <div className="flow-down">
            <span />
          </div>
          <div className="flow-receipt">{t.flowReceipt}</div>
        </div>
      </section>

      <section className="landing-section landing-split">
        <div>
          <div className="brand-hero-eyebrow">{t.hostedEyebrow}</div>
          <h2 className="landing-section-title">{t.hostedTitle}</h2>
          <p className="landing-section-copy">{t.hostedBody}</p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
            <Link href="/trust" className="btn btn-sm">
              {t.hostedCtaTrust}
            </Link>
            <Link href="/state-of-agent-spend" className="btn btn-sm">
              {t.hostedCtaProof}
            </Link>
          </div>
        </div>
        <div className="landing-problem-stack">
          {hostedCards.map(([title, body], index) => (
            <div key={title} className="landing-problem-card">
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section landing-code-section">
        <div>
          <div className="brand-hero-eyebrow">{t.devEyebrow}</div>
          <h2 className="landing-section-title">{t.devTitle}</h2>
          <p className="landing-section-copy">{t.devBody}</p>
          <div className="landing-tool-cloud">
            {[
              ["Cursor", "docs/integrations/cursor.md"],
              ["OpenClaw", "examples/openclaw/README.md"],
              ["Hermes", "examples/hermes-agent/README.md"],
              ["LangChain", "docs/integrations/langchain.md"],
              ["Vercel AI SDK", "docs/integrations/vercel-ai-sdk.md"],
              ["Cline", "docs/integrations/cline.md"],
            ].map(([tool, href]) => (
              <a
                key={tool}
                href={getDocsUrl(href)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {tool}
              </a>
            ))}
          </div>
        </div>
        <div className="landing-code-card">
          <div className="landing-code-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <pre className="code-block">
{`import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${gatewayUrl}",
  apiKey: "ts_your_project_key",
});

await client.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Ship it." }],
});`}
          </pre>
        </div>
      </section>

      <section className="landing-section landing-split">
        <div>
          <div className="brand-hero-eyebrow">{t.whyEyebrow}</div>
          <h2 className="landing-section-title">{t.whyTitle}</h2>
          <p className="landing-section-copy">{t.whyBody}</p>
        </div>
        <div className="landing-problem-stack">
          {whyCards.map(([title, body], index) => (
            <div key={title} className="landing-problem-card">
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section">
        <div className="landing-loop-heading">
          <div className="brand-hero-eyebrow">{t.loopEyebrow}</div>
          <h2 className="landing-section-title">{t.loopTitle}</h2>
          <p className="landing-section-copy">{t.loopBody}</p>
        </div>
        <div className="landing-bento">
          <div className="landing-bento-card landing-bento-large landing-bento-accent">
            <span className="pill pill-accent">{t.bento1Pill}</span>
            <h3>{t.bento1Title}</h3>
            <p>{t.bento1Body}</p>
          </div>
          <div className="landing-bento-card">
            <span className="pill pill-warning">{t.bento2Pill}</span>
            <h3>{t.bento2Title}</h3>
            <p>{t.bento2Body}</p>
          </div>
          <div className="landing-bento-card">
            <span className="pill pill-purple">{t.bento3Pill}</span>
            <h3>{t.bento3Title}</h3>
            <p>{t.bento3Body}</p>
          </div>
          <div className="landing-bento-card landing-bento-wide">
            <span className="pill pill-success">{t.bento4Pill}</span>
            <h3>{t.bento4Title}</h3>
            <p>{t.bento4Body}</p>
          </div>
        </div>
      </section>

      <section className="landing-section landing-trust-band">
        {trustBand.map(([title, body]) => (
          <div key={title}>
            <h3>{title}</h3>
            <p>{body}</p>
          </div>
        ))}
      </section>

      <section className="landing-section landing-faq">
        <div>
          <div className="brand-hero-eyebrow">{t.faqEyebrow}</div>
          <h2 className="landing-section-title">{t.faqTitle}</h2>
          <p className="landing-section-copy">{t.faqBody}</p>
        </div>
        <div className="landing-faq-grid">
          {faq.map(([question, answer]) => (
            <div key={question}>
              <h3>{question}</h3>
              <p>{answer}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-final-cta">
        <div className="brand-hero-eyebrow">{t.finalEyebrow}</div>
        <h2>{t.finalTitle}</h2>
        <p>{t.finalBody}</p>
        <div>
          <Link href={appHref} className="btn btn-primary">
            {finalCta}
          </Link>
          <a
            href={getDocsUrl("QUICKSTART.md")}
            target="_blank"
            rel="noopener noreferrer"
            className="btn"
          >
            {t.finalCtaQuickstart}
          </a>
          <Link href="/trust" className="btn">
            {t.hostedCtaTrust}
          </Link>
        </div>
      </section>
    </main>
  );
}


export default async function Page() {
  const session = isAuthEnabled() ? await getSession() : null;
  const { locale, t } = await getDictionary();
  const aggregateProof = await getPublicAggregateProof();
  return (
    <PublicLandingPage
      signedIn={Boolean(session)}
      locale={locale}
      t={t.landing}
      aggregateProof={aggregateProof}
    />
  );
}
