import Link from "next/link";
import { redirect } from "next/navigation";
import { getScope, getSession, isAuthEnabled } from "@/lib/auth";
import {
  getSavingsBreakdown,
  getUserPlanUsageSnapshot,
  listBillingTransferIntentsForUser,
  type BillingTransferIntentRow,
} from "@/lib/db";
import {
  ENTERPRISE_DISPLAY,
  PLANS,
  planFromId,
  type Plan,
} from "@/lib/plans";
import { getDocsUrl } from "@/lib/docs-url";
import { isHostedMode } from "@/lib/mode";
import { isStripeConfigured } from "@/lib/stripe";
import {
  manageSubscriptionAction,
  upgradeToAction,
} from "./actions";
import { cancelBillingTransferIntentAction } from "../organization/actions";
import { SettingsLayout } from "@/components/SettingsLayout";
import { getDictionary } from "@/lib/i18n.server";
import type { Dictionary } from "@/i18n/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function formatDailyLimit(plan: Plan, t: { limitDailyTpl: string; limitUnlimited: string }): string {
  return Number.isFinite(plan.dailyLimitUsd)
    ? t.limitDailyTpl.replace("{n}", String(plan.dailyLimitUsd))
    : t.limitUnlimited;
}

function formatMonthlyRequests(
  plan: Plan,
  t: { limitMonthlyTpl: string; limitUnlimited: string },
  locale: string
): string {
  return Number.isFinite(plan.monthlyRequestLimit)
    ? t.limitMonthlyTpl.replace(
        "{n}",
        plan.monthlyRequestLimit.toLocaleString(
          locale === "zh-CN" ? "zh-CN" : "en-US"
        )
      )
    : t.limitUnlimited;
}

function formatBillingDate(d: Date | string, locale: string): string {
  return new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(d));
}

function getPlanDisplay(plan: Plan, t: Dictionary["billing"]) {
  switch (plan.id) {
    case "pro":
      return {
        tagline: t.planCards.proTagline,
        features: t.planCards.proFeatures,
      };
    case "team":
      return {
        tagline: t.planCards.teamTagline,
        features: t.planCards.teamFeatures,
      };
    case "scale":
      return {
        tagline: t.planCards.scaleTagline,
        features: t.planCards.scaleFeatures,
      };
    case "free":
    default:
      return {
        tagline: t.planCards.freeTagline,
        features: t.planCards.freeFeatures,
      };
  }
}

function formatUsd(microCents: number, digits = 2): string {
  return `$${(microCents / 100_000).toFixed(digits)}`;
}

/**
 * Inline usage-progress bar for the /billing "Current plan" card.
 * Color + numeric emphasis escalate at 60% / 80% / 100% so the
 * visual state of the meter tells the whole story without having
 * to read the small print.
 */
