/**
 * v0.6.7 — caller-visible routing-decision response headers.
 *
 * Why these exist: TokenSmart's product thesis is "caller doesn't change
 * strings, gateway saves money in the background" — the cost-savings story
 * is intentionally invisible to the application. But for OPERATORS
 * dogfooding their own agent harness against the gateway, that invisibility
 * makes the savings impossible to verify without a separate dashboard
 * trip. Most OpenAI-SDK callers don't auto-expose the response body's
 * `model` field as a property either; you have to grep it out by hand.
 *
 * These response headers solve that for any operator who wires their
 * tooling to read them. Default callers continue to see the OpenAI-compat
 * response body unchanged.
 *
 * Pin the helper's contract so a future refactor doesn't quietly:
 *   - drop a header (an operator's dashboard would silently lose data)
 *   - emit a non-ASCII byte (HTTP/1.1 strict parsers reject the response)
 *   - lose precision on the cost number (sub-cent matters for high-volume
 *     agents — a 1000-req/min agent at 0.5 micro-cents/req is real money)
 */

import { describe, expect, test } from "bun:test";

// Env must be set before importing src/routes/chat (transitively imports
// src/config which validates + exits on missing creds at module init).
process.env.DATABASE_URL = process.env.DATABASE_URL ?? ":memory:";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "sk-test-fixture";

import { buildRoutingDecisionHeaders } from "../src/routes/chat";

