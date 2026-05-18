/**
 * Unit tests for tool-result-compressor.
 *
 * The compressor's behavior contract:
 *   1. With policy.enabled = false, it's a no-op (input array reference
 *      returned unchanged).
 *   2. Only role === "tool" / "function" messages are ever rewritten.
 *   3. Detection is conservative — under the minMessageChars floor or
 *      with no detector match, content is left alone (no silent
 *      truncation of small messages).
 *   4. All filters are deterministic + idempotent: running compressor
 *      twice on the same content returns identical bytes both times.
 *      This matters because fingerprinting runs AFTER compression in
 *      chat.ts and a non-deterministic compressor would tank loop
 *      detection accuracy.
 *   5. Per-tool exclusion via the `name` field bypasses compression
 *      entirely for that message — the per-call escape hatch.
 */

import { describe, expect, test } from "bun:test";
import {
  buildPolicyFromEnv,
  compressContent,
  compressMessages,
  detectShape,
  DEFAULT_POLICY,
  estimateTokensFromChars,
  type CompressionPolicy,
} from "../src/tool-result-compressor";

const ENABLED_POLICY: CompressionPolicy = {
  ...DEFAULT_POLICY,
  enabled: true,
};

describe("buildPolicyFromEnv", () => {
  test("disabled when env flag missing", () => {
    const p = buildPolicyFromEnv({});
    expect(p.enabled).toBe(false);
  });

  test("disabled when env flag set to anything but '1'", () => {
    expect(buildPolicyFromEnv({ TOKENSMART_TOOL_COMPRESS_ENABLED: "0" }).enabled).toBe(false);
    expect(buildPolicyFromEnv({ TOKENSMART_TOOL_COMPRESS_ENABLED: "true" }).enabled).toBe(false);
    expect(buildPolicyFromEnv({ TOKENSMART_TOOL_COMPRESS_ENABLED: "" }).enabled).toBe(false);
  });

  test("enabled when env flag is '1'", () => {
    const p = buildPolicyFromEnv({ TOKENSMART_TOOL_COMPRESS_ENABLED: "1" });
    expect(p.enabled).toBe(true);
    expect(p.minMessageChars).toBe(500);
    expect(p.maxCompressedChars).toBe(4000);
    expect(p.stripAnsi).toBe(true);
    expect(p.dedupeLines).toBe(true);
  });

  test("respects min/max overrides", () => {
    const p = buildPolicyFromEnv({
      TOKENSMART_TOOL_COMPRESS_ENABLED: "1",
      TOKENSMART_TOOL_COMPRESS_MIN_MESSAGE_CHARS: "1000",
      TOKENSMART_TOOL_COMPRESS_MAX_COMPRESSED_CHARS: "2000",
    });
    expect(p.minMessageChars).toBe(1000);
    expect(p.maxCompressedChars).toBe(2000);
  });

  test("rejects bogus numeric overrides and falls back to defaults", () => {
    const p = buildPolicyFromEnv({
      TOKENSMART_TOOL_COMPRESS_ENABLED: "1",
      TOKENSMART_TOOL_COMPRESS_MIN_MESSAGE_CHARS: "not-a-number",
      TOKENSMART_TOOL_COMPRESS_MAX_COMPRESSED_CHARS: "-50",
    });
    expect(p.minMessageChars).toBe(500);
    expect(p.maxCompressedChars).toBe(4000);
  });

  test("excludeToolNames is parsed + lower-cased", () => {
    const p = buildPolicyFromEnv({
      TOKENSMART_TOOL_COMPRESS_ENABLED: "1",
      TOKENSMART_TOOL_COMPRESS_EXCLUDE_TOOLS: "Search_Web, Vision-Describe ,",
    });
    expect(p.excludeToolNames.has("search_web")).toBe(true);
    expect(p.excludeToolNames.has("vision-describe")).toBe(true);
    expect(p.excludeToolNames.size).toBe(2);
  });

  test("flag overrides toggle stripAnsi / dedupeLines", () => {
    const p = buildPolicyFromEnv({
      TOKENSMART_TOOL_COMPRESS_ENABLED: "1",
      TOKENSMART_TOOL_COMPRESS_STRIP_ANSI: "0",
      TOKENSMART_TOOL_COMPRESS_DEDUP_LINES: "false",
    });
    expect(p.stripAnsi).toBe(false);
    expect(p.dedupeLines).toBe(false);
  });
});

