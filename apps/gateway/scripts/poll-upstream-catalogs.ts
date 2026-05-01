#!/usr/bin/env bun
/**
 * L2 scaffold — upstream-catalog freshness checker.
 *
 * Polls every supported provider's `/v1/models` endpoint (or equivalent
 * listing API) and diffs the returned model IDs against the entries in
 * `apps/gateway/data/pricing.json`. The output is a human-readable
 * report + a machine-readable JSON artifact an operator can feed into
 * an auto-PR workflow.
 *
 * What this script DOES today:
 *   - Queries each provider's public model-list endpoint
 *   - Matches every returned model ID against the existing pricing.json
 *     entries by exact (provider, model) tuple
 *   - Emits two lists: NEW (returned upstream, not in pricing.json),
 *     STALE (in pricing.json, no longer returned upstream — might be
 *     deprecated)
 *   - Writes JSON artifact to `scripts/out/upstream-catalog-diff.json`
 *   - Prints a pricing-freshness-style summary to stdout
 *
 * What this script DELIBERATELY does NOT do yet:
 *   - Does NOT auto-add new entries to pricing.json — upstream model
 *     listings don't include prices, so the operator still has to
 *     look up USD/1M-tokens and fill them in. An auto-PR that opens
 *     a tracking issue is the right next step.
 *   - Does NOT trigger a benchmark sweep on new models. That's the
 *     L2 "full automation" arc — each new model costs ~$2-5 of
 *     upstream spend for a full policy-eval sweep
 *     at frontier pricing). Gating that behind operator approval
 *     is the right posture for v0 — the script prints what WOULD be
 *     benchmarked if you ran it.
 *
 * Cron target: once a week is plenty — provider catalogs churn slowly.
 * The existing `pricing-freshness.yml` workflow is the natural home.
 *
 * Safety:
 *   - Read-only against upstream APIs (no model calls, no spend)
 *   - Read-only against pricing.json (never writes)
 *   - Fail-soft: a provider that doesn't expose /v1/models (or is
 *     down) is skipped with a warning, not a fatal exit
 *
 * Examples:
 *   bun run poll-upstream-catalogs              # full sweep, all providers
 *   bun run poll-upstream-catalogs -- --providers openai,anthropic
 *   bun run poll-upstream-catalogs -- --format github     # gh-issue-style markdown
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ProviderId = "openai" | "anthropic" | "deepseek" | "qwen" | "doubao";

const SUPPORTED: ProviderId[] = [
  "openai",
  "anthropic",
  "deepseek",
  "qwen",
  "doubao",
];

/**
 * Per-provider listing strategy. Keeping this as an interface so adding
 * a new provider (Groq, xAI, Mistral direct) is one new entry + a
 * listModels implementation.
 */
interface CatalogStrategy {
  readonly id: ProviderId;
  readonly baseUrl: string;
  /** Env var the operator stashes the auth token in. */
  readonly envKey: string;
  /** GET {baseUrl}/models returns `{data: [{id: "..."}, …]}` for every
   *  listed OpenAI-compat endpoint + Anthropic's own list API. DeepSeek /
   *  Qwen share the same shape; Doubao needs a custom path. */
  listModels(apiKey: string): Promise<string[]>;
}

async function fetchOpenAICompatList(baseUrl: string, apiKey: string, headerName = "Authorization", prefix = "Bearer "): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      [headerName]: `${prefix}${apiKey}`,
      accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} from ${url}`);
  }
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  if (!Array.isArray(body.data)) {
    throw new Error(`unexpected response shape from ${url}`);
  }
  return body.data.map((d) => d.id).filter((x): x is string => typeof x === "string");
}

const STRATEGIES: CatalogStrategy[] = [
  {
    id: "openai",
    baseUrl: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
    listModels: (k) => fetchOpenAICompatList("https://api.openai.com/v1", k),
  },
  {
    id: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    envKey: "ANTHROPIC_API_KEY",
    listModels: async (apiKey) => {
      // Anthropic's list endpoint uses x-api-key + anthropic-version.
      const res = await fetch("https://api.anthropic.com/v1/models", {
        method: "GET",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          accept: "application/json",
        },
      });
      if (!res.ok) {
        throw new Error(
          `${res.status} ${res.statusText} from https://api.anthropic.com/v1/models`
        );
      }
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      return (body.data ?? [])
        .map((d) => d.id)
        .filter((x): x is string => typeof x === "string");
    },
  },
  {
    id: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    envKey: "DEEPSEEK_API_KEY",
    listModels: (k) => fetchOpenAICompatList("https://api.deepseek.com/v1", k),
  },
  {
    id: "qwen",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    envKey: "QWEN_API_KEY",
    listModels: (k) =>
      fetchOpenAICompatList(
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        k
      ),
  },
  {
    id: "doubao",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    envKey: "DOUBAO_API_KEY",
    // Volcengine Ark doesn't expose /v1/models publicly — operators
    // register models via the console + endpoint IDs. We skip the
    // catalog poll for now; a future iteration can scrape the
    // public pricing page instead.
    listModels: async () => {
      throw new Error("doubao: no /v1/models catalog endpoint; skip");
    },
  },
];

