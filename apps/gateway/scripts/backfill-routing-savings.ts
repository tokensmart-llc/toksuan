/**
 * One-time backfill for `routing_saving_micro_cents` on requests that were
 * logged before v0.0.9's migration 005.
 *
 * Rationale: without this, the dashboard's "saved $X" hero number ignores
 * every routing event before the migration was applied. Running this once
 * retroactively populates the column using the current pricing table.
 *
 * Safety:
 *   - Idempotent: skips rows that already have routing_saving_micro_cents > 0
 *   - Only updates rows where `original_model IS NOT NULL AND original_model <> model`
 *   - Reads in batches, updates in a single transaction per batch
 *   - `--dry-run` shows what would change without touching the table
 *
 * Usage:
 *   bun run scripts/backfill-routing-savings.ts --dry-run
 *   bun run scripts/backfill-routing-savings.ts
 */

import { sql } from "../src/db";
import { findProviderTemplate } from "../src/config";
import { calcRoutingSavingMicroCents } from "../src/pricing";

const DRY = process.argv.includes("--dry-run");
const BATCH_SIZE = 500;

type Row = {
  id: string;
  model: string;
  original_model: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cost_micro_cents: number;
  routing_saving_micro_cents: number;
};

async function main(): Promise<void> {
  console.log(`[backfill-routing-savings] mode: ${DRY ? "DRY RUN" : "COMMIT"}`);

  let totalScanned = 0;
  let totalUpdated = 0;
  let totalSavingsMicroCents = 0;
  let lastId: string | null = null;

  // Scan all rows where routing happened and savings haven't been set yet.
  // Paginate by id so a large history doesn't blow up memory.
  for (;;) {
    const rows: Row[] = await sql`
      SELECT id, model, original_model,
             input_tokens, output_tokens, cached_input_tokens,
             cost_micro_cents, routing_saving_micro_cents
        FROM requests
       WHERE original_model IS NOT NULL
         AND original_model <> model
         AND routing_saving_micro_cents = 0
         ${lastId ? sql`AND id > ${lastId}` : sql``}
       ORDER BY id ASC
       LIMIT ${BATCH_SIZE}
    `;
    if (rows.length === 0) break;

    totalScanned += rows.length;
    lastId = rows[rows.length - 1]!.id;

    type Update = { id: string; saving: number };
    const updates: Update[] = [];
    for (const r of rows) {
      const tpl = findProviderTemplate(r.original_model);
      const origProvider = tpl?.name ?? null;
      const saving = calcRoutingSavingMicroCents(
        origProvider,
        r.original_model,
        r.model,
        r.input_tokens,
        r.output_tokens,
        r.cached_input_tokens,
        r.cost_micro_cents
      );
      if (saving > 0) updates.push({ id: r.id, saving });
    }

    if (updates.length > 0 && !DRY) {
      await sql.begin(async (tx) => {
        for (const u of updates) {
          await tx`
            UPDATE requests
               SET routing_saving_micro_cents = ${u.saving}
             WHERE id = ${u.id}
          `;
        }
      });
    }

    totalUpdated += updates.length;
    totalSavingsMicroCents += updates.reduce((a, b) => a + b.saving, 0);

    console.log(
      `  scanned=${totalScanned} updated=${totalUpdated} accumulated_saving=${(totalSavingsMicroCents / 100_000).toFixed(4)} USD`
    );
  }

  console.log(
    `\n[backfill-routing-savings] done. ${DRY ? "Would update" : "Updated"} ${totalUpdated} row(s). Total historical routing savings: ${(totalSavingsMicroCents / 100_000).toFixed(4)} USD.`
  );
  await sql.end();
}

if (import.meta.main) {
  await main();
}
