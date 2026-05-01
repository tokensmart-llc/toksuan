#!/usr/bin/env bun
/**
 * Configure a semantic routing rule for a project.
 *
 * Examples:
 *   # Route trivial Gemini-pro calls down to flash-lite
 *   bun run set-routing -- \
 *     --from "gpt-4o" \
 *     --to   "gpt-4o-mini" \
 *     --threshold 0.3
 *
 *   # Route any gpt-4o* below score 0.25 to gpt-4o-mini
 *   bun run set-routing -- \
 *     --from "^gpt-4o" \
 *     --to   "gpt-4o-mini" \
 *     --threshold 0.25
 *
 *   # Disable a rule
 *   bun run set-routing -- --from "^gpt-4o" --disable
 *
 *   # List active rules for the default project
 *   bun run set-routing -- --list
 */
import { sql } from "../src/db";

type Args = {
  project: string;
  from: string | null;
  to: string | null;
  threshold: number;
  mode: "route" | "shadow" | "both";
  shadow: string | null;
  disable: boolean;
  list: boolean;
  /**
   * Probability the rule fires when it would otherwise match.
   * NULL = legacy "fire on every match". Useful for shadow rules
   * that only want a 5–10% trickle of A/B observations into
   * `ab_results` for the per-project policy aggregator.
   */
  sampleRate: number | null;
};

const DEFAULT_PROJECT = "00000000-0000-0000-0000-000000000001";

function parseArgs(argv: string[]): Args {
  const a: Args = {
    project: DEFAULT_PROJECT,
    from: null,
    to: null,
    threshold: 0.3,
    mode: "route",
    shadow: null,
    disable: false,
    list: false,
    sampleRate: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--project":
        a.project = next!;
        i++;
        break;
      case "--from":
        a.from = next!;
        i++;
        break;
      case "--to":
        a.to = next!;
        i++;
        break;
      case "--threshold": {
        const n = Number(next);
        if (!Number.isFinite(n) || n < 0 || n > 1) {
          fail(`--threshold must be a number in [0, 1] (got ${next})`);
        }
        a.threshold = n;
        i++;
        break;
      }
      case "--mode": {
        if (next !== "route" && next !== "shadow" && next !== "both") {
          fail(`--mode must be route|shadow|both (got ${next})`);
        }
        a.mode = next;
        i++;
        break;
      }
      case "--shadow":
        a.shadow = next!;
        i++;
        break;
      case "--sample-rate": {
        const n = Number(next);
        if (!Number.isFinite(n) || n < 0 || n > 1) {
          fail(`--sample-rate must be a number in [0, 1] (got ${next})`);
        }
        a.sampleRate = n;
        i++;
        break;
      }
      case "--disable":
        a.disable = true;
        break;
      case "--list":
        a.list = true;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        fail(`Unknown arg: ${arg}`);
    }
  }
  return a;
}

function fail(msg: string): never {
  console.error(`set-routing: ${msg}\n`);
  printHelp();
  process.exit(1);
}

function printHelp(): void {
  console.log(`Usage:
  bun run set-routing -- --from <pattern> --to <model> [--threshold 0..1]
  bun run set-routing -- --from <pattern> --to <model> --mode shadow --shadow <model>
  bun run set-routing -- --from <pattern> --to <model> --mode both   --shadow <model>
  bun run set-routing -- --from <pattern> --disable
  bun run set-routing -- --list
  bun run set-routing -- --project <uuid> ...

--from      JavaScript regex evaluated against the incoming model name.
--to        Cheaper model to rewrite to when the rule fires (route mode), or
            the placeholder target (shadow mode — required by schema).
--threshold complexity score above which the rule does NOT fire.
--mode      route   (default) rewrite body.model to --to
            shadow  leave model alone, fire a parallel call to --shadow
                    for cost/quality A/B comparison
            both    rewrite AND shadow the original model (defaults --shadow
                    to <from>)
--shadow    experimental model name for shadow / both modes.
--sample-rate
            Probability the rule fires when it would otherwise match
            (number in [0, 1]). Default: NULL = always fire (legacy).
            Use 0.05–0.10 for steady-state shadow learning that doesn't
            double the upstream bill.
`);
}