// =========================================================================
// CLI parsing (tiny, no deps)
// =========================================================================

interface Args {
  providers: Set<ProviderId>;
  format: "text" | "github";
  outJson: string;
  pricingPath: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    providers: new Set<ProviderId>(SUPPORTED),
    format: "text",
    outJson: path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "out",
      "upstream-catalog-diff.json"
    ),
    pricingPath: path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "data",
      "pricing.json"
    ),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--providers": {
        const picks = (next ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        for (const p of picks) {
          if (!SUPPORTED.includes(p as ProviderId)) {
            fail(
              `unknown provider '${p}' — must be one of ${SUPPORTED.join(", ")}`
            );
          }
        }
        a.providers = new Set(picks as ProviderId[]);
        i++;
        break;
      }
      case "--format":
        if (next !== "text" && next !== "github") {
          fail(`--format must be 'text' or 'github'`);
        }
        a.format = next;
        i++;
        break;
      case "--out":
        a.outJson = path.resolve(next ?? "");
        i++;
        break;
      case "--pricing":
        a.pricingPath = path.resolve(next ?? "");
        i++;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        if (arg && arg.startsWith("--")) fail(`unknown flag: ${arg}`);
    }
  }
  return a;
}

function fail(msg: string): never {
  console.error(`poll-upstream-catalogs: ${msg}`);
  process.exit(1);
}

function printHelp(): void {
  console.log(`Usage:
  bun run poll-upstream-catalogs [-- options]

Diffs each provider's /v1/models catalog against apps/gateway/data/pricing.json,
so operators know which newly-released models the gateway doesn't price yet.

Options:
  --providers a,b,c   Subset to poll. Default: all supported. Valid ids:
                      ${SUPPORTED.join(", ")}
  --format text|github   Output format. 'text' (default) is terminal-friendly;
                         'github' emits markdown suitable for gh-issue body.
  --out PATH          JSON artifact path. Default: scripts/out/upstream-catalog-diff.json
  --pricing PATH      pricing.json to diff against. Default: apps/gateway/data/pricing.json

Env:
  OPENAI_API_KEY / ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / QWEN_API_KEY /
  DOUBAO_API_KEY — each provider needs its own key to call /v1/models. Missing
  keys cause that provider to be skipped with a warning.

Exits non-zero only on argument errors + IO failures — never on
individual provider fetch failures (those are logged + skipped).
`);
}

// =========================================================================
// Pricing.json loader
// =========================================================================

interface PricingEntry {
  provider: ProviderId;
  model: string;
  inputUsdPerM?: number;
  outputUsdPerM?: number;
  last_verified_at?: string;
}

interface PricingFile {
  generated_at?: string;
  entries: PricingEntry[];
}

function loadPricing(p: string): PricingFile {
  const raw = readFileSync(p, "utf8");
  const parsed = JSON.parse(raw) as PricingFile;
  if (!Array.isArray(parsed.entries)) {
    fail(`pricing.json at ${p} has no 'entries' array`);
  }
  return parsed;
}

// =========================================================================
// Main
// =========================================================================

interface ProviderReport {
  provider: ProviderId;
  status: "ok" | "skipped" | "failed";
  reason?: string;
  upstream_count: number;
  shipped_count: number;
  new_upstream: string[]; // in upstream but not in pricing.json
  stale_shipped: string[]; // in pricing.json but not in upstream
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pricing = loadPricing(args.pricingPath);

  const shippedByProvider = new Map<ProviderId, Set<string>>();
  for (const e of pricing.entries) {
    const s = shippedByProvider.get(e.provider) ?? new Set<string>();
    s.add(e.model);
    shippedByProvider.set(e.provider, s);
  }

