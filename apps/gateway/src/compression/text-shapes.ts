/**
 * Deterministic per-shape text compressors.
 *
 * Moved verbatim from the original `tool-result-compressor.ts` during the
 * M1 refactor — byte-for-byte identical behavior so existing fingerprints,
 * receipts, and tests stay stable. Each function is pure + idempotent.
 */

export const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * Collapse consecutive identical lines into "<line> (×N)". Conservative —
 * only EXACT-equal consecutive lines collapse (no fuzzy matching), so a
 * test runner that prints the same "INFO  | started" line 200 times
 * compacts to one line + a count, but a stack trace where each frame
 * differs by line number is left alone.
 */
export function dedupeConsecutive(text: string): string {
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

export function compressGitStatus(text: string): string {
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

export function compressGitDiff(text: string, maxChars: number): string {
  const fileSections: Array<{ header: string; body: string[] }> = [];
  let current: { header: string; body: string[] } | null = null;
  for (const ln of text.split("\n")) {
    if (/^diff --git /.test(ln)) {
      if (current) fileSections.push(current);
      current = { header: ln, body: [] };
      continue;
    }
    if (current) {
      if (/^index [0-9a-f]+\.\.[0-9a-f]+/.test(ln)) continue;
      if (/^--- [ab]?\//.test(ln) || ln === "--- /dev/null") continue;
      if (/^\+\+\+ [ab]?\//.test(ln) || ln === "+++ /dev/null") continue;
      current.body.push(ln);
    }
  }
  if (current) fileSections.push(current);

  if (fileSections.length === 0) {
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

export function compressShellListing(text: string, maxChars: number): string {
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

export function compressStackTrace(text: string, maxChars: number): string {
  const lines = text.split("\n");
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

export function compressJsonLogs(text: string, maxChars: number): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  // Bucket by level/severity, keep first sample of each level + count.
  const bucket = new Map<string, { count: number; firstSample: string }>();
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

export function truncateHeadTail(text: string, maxChars: number): string {
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
