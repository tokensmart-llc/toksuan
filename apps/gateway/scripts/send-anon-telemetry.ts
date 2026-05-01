#!/usr/bin/env bun
/**
 * Opt-in anonymous aggregate telemetry sender.
 *
 * Defaults to OFF. A self-hosted operator must explicitly set:
 *
 *   TOKENSMART_ANON_TELEMETRY=1
 *
 * Optional knobs:
 *
 *   TOKENSMART_ANON_TELEMETRY_ENDPOINT=https://tokensmt.com/api/telemetry/agent-spend
 *   TOKENSMART_ANON_TELEMETRY_DEPLOYMENT_ID=random-local-string  (required)
 *   TOKENSMART_ANON_TELEMETRY_MIN_ROUTE_REQUESTS=5
 *   TOKENSMART_ANON_TELEMETRY_MIN_ROUTE_PROJECTS=1
 *
 * Usage:
 *
 *   TOKENSMART_ANON_TELEMETRY_DEPLOYMENT_ID=random-local-string \
 *     bun run send-anon-telemetry -- --yesterday --dry-run
 *   TOKENSMART_ANON_TELEMETRY=1 bun run send-anon-telemetry -- --yesterday
 *
 * Privacy posture:
 *   - sends daily aggregate counts and route pairs only
 *   - never sends prompts, responses, API keys, request ids, project names,
 *     user emails, or exact per-request timestamps
 *   - locally suppresses route rows below min-route thresholds
 */

import {
  anonTelemetryEndpoint,
  collectAnonTelemetry,
  isAnonTelemetryEnabled,
  yesterdayWindow,
} from "../src/anon-telemetry";

function usage(): never {
  console.error(`Usage:
  bun run send-anon-telemetry -- --yesterday [--dry-run]
  bun run send-anon-telemetry -- --start YYYY-MM-DD --end YYYY-MM-DD [--dry-run]

Env:
  TOKENSMART_ANON_TELEMETRY=1                 required unless --dry-run
  TOKENSMART_ANON_TELEMETRY_DEPLOYMENT_ID=<random-local-id>  required
  TOKENSMART_ANON_TELEMETRY_ENDPOINT=<url>    optional
`);
  process.exit(2);
}

function parseDateOnly(raw: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`Expected YYYY-MM-DD, got '${raw}'`);
  }
  return new Date(`${raw}T00:00:00.000Z`);
}

function parseArgs(argv: string[]): {
  start: Date;
  end: Date;
  dryRun: boolean;
} {
  let start: Date | null = null;
  let end: Date | null = null;
  let dryRun = false;
  let yesterday = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--yesterday") {
      yesterday = true;
    } else if (arg === "--start") {
      const next = argv[++i];
      if (!next) usage();
      start = parseDateOnly(next);
    } else if (arg === "--end") {
      const next = argv[++i];
      if (!next) usage();
      end = parseDateOnly(next);
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      console.error(`Unknown arg: ${arg}`);
      usage();
    }
  }

  if (yesterday) {
    if (start || end) usage();
    return { ...yesterdayWindow(), dryRun };
  }
  if (!start || !end || start >= end) usage();
  return { start, end, dryRun };
}

async function main(): Promise<void> {
  const { start, end, dryRun } = parseArgs(process.argv.slice(2));
  if (!dryRun && !isAnonTelemetryEnabled()) {
    console.error(
      "[anon-telemetry] disabled. Set TOKENSMART_ANON_TELEMETRY=1 or run with --dry-run."
    );
    process.exit(2);
  }

  const payload = await collectAnonTelemetry({ start, end });
  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const endpoint = anonTelemetryEndpoint();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "TokSuan/anon-telemetry (+https://tokensmt.com)",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "<unreadable>");
      console.error(
        `[anon-telemetry] POST ${endpoint} -> HTTP ${res.status}: ${body.slice(0, 500)}`
      );
      process.exit(1);
    }
    console.log(
      `[anon-telemetry] sent ${payload.window.start}..${payload.window.end}: ${payload.totals.requests} requests, ${payload.routes.length} route rows`
    );
  } finally {
    clearTimeout(timer);
  }
}

main().catch((err) => {
  console.error("[anon-telemetry] failed:", err);
  process.exit(1);
});