function UsageBar(props: {
  label: string;
  numerator: string;
  denominator: string;
  pct: number;
}) {
  const color =
    props.pct >= 100
      ? "var(--danger)"
      : props.pct >= 80
        ? "var(--warning)"
        : props.pct >= 60
          ? "var(--accent)"
          : "var(--success)";
  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          fontSize: 12,
          marginBottom: 4,
        }}
      >
        <span style={{ color: "var(--text-muted)" }}>{props.label}</span>
        <span style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>
          <strong style={{ color }}>{props.numerator}</strong>
          <span style={{ color: "var(--text-muted)" }}>
            {" "}
            / {props.denominator} ({props.pct}%)
          </span>
        </span>
      </div>
      <div
        style={{
          height: 6,
          background: "var(--border)",
          borderRadius: 999,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${Math.max(2, props.pct)}%`,
            background: color,
            transition: "width 200ms ease-out",
          }}
        />
      </div>
    </div>
  );
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  if (!isAuthEnabled()) redirect("/");
  const session = await getSession();
  if (!session) redirect("/login");

  const current = planFromId(session.user.plan);
  const { status } = await searchParams;
  const configured = isStripeConfigured();

  // Live usage snapshot for the meter — the gateway uses the same SQL
  // for real enforcement, so the numbers shown here match what would
  // actually block the next request if the meter runs dry.
  let usage: { daily_spent_micro_cents: number; monthly_request_count: number };
  let savings30d = {
    total_saving_micro_cents: 0,
    routing_saving_micro_cents: 0,
    cache_saving_micro_cents: 0,
    total_spend_micro_cents: 0,
    routing_request_count: 0,
    cache_hit_count: 0,
    loops_prevented_count: 0,
    budget_blocked_count: 0,
  };
  try {
    const scope = await getScope();
    [usage, savings30d] = await Promise.all([
      getUserPlanUsageSnapshot(session.user.id),
      getSavingsBreakdown(24 * 30, scope),
    ]);
  } catch {
    usage = { daily_spent_micro_cents: 0, monthly_request_count: 0 };
  }

  // Pending billing-transfer intents — may show up on both sides:
  // the old owner sees "you're handing off billing for <org> to <new>",
  // the new owner sees "<old> wants you to take over billing". Intent
  // rows that are completed / cancelled / expired are filtered out
  // by the DB helper.
  let billingTransfers: BillingTransferIntentRow[] = [];
  try {
    billingTransfers = await listBillingTransferIntentsForUser(
      session.user.id
    );
  } catch {
    /* non-fatal */
  }
  // Percent of each cap consumed. Unlimited (Team/Scale) renders null so
  // the bar can show "—" instead of a meaningless 0%.
  const dailyPct = Number.isFinite(current.dailyMicroCentsLimit)
    ? Math.min(
        100,
        Math.round(
          (usage.daily_spent_micro_cents / current.dailyMicroCentsLimit) *
            100
        )
      )
    : null;
  const monthlyPct = Number.isFinite(current.monthlyRequestLimit)
    ? Math.min(
        100,
        Math.round(
          (usage.monthly_request_count / current.monthlyRequestLimit) * 100
        )
      )
    : null;
  const anyNearCap =
    (dailyPct != null && dailyPct >= 80) ||
    (monthlyPct != null && monthlyPct >= 80);
  const proMonthlyMicroCents = 29 * 100_000;
  const weeklySavingsMicroCents =
    Math.round(savings30d.total_saving_micro_cents / 30) * 7;
  const proPaysThisWeek = weeklySavingsMicroCents >= proMonthlyMicroCents;
  const proPaybackDays =
    savings30d.total_saving_micro_cents > 0
      ? Math.max(
          1,
          Math.ceil(
            proMonthlyMicroCents /
              (savings30d.total_saving_micro_cents / 30)
          )
        )
      : null;

  const { locale, t } = await getDictionary();
  const tBilling = t.billing;

  return (
    <SettingsLayout t={t.nav}>
      <h1>{tBilling.title}</h1>
      <p className="tagline">{tBilling.tagline}</p>

      <div
        className="card card-accent"
        style={{
          marginBottom: 24,
          borderLeftWidth: 4,
          borderLeftStyle: "solid",
          borderLeftColor: proPaysThisWeek ? "var(--success)" : "var(--accent)",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) minmax(220px, auto)",
            gap: 18,
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
              {tBilling.paybackTitle}
            </div>
            <div
              style={{
                fontSize: 28,
                fontWeight: 700,
                letterSpacing: "-0.02em",
                marginTop: 4,
              }}
            >
              {savings30d.total_saving_micro_cents > 0 ? (
                proPaysThisWeek ? (
                  <>{tBilling.paybackPaysThisWeek}</>
                ) : proPaybackDays != null && proPaybackDays <= 30 ? (
                  <>
                    {tBilling.paybackPaysIn.replace(
                      "{days}",
                      String(proPaybackDays)
                    )}
                  </>
                ) : (
                  <>{tBilling.paybackKeepProving}</>
                )
              ) : (
                <>{tBilling.paybackRunFirst}</>
              )}
            </div>
            <div
              style={{
                fontSize: 13,
                color: "var(--text-secondary)",
                lineHeight: 1.55,
                marginTop: 8,
              }}
            >
              {tBilling.paybackBodyPrefix}
              <strong>{formatUsd(savings30d.total_saving_micro_cents)}</strong>
              {tBilling.paybackBodyMid}
              {tBilling.paybackBodySuffix}
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
              {savings30d.total_saving_micro_cents > 0 ? (
                <a href="#plans" className="btn btn-primary">
                  {tBilling.paybackComparePlans}
                </a>
              ) : (
                <Link href="/projects" className="btn btn-primary">
                  {tBilling.paybackSendFirst}
                </Link>
              )}
              <Link href="/estimate" className="btn">
                {tBilling.paybackEstimate}
              </Link>
            </div>
          </div>
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: 14,
              background: "var(--surface)",
              minWidth: 220,
            }}
          >
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {tBilling.paybackLast30}
            </div>
            <div
              style={{
                fontSize: 24,
                fontWeight: 700,
                color:
                  savings30d.total_saving_micro_cents > 0
                    ? "var(--success)"
                    : "var(--text-muted)",
                marginTop: 4,
              }}
            >
              {formatUsd(savings30d.total_saving_micro_cents)}
            </div>
            <div
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                lineHeight: 1.45,
                marginTop: 6,
              }}
            >
              {savings30d.routing_request_count}
              {tBilling.paybackRoutedSuffix} · {savings30d.cache_hit_count}
              {savings30d.cache_hit_count === 1
                ? tBilling.paybackCacheSingular
                : tBilling.paybackCachePlural}
            </div>
          </div>
        </div>
      </div>

      <div
        className="card"
        style={{
          background: "var(--accent-weak)",
          borderColor: "var(--accent)",
          marginBottom: 24,
        }}
      >
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>
            {tBilling.whyTitle}
          </div>
          <ul
            style={{
              margin: 0,
              padding: 0,
              listStyle: "none",
              fontSize: 13,
              color: "var(--text-secondary)",
              display: "grid",
              gap: 6,
            }}
          >
            <li>
              <span style={{ color: "var(--success)" }}>✓</span>{" "}
              <strong>{tBilling.why1Title}</strong> {tBilling.why1Body}
            </li>
            <li>
              <span style={{ color: "var(--success)" }}>✓</span>{" "}
              <strong>{tBilling.why2Title}</strong> {tBilling.why2Body}
            </li>
            <li>
              <span style={{ color: "var(--success)" }}>✓</span>{" "}
              <strong>{tBilling.why3Title}</strong> {tBilling.why3Body}
            </li>
            <li>
              <span style={{ color: "var(--success)" }}>✓</span>{" "}
              <strong>{tBilling.why4Title}</strong> {tBilling.why4Body}
            </li>
            <li>
              <span style={{ color: "var(--success)" }}>✓</span>{" "}
              <strong>{tBilling.why5Title}</strong>
              {tBilling.why5BodyPrefix}
              <Link href="/trust" style={{ color: "var(--accent)" }}>
                {tBilling.why5BodyLink}
              </Link>
              {tBilling.why5BodySuffix}
            </li>
            <li>
              <span style={{ color: "var(--text-muted)" }}>!</span>{" "}
              <strong>{tBilling.why6Title}</strong> {tBilling.why6Body}
            </li>
          </ul>
          <div style={{ marginTop: 4 }}>
            <a
              href="/estimate"
              style={{
                fontSize: 13,
                color: "var(--accent)",
                textDecoration: "underline",
              }}
            >
              {tBilling.whyEstimateLink}
            </a>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-header">
          <h2>{tBilling.notYetTitle}</h2>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 12,
            fontSize: 13,
            color: "var(--text-secondary)",
            lineHeight: 1.55,
          }}
        >
          <div>
            <strong style={{ color: "var(--text)" }}>{tBilling.notYet1Title}</strong>
            <br />
            {tBilling.notYet1BodyPrefix}
            <a
              href={getDocsUrl("QUICKSTART.md#self-host--production")}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent)" }}
            >
              {tBilling.notYet1BodyLink}
            </a>
            {tBilling.notYet1BodySuffix}
          </div>
          <div>
            <strong style={{ color: "var(--text)" }}>{tBilling.notYet2Title}</strong>
            <br />
            {tBilling.notYet2Body}
          </div>
          <div>
            <strong style={{ color: "var(--text)" }}>{tBilling.notYet3Title}</strong>
            <br />
            <a
              href={getDocsUrl("docs/production-runbook.md")}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent)" }}
            >
              {tBilling.notYet3BodyLink1}
            </a>
            {tBilling.notYet3BodyMid}
            <a
              href="https://github.com/tokensmart-llc/toksuan/issues/new/choose"
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent)" }}
            >
              {tBilling.notYet3BodyLink2}
            </a>
            {tBilling.notYet3BodySuffix}
          </div>
          <div>
            <strong style={{ color: "var(--text)" }}>{tBilling.notYet4Title}</strong>
            <br />
            {tBilling.notYet4Body}
          </div>
        </div>
      </div>

      {/* Pricing roadmap: keep this secondary. Buyers should first understand
          today's flat fee + proof loop; the future formula is a trust signal,
          not the primary upgrade reason. */}
      <div
        className="card"
        style={{
          background: "var(--surface)",
          marginBottom: 24,
          borderLeftWidth: 4,
          borderLeftStyle: "solid",
          borderLeftColor: "var(--border)",
        }}
      >
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>
            {tBilling.roadmapTitle}
          </div>
          <p
            style={{
              fontSize: 13,
              color: "var(--text-secondary)",
              lineHeight: 1.55,
              margin: 0,
            }}
          >
            {tBilling.roadmapBodyPrefix}
            <code className="code-inline">{tBilling.roadmapBodyCode}</code>
            {tBilling.roadmapBodySuffix}
          </p>
          <ul
            style={{
              fontSize: 13,
              color: "var(--text-secondary)",
              lineHeight: 1.6,
              margin: "4px 0 4px 0",
              padding: 0,
              listStyle: "none",
              fontFamily: "var(--font-mono)",
            }}
          >
            <li>{tBilling.roadmapPro}</li>
            <li>{tBilling.roadmapTeam}</li>
            <li>
              {tBilling.roadmapScale}
              <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
                {tBilling.roadmapScaleNote}
              </span>
            </li>
          </ul>
          <p
            style={{
              fontSize: 13,
              color: "var(--text-secondary)",
              lineHeight: 1.55,
              margin: "4px 0 0 0",
            }}
          >
            {tBilling.roadmapAfterBody}
          </p>
          <div
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              marginTop: 4,
            }}
          >
            {tBilling.roadmapTransitionFootnote}
          </div>
        </div>
      </div>

      {/* Reliability + SLA — solo-founder-honest version. No 99.9% claim,
          no status page yet (we'll stand one up alongside the public
          hosted launch — until then, building one is $30/mo with nothing
          to report). Link to the SECURITY.md "reliability posture". */}
      <div
        className="card"
        style={{
          background: "var(--surface)",
          marginBottom: 24,
          fontSize: 13,
          color: "var(--text-secondary)",
        }}
      >
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text)" }}>
            {tBilling.reliabilityTitle}
          </div>
          <p style={{ margin: 0, lineHeight: 1.55 }}>
            {tBilling.reliabilityBodyPrefix}
            <a
              href={getDocsUrl("SECURITY.md#reliability-posture")}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent)" }}
            >
              {tBilling.reliabilityBodyLink}
            </a>
            {tBilling.reliabilityBodySuffix}
          </p>
        </div>
      </div>

      {status === "success" && (
        <div className="card card-success">{tBilling.checkoutSuccess}</div>
      )}
      {status === "cancel" && (
        <div className="card card-warning">{tBilling.checkoutCancelled}</div>
      )}

      {!configured && (
        isHostedMode() ? (
          // Hosted operator: this would mean OUR Stripe credentials are
          // missing/broken — the customer can't fix it from their side
          // and shouldn't see a config-snippet that reads as "this SaaS
          // hasn't even wired payments." Tell them what's actually going
          // on (degradation, not absence) and that their plan is
          // unaffected.
          <div className="card card-warning">
            {tBilling.stripeMissingHosted}
          </div>
        ) : (
          // Self-host operator: actionable env-var diff is exactly what
          // they need.
          <div className="card card-danger">
            {tBilling.stripeMissingSelfHostPrefix}
            <code className="code-inline">STRIPE_SECRET_KEY</code>,{" "}
            <code className="code-inline">STRIPE_PRICE_PRO</code>,{" "}
            <code className="code-inline">STRIPE_PRICE_TEAM</code>
            {tBilling.stripeMissingSelfHostSuffix}
          </div>
        )
      )}

      {/* Billing-transfer intents — paint a clear explainer card on
          each party's /billing so neither side has to wonder "what's
          supposed to happen now?". The old owner gets instructions
          to keep their subscription alive until the new owner subs;
          the new owner gets a CTA to start their own subscription. */}
      {billingTransfers.map((intent) => {
        const iAmSender = intent.from_user_id === session.user.id;
        return (
          <div
            key={intent.id}
            className="card"
            style={{
              marginBottom: 24,
              borderLeftWidth: 4,
              borderLeftStyle: "solid",
              borderLeftColor: "var(--accent)",
            }}
          >
            <div className="card-header">
              <h3>
                {iAmSender
                  ? tBilling.transferTitleSender.replace(
                      "{org}",
                      intent.organization_name
                    )
                  : tBilling.transferTitleReceiver.replace(
                      "{org}",
                      intent.organization_name
                    )}
              </h3>
              <div className="card-header-spacer" />
              <span
                className="pill pill-neutral"
                style={{ fontSize: 11 }}
              >
                {tBilling.transferExpiresPrefix}
                {formatBillingDate(intent.expires_at, locale)}
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
              {iAmSender ? (
                <>
                  {tBilling.transferSenderBodyPrefix}
                  <strong>{intent.organization_name}</strong>
                  {tBilling.transferSenderBodyMid}
                  <code className="code-inline">{intent.to_email}</code>
                  {tBilling.transferSenderBodySuffix}
                  <br />
                  <span style={{ color: "var(--warning)" }}>
                    {tBilling.transferSenderHeadsUp}
                  </span>{" "}
                  <strong>
                    {formatBillingDate(intent.expires_at, locale)}
                  </strong>
                  {tBilling.transferSenderExpireSuffix}
                </>
              ) : (
                <>
                  {tBilling.transferReceiverBodyPrefix}
                  <code className="code-inline">{intent.from_email}</code>
                  {tBilling.transferReceiverBodyMid}
                  <strong>{intent.organization_name}</strong>
                  {tBilling.transferReceiverBodySuffix}
                </>
              )}
            </div>
            <form action={cancelBillingTransferIntentAction}>
              <input type="hidden" name="intent_id" value={intent.id} />
              <button type="submit" className="btn btn-sm btn-ghost">
                {tBilling.transferCancelButton}
              </button>
            </form>
          </div>
        );
      })}

      {/* Current-plan card */}
      <div className="card">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 24,
            flexWrap: "wrap",
          }}
        >
          <div>
            <h3>{tBilling.currentPlanH3}</h3>
            <div
              style={{
                fontSize: 24,
                fontWeight: 600,
                letterSpacing: "-0.01em",
                display: "flex",
                alignItems: "baseline",
                gap: 10,
              }}
            >
              {current.name}
              {current.priceUsdPerMonth > 0 && (
                <span
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: 14,
                    fontWeight: 400,
                  }}
                >
                  ${current.priceUsdPerMonth}
                  {tBilling.currentPlanPriceSuffix}
                </span>
              )}
            </div>
            <div
              style={{
                color: "var(--text-secondary)",
                fontSize: 13,
                marginTop: 6,
              }}
            >
              {tBilling.currentPlanLimitsLabel}
              <span style={{ color: "var(--text)" }}>
                {formatDailyLimit(current, tBilling)}
              </span>
              <span style={{ color: "var(--text-muted)", margin: "0 6px" }}>
                ·
              </span>
              <span style={{ color: "var(--text)" }}>
                {formatMonthlyRequests(current, tBilling, locale)}
              </span>
            </div>

            {/* Usage meter — live daily + monthly against the plan cap.
                Hidden entirely on unlimited tiers (Team / Scale) since
                a full-width bar with no maximum reads as a visual bug. */}
            {(dailyPct != null || monthlyPct != null) && (
              <div
                style={{
                  marginTop: 14,
                  display: "grid",
                  gap: 10,
                  maxWidth: 520,
                }}
              >
                {dailyPct != null && (
                  <UsageBar
                    label={tBilling.usageDailyMeterLabel}
                    numerator={`$${(
                      usage.daily_spent_micro_cents / 100_000
                    ).toFixed(4)}`}
                    denominator={`$${(
                      current.dailyMicroCentsLimit / 100_000
                    ).toFixed(2)}`}
                    pct={dailyPct}
                  />
                )}
                {monthlyPct != null && (
                  <UsageBar
                    label={tBilling.usageMonthlyMeterLabel}
                    numerator={usage.monthly_request_count.toLocaleString(
                      locale === "zh-CN" ? "zh-CN" : "en-US"
                    )}
                    denominator={`${current.monthlyRequestLimit.toLocaleString(
                      locale === "zh-CN" ? "zh-CN" : "en-US"
                    )}${tBilling.usageMonthlyDenomSuffix}`}
                    pct={monthlyPct}
                  />
                )}
                {anyNearCap && (
                  <div
                    style={{
                      fontSize: 11.5,
                      color: "var(--warning)",
                      lineHeight: 1.5,
                    }}
                  >
                    {tBilling.usageNearCapBody}
                  </div>
                )}
              </div>
            )}
          </div>
          <div style={{ flex: 1 }} />
          {configured && current.id !== "free" && (
            <form action={manageSubscriptionAction}>
              <button type="submit" className="btn">
                {tBilling.manageSubscriptionBtn}
              </button>
            </form>
          )}
        </div>
      </div>

      <h2 id="plans" style={{ marginTop: 32 }}>
        {tBilling.plansHeading}
      </h2>

      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
        }}
      >
        {Object.values(PLANS).map((p) => {
          const isCurrent = p.id === current.id;
          const canUpgrade = configured && p.id !== "free" && !isCurrent;
          const display = getPlanDisplay(p, tBilling);
          return (
            <div
              key={p.id}
              className={`card ${isCurrent ? "card-accent" : ""}`}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 14,
                marginBottom: 0,
              }}
            >
              <div>
                <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>
                  {display.tagline}
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 10,
                    marginTop: 6,
                  }}
                >
                  <div
                    style={{
                      fontSize: 22,
                      fontWeight: 600,
                      letterSpacing: "-0.01em",
                    }}
                  >
                    {p.name}
                  </div>
                  {isCurrent && (
                    <span className="pill pill-accent">
                      {tBilling.plansCurrentPill}
                    </span>
                  )}
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: "var(--text-secondary)",
                    fontSize: 13,
                    marginTop: 4,
                  }}
                >
                  {p.priceUsdPerMonth === 0 ? (
                    tBilling.plansFreeForever
                  ) : (
                    <>
                      ${p.priceUsdPerMonth}
                      {tBilling.currentPlanPriceSuffix}
                      <span
                        style={{
                          color: "var(--text-muted)",
                          marginLeft: 8,
                          fontSize: 11,
                        }}
                      >
                        ${p.priceUsdPerMonthAnnual}
                        {tBilling.plansAnnualSuffix}
                      </span>
                    </>
                  )}
                </div>
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 12,
                    color: "var(--accent)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {formatDailyLimit(p, tBilling)}
                  {tBilling.plansBucketSeparator}
                  {formatMonthlyRequests(p, tBilling, locale)}
                </div>
              </div>

              <ul
                style={{
                  margin: 0,
                  padding: 0,
                  listStyle: "none",
                  fontSize: 13,
                  color: "var(--text)",
                  display: "grid",
                  gap: 6,
                }}
              >
                {display.features.map((f) => (
                  <li
                    key={f}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                    }}
                  >
                    <span style={{ color: "var(--success)", lineHeight: 1.5 }}>
                      ✓
                    </span>
                    <span style={{ color: "var(--text-secondary)" }}>{f}</span>
                  </li>
                ))}
              </ul>

              <div style={{ flex: 1 }} />

              {isCurrent ? (
                <button type="button" className="btn" disabled>
                  {tBilling.plansCurrentPlanBtn}
                </button>
              ) : canUpgrade ? (
                <form action={upgradeToAction}>
                  <input type="hidden" name="plan" value={p.id} />
                  <button
                    type="submit"
                    className="btn btn-primary"
                    style={{ width: "100%" }}
                  >
                    {tBilling.plansUpgradeBtn.replace("{plan}", p.name)}
                  </button>
                </form>
              ) : p.id === "free" ? (
                <button type="button" className="btn" disabled>
                  {current.id === "free"
                    ? tBilling.plansFreeYouAreHere
                    : tBilling.plansDowngradeViaPortal}
                </button>
              ) : (
                <button type="button" className="btn" disabled>
                  {tBilling.plansBillingNotConfigured}
                </button>
              )}
            </div>
          );
        })}

        {/* Enterprise — synthetic display tier, no Stripe price, "talk to us"
            CTA. Positioned at the end of the grid so it doesn't compete with
            real upgrade flows but is visible to procurement-driven buyers. */}
        <div
          className="card"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 14,
            marginBottom: 0,
            borderStyle: "dashed",
            borderColor: "var(--border)",
          }}
        >
          <div>
            <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>
              {tBilling.planCards.enterpriseTagline}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 10,
                marginTop: 6,
              }}
            >
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 600,
                  letterSpacing: "-0.01em",
                }}
              >
                {tBilling.planCards.enterpriseName}
              </div>
            </div>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--text-secondary)",
                fontSize: 13,
                marginTop: 4,
              }}
            >
              {tBilling.plansEnterprisePricing}
            </div>
            <div
              style={{
                marginTop: 6,
                fontSize: 12,
                color: "var(--accent)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {tBilling.plansEnterpriseBilateral}
            </div>
          </div>

          <ul
            style={{
              margin: 0,
              padding: 0,
              listStyle: "none",
              fontSize: 13,
              color: "var(--text)",
              display: "grid",
              gap: 6,
            }}
          >
            {tBilling.planCards.enterpriseFeatures.map((f) => (
              <li
                key={f}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                }}
              >
                <span style={{ color: "var(--success)", lineHeight: 1.5 }}>
                  ✓
                </span>
                <span style={{ color: "var(--text-secondary)" }}>{f}</span>
              </li>
            ))}
          </ul>

          <div style={{ flex: 1 }} />

          <a
            href={ENTERPRISE_DISPLAY.contactHref}
            target="_blank"
            rel="noreferrer"
            className="btn btn-primary"
            style={{
              textDecoration: "none",
              textAlign: "center",
              width: "100%",
              display: "block",
            }}
          >
            {tBilling.plansEnterpriseContact}
          </a>
        </div>
      </div>

      {/* Discounts pointer */}
      <p
        style={{
          color: "var(--text-muted)",
          fontSize: 12,
          marginTop: 16,
          lineHeight: 1.6,
        }}
      >
        {tBilling.discountsBodyPrefix}
        <a
          href="https://github.com/tokensmart-llc/toksuan/issues/new/choose"
          target="_blank"
          rel="noreferrer"
          style={{ color: "var(--accent)" }}
        >
          {tBilling.discountsBodyLink}
        </a>
        {tBilling.discountsBodySuffix}
      </p>

      <p
        style={{
          color: "var(--text-muted)",
          fontSize: 12,
          marginTop: 8,
        }}
      >
        {tBilling.cancellationsBody}
      </p>
    </SettingsLayout>
  );
}
