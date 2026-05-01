#!/usr/bin/env bun
/**
 * Live feature-smoke against your localhost gateway.
 *
 * USAGE
 * -----
 * 1. Make sure your gateway + Postgres are running locally:
 *      docker compose up -d
 *      cd apps/gateway && bun run dev
 *
 * 2. Tell the script which API key to use. Recommended: drop a line
 *    into `apps/gateway/.env.local` (gitignored, auto-loaded by Bun) so
 *    you never have to retype the key:
 *      TS_API_KEY=ts_xxxxxxxxxxxxxxxxxxxx
 *      ANTHROPIC_MODEL=claude-3-5-haiku-latest   # optional, for scenario 4
 *
 *    Or one-shot via env on the command line:
 *      TS_API_KEY=ts_xxxx bun run smoke:features
 *
 *    Last-resort: edit `TS_API_KEY` in this file directly (DO NOT commit).
 *
 * 3. From `apps/gateway`:
 *      bun run smoke:features
 *
 * Other env knobs (all optional):
 *   GATEWAY_URL       default http://localhost:8787
 *   SMOKE_MODEL       default gpt-4o-mini
 *   ANTHROPIC_MODEL   default "" (skip scenario 4)
 *   DATABASE_URL      default the docker-compose Postgres URL
 *   SMOKE_SCENARIOS   default "1,2,3,4" — comma-separated subset.
 *                     Recommended for prod smoke (avoids writing 12+
 *                     loop-detected rows into the live ledger):
 *                       SMOKE_SCENARIOS=1,2 \
 *                         GATEWAY_URL=https://gateway.tokensmt.com \
 *                         TS_API_KEY=ts_live_project_key \
 *                         bun run smoke:features
 *
 * WHAT IT VERIFIES
 * ----------------
 *   1. Auth + key reuse           — three same-key calls all return 200.
 *                                    Catches regressions in the new
 *                                    `findApiKey` 60s in-memory cache,
 *                                    and prints latencies so you can
 *                                    eyeball the warm vs cold delta.
 *   2. Negative cache safety      — a wrong key 401s twice AND the real
 *                                    key still works after — catches
 *                                    cross-key pollution in the negative
 *                                    side of the cache.
 *   3. Loop detection             — twelve identical prompts trip the
 *                                    durable loop window and return 403
 *                                    `loop_detected` before the burst
 *                                    completes.
 *   4. Anthropic cache_control    — (skipped unless ANTHROPIC_MODEL is
 *                                    set) the request_body row stored
 *                                    in `requests` carries the auto-
 *                                    injected `cache_control` markers.
 *
 * COSTS
 * -----
 * Scenario 3 sends ~12 real upstream calls; scenario 4 sends 1; the others
 * add 4-6 more. Pick a cheap SMOKE_MODEL (gpt-4o-mini is the default).
 * Total: ~$0.001 per run on gpt-4o-mini.
 *
 * EXIT CODES
 * ----------
 *   0  every scenario passed (or was deliberately skipped)
 *   1  one or more scenarios failed
 *   2  setup error (gateway unreachable, key not configured, etc.)
 */

import { buildSql } from "../src/sql-driver";

// =====================================================================
// EDIT HERE — your localhost setup
// =====================================================================

const PLACEHOLDER = "REPLACE_ME";

/**
 * Bearer token your gateway accepts. For hosted/multi-tenant: a
 * project key minted from /projects/[id] (`ts_…`). For self-hosted
 * single-tenant: the gateway's bootstrap key (`tokensmart-dev-key`
 * out of the box, otherwise whatever the bootstrap log printed at
 * boot time).
 */
const TS_API_KEY = process.env.TS_API_KEY || PLACEHOLDER;

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:8787";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://tokensmart:tokensmart_dev@localhost:5432/tokensmart";

/**
 * Any cheap model your gateway can resolve (BYO or env credential).
 * Used for the auth + loop-detection scenarios.
 */
const SMOKE_MODEL = process.env.SMOKE_MODEL ?? "gpt-4o-mini";

/**
 * Optional Anthropic model for the cache_control scenario. Empty =
 * skip. Requires an Anthropic BYO/env key configured on the gateway.
 */
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? "";

