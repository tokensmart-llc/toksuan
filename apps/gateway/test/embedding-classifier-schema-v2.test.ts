/**
 * v0.6.7 — embedding-classifier extraction migration + schema bump.
 *
 * Closes the v0.6.6 follow-up tracked at the top of `policy/
 * embedding-classifier.ts`. Two coupled changes:
 *
 *   1. `extractLastUserText` (used by `encodeRequest`) now delegates
 *      to the v0.6.6 `extractTextFromContent` + `extractUserIntent`
 *      helpers from `task-classifier.ts`. The encoder now sees the
 *      same input the heuristic + LLM-judge classifier sees: peeled
 *      multi-modal content arrays + stripped harness wrappers.
 *
 *   2. `ClassifierArtifact.schema_version` bumped from `1` → `2`.
 *      Pre-v0.6.7 artifacts trained against the legacy verbatim
 *      JSON.stringify extraction are now REJECTED by the loader so
 *      operators upgrading the gateway without retraining fall back
 *      to the heuristic + LLM-judge path (clean degradation) instead
 *      of getting silently-stale predictions.
 *
 * This file pins both contracts.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL ?? ":memory:";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "sk-test-fixture";

import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_SCHEMA_VERSION,
  describeStaleArtifactReason,
  encodeRequest,
  DEFAULT_ENCODER_CONFIG,
} from "../src/policy";
import type { OpenAIChatRequest } from "../src/providers/openai";

// =========================================================================
// Schema constant + describeStaleArtifactReason
// =========================================================================

describe("ARTIFACT_SCHEMA_VERSION (v0.6.7)", () => {
  test("current schema_version is 2", () => {
    // Bumped from 1 in v0.6.7 to force-retrain artifacts trained
    // against the legacy verbatim-stringify extractor. Whenever the
    // extractor or encoder feature shape changes incompatibly,
    // bump this AND the loader-side check in lockstep.
    expect(ARTIFACT_SCHEMA_VERSION).toBe(2);
  });
});

describe("describeStaleArtifactReason — diagnostic emitter", () => {
  test("v=1 artifact returns a 'force retrain' message that names the CLI", () => {
    const stale = describeStaleArtifactReason({ schema_version: 1 });
    expect(stale).not.toBeNull();
    expect(stale).toContain("schema_version=1");
    expect(stale).toContain("schema_version=2");
    // The exact CLI invocation is part of the contract — operators
    // copy-paste from log lines into their terminal. Pin the
    // command.
    expect(stale).toContain("bun run train-embedding-classifier");
  });

  test("current-schema artifact returns null (nothing to complain about)", () => {
    expect(
      describeStaleArtifactReason({ schema_version: ARTIFACT_SCHEMA_VERSION })
    ).toBeNull();
  });

  test("future schema (v=3 hypothetical) returns null (forward-tolerant — operator probably knows what they're doing)", () => {
    // We deliberately don't WARN on a future schema — that's a
    // distinct upgrade scenario; the loader will still reject via
    // isArtifactShape, but the diagnostic message should focus on
    // the common case (operator hasn't retrained yet).
    expect(describeStaleArtifactReason({ schema_version: 3 })).toBeNull();
  });

  test("missing/invalid schema_version returns null (not the right diagnostic — caller handles via isArtifactShape's generic path)", () => {
    expect(describeStaleArtifactReason({})).toBeNull();
    expect(
      describeStaleArtifactReason({ schema_version: "1" /* string, not number */ })
    ).toBeNull();
    expect(describeStaleArtifactReason(null)).toBeNull();
    expect(describeStaleArtifactReason(undefined)).toBeNull();
  });
});

// =========================================================================
// encodeRequest delegates to the shared v0.6.6 extractors
// =========================================================================
//
// We can't easily peek inside the encoder at the extracted text (the
// encoder hashes it into a Float32Array immediately), but we can
// observe the SAME-extraction property: two requests whose user text
// becomes identical after extraction produce IDENTICAL feature
// vectors. Pre-v0.6.7 they would've diverged because the legacy
// extractor JSON.stringify'd one shape and string-passed-through the
// other.

function vectorsEqual(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > 1e-6) return false;
  }
  return true;
}

function encode(body: OpenAIChatRequest): Float32Array {
  return encodeRequest(body, DEFAULT_ENCODER_CONFIG);
}

