/**
 * Pricing refresh helper.
 *
 * NON-GOAL: auto-scraping OpenAI / Anthropic / DashScope HTML pricing
 * pages. Those pages are React-heavy, change layout often, and a fragile
 * scraper produces more pain than the staleness it tries to fix. We tried.
 *
 * GOAL: make the manual verify-and-bump cycle one command. Two modes:
 *
 *   bun run refresh-pricing                # interactive review
 *   bun run refresh-pricing --bump-all     # mark every entry verified today
 *                                            (only run AFTER you actually
 *                                             verified — don't lie to your
 *                                             freshness check)
 *   bun run refresh-pricing --bump=openai/gpt-4o
 *                                          # verify a single model and
 *                                            stamp it as of today
 *   bun run refresh-pricing --report       # list every source_url +
 *                                            current price (no writes)
 *
 * The interactive mode walks every stale entry, prints the source_url,
 * and prompts: keep / bump-only / edit / skip. Keeps a backup of the
 * old file at `data/pricing.json.bak` before writing.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { findPricingFile, PricingFileSchema, type PricingFile } from "../src/pricing";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

type Cli =
  | { mode: "interactive" }
  | { mode: "bump-all" }
  | { mode: "bump-one"; key: string }
  | { mode: "report" };

function parseArgs(argv: string[]): Cli {
  for (const a of argv) {
    if (a === "--bump-all") return { mode: "bump-all" };
    if (a === "--report") return { mode: "report" };
    if (a.startsWith("--bump=")) {
      return { mode: "bump-one", key: a.slice("--bump=".length) };
    }
  }
  return { mode: "interactive" };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadFile(path: string): { raw: string; parsed: PricingFile } {
  const raw = readFileSync(path, "utf-8");
  const parsed = PricingFileSchema.parse(JSON.parse(raw));
  return { raw, parsed };
}

function writeFile(path: string, parsed: PricingFile): void {
  copyFileSync(path, path + ".bak");
  // Preserve the structure: 2-space indent matches the existing file's
  // hand-edited shape, so reviewers see a small diff instead of a full
  // reformat.
  writeFileSync(path, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
}

function reportTable(entries: PricingFile["entries"]): void {
  const rows = entries
    .slice()
    .sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`));
  console.log(
    `provider/model                                              in $/M     out $/M    cached    last_verified  source`
  );
  console.log(
    `----------------------------------------------------------- --------   --------   --------  -------------  ------`
  );
  for (const e of rows) {
    const key = `${e.provider}/${e.model}`.padEnd(60);
    const inStr = e.inputUsdPerM.toFixed(3).padStart(8);
    const outStr = e.outputUsdPerM.toFixed(3).padStart(8);
    const cachedStr = (e.cachedInputUsdPerM ?? "-")
      .toString()
      .padStart(8);
    const verifiedStr = (e.last_verified_at ?? "—").padEnd(13);
    const src = e.source_url ?? "(no source_url)";
    console.log(
      `${key}  ${inStr}   ${outStr}   ${cachedStr}  ${verifiedStr}  ${src}`
    );
  }
}

async function interactive(file: string, parsed: PricingFile): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  let changed = 0;
  try {
    for (const entry of parsed.entries) {
      console.log("\n────────────────────────────────────────");
      console.log(`${entry.provider}/${entry.model}`);
      console.log(`  in:     $${entry.inputUsdPerM} per 1M tokens`);
      console.log(`  out:    $${entry.outputUsdPerM} per 1M tokens`);
      if (entry.cachedInputUsdPerM != null) {
        console.log(`  cached: $${entry.cachedInputUsdPerM} per 1M tokens`);
      }
      console.log(
        `  last_verified_at: ${entry.last_verified_at ?? "(unset)"}`
      );
      console.log(`  source: ${entry.source_url ?? "(no source_url)"}`);
      const answer = (
        await rl.question(
          `  [k]eep as-is, [b]ump verified to ${todayIso()}, [s]kip > `
        )
      )
        .trim()
        .toLowerCase();
      if (answer === "b" || answer === "bump") {
        entry.last_verified_at = todayIso();
        changed++;
      }
      // 'k' / 's' / anything else → leave untouched
    }
  } finally {
    rl.close();
  }
  if (changed > 0) {
    writeFile(file, parsed);
    console.log(
      `\n[refresh] wrote ${file} (${changed} entries bumped). Backup at ${file}.bak`
    );
  } else {
    console.log("\n[refresh] no changes");
  }
}

function bumpAll(file: string, parsed: PricingFile): void {
  const today = todayIso();
  let changed = 0;
  for (const e of parsed.entries) {
    if (e.last_verified_at !== today) {
      e.last_verified_at = today;
      changed++;
    }
  }
  if (changed > 0) {
    writeFile(file, parsed);
    console.log(
      `[refresh] bumped ${changed} entry / entries to last_verified_at=${today}. Backup at ${file}.bak`
    );
  } else {
    console.log(`[refresh] every entry already has last_verified_at=${today}; no writes`);
  }
}

function bumpOne(file: string, parsed: PricingFile, key: string): void {
  const sep = key.indexOf("/");
  if (sep < 0) {
    throw new Error(
      `--bump expects "<provider>/<model>" (got "${key}"). Example: --bump=openai/gpt-4o`
    );
  }
  const provider = key.slice(0, sep);
  const model = key.slice(sep + 1);
  const entry = parsed.entries.find(
    (e) => e.provider === provider && e.model === model
  );
  if (!entry) {
    throw new Error(`--bump=${key} did not match any entry in pricing.json`);
  }
  const before = entry.last_verified_at ?? "(unset)";
  entry.last_verified_at = todayIso();
  writeFile(file, parsed);
  console.log(
    `[refresh] ${provider}/${model}: last_verified_at ${before} → ${entry.last_verified_at}. Backup at ${file}.bak`
  );
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const file = findPricingFile();
  if (!file) {
    console.error(
      "[refresh] pricing.json not found. Set TOKENSMART_PRICING_FILE if it lives elsewhere."
    );
    process.exit(2);
  }
  if (!existsSync(file)) {
    console.error(`[refresh] pricing.json missing at ${file}`);
    process.exit(2);
  }
  const { parsed } = loadFile(file);

  if (cli.mode === "report") {
    reportTable(parsed.entries);
    return;
  }
  if (cli.mode === "bump-all") {
    bumpAll(file, parsed);
    return;
  }
  if (cli.mode === "bump-one") {
    bumpOne(file, parsed, cli.key);
    return;
  }
  await interactive(file, parsed);
}

await main();
