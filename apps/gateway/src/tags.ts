/**
 * Per-request tag parsing for cost attribution.
 *
 * Customers send `x-ts-tag: feature=summarization,team=growth,user=u_42`
 * and we store an object `{ feature: "summarization", team: "growth",
 * user: "u_42" }` on the request row's `tags` JSONB column. The dashboard's
 * "Spend by tag" card aggregates by tag.
 *
 * Why this format and not JSON in the header:
 *   - Comma-separated key=value is what every framework (LangChain, Vercel
 *     AI SDK, Cline, etc.) can append without thinking
 *   - JSON-in-a-header forces the customer to URL-encode or escape — a
 *     papercut we'd hear about every time
 *   - Trade-off: tag values can't contain literal `,` or `=`. Acceptable
 *     for cost-attribution dimensions (feature names, team slugs, user ids)
 *     which are usually identifier-shaped already.
 *
 * Caps:
 *   - Max 20 tag pairs per request (anything beyond is dropped, logged to
 *     console once per process). Prevents pathological headers from bloating
 *     Postgres rows.
 *   - Max key length 64, max value length 256. Truncation, not rejection.
 *
 * The tag map IS NOT trusted to be unique by key — last-wins on duplicates.
 */

const MAX_PAIRS = 20;
const MAX_KEY_LEN = 64;
const MAX_VAL_LEN = 256;

let _overflowWarned = false;

/**
 * Parse the `x-ts-tag` header (or whatever the caller passes). Always
 * returns a plain object — `{}` when the header is missing/empty/malformed.
 * Never throws.
 */
export function parseTagHeader(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  const parts = raw.split(",");
  let kept = 0;
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue; // need at least one char of key
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!key) continue;
    if (kept >= MAX_PAIRS) {
      if (!_overflowWarned) {
        _overflowWarned = true;
        console.warn(
          `[tokensmart] x-ts-tag header had >${MAX_PAIRS} pairs; later pairs dropped. (warned once per process)`
        );
      }
      break;
    }
    out[key.slice(0, MAX_KEY_LEN)] = val.slice(0, MAX_VAL_LEN);
    kept++;
  }
  return out;
}

/**
 * "Well-known" attribution headers we promote to first-class status
 * because every long-running agent (OpenClaw, an AutoGPT-style loop, a
 * LangGraph multi-step pipeline, etc.) ends up wanting them eventually:
 *
 *   x-ts-agent    — which agent/binary made the call ("openclaw", "cline")
 *   x-ts-session  — caller-defined session/conversation id
 *   x-ts-turn     — caller-defined turn id within the session
 *   x-ts-channel  — coarse-grained source ("repl", "ide", "cron", "webhook")
 *
 * Why dedicated headers and not "just put them in x-ts-tag":
 *   - SDK ergonomics. A LangGraph node can `headers["x-ts-turn"] =
 *     str(state.turn)` without doing string-concat into a comma list.
 *   - Hard contract. We commit to NEVER repurposing these four keys, so
 *     dashboards and benchmarks can rely on their meaning. x-ts-tag is
 *     deliberately freeform; well-known keys are deliberately not.
 *   - Visibility. They show up in the dashboard's session view as a
 *     pinned column, not somewhere in a generic tag pill.
 *
 * Same caps as freeform tags (length truncation, no rejection).
 */
const WELL_KNOWN_HEADERS = [
  "x-ts-agent",
  "x-ts-session",
  "x-ts-turn",
  "x-ts-channel",
] as const;

type HeaderGetter = (name: string) => string | null | undefined;

/**
 * Build the full tag map for a request.
 *
 * Order of precedence (later wins):
 *   1. `x-ts-tag` freeform pairs (caller-controlled freeform attribution)
 *   2. Well-known headers (x-ts-agent / session / turn / channel)
 *
 * Well-known headers WIN over a same-named pair in `x-ts-tag` so a
 * caller sending both `x-ts-tag: turn=1` and `x-ts-turn: 2` ends up
 * with `turn=2` — the dedicated header is the more specific signal.
 *
 * Empty / missing values are skipped (we don't pollute the tag map
 * with "session=" pairs).
 */
export function parseAttributionHeaders(
  getHeader: HeaderGetter
): Record<string, string> {
  const tags = parseTagHeader(getHeader("x-ts-tag"));
  for (const headerName of WELL_KNOWN_HEADERS) {
    const raw = getHeader(headerName);
    if (raw == null) continue;
    const v = String(raw).trim();
    if (!v) continue;
    // Strip "x-ts-" prefix to get the canonical tag key.
    const key = headerName.replace(/^x-ts-/, "");
    tags[key.slice(0, MAX_KEY_LEN)] = v.slice(0, MAX_VAL_LEN);
  }
  return tags;
}

export const WELL_KNOWN_TAG_HEADERS: readonly string[] = WELL_KNOWN_HEADERS;
