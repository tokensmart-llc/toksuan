/**
 * Shared types for the context-compression pipeline.
 *
 * M1 extracted these from the original single-file
 * `tool-result-compressor.ts`. The pipeline is the TokSuan analogue of
 * Headroom's ContentRouter: detect a content shape, route it to the
 * right deterministic strategy, and record what happened so the
 * dashboard can prove the savings.
 *
 * Design invariants carried over from the original module:
 *   - Only `tool` / `function` role messages are ever rewritten.
 *   - Every strategy is deterministic + idempotent (running it twice
 *     yields identical bytes) so loop-detection fingerprints stay
 *     stable.
 *   - Detection is heuristic-only; no model calls.
 */

/**
 * Content shapes the detector recognises. `json_array` (M2) covers any
 * JSON container the SmartCrusher can shrink (a top-level array, or an
 * object whose values include arrays).
 */
export type CompressionShape =
  | "git_status"
  | "git_diff"
  | "shell_listing"
  | "stack_trace"
  | "json_logs"
  | "json_array"
  | "ansi_text"
  | "generic_long_log"
  | "unknown";

/**
 * Compression mode (M3). Mirrors Headroom's audit/optimize split:
 *   - off:      pipeline never runs.
 *   - audit:    measure potential savings, DO NOT rewrite the body.
 *   - optimize: actually rewrite tool messages before forwarding.
 */
export type CompressionMode = "off" | "audit" | "optimize";

export type CompressionPolicy = {
  /**
   * True only in `optimize` mode. Kept as the canonical low-level gate
   * so `compressContent` / `compressMessages` behave exactly as they did
   * before M1-M3 (audit/off both leave it false).
   */
  enabled: boolean;
  /** Resolved mode. `enabled === (mode === "optimize")`. */
  mode: CompressionMode;
  minMessageChars: number;
  maxCompressedChars: number;
  stripAnsi: boolean;
  dedupeLines: boolean;
  /** Lower-cased tool names whose results we never touch. */
  excludeToolNames: ReadonlySet<string>;
  /** M2: enable the JSON SmartCrusher strategy. */
  crushJson: boolean;
  /** Arrays shorter than this are never crushed (just minified). */
  smartCrushMinItems: number;
  /** Upper bound on items kept after a crush. */
  smartCrushMaxItems: number;
  /**
   * M4: persist the pre-compression originals in `compressed_blobs` so
   * an operator can retrieve them (reversible compression). Off by
   * default; only consulted in `optimize` mode.
   */
  store: boolean;
};

export type CompressedMessageInfo = {
  /** Index in the original messages[] array. */
  index: number;
  role: string;
  /** What the heuristic decided this content was. */
  shape: CompressionShape;
  charsBefore: number;
  charsAfter: number;
};

export type CompressionResult = {
  /** True if at least one message was actually rewritten (optimize only). */
  applied: boolean;
  /** Sum of (charsBefore - charsAfter) across rewritten messages. */
  totalCharsSaved: number;
  perMessage: CompressedMessageInfo[];
  /**
   * Mode that produced this result. In `audit` mode `applied` is false
   * but `totalCharsSaved` / `perMessage` describe what WOULD have been
   * saved, so the dashboard can show a "potential savings" receipt
   * without changing the prompt.
   */
  mode?: CompressionMode;
};

export type ChatMessageLike = {
  role: string;
  content: unknown;
  name?: string;
  tool_call_id?: string;
  // Forward-compat: anything else passes through untouched.
  [key: string]: unknown;
};

export const DEFAULT_POLICY: CompressionPolicy = {
  enabled: false,
  mode: "off",
  minMessageChars: 500,
  maxCompressedChars: 4000,
  stripAnsi: true,
  dedupeLines: true,
  excludeToolNames: new Set<string>(),
  crushJson: true,
  smartCrushMinItems: 10,
  smartCrushMaxItems: 20,
  store: false,
};