type Row = {
  id: string;
  project_id: string;
  enabled: boolean;
  threshold: number;
  from_pattern: string;
  to_model: string;
  shadow_to_model: string | null;
  mode: "route" | "shadow" | "both";
  sample_rate: number | null;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    const rows = await sql<Row[]>`
      SELECT id, project_id, enabled, threshold, from_pattern, to_model,
             shadow_to_model, mode, sample_rate
      FROM routing_rules
      WHERE project_id = ${args.project}
      ORDER BY created_at ASC
    `;
    if (rows.length === 0) {
      console.log(`No routing rules for project ${args.project}.`);
    } else {
      console.log(`Routing rules for project ${args.project}:\n`);
      for (const r of rows) {
        const tag = r.enabled ? "ON " : "off";
        const shadow = r.shadow_to_model ? `  ⤳ shadow ${r.shadow_to_model}` : "";
        const sample =
          r.sample_rate != null && r.sample_rate < 1
            ? `  sample=${(r.sample_rate * 100).toFixed(1)}%`
            : "";
        console.log(
          `  [${tag}] mode=${r.mode}  threshold=${r.threshold}  ${r.from_pattern}  →  ${r.to_model}${shadow}${sample}`
        );
      }
    }
    await sql.end();
    return;
  }

  if (!args.from) fail("--from <pattern> is required.");

  if (args.disable) {
    const rows = await sql<{ id: string }[]>`
      UPDATE routing_rules
         SET enabled = FALSE, updated_at = NOW()
       WHERE project_id = ${args.project}
         AND from_pattern = ${args.from}
      RETURNING id
    `;
    if (rows.length === 0) {
      console.log(
        `No rule matched from_pattern=${args.from} for project ${args.project}. Nothing to disable.`
      );
    } else {
      console.log(`Disabled routing rule ${args.from} for project ${args.project}.`);
    }
    await sql.end();
    return;
  }

  if (!args.to) fail("--to <model> is required when creating/updating a rule.");
  if ((args.mode === "shadow" || args.mode === "both") && !args.shadow) {
    if (args.mode === "shadow") {
      fail(`--shadow <model> is required when --mode=shadow.`);
    }
    // mode=both with no --shadow defaults to shadowing the original (--from)
    args.shadow = args.from;
  }

  // Validate regex so we don't write garbage that crashes the request path.
  try {
    new RegExp(args.from);
  } catch (e) {
    fail(`--from is not a valid regex: ${String(e)}`);
  }

  await sql`
    INSERT INTO routing_rules (
      project_id, enabled, threshold, from_pattern, to_model,
      shadow_to_model, mode, sample_rate
    )
    VALUES (
      ${args.project}, TRUE, ${args.threshold}, ${args.from}, ${args.to},
      ${args.shadow}, ${args.mode}, ${args.sampleRate}
    )
    ON CONFLICT (project_id, from_pattern)
    DO UPDATE SET
      enabled         = TRUE,
      threshold       = EXCLUDED.threshold,
      to_model        = EXCLUDED.to_model,
      shadow_to_model = EXCLUDED.shadow_to_model,
      mode            = EXCLUDED.mode,
      sample_rate     = EXCLUDED.sample_rate,
      updated_at      = NOW()
  `;

  const shadowDesc = args.shadow ? `  ⤳ shadow ${args.shadow}` : "";
  const sampleDesc =
    args.sampleRate != null && args.sampleRate < 1
      ? `  sample=${(args.sampleRate * 100).toFixed(1)}%`
      : "";
  console.log(
    `Routing rule set for project ${args.project}:\n  [${args.mode}] ${args.from}  →  ${args.to}${shadowDesc}${sampleDesc}  (threshold ${args.threshold})`
  );
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