describe("encodeRequest extraction policy (v0.6.7)", () => {
  test("multi-modal vision-mode array unwraps to the same vector as the equivalent string", () => {
    // The OpenClaw + OpenAI v2 SDK + Vercel AI SDK + LangChain shape
    // — pre-v0.6.7 the array was JSON.stringify'd into the encoder,
    // producing different features than the equivalent plain string.
    const fromArray = encode({
      model: "gpt-fake",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "你是谁?" }],
        },
      ],
    } as OpenAIChatRequest);
    const fromString = encode({
      model: "gpt-fake",
      messages: [{ role: "user", content: "你是谁?" }],
    });
    expect(vectorsEqual(fromArray, fromString)).toBe(true);
  });

  test("Anthropic's `value` field shape is also unwrapped", () => {
    const fromValueShape = encode({
      model: "gpt-fake",
      messages: [
        {
          role: "user",
          content: [{ type: "text", value: "Write a haiku" }],
        },
      ],
    } as OpenAIChatRequest);
    const fromString = encode({
      model: "gpt-fake",
      messages: [{ role: "user", content: "Write a haiku" }],
    });
    expect(vectorsEqual(fromValueShape, fromString)).toBe(true);
  });

  test("noise prefix (timestamp, bracket tag) gets stripped before encoding", () => {
    // OpenClaw's `[Fri 2026-04-24 16:00 PDT] 你是谁?` shape — the
    // timestamp inflates length past the trivial cap and contributes
    // a chunk of bucket activations that have nothing to do with the
    // user's intent. Post-v0.6.7 the encoder sees just `你是谁?`.
    const withTimestamp = encode({
      model: "gpt-fake",
      messages: [
        {
          role: "user",
          content: "[Fri 2026-04-24 16:00 PDT] 你是谁?",
        },
      ],
    });
    const withoutTimestamp = encode({
      model: "gpt-fake",
      messages: [{ role: "user", content: "你是谁?" }],
    });
    expect(vectorsEqual(withTimestamp, withoutTimestamp)).toBe(true);
  });

  test("wrapper-in-user-message + short trailing intent collapses to the intent", () => {
    // LangChain-style wrapper-in-user-message: a chunk of system
    // instructions, blank line, then the actual short ask. Post-
    // v0.6.7 the encoder sees just the trailing intent (matches
    // `extractUserIntent`'s 80-char trailing-paragraph rule).
    const wrapped = encode({
      model: "gpt-fake",
      messages: [
        {
          role: "user",
          content:
            "You are a helpful assistant. Use the tools below to answer questions.\n\nHi",
        },
      ],
    });
    const intentOnly = encode({
      model: "gpt-fake",
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(vectorsEqual(wrapped, intentOnly)).toBe(true);
  });

  test("multi-paragraph genuine user content (with code fence) is NOT collapsed", () => {
    // Safety guard from `extractUserIntent`: a code fence anywhere
    // in the message means the whole thing is intent. Encoder
    // should see the full text, NOT just the trailing paragraph.
    const fullContent =
      "Please refactor this fn:\n\n```rust\nfn main() {}\n```\n\nDerive lock order";
    const trailingOnly = "Derive lock order";
    const fromFull = encode({
      model: "gpt-fake",
      messages: [{ role: "user", content: fullContent }],
    });
    const fromTrailing = encode({
      model: "gpt-fake",
      messages: [{ role: "user", content: trailingOnly }],
    });
    // These should NOT be equal — the code-fence guard preserves the
    // whole content.
    expect(vectorsEqual(fromFull, fromTrailing)).toBe(false);
  });

  test("long genuine multi-paragraph content (≥ 80-char trailing paragraph) is NOT collapsed", () => {
    // Calibration anchor: real user descriptions have ≥ 80-char
    // trailing paragraphs and stay un-stripped. Pin the encoder
    // honors that.
    const fullContent =
      "Background: I've been investigating a regression in the cache layer.\n\n" +
      "Specifically, requests above 16KB body sizes evict valid entries that " +
      "were inserted seconds ago, even though their TTL hasn't expired yet. " +
      "Could you walk me through the eviction policy implementation?";
    const trailingOnly =
      "Specifically, requests above 16KB body sizes evict valid entries that " +
      "were inserted seconds ago, even though their TTL hasn't expired yet. " +
      "Could you walk me through the eviction policy implementation?";
    const fromFull = encode({
      model: "gpt-fake",
      messages: [{ role: "user", content: fullContent }],
    });
    const fromTrailing = encode({
      model: "gpt-fake",
      messages: [{ role: "user", content: trailingOnly }],
    });
    // Trailing paragraph is itself > 80 chars → NOT collapsed →
    // encoder sees both paragraphs in the full case, only the trail
    // in the trailing-only case → vectors must differ.
    expect(vectorsEqual(fromFull, fromTrailing)).toBe(false);
  });
});
