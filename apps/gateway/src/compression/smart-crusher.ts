/**
 * SmartCrusher — deterministic JSON array compression (M2).
 *
 * The TokSuan analogue of Headroom's SmartCrusher. When a `tool` message
 * carries a JSON array (search results, API rows, metric points, NDJSON
 * collapsed into an array) or an object whose values are such arrays, we
 * keep a representative subset and replace dropped runs with a compact
 * sentinel:
 *
 *     { "__tokensmart_elided": <count> }
 *
 * Selection per array (all by ORIGINAL index, so order is preserved):
 *   - the first `~40%` of the item budget (head)
 *   - the last `~20%` of the item budget (tail)
 *   - "interesting" items anywhere in the array (error/exception/fail/
 *     critical/fatal keywords, or an HTTP 4xx/5xx status) up to the
 *     remaining budget
 *
 * Guarantees (match the rest of the pipeline):
 *   - **Deterministic**: same input → same output, no randomness.
 *   - **Idempotent**: an array that already contains a sentinel is left
 *     untouched, and a re-parse + re-stringify of crushed output is
 *     byte-identical. Loop-detection fingerprints stay stable.
 *   - **Valid JSON out**: downstream parsers still work.
 *   - **Lossless fallback**: if crushing doesn't actually shrink the
 *     string, the original content is returned unchanged.
 */

import type { CompressionPolicy } from "./types";

export const ELIDED_KEY = "__tokensmart_elided";

const INTERESTING_RE =
  /(error|exception|traceback|fail(ed|ure)?|critical|fatal|panic|"status"\s*:\s*[45]\d\d|"code"\s*:\s*[45]\d\d)/i;

function isSentinel(item: unknown): boolean {
  return Boolean(
    item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      ELIDED_KEY in (item as Record<string, unknown>)
  );
}

function arrayHasSentinel(arr: unknown[]): boolean {
  return arr.some(isSentinel);
}

function isInteresting(item: unknown): boolean {
  let s: string;
  try {
    s = typeof item === "string" ? item : JSON.stringify(item);
  } catch {
    return false;
  }
  if (!s) return false;
  // Bound the scan so a pathologically large nested item can't dominate.
  return INTERESTING_RE.test(s.length > 4000 ? s.slice(0, 4000) : s);
}

function crushArray(arr: unknown[], policy: CompressionPolicy): unknown[] {
  const n = arr.length;
  // Idempotency: a previously-crushed array carries a sentinel.
  if (arrayHasSentinel(arr)) return arr;
  if (n < policy.smartCrushMinItems) return arr.map((v) => crushValue(v, policy));

  const maxItems = Math.max(2, policy.smartCrushMaxItems);
  const keep = new Set<number>();
  const head = Math.max(1, Math.ceil(maxItems * 0.4));
  const tail = Math.max(1, Math.ceil(maxItems * 0.2));
  for (let i = 0; i < head && i < n; i++) keep.add(i);
  for (let i = Math.max(0, n - tail); i < n; i++) keep.add(i);

  let budget = maxItems - keep.size;
  if (budget > 0) {
    for (let i = 0; i < n; i++) {
      if (keep.has(i)) continue;
      if (isInteresting(arr[i])) {
        keep.add(i);
        if (--budget <= 0) break;
      }
    }
  }

  const sorted = [...keep].sort((a, b) => a - b);
  const out: unknown[] = [];
  let prev = -1;
  for (const idx of sorted) {
    if (idx > prev + 1) {
      out.push({ [ELIDED_KEY]: idx - (prev + 1) });
    }
    // Recurse into kept items so nested giant arrays also shrink.
    out.push(crushValue(arr[idx], policy));
    prev = idx;
  }
  if (prev < n - 1) {
    out.push({ [ELIDED_KEY]: n - 1 - prev });
  }
  return out;
}

function crushValue(value: unknown, policy: CompressionPolicy): unknown {
  if (Array.isArray(value)) return crushArray(value, policy);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (ELIDED_KEY in obj) return obj; // leave sentinels alone
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) {
      out[k] = crushValue(obj[k], policy);
    }
    return out;
  }
  return value;
}

/**
 * Crush a JSON-container string. Returns compact JSON when it's smaller
 * than the input, otherwise the original string unchanged.
 */
export function smartCrushJson(content: string, policy: CompressionPolicy): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  const crushed = crushValue(parsed, policy);
  let out: string;
  try {
    out = JSON.stringify(crushed);
  } catch {
    return content;
  }
  // Optional hard cap: if the crushed JSON is still enormous, fall back to
  // a byte truncation is NOT applied here (it would break JSON validity);
  // we simply return whichever is smaller and let the caller's
  // length-gain check decide.
  return out.length < content.length ? out : content;
}