/**
 * Subset filter — comma-separated scenario IDs (1..4). Unset = run all.
 *
 * Useful for prod smokes where the destructive scenarios shouldn't
 * touch the live ledger:
 *   SMOKE_SCENARIOS=1,2 \
 *     GATEWAY_URL=https://gateway.tokensmt.com \
 *     TS_API_KEY=ts_live_project_key \
 *     bun run smoke:features
 *
 * Reasoning:
 *   * #1 Auth+reuse and #2 negative-cache are READ-only as far as the
 *     ledger is concerned — they create successful + failed-auth rows
 *     that look just like real traffic, which is fine.
 *   * #3 Loop detection writes 12 identical "loop-smoke-…" rows AND
 *     trips the durable loop window for that fingerprint for ~5min,
 *     which would also fire any `loop_detected` webhook subscriptions.
 *     Don't run on prod unless you actually want that.
 *   * #4 Anthropic cache_control spends real tokens on a ~1500-token
 *     prompt, ~$0.0006 on Haiku. Cheap, but not free.
 */
const SMOKE_SCENARIOS_RAW = process.env.SMOKE_SCENARIOS?.trim() ?? "";

const ALL_SCENARIO_IDS = [1, 2, 3, 4] as const;
type ScenarioId = (typeof ALL_SCENARIO_IDS)[number];

function parseScenarioFilter(raw: string): Set<ScenarioId> {
  if (!raw) return new Set(ALL_SCENARIO_IDS);
  const out = new Set<ScenarioId>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const n = Number(trimmed);
    if (
      !Number.isInteger(n) ||
      !(ALL_SCENARIO_IDS as readonly number[]).includes(n)
    ) {
      throw new Error(
        `SMOKE_SCENARIOS contains invalid id "${trimmed}"; valid: ${ALL_SCENARIO_IDS.join(",")}`
      );
    }
    out.add(n as ScenarioId);
  }
  if (out.size === 0) {
    throw new Error("SMOKE_SCENARIOS is empty after parsing");
  }
  return out;
}

// =====================================================================
// Helpers
// =====================================================================

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

type Result = { name: string; passed: boolean | null; detail: string };
const results: Result[] = [];

type ChatResp = {
  status: number;
  ms: number;
  requestId: string | null;
  bodyText: string;
};

async function chat(opts: {
  apiKey: string;
  body: Record<string, unknown>;
}): Promise<ChatResp> {
  const t0 = performance.now();
  const r = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(opts.body),
  });
  const ms = performance.now() - t0;
  let text = "";
  try {
    text = await r.text();
  } catch {
    // ignore body-drain errors — we mostly care about the status code
  }
  return {
    status: r.status,
    ms,
    requestId: r.headers.get("x-tokensmart-request-id"),
    bodyText: text.slice(0, 200),
  };
}

// =====================================================================
// Scenario 1 — Auth + key reuse
// =====================================================================

async function scenarioAuthAndKeyReuse(): Promise<void> {
  const name = "1. Auth + key reuse (3 same-key calls)";
  const calls: ChatResp[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await chat({
      apiKey: TS_API_KEY,
      body: {
        model: SMOKE_MODEL,
        messages: [
          {
            role: "user",
            // Unique per call so loop detection / semantic cache
            // don't kick in and skew the latency reading.
            content: `smoke-auth-probe ${Date.now()}-${i}`,
          },
        ],
        max_tokens: 16,
      },
    });
    calls.push(r);
  }
  const allOk = calls.every((c) => c.status === 200);
  const lats = calls.map((c) => Math.round(c.ms)).join("ms / ");
  const ids = calls.map((c) => c.requestId?.slice(0, 8) ?? "?").join(", ");
  if (allOk) {
    results.push({
      name,
      passed: true,
      detail: `latencies ${lats}ms (cold → warm) · req ids ${ids}`,
    });
  } else {
    results.push({
      name,
      passed: false,
      detail:
        `statuses ${calls.map((c) => c.status).join("/")} · ` +
        `first body: ${calls[0]?.bodyText ?? "(empty)"}`,
    });
  }
}

// =====================================================================
// Scenario 2 — Negative cache safety
// =====================================================================

async function scenarioNegativeCacheSafety(): Promise<void> {
  const name = "2. Negative auth cache (wrong key stays 401)";
  const wrongKey = `ts_obviously_fake_smoke_${Date.now()}`;
  const w1 = await chat({
    apiKey: wrongKey,
    body: {
      model: SMOKE_MODEL,
      messages: [{ role: "user", content: "neg-cache probe a" }],
      max_tokens: 8,
    },
  });
  const w2 = await chat({
    apiKey: wrongKey,
    body: {
      model: SMOKE_MODEL,
      messages: [{ role: "user", content: "neg-cache probe b" }],
      max_tokens: 8,
    },
  });
  // Real key must STILL work — the negative-cache entry for the wrong
  // key must not have leaked into the real key's slot.
  const real = await chat({
    apiKey: TS_API_KEY,
    body: {
      model: SMOKE_MODEL,
      messages: [
        { role: "user", content: `neg-cache real ${Date.now()}` },
      ],
      max_tokens: 8,
    },
  });
  const passed = w1.status === 401 && w2.status === 401 && real.status === 200;
  results.push({
    name,
    passed,
    detail: `wrong → ${w1.status} / ${w2.status} · real → ${real.status}`,
  });
}

