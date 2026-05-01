import { describe, expect, test } from "bun:test";
import { parseTagHeader } from "../src/tags";

describe("parseTagHeader", () => {
  test("returns empty object for null/undefined/empty", () => {
    expect(parseTagHeader(null)).toEqual({});
    expect(parseTagHeader(undefined)).toEqual({});
    expect(parseTagHeader("")).toEqual({});
    expect(parseTagHeader("   ")).toEqual({});
  });

  test("parses a single key=value pair", () => {
    expect(parseTagHeader("feature=summarize")).toEqual({
      feature: "summarize",
    });
  });

  test("parses comma-separated key=value pairs", () => {
    expect(
      parseTagHeader("feature=summarize,team=growth,user=u_42")
    ).toEqual({
      feature: "summarize",
      team: "growth",
      user: "u_42",
    });
  });

  test("tolerates whitespace around keys, values, and commas", () => {
    expect(
      parseTagHeader("  feature = summarize ,  team= growth ,user =u_42")
    ).toEqual({
      feature: "summarize",
      team: "growth",
      user: "u_42",
    });
  });

  test("ignores pairs with empty key", () => {
    expect(parseTagHeader("=val,feature=ok")).toEqual({ feature: "ok" });
  });

  test("ignores pairs without =", () => {
    expect(parseTagHeader("just-a-key,feature=ok")).toEqual({
      feature: "ok",
    });
  });

  test("last-wins on duplicate keys", () => {
    expect(parseTagHeader("feature=a,feature=b")).toEqual({
      feature: "b",
    });
  });

  test("supports = inside values (only the first = splits)", () => {
    expect(parseTagHeader("query=foo=bar")).toEqual({
      query: "foo=bar",
    });
  });

  test("truncates values longer than 256 chars", () => {
    const long = "x".repeat(500);
    const out = parseTagHeader(`feature=${long}`);
    expect(out.feature.length).toBe(256);
  });

  test("truncates keys longer than 64 chars", () => {
    const long = "k".repeat(100);
    const out = parseTagHeader(`${long}=v`);
    const onlyKey = Object.keys(out)[0];
    expect(onlyKey.length).toBe(64);
  });

  test("caps at 20 pairs", () => {
    const pairs = Array.from({ length: 30 }, (_, i) => `k${i}=v${i}`).join(",");
    const out = parseTagHeader(pairs);
    expect(Object.keys(out).length).toBe(20);
    expect(out["k0"]).toBe("v0");
    expect(out["k19"]).toBe("v19");
    expect(out["k20"]).toBeUndefined();
  });
});