describe("detectShape", () => {
  test("git_status", () => {
    const text = [
      "On branch develop",
      "Your branch is up to date with 'origin/develop'.",
      "",
      "Changes not staged for commit:",
      "  (use \"git add <file>...\" to update what will be committed)",
      "        modified:   src/foo.ts",
      "        modified:   src/bar.ts",
      "",
      "Untracked files:",
      "  (use \"git add <file>...\" to include in what will be committed)",
      "        notes.txt",
    ].join("\n");
    expect(detectShape(text)).toBe("git_status");
  });

  test("git_diff", () => {
    const text = [
      "diff --git a/foo.ts b/foo.ts",
      "index 0123456..abcdef0 100644",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,3 +1,3 @@",
      "-old line",
      "+new line",
    ].join("\n");
    expect(detectShape(text)).toBe("git_diff");
  });

  test("shell_listing (ls -l style)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      lines.push(`-rw-r--r--  1 user staff ${i * 100} Jan  1 12:34 file_${i}.ts`);
    }
    expect(detectShape(lines.join("\n"))).toBe("shell_listing");
  });

  test("stack_trace (python)", () => {
    const text = [
      'Traceback (most recent call last):',
      '  File "/app/main.py", line 12, in <module>',
      '    main()',
      '  File "/app/main.py", line 7, in main',
      '    foo()',
      '  File "/app/lib.py", line 4, in foo',
      '    raise ValueError("nope")',
      'ValueError: nope',
    ].join("\n");
    expect(detectShape(text)).toBe("stack_trace");
  });

  test("stack_trace (node)", () => {
    const text = [
      "Error: ECONNREFUSED",
      "    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1234)",
      "    at process.processTicksAndRejections (node:internal/process/task_queues:96)",
      "    at async fetchData (/app/src/api.ts:42:10)",
      "    at async main (/app/src/index.ts:8:3)",
    ].join("\n");
    expect(detectShape(text)).toBe("stack_trace");
  });

  test("json_logs", () => {
    const text = [
      '{"level":"info","msg":"started"}',
      '{"level":"info","msg":"connected"}',
      '{"level":"warn","msg":"slow query","ms":4200}',
      '{"level":"info","msg":"ok"}',
      '{"level":"error","msg":"db conn lost"}',
    ].join("\n");
    expect(detectShape(text)).toBe("json_logs");
  });

  test("ansi_text fallback when nothing else matches", () => {
    const text = "\u001b[31mhello\u001b[0m world\n".repeat(20);
    expect(detectShape(text)).toBe("ansi_text");
  });

  test("unknown for plain prose", () => {
    expect(detectShape("This is just a sentence without any special structure.")).toBe(
      "unknown"
    );
  });
});