describe("buildRoutingDecisionHeaders (v0.6.7)", () => {
  test("baseline trio is always present, even with no routing", () => {
    const headers = buildRoutingDecisionHeaders({
      askedModel: "gpt-5.2",
      landedModel: "gpt-5.2",
      routingReason: null,
    });
    expect(headers["X-Tokensmart-Asked-Model"]).toBe("gpt-5.2");
    expect(headers["X-Tokensmart-Landed-Model"]).toBe("gpt-5.2");
    // null routing reason → "none" so callers can rely on header presence
    // instead of doing a presence check before parsing.
    expect(headers["X-Tokensmart-Routing-Reason"]).toBe("none");
    expect(headers["X-Tokensmart-Cost-Cents"]).toBeUndefined();
    expect(headers["X-Tokensmart-Cost-Saved-Vs-Asked-Cents"]).toBeUndefined();
  });

  test("baseline routing reason with a Unicode arrow is sanitized to ASCII", () => {
    // The shipped baseline routing reason format embeds "→" — a Unicode
    // arrow that strict HTTP/1.1 parsers reject in header values. The
    // helper must replace it before stamping. The DB column + the log
    // line keep the original arrow; only the header is rewritten.
    const headers = buildRoutingDecisionHeaders({
      askedModel: "gpt-5.2",
      landedModel: "gpt-4o-mini",
      routingReason:
        "baseline:tool_use:simple→reasoning:medium:q=0.87:n=21:eps=0.05",
    });
    expect(headers["X-Tokensmart-Routing-Reason"]).toBe(
      "baseline:tool_use:simple->reasoning:medium:q=0.87:n=21:eps=0.05"
    );
    // No → byte should survive into the header.
    expect(headers["X-Tokensmart-Routing-Reason"]).not.toContain("→");
  });

  test("project-rule routing reason passes through unchanged (already ASCII)", () => {
    const headers = buildRoutingDecisionHeaders({
      askedModel: "gpt-4o",
      landedModel: "gpt-4o-mini",
      routingReason: "rule:abc-123:from=gpt-4o:to=gpt-4o-mini",
    });
    expect(headers["X-Tokensmart-Routing-Reason"]).toBe(
      "rule:abc-123:from=gpt-4o:to=gpt-4o-mini"
    );
  });

  test("control bytes in any field are scrubbed (defense in depth)", () => {
    // No code path in chat.ts would inject a control byte today, but a
    // future contributor adding a logging-derived diagnostic to the
    // reason string shouldn't be able to break HTTP framing by accident.
    const headers = buildRoutingDecisionHeaders({
      askedModel: "gpt-5.2",
      landedModel: "gpt-5.2",
      routingReason: "rule:weird\nname\rval",
    });
    expect(headers["X-Tokensmart-Routing-Reason"]).toBe("rule:weird_name_val");
    // Specifically — no CR, no LF (those are the framing-break chars).
    expect(headers["X-Tokensmart-Routing-Reason"]).not.toContain("\n");
    expect(headers["X-Tokensmart-Routing-Reason"]).not.toContain("\r");
  });

  test("very long reason strings are clamped to 512 chars (header line cap)", () => {
    const giant = "rule:" + "a".repeat(10_000);
    const headers = buildRoutingDecisionHeaders({
      askedModel: "gpt-5.2",
      landedModel: "gpt-5.2",
      routingReason: giant,
    });
    expect(headers["X-Tokensmart-Routing-Reason"]?.length).toBe(512);
  });

  test("cost is emitted in cents with 6 decimals to preserve sub-cent precision", () => {
    // Input is integer micro_cents; 1 cent = 1000 micro_cents.
    // 12_345 micro_cents → 12.345 cents → "12.345000".
    // 1 micro_cent → 0.001 cents → "0.001000". This precision matters
    // for high-volume agents whose per-request cost is sub-cent.
    const headers = buildRoutingDecisionHeaders({
      askedModel: "gpt-5.2",
      landedModel: "gemini-2.5-flash-lite",
      routingReason: "baseline:chat:simple",
      costMicroCents: 12_345,
      costSavedVsAskedMicroCents: 1_555,
    });
    expect(headers["X-Tokensmart-Cost-Cents"]).toBe("12.345000");
    expect(headers["X-Tokensmart-Cost-Saved-Vs-Asked-Cents"]).toBe("1.555000");
  });

  test("zero cost on blocked / cached paths formats as 0.000000 (always present, never NaN)", () => {
    // Headers stamped by loop-blocked / plan-cap / budget-cap / cache-hit
    // paths set cost to 0 explicitly. The format should be a numeric
    // string a downstream operator can parseFloat without special-case.
    const headers = buildRoutingDecisionHeaders({
      askedModel: "gpt-5.2",
      landedModel: "gpt-5.2",
      routingReason: null,
      costMicroCents: 0,
      costSavedVsAskedMicroCents: 0,
    });
    expect(headers["X-Tokensmart-Cost-Cents"]).toBe("0.000000");
    expect(headers["X-Tokensmart-Cost-Saved-Vs-Asked-Cents"]).toBe("0.000000");
    expect(Number.parseFloat(headers["X-Tokensmart-Cost-Cents"]!)).toBe(0);
    expect(
      Number.parseFloat(headers["X-Tokensmart-Cost-Saved-Vs-Asked-Cents"]!)
    ).toBe(0);
  });

  test("cost headers are OMITTED when undefined (streaming success path)", () => {
    // On the streaming branch we know the model trio when SSE headers
    // flush, but cost is unknown until upstream completes (operator
    // reads the cost off the request row by following X-Tokensmart-
    // Request-Id). Verify the helper doesn't emit "undefined" or "NaN"
    // when cost numbers are absent.
    const headers = buildRoutingDecisionHeaders({
      askedModel: "gpt-5.2",
      landedModel: "gemini-2.5-flash-lite",
      routingReason: "baseline:chat:simple",
    });
    expect(headers["X-Tokensmart-Asked-Model"]).toBe("gpt-5.2");
    expect(headers["X-Tokensmart-Landed-Model"]).toBe("gemini-2.5-flash-lite");
    expect(headers["X-Tokensmart-Cost-Cents"]).toBeUndefined();
    expect(headers["X-Tokensmart-Cost-Saved-Vs-Asked-Cents"]).toBeUndefined();
    // Sanity: every emitted value is a string suitable for an HTTP
    // header line (no undefined leaks).
    for (const [, value] of Object.entries(headers)) {
      expect(typeof value).toBe("string");
      expect(value).not.toBe("undefined");
      expect(value).not.toBe("NaN");
    }
  });

  test("model strings with provider prefix slashes are passed through verbatim", () => {
    // Model names with provider prefix slashes are valid HTTP header bytes.
    // Pin that the helper doesn't accidentally URL-encode them.
    const headers = buildRoutingDecisionHeaders({
      askedModel: "custom/openai/gpt-5.2",
      landedModel: "custom/openai/gpt-4o-mini",
      routingReason: null,
    });
    expect(headers["X-Tokensmart-Asked-Model"]).toBe("custom/openai/gpt-5.2");
    expect(headers["X-Tokensmart-Landed-Model"]).toBe(
      "custom/openai/gpt-4o-mini"
    );
  });

  test("large cost numbers (a $50 reasoning-model burn) format cleanly", () => {
    // 50 dollars = 5000 cents = 5_000_000 micro_cents. The toFixed(6)
    // formatting must not switch to scientific notation.
    const headers = buildRoutingDecisionHeaders({
      askedModel: "gpt-5-pro",
      landedModel: "gpt-5-pro",
      routingReason: null,
      costMicroCents: 5_000_000,
      costSavedVsAskedMicroCents: 0,
    });
    expect(headers["X-Tokensmart-Cost-Cents"]).toBe("5000.000000");
    // Sanity — no "e+" or other notation that breaks naive parsers.
    expect(headers["X-Tokensmart-Cost-Cents"]).not.toContain("e");
    expect(headers["X-Tokensmart-Cost-Cents"]).not.toContain("E");
  });

  // -- Tool-result compressor headers (rtk-style input-token savings) --

  test("compressor headers are OMITTED when the compressor didn't fire", () => {
    // Default request — no compression breadcrumbs, no headers. Pins the
    // "invisible by default" contract: callers who don't enable the
    // feature shouldn't see new headers appear in their responses.
    const headers = buildRoutingDecisionHeaders({
      askedModel: "gpt-5.2",
      landedModel: "gpt-5.2",
      routingReason: null,
      costMicroCents: 12_345,
      costSavedVsAskedMicroCents: 0,
    });
    expect(headers["X-Tokensmart-Tool-Compress-Chars-Saved"]).toBeUndefined();
    expect(headers["X-Tokensmart-Tool-Compress-Saved-Cents"]).toBeUndefined();
  });

  test("compressor headers carry chars + dollars when the compressor fired", () => {
    const headers = buildRoutingDecisionHeaders({
      askedModel: "gpt-5.2",
      landedModel: "gpt-4o-mini",
      routingReason: "baseline:chat:simple",
      costMicroCents: 5_000,
      costSavedVsAskedMicroCents: 8_000,
      toolCompressCharsSaved: 4200,
      toolCompressMicroCentsSaved: 175,
    });
    // Chars are an integer count, no decimals.
    expect(headers["X-Tokensmart-Tool-Compress-Chars-Saved"]).toBe("4200");
    // Dollars use the same 6-decimals-of-cents format as the other cost
    // headers so a single parser can handle them all.
    expect(headers["X-Tokensmart-Tool-Compress-Saved-Cents"]).toBe("0.175000");
  });

  test("compressor headers are OMITTED when savings are zero (no false-positive UX)", () => {
    // The compressor stamps a tag but, for a particular request, may
    // have ended up with zero net savings (e.g. content < min threshold,
    // unknown shape, no mutation). Don't surface a "saved $0" header —
    // it's noise and would mislead operators reading the savings hero.
    const headers = buildRoutingDecisionHeaders({
      askedModel: "gpt-5.2",
      landedModel: "gpt-5.2",
      routingReason: null,
      costMicroCents: 5_000,
      costSavedVsAskedMicroCents: 0,
      toolCompressCharsSaved: 0,
      toolCompressMicroCentsSaved: 0,
    });
    expect(headers["X-Tokensmart-Tool-Compress-Chars-Saved"]).toBeUndefined();
    expect(headers["X-Tokensmart-Tool-Compress-Saved-Cents"]).toBeUndefined();
  });

  test("compressor chars header without dollars is allowed (streaming success path)", () => {
    // On the streaming branch we know chars saved (compressor ran before
    // SSE handoff) but micro-cents may swap if failover changes the model
    // mid-stream. Verify the chars header can ship alone — operators get
    // the compression dimension visible same-trip even when pricing isn't
    // pinned yet.
    const headers = buildRoutingDecisionHeaders({
      askedModel: "gpt-5.2",
      landedModel: "gemini-2.5-flash-lite",
      routingReason: "baseline:chat:simple",
      toolCompressCharsSaved: 1_800,
    });
    expect(headers["X-Tokensmart-Tool-Compress-Chars-Saved"]).toBe("1800");
    expect(headers["X-Tokensmart-Tool-Compress-Saved-Cents"]).toBeUndefined();
  });
});
