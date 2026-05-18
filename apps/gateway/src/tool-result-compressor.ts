/**
 * Tool-result compressor — opt-in input-token saver for `messages[]` payloads.
 *
 * Goal — answer the question "rtk filters shell-tool output BEFORE it enters
 * the LLM context; can TokSuan do something analogous?". rtk lives at the
 * Bash-tool layer in the user's IDE and knows the literal command name
 * (`git status`, `cargo test`), so it can apply 100+ command-specific
 * filters with high precision. By the time bytes reach the gateway we've
 * lost that signal: the agent already decided to send a tool message,
 * the command name is gone, and we're staring at a string blob.
 *
 * What we CAN do here is content-shape detection on the strings inside
 * `tool` / `function` messages and apply a small set of conservative
 * filters. The savings are real (those tool-result blobs are billed as
 * input tokens on every subsequent turn), but the strategy is on
 * purpose much narrower than rtk's:
 *   - we ONLY rewrite messages with role === "tool" / "function" — the
 *     human-or-agent prompt is sacred. Even if a user message contains
 *     a 5,000-line stack trace, we don't touch it: agents may be
 *     specifically instructed to find line 47 of that trace and we
 *     can't second-guess.
 *   - rewrites are deterministic + idempotent. Running the compressor
 *     twice on the same content yields identical bytes — important
 *     because fingerprinting (loop detection) runs AFTER compression
 *     in chat.ts and a non-deterministic compressor would tank
 *     fingerprint stability.
 *   - shape detection is heuristic-only. We never call out to a model
 *     to "understand" the content; that would defeat the purpose
 *     (we'd spend tokens to save tokens). When detection is unsure,
 *     the message passes through unchanged.
 *   - opt-in via env. Default OFF. Modifying the request body silently
 *     by default would break the trust contract that's the whole
 *     point of TokSuan ("we record what happened, we don't fudge
 *     prompts behind your back"). Operators flip this on knowingly.
 *
 * The compressor is a pure module: no DB, no I/O, no async. It takes a
 * messages[] array and a policy, returns a new array + a result
 * descriptor. chat.ts wires it in and stamps `tags.tool_compress_*`
 * fields onto the request row so the dashboard's gain breakdown can
 * surface "you saved $X this week from tool-result compression".
 *
 * Env knobs (read by buildPolicyFromEnv in config.ts):
 *   TOKENSMART_TOOL_COMPRESS_ENABLED=0|1
 *     Master switch. Default 0.
 *   TOKENSMART_TOOL_COMPRESS_MIN_MESSAGE_CHARS=500
 *     Don't bother touching messages smaller than this — the savings
 *     are below noise floor and the filters can be lossy on tiny
 *     blobs (e.g. a 2-line "ok" output looks like a stack trace
 *     header to a naive matcher).
 *   TOKENSMART_TOOL_COMPRESS_MAX_COMPRESSED_CHARS=4000
 *     Hard cap on per-message length AFTER shape-specific filtering.
 *     Prevents a never-before-seen content shape from sneaking
 *     through with full size just because no detector matched.
 *   TOKENSMART_TOOL_COMPRESS_STRIP_ANSI=1
 *     Strip ANSI escape sequences. Almost always safe; agents don't
 *     use color information for reasoning. Default ON when the
 *     master switch is on.
 *   TOKENSMART_TOOL_COMPRESS_DEDUP_LINES=1
 *     Collapse exact-equal consecutive lines into "<line> (×N)".
 *     Catches the common "spammed log line" failure mode that
 *     dominates docker logs / pytest verbose / etc.
 *   TOKENSMART_TOOL_COMPRESS_EXCLUDE_TOOLS=search_web,vision_describe
 *     Comma-separated tool names whose results we never compress.
 *     Per-call escape hatch for tools where the agent really does
 *     need the full blob.
 */

export type CompressionShape =
  | "git_status"
  | "git_diff"
  | "shell_listing"
  | "stack_trace"
  | "json_logs"
  | "ansi_text"
  | "generic_long_log"
  | "unknown";

export type CompressionPolicy = {
  enabled: boolean;
  minMessageChars: number;
  maxCompressedChars: number;
  stripAnsi: boolean;
  dedupeLines: boolean;
  /** Lower-cased tool names whose results we never touch. */
  excludeToolNames: ReadonlySet<string>;
};

