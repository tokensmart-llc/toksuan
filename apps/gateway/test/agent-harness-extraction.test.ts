/**
 * v0.6.6 — pin the v0.6.0 follow-up: classifier extracts user intent
 * correctly from (a) OpenAI multi-modal content arrays + (b) prepended
 * agent-harness wrappers. Pre-fix, OpenClaw's `[{"text":"你是谁?",
 * "type":"text"}]` wrapped a 4-char user intent into a 50+-char string,
 * defeated the < 30 trivial cap + TRIVIAL_CHAT regex, was misclassified
 * as `tool_use:medium`, fell through to reasoning:medium, and refused
 * to downgrade. This file pins the contract that "real intent" is what
 * the classifier sees.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL ?? ":memory:";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "sk-test-fixture";

import { describe, expect, test } from "bun:test";
import {
  extractTextFromContent,
  extractUserIntent,
  classifyTask,
} from "../src/policy";
import { complexityScore } from "../src/classifier";
import type { OpenAIChatRequest } from "../src/providers/openai";

// =========================================================================
// extractTextFromContent — multi-modal content array parsing
// =========================================================================

describe("extractTextFromContent (v0.6.6 multi-modal-aware)", () => {
  test("string content passes through unchanged", () => {
    expect(extractTextFromContent("hello")).toBe("hello");
    expect(extractTextFromContent("")).toBe("");
  });

  test("vision-mode array with single text part returns the text", () => {
    // The OpenClaw shape we hit in production:
    //   [{"text":"[Fri 2026-04-24 16:00 PDT] 你是谁?","type":"text"}]
    // Pre-fix this stringified to a 50+-char wrapped string; post-fix
    // we pull out the actual text.
    const content = [{ text: "[Fri 2026-04-24 16:00 PDT] 你是谁?", type: "text" }];
    expect(extractTextFromContent(content)).toBe(
      "[Fri 2026-04-24 16:00 PDT] 你是谁?"
    );
  });

  test("vision-mode array with multiple text parts joins with newline", () => {
    const content = [
      { text: "First part.", type: "text" },
      { text: "Second part.", type: "text" },
    ];
    expect(extractTextFromContent(content)).toBe("First part.\nSecond part.");
  });

  test("vision-mode array drops image_url / non-text parts", () => {
    const content = [
      { text: "Describe this image:", type: "text" },
      { type: "image_url", image_url: { url: "data:image/png;base64,..." } },
    ];
    expect(extractTextFromContent(content)).toBe("Describe this image:");
  });

  test("Anthropic-style {value} field is also recognized", () => {
    const content = [{ type: "text", value: "via the value field" }];
    expect(extractTextFromContent(content)).toBe("via the value field");
  });

  test("array with NO text parts (image-only) falls back to JSON for keyword scan", () => {
    const content = [
      { type: "image_url", image_url: { url: "data:image/png;base64,..." } },
    ];
    // We don't pin the exact stringification — just that it doesn't
    // throw and returns something non-empty so keyword regexes have
    // *some* signal. Length-based heuristics in the caller are the
    // ones that have to be defensive about a worst-case empty intent.
    const result = extractTextFromContent(content);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("plain string element in array works too (some SDKs do this)", () => {
    const content = ["bare string in array"];
    expect(extractTextFromContent(content)).toBe("bare string in array");
  });

  test("null / undefined content yields empty string", () => {
    expect(extractTextFromContent(null)).toBe("");
    expect(extractTextFromContent(undefined)).toBe("");
  });

  test("non-array non-string content (object) falls back to JSON", () => {
    const content = { unexpected: "shape" };
    const result = extractTextFromContent(content);
    expect(typeof result).toBe("string");
    expect(result).toContain("unexpected");
  });
});

// =========================================================================
// extractUserIntent — agent-harness wrapper strip
// =========================================================================

describe("extractUserIntent (v0.6.6 wrapper strip)", () => {
  test("single-line text passes through unchanged (no wrapper)", () => {
    expect(extractUserIntent("你好")).toBe("你好");
    expect(extractUserIntent("Write a function isPrime")).toBe(
      "Write a function isPrime"
    );
  });

  test("single-paragraph multi-line text passes through unchanged", () => {
    const text =
      "Write a function isPrime\nthat takes an int and returns bool.\nUse trial division.";
    expect(extractUserIntent(text)).toBe(text);
  });

  test("LangChain-style wrapper + short intent is stripped to intent", () => {
    const wrapped =
      "You are a helpful assistant. Use the following tools: weather, calculator.\nWhen the user asks X, do Y. Always reply in markdown.\n\n你是谁?";
    expect(extractUserIntent(wrapped)).toBe("你是谁?");
  });

  test("wrapper + multi-line intent strips to the trailing paragraph", () => {
    const wrapped =
      "[System: agent identity loaded]\nUse tools sparingly.\n\nWrite a function isPrime\nthat returns bool.";
    expect(extractUserIntent(wrapped)).toBe(
      "Write a function isPrime\nthat returns bool."
    );
  });

  test("wrapper + LONG intent (real complex ask) keeps full text — strip would mis-classify a real long ask", () => {
    const wrapper = "You are a helpful agent.\nUse tools when relevant.\n\n";
    const longIntent = "Analyze the trade-offs between A and B. ".repeat(20); // ~800 chars
    const full = wrapper + longIntent;
    // Trailing paragraph is > 500 chars → keep full text. Classifier
    // sees the long ask + the wrapper, which is fine: long real asks
    // SHOULD weight as long.
    expect(extractUserIntent(full)).toBe(full.trim());
  });

  test("empty / whitespace input is preserved (no crash)", () => {
    expect(extractUserIntent("")).toBe("");
    expect(extractUserIntent("   \n\n  ")).toBe("");
  });

  test("trailing-paragraph-only when there are MULTIPLE wrapper paragraphs", () => {
    const wrapped =
      "Section 1: identity\n你是 helpful agent.\n\n" +
      "Section 2: tools\nweather, calc.\n\n" +
      "Section 3: rules\nReply in English.\n\n" +
      "你好";
    expect(extractUserIntent(wrapped)).toBe("你好");
  });

  test("strips OpenClaw timestamp prefix `[Fri 2026-04-24 16:00 PDT]`", () => {
    expect(extractUserIntent("[Fri 2026-04-24 16:00 PDT] 你是谁?")).toBe(
      "你是谁?"
    );
    expect(
      extractUserIntent("[Mon 2026-12-31 23:59:59 EST] hi")
    ).toBe("hi");
  });

  test("strips bracket tag prefix `[Bootstrap pending]\\n directives \\n\\n intent`", () => {
    const wrapped =
      "[Bootstrap pending]\nPlease read BOOTSTRAP.md first.\n\n你好";
    // Bracket-line gets peeled, then trailing-paragraph rule picks up "你好".
    // (The middle line is part of the now-single-paragraph stripped text,
    // separated from "你好" by the blank line.)
    expect(extractUserIntent(wrapped)).toBe("你好");
  });

  test("strips XML system_context prefix", () => {
    const wrapped =
      "<system_context>You are a helper. Tools: x, y.</system_context>\n你好";
    expect(extractUserIntent(wrapped)).toBe("你好");
  });

  test("stacked prefixes (timestamp + bracket tag) all peel", () => {
    const wrapped =
      "[Fri 2026-04-24 16:00 PDT] [Persona helpful]\nReply in markdown.\n\nWrite a function isPrime";
    expect(extractUserIntent(wrapped)).toBe("Write a function isPrime");
  });
});

// =========================================================================
// End-to-end: classifyTask on the EXACT openclaw wire shape we hit
// in production (the bug repro).
// =========================================================================

describe("classifyTask — pre-v0.6.6 OpenClaw repro is now classified correctly", () => {
  /**
   * Real wire shape we captured from production:
   *   role=user content=[{"text":"[Fri 2026-04-24 16:00 PDT] 你是谁?","type":"text"}]
   *   tools=[{type:"function",function:{name:"weather",...}}, …]
   * Pre-fix this was tagged tool_use because:
   *   - extractLastUserText JSON.stringify'd the array → 58 chars
   *   - 58 ≥ 30 → trivialChat=false
   *   - tools[] non-empty → tool_use
   * Post-fix:
   *   - extractTextFromContent pulls "[Fri 2026-04-24 16:00 PDT] 你是谁?" (29 chars)
   *   - 29 < 30 → trivialChat=true
   *   - despite tools[] being non-empty → falls through to chat
   */
  test("vision-mode array short user text + tools[] → chat (not tool_use)", () => {
    const body: OpenAIChatRequest = {
      model: "gpt-5.2",
      messages: [
        { role: "system", content: "Long system prompt with skills + identity + bootstrap…" },
        {
          role: "user",
          content: [
            { text: "[Fri 2026-04-24 16:00 PDT] 你是谁?", type: "text" },
          ],
        },
      ],
      tools: [
        { type: "function", function: { name: "weather", description: "get weather", parameters: { type: "object" } } },
        { type: "function", function: { name: "calculator", description: "do math", parameters: { type: "object" } } },
      ],
    };

    const cls = classifyTask(body);
    expect(cls.task_type).toBe("chat");
    expect(cls.complexity).toBe("simple");
  });

  test("vision-mode array LONG user ask + tools[] → tool_use (regression — long ask still tool_use)", () => {
    const body: OpenAIChatRequest = {
      model: "gpt-5.2",
      messages: [
        {
          role: "user",
          content: [
            {
              text: "Use the weather tool to look up SF, then use the calculator tool to add 7 days of forecasts. Show me your work.",
              type: "text",
            },
          ],
        },
      ],
      tools: [
        { type: "function", function: { name: "weather", description: "get weather", parameters: { type: "object" } } },
      ],
    };

    const cls = classifyTask(body);
    expect(cls.task_type).toBe("tool_use");
  });

  test("string content short greeting + tools[] → chat (regression: pre-fix already worked, must not break)", () => {
    const body: OpenAIChatRequest = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "weather", description: "get weather", parameters: { type: "object" } } },
      ],
    };
    const cls = classifyTask(body);
    expect(cls.task_type).toBe("chat");
    expect(cls.complexity).toBe("simple");
  });

  test("LangChain-style wrapper-in-user + short intent → chat:simple", () => {
    const body: OpenAIChatRequest = {
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content:
            "You are a helpful agent. Use the following tools: weather, calc.\nReply concisely.\n\n你好",
        },
      ],
      tools: [
        { type: "function", function: { name: "weather", description: "get weather", parameters: { type: "object" } } },
      ],
    };
    const cls = classifyTask(body);
    expect(cls.task_type).toBe("chat");
    expect(cls.complexity).toBe("simple");
  });
});

// =========================================================================
// complexityScore — same fix has to apply here too
// =========================================================================

describe("complexityScore — multi-modal-aware + intent-aware (v0.6.6)", () => {
  test("vision-mode array short user text scores as trivial / simple", () => {
    const body: OpenAIChatRequest = {
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [{ text: "你是谁?", type: "text" }],
        },
      ],
    };
    // 4-char Chinese — should score very low. Pre-fix this scored
    // ~0.05 because the wrapped 30-char JSON string skipped the
    // < 30 cap, giving a baseline near 0.2. Post-fix len=4 < 30 →
    // -0.15 → score = 0.05.
    expect(complexityScore(body)).toBeLessThan(0.25);
  });

  test("string short greeting scores trivial (regression — must not break)", () => {
    const body: OpenAIChatRequest = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    };
    expect(complexityScore(body)).toBeLessThan(0.25);
  });

  test("genuine long single-paragraph ask scores high (no false strip)", () => {
    const body: OpenAIChatRequest = {
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content:
            "Implement a binary search tree with insert, delete, and in-order traversal. " +
            "Include unit tests. " +
            "Optimize for cache locality. ".repeat(15),
        },
      ],
    };
    expect(complexityScore(body)).toBeGreaterThan(0.5);
  });
});