describe("compressContent", () => {
  test("disabled policy is a no-op", () => {
    const text = "x".repeat(10_000);
    const r = compressContent(text, DEFAULT_POLICY);
    expect(r.content).toBe(text);
  });

  test("under-min-chars content is left alone even when enabled", () => {
    const text = "small content";
    const r = compressContent(text, ENABLED_POLICY);
    expect(r.content).toBe(text);
  });

  test("strips ANSI escape codes", () => {
    const text = "\u001b[31mERROR\u001b[0m: something failed\n".repeat(80); // ~2.4k chars
    const r = compressContent(text, ENABLED_POLICY);
    expect(r.content).not.toContain("\u001b[");
  });

  test("dedupes consecutive identical lines into a count marker", () => {
    const text =
      "header\n" +
      Array(200).fill("repeated log line").join("\n") +
      "\nfooter\n";
    const r = compressContent(text, ENABLED_POLICY);
    expect(r.content).toContain("(×200)");
    expect(r.content.length).toBeLessThan(text.length);
  });

  test("git_status compresses to summary + headers", () => {
    const lines: string[] = [
      "On branch develop",
      "Your branch is up to date with 'origin/develop'.",
      "",
      "Changes to be committed:",
      '  (use "git restore --staged <file>..." to unstage)',
    ];
    for (let i = 0; i < 30; i++) lines.push(`        modified:   src/file_${i}.ts`);
    lines.push("");
    lines.push("Untracked files:");
    lines.push('  (use "git add <file>..." to include in what will be committed)');
    for (let i = 0; i < 10; i++) lines.push(`        notes_${i}.txt`);
    const text = lines.join("\n");

    expect(text.length).toBeGreaterThan(ENABLED_POLICY.minMessageChars);
    const r = compressContent(text, ENABLED_POLICY);
    expect(r.shape).toBe("git_status");
    expect(r.content).toContain("On branch develop");
    expect(r.content).toContain("30 staged");
    expect(r.content).toContain("10 untracked");
    expect(r.content.length).toBeLessThan(text.length);
  });

  test("git_diff keeps headers but elides body when over budget", () => {
    const sections: string[] = [];
    for (let f = 0; f < 5; f++) {
      sections.push(`diff --git a/file_${f}.ts b/file_${f}.ts`);
      sections.push("index abc..def 100644");
      sections.push(`--- a/file_${f}.ts`);
      sections.push(`+++ b/file_${f}.ts`);
      sections.push("@@ -1,5 +1,5 @@");
      for (let i = 0; i < 200; i++) sections.push(`-old line ${i}`);
      for (let i = 0; i < 200; i++) sections.push(`+new line ${i}`);
    }
    const text = sections.join("\n");

    const r = compressContent(text, ENABLED_POLICY);
    expect(r.shape).toBe("git_diff");
    expect(r.content).toContain("diff --git a/file_0.ts");
    expect(r.content).toContain("diff --git a/file_4.ts");
    expect(r.content).toContain("more diff lines elided");
    expect(r.content.length).toBeLessThan(text.length);
  });

  test("stack_trace keeps head + tail and elides middle frames", () => {
    const lines = ["Error: oops"];
    for (let i = 0; i < 80; i++) {
      lines.push(`    at frame_${i} (/app/src/file_${i}.ts:${i + 1}:${i + 1})`);
    }
    const text = lines.join("\n");

    const r = compressContent(text, ENABLED_POLICY);
    expect(r.shape).toBe("stack_trace");
    expect(r.content).toContain("Error: oops");
    expect(r.content).toContain("at frame_0");
    expect(r.content).toContain("frames elided");
    expect(r.content.length).toBeLessThan(text.length);
  });

  test("json_logs bucket by level when lines differ in content", () => {
    // Realistic case: same level repeats but each line has a unique
    // timestamp/request-id so the cheap consecutive-dedup pass can't
    // collapse them. The level-bucketer is what does the work here.
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`{"level":"info","msg":"step ok","i":${i}}`);
    }
    for (let i = 0; i < 30; i++) {
      lines.push(`{"level":"warn","msg":"slow","ms":${i + 1000}}`);
    }
    lines.push('{"level":"error","msg":"timeout","ms":30000}');
    const text = lines.join("\n");

    const r = compressContent(text, ENABLED_POLICY);
    expect(r.shape).toBe("json_logs");
    expect(r.content).toContain("(×100 info)");
    expect(r.content).toContain("(×30 warn)");
    expect(r.content).toContain("error");
    expect(r.content.length).toBeLessThan(text.length / 4);
  });

  test("json_logs path tolerates dedup pre-pass on identical lines", () => {
    // When every line is byte-equal, the consecutive-dedup pass collapses
    // before json_logs detection runs. The shape may shift away from
    // json_logs (only one log line left) but the savings still land.
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) lines.push('{"level":"info","msg":"step ok"}');
    const text = lines.join("\n").padEnd(800, " ");

    const r = compressContent(text, ENABLED_POLICY);
    expect(r.content).toContain("(×100)");
    expect(r.content.length).toBeLessThan(text.length / 4);
  });

  test("idempotent — running twice yields identical bytes", () => {
    const lines: string[] = ["On branch main"];
    for (let i = 0; i < 30; i++) lines.push(`        modified:   src/file_${i}.ts`);
    const text = lines.join("\n").padEnd(800, " ");

    const once = compressContent(text, ENABLED_POLICY).content;
    const twice = compressContent(once, ENABLED_POLICY).content;
    expect(twice).toBe(once);
  });

  test("oversized unknown content gets generic head/tail truncation", () => {
    const text = "lorem ipsum ".repeat(2000); // ~24k chars, no detectable shape
    const policy: CompressionPolicy = { ...ENABLED_POLICY, maxCompressedChars: 1000 };
    const r = compressContent(text, policy);
    expect(r.content).toContain("chars elided");
    expect(r.content.length).toBeLessThan(text.length);
  });
});

