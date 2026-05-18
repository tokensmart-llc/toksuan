#!/usr/bin/env bun
/**
 * What the dashboard's savings hero card WOULD show if it could read this
 * SQLite database. This is a stand-in for the dashboard view when running
 * in single-binary SQLite mode — the actual dashboard at /dashboard
 * hardcodes a Postgres driver (apps/dashboard/src/lib/db.ts), so SQLite-mode
 * users currently can't render those cards. The data is real either way;
 * this script just runs the same SQL the dashboard does, against SQLite.
 *
 *   Run: bun run scripts/preview-dashboard-savings.ts
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";

const DB_PATH =
  process.env.TOKENSMART_SQLITE_PATH ??
  resolve(import.meta.dir, "../data/tokensmart-dev.db");

let db: Database;
try {
  db = new Database(DB_PATH, { readonly: true });
} catch (e) {
  console.error(`Could not open ${DB_PATH}.`);
  console.error("Did the gateway boot at least once to create the file?");
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}

type Row = {
  routing_saving: number;
  cache_saving: number;
  tool_compress_saving: number;
  total_spend: number;
  routing_request_count: number;
  cache_hit_count: number;
  tool_compress_request_count: number;
  loops_prevented_count: number;
  budget_blocked_count: number;
};

// Same logic as apps/dashboard/src/lib/db.ts getSavingsBreakdown,
// rewritten in SQLite-native syntax (json_extract instead of `tags->>`).
const SQL_30D = `
  SELECT
    COALESCE(SUM(routing_saving_micro_cents), 0)            AS routing_saving,
    COALESCE(SUM(cache_savings_micro_cents), 0)             AS cache_saving,
    COALESCE(SUM(
      CASE
        WHEN json_extract(tags, '$.tool_compress_micro_cents_saved_est') IS NOT NULL
          THEN CAST(json_extract(tags, '$.tool_compress_micro_cents_saved_est') AS INTEGER)
        ELSE 0
      END
    ), 0) AS tool_compress_saving,
    COALESCE(SUM(cost_micro_cents), 0) AS total_spend,
    SUM(CASE WHEN routing_saving_micro_cents > 0 THEN 1 ELSE 0 END) AS routing_request_count,
    SUM(CASE WHEN cached_input_tokens > 0 THEN 1 ELSE 0 END) AS cache_hit_count,
    SUM(CASE WHEN json_extract(tags, '$.tool_compress_applied') = '1' THEN 1 ELSE 0 END) AS tool_compress_request_count,
    SUM(CASE WHEN status = 'loop_detected' THEN 1 ELSE 0 END) AS loops_prevented_count,
    SUM(CASE WHEN status IN ('budget_exceeded', 'plan_limit_exceeded') THEN 1 ELSE 0 END) AS budget_blocked_count
  FROM requests
  WHERE created_at > datetime('now', '-30 days')
`;

const row = db.query<Row, []>(SQL_30D).get();
if (!row) {
  console.error("No rows returned — schema mismatch?");
  process.exit(1);
}

const usd = (microCents: number): string => {
  const u = microCents / 100_000;
  if (u === 0) return "$0";
  if (u >= 100) return `$${u.toFixed(2)}`;
  if (u >= 1) return `$${u.toFixed(2)}`;
  if (u >= 0.01) return `$${u.toFixed(4)}`;
  return `$${u.toFixed(6)}`;
};

const pct = (saved: number, spent: number): string => {
  const baseline = saved + spent;
  if (baseline <= 0) return "—";
  return `${((saved / baseline) * 100).toFixed(1)}%`;
};

const total = row.routing_saving + row.cache_saving + row.tool_compress_saving;

console.log("=".repeat(64));
console.log(" Dashboard 'Saved · last 30 days' — equivalent rendering");
console.log(` from ${DB_PATH}`);
console.log("=".repeat(64));
console.log();
console.log(`  Saved · last 30 days       ${usd(total)}`);
console.log(`                             (${pct(total, row.total_spend)} off baseline)`);
console.log();
console.log("  ┌─────────────────────────┬──────────────┬──────────────────────────┐");
console.log("  │ dimension               │       saved  │  detail                  │");
console.log("  ├─────────────────────────┼──────────────┼──────────────────────────┤");
console.log(
  `  │ Routing                 │ ${usd(row.routing_saving).padStart(12)} │  ${String(row.routing_request_count).padStart(3)} requests downgraded   │`
);
console.log(
  `  │ Prompt cache            │ ${usd(row.cache_saving).padStart(12)} │  ${String(row.cache_hit_count).padStart(3)} requests cached       │`
);
if (row.tool_compress_request_count > 0) {
  console.log(
    `  │ Tool-result compression │ ${usd(row.tool_compress_saving).padStart(12)} │  ${String(row.tool_compress_request_count).padStart(3)} requests compressed   │`
  );
} else {
  console.log("  │ Tool-result compression │            — │  not active in window    │");
}
const prevented = row.loops_prevented_count + row.budget_blocked_count;
if (prevented > 0) {
  console.log(
    `  │ Also prevented          │           ${String(prevented).padStart(3)}n │  ${String(row.loops_prevented_count).padStart(3)} loops · ${String(row.budget_blocked_count).padStart(3)} over-budget │`
  );
}
console.log("  └─────────────────────────┴──────────────┴──────────────────────────┘");
console.log();
console.log("Note: Total spend in window:", usd(row.total_spend));
console.log();
console.log("This is the SAME data that would appear in the dashboard's");
console.log("savings hero card if the dashboard supported SQLite.");
console.log("(See apps/dashboard/src/lib/db.ts:18 — postgres-only driver.)");
