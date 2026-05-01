/**
 * v0.6.7 — selective request_body storage.
 *
 * Pre-v0.6.7, every successful request stored the full JSON wire body in
 * `requests.request_body`. That's a debugging gold mine (we used it to
 * reproduce v0.6.6's multi-modal-array bug) but it's ~10× the row size of
 * the typical traffic AND it pins full prompts + system messages in
 * Postgres forever — a real privacy concern for shared / regulated
 * workloads. The new env knob lets operators trade debug visibility for
 * row size + privacy:
 *
 *   TOKENSMART_STORE_FULL_REQUEST_BODY=sample (default) — store full body
 *     on EVERY non-success row + ~1% of success rows; the rest get a
 *     compact summary stub. Default catches all the failure cases an
 *     operator wants to debug while keeping steady-state storage tight.
 *   TOKENSMART_STORE_FULL_REQUEST_BODY=never — never store the full body;
 *     the summary stub goes on every row. For high-volume privacy-
 *     sensitive deployments where prompts must NOT live in the ledger.
 *   TOKENSMART_STORE_FULL_REQUEST_BODY=always — store full body on every
 *     row (the legacy v0.6.6 behavior). For debug-heavy installs where
 *     storage cost isn't a concern.
 *
 * The summary stub is a small object — `{truncated:true, model,
 * message_count, tools_count, reason}` — that preserves enough shape to
 * spot traffic patterns ("model X + 50 messages + 12 tools") without
 * keeping the content. The dashboard's request-detail page renders it
 * with a clear "body sampled out" badge so operators know to look at a
 * sibling row (or grep logs) for the actual content.
 */

export type RequestBodyStorageMode = "sample" | "never" | "always";

export function getRequestBodyStorageMode(): RequestBodyStorageMode {
  const raw = (process.env.TOKENSMART_STORE_FULL_REQUEST_BODY ?? "sample")
    .toLowerCase()
    .trim();
  if (raw === "never" || raw === "always" || raw === "sample") return raw;
  // Unknown value → fall back to the default. Operators typo their env
  // vars; the safe default beats a hard fail at the request hot path.
  return "sample";
}

/**
 * Sample rate for the "sample" mode. 1% of successful requests get
 * their full body persisted; everything else gets the summary stub.
 * Picked so a busy production install (~100 req/s) keeps a few full
 * bodies per minute for debugging while shedding 99% of the storage
 * + privacy footprint.
 */
export const REQUEST_BODY_SAMPLE_RATE = 0.01;

export interface TruncatedRequestBody {
  truncated: true;
  model: string;
  message_count: number;
  tools_count: number;
  reason: "sampled_out" | "storage_disabled";
}

interface ChatBodyShape {
  model?: unknown;
  messages?: unknown;
  tools?: unknown;
}

/**
 * Project a wire body down to the small structural-shape stub the
 * truncated path stores. The shape mirrors `OpenAIChatRequest` enough
 * for the dashboard to render meaningful "skipped body" diagnostics
 * without keeping any prompt / system-message content.
 *
 * Public so unit tests can pin the exact shape without going through
 * the full chooseRequestBodyForStorage() flow.
 */
export function summarizeRequestBody(
  body: unknown,
  mode: RequestBodyStorageMode = getRequestBodyStorageMode()
): TruncatedRequestBody {
  const b = (body ?? {}) as ChatBodyShape;
  const messages = Array.isArray(b.messages) ? b.messages.length : 0;
  const tools = Array.isArray(b.tools) ? b.tools.length : 0;
  return {
    truncated: true,
    model: typeof b.model === "string" ? b.model : "",
    message_count: messages,
    tools_count: tools,
    reason: mode === "never" ? "storage_disabled" : "sampled_out",
  };
}

/**
 * Decide what to persist for a row's `request_body` given the row's
 * final status. Always keeps the full body for non-success rows
 * (failures + budget/plan/loop blocks) when mode is "sample" —
 * debugging value far outweighs the per-row cost on the rare-event
 * side. The "never" mode honors privacy posture even for failures.
 *
 * Status is intentionally a wide string (matches the `RequestStatus`
 * union) so call sites pass their literal without a cast.
 */
export function chooseRequestBodyForStorage(
  body: unknown,
  status: string,
  modeOverride?: RequestBodyStorageMode
): unknown {
  if (body == null) return body;
  const mode = modeOverride ?? getRequestBodyStorageMode();
  if (mode === "always") return body;
  if (mode === "sample" && status !== "success") return body;
  if (mode === "sample" && Math.random() < REQUEST_BODY_SAMPLE_RATE) {
    return body;
  }
  return summarizeRequestBody(body, mode);
}
