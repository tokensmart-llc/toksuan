/**
 * Unit tests for compression modes (M3): off / audit / optimize.
 *
 * Contract:
 *   - buildPolicyFromEnv resolves mode from TOKENSMART_CONTEXT_COMPRESS_MODE,
 *     falling back to the legacy TOKENSMART_TOOL_COMPRESS_ENABLED switch.
 *   - compressContextMessages:
 *       off      → passthrough (same array ref, no measurement)
 *       audit    → original messages returned, but result measures the
 *                  potential savings (applied=false, totalCharsSaved>0)
 *       optimize → messages actually rewritten (applied=true)
 *   - resolveRequestMode: a per-call header can only DOWNGRADE.
 */

import { describe, expect, test } from "bun:test";
import {
  buildPolicyFromEnv,
  compressContextMessages,
  resolveRequestMode,
  DEFAULT_POLICY,
  type CompressionPolicy,
} from "../src/compression";

const BIG = "x".repeat(4000);

function toolMsg(content: string) {
  return [{ role: "tool", content, tool_call_id: "t1" }];
}

describe("buildPolicyFromEnv — modes", () => {
  test("no env → off, disabled", () => {
    const p = buildPolicyFromEnv({});
    expect(p.mode).toBe("off");
    expect(p.enabled).toBe(false);
  });

  test("legacy TOKENSMART_TOOL_COMPRESS_ENABLED=1 → optimize", () => {
    const p = buildPolicyFromEnv({ TOKENSMART_TOOL_COMPRESS_ENABLED: "1" });
    expect(p.mode).toBe("optimize");
    expect(p.enabled).toBe(true);
  });

  test("TOKENSMART_CONTEXT_COMPRESS_MODE=audit → audit, not enabled", () => {
    const p = buildPolicyFromEnv({ TOKENSMART_CONTEXT_COMPRESS_MODE: "audit" });
    expect(p.mode).toBe("audit");
    expect(p.enabled).toBe(false);
  });

  test("TOKENSMART_CONTEXT_COMPRESS_MODE wins over the legacy switch", () => {
    const p = buildPolicyFromEnv({
      TOKENSMART_CONTEXT_COMPRESS_MODE: "off",
      TOKENSMART_TOOL_COMPRESS_ENABLED: "1",
    });
    expect(p.mode).toBe("off");
    expect(p.enabled).toBe(false);
  });

  test("smart-crush + store knobs parse", () => {
    const p = buildPolicyFromEnv({
      TOKENSMART_CONTEXT_COMPRESS_MODE: "optimize",
      TOKENSMART_CONTEXT_COMPRESS_MIN_ITEMS: "25",
      TOKENSMART_CONTEXT_COMPRESS_MAX_ITEMS: "40",
      TOKENSMART_CONTEXT_COMPRESS_STORE: "1",
      TOKENSMART_CONTEXT_COMPRESS_CRUSH_JSON: "0",
    });
    expect(p.smartCrushMinItems).toBe(25);
    expect(p.smartCrushMaxItems).toBe(40);
    expect(p.store).toBe(true);
    expect(p.crushJson).toBe(false);
  });
});

describe("compressContextMessages — mode behavior", () => {
  const policy: CompressionPolicy = {
    ...DEFAULT_POLICY,
    maxCompressedChars: 200,
    minMessageChars: 200,
  };

  test("off: passthrough, same array reference, no measurement", () => {
    const messages = toolMsg(BIG);
    const out = compressContextMessages(messages, policy, "off");
    expect(out.messages).toBe(messages);
    expect(out.result.applied).toBe(false);
    expect(out.result.totalCharsSaved).toBe(0);
    expect(out.result.mode).toBe("off");
  });

  test("audit: measures savings but does NOT rewrite the prompt", () => {
    const messages = toolMsg(BIG);
    const out = compressContextMessages(messages, policy, "audit");
    // Original messages returned untouched.
    expect(out.messages).toBe(messages);
    expect((out.messages[0].content as string).length).toBe(4000);
    // But the measurement reflects what WOULD have been saved.
    expect(out.result.applied).toBe(false);
    expect(out.result.totalCharsSaved).toBeGreaterThan(0);
    expect(out.result.perMessage.length).toBe(1);
    expect(out.result.mode).toBe("audit");
  });

  test("optimize: actually rewrites the tool message", () => {
    const messages = toolMsg(BIG);
    const out = compressContextMessages(messages, policy, "optimize");
    expect(out.messages).not.toBe(messages);
    expect((out.messages[0].content as string).length).toBeLessThan(4000);
    expect(out.result.applied).toBe(true);
    expect(out.result.totalCharsSaved).toBeGreaterThan(0);
    expect(out.result.mode).toBe("optimize");
    // Input array untouched.
    expect((messages[0].content as string).length).toBe(4000);
  });
});

describe("resolveRequestMode — header can only downgrade", () => {
  test("off policy stays off regardless of header", () => {
    expect(resolveRequestMode("off", "optimize")).toBe("off");
  });

  test("optimize policy + no header → optimize", () => {
    expect(resolveRequestMode("optimize", null)).toBe("optimize");
    expect(resolveRequestMode("optimize", "")).toBe("optimize");
  });

  test("optimize policy + off header → off", () => {
    expect(resolveRequestMode("optimize", "off")).toBe("off");
    expect(resolveRequestMode("optimize", "0")).toBe("off");
    expect(resolveRequestMode("optimize", "false")).toBe("off");
  });

  test("optimize policy + audit header → audit (downgrade)", () => {
    expect(resolveRequestMode("optimize", "audit")).toBe("audit");
  });

  test("audit policy + optimize header → audit (no upgrade)", () => {
    expect(resolveRequestMode("audit", "optimize")).toBe("audit");
  });
});
