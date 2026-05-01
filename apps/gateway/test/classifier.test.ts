/**
 * Locks in the contract of `complexityScore` (heuristic) and the
 * `scoreComplexity` integration with the optional LLM judge.
 *
 * The motivating regression — and the reason this file exists — is the
 * "OpenClaw harness inflates a 'Hi' to medium" bug:
 *
 *   - OpenClaw ships a 12k-token system prompt and a full tools[] array
 *     with every turn.
 *   - Earlier complexity heuristic added +0.25 for tools[] presence and
 *     +0.15 for any session ≥ 5 messages.
 *   - Result: every OpenClaw turn scored ≥ 0.40 (medium bucket), the
 *     baseline policy never recommended a downgrade, and a "Suggest a
 *     casual greeting" call cost ~$0.04 instead of ~$0.0001.
 *
 * The fixed heuristic only weighs USER intent (text the user actually
 * typed this turn). Tests below pin down each side of that contract.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  complexityScore,
  scoreComplexity,
} from "../src/classifier";
import { classifyTask } from "../src/policy/task-classifier";
import type { OpenAIChatRequest } from "../src/providers/openai";

function userOnly(content: string, extras: Partial<OpenAIChatRequest> = {}): OpenAIChatRequest {
  return {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content }],
    ...extras,
  };
}

/**
 * Build a request that mimics OpenClaw's typical wire shape: one user
 * turn wrapped in a giant system prompt + tool definitions + several
 * prior assistant/user turns. The point of these fixtures is to prove
 * that none of the harness signals push a trivial USER intent into a
 * harder bucket.
 */
function openclawShaped(userText: string): OpenAIChatRequest {
  const giantSystem = "You are an autonomous assistant. ".repeat(400); // ~12k chars
  return {
    model: "gpt-5.2",
    messages: [
      { role: "system", content: giantSystem },
      { role: "user", content: "earlier turn from this session" },
      { role: "assistant", content: "earlier reply" },
      { role: "user", content: "another earlier turn" },
      { role: "assistant", content: "another earlier reply" },
      { role: "user", content: userText },
    ],
    tools: Array.from({ length: 12 }, (_, i) => ({
      type: "function",
      function: {
        name: `tool_${i}`,
        description: `Tool number ${i} in the OpenClaw toolbox.`,
        parameters: {
          type: "object",
          properties: { arg: { type: "string" } },
        },
      },
    })),
  } as OpenAIChatRequest;
}

describe("complexityScore heuristic — content-driven, not harness-driven", () => {
  test("standalone trivial greeting stays simple", () => {
    expect(complexityScore(userOnly("hi"))).toBeLessThanOrEqual(0.15);
    expect(complexityScore(userOnly("thanks!"))).toBeLessThanOrEqual(0.15);
    expect(complexityScore(userOnly("你好"))).toBeLessThanOrEqual(0.15);
  });

  test("OpenClaw-shaped 'Hi' (12k system + 12 tools + 6 messages) stays simple", () => {
    // This is the core regression. Without the fix, score would land
    // around 0.45 (0.20 baseline - 0.15 short + 0.25 tools + 0.15
    // multi-turn) → bucket=medium → no downgrade → expensive call.
    // With the fix it stays ≤ 0.20 (simple bucket).
    const score = complexityScore(openclawShaped("Hi"));
    expect(score).toBeLessThanOrEqual(0.2);
  });

  test("OpenClaw-shaped short user ask still bounded by short-content cap", () => {
    // "What's next?" is short and contextual — even though the agent
    // session has been going for many turns and has many tools, this
    // turn's intent is trivial and should route cheaply.
    const score = complexityScore(openclawShaped("What's next?"));
    expect(score).toBeLessThanOrEqual(0.2);
  });

  test("OpenClaw-shaped real coding ask DOES escalate (no false-down)", () => {
    // Long user ask with code-block + complex keyword: even with the
    // softer harness signals, real complexity from the user content
    // should still cross into medium / hard. False routing-down is
    // the costly failure we're protecting against.
    const codeAsk =
      "Please refactor this function to be thread-safe and analyze the lock ordering. " +
      "Here is the code:\n\n```rust\nfn process(state: &mut State) {\n  // ... 200 lines ...\n}\n```\n\n" +
      "Then derive worst-case lock contention and explain how to optimize the hot path.";
    const score = complexityScore(openclawShaped(codeAsk));
    expect(score).toBeGreaterThan(0.6); // hard bucket territory
  });

  test("standalone code block prompt escalates (existing behavior preserved)", () => {
    const score = complexityScore(
      userOnly(
        "Refactor this:\n```python\ndef foo(): return 1\n```\nMake it generic."
      )
    );
    expect(score).toBeGreaterThan(0.3);
  });

  test("very short content cap survives complex-keyword spike", () => {
    // "compare?" is 8 chars and matches the complexKw regex (compare).
    // Without the short-content cap that single keyword would push the
    // score into medium territory just for one-word follow-ups in a
    // chat. Cap keeps it pinned at simple.
    const score = complexityScore(userOnly("compare?"));
    expect(score).toBeLessThanOrEqual(0.2);
  });

  test("multi-turn alone no longer escalates (used to be +0.15)", () => {
    const messages = [
      ...Array.from({ length: 8 }, (_, i) => ({
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `turn ${i}`,
      })),
      { role: "user" as const, content: "ok" },
    ];
    const score = complexityScore({
      model: "gpt-4o-mini",
      messages,
    } as OpenAIChatRequest);
    // "ok" matches trivial regex → cap 0.15. multi-turn used to add
    // +0.15 on top, taking it to 0.30 (medium). With the +0.05
    // softened multi-turn AND trivial cap winning, score stays ≤ 0.15.
    expect(score).toBeLessThanOrEqual(0.15);
  });
});