describe("compressMessages", () => {
  test("disabled policy returns the same array reference", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "tool", content: "x".repeat(10_000) },
    ];
    const out = compressMessages(messages, DEFAULT_POLICY);
    expect(out.messages).toBe(messages);
    expect(out.result.applied).toBe(false);
  });

  test("only tool/function messages are touched", () => {
    const huge = "x".repeat(2000);
    const messages = [
      { role: "system", content: huge },
      { role: "user", content: huge },
      { role: "assistant", content: huge },
      { role: "tool", content: huge, tool_call_id: "t1" },
      { role: "function", content: huge, name: "lookup" },
    ];
    const policy: CompressionPolicy = {
      ...ENABLED_POLICY,
      maxCompressedChars: 200,
    };
    const out = compressMessages(messages, policy);
    expect(out.result.applied).toBe(true);
    // System / user / assistant are still the original 2000-char blob.
    expect((out.messages[0].content as string).length).toBe(2000);
    expect((out.messages[1].content as string).length).toBe(2000);
    expect((out.messages[2].content as string).length).toBe(2000);
    // Tool / function got compressed.
    expect((out.messages[3].content as string).length).toBeLessThan(2000);
    expect((out.messages[4].content as string).length).toBeLessThan(2000);
  });

  test("respects per-tool exclusion via name field", () => {
    const messages = [
      {
        role: "tool",
        name: "search_web",
        content: "x".repeat(5000),
        tool_call_id: "t1",
      },
      { role: "tool", content: "y".repeat(5000), tool_call_id: "t2" },
    ];
    const policy: CompressionPolicy = {
      ...ENABLED_POLICY,
      maxCompressedChars: 200,
      excludeToolNames: new Set(["search_web"]),
    };
    const out = compressMessages(messages, policy);
    expect((out.messages[0].content as string).length).toBe(5000);
    expect((out.messages[1].content as string).length).toBeLessThan(5000);
    expect(out.result.perMessage.length).toBe(1);
    expect(out.result.perMessage[0].index).toBe(1);
  });

  test("structured non-string content is left alone (forward-compat)", () => {
    const messages = [
      {
        role: "tool",
        content: [{ type: "text", text: "hello" }],
        tool_call_id: "t1",
      },
    ];
    const out = compressMessages(messages, ENABLED_POLICY);
    expect(out.result.applied).toBe(false);
    expect(out.messages).toBe(messages);
  });

  test("does not mutate the input array or its messages", () => {
    const original = "x".repeat(5000);
    const messages = [
      { role: "user", content: "hi" },
      { role: "tool", content: original, tool_call_id: "t1" },
    ];
    const messagesCopy = messages.map((m) => ({ ...m }));
    const policy: CompressionPolicy = {
      ...ENABLED_POLICY,
      maxCompressedChars: 200,
    };
    compressMessages(messages, policy);
    // Original objects unchanged.
    expect(messages[1].content).toBe(original);
    expect(messages.length).toBe(messagesCopy.length);
  });

  test("totalCharsSaved sums up per-message savings", () => {
    const blob = "x".repeat(5000);
    const messages = [
      { role: "tool", content: blob, tool_call_id: "t1" },
      { role: "tool", content: blob, tool_call_id: "t2" },
    ];
    const policy: CompressionPolicy = {
      ...ENABLED_POLICY,
      maxCompressedChars: 500,
    };
    const out = compressMessages(messages, policy);
    expect(out.result.applied).toBe(true);
    let computed = 0;
    for (const m of out.result.perMessage) {
      computed += m.charsBefore - m.charsAfter;
    }
    expect(out.result.totalCharsSaved).toBe(computed);
    expect(out.result.totalCharsSaved).toBeGreaterThan(0);
  });
});

describe("estimateTokensFromChars", () => {
  test("zero in zero out", () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(-100)).toBe(0);
  });
  test("uses ~3.5 chars/token ratio", () => {
    expect(estimateTokensFromChars(3500)).toBe(1000);
    expect(estimateTokensFromChars(7000)).toBe(2000);
  });
});
