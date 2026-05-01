/**
 * Pricing freshness audit.
 *
 * Reads `apps/gateway/data/pricing.json` and reports which entries:
 *   - Are stale (last_verified_at > N days ago, default 30)
 *   - Are missing `last_verified_at` entirely
 *   - Are missing `source_url`
 *
 * Exits non-zero when any entry is stale, so CI / nightly workflow
 * can gate releases on a fresh pricing table.
 *
 * Usage:
 *   bun run check-pricing-freshness                # default 30-day window
 *   bun run check-pricing-freshness --max-age=14   # tighter
 *   bun run check-pricing-freshness --json         # machine-readable
 *
 * Exit codes:
 *   0  every entry is fresh AND has source_url + last_verified_at
 *   1  at least one entry is stale or missing required metadata
 *   2  pricing.json is missing or malformed (a hard failure — fix it)
 */

import { findPricingFile, loadPricingFile } from "../src/pricing";

type Args = {
  maxAgeDays: number;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { maxAgeDays: 30, json: false };
  for (const a of argv) {
    if (a === "--json") out.json = true;
    else if (a.startsWith("--max-age=")) {
      const n = Number(a.slice("--max-age=".length));
      if (Number.isFinite(n) && n > 0) out.maxAgeDays = n;
    }
  }
  return out;
}

function ageDays(iso: string, now = new Date()): number {
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return Number.POSITIVE_INFINITY;
  return Math.floor((now.getTime() - d.getTime()) / (24 * 60 * 60 * 1000));
}

type Issue = {
  provider: string;
  model: string;
  problem: "stale" | "no_verified_at" | "no_source_url";
  details?: string;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const file = findPricingFile();
  if (!file) {
    console.error(
      "[freshness] pricing.json not found. Looked in cwd/data/, " +
        "cwd/apps/gateway/data/, src-relative path, and TOKENSMART_PRICING_FILE."
    );
    process.exit(2);
  }
  const entries = loadPricingFile(file);
  if (!entries) {
    console.error(`[freshness] pricing file ${file} failed to load`);
    process.exit(2);
  }

  const issues: Issue[] = [];
  for (const e of entries) {
    if (!e.source_url) {
      issues.push({
        provider: e.provider,
        model: e.model,
        problem: "no_source_url",
        details:
          "Missing source_url. Add the provider's pricing page URL so the next " +
          "verifier (human or workflow) can find it without a search.",
      });
    }
    if (!e.last_verified_at) {
      issues.push({
        provider: e.provider,
        model: e.model,
        problem: "no_verified_at",
        details:
          "Missing last_verified_at. Set to today's date (YYYY-MM-DD) when you " +
          "next confirm the price against source_url.",
      });
      continue;
    }
    const age = ageDays(e.last_verified_at);
    if (age > args.maxAgeDays) {
      issues.push({
        provider: e.provider,
        model: e.model,
        problem: "stale",
        details: `Last verified ${age} day(s) ago (max ${args.maxAgeDays}). ${
          e.source_url ?? ""
        }`.trim(),
      });
    }
  }

  if (args.json) {
    const payload = {
      file,
      max_age_days: args.maxAgeDays,
      total_entries: entries.length,
      stale_count: issues.filter((i) => i.problem === "stale").length,
      missing_verified_at_count: issues.filter(
        (i) => i.problem === "no_verified_at"
      ).length,
      missing_source_url_count: issues.filter(
        (i) => i.problem === "no_source_url"
      ).length,
      issues,
    };
    console.log(JSON.stringify(payload, null, 2));
    process.exit(issues.length > 0 ? 1 : 0);
  }

  console.log(`[freshness] checked ${entries.length} entries in ${file}`);
  console.log(
    `[freshness] threshold: last_verified_at must be within ${args.maxAgeDays} days`
  );
  if (issues.length === 0) {
    console.log("[freshness] OK — every entry is fresh and has full provenance.");
    process.exit(0);
  }

  const stale = issues.filter((i) => i.problem === "stale");
  const noVerified = issues.filter((i) => i.problem === "no_verified_at");
  const noSource = issues.filter((i) => i.problem === "no_source_url");

  if (stale.length > 0) {
    console.log(`\n[freshness] STALE entries (${stale.length}):`);
    for (const i of stale) {
      console.log(`  ${i.provider}/${i.model} — ${i.details}`);
    }
  }
  if (noVerified.length > 0) {
    console.log(
      `\n[freshness] entries missing last_verified_at (${noVerified.length}):`
    );
    for (const i of noVerified) {
      console.log(`  ${i.provider}/${i.model}`);
    }
  }
  if (noSource.length > 0) {
    console.log(
      `\n[freshness] entries missing source_url (${noSource.length}):`
    );
    for (const i of noSource) {
      console.log(`  ${i.provider}/${i.model}`);
    }
  }

  console.log(
    `\n[freshness] FAIL — fix the issues above (or re-run with --max-age=N if intentional).`
  );
  process.exit(1);
}

await main();
