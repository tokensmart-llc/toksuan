/**
 * Unit tests for the JSON SmartCrusher strategy (M2).
 *
 * Contract:
 *   1. A large JSON array is shrunk to head + tail + "interesting" items,
 *      with dropped runs replaced by a {__tokensmart_elided: N} sentinel.
 *   2. Output is always valid JSON and strictly smaller than the input.
 *   3. Deterministic + idempotent — running twice yields identical bytes.
 *   4. Error-like items anywhere in the array are preserved.
 *   5. Objects whose values are arrays get their arrays crushed in place.
 *   6. NDJSON is NOT treated as a json_array (it stays json_logs).
 */

import { describe, expect, test } from "bun:test";
import {
  compressContent,
  detectShape,
  smartCrushJson,
  ELIDED_KEY,
  DEFAULT_POLICY,
  type CompressionPolicy,
} from "../src/compression";

const OPTIMIZE: CompressionPolicy = {
  ...DEFAULT_POLICY,
  enabled: true,
  mode: "optimize",
};

function hasSentinel(arr: unknown[]): boolean {
  return arr.some(
    (x) => x && typeof x === "object" && !Array.isArray(x) && ELIDED_KEY in (x as object)
  );
}

describe("detectShape — JSON containers", () => {
  test("top-level array → json_array", () => {
    const arr = JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ i })));
    expect(detectShape(arr)).toBe("json_array");
  });

  test("object with array values → json_array", () => {
    const obj = JSON.stringify({ rows: Array.from({ length: 40 }, (_, i) => ({ i })) });
    expect(detectShape(obj)).toBe("json_array");
  });

  test("NDJSON is NOT json_array (stays json_logs)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 8; i++) lines.push(`{"level":"info","msg":"ok","i":${i}}`);
    expect(detectShape(lines.join("\n"))).toBe("json_logs");
  });

  test("plain prose stays unknown", () => {
    expect(detectShape("just a sentence, nothing structured here.")).toBe("unknown");
  });
});

describe("smartCrushJson", () => {
  test("crushes a large array, keeps head+tail, inserts sentinel, valid JSON, smaller", () => {
    const items = Array.from({ length: 80 }, (_, i) => ({
      i,
      msg: `step ok number ${i}`,
      ok: true,
    }));
    const input = JSON.stringify(items);
    const out = smartCrushJson(input, OPTIMIZE);

    expect(out.length).toBeLessThan(input.length);
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(hasSentinel(parsed)).toBe(true);
    // First and last original items survive.
    expect(JSON.stringify(parsed[0])).toContain("step ok number 0");
    expect(out).toContain("step ok number 79");
  });

  test("preserves an error item buried in the middle", () => {
    const items = Array.from({ length: 80 }, (_, i) =>
      i === 40
        ? { i, level: "error", msg: "ECONNRESET upstream" }
        : { i, level: "info", msg: "ok" }
    );
    const out = smartCrushJson(JSON.stringify(items), OPTIMIZE);
    expect(out).toContain("ECONNRESET upstream");
  });

  test("deterministic + idempotent", () => {
    const items = Array.from({ length: 80 }, (_, i) => ({ i, msg: `row ${i}` }));
    const input = JSON.stringify(items);
    const once = smartCrushJson(input, OPTIMIZE);
    const twice = smartCrushJson(once, OPTIMIZE);
    expect(twice).toBe(once);
  });

  test("small arrays are not sentinel-ized (just minified)", () => {
    const items = Array.from({ length: 4 }, (_, i) => ({ i }));
    // Pretty-printed so there's whitespace to reclaim via minification.
    const input = JSON.stringify(items, null, 2);
    const out = smartCrushJson(input, OPTIMIZE);
    const parsed = JSON.parse(out);
    expect(hasSentinel(parsed)).toBe(false);
    expect(parsed.length).toBe(4);
  });

  test("object-with-arrays: crushes nested array in place, keeps object shape", () => {
    const obj = {
      query: "search foo",
      total: 500,
      rows: Array.from({ length: 60 }, (_, i) => ({ id: i, title: `r${i}` })),
    };
    const out = smartCrushJson(JSON.stringify(obj), OPTIMIZE);
    const parsed = JSON.parse(out) as { query: string; total: number; rows: unknown[] };
    expect(parsed.query).toBe("search foo");
    expect(parsed.total).toBe(500);
    expect(Array.isArray(parsed.rows)).toBe(true);
    expect(hasSentinel(parsed.rows)).toBe(true);
    expect(parsed.rows.length).toBeLessThan(60);
  });

  test("non-JSON content is returned unchanged", () => {
    const text = "not json at all { [ ";
    expect(smartCrushJson(text, OPTIMIZE)).toBe(text);
  });
});

describe("compressContent — json_array routing", () => {
  test("routes a JSON array to the crusher and reports the shape", () => {
    const items = Array.from({ length: 80 }, (_, i) => ({ i, msg: `row ${i}` }));
    const input = JSON.stringify(items);
    const r = compressContent(input, OPTIMIZE);
    expect(r.shape).toBe("json_array");
    expect(r.content.length).toBeLessThan(input.length);
    expect(() => JSON.parse(r.content)).not.toThrow();
  });

  test("idempotent through compressContent", () => {
    const items = Array.from({ length: 80 }, (_, i) => ({ i, msg: `row ${i}` }));
    const once = compressContent(JSON.stringify(items), OPTIMIZE).content;
    const twice = compressContent(once, OPTIMIZE).content;
    expect(twice).toBe(once);
  });

  test("does not run line-dedup on JSON (structure preserved)", () => {
    // A pretty-printed array of identical objects would be corrupted by a
    // naive consecutive-line dedup. The crusher must keep valid JSON.
    const items = Array.from({ length: 40 }, () => ({ status: "ok", code: 200 }));
    const input = JSON.stringify(items, null, 2);
    const r = compressContent(input, OPTIMIZE);
    expect(() => JSON.parse(r.content)).not.toThrow();
  });
});