// =====================================================================
// Scenario 3 — Loop detection
// =====================================================================

async function scenarioLoopDetection(): Promise<void> {
  const name = "3. Loop detection (12 identical → 403 loop_detected)";
  // Unique-per-run so re-running the smoke doesn't get pre-blocked
  // by a leftover loop window from the previous run (durable window
  // is several minutes long).
  const constantPrompt = `loop-smoke-${Date.now()}`;
  const statuses: number[] = [];
  let lastBody = "";
  for (let i = 0; i < 12; i++) {
    const r = await chat({
      apiKey: TS_API_KEY,
      body: {
        model: SMOKE_MODEL,
        messages: [{ role: "user", content: constantPrompt }],
        max_tokens: 8,
      },
    });
    statuses.push(r.status);
    lastBody = r.bodyText;
    if (r.status === 403) break;
  }
  const final = statuses[statuses.length - 1];
  const loopBodyOk = final === 403 && lastBody.includes("loop_detected");
  results.push({
    name,
    passed: loopBodyOk,
    detail: `statuses=[${statuses.join(",")}] · final=${final}${
      loopBodyOk ? " (loop_detected: yes)" : ""
    }`,
  });
}

// =====================================================================
// Scenario 4 — Anthropic auto cache_control (optional)
// =====================================================================

async function scenarioAnthropicCacheControl(): Promise<void> {
  const name = "4. Anthropic auto cache_control (DB row carries markers)";
  if (!ANTHROPIC_MODEL) {
    results.push({
      name,
      passed: null,
      detail: "skipped — set ANTHROPIC_MODEL=claude-3-5-haiku-latest to run",
    });
    return;
  }
  // Prompt has to clear the 3500-byte cache_control threshold (see
  // apps/gateway/src/cache-control.ts MIN_CACHEABLE_BYTES). 50 reps of
  // ~85 chars = ~4200 chars, comfortably above the bar.
  const longSystem =
    "You are a helpful coding assistant who reviews code and writes clear documentation. ".repeat(
      50
    );
  const r = await chat({
    apiKey: TS_API_KEY,
    body: {
      model: ANTHROPIC_MODEL,
      messages: [
        { role: "system", content: longSystem },
        {
          role: "user",
          content: `cache_control probe ${Date.now()}`,
        },
      ],
      max_tokens: 32,
    },
  });
  if (r.status !== 200 || !r.requestId) {
    results.push({
      name,
      passed: false,
      detail: `request itself failed: status=${r.status}, body=${r.bodyText}`,
    });
    return;
  }
  // Give the post-stream best-effort `insertRequest` a tick to land —
  // same trick the e2e + dashboard tests use.
  await Bun.sleep(200);
  const sql = buildSql(DATABASE_URL);
  try {
    // We check the `tags` column rather than the `request_body` column
    // because the gateway's default request-body storage policy is
    // `sample` — only ~1% of success rows keep the full body, the
    // other 99% land as a stub `{truncated:true, ...}` that doesn't
    // carry the cache_control marker. The `tags` JSONB is always
    // stored fully (see chat.ts: the gateway stamps
    // `tags.cache_control = "system,..."` whenever auto-injection
    // tags at least one block), so reading it gives a deterministic
    // signal regardless of the storage mode.
    type Row = { tags: unknown };
    const rows = await sql<Row[]>`
      SELECT tags FROM requests WHERE id = ${r.requestId} LIMIT 1
    `;
    const rawTags = rows[0]?.tags;
    if (rawTags == null) {
      results.push({
        name,
        passed: false,
        detail: `no requests row for id=${r.requestId} after 200ms wait`,
      });
      return;
    }
    // Postgres jsonb auto-parses to object; SQLite shim returns a
    // string. Normalize so the lookup below is uniform.
    const tagsObj =
      typeof rawTags === "string"
        ? (JSON.parse(rawTags) as Record<string, string>)
        : (rawTags as Record<string, string>);
    const stamped = tagsObj.cache_control;
    const hasSystemTag =
      typeof stamped === "string" && stamped.split(",").includes("system");
    results.push({
      name,
      passed: hasSystemTag,
      detail: hasSystemTag
        ? `req ${r.requestId.slice(0, 8)} tags.cache_control="${stamped}" — system block tagged`
        : `req ${r.requestId.slice(0, 8)} no tags.cache_control on row — ` +
          `auto-injection didn't fire (TOKENSMART_AUTO_CACHE_CONTROL=0? non-Anthropic provider? ` +
          `system prompt < ${3500} bytes?)`,
    });
  } finally {
    // postgres.js `end()` lets us exit cleanly. Best-effort.
    await (sql as unknown as { end: () => Promise<void> })
      .end()
      .catch(() => {});
  }
}

