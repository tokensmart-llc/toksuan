import { redirect } from "next/navigation";
import { getSession, isAuthEnabled } from "@/lib/auth";
import {
  getReferralProfile,
  getReferralStats,
  listReferralCreditsForUser,
  type ReferralCreditRow,
  type ReferralProfile,
  type ReferralStats,
} from "@/lib/db";
import { CopyButton } from "@/components/CopyButton";
import { SettingsLayout } from "@/components/SettingsLayout";
import { getDictionary } from "@/lib/i18n.server";
import {
  generateReferralCodeAction,
  settleReferralCreditsAction,
} from "./actions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MICRO_PER_USD = 100_000;

function fmtUsd(microCents: number, digits = 2): string {
  return `$${(microCents / MICRO_PER_USD).toFixed(digits)}`;
}

function fmtTime(d: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(d));
}

/**
 * Dashboard origin used in the user-visible "share your link" copy.
 *
 *   1. `NEXT_PUBLIC_BASE_URL` — the configured dashboard origin. On
 *      hosted tokensmt.com this is `https://tokensmt.com`; on a
 *      self-hosted install the operator sets it to their own domain.
 *   2. Fallback: `http://localhost:3000` for dev. Deliberately NOT
 *      hard-coded to `tokensmt.com` — that would silently misroute a
 *      self-hoster's viral loop back to our site.
 */
function publicBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_BASE_URL?.trim();
  if (raw) return raw.replace(/\/+$/, "");
  return "http://localhost:3000";
}