  const reports: ProviderReport[] = [];
  for (const strategy of STRATEGIES) {
    if (!args.providers.has(strategy.id)) continue;
    const apiKey = process.env[strategy.envKey];
    if (!apiKey) {
      reports.push({
        provider: strategy.id,
        status: "skipped",
        reason: `env ${strategy.envKey} unset`,
        upstream_count: 0,
        shipped_count: shippedByProvider.get(strategy.id)?.size ?? 0,
        new_upstream: [],
        stale_shipped: [],
      });
      continue;
    }
    let upstream: string[];
    try {
      upstream = await strategy.listModels(apiKey);
    } catch (err) {
      reports.push({
        provider: strategy.id,
        status: "failed",
        reason: (err as Error).message,
        upstream_count: 0,
        shipped_count: shippedByProvider.get(strategy.id)?.size ?? 0,
        new_upstream: [],
        stale_shipped: [],
      });
      continue;
    }
    const upstreamSet = new Set(upstream);
    const shipped = shippedByProvider.get(strategy.id) ?? new Set<string>();
    const newUpstream = [...upstreamSet].filter((m) => !shipped.has(m)).sort();
    const staleShipped = [...shipped].filter((m) => !upstreamSet.has(m)).sort();
    reports.push({
      provider: strategy.id,
      status: "ok",
      upstream_count: upstreamSet.size,
      shipped_count: shipped.size,
      new_upstream: newUpstream,
      stale_shipped: staleShipped,
    });
  }

  // Emit artifact
  const outDir = path.dirname(args.outJson);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(
    args.outJson,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        pricing_generated_at: pricing.generated_at ?? null,
        reports,
      },
      null,
      2
    ) + "\n"
  );

  // Render human output
  if (args.format === "github") {
    renderMarkdown(reports);
  } else {
    renderText(reports);
  }

  console.log(`\n[poll] wrote artifact → ${args.outJson}`);
}

function renderText(reports: ProviderReport[]): void {
  console.log("=== Upstream catalog freshness ===\n");
  for (const r of reports) {
    const header =
      r.status === "ok"
        ? `${r.provider.padEnd(10)} upstream=${r.upstream_count} shipped=${r.shipped_count}`
        : `${r.provider.padEnd(10)} [${r.status.toUpperCase()}] ${r.reason}`;
    console.log(header);
    if (r.status !== "ok") continue;
    if (r.new_upstream.length === 0 && r.stale_shipped.length === 0) {
      console.log(`  ✓ in sync`);
      continue;
    }
    if (r.new_upstream.length > 0) {
      console.log(`  + NEW in upstream (not priced yet): ${r.new_upstream.length}`);
      for (const m of r.new_upstream.slice(0, 20)) {
        console.log(`      ${m}`);
      }
      if (r.new_upstream.length > 20) {
        console.log(`      … (+${r.new_upstream.length - 20} more)`);
      }
    }
    if (r.stale_shipped.length > 0) {
      console.log(`  - STALE in pricing.json (gone upstream): ${r.stale_shipped.length}`);
      for (const m of r.stale_shipped.slice(0, 20)) {
        console.log(`      ${m}`);
      }
      if (r.stale_shipped.length > 20) {
        console.log(`      … (+${r.stale_shipped.length - 20} more)`);
      }
    }
    console.log();
  }
}

function renderMarkdown(reports: ProviderReport[]): void {
  console.log("## Upstream catalog freshness\n");
  for (const r of reports) {
    if (r.status !== "ok") {
      console.log(`### \`${r.provider}\`  — **${r.status}**`);
      if (r.reason) console.log(`> ${r.reason}\n`);
      continue;
    }
    console.log(
      `### \`${r.provider}\`  — upstream=${r.upstream_count}, shipped=${r.shipped_count}`
    );
    if (r.new_upstream.length === 0 && r.stale_shipped.length === 0) {
      console.log(`\n✅ in sync\n`);
      continue;
    }
    if (r.new_upstream.length > 0) {
      console.log(
        `\n#### ➕ New upstream models (not in pricing.json) — ${r.new_upstream.length}\n`
      );
      for (const m of r.new_upstream) console.log(`- \`${m}\``);
    }
    if (r.stale_shipped.length > 0) {
      console.log(
        `\n#### ➖ Stale shipped models (no longer in upstream catalog) — ${r.stale_shipped.length}\n`
      );
      for (const m of r.stale_shipped) console.log(`- \`${m}\``);
    }
    console.log();
  }
}

await main().catch((err) => {
  console.error("poll-upstream-catalogs: fatal:", err);
  process.exit(1);
});