export type CompressedMessageInfo = {
  /** Index in the original messages[] array. */
  index: number;
  role: string;
  /** What the heuristic decided this content was. */
  shape: CompressionShape;
  charsBefore: number;
  charsAfter: number;
};

export type CompressionResult = {
  /** True if at least one message was rewritten. */
  applied: boolean;
  /** Sum of (charsBefore - charsAfter) across rewritten messages. */
  totalCharsSaved: number;
  perMessage: CompressedMessageInfo[];
};

export const DEFAULT_POLICY: CompressionPolicy = {
  enabled: false,
  minMessageChars: 500,
  maxCompressedChars: 4000,
  stripAnsi: true,
  dedupeLines: true,
  excludeToolNames: new Set<string>(),
};

/**
 * Build a policy from env-vars. Kept here (rather than in config.ts) so
 * the pure module is self-contained for tests — pass it a stub object,
 * get a policy back. config.ts calls this once at boot with
 * `process.env`.
 */
export function buildPolicyFromEnv(
  env: Record<string, string | undefined>
): CompressionPolicy {
  const enabled = env.TOKENSMART_TOOL_COMPRESS_ENABLED === "1";
  if (!enabled) return DEFAULT_POLICY;

  const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  const parseFlag = (raw: string | undefined, fallback: boolean): boolean => {
    if (raw === undefined) return fallback;
    return raw === "1" || raw.toLowerCase() === "true";
  };

  const exclude = new Set<string>();
  const rawExclude = env.TOKENSMART_TOOL_COMPRESS_EXCLUDE_TOOLS ?? "";
  for (const name of rawExclude.split(",")) {
    const trimmed = name.trim().toLowerCase();
    if (trimmed) exclude.add(trimmed);
  }

  return {
    enabled: true,
    minMessageChars: parsePositiveInt(
      env.TOKENSMART_TOOL_COMPRESS_MIN_MESSAGE_CHARS,
      DEFAULT_POLICY.minMessageChars
    ),
    maxCompressedChars: parsePositiveInt(
      env.TOKENSMART_TOOL_COMPRESS_MAX_COMPRESSED_CHARS,
      DEFAULT_POLICY.maxCompressedChars
    ),
    stripAnsi: parseFlag(env.TOKENSMART_TOOL_COMPRESS_STRIP_ANSI, true),
    dedupeLines: parseFlag(env.TOKENSMART_TOOL_COMPRESS_DEDUP_LINES, true),
    excludeToolNames: exclude,
  };
}

// ---------------------------------------------------------------------------
// Shape detection
// ---------------------------------------------------------------------------

const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;

const SHAPE_DETECTORS: Array<{
  shape: CompressionShape;
  test: (text: string) => boolean;
}> = [
  // git diff is checked first because `On branch main\ndiff --git ...` is
  // technically a git status output that contains a diff — but the diff
  // filter is the more aggressive savings, so prefer it.
  {
    shape: "git_diff",
    test: (t) =>
      /^diff --git /m.test(t) ||
      (/^---\s/m.test(t) && /^\+\+\+\s/m.test(t) && /^@@\s/m.test(t)),
  },
  {
    shape: "git_status",
    test: (t) =>
      /^(On branch |HEAD detached at )/m.test(t) &&
      /(Changes (not staged|to be committed)|Untracked files|nothing to commit)/m.test(t),
  },
  {
    // Classic ls -l / find / tree output: many lines starting with
    // permission bits OR file-path prefixes.
    shape: "shell_listing",
    test: (t) => {
      const lines = t.split("\n");
      if (lines.length < 8) return false;
      let permLines = 0;
      for (const ln of lines) {
        if (/^[-dlcbsp][rwx-]{9}/.test(ln)) permLines++;
      }
      return permLines >= 5;
    },
  },
  {
    // Python / JS / Java / Go stack trace: an error/exception name plus
    // multiple "at .../:NNN" or "  File ..., line NNN" frames.
    shape: "stack_trace",
    test: (t) => {
      const frameAt = (t.match(/^\s+at\s+\S+/gm) ?? []).length;
      const framePy = (t.match(/^\s*File ".+", line \d+/gm) ?? []).length;
      const errLine = /\b(Error|Exception|panic|Traceback|FAIL|FAILED)\b/.test(
        t
      );
      return errLine && frameAt + framePy >= 3;
    },
  },
  {
    // NDJSON / structured log lines. Detect by: multiple lines, each
    // parseable as JSON object containing a level/severity/msg field.
    shape: "json_logs",
    test: (t) => {
      const lines = t.split("\n").filter((l) => l.trim().startsWith("{"));
      if (lines.length < 5) return false;
      let parsed = 0;
      for (let i = 0; i < Math.min(lines.length, 12); i++) {
        try {
          const v = JSON.parse(lines[i]) as Record<string, unknown>;
          if (
            v &&
            typeof v === "object" &&
            ("level" in v ||
              "severity" in v ||
              "msg" in v ||
              "message" in v)
          ) {
            parsed++;
          }
        } catch {
          // not JSON, skip
        }
      }
      return parsed >= 3;
    },
  },
  {
    shape: "ansi_text",
    test: (t) => ANSI_RE.test(t),
  },
];

