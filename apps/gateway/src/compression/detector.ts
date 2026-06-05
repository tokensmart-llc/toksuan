/**
 * Content-shape detection — the "router" half of the ContentRouter.
 *
 * Heuristic-only, no model calls. Order matters: JSON containers are
 * probed first (M2 SmartCrusher), then the line-oriented text detectors
 * moved verbatim from the original module.
 */

import type { CompressionShape } from "./types";
import { ANSI_RE } from "./text-shapes";

/**
 * Is this a JSON container the SmartCrusher can shrink? True for a
 * top-level array, or an object whose values include at least one array.
 *
 * Cheap pre-check (first non-space char must be `[` or `{`) keeps us from
 * attempting a full JSON.parse on multi-KB log blobs. NDJSON (newline-
 * separated objects, not wrapped in `[]`) fails the whole-document parse
 * and falls through to the `json_logs` detector — no regression.
 */
function jsonContainerKind(content: string): "json_array" | null {
  const t = content.trimStart();
  if (!t.startsWith("[") && !t.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) return "json_array";
  if (parsed && typeof parsed === "object") {
    for (const v of Object.values(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) return "json_array";
    }
  }
  return null;
}

const SHAPE_DETECTORS: Array<{
  shape: CompressionShape;
  test: (text: string) => boolean;
}> = [
  // git diff is checked first because `On branch main\ndiff --git ...` is
  // technically a git status output that contains a diff — but the diff
  // filter is the more aggressive savings, so prefer it.
  {
    shape: "git_diff",
    test: (t) =>
      /^diff --git /m.test(t) ||
      (/^---\s/m.test(t) && /^\+\+\+\s/m.test(t) && /^@@\s/m.test(t)),
  },
  {
    shape: "git_status",
    test: (t) =>
      /^(On branch |HEAD detached at )/m.test(t) &&
      /(Changes (not staged|to be committed)|Untracked files|nothing to commit)/m.test(t),
  },
  {
    // Classic ls -l / find / tree output: many lines starting with
    // permission bits OR file-path prefixes.
    shape: "shell_listing",
    test: (t) => {
      const lines = t.split("\n");
      if (lines.length < 8) return false;
      let permLines = 0;
      for (const ln of lines) {
        if (/^[-dlcbsp][rwx-]{9}/.test(ln)) permLines++;
      }
      return permLines >= 5;
    },
  },
  {
    // Python / JS / Java / Go stack trace: an error/exception name plus
    // multiple "at .../:NNN" or "  File ..., line NNN" frames.
    shape: "stack_trace",
    test: (t) => {
      const frameAt = (t.match(/^\s+at\s+\S+/gm) ?? []).length;
      const framePy = (t.match(/^\s*File ".+", line \d+/gm) ?? []).length;
      const errLine = /\b(Error|Exception|panic|Traceback|FAIL|FAILED)\b/.test(t);
      return errLine && frameAt + framePy >= 3;
    },
  },
  {
    // NDJSON / structured log lines. Detect by: multiple lines, each
    // parseable as JSON object containing a level/severity/msg field.
    shape: "json_logs",
    test: (t) => {
      const lines = t.split("\n").filter((l) => l.trim().startsWith("{"));
      if (lines.length < 5) return false;
      let parsed = 0;
      for (let i = 0; i < Math.min(lines.length, 12); i++) {
        try {
          const v = JSON.parse(lines[i]) as Record<string, unknown>;
          if (
            v &&
            typeof v === "object" &&
            ("level" in v ||
              "severity" in v ||
              "msg" in v ||
              "message" in v)
          ) {
            parsed++;
          }
        } catch {
          // not JSON, skip
        }
      }
      return parsed >= 3;
    },
  },
  {
    shape: "ansi_text",
    test: (t) => ANSI_RE.test(t),
  },
];

export function detectShape(content: string): CompressionShape {
  // JSON container (array / object-with-arrays) takes priority — it's the
  // highest-value, structure-preserving strategy.
  const jsonKind = jsonContainerKind(content);
  if (jsonKind) return jsonKind;

  // Reset regex state because some detectors use a global flag.
  ANSI_RE.lastIndex = 0;
  for (const { shape, test } of SHAPE_DETECTORS) {
    if (test(content)) return shape;
    ANSI_RE.lastIndex = 0;
  }
  return "unknown";
}