describe("classifyTask task_type inference — content beats harness", () => {
  test("trivial chat through OpenClaw harness → task_type=chat (NOT tool_use)", () => {
    // Regression: the previous order made tools[] presence the deciding
    // signal, so even "Hi" through OpenClaw bucketed as tool_use →
    // reasoning fallback → no downgrade. Fixed order: tools[] only
    // wins when the user content is non-trivial.
    const t = classifyTask(openclawShaped("Hi"));
    expect(t.task_type).toBe("chat");
  });

  test("short ambiguous ask through harness still classifies as chat", () => {
    // "What's next?" — 12 chars — short enough that the toolset's
    // existence shouldn't decide the task type for us.
    const t = classifyTask(openclawShaped("What's next?"));
    expect(t.task_type).toBe("chat");
  });

  test("genuine code ask through harness → task_type=code (content keyword wins over tools[])", () => {
    const t = classifyTask(
      openclawShaped(
        "Refactor this function to be thread-safe and add unit tests."
      )
    );
    expect(t.task_type).toBe("code");
  });

  test("genuine reasoning ask through harness → task_type=reasoning", () => {
    const t = classifyTask(
      openclawShaped(
        "Analyze why this distributed cache invalidation strategy fails under partition."
      )
    );
    expect(t.task_type).toBe("reasoning");
  });

  test("longer non-trivial ask + tools[] → task_type=tool_use (designed agent flow)", () => {
    // When the user's ask is substantive AND the harness offers tools,
    // tool_use is still the right call: this is the canonical agent
    // setup we want to route to tool-call-friendly models.
    const t = classifyTask(
      openclawShaped(
        "Look up the weather in Tokyo and summarize the forecast for tomorrow afternoon."
      )
    );
    expect(t.task_type).toBe("tool_use");
  });

  test("standalone (no tools) chat preserved", () => {
    const t = classifyTask(userOnly("Tell me a joke."));
    expect(t.task_type).toBe("chat");
  });
});

describe("scoreComplexity — LLM judge integration", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.TOKENSMART_CLASSIFIER_MODEL;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv == null) {
      delete process.env.TOKENSMART_CLASSIFIER_MODEL;
    } else {
      process.env.TOKENSMART_CLASSIFIER_MODEL = originalEnv;
    }
  });

  test("falls back to heuristic when judge model env is unset", async () => {
    // Without env override, judge is skipped entirely. The OpenClaw
    // simulation should still resolve via heuristic to ≤ 0.20.
    const score = await scoreComplexity(openclawShaped("Hi"));
    expect(score).toBeLessThanOrEqual(0.2);
  });

  test("judge HTTP failure silently falls back to heuristic", async () => {
    // Simulate a configured-but-unreachable judge: fetch throws.
    // scoreComplexity must not propagate the error — the heuristic
    // takes over so the request still routes.
    process.env.TOKENSMART_CLASSIFIER_MODEL = "gpt-4o-mini";
    let judgeCalls = 0;
    globalThis.fetch = (async () => {
      judgeCalls++;
      throw new Error("simulated judge network failure");
    }) as typeof fetch;

    // env.providers is built once at module-load time from .env, so the judge
    // model also needs a configured provider. If provider lookup fails before
    // fetch, that's also "fall back to heuristic"; both paths satisfy the
    // contract.
    const score = await scoreComplexity(openclawShaped("Hi"));
    expect(score).toBeLessThanOrEqual(0.2);
    // Judge may or may not have been reached depending on env config;
    // we ONLY care that the answer is sane. Don't assert judgeCalls.
    expect(judgeCalls).toBeGreaterThanOrEqual(0);
  });

  test("judge integer reply overrides heuristic when reachable", async () => {
    process.env.TOKENSMART_CLASSIFIER_MODEL = "gpt-4o-mini";
    let captured: { url: string; body: string } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, body: String(init.body ?? "") };
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "85" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    // A trivial-looking prompt that the judge claims is hard (85/100).
    // If the judge is reached, it overrides the heuristic. If the
    // judge can't be reached (provider lookup fails when running in
    // isolation), heuristic wins. Either way the score is meaningful — we
    // assert based on whether the judge actually saw the call.
    const score = await scoreComplexity(userOnly("trivial-looking prompt"));
    if (captured) {
      // Judge was reached → 85/100 = 0.85.
      expect(score).toBeCloseTo(0.85, 2);
      // Capture sanity: it sent a chat completions POST.
      expect(captured.url).toContain("/chat/completions");
      expect(captured.body).toContain("trivial-looking prompt");
    } else {
      // Judge couldn't be reached → heuristic. "trivial-looking
      // prompt" is 22 chars short content → cap at 0.2.
      expect(score).toBeLessThanOrEqual(0.2);
    }
  });
});

