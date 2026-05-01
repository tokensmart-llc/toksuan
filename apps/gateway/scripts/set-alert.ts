#!/usr/bin/env bun
/**
 * Configure alert rules for a project.
 *
 * Examples:
 *   # Webhook on every budget_exceeded event
 *   bun run set-alert -- --event budget_exceeded --webhook https://hooks.example.com/x
 *
 *   # Email-log on loop_detected (actual SMTP delivery comes later)
 *   bun run set-alert -- --event loop_detected --email ops@example.com
 *
 *   # Disable all alerts of a given type for a project
 *   bun run set-alert -- --event budget_exceeded --disable
 *
 *   # List existing alerts for the default project
 *   bun run set-alert -- --list
 */
import { sql, ALERT_EVENT_TYPES, type AlertEventType } from "../src/db";

type EventType = AlertEventType;

type Args = {
  project: string;
  event: EventType | null;
  webhook: string | null;
  email: string | null;
  disable: boolean;
  list: boolean;
};

const DEFAULT_PROJECT = "00000000-0000-0000-0000-000000000001";
const VALID_EVENTS: readonly EventType[] = ALERT_EVENT_TYPES;

function parseArgs(argv: string[]): Args {
  const a: Args = {
    project: DEFAULT_PROJECT,
    event: null,
    webhook: null,
    email: null,
    disable: false,
    list: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--project":
        a.project = next!;
        i++;
        break;
      case "--event":
        if (!next || !(VALID_EVENTS as string[]).includes(next)) {
          fail(`--event must be one of: ${VALID_EVENTS.join(", ")} (got ${next})`);
        }
        a.event = next as EventType;
        i++;
        break;
      case "--webhook":
        a.webhook = next!;
        i++;
        break;
      case "--email":
        a.email = next!;
        i++;
        break;
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
  console.error(`set-alert: ${msg}\n`);
  printHelp();
  process.exit(1);
}

function printHelp(): void {
  console.log(`Usage:
  bun run set-alert -- --event budget_exceeded --webhook https://example.com/hook
  bun run set-alert -- --event loop_detected --email ops@example.com
  bun run set-alert -- --event cost_anomaly --webhook https://example.com/hook
  bun run set-alert -- --event budget_exceeded --disable
  bun run set-alert -- --list

Options:
  --project <uuid>      Project UUID. Defaults to the seeded default project.
  --event   <type>      ${VALID_EVENTS.join(" | ")}
  --webhook <url>       POST a JSON payload here when the event fires.
  --email   <address>   Log-only in v0 (no SMTP yet); dispatcher prints payload.
  --disable             Disable all rules for --event on this project.
  --list                List existing rules and exit.
`);
}

type Row = {
  id: string;
  project_id: string;
  event_type: EventType;
  webhook_url: string | null;
  email: string | null;
  enabled: boolean;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    const rows = await sql<Row[]>`
      SELECT id, project_id, event_type, webhook_url, email, enabled
      FROM alert_rules
      WHERE project_id = ${args.project}
      ORDER BY created_at ASC
    `;
    if (rows.length === 0) {
      console.log(`No alert rules for project ${args.project}.`);
    } else {
      console.log(`Alert rules for project ${args.project}:\n`);
      for (const r of rows) {
        const tag = r.enabled ? "ON " : "off";
        const dests = [
          r.webhook_url ? `webhook=${r.webhook_url}` : null,
          r.email ? `email=${r.email}` : null,
        ]
          .filter(Boolean)
          .join("  ");
        console.log(`  [${tag}] ${r.event_type}  ${dests}`);
      }
    }
    await sql.end();
    return;
  }

  if (!args.event) fail("--event is required.");

  if (args.disable) {
    const rows = await sql<{ id: string }[]>`
      UPDATE alert_rules
         SET enabled = FALSE, updated_at = NOW()
       WHERE project_id = ${args.project}
         AND event_type = ${args.event}
      RETURNING id
    `;
    console.log(
      rows.length === 0
        ? `No ${args.event} alert rules found for project ${args.project}.`
        : `Disabled ${rows.length} ${args.event} alert rule(s) for project ${args.project}.`
    );
    await sql.end();
    return;
  }

  if (!args.webhook && !args.email) {
    fail("At least one of --webhook <url> or --email <address> is required.");
  }

  if (args.webhook) {
    try {
      new URL(args.webhook);
    } catch {
      fail(`--webhook must be a valid URL (got ${args.webhook}).`);
    }
  }

  await sql`
    INSERT INTO alert_rules (project_id, event_type, webhook_url, email, enabled)
    VALUES (${args.project}, ${args.event}, ${args.webhook}, ${args.email}, TRUE)
  `;
  console.log(
    `Added ${args.event} alert rule for project ${args.project}` +
      (args.webhook ? ` (webhook=${args.webhook})` : "") +
      (args.email ? ` (email=${args.email})` : "") +
      "."
  );
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
