#!/usr/bin/env bun
/**
 * Quick local preview for the tool-result compressor.
 *
 * Run:
 *   bun run scripts/preview-tool-compress.ts
 *
 * No DB, no gateway, no env-vars required — pulls the compressor module
 * directly and walks a set of representative tool-output fixtures
 * (git status, git diff, ls -l, stack trace, NDJSON logs, ANSI-painted
 * cargo build, repeated docker logs). For each fixture: print the
 * before bytes, the detected shape, the after bytes, and the
 * estimated input-token savings. The compressor is deterministic +
 * idempotent so the output is reproducible run-to-run.
 *
 * Optional: pass `--shape <name>` to only show one fixture, e.g.
 *   bun run scripts/preview-tool-compress.ts --shape git_diff
 *
 * This is the script equivalent of "what does rtk gain look like
 * before I plumb the compressor into a real request?".
 */

import {
  compressContent,
  detectShape,
  estimateTokensFromChars,
  type CompressionPolicy,
  type CompressionShape,
} from "../src/tool-result-compressor";

// ---------------------------------------------------------------------------
// Fixtures — synthesized to look like real Bash-tool outputs an agent
// would replay back to the model in a `tool` / `function` message.
// ---------------------------------------------------------------------------

function gitStatusFixture(): string {
  const lines: string[] = [
    "On branch develop",
    "Your branch is up to date with 'origin/develop'.",
    "",
    "Changes to be committed:",
    '  (use "git restore --staged <file>..." to unstage)',
  ];
  for (let i = 0; i < 18; i++) {
    lines.push(`        modified:   apps/gateway/src/routes/file_${i}.ts`);
  }
  lines.push("", "Changes not staged for commit:");
  lines.push('  (use "git add <file>..." to update what will be committed)');
  for (let i = 0; i < 9; i++) {
    lines.push(`        modified:   apps/dashboard/src/components/widget_${i}.tsx`);
  }
  lines.push("", "Untracked files:");
  lines.push('  (use "git add <file>..." to include in what will be committed)');
  for (let i = 0; i < 6; i++) lines.push(`        scratch/notes_${i}.md`);
  return lines.join("\n");
}

function gitDiffFixture(): string {
  const sections: string[] = [];
  for (let f = 0; f < 4; f++) {
    sections.push(`diff --git a/src/file_${f}.ts b/src/file_${f}.ts`);
    sections.push("index 0a1b2c3..d4e5f60 100644");
    sections.push(`--- a/src/file_${f}.ts`);
    sections.push(`+++ b/src/file_${f}.ts`);
    sections.push("@@ -1,5 +1,5 @@");
    for (let i = 0; i < 80; i++) sections.push(`-removed line ${i}`);
    for (let i = 0; i < 80; i++) sections.push(`+added line ${i}`);
  }
  return sections.join("\n");
}

function shellListingFixture(): string {
  // 120 entries — above the 60-line threshold the listing filter uses
  // before it kicks in. Real `ls -laR` output on a typical project's
  // node_modules is in the same ballpark.
  const lines: string[] = [];
  for (let i = 0; i < 120; i++) {
    lines.push(
      `-rw-r--r--  1 user staff  ${i * 137} Jan ${(i % 28) + 1} 12:${(i * 7) % 60} report_${i}.csv`
    );
  }
  return lines.join("\n");
}

function stackTraceFixture(): string {
  const lines: string[] = ["Error: ECONNRESET upstream"];
  for (let i = 0; i < 60; i++) {
    lines.push(
      `    at frame_${i} (/app/src/long/path/segment/file_${i}.ts:${i + 1}:${(i * 3) + 7})`
    );
  }
  lines.push("    at processTicksAndRejections (node:internal/process/task_queues:96:5)");
  return lines.join("\n");
}

function jsonLogsFixture(): string {
  const lines: string[] = [];
  for (let i = 0; i < 80; i++) {
    lines.push(`{"level":"info","msg":"step ok","seq":${i},"t":"2026-05-17T19:${i % 60}"}`);
  }
  for (let i = 0; i < 25; i++) {
    lines.push(`{"level":"warn","msg":"slow query","ms":${1500 + i * 50}}`);
  }
  lines.push('{"level":"error","msg":"db conn lost","ms":30000}');
  return lines.join("\n");
}

function ansiCargoBuildFixture(): string {
  const RED = "\u001b[31m";
  const GREEN = "\u001b[32m";
  const RESET = "\u001b[0m";
  const lines: string[] = [];
  for (let i = 0; i < 60; i++) {
    lines.push(`   ${GREEN}Compiling${RESET} crate_${i} v0.${i}.0`);
  }
  for (let i = 0; i < 5; i++) {
    lines.push(`${RED}error${RESET}[E0432]: unresolved import \`foo::bar_${i}\``);
  }
  return lines.join("\n");
}