// =====================================================================
// main
// =====================================================================

/**
 * Static registry of every scenario in the suite. Order here is the
 * order they execute. The numeric `id` is the public stable handle —
 * once you ship `SMOKE_SCENARIOS=1,2`, these ids are part of the
 * contract; renumber with care.
 */
const SCENARIO_REGISTRY: Array<{
  id: ScenarioId;
  fn: () => Promise<void>;
}> = [
  { id: 1, fn: scenarioAuthAndKeyReuse },
  { id: 2, fn: scenarioNegativeCacheSafety },
  { id: 3, fn: scenarioLoopDetection },
  { id: 4, fn: scenarioAnthropicCacheControl },
];

async function main() {
  if (TS_API_KEY === PLACEHOLDER) {
    console.error(
      c.red(
        "TS_API_KEY is not set. Either edit `TS_API_KEY` in this script\n" +
          "or run with the env var:\n" +
          "  TS_API_KEY=ts_xxxxxxxxxxxxxx bun run smoke:features"
      )
    );
    process.exit(2);
  }

  let selected: Set<ScenarioId>;
  try {
    selected = parseScenarioFilter(SMOKE_SCENARIOS_RAW);
  } catch (err) {
    console.error(c.red((err as Error).message));
    process.exit(2);
  }

  // Probe gateway is up before we spend money on real upstream calls.
  try {
    const h = await fetch(`${GATEWAY_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!h.ok) {
      console.error(
        c.red(`Gateway at ${GATEWAY_URL}/health → HTTP ${h.status}.`)
      );
      process.exit(2);
    }
  } catch {
    console.error(
      c.red(
        `Cannot reach gateway at ${GATEWAY_URL}. Start it with:\n  cd apps/gateway && bun run dev`
      )
    );
    process.exit(2);
  }

  console.log(c.bold("\n=== TokSuan feature smoke ==="));
  console.log(`  gateway:          ${GATEWAY_URL}`);
  console.log(`  smoke model:      ${SMOKE_MODEL}`);
  console.log(
    `  anthropic model:  ${ANTHROPIC_MODEL || c.dim("(skipped — set ANTHROPIC_MODEL to enable)")}`
  );
  // Show which scenarios will actually run. Distinguish "all four"
  // (default) from an explicit subset so prod operators aren't
  // wondering whether the filter took effect.
  if (SMOKE_SCENARIOS_RAW) {
    const sortedIds = [...selected].sort((a, b) => a - b).join(",");
    console.log(`  scenarios:        ${sortedIds} ${c.dim(`(SMOKE_SCENARIOS=${SMOKE_SCENARIOS_RAW})`)}`);
  } else {
    console.log(`  scenarios:        ${[...selected].sort().join(",")} ${c.dim("(default — all four; set SMOKE_SCENARIOS to filter)")}`);
  }
  console.log("");

  for (const scenario of SCENARIO_REGISTRY) {
    if (!selected.has(scenario.id)) continue;
    await scenario.fn();
  }

  let failed = 0;
  let skipped = 0;
  console.log(c.bold("\n=== results ===\n"));
  for (const r of results) {
    const tag =
      r.passed === true
        ? c.green("PASS")
        : r.passed === null
          ? c.yellow("SKIP")
          : c.red("FAIL");
    console.log(`  ${tag}  ${r.name}`);
    console.log(`        ${c.dim(r.detail)}`);
    if (r.passed === false) failed++;
    if (r.passed === null) skipped++;
  }
  console.log("");

  if (failed > 0) {
    console.error(c.red(`${failed} scenario(s) failed.`));
    process.exit(1);
  }
  const passedCount = results.length - skipped;
  console.log(
    c.green(
      `All ${passedCount} scenario(s) passed${
        skipped > 0 ? `, ${skipped} skipped.` : "."
      }`
    )
  );
}

await main();
