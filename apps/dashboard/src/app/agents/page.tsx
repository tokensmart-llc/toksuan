/**
 * Agent sessions overview.
 *
 * The "spend by tag" card on the dashboard home tells you which freeform
 * tag values (`feature=summarize`, `team=growth`) are burning money. It
 * does NOT tell you "this OpenClaw session ran 47 tool turns in a row
 * and spent $4.20 — was something looping or just busy?". This page
 * does.
 *
 * Surface contract:
 *   - A row per (agent, session) pair from the requests ledger.
 *   - Sorted by recency by default; the operator can scroll to the top
 *     and see what's running RIGHT NOW.
 *   - Declared/observed tool counts and error / loop / budget block counts surface
 *     so a single glance answers "is the agent making progress, or is
 *     it spinning?"
 *   - Click any row → the per-turn drilldown.
 *
 * Population is purely data-driven: a project that sends no `x-ts-agent`
 * / `x-ts-session` headers shows an empty state with a one-line
 * pointer at the integration docs. We don't auto-bucket untagged
 * traffic — that would create false agent identities.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { getScope, getSession, isAuthEnabled } from "@/lib/auth";
import { getAgentSessions, type AgentSessionSummary } from "@/lib/db";
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

function fmtLatency(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtRelative(
  d: Date,
  t: {
    relSecondsAgo: string;
    relMinutesAgo: string;
    relHoursAgo: string;
    relDaysAgo: string;
  }
): string {
  const ms = Date.now() - new Date(d).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return t.relSecondsAgo.replace("{n}", String(sec));
  const min = Math.floor(sec / 60);
  if (min < 60) return t.relMinutesAgo.replace("{n}", String(min));
  const hr = Math.floor(min / 60);
  if (hr < 24) return t.relHoursAgo.replace("{n}", String(hr));
  const day = Math.floor(hr / 24);
  return t.relDaysAgo.replace("{n}", String(day));
}

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  if (isAuthEnabled()) {
    const session = await getSession();
    if (!session) redirect("/login");
  }
  const scope = await getScope();
  const sp = await searchParams;
  const sinceDays = (() => {
    const n = Number(sp.days);
    return Number.isFinite(n) && n > 0 && n <= 90 ? Math.floor(n) : 7;
  })();

  const sessions: AgentSessionSummary[] = await getAgentSessions(
    sinceDays,
    100,
    scope
  ).catch((err) => {
    // Postgres-only feature (uses jsonb operators). Don't crash the
    // page on a SQLite-mode install — show an empty state instead.
    console.error("[dashboard] getAgentSessions failed:", err);
    return [];
  });

  const totalSpend = sessions.reduce(
    (acc, s) => acc + s.total_cost_micro_cents,
    0
  );

  // Captured at the start of this server render so <AutoRefresh> can show a
  // stable "updated Xs ago" label. See components/AutoRefresh.tsx.
  const renderedAt = Date.now();
  const { t } = await getDictionary();
  const tAgents = t.agents;

  return (
    <main>
      <Link href="/dashboard" className="back-link">
        {tAgents.backDashboard}
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
        <h1 style={{ margin: 0 }}>{tAgents.title}</h1>
        <AutoRefresh renderedAt={renderedAt} t={t.common.autoRefresh} />
      </div>
      <p style={{ color: "var(--muted)", marginTop: 0 }}>
        {/* Pick the right day-word form so EN reads naturally
         *  ("1 day" vs "7 days") while CN ("天") stays invariant. */}
        {t.agentsPage.paragraph
          .replace("{days}", String(sinceDays))
          .replace(
            "{dayWord}",
            sinceDays === 1
              ? t.agentsPage.dayWordSingular
              : t.agentsPage.dayWordPlural
          )}
      </p>

      <section style={{ margin: "8px 0 16px", color: "var(--muted)", fontSize: 13 }}>
        {t.agentsPage.windowLabel}{" "}
        {[
          { d: 1, label: t.agentsPage.window24h },
          { d: 7, label: t.agentsPage.window7d },
          { d: 30, label: t.agentsPage.window30d },
        ].map(({ d, label }) => (
          <Link
            key={d}
            href={`/agents?days=${d}`}
            className={d === sinceDays ? "pill pill-accent" : "pill pill-neutral"}
            style={{ marginRight: 8, textDecoration: "none" }}
          >
            {label}
          </Link>
        ))}
      </section>

      {sessions.length === 0 ? (
        <section
          style={{
            padding: 16,
            border: "1px dashed var(--border)",
            borderRadius: 8,
            color: "var(--muted)",
            background: "var(--bg)",
          }}
        >
          <p style={{ marginTop: 0 }}>{tAgents.emptyTitle}</p>
          <p style={{ marginBottom: 0 }}>{tAgents.emptyBody}</p>
        </section>
      ) : (
        <>
          <p style={{ color: "var(--muted)", marginTop: 12 }}>
            {t.agentsPage.countLine
              .replace("{n}", fmtNum(sessions.length))
              .replace("{spend}", fmtUsd(totalSpend, 2))}
          </p>
          <table className="data-table" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>{t.agentsPage.colAgent}</th>
                <th>{t.agentsPage.colSession}</th>
                <th style={{ textAlign: "right" }}>{t.agentsPage.colTurns}</th>
                <th style={{ textAlign: "right" }}>{t.agentsPage.colSpend}</th>
                <th style={{ textAlign: "right" }}>{t.agentsPage.colTokensInOut}</th>
                <th style={{ textAlign: "right" }}>{t.agentsPage.colP50P95}</th>
                <th style={{ textAlign: "right" }}>{t.agentsPage.colCounters}</th>
                <th style={{ textAlign: "right" }}>{t.agentsPage.colLastSeen}</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={`${s.agent}::${s.session}`}>
                  <td>
                    <code>{s.agent}</code>
                  </td>
                  <td>
                    <Link
                      href={`/agents/${encodeURIComponent(
                        s.agent
                      )}/${encodeURIComponent(s.session)}`}
                    >
                      <code>{s.session}</code>
                    </Link>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {fmtNum(s.turn_count)}
                    <span
                      style={{ color: "var(--muted)", fontSize: 11 }}
                    >
                      {" "}
                      ({fmtNum(s.request_count)} {t.agentsPage.cellReqSuffix})
                    </span>
                  </td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {fmtUsd(s.total_cost_micro_cents)}
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {fmtNum(s.total_input_tokens)} /{" "}
                    {fmtNum(s.total_output_tokens)}
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {fmtLatency(s.p50_latency_ms)} /{" "}
                    {fmtLatency(s.p95_latency_ms)}
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    <span title={t.agentsPage.titleToolCounts}>
                      {fmtNum(s.tool_capable_count)}
                      {" / "}
                      {fmtNum(s.tool_call_observed_count)}
                    </span>{" "}
                    /{" "}
                    <span
                      title={t.agentsPage.titleErrorCounts}
                      style={{
                        color: s.error_count > 0 ? "var(--danger)" : undefined,
                      }}
                    >
                      {fmtNum(s.error_count)}
                    </span>{" "}
                    /{" "}
                    <span
                      title={t.agentsPage.titleLoopBlocked}
                      style={{
                        color:
                          s.loop_blocked_count > 0
                            ? "var(--danger)"
                            : undefined,
                      }}
                    >
                      {fmtNum(s.loop_blocked_count)}
                    </span>{" "}
                    /{" "}
                    <span
                      title={t.agentsPage.titleBudgetBlocked}
                      style={{
                        color:
                          s.budget_blocked_count > 0
                            ? "var(--warning)"
                            : undefined,
                      }}
                    >
                      {fmtNum(s.budget_blocked_count)}
                    </span>{" "}
                    /{" "}
                    <span
                      title={t.agentsPage.titlePlanBlocked}
                      style={{
                        color:
                          s.plan_blocked_count > 0
                            ? "var(--warning)"
                            : undefined,
                      }}
                    >
                      {fmtNum(s.plan_blocked_count)}
                    </span>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <span
                      title={new Date(s.last_seen_at).toISOString()}
                      style={{ color: "var(--muted)" }}
                    >
                      {fmtRelative(s.last_seen_at, t.agentsPage)}
                    </span>
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
