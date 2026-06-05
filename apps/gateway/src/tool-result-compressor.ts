/**
 * Back-compat shim — the compressor moved to `./compression/` (M1).
 *
 * The original single-file module grew into a full ContentRouter-style
 * pipeline (detector + per-shape strategies + JSON SmartCrusher + modes +
 * reversible store). It now lives under `apps/gateway/src/compression/`.
 *
 * This file re-exports the public surface so existing imports keep
 * working unchanged:
 *
 *   import {
 *     buildPolicyFromEnv, compressMessages, estimateTokensFromChars,
 *     type CompressionPolicy,
 *   } from "./tool-result-compressor";
 *
 * New code should import from `./compression` directly.
 *
 * Historical design notes (still accurate, why the pipeline is narrow):
 *   - Only `tool` / `function` role messages are ever rewritten — the
 *     human-or-agent prompt is sacred.
 *   - Rewrites are deterministic + idempotent so fingerprinting (loop
 *     detection) stays stable.
 *   - Shape detection is heuristic-only; we never call a model to
 *     "understand" content (that would defeat the purpose).
 *   - Off by default; operators opt in via env. Per-call escape hatch via
 *     `x-ts-tool-compress: off` / `x-ts-context-compress: off`.
 */

export * from "./compression";
