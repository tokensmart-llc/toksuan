import Link from "next/link";
import { notFound } from "next/navigation";
import { getScope } from "@/lib/auth";
import { getDictionary } from "@/lib/i18n.server";
import {
  getCompressedBlobsByRequestId,
  getFingerprintNeighbors,
  getRequestById,
  type CompressedBlobDetail,
  type FingerprintNeighbor,
  type RequestDetail,
} from "@/lib/db";
import { AutoRefresh } from "@/components/AutoRefresh";
import { LoopTimeline, type LoopTick } from "@/components/LoopTimeline";
import { lockRoutingFromRequestAction } from "@/app/projects/actions";
import { replayRequestAction } from "./actions";

const REPLAY_MODEL_SUGGESTIONS = [
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1-mini",
  "claude-3-5-sonnet-latest",
  "claude-3-5-haiku-latest",
  "deepseek-chat",
  "qwen-plus",
];

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MICRO_PER_USD = 100_000;

function fmtMicroAsUsd(microCents: number, digits = 4): string {
  return `$${(microCents / MICRO_PER_USD).toFixed(digits)}`;
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
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(d));
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

type Message = { role: string; content: unknown };

function extractMessages(requestBody: unknown): Message[] {
  if (
    requestBody &&
    typeof requestBody === "object" &&
    "messages" in requestBody
  ) {
    const m = (requestBody as { messages?: unknown }).messages;
    if (Array.isArray(m)) return m as Message[];
  }
  return [];
}

function extractAssistantText(responseBody: unknown): string | null {
  if (
    responseBody &&
    typeof responseBody === "object" &&
    "choices" in responseBody
  ) {
    const choices = (responseBody as { choices?: unknown }).choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const msg = (choices[0] as { message?: { content?: unknown } } | undefined)
        ?.message;
      if (msg && typeof msg.content === "string") return msg.content;
    }
  }
  return null;
}

function renderMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let detail: RequestDetail | null = null;
  let neighbors: FingerprintNeighbor[] = [];
  let compressedBlobs: CompressedBlobDetail[] = [];
  let dbError: string | null = null;
  try {
    const scope = await getScope();
    detail = await getRequestById(id, scope);
    if (detail) {
      compressedBlobs = await getCompressedBlobsByRequestId(id, scope);
    }
    if (detail?.fingerprint) {
      neighbors = await getFingerprintNeighbors(
        detail.fingerprint,
        24,
        500,
        scope
      );
    }
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  const { t } = await getDictionary();
  const tReq = t.requests;
  if (dbError) {
    return (
      <main>
        <Link href="/dashboard" className="back-link">
          {tReq.backDashboard}
        </Link>
        <h1>{tReq.title}</h1>
        <div className="card card-danger">
          <strong>{tReq.dbErrTitle}</strong>
          <br />
          <span style={{ color: "var(--text-muted)" }}>{dbError}</span>
        </div>
      </main>
    );
  }

  if (!detail) notFound();

  const messages = extractMessages(detail.request_body);
  const assistantText = extractAssistantText(detail.response_body);
  const routed =
    detail.original_model != null && detail.original_model !== detail.model;

  // Captured at the start of this server render so <AutoRefresh> can show a
  // stable "updated Xs ago" label. See components/AutoRefresh.tsx.
  const renderedAt = Date.now();

  // The replay card talks to the gateway's /internal/replay endpoint via a
  // shared secret. If the operator hasn't wired it, the click path 503s with
  // a clear toast — but the empty-state below shows the setup inline so
  // first-time users aren't debugging through redirect-toasts.
  const replayConfigured =
    process.env.TOKENSMART_INTERNAL_REPLAY_ENABLED === "1" &&
    Boolean(process.env.TOKENSMART_INTERNAL_TOKEN);

  return (
    <main>
      <Link href="/dashboard" className="back-link">
        {tReq.backDashboard}
      </Link>

      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 14,
          marginBottom: 4,
          flexWrap: "wrap",
        }}
      >
        <code
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 20,
            fontWeight: 500,
          }}
        >
          {detail.model}
        </code>
        <span className={`status-${detail.status}`}>{detail.status}</span>
        <span className="pill pill-neutral">{detail.provider}</span>
        <AutoRefresh renderedAt={renderedAt} t={t.common.autoRefresh} />
      </div>
      <p className="tagline" style={{ marginBottom: 24 }}>
        {fmtTime(detail.created_at)}
      </p>

      {/* Routed callout — when the gateway swapped models on this request,
          show the savings + offer a one-click "lock this routing as a
          permanent rule for this project" action. */}
      {routed && (
        <div className="card card-accent routed-callout">
          <div className="routed-callout-head">
            <h3 style={{ color: "var(--accent)", margin: 0 }}>{tReq.routedTitle}</h3>
            {detail.routing_saving_micro_cents > 0 && (
              <span className="routed-saving-pill">
                {tReq.routedSavedPill.replace(
                  "{amount}",
                  `$${(detail.routing_saving_micro_cents / MICRO_PER_USD).toFixed(4)}`
                )}
              </span>
            )}
          </div>
          <div
            style={{
              fontSize: 13,
              color: "var(--text-secondary)",
              marginTop: 8,
            }}
          >
            {tReq.routedReplaceBody}{" "}
            <code className="code-inline">{detail.original_model}</code>
            <span style={{ color: "var(--accent)", padding: "0 8px" }}>→</span>
            <code className="code-inline">{detail.model}</code>
          </div>

          {detail.project_id && (() => {
            // Splice the model name into the lock-routing copy so the
            // emphasised <code> inside the sentence survives translation.
            const lockHeader = tReq.routedLockHeader.split("{model}");
            return (
              <form
                action={lockRoutingFromRequestAction}
                className="routed-lock-form"
              >
                <input
                  type="hidden"
                  name="project_id"
                  value={detail.project_id}
                />
                <input
                  type="hidden"
                  name="from_model"
                  value={detail.original_model ?? ""}
                />
                <input type="hidden" name="to_model" value={detail.model} />
                <input
                  type="hidden"
                  name="source_request_id"
                  value={detail.id}
                />
                <div className="routed-lock-copy">
                  {lockHeader[0]}
                  <code className="code-inline">{detail.original_model}</code>
                  {lockHeader[1] ?? ""}
                </div>
                <button type="submit" className="btn btn-primary btn-sm">
                  {tReq.routedLockButton}
                </button>
              </form>
            );
          })()}
        </div>
      )}

      {/* Stat grid */}
      <div className="stat-grid">
        <div className="stat">
          <div className="stat-label">{tReq.statCost}</div>
          <div className="stat-value">
            {fmtMicroAsUsd(detail.cost_micro_cents)}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">{tReq.statInputTokens}</div>
          <div className="stat-value">{fmtNum(detail.input_tokens)}</div>
          {detail.cached_input_tokens > 0 && (
            <div className="stat-value-sub">
              {fmtNum(detail.cached_input_tokens)}
              {tReq.statInputCachedSuffix}
            </div>
          )}
        </div>
        <div className="stat">
          <div className="stat-label">{tReq.statOutputTokens}</div>
          <div className="stat-value">{fmtNum(detail.output_tokens)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">{tReq.statLatency}</div>
          <div className="stat-value">{fmtLatency(detail.latency_ms)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">{tReq.statProjectKey}</div>
          <div
            className="stat-value"
            style={{ fontSize: 14, fontFamily: "var(--font-mono)" }}
          >
            {detail.project_name ?? "—"}
            <span style={{ color: "var(--text-muted)" }}> · </span>
            <span style={{ color: "var(--text-secondary)" }}>
              {detail.api_key_name ?? "—"}
            </span>
          </div>
        </div>
        {detail.fingerprint && (
          <div className="stat">
            <div className="stat-label">{tReq.statFingerprint}</div>
            <div
              className="stat-value"
              style={{ fontSize: 14, fontFamily: "var(--font-mono)" }}
            >
              {detail.fingerprint}
            </div>
          </div>
        )}
      </div>

      {/* Replay card — re-issue the SAME prompt against a (possibly different)
          model and write a new row to the requests ledger. Useful for the
          "is the cheap model actually working?" trust loop, and for
          retroactively comparing models on a known-interesting input.
          Hidden when there's no project (orphan rows from the seed DB).
          When the operator hasn't set TOKENSMART_INTERNAL_TOKEN, render
          the setup instructions inline instead of the form so users aren't
          debugging the feature through a post-click redirect toast. */}
      {detail.project_id && replayConfigured && (
        <div className="card">
          <div className="card-header">
            <h2>{tReq.replayTitle}</h2>
            <div className="card-header-spacer" />
            <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
              {tReq.replayHeaderHint}
            </span>
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--text-secondary)",
              marginBottom: 10,
              lineHeight: 1.55,
            }}
          >
            {tReq.replayIntroPrefix}
            <code className="code-inline">replay_of:{detail.id.slice(0, 8)}…</code>
            {tReq.replayIntroSuffix}
          </div>
          <form
            action={replayRequestAction}
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <input type="hidden" name="request_id" value={detail.id} />
            <input
              name="target_model"
              type="text"
              required
              defaultValue={detail.model}
              list="replay-model-suggestions"
              placeholder={tReq.replayModelPlaceholder}
              className="input"
              style={{ minWidth: 280, flex: "1 1 280px" }}
            />
            <datalist id="replay-model-suggestions">
              {REPLAY_MODEL_SUGGESTIONS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <button type="submit" className="btn btn-primary">
              {tReq.replayButton}
            </button>
          </form>
        </div>
      )}

      {detail.project_id && !replayConfigured && (
        <div className="card">
          <div className="card-header">
            <h2>{tReq.replayTitle}</h2>
            <div className="card-header-spacer" />
            <span className="pill pill-neutral" style={{ fontSize: 11 }}>
              {tReq.replaySetupPill}
            </span>
          </div>
          <div
            style={{
              fontSize: 13,
              color: "var(--text-secondary)",
              marginBottom: 12,
              lineHeight: 1.6,
            }}
          >
            {tReq.replaySetupBody}
          </div>
          <ol
            style={{
              fontSize: 13,
              color: "var(--text)",
              lineHeight: 1.7,
              margin: "0 0 12px 20px",
              padding: 0,
            }}
          >
            <li>
              {tReq.replaySetupStep1}
              <pre className="code-block" style={{ marginTop: 6 }}>
{`openssl rand -hex 32`}
              </pre>
            </li>
            <li>
              {tReq.replaySetupStep2Prefix}
              <strong>{tReq.replaySetupStep2Same}</strong>
              {tReq.replaySetupStep2Mid}
              <strong>{tReq.replaySetupStep2Both}</strong>
              {tReq.replaySetupStep2Suffix}
              <pre className="code-block" style={{ marginTop: 6 }}>
{`# apps/gateway/.env
TOKENSMART_INTERNAL_REPLAY_ENABLED=1
TOKENSMART_INTERNAL_TOKEN=<paste-here>

# apps/dashboard/.env.local
TOKENSMART_INTERNAL_REPLAY_ENABLED=1
TOKENSMART_INTERNAL_TOKEN=<paste-here>`}
              </pre>
            </li>
            <li>
              {tReq.replaySetupStep3Prefix}
              <code className="code-inline">bun run dev</code>
              {tReq.replaySetupStep3Suffix}
            </li>
          </ol>
          <div
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              lineHeight: 1.55,
            }}
          >
            {tReq.replaySetupFooter}
          </div>
        </div>
      )}

      {detail.fingerprint && neighbors.length >= 2 && (() => {
        const ticks: LoopTick[] = neighbors.map((n) => ({
          id: n.id,
          created_at: n.created_at,
          status: n.status,
          cost_micro_cents: n.cost_micro_cents,
          is_current: n.id === detail.id,
        }));
        const totalCost = neighbors.reduce(
          (acc, n) => acc + n.cost_micro_cents,
          0
        );
        const blocked = neighbors.filter(
          (n) =>
            n.status === "loop_detected" ||
            n.status === "budget_exceeded" ||
            n.status === "plan_limit_exceeded"
        ).length;
        const span =
          new Date(neighbors[neighbors.length - 1].created_at).getTime() -
          new Date(neighbors[0].created_at).getTime();
        const spanLabel =
          span < 60_000
            ? `${Math.round(span / 1000)}s`
            : span < 3_600_000
              ? `${Math.round(span / 60_000)}m`
              : `${(span / 3_600_000).toFixed(1)}h`;

        // Splice the fingerprint into the localised loop-timeline body
        // so the inline <code> survives translation.
        const tlBody = tReq.loopTimelineBody.split("{fingerprint}");
        return (
          <div className="card">
            <div className="card-header">
              <h2>{tReq.loopTimelineTitle}</h2>
              <div className="card-header-spacer" />
              <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
                {neighbors.length}
                {tReq.loopTimelineCallsSuffix} · {spanLabel}
                {tReq.loopTimelineSpanSuffix} · {fmtMicroAsUsd(totalCost)}
                {tReq.loopTimelineTotalSuffix}
                {blocked > 0 && (
                  <>
                    {" · "}
                    <span style={{ color: "var(--purple)" }}>
                      {blocked}
                      {tReq.loopTimelineBlockedSuffix}
                    </span>
                  </>
                )}
              </span>
            </div>
            <p
              style={{
                color: "var(--text-muted)",
                fontSize: 12,
                margin: "0 0 12px",
              }}
            >
              {tlBody[0]}
              <code className="code-inline">{detail.fingerprint}</code>
              {tlBody[1] ?? ""}
            </p>
            <LoopTimeline ticks={ticks} ariaLabelTpl={tReq.loopTimelineAriaTpl} />
          </div>
        );
      })()}

      {detail.error && (
        <div className="card card-danger">
          <h3 style={{ color: "var(--danger)" }}>{tReq.errorTitle}</h3>
          <pre className="code-block">{detail.error}</pre>
        </div>
      )}

      {/* Prompt messages */}
      <div className="card">
        <div className="card-header">
          <h2>{tReq.sectionPromptMessages}</h2>
          <div className="card-header-spacer" />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            {messages.length}
          </span>
        </div>
        {messages.length === 0 ? (
          <div className="empty">{tReq.emptyMessages}</div>
        ) : (
          <div style={{ display: "grid", gap: 14 }}>
            {messages.map((m, i) => (
              <div key={i} className="message">
                <div className="message-role">{m.role}</div>
                <pre className="code-block">
                  {renderMessageContent(m.content)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>

      {assistantText !== null && (
        <div className="card">
          <div className="card-header">
            <h2>{tReq.sectionAssistantText}</h2>
          </div>
          <pre className="code-block">{assistantText}</pre>
        </div>
      )}

      {compressedBlobs.length > 0 && (
        <details className="card details-card" open>
          <summary className="card-header details-summary">
            <h2>{tReq.contextCompressionTitle}</h2>
            <div className="card-header-spacer" />
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
              {compressedBlobs.length}
            </span>
            <span className="details-toggle" aria-hidden="true" />
          </summary>
          <div style={{ display: "grid", gap: 14 }}>
            <p className="tagline" style={{ margin: 0 }}>
              {tReq.contextCompressionBody}
            </p>
            {compressedBlobs.map((blob) => (
              <div key={`${blob.message_index}:${blob.hash}`} className="message">
                <div className="message-role">
                  message[{blob.message_index}] · {blob.strategy} ·{" "}
                  {tReq.contextCompressionSavedPrefix}
                  {fmtNum(blob.original_chars - blob.compressed_chars)}
                  {tReq.contextCompressionSavedSuffix}
                </div>
                <details>
                  <summary style={{ cursor: "pointer", color: "var(--text-secondary)" }}>
                    {tReq.contextCompressionOriginal}
                  </summary>
                  <pre className="code-block">{blob.original_content}</pre>
                </details>
                <details>
                  <summary style={{ cursor: "pointer", color: "var(--text-secondary)" }}>
                    {tReq.contextCompressionCompressed}
                  </summary>
                  <pre className="code-block">{blob.compressed_content}</pre>
                </details>
              </div>
            ))}
          </div>
        </details>
      )}

      <details className="card details-card">
        <summary className="card-header details-summary">
          <h2>{tReq.rawRequestBody}</h2>
          <div className="card-header-spacer" />
          <span className="details-toggle" aria-hidden="true" />
        </summary>
        <pre className="code-block">{prettyJson(detail.request_body)}</pre>
      </details>

      <details className="card details-card">
        <summary className="card-header details-summary">
          <h2>{tReq.rawResponseBody}</h2>
          <div className="card-header-spacer" />
          <span className="details-toggle" aria-hidden="true" />
        </summary>
        {detail.response_body ? (
          <pre className="code-block">{prettyJson(detail.response_body)}</pre>
        ) : (
          <div className="empty">{tReq.emptyResponseBody}</div>
        )}
      </details>
    </main>
  );
}