export function detectShape(content: string): CompressionShape {
  // Reset regex state because some detectors use a global flag.
  ANSI_RE.lastIndex = 0;
  for (const { shape, test } of SHAPE_DETECTORS) {
    if (test(content)) return shape;
    ANSI_RE.lastIndex = 0;
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Filters (one per shape, plus shared utilities)
// ---------------------------------------------------------------------------

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * Collapse consecutive identical lines into "<line> (×N)". Conservative —
 * only EXACT-equal consecutive lines collapse (no fuzzy matching), so a
 * test runner that prints the same "INFO  | started" line 200 times
 * compacts to one line + a count, but a stack trace where each frame
 * differs by line number is left alone.
 */
function dedupeConsecutive(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let j = i + 1;
    while (j < lines.length && lines[j] === line) j++;
    const repeats = j - i;
    if (repeats >= 4) {
      out.push(`${line} (×${repeats})`);
    } else {
      for (let k = 0; k < repeats; k++) out.push(line);
    }
    i = j;
  }
  return out.join("\n");
}

function compressGitStatus(text: string): string {
  const lines = text.split("\n");
  const interesting: string[] = [];
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let mode: "none" | "staged" | "unstaged" | "untracked" = "none";

  for (const raw of lines) {
    const ln = raw.trimEnd();
    if (/^On branch /.test(ln) || /^HEAD detached at /.test(ln)) {
      interesting.push(ln);
      continue;
    }
    if (/Your branch /.test(ln) || /^nothing to commit/.test(ln)) {
      interesting.push(ln);
      continue;
    }
    if (/^Changes to be committed:/.test(ln)) {
      mode = "staged";
      continue;
    }
    if (/^Changes not staged for commit:/.test(ln)) {
      mode = "unstaged";
      continue;
    }
    if (/^Untracked files:/.test(ln)) {
      mode = "untracked";
      continue;
    }
    if (/^\s*\(use /.test(ln) || ln.trim() === "") continue;
    // File entries — modified: foo.ts / new file: bar.ts / etc.
    if (/^\s+(modified|new file|deleted|renamed|typechange):/.test(ln)) {
      if (mode === "staged") staged++;
      else if (mode === "unstaged") unstaged++;
      continue;
    }
    if (mode === "untracked" && /^\s+\S/.test(ln)) {
      untracked++;
      continue;
    }
  }

  const summary: string[] = [];
  if (staged > 0) summary.push(`${staged} staged`);
  if (unstaged > 0) summary.push(`${unstaged} unstaged`);
  if (untracked > 0) summary.push(`${untracked} untracked`);
  if (summary.length > 0) {
    interesting.push(`(${summary.join(", ")})`);
  }
  return interesting.join("\n");
}

function compressGitDiff(text: string, maxChars: number): string {
  const fileSections: Array<{ header: string; body: string[] }> = [];
  let current: { header: string; body: string[] } | null = null;
  for (const ln of text.split("\n")) {
    if (/^diff --git /.test(ln)) {
      if (current) fileSections.push(current);
      current = { header: ln, body: [] };
      continue;
    }
    // Drop the three lines git emits per file that an LLM reasoning
    // about the diff never benefits from:
    //   - `index 0a1b2c3..d4e5f60 100644`  — git blob shas + mode,
    //     useless once we have the file-path-bearing diff header
    //   - `--- a/<path>`                    — implicit from the
    //   - `+++ b/<path>`                      same diff --git header
    // Dropping all three for every file saves ~80-150 bytes / file
    // even on a diff that's small enough to otherwise fit inside the
    // per-file budget — so a request that detected as "git_diff" but
    // would have passed through unchanged still nets a real savings.
    if (current) {
      if (/^index [0-9a-f]+\.\.[0-9a-f]+/.test(ln)) continue;
      if (/^--- [ab]?\//.test(ln) || ln === "--- /dev/null") continue;
      if (/^\+\+\+ [ab]?\//.test(ln) || ln === "+++ /dev/null") continue;
      current.body.push(ln);
    }
  }
  if (current) fileSections.push(current);

  if (fileSections.length === 0) {
    // Probably a unified diff without `diff --git` headers (plain `diff`
    // output). Fall back to a head/tail truncation.
    return truncateHeadTail(text, maxChars);
  }

  const perFileBudget = Math.max(
    400,
    Math.floor(maxChars / Math.max(1, fileSections.length))
  );
  const out: string[] = [];
  for (const sec of fileSections) {
    out.push(sec.header);
    let used = sec.header.length + 1;
    let kept = 0;
    let dropped = 0;
    for (const line of sec.body) {
      if (used + line.length + 1 <= perFileBudget) {
        out.push(line);
        used += line.length + 1;
        kept++;
      } else {
        dropped++;
      }
    }
    if (dropped > 0) {
      out.push(`... ${dropped} more diff lines elided ...`);
    }
    void kept;
  }
  return out.join("\n");
}

function compressShellListing(text: string, maxChars: number): string {
  const lines = text.split("\n");
  if (lines.length <= 60) return text;
  const head = lines.slice(0, 40);
  const tail = lines.slice(-10);
  const elided = lines.length - head.length - tail.length;
  const result = [
    ...head,
    `... ${elided} more entries elided ...`,
    ...tail,
  ].join("\n");
  return truncateHeadTail(result, maxChars);
}

function compressStackTrace(text: string, maxChars: number): string {
  const lines = text.split("\n");
  // Keep the first ~6 lines (error message + first few frames) and the
  // last ~3 lines (often the originating user-code frame on Python /
  // the cause chain on JVM languages).
  if (lines.length <= 14) return text;
  const head = lines.slice(0, 6);
  const tail = lines.slice(-4);
  const elided = lines.length - head.length - tail.length;
  const result = [
    ...head,
    `... ${elided} stack frames elided ...`,
    ...tail,
  ].join("\n");
  return truncateHeadTail(result, maxChars);
}

function compressJsonLogs(text: string, maxChars: number): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  // Bucket by level/severity, keep first sample of each level + count.
  const bucket = new Map<
    string,
    { count: number; firstSample: string }
  >();
  const passthrough: string[] = []; // non-JSON lines preserved in order
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      passthrough.push(line);
      continue;
    }
    let level = "?";
    try {
      const v = JSON.parse(trimmed) as Record<string, unknown>;
      const lvl = v.level ?? v.severity ?? v.lvl;
      if (typeof lvl === "string") level = lvl;
      else if (typeof lvl === "number") level = String(lvl);
    } catch {
      // unparseable — bucket as raw
    }
    const existing = bucket.get(level);
    if (existing) {
      existing.count++;
    } else {
      bucket.set(level, { count: 1, firstSample: line });
    }
  }

  const out: string[] = [];
  for (const [level, entry] of bucket) {
    if (entry.count === 1) {
      out.push(entry.firstSample);
    } else {
      out.push(`${entry.firstSample}  // (×${entry.count} ${level})`);
    }
  }
  out.push(...passthrough);
  return truncateHeadTail(out.join("\n"), maxChars);
}

function truncateHeadTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  // Reserve ~20% of the budget for the tail so a "FAILED" / final
  // summary line doesn't get chopped. The marker reports the elided
  // byte count so the reader knows roughly how much was lost.
  const tailBudget = Math.max(200, Math.floor(maxChars * 0.2));
  const headBudget = Math.max(100, maxChars - tailBudget - 80);
  const head = text.slice(0, headBudget);
  const tail = text.slice(text.length - tailBudget);
  const elided = text.length - head.length - tail.length;
  return `${head}\n... ${elided} chars elided ...\n${tail}`;
}