function dedupeDockerLogsFixture(): string {
  const lines: string[] = [];
  for (let i = 0; i < 200; i++) lines.push("INFO  app: heartbeat");
  lines.push("WARN  app: slow request /api/foo took 2200ms");
  for (let i = 0; i < 50; i++) lines.push("INFO  app: heartbeat");
  return lines.join("\n");
}

const FIXTURES: Array<{ name: string; expected: CompressionShape; build: () => string }> = [
  { name: "git_status", expected: "git_status", build: gitStatusFixture },
  { name: "git_diff", expected: "git_diff", build: gitDiffFixture },
  { name: "shell_listing", expected: "shell_listing", build: shellListingFixture },
  { name: "stack_trace", expected: "stack_trace", build: stackTraceFixture },
  { name: "json_logs", expected: "json_logs", build: jsonLogsFixture },
  { name: "ansi_cargo", expected: "ansi_text", build: ansiCargoBuildFixture },
  { name: "dedupe_logs", expected: "json_logs", build: dedupeDockerLogsFixture },
];

// ---------------------------------------------------------------------------
// Pretty-printing helpers
// ---------------------------------------------------------------------------

const POLICY: CompressionPolicy = {
  enabled: true,
  minMessageChars: 500,
  maxCompressedChars: 4000,
  stripAnsi: true,
  dedupeLines: true,
  excludeToolNames: new Set<string>(),
};

function fmt(chars: number): string {
  if (chars >= 1024 * 1024) return `${(chars / 1024 / 1024).toFixed(2)} MiB`;
  if (chars >= 1024) return `${(chars / 1024).toFixed(1)} KiB`;
  return `${chars} B`;
}

function fmtPct(saved: number, before: number): string {
  if (before === 0) return "0%";
  return `${((saved / before) * 100).toFixed(1)}%`;
}

function previewSnippet(text: string, maxLines = 8): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return lines.map((l) => `  | ${l}`).join("\n");
  const head = lines.slice(0, maxLines - 2);
  const tail = lines.slice(-2);
  return [
    ...head.map((l) => `  | ${l}`),
    `  | ... (${lines.length - head.length - tail.length} more lines)`,
    ...tail.map((l) => `  | ${l}`),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let onlyShape: string | null = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--shape" && args[i + 1]) {
    onlyShape = args[i + 1];
    i++;
  }
}

console.log("=".repeat(78));
console.log(" Tool-result compressor — local preview");
console.log(` policy: minChars=${POLICY.minMessageChars}, maxChars=${POLICY.maxCompressedChars},`);
console.log(`         stripAnsi=${POLICY.stripAnsi}, dedupeLines=${POLICY.dedupeLines}`);
console.log(" all fixtures are synthesized — no live data.");
console.log("=".repeat(78));

let totalBefore = 0;
let totalAfter = 0;

for (const fx of FIXTURES) {
  if (onlyShape && fx.name !== onlyShape) continue;

  const before = fx.build();
  const detected = detectShape(before);
  const { content: after, shape: postCompressShape } = compressContent(before, POLICY);
  const saved = before.length - after.length;
  const tokensSaved = estimateTokensFromChars(saved);
  totalBefore += before.length;
  totalAfter += after.length;

  console.log(`\n[${fx.name}]`);
  console.log(
    `  detected shape: ${detected}` +
      (detected !== fx.expected ? `  (expected: ${fx.expected})` : "") +
      (postCompressShape !== detected
        ? `  →  applied filter for: ${postCompressShape}`
        : "")
  );
  console.log(
    `  size:  ${fmt(before.length).padStart(10)}  →  ${fmt(after.length).padStart(10)}` +
      `   (saved ${fmt(saved)}, ${fmtPct(saved, before.length)},` +
      ` ~${tokensSaved.toLocaleString("en-US")} input tokens)`
  );
  console.log("  before:");
  console.log(previewSnippet(before));
  console.log("  after:");
  console.log(previewSnippet(after));
}

if (!onlyShape) {
  const totalSaved = totalBefore - totalAfter;
  console.log("\n" + "=".repeat(78));
  console.log(
    ` totals: ${fmt(totalBefore)} → ${fmt(totalAfter)}` +
      `  (saved ${fmt(totalSaved)}, ${fmtPct(totalSaved, totalBefore)},` +
      ` ~${estimateTokensFromChars(totalSaved).toLocaleString("en-US")} input tokens)`
  );
  console.log("=".repeat(78));
  console.log(
    "\nTry `bun run scripts/preview-tool-compress.ts --shape git_diff` to drill into one."
  );
}
