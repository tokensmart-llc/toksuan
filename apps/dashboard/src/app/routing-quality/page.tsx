/**
 * Routing-quality monitor.
 *
 * Answers the operator's #1 worry after enabling auto-downgrade:
 *   "Did TokSuan silently trade dollars for failed responses?"
 *
 * Surface:
 *   - Top section: every (asked, landed) ROUTED pair (gateway rewrote
 *     the model). Per row: total calls, success rate, deltas vs the
 *     same landed model when asked NATIVELY (no rewrite). Negative
 *     deltas are the headline alarm — they say "when this rewrite
 *     fires the model fails more often than when the same model is
 *     asked directly".
 *   - Lower section: native-call success rates for every landed model
 *     (the comparison baseline). Useful as a denominator + sanity
 *     check that the cheap models we route TO are themselves stable.
 *
 * What this page DELIBERATELY does NOT measure:
 *   - Answer-quality regressions on requests that returned status
 *     'success' but produced a confidently-wrong response. That needs
 *     either shadow A/B (already wired) or human eval.
 *   - Per-bucket breakdown (chat:medium vs code:hard etc.) — the
 *     `requests` row doesn't currently store the policy bucket the
 *     classifier picked. If we add a `routing_reason` column later,
 *     this page is the natural place to surface bucket-level deltas.
 */
import Link from "next/link";
import { getScope, getSession, isAuthEnabled } from "@/lib/auth";
import {
  getRoutingQuality,
  type RoutingBucketStats,
  type RoutingQuality,
} from "@/lib/db";
import { AutoRefresh } from "@/components/AutoRefresh";
import { getDictionary } from "@/lib/i18n.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MICRO_PER_USD = 100_000;

