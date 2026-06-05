/**
 * Public surface of the context-compression pipeline.
 *
 * Import from here for new code:
 *   import { compressContextMessages, buildPolicyFromEnv } from "../compression";
 *
 * The legacy `tool-result-compressor.ts` module re-exports this barrel so
 * existing imports keep working unchanged.
 */

export * from "./types";
export { detectShape } from "./detector";
export {
  ANSI_RE,
  stripAnsi,
  dedupeConsecutive,
  compressGitStatus,
  compressGitDiff,
  compressShellListing,
  compressStackTrace,
  compressJsonLogs,
  truncateHeadTail,
} from "./text-shapes";
export { smartCrushJson, ELIDED_KEY } from "./smart-crusher";
export {
  compressContent,
  compressMessages,
  compressContextMessages,
  estimateTokensFromChars,
} from "./router";
export { buildPolicyFromEnv, resolveRequestMode } from "./policy";

// NOTE: the reversible store (`./store`) is intentionally NOT re-exported
// here. It imports the DB layer (which loads env at module init), and
// keeping it out of the barrel lets the compression core stay pure +
// unit-testable without a configured DATABASE_URL. Import it directly:
//   import { storeCompressedBlobs } from "../compression/store";
