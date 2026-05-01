#!/usr/bin/env bun
/**
 * Set (or disable) the budget for a project, so you can demo enforcement.
 *
 * The on-disk unit is micro_cents (1 cent = 1000 micro_cents). Use whichever
 * scale is convenient:
 *
 *   bun run set-budget -- --period daily --usd 1            # $1.00
 *   bun run set-budget -- --period daily --cents 10         # 10 cents
 *   bun run set-budget -- --period daily --micro-cents 500  # 0.5 cents
 *   bun run set-budget -- --period daily --disable
 *   bun run set-budget -- --project <uuid> --period daily --usd 0.01
 *
 * Defaults to the seeded "default" project (id ends in ...001).
 */
import { sql } from "../src/db";

type Args = {
  project: string;
  period: "daily" | "monthly";
  micro_cents: number | null;
  disable: boolean;
};

const DEFAULT_PROJECT = "00000000-0000-0000-0000-000000000001";
const MICRO_PER_CENT = 1000;
const MICRO_PER_USD = 100_000;

function parseArgs(argv: string[]): Args {
  const a: Args = {
    project: DEFAULT_PROJECT,
    period: "daily",
    micro_cents: null,
    disable: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--project":
        a.project = next!;
        i++;
        break;
      case "--period":
        if (next !== "daily" && next !== "monthly") {
          fail(`--period must be 'daily' or 'monthly' (got ${next})`);
        }
        a.period = next;
        i++;
        break;
      case "--micro-cents": {
        const n = Number(next);
        if (!Number.isFinite(n) || n < 0) {
          fail(`--micro-cents must be a non-negative number (got ${next})`);
        }
        a.micro_cents = Math.round(n);
        i++;
        break;
      }
      case "--cents": {
        const n = Number(next);
        if (!Number.isFinite(n) || n < 0) {
          fail(`--cents must be a non-negative number (got ${next})`);
        }
        a.micro_cents = Math.round(n * MICRO_PER_CENT);
        i++;
        break;
      }
      case "--usd": {
        const usd = Number(next);
        if (!Number.isFinite(usd) || usd < 0) {
          fail(`--usd must be a non-negative number (got ${next})`);
        }
        a.micro_cents = Math.round(usd * MICRO_PER_USD);
        i++;
        break;
      }
      case "--disable":
        a.disable = true;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        fail(`Unknown arg: ${arg}`);
    }
  }

  if (!a.disable && a.micro_cents === null) {
    fail("Must pass --micro-cents <n>, --cents <n>, or --usd <n> (or --disable).");
  }
  return a;
}

function fail(msg: string): never {
  console.error(`set-budget: ${msg}\n`);
  printHelp();
  process.exit(1);
}

function printHelp(): void {
  console.log(`Usage:
  bun run set-budget -- --period daily --usd 1
  bun run set-budget -- --period daily --cents 10
  bun run set-budget -- --period daily --micro-cents 500   # 0.5 cents
  bun run set-budget -- --period daily --disable

Options:
  --project <uuid>       Project UUID. Defaults to the seeded default project.
  --period daily|monthly
  --usd <n>              Budget cap in USD (converted to micro_cents).
  --cents <n>            Budget cap in cents (converted to micro_cents).
  --micro-cents <n>      Budget cap in raw micro_cents (1 cent = 1000).
  --disable              Disable (not delete) the budget for this project+period.
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.disable) {
    const rows = await sql<{ id: string }[]>`
      UPDATE budgets
         SET enabled = FALSE, updated_at = NOW()
       WHERE project_id = ${args.project}
         AND period = ${args.period}
      RETURNING id
    `;
    if (rows.length === 0) {
      console.log(
        `No budget row found for project=${args.project} period=${args.period}. Nothing to disable.`
      );
    } else {
      console.log(`Disabled ${args.period} budget for project ${args.project}.`);
    }
    await sql.end();
    return;
  }

  const micro = args.micro_cents as number;
  await sql`
    INSERT INTO budgets (project_id, period, limit_micro_cents, enabled)
    VALUES (${args.project}, ${args.period}, ${micro}, TRUE)
    ON CONFLICT (project_id, period)
    DO UPDATE SET
      limit_micro_cents = EXCLUDED.limit_micro_cents,
      enabled           = TRUE,
      updated_at        = NOW()
  `;

  const usd = (micro / MICRO_PER_USD).toFixed(4);
  console.log(
    `Set ${args.period} budget = $${usd} (${micro} micro_cents) for project ${args.project}.`
  );
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
