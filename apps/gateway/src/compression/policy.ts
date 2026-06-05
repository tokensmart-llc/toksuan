/**
 * Policy construction from env (M1 + M3).
 *
 * Back-compat is load-bearing: the original `TOKENSMART_TOOL_COMPRESS_*`
 * env vars keep working exactly as before. The new
 * `TOKENSMART_CONTEXT_COMPRESS_MODE` (off|audit|optimize) takes
 * precedence when set, unlocking the audit dry-run path.
 *
 * Resolution:
 *   - If TOKENSMART_CONTEXT_COMPRESS_MODE is set → that mode wins.
 *   - Else if TOKENSMART_TOOL_COMPRESS_ENABLED=1 → mode "optimize".
 *   - Else → mode "off".
 * `enabled` is true iff mode === "optimize" (the canonical low-level gate).
 */

import { DEFAULT_POLICY, type CompressionMode, type CompressionPolicy } from "./types";

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

function resolveMode(env: Record<string, string | undefined>): CompressionMode {
  const raw = (env.TOKENSMART_CONTEXT_COMPRESS_MODE ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "audit" || raw === "optimize") return raw;
  // Legacy switch: enabled === optimize.
  if (env.TOKENSMART_TOOL_COMPRESS_ENABLED === "1") return "optimize";
  return "off";
}

/**
 * Build a policy from env-vars. Self-contained so tests can pass a stub
 * object and get a policy back. `config.ts` / `chat.ts` call this once at
 * boot with `process.env`.
 */
export function buildPolicyFromEnv(
  env: Record<string, string | undefined>
): CompressionPolicy {
  const mode = resolveMode(env);
  if (mode === "off") return { ...DEFAULT_POLICY };

  const exclude = new Set<string>();
  const rawExclude = env.TOKENSMART_TOOL_COMPRESS_EXCLUDE_TOOLS ?? "";
  for (const name of rawExclude.split(",")) {
    const trimmed = name.trim().toLowerCase();
    if (trimmed) exclude.add(trimmed);
  }

  return {
    enabled: mode === "optimize",
    mode,
    minMessageChars: parsePositiveInt(
      env.TOKENSMART_TOOL_COMPRESS_MIN_MESSAGE_CHARS,
      DEFAULT_POLICY.minMessageChars
    ),
    maxCompressedChars: parsePositiveInt(
      env.TOKENSMART_TOOL_COMPRESS_MAX_COMPRESSED_CHARS,
      DEFAULT_POLICY.maxCompressedChars
    ),
    stripAnsi: parseFlag(env.TOKENSMART_TOOL_COMPRESS_STRIP_ANSI, true),
    dedupeLines: parseFlag(env.TOKENSMART_TOOL_COMPRESS_DEDUP_LINES, true),
    excludeToolNames: exclude,
    crushJson: parseFlag(env.TOKENSMART_CONTEXT_COMPRESS_CRUSH_JSON, true),
    smartCrushMinItems: parsePositiveInt(
      env.TOKENSMART_CONTEXT_COMPRESS_MIN_ITEMS,
      DEFAULT_POLICY.smartCrushMinItems
    ),
    smartCrushMaxItems: parsePositiveInt(
      env.TOKENSMART_CONTEXT_COMPRESS_MAX_ITEMS,
      DEFAULT_POLICY.smartCrushMaxItems
    ),
    store: parseFlag(env.TOKENSMART_CONTEXT_COMPRESS_STORE, false),
  };
}

/**
 * Resolve the effective mode for a single request given the boot policy +
 * an optional per-call header value. Header can only DOWNGRADE (turn off)
 * — it cannot turn compression on for a project that didn't enable it.
 *
 * Accepted header values: off|0|false (disable), audit, optimize.
 */
export function resolveRequestMode(
  policyMode: CompressionMode,
  headerValue: string | undefined | null
): CompressionMode {
  if (policyMode === "off") return "off";
  const h = (headerValue ?? "").trim().toLowerCase();
  if (!h) return policyMode;
  if (h === "off" || h === "0" || h === "false") return "off";
  if (h === "audit") return "audit";
  if (h === "optimize") {
    // Only honor an upgrade to optimize if the project allows optimize.
    return policyMode === "optimize" ? "optimize" : "audit";
  }
  return policyMode;
}