function fmtUsd(microCents: number, digits = 4): string {
  return `$${(microCents / MICRO_PER_USD).toFixed(digits)}`;
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtPct(p: number | null, digits = 1): string {
  if (p == null) return "—";
  return `${p.toFixed(digits)}%`;
}

function fmtLatency(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Color scale for the success-rate column.
 *   ≥ 99%   ok (green)
 *   ≥ 95%   neutral (default text color)
 *   ≥ 90%   warning (amber)
 *   < 90%   danger (red)
 *
 * Pick the same thresholds for absolute success rate and for the
 * delta vs baseline (negative deltas inherit the same scale).
 */
function colorForSuccess(p: number | null): string | undefined {
  if (p == null) return undefined;
  if (p >= 99) return "var(--ok, #15803d)";
  if (p >= 95) return undefined;
  if (p >= 90) return "var(--warning, #b45309)";
  return "var(--danger, #b91c1c)";
}

function colorForDelta(d: number | null): string | undefined {
  if (d == null) return "var(--muted)";
  if (d >= 0) return "var(--ok, #15803d)";
  if (d >= -1) return undefined;
  if (d >= -5) return "var(--warning, #b45309)";
  return "var(--danger, #b91c1c)";
}

function fmtDelta(d: number | null): string {
  if (d == null) return "—";
  const sign = d > 0 ? "+" : d === 0 ? "±" : "";
  return `${sign}${d.toFixed(1)}pp`;
}

export default async function RoutingQualityPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const authEnabled = isAuthEnabled();
  const session = authEnabled ? await getSession() : null;
  // Public read-only mode: anonymous users may open the page from the
  // marketing proof surface, but they must not see hosted customer traffic.
  // `[]` means "match no projects" in db.ts's Scope convention. Logged-in
  // users still see their own projects; self-host auth-off deployments see all.
  const scope = authEnabled ? (session ? await getScope() : []) : undefined;
  const publicReadOnly = authEnabled && !session;
  const sp = await searchParams;
  const sinceDays = (() => {
    const n = Number(sp.days);
    return Number.isFinite(n) && n > 0 && n <= 90 ? Math.floor(n) : 7;
  })();

  let data: RoutingQuality = { rewrites: [], natives: [], by_bucket: [] };
  let queryError: string | null = null;
  try {
    data = await getRoutingQuality(sinceDays, scope);
  } catch (err) {
    queryError = err instanceof Error ? err.message : String(err);
    console.error("[dashboard] getRoutingQuality failed:", err);
  }

  const totalRewrites = data.rewrites.reduce((acc, r) => acc + r.total, 0);
  const totalRewriteSuccess = data.rewrites.reduce(
    (acc, r) => acc + r.success,
    0
  );
  const totalRewriteReachedUpstream = data.rewrites.reduce(
    (acc, r) => acc + r.success + r.upstream_errors,
    0
  );
  // Mirror the per-row formula: only requests that reached upstream
  // count toward the success rate. Loop / quota blocks are TokSuan
  // protection layers, orthogonal to "did the routed model perform".
  const overallRewriteRate =
    totalRewriteReachedUpstream > 0
      ? Math.round((1000 * totalRewriteSuccess) / totalRewriteReachedUpstream) / 10
      : null;

  // Identify rewrite pairs whose success rate has dropped meaningfully
  // vs their direct-call baseline (≥ 5pp drop AND at least 20 samples
  // so we're not alarming on small numbers).
  const flagged = data.rewrites.filter(
    (r) =>
      r.success_rate_delta_pct != null &&
      r.success_rate_delta_pct <= -5 &&
      r.total >= 20
  );

  // Captured at the start of this server render so <AutoRefresh> can show a
  // stable "updated Xs ago" label. See components/AutoRefresh.tsx.
  const renderedAt = Date.now();

  const { t } = await getDictionary();

  return (
    <main>
      <Link href={publicReadOnly ? "/" : "/dashboard"} className="back-link">
        {publicReadOnly ? t.routingQuality.backHome : t.routingQuality.backDashboard}
      </Link>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 14,
          flexWrap: "wrap",
          marginBottom: 4,
        }}
      >
        <h1 style={{ margin: 0 }}>{t.routingQualityPage.title}</h1>
        <AutoRefresh renderedAt={renderedAt} t={t.common.autoRefresh} />
      </div>
      <p style={{ color: "var(--muted)", marginTop: 0 }}>
        {t.routingQualityPage.paragraph
          .replace("{days}", String(sinceDays))
          .replace(
            "{dayWord}",
            sinceDays === 1
              ? t.routingQualityPage.dayWordSingular
              : t.routingQualityPage.dayWordPlural
          )}
      </p>

      {publicReadOnly && (
        <section className="card card-accent" style={{ marginBottom: 16 }}>
          <strong>{t.routingQualityPage.publicReadOnlyTitle}</strong>{" "}
          <span style={{ color: "var(--text-secondary)" }}>
            {t.routingQualityPage.publicReadOnlyBody}
          </span>
          <div style={{ marginTop: 10 }}>
            <Link href="/login?next=/routing-quality" className="btn btn-sm btn-primary">
              {t.routingQualityPage.publicSignInCta}
            </Link>
          </div>
        </section>
      )}

      <section style={{ margin: "8px 0 16px", color: "var(--muted)", fontSize: 13 }}>
        {t.agentsPage.windowLabel}{" "}
        {[
          { d: 1, label: t.agentsPage.window24h },
          { d: 7, label: t.agentsPage.window7d },
          { d: 30, label: t.agentsPage.window30d },
        ].map(({ d, label }) => (
          <Link
            key={d}
            href={`/routing-quality?days=${d}`}
            className={d === sinceDays ? "pill pill-accent" : "pill pill-neutral"}
            style={{ marginRight: 8, textDecoration: "none" }}
          >
            {label}
          </Link>
        ))}
      </section>

      {queryError && (
        <section
          style={{
            padding: 12,
            border: "1px solid var(--danger)",
            borderRadius: 8,
            color: "var(--danger)",
            background: "var(--bg)",
            marginBottom: 16,
          }}
        >
          {t.routingQualityPage.queryFailedPrefix}
          {t.routingQualityPage.queryFailedDetailPrefix}
          <code>{queryError}</code>
        </section>
      )}

      {data.rewrites.length === 0 && !queryError && (
        <section
          style={{
            padding: 16,
            border: "1px dashed var(--border)",
            borderRadius: 8,
            color: "var(--muted)",
            background: "var(--bg)",
          }}
        >
          <p style={{ marginTop: 0 }}>
            {t.routingQualityPage.emptyTitle.replace(
              "{n}",
              String(sinceDays)
            )}
          </p>
          <p style={{ marginBottom: 0 }}>
            {t.routingQualityPage.emptyBodyPrefix}
            <code>body.model</code>
            {t.routingQualityPage.emptyBodyMid}
            <code>baseline routing:</code>
            {t.routingQualityPage.emptyBodySuffix}
          </p>
        </section>
      )}

      {data.rewrites.length > 0 && (
        <>
          <section
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
              marginTop: 16,
              marginBottom: 16,
            }}
          >
            <div
              style={{
                padding: 12,
                border: "1px solid var(--border)",
                borderRadius: 8,
              }}
            >
              <div style={{ color: "var(--muted)", fontSize: 12 }}>
                {t.routingQualityPage.statTotalRewrites}
              </div>
              <div style={{ fontSize: 22, fontWeight: 600 }}>
                {fmtNum(totalRewrites)}
              </div>
            </div>
            <div
              style={{
                padding: 12,
                border: "1px solid var(--border)",
                borderRadius: 8,
              }}
            >
              <div style={{ color: "var(--muted)", fontSize: 12 }}>
                {t.routingQualityPage.statOverallSuccess}
              </div>
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 600,
                  color: colorForSuccess(overallRewriteRate),
                }}
              >
                {fmtPct(overallRewriteRate)}
              </div>
            </div>
            <div
              style={{
                padding: 12,
                border: "1px solid var(--border)",
                borderRadius: 8,
              }}
            >
              <div style={{ color: "var(--muted)", fontSize: 12 }}>
                {t.routingQualityPage.statFlaggedPairs}
              </div>
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 600,
                  color:
                    flagged.length > 0
                      ? "var(--danger, #b91c1c)"
                      : "var(--ok, #15803d)",
                }}
              >
                {fmtNum(flagged.length)}
              </div>
              <div style={{ color: "var(--muted)", fontSize: 11 }}>
                {t.routingQualityPage.statFlaggedNote}
              </div>
            </div>
          </section>

          <h2 style={{ marginTop: 24 }}>{t.routingQualityPage.sectionRewrites}</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.routingQualityPage.rewritesAsked}</th>
                <th>{t.routingQualityPage.rewritesLanded}</th>
                <th style={{ textAlign: "right" }}>{t.routingQualityPage.rewritesCalls}</th>
                <th style={{ textAlign: "right" }}>{t.routingQualityPage.rewritesSuccess}</th>
                <th style={{ textAlign: "right" }}>{t.routingQualityPage.rewritesVsNative}</th>
                <th style={{ textAlign: "right" }}>{t.routingQualityPage.rewritesErrors}</th>
                <th style={{ textAlign: "right" }}>{t.routingQualityPage.rewritesLoopQuota}</th>
                <th style={{ textAlign: "right" }}>{t.routingQualityPage.rewritesAvgLatency}</th>
                <th style={{ textAlign: "right" }}>{t.routingQualityPage.rewritesTotalSpend}</th>
              </tr>
            </thead>
            <tbody>
              {data.rewrites.map((r) => (
                <tr key={`${r.asked}::${r.landed}`}>
                  <td>
                    <code>{r.asked}</code>
                  </td>
                  <td>
                    <code>{r.landed}</code>
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {fmtNum(r.total)}
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      color: colorForSuccess(r.success_rate_pct),
                      fontWeight: 500,
                    }}
                  >
                    {fmtPct(r.success_rate_pct)}
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      color: colorForDelta(r.success_rate_delta_pct),
                      fontWeight: 500,
                    }}
                    title={
                      r.baseline_success_rate_pct == null
                        ? "No native data for this landing model in the same window"
                        : `native ${r.landed}: ${fmtPct(
                            r.baseline_success_rate_pct
                          )} on ${fmtNum(r.baseline_total)} calls`
                    }
                  >
                    {fmtDelta(r.success_rate_delta_pct)}
                    {r.baseline_total > 0 && (
                      <span
                        style={{ color: "var(--muted)", fontSize: 11 }}
                      >
                        {" "}
                        (n={fmtNum(r.baseline_total)})
                      </span>
                    )}
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      color:
                        r.upstream_errors > 0 ? "var(--danger)" : undefined,
                    }}
                  >
                    {fmtNum(r.upstream_errors)}
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    <span
                      title="loop_detected blocks"
                      style={{
                        color:
                          r.loop_blocked > 0 ? "var(--danger)" : undefined,
                      }}
                    >
                      {fmtNum(r.loop_blocked)}
                    </span>{" "}
                    /{" "}
                    <span
                      title="budget_exceeded + plan_limit_exceeded blocks"
                      style={{
                        color:
                          r.quota_blocked > 0 ? "var(--warning)" : undefined,
                      }}
                    >
                      {fmtNum(r.quota_blocked)}
                    </span>
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {fmtLatency(r.avg_latency_ms)}
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {fmtUsd(r.total_cost_micro_cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {flagged.length > 0 && (
            <section
              style={{
                marginTop: 24,
                padding: 12,
                border: "1px solid var(--danger)",
                borderRadius: 8,
                background: "var(--bg)",
              }}
            >
              <h3 style={{ marginTop: 0 }}>
                Flagged: rewrites that perform worse than baseline
              </h3>
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {flagged.map((r) => (
                  <li
                    key={`flag-${r.asked}::${r.landed}`}
                    style={{ marginBottom: 6 }}
                  >
                    <code>
                      {r.asked} → {r.landed}
                    </code>{" "}
                    succeeds at <strong>{fmtPct(r.success_rate_pct)}</strong>{" "}
                    over {fmtNum(r.total)} calls — that&apos;s{" "}
                    <strong style={{ color: "var(--danger)" }}>
                      {fmtDelta(r.success_rate_delta_pct)}
                    </strong>{" "}
                    vs the {fmtNum(r.baseline_total)} native calls to{" "}
                    <code>{r.landed}</code> at{" "}
                    {fmtPct(r.baseline_success_rate_pct)}.
                  </li>
                ))}
              </ul>
              <p
                style={{
                  marginBottom: 0,
                  marginTop: 8,
                  color: "var(--muted)",
                  fontSize: 13,
                }}
              >
                Likely fixes: tighten <code>TOKENSMART_BASELINE_POLICY_EPS</code>,
                disable the routing rule for the <code>asked</code>{" "}
                model, or upgrade the landing model. The flagged set is
                conservative on purpose (≥ 20 calls, ≥ 5pp drop) — small
                samples can fluctuate.
              </p>
            </section>
          )}
        </>
      )}

      {data.by_bucket.length > 0 && (
        <>
          <h2 style={{ marginTop: 24 }}>{t.routingQualityPage.sectionPerBucket}</h2>
          <p style={{ color: "var(--muted)", marginTop: 0 }}>
            {t.routingQualityPage.perBucketBody}
          </p>
          <table className="data-table" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>{t.routingQualityPage.bucketCol}</th>
                <th style={{ textAlign: "right" }}>{t.routingQualityPage.bucketCalls}</th>
                <th style={{ textAlign: "right" }}>{t.routingQualityPage.bucketSuccess}</th>
                <th style={{ textAlign: "right" }}>{t.routingQualityPage.bucketErrors}</th>
                <th style={{ textAlign: "right" }}>{t.routingQualityPage.bucketLoopQuota}</th>
                <th style={{ textAlign: "right" }}>{t.routingQualityPage.bucketAvgSavedCall}</th>
                <th style={{ textAlign: "right" }}>{t.routingQualityPage.bucketTotalSpend}</th>
              </tr>
            </thead>
            <tbody>
              {data.by_bucket.map((b: RoutingBucketStats) => (
                <tr key={`bucket-${b.bucket}`}>
                  <td>
                    <code>{b.bucket}</code>
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {fmtNum(b.total)}
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      color: colorForSuccess(b.success_rate_pct),
                      fontWeight: 500,
                    }}
                  >
                    {fmtPct(b.success_rate_pct)}
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      color:
                        b.upstream_errors > 0 ? "var(--danger)" : undefined,
                    }}
                  >
                    {fmtNum(b.upstream_errors)}
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    <span
                      title="loop_detected blocks"
                      style={{
                        color:
                          b.loop_blocked > 0 ? "var(--danger)" : undefined,
                      }}
                    >
                      {fmtNum(b.loop_blocked)}
                    </span>{" "}
                    /{" "}
                    <span
                      title="budget_exceeded + plan_limit_exceeded blocks"
                      style={{
                        color:
                          b.quota_blocked > 0 ? "var(--warning)" : undefined,
                      }}
                    >
                      {fmtNum(b.quota_blocked)}
                    </span>
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      color:
                        b.avg_routing_saving_micro_cents > 0
                          ? "var(--ok, #15803d)"
                          : undefined,
                    }}
                  >
                    {fmtUsd(b.avg_routing_saving_micro_cents)}
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {fmtUsd(b.total_cost_micro_cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {data.natives.length > 0 && (
        <>
          <h2 style={{ marginTop: 24 }}>{t.routingQualityPage.sectionNative}</h2>
          <p style={{ color: "var(--muted)", marginTop: 0 }}>
            {t.routingQualityPage.nativeBody}
          </p>
          <table className="data-table" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>{t.routingQualityPage.nativeCol}</th>
                <th style={{ textAlign: "right" }}>{t.routingQualityPage.nativeCalls}</th>
                <th style={{ textAlign: "right" }}>{t.routingQualityPage.nativeSuccess}</th>
                <th style={{ textAlign: "right" }}>{t.routingQualityPage.nativeErrors}</th>
                <th style={{ textAlign: "right" }}>{t.routingQualityPage.nativeAvgLatency}</th>
                <th style={{ textAlign: "right" }}>{t.routingQualityPage.nativeTotalSpend}</th>
              </tr>
            </thead>
            <tbody>
              {data.natives.map((n) => (
                <tr key={`native-${n.landed}`}>
                  <td>
                    <code>{n.landed}</code>
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {fmtNum(n.total)}
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      color: colorForSuccess(n.success_rate_pct),
                      fontWeight: 500,
                    }}
                  >
                    {fmtPct(n.success_rate_pct)}
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      color:
                        n.upstream_errors > 0 ? "var(--danger)" : undefined,
                    }}
                  >
                    {fmtNum(n.upstream_errors)}
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {fmtLatency(n.avg_latency_ms)}
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {fmtUsd(n.total_cost_micro_cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

    </main>
  );
}
