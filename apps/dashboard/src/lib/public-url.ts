/**
 * Public-facing URLs the dashboard surfaces to users in copy, code
 * snippets, and empty-state nudges.
 *
 * There are TWO gateway URLs in this codebase — don't confuse them:
 *
 *   - `GATEWAY_URL` (server-only) is the URL the dashboard uses for its
 *     own RPC calls to the gateway (`/health`, `/internal/replay`). In
 *     Kubernetes / multi-service deploys this can point at an internal
 *     service address that isn't reachable from the public internet.
 *     See `src/lib/gateway-status.ts` + `src/app/requests/[id]/actions.ts`.
 *
 *   - `GATEWAY_PUBLIC_URL` (this file) is the URL we TELL THE USER to
 *     curl. It's what lands in `base_url` of their OpenAI SDK / in the
 *     "How to point an agent here" card / in every copy-paste snippet.
 *     In hosted production set this to your public gateway domain, e.g.
 *     `https://gateway.tokensmt.com`. Local dev leaves it unset and
 *     falls back through `GATEWAY_URL` to `http://localhost:8787`.
 *
 * Fallback chain (first non-empty wins):
 *   1. GATEWAY_PUBLIC_URL   ← set this in hosted prod
 *   2. GATEWAY_URL          ← reuses the dev default when both are the
 *                             same host (typical single-box deploy)
 *   3. http://localhost:8787 ← dev fallback so nobody has to configure
 *                              anything to start hacking
 *
 * This is NOT a `NEXT_PUBLIC_*` var on purpose: every caller is a
 * server component / server action, and keeping it server-side means
 * operators can change the value with a restart instead of a full
 * `bun run build`.
 */

const DEFAULT = "http://localhost:8787";

/** Origin only — e.g. `https://gateway.tokensmt.com` (no trailing slash, no `/v1`). */
export function getPublicGatewayUrl(): string {
  const raw =
    process.env.GATEWAY_PUBLIC_URL ?? process.env.GATEWAY_URL ?? DEFAULT;
  return raw.replace(/\/+$/, "");
}

/** Full OpenAI-compatible base URL — e.g. `https://gateway.tokensmt.com/v1`. */
export function getPublicGatewayApiUrl(): string {
  return `${getPublicGatewayUrl()}/v1`;
}

/**
 * Same as `getPublicGatewayApiUrl()` but appends the chat-completions
 * endpoint, for curl / empty-state snippets where the full URL matters.
 */
export function getPublicGatewayChatUrl(): string {
  return `${getPublicGatewayApiUrl()}/chat/completions`;
}