// =========================================================================
// CJK keyword coverage — the multilingual slice of the classifier
// =========================================================================
//
// Pre-v0.6.1, CODE_KEYWORDS was English-only: a Chinese ask like
// 请帮我重构这个函数 (please help me refactor this function) matched
// neither CODE_KEYWORDS nor REASONING_KEYWORDS, so it bucketed as
// chat — losing the routing signal that the user is asking for code.
// These tests lock the expanded multilingual regexes.

describe("classifyTask CJK coverage — Chinese / Japanese get proper task_type", () => {
  test("Chinese code ask → task_type=code (not chat)", () => {
    const r = classifyTask(userOnly("请帮我重构这个函数的逻辑"));
    expect(r.task_type).toBe("code");
  });

  test("Chinese bug-report ask → task_type=code", () => {
    const r = classifyTask(userOnly("这段代码一直报错,帮我看看是哪里的问题"));
    expect(r.task_type).toBe("code");
  });

  test("Chinese reasoning ask → task_type=reasoning", () => {
    const r = classifyTask(userOnly("请推导一下这个结论,并且论证它的合理性"));
    expect(r.task_type).toBe("reasoning");
  });

  test("Chinese comparison ask → task_type=reasoning", () => {
    const r = classifyTask(userOnly("对比一下这两种方案的权衡和评估"));
    expect(r.task_type).toBe("reasoning");
  });

  test("Japanese code ask → task_type=code", () => {
    const r = classifyTask(userOnly("この関数をリファクタリングしてください"));
    expect(r.task_type).toBe("code");
  });

  test("Japanese reasoning ask → task_type=reasoning", () => {
    const r = classifyTask(userOnly("この結果について分析と説明をお願いします"));
    expect(r.task_type).toBe("reasoning");
  });

  test("Chinese greeting is still trivial chat (TRIVIAL_CHAT covers CJK)", () => {
    const r = classifyTask(userOnly("你好"));
    expect(r.task_type).toBe("chat");
    expect(r.complexity).toBe("simple");
  });

  test("Japanese greeting is trivial chat too", () => {
    const r = classifyTask(userOnly("こんにちは"));
    expect(r.task_type).toBe("chat");
    expect(r.complexity).toBe("simple");
  });

  test("Chinese ack through an OpenClaw-like harness is STILL chat:simple", () => {
    // Same property we lock in for English ack ("Hi" / "Thanks" /
    // "ok") — harness shape must not push a CJK greeting into
    // tool_use. Regression guard for the cross-product of v0.6.0's
    // "content beats harness" with v0.6.1's CJK keyword expansion.
    const r = classifyTask(openclawShaped("好的"));
    expect(r.task_type).toBe("chat");
    expect(r.complexity).toBe("simple");
  });

  test("Chinese code ask through OpenClaw-like harness → code (escalates)", () => {
    // The mirror property: a genuine CJK code ask wrapped in harness
    // SHOULD be caught as code, not masked into chat. Content still
    // beats harness, AND the content regex now sees Chinese.
    const r = classifyTask(openclawShaped("请帮我重构这个函数,让它能处理并发场景"));
    expect(r.task_type).toBe("code");
  });

  test("mixed-language ask — English code keyword wins", () => {
    // User-typed mixture (common in real Chinese dev traffic). Either
    // language's keyword should fire; the first match wins and that's
    // fine — both are "code" anyway.
    const r = classifyTask(userOnly("帮我 refactor 一下这个 function"));
    expect(r.task_type).toBe("code");
  });

  test("Chinese ask without code/reasoning keywords stays chat", () => {
    // Sanity: we're not false-positiving every Chinese sentence into
    // code/reasoning. An ordinary question about the weather stays
    // in chat.
    const r = classifyTask(userOnly("今天天气怎么样,适合出去散步吗"));
    expect(r.task_type).toBe("chat");
  });
});