export default async function ReferralsPage() {
  if (!isAuthEnabled()) redirect("/");
  const session = await getSession();
  if (!session) redirect("/login");

  let profile: ReferralProfile = {
    referral_code: null,
    referred_by_user_id: null,
    referred_by_email: null,
  };
  let stats: ReferralStats = {
    referee_count: 0,
    paying_referee_count: 0,
    total_credit_micro_cents: 0,
    pending_credit_micro_cents: 0,
  };
  let credits: ReferralCreditRow[] = [];
  // Each query handled independently — if `getReferralStats` throws,
  // we still want the user to see their referral CODE and credit list
  // (and to be able to click "Generate my referral code" if they have
  // none yet). The previous Promise.all-and-catch pattern hid the code
  // generator behind every transient stats failure.
  const dbErrors: string[] = [];
  const [profileR, statsR, creditsR] = await Promise.allSettled([
    getReferralProfile(session.user.id),
    getReferralStats(session.user.id),
    listReferralCreditsForUser(session.user.id, 100),
  ]);
  if (profileR.status === "fulfilled") profile = profileR.value;
  else dbErrors.push(`profile: ${profileR.reason?.message ?? profileR.reason}`);
  if (statsR.status === "fulfilled") stats = statsR.value;
  else dbErrors.push(`stats: ${statsR.reason?.message ?? statsR.reason}`);
  if (creditsR.status === "fulfilled") credits = creditsR.value;
  else dbErrors.push(`credits: ${creditsR.reason?.message ?? creditsR.reason}`);
  const dbError = dbErrors.length > 0 ? dbErrors.join(" · ") : null;

  const opsEmails = (process.env.TOKENSMART_OPS_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const isOperator = opsEmails.includes(session.user.email.toLowerCase());

  const code = profile.referral_code;
  const shareUrl = code ? `${publicBaseUrl()}/?ref=${code}` : null;
  const { locale, t } = await getDictionary();
  const tr = t.referrals;

  return (
    <SettingsLayout t={t.nav}>
      <h1>{t.nav.settingsReferrals}</h1>
      <p className="tagline">
        {tr.taglinePrefix}
        <strong>{tr.taglineCommission}</strong>
        {tr.taglineMid}
        <strong>{tr.taglineAnnualCap}</strong>
        {tr.taglineSuffix}
      </p>

      {dbError && (
        <div className="card card-danger">
          <strong>{tr.dbErrTitle}</strong>
          <br />
          <span style={{ color: "var(--text-muted)" }}>{dbError}</span>
        </div>
      )}

      {/* Your referral link */}
      <div
        className="card"
        style={{
          borderLeftWidth: 4,
          borderLeftStyle: "solid",
          borderLeftColor: "var(--accent)",
        }}
      >
        <div className="card-header">
          <h2>{tr.linkTitle}</h2>
        </div>
        {!code ? (
          <form
            action={generateReferralCodeAction}
            style={{ display: "grid", gap: 10 }}
          >
            <div
              style={{
                fontSize: 13,
                color: "var(--text-secondary)",
                lineHeight: 1.55,
              }}
            >
              {tr.linkEmptyBody}
            </div>
            <div>
              <button type="submit" className="btn btn-primary">
                {tr.linkGenerateBtn}
              </button>
            </div>
          </form>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            <div
              style={{
                fontSize: 12,
                color: "var(--text-muted)",
              }}
            >
              {tr.linkYourCode}{" "}
              <code className="code-inline" style={{ fontSize: 13 }}>
                {code}
              </code>
            </div>
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <CopyButton
                value={shareUrl ?? ""}
                display={shareUrl ?? ""}
                t={t.copyButton}
              />
            </div>
            <div
              style={{
                fontSize: 12,
                color: "var(--text-secondary)",
                lineHeight: 1.55,
              }}
            >
              {tr.linkShareHelp}
            </div>
          </div>
        )}
      </div>

      {/* Stats grid */}
      <div className="stat-grid">
        <div className="stat">
          <div className="stat-label">{tr.statSignedUp}</div>
          <div className="stat-value">{stats.referee_count}</div>
          {stats.paying_referee_count > 0 && (
            <div className="stat-value-sub">
              {stats.paying_referee_count}
              {tr.statSignedUpPayingSuffix}
            </div>
          )}
        </div>
        <div className="stat">
          <div className="stat-label">{tr.statTotalEarned}</div>
          <div className="stat-value">
            {fmtUsd(stats.total_credit_micro_cents)}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">{tr.statPending}</div>
          <div className="stat-value">
            {fmtUsd(stats.pending_credit_micro_cents)}
          </div>
          <div
            className="stat-value-sub"
            style={{ color: "var(--text-muted)" }}
          >
            {tr.statPendingSubLabel}
          </div>
        </div>
      </div>

      {/* You were referred by */}
      {profile.referred_by_email && (
        <div
          className="card"
          style={{
            background: "var(--surface)",
            fontSize: 13,
            color: "var(--text-secondary)",
          }}
        >
          {tr.referredByPrefix}
          <code className="code-inline">{profile.referred_by_email}</code>
          {tr.referredBySuffix}
        </div>
      )}

      {/* Credits ledger */}
      <div className="card">
        <div className="card-header">
          <h2>{tr.historyTitle}</h2>
          <div className="card-header-spacer" />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            {credits.length}
            {credits.length === 1
              ? tr.historyRowsSingular
              : tr.historyRowsPlural}
          </span>
        </div>

        {credits.length === 0 ? (
          <div
            style={{
              padding: "20px 16px",
              fontSize: 13,
              color: "var(--text-secondary)",
              lineHeight: 1.55,
            }}
          >
            <div style={{ marginBottom: 6 }}>
              <strong>{tr.historyEmptyTitle}</strong>
              {tr.historyEmptyBody}
            </div>
            <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
              {tr.historyTipPrefix}
              <code className="code-inline">
                {code ? `?ref=${code}` : tr.historyTipPlaceholder}
              </code>
              {tr.historyTipSuffix}
            </div>
          </div>
        ) : (
          <div style={{ overflowX: "auto", minWidth: 0 }}>
            <table className="data-table" style={{ minWidth: 720 }}>
              <thead>
                <tr>
                  <th>{tr.historyColDate}</th>
                  <th>{tr.historyColReferee}</th>
                  <th>{tr.historyColInvoice}</th>
                  <th>{tr.historyColCommission}</th>
                  <th>{tr.historyColStatus}</th>
                </tr>
              </thead>
              <tbody>
                {credits.map((c) => (
                  <tr key={c.id}>
                    <td className="muted">{fmtTime(c.created_at, locale)}</td>
                    <td>
                      <code
                        className="code-inline"
                        title={c.referee_email ?? "—"}
                      >
                        {c.referee_email ?? "—"}
                      </code>
                    </td>
                    <td
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 12,
                        color: "var(--text-secondary)",
                      }}
                    >
                      {fmtUsd(c.referee_invoice_subtotal_micro_cents)}{" "}
                      <span
                        style={{
                          color: "var(--text-muted)",
                          fontSize: 10,
                          marginLeft: 4,
                        }}
                      >
                        {c.referee_invoice_id.slice(-8)}
                      </span>
                    </td>
                    <td
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 13,
                      }}
                    >
                      <strong>{fmtUsd(c.credit_micro_cents)}</strong>
                    </td>
                    <td>
                      {c.applied_at ? (
                        <span
                          className="pill pill-success"
                          title={`${tr.historyStatusCreditedTooltip} ${
                            c.stripe_balance_txn_id ?? ""
                          }`}
                        >
                          {tr.historyStatusCredited}
                        </span>
                      ) : (
                        <span
                          className="pill pill-warning"
                          title={tr.historyStatusPendingTooltip}
                        >
                          {tr.historyStatusPending}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Operator-only settle button */}
      {isOperator && (
        <div
          className="card"
          style={{
            borderLeftWidth: 4,
            borderLeftStyle: "solid",
            borderLeftColor: "var(--purple)",
          }}
        >
          <div className="card-header">
            <h2>Operator: settle pending credits</h2>
          </div>
          <div
            style={{
              fontSize: 13,
              color: "var(--text-secondary)",
              lineHeight: 1.55,
              marginBottom: 12,
            }}
          >
            Drains the global pending queue (across ALL referrers) by minting
            Stripe customer-balance credits on each referrer&apos;s account.
            Idempotent — credits already applied are skipped.
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              lineHeight: 1.55,
              marginBottom: 12,
              padding: "8px 10px",
              background: "var(--code-bg)",
              borderRadius: 6,
            }}
          >
            <strong style={{ color: "var(--text-secondary)" }}>
              Automated pass:
            </strong>{" "}
            a daily cron at 04:30 UTC runs the same code via{" "}
            <code className="code-inline">
              .github/workflows/settle-referrals.yml
            </code>
            . This button is the manual override — useful for verifying a
            new referee right after they pay, or for catching up after a
            Stripe outage. Both code paths write to the same{" "}
            <code className="code-inline">ops_audit_events</code> log.
          </div>
          <form action={settleReferralCreditsAction}>
            <button type="submit" className="btn btn-primary">
              Run settle pass now
            </button>
          </form>
        </div>
      )}

      {/* Program rules */}
      <div
        className="card"
        style={{
          background: "var(--surface)",
          fontSize: 12,
          color: "var(--text-muted)",
          lineHeight: 1.6,
        }}
      >
        <div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>
          {tr.rulesTitle}
        </div>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          <li>
            {tr.rule1Prefix}
            <strong>{tr.rule1Commission}</strong>
            {tr.rule1Suffix}
          </li>
          <li>
            {tr.rule2Prefix}
            <strong>{tr.rule2Cap}</strong>
            {tr.rule2Suffix}
          </li>
          <li>{tr.rule3}</li>
          <li>{tr.rule4}</li>
          <li>{tr.rule5}</li>
          <li>{tr.rule6}</li>
        </ul>
      </div>
    </SettingsLayout>
  );
}