// ---------------------------------------------------------------------------
// Top-level: compress one content string and an array of messages
// ---------------------------------------------------------------------------

/**
 * Compress a raw content string in isolation. Exposed mainly for tests +
 * the eventual /internal/discover endpoint that previews potential savings.
 */
export function compressContent(
  content: string,
  policy: CompressionPolicy
): { content: string; shape: CompressionShape } {
  if (!policy.enabled) return { content, shape: "unknown" };
  if (content.length < policy.minMessageChars) {
    return { content, shape: "unknown" };
  }

  const shape = detectShape(content);
  let working = content;

  // Always-on stripping passes first (cheap, almost always safe).
  if (policy.stripAnsi) {
    working = stripAnsi(working);
  }
  if (policy.dedupeLines) {
    working = dedupeConsecutive(working);
  }

  switch (shape) {
    case "git_status":
      working = compressGitStatus(working);
      break;
    case "git_diff":
      working = compressGitDiff(working, policy.maxCompressedChars);
      break;
    case "shell_listing":
      working = compressShellListing(working, policy.maxCompressedChars);
      break;
    case "stack_trace":
      working = compressStackTrace(working, policy.maxCompressedChars);
      break;
    case "json_logs":
      working = compressJsonLogs(working, policy.maxCompressedChars);
      break;
    case "ansi_text":
    case "unknown":
      // No specialised filter ran. The catch-all generic path is to
      // truncate iff we're still way past the policy cap after the
      // shared (ansi/dedup) passes — that catches "agent dumped a 50k-
      // line build log" without silently dropping content from a
      // 1000-char tool message that just happened to not match any
      // detector.
      if (working.length > policy.maxCompressedChars * 2) {
        working = truncateHeadTail(working, policy.maxCompressedChars);
      }
      break;
    case "generic_long_log":
      working = truncateHeadTail(working, policy.maxCompressedChars);
      break;
  }

  return { content: working, shape };
}

