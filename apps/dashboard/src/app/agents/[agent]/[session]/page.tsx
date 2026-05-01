/**
 * Per-session drilldown.
 *
 * Lands here from /agents → click on a session row. Renders one row per
 * turn (or per request when the caller didn't tag turns), with the
 * fields an operator actually uses to debug a misbehaving agent: model
 * picked, status, token cost, latency, whether it declared tools or
 * produced a tool call, the upstream error string when present, and a deep-link to the
 * full request payload at /requests/[id].
 *
 * Why a separate page (not an inline expansion on /agents): the request
 * detail link is the killer feature — operators almost always want
 * the full prompt/response of a specific turn, and a separate page
 * means you can hard-link an OpenClaw bug report to a session's URL
 * and the recipient lands on the exact view.
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getScope, getSession, isAuthEnabled } from "@/lib/auth";
import { getAgentSessionTurns, type AgentSessionTurn } from "@/lib/db";
import { AutoRefresh } from "@/components/AutoRefresh";
import { getDictionary } from "@/lib/i18n.server";
import type { Dictionary } from "@/i18n/types";

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
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtTime(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(d));
}

function statusBadge(
  status: string,
  t: Dictionary["agentSession"]
): { color: string; label: string } {
  switch (status) {
    case "success":
      return { color: "var(--ok, #15803d)", label: t.statusOk };
    case "loop_detected":
      return { color: "var(--danger, #b91c1c)", label: t.statusLoop };
    case "budget_exceeded":
      return { color: "var(--warning, #b45309)", label: t.statusBudget };
    case "plan_limit_exceeded":
      return { color: "var(--warning, #b45309)", label: t.statusPlan };
    case "error":
      return { color: "var(--danger, #b91c1c)", label: t.statusError };
    default:
      return { color: "var(--muted)", label: status };
  }
}

function shortToolNames(names: string | null): string | null {
  if (!names) return null;
  return names.split(",").slice(0, 3).join(", ");
}

export default async function AgentSessionPage({
  params,
}: {
  params: Promise<{ agent: string; session: string }>;
}) {
  if (isAuthEnabled()) {
    const session = await getSession();
    if (!session) redirect("/login");
  }
  const scope = await getScope();
  const { agent: agentRaw, session: sessionRaw } = await params;
  const agent = decodeURIComponent(agentRaw);
  const sessionId = decodeURIComponent(sessionRaw);

  const turns: AgentSessionTurn[] = await getAgentSessionTurns(
    agent,
    sessionId,
    500,
    scope
  ).catch((err) => {
    console.error("[dashboard] getAgentSessionTurns failed:", err);
    return [];
  });

  if (turns.length === 0) {
    notFound();
  }

  const totalSpend = turns.reduce((acc, t) => acc + t.cost_micro_cents, 0);
  const totalIn = turns.reduce((acc, t) => acc + t.input_tokens, 0);
  const totalOut = turns.reduce((acc, t) => acc + t.output_tokens, 0);
  const okCount = turns.filter((t) => t.status === "success").length;
  const errCount = turns.length - okCount;
  const toolCount = turns.filter((t) => t.has_tools).length;
  const observedToolCallCount = turns.filter((t) => t.tool_calls_observed).length;
  const start = turns[0]!.created_at;
  const end = turns[turns.length - 1]!.created_at;
  const elapsedMs =
    new Date(end).getTime() - new Date(start).getTime();

  // Captured at the start of this server render so <AutoRefresh> can show a
  // stable "updated Xs ago" label. See components/AutoRefresh.tsx.
  const renderedAt = Date.now();
  const { t } = await getDictionary();
  const tSession = t.agentSession;

  // Splice the runtime numbers into the localised summary template. Doing
  // this in one substitution pass keeps the en/zh sentences readable in
  // the dictionary file without scattering React fragments.
  const reqWord =
    turns.length === 1 ? tSession.requestsSingular : tSession.requestsPlural;
  const summaryParts = tSession.summary
    .replace("{requests}", "__SPENT_PRE__")
    .replace("{spent}", "__SPENT_VAL__")
    .replace("__SPENT_PRE__", fmtNum(turns.length))
    .replace("{reqWord}", reqWord)
    .replace("{ok}", fmtNum(okCount))
    .replace("{err}", fmtNum(errCount))
    .replace("{tools}", fmtNum(toolCount))
    .replace("{observed}", fmtNum(observedToolCallCount))
    .replace("{tokensIn}", fmtNum(totalIn))
    .replace("{tokensOut}", fmtNum(totalOut))
    .replace("{elapsed}", fmtLatency(elapsedMs))
    .replace("{when}", fmtTime(start))
    .split("__SPENT_VAL__");

  return (
    <main>
      <Link href="/agents" className="back-link">
        {t.agents.sessionBackAll}
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
        <h1 style={{ margin: 0 }}>
          <code>{agent}</code> · <code>{sessionId}</code>
        </h1>
        <AutoRefresh renderedAt={renderedAt} t={t.common.autoRefresh} />
      </div>
      <p style={{ color: "var(--muted)", marginTop: 0 }}>
        {summaryParts[0]}
        <strong>{fmtUsd(totalSpend, 2)}</strong>
        {summaryParts[1] ?? ""}
      </p>

      <table className="data-table" style={{ marginTop: 16 }}>
        <thead>
          <tr>
            <th>{tSession.colIndex}</th>
            <th>{tSession.colTurn}</th>
            <th>{tSession.colModel}</th>
            <th style={{ textAlign: "right" }}>{tSession.colStatus}</th>
            <th style={{ textAlign: "right" }}>{tSession.colInOut}</th>
            <th style={{ textAlign: "right" }}>{tSession.colCost}</th>
            <th style={{ textAlign: "right" }}>{tSession.colLatency}</th>
            <th>{tSession.colTools}</th>
            <th>{tSession.colWhen}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {turns.map((t, idx) => {
            const badge = statusBadge(t.status, tSession);
            return (
              <tr key={t.request_id}>
                <td style={{ color: "var(--muted)" }}>
                  {idx + 1}
                </td>
                <td>
                  {t.turn ? (
                    <code>{t.turn}</code>
                  ) : (
                    <span style={{ color: "var(--muted)" }}>—</span>
                  )}
                </td>
                <td>
                  <code>{t.model}</code>
                </td>
                <td style={{ textAlign: "right" }}>
                  <span
                    style={{
                      color: badge.color,
                      fontWeight: 500,
                    }}
                  >
                    {badge.label}
                  </span>
                </td>
                <td
                  style={{
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {fmtNum(t.input_tokens)}
                  {t.cached_input_tokens > 0 ? (
                    <span
                      style={{ color: "var(--muted)", fontSize: 11 }}
                      title={tSession.titleCachedTokens}
                    >
                      {" "}
                      ({fmtNum(t.cached_input_tokens)}
                      {tSession.cellCachedSuffix})
                    </span>
                  ) : null}{" "}
                  / {fmtNum(t.output_tokens)}
                </td>
                <td
                  style={{
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {fmtUsd(t.cost_micro_cents)}
                </td>
                <td
                  style={{
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {fmtLatency(t.latency_ms)}
                </td>
                <td>
                  {t.tool_calls_observed ? (
                    <span
                      title={
                        t.tool_call_names
                          ? tSession.titleObservedTools.replace(
                              "{names}",
                              t.tool_call_names
                            )
                          : tSession.titleObservedFinish
                      }
                    >
                      {tSession.cellToolCalled}
                      {shortToolNames(t.tool_call_names) ? (
                        <span style={{ color: "var(--muted)" }}>
                          {" "}
                          ({shortToolNames(t.tool_call_names)})
                        </span>
                      ) : null}
                    </span>
                  ) : t.has_tools ? (
                    <span
                      title={
                        t.declared_tool_names
                          ? tSession.titleDeclaredTools.replace(
                              "{names}",
                              t.declared_tool_names
                            )
                          : tSession.titleDeclaredArray
                      }
                    >
                      {tSession.cellToolDeclared}
                      {shortToolNames(t.declared_tool_names) ? (
                        <span style={{ color: "var(--muted)" }}>
                          {" "}
                          ({shortToolNames(t.declared_tool_names)})
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    <span style={{ color: "var(--muted)" }}>—</span>
                  )}
                </td>
                <td
                  style={{ color: "var(--muted)", fontSize: 12 }}
                  title={new Date(t.created_at).toISOString()}
                >
                  {fmtTime(t.created_at)}
                </td>
                <td>
                  <Link href={`/requests/${t.request_id}`}>
                    {tSession.viewLink}
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {errCount > 0 && (
        <section
          style={{
            marginTop: 24,
            padding: 12,
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg)",
          }}
        >
          <h3 style={{ marginTop: 0 }}>{tSession.nonSuccessTitle}</h3>
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {turns
              .filter((t) => t.status !== "success")
              .slice(-5)
              .reverse()
              .map((t) => (
                <li key={`err-${t.request_id}`}>
                  <code>{t.status}</code>
                  {t.error ? <>: {t.error}</> : null}{" "}
                  <Link
                    href={`/requests/${t.request_id}`}
                    style={{ color: "var(--muted)", fontSize: 12 }}
                  >
                    {tSession.viewLink}
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      )}
    </main>
  );
}
