/**
 * Coverage for the pricing JSON loader + the embedded fallback path.
 *
 * The hot-path math (`calcCostMicroCents`, family/global fallback) is
 * covered by `pricing.test.ts` already. This file specifically locks in:
 *   - JSON file is found by the dev-relative path
 *   - JSON validates and yields the same shape callers expect
 *   - A malformed JSON file degrades gracefully (returns null, not throw)
 *   - The schema rejects obviously-bad shapes
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  findPricingFile,
  loadPricingFile,
  PricingFileSchema,
} from "../src/pricing";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp = "";
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "ts-pricing-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("findPricingFile", () => {
  test("respects TOKENSMART_PRICING_FILE override", () => {
    const p = path.join(tmp, "custom.json");
    writeFileSync(
      p,
      JSON.stringify({
        entries: [
          {
            provider: "openai",
            model: "test-model",
            inputUsdPerM: 1,
            outputUsdPerM: 2,
          },
        ],
      })
    );
    const previous = process.env.TOKENSMART_PRICING_FILE;
    process.env.TOKENSMART_PRICING_FILE = p;
    try {
      expect(findPricingFile()).toBe(p);
    } finally {
      if (previous == null) delete process.env.TOKENSMART_PRICING_FILE;
      else process.env.TOKENSMART_PRICING_FILE = previous;
    }
  });

  test("returns null when override is set but file does not exist", () => {
    const previous = process.env.TOKENSMART_PRICING_FILE;
    process.env.TOKENSMART_PRICING_FILE = path.join(tmp, "no-such-file.json");
    try {
      expect(findPricingFile()).toBeNull();
    } finally {
      if (previous == null) delete process.env.TOKENSMART_PRICING_FILE;
      else process.env.TOKENSMART_PRICING_FILE = previous;
    }
  });

  test("falls through to the source-relative path when no override is set", () => {
    const previous = process.env.TOKENSMART_PRICING_FILE;
    delete process.env.TOKENSMART_PRICING_FILE;
    try {
      const found = findPricingFile();
      // The shipped data/pricing.json must be findable when running tests
      // from apps/gateway — this protects against a future refactor that
      // breaks the path-search order.
      expect(found).toBeTruthy();
      if (!found) return;
      expect(found.endsWith("data/pricing.json")).toBe(true);
    } finally {
      if (previous != null) process.env.TOKENSMART_PRICING_FILE = previous;
    }
  });
});

describe("loadPricingFile", () => {
  test("loads and validates a well-formed file", () => {
    const p = path.join(tmp, "ok.json");
    writeFileSync(
      p,
      JSON.stringify({
        entries: [
          {
            provider: "openai",
            model: "gpt-4o-mini",
            inputUsdPerM: 0.15,
            outputUsdPerM: 0.6,
            cachedInputUsdPerM: 0.075,
            source_url: "https://openai.com/api/pricing/",
            last_verified_at: "2026-04-23",
            notes: "test note",
          },
        ],
      })
    );
    const entries = loadPricingFile(p);
    expect(entries).not.toBeNull();
    if (!entries) return;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.model).toBe("gpt-4o-mini");
    expect(entries[0]?.cachedInputUsdPerM).toBe(0.075);
    expect(entries[0]?.last_verified_at).toBe("2026-04-23");
    expect(entries[0]?.notes).toBe("test note");
  });

  test("returns null on malformed JSON (does not throw)", () => {
    const p = path.join(tmp, "broken.json");
    writeFileSync(p, "{ this is not json");
    expect(loadPricingFile(p)).toBeNull();
  });

  test("returns null on schema-invalid contents", () => {
    const p = path.join(tmp, "bad-schema.json");
    writeFileSync(
      p,
      JSON.stringify({
        entries: [
          {
            provider: "openai",
            model: "gpt-4o",
            // Missing required numeric fields entirely.
          },
        ],
      })
    );
    expect(loadPricingFile(p)).toBeNull();
  });

  test("rejects an unknown provider enum value", () => {
    const p = path.join(tmp, "bad-provider.json");
    writeFileSync(
      p,
      JSON.stringify({
        entries: [
          {
            provider: "made-up-vendor",
            model: "x",
            inputUsdPerM: 1,
            outputUsdPerM: 1,
          },
        ],
      })
    );
    expect(loadPricingFile(p)).toBeNull();
  });

  test("rejects last_verified_at when it isn't YYYY-MM-DD", () => {
    const p = path.join(tmp, "bad-date.json");
    writeFileSync(
      p,
      JSON.stringify({
        entries: [
          {
            provider: "openai",
            model: "x",
            inputUsdPerM: 1,
            outputUsdPerM: 1,
            last_verified_at: "yesterday",
          },
        ],
      })
    );
    expect(loadPricingFile(p)).toBeNull();
  });
});

describe("PricingFileSchema", () => {
  test("requires at least one entry", () => {
    const r = PricingFileSchema.safeParse({ entries: [] });
    expect(r.success).toBe(false);
  });
  test("accepts optional generated_at + notes at file level", () => {
    const r = PricingFileSchema.safeParse({
      generated_at: "2026-04-23",
      notes: "hi",
      entries: [
        {
          provider: "deepseek",
          model: "deepseek-chat",
          inputUsdPerM: 0.27,
          outputUsdPerM: 1.1,
        },
      ],
    });
    expect(r.success).toBe(true);
  });
});

describe("shipped data/pricing.json", () => {
  test("the canonical pricing file is loadable end-to-end", () => {
    // This catches the most common breakage class: someone hand-edits
    // data/pricing.json and introduces a typo. The gateway's hot path
    // would silently fall back to the embedded table; we want the test
    // suite to scream first.
    const found = findPricingFile();
    expect(found).toBeTruthy();
    if (!found) return;
    const entries = loadPricingFile(found);
    expect(entries).not.toBeNull();
    if (!entries) return;
    expect(entries.length).toBeGreaterThan(5);
    // Sanity: a well-known model the test suite + e2e depends on.
    expect(entries.some((e) => e.provider === "openai" && e.model === "gpt-4o-mini")).toBe(true);
  });
});