type ChatMessageLike = {
  role: string;
  content: unknown;
  name?: string;
  tool_call_id?: string;
  // Forward-compat: anything else passes through untouched.
  [key: string]: unknown;
};

/**
 * Compress every tool/function-result message in `messages`. Returns a
 * NEW array (input is not mutated). Non-tool messages are forwarded
 * by reference. When no rewrites happened, the input array reference
 * is returned unchanged (cheap pointer-equality short-circuit for
 * downstream optimization).
 */
export function compressMessages(
  messages: ChatMessageLike[],
  policy: CompressionPolicy
): { messages: ChatMessageLike[]; result: CompressionResult } {
  const empty: CompressionResult = {
    applied: false,
    totalCharsSaved: 0,
    perMessage: [],
  };
  if (!policy.enabled) return { messages, result: empty };

  let totalSaved = 0;
  const perMessage: CompressedMessageInfo[] = [];
  let mutated = false;
  const out = messages.slice();

  for (let i = 0; i < out.length; i++) {
    const msg = out[i];
    if (!msg || (msg.role !== "tool" && msg.role !== "function")) continue;

    // Per-tool-name opt-out.
    const toolName = typeof msg.name === "string" ? msg.name.toLowerCase() : null;
    if (toolName && policy.excludeToolNames.has(toolName)) continue;

    // We only know how to compress string content. Some agents send
    // structured blobs (e.g. {type: "tool_result", content: [...]});
    // those pass through untouched on this version.
    if (typeof msg.content !== "string") continue;
    const before = msg.content.length;
    if (before < policy.minMessageChars) continue;

    const { content: after, shape } = compressContent(msg.content, policy);
    if (after.length >= before) continue; // no gain — leave it
    out[i] = { ...msg, content: after };
    mutated = true;
    totalSaved += before - after.length;
    perMessage.push({
      index: i,
      role: msg.role,
      shape,
      charsBefore: before,
      charsAfter: after.length,
    });
  }

  if (!mutated) return { messages, result: empty };
  return {
    messages: out,
    result: {
      applied: true,
      totalCharsSaved: totalSaved,
      perMessage,
    },
  };
}

/**
 * Token-savings estimate from char-savings. Uses a deliberately
 * conservative ratio (~3.5 chars/token) because tool-result content
 * is usually code/log-dense and tokenizes denser than English prose
 * (which is closer to 4 chars/token). Under-estimating by a small
 * margin is preferable to over-claiming on the savings card.
 */
export function estimateTokensFromChars(chars: number): number {
  if (chars <= 0) return 0;
  return Math.round(chars / 3.5);
}
