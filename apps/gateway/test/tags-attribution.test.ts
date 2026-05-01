/**
 * Coverage for `parseAttributionHeaders` — the mux that combines
 * freeform `x-ts-tag` pairs with the well-known OpenClaw/agent
 * headers (`x-ts-agent`, `x-ts-session`, `x-ts-turn`, `x-ts-channel`).
 *
 * The contract these tests lock in:
 *
 *   1. Both signal channels feed the same tag map.
 *   2. Well-known headers WIN over a colliding key in `x-ts-tag`.
 *   3. Empty / whitespace well-known headers don't poison the map.
 *   4. Length caps still apply (max 64-char keys, 256-char values).
 */
import { describe, expect, test } from "bun:test";
import { parseAttributionHeaders } from "../src/tags";

function fakeHeaders(map: Record<string, string | undefined>) {
  return (name: string) => {
    const v = map[name.toLowerCase()];
    return v == null ? null : v;
  };
}

describe("parseAttributionHeaders", () => {
  test("returns empty object when every channel is unset", () => {
    expect(parseAttributionHeaders(fakeHeaders({}))).toEqual({});
  });

  test("freeform x-ts-tag pairs land on the tag map", () => {
    const tags = parseAttributionHeaders(
      fakeHeaders({ "x-ts-tag": "feature=summarize,team=growth" })
    );
    expect(tags).toEqual({ feature: "summarize", team: "growth" });
  });

  test("well-known headers land as canonical tag keys", () => {
    const tags = parseAttributionHeaders(
      fakeHeaders({
        "x-ts-agent": "openclaw",
        "x-ts-session": "s_42",
        "x-ts-turn": "7",
        "x-ts-channel": "ide",
      })
    );
    expect(tags).toEqual({
      agent: "openclaw",
      session: "s_42",
      turn: "7",
      channel: "ide",
    });
  });

  test("well-known headers OVERRIDE same-named freeform pairs", () => {
    // A caller setting both should get the dedicated header's value —
    // it's the more specific signal. This locks in the precedence rule
    // so a later refactor doesn't silently flip it.
    const tags = parseAttributionHeaders(
      fakeHeaders({
        "x-ts-tag": "session=stale,turn=stale",
        "x-ts-session": "fresh-session",
        "x-ts-turn": "fresh-turn",
      })
    );
    expect(tags).toEqual({
      session: "fresh-session",
      turn: "fresh-turn",
    });
  });

  test("freeform pairs with non-conflicting keys are preserved alongside well-known", () => {
    const tags = parseAttributionHeaders(
      fakeHeaders({
        "x-ts-tag": "feature=loop_detect,team=infra",
        "x-ts-agent": "openclaw",
        "x-ts-session": "s_99",
      })
    );
    expect(tags).toEqual({
      feature: "loop_detect",
      team: "infra",
      agent: "openclaw",
      session: "s_99",
    });
  });

  test("empty / whitespace well-known headers are ignored, not stored as empty strings", () => {
    const tags = parseAttributionHeaders(
      fakeHeaders({
        "x-ts-agent": "",
        "x-ts-session": "   ",
        "x-ts-turn": "real",
      })
    );
    expect(tags).toEqual({ turn: "real" });
  });

  test("oversized well-known values are truncated, not rejected", () => {
    const big = "x".repeat(1000);
    const tags = parseAttributionHeaders(
      fakeHeaders({ "x-ts-session": big })
    );
    // Match the freeform-tag cap (256). We truncate to keep tag rows from
    // ballooning, but a too-long value is recoverable so we don't reject.
    expect(tags.session?.length).toBe(256);
  });
});
