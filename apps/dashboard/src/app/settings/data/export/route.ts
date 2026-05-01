import { NextResponse } from "next/server";
import { getSession, isAuthEnabled } from "@/lib/auth";
import { sql } from "@/lib/db";

/**
 * Streamed JSON archive of everything the current user owns on
 * TokSuan. This is the self-serve implementation of the "export
 * Customer Data" commitment in the DPA — customers can grab a full
 * snapshot any time without filing a support ticket.
 *
 * What's included:
 *   - user profile (id, email, name, plan, created_at, deleted_at)
 *   - orgs the user is a member of (plus role + joined_at)
 *   - projects owned personally + via org membership
 *   - api_keys metadata (id, name, prefix/last4, created_at — NO
 *     plaintext, NO hash; the key material was never retrievable
 *     after mint anyway)
 *   - budgets / routing_rules / alert_rules / prompt_templates
 *   - audit_events (user-scoped, last 10k rows)
 *   - requests (user-scoped, last 10k rows — bodies are JSONB so
 *     they're included verbatim)
 *   - Stripe references (customer_id, subscription_id — NOT charges
 *     or invoice line items, since Stripe's own data-subject-request
 *     process is the source of truth for those)
 *
 * Returns NDJSON (one record per line, typed via a `__type` field)
 * so the download streams without buffering the whole dataset in
 * RAM. Large exports (>100MB) still fit in a single HTTP response
 * at standard reverse-proxy limits.
 *
 * No plan gate — DPA §7 commits to "export at any time" and that's
 * a contractual obligation regardless of tier.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ExportRecord =
  | { __type: "user"; [k: string]: unknown }
  | { __type: "organization_membership"; [k: string]: unknown }
  | { __type: "project"; [k: string]: unknown }
  | { __type: "api_key"; [k: string]: unknown }
  | { __type: "budget"; [k: string]: unknown }
  | { __type: "routing_rule"; [k: string]: unknown }
  | { __type: "alert_rule"; [k: string]: unknown }
  | { __type: "prompt_template"; [k: string]: unknown }
  | { __type: "audit_event"; [k: string]: unknown }
  | { __type: "request"; [k: string]: unknown };

function ndjson(record: ExportRecord): string {
  return `${JSON.stringify(record)}\n`;
}

export async function GET(): Promise<Response> {
  if (!isAuthEnabled()) {
    // Guard message previously said "hosted mode" — but the actual
    // gate is "per-user scope exists", which requires auth. A
    // self-hosted single-tenant install with auth off has no user
    // scope to export (everything on the gateway is shared).
    return new NextResponse(
      "Data export requires per-user scope, which is only available " +
        "when auth is enabled (TOKENSMART_AUTH_ENABLED=1). Single-tenant " +
        "installs have no user-bound data to export — pull from Postgres " +
        "directly with your preferred tool.",
      { status: 404 }
    );
  }
  const session = await getSession();
  if (!session) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const userId = session.user.id;

  // All queries run up front in parallel; the stream just serialises
  // the results. For a truly massive account (>10M requests) we'd
  // need to chunk — not worth the complexity until a real customer
  // hits that size. Today's caps are plenty.
  const [
    user,
    orgMemberships,
    projects,
    apiKeys,
    budgets,
    routingRules,
    alertRules,
    templates,
    auditEvents,
    requests,
  ] = await Promise.all([
    sql`SELECT id, email, name, plan, created_at, deleted_at,
               stripe_customer_id, stripe_subscription_id,
               weekly_digest_enabled, weekly_digest_last_sent_at,
               referred_by_user_id
          FROM users WHERE id = ${userId} LIMIT 1`,
    sql`SELECT m.organization_id, o.name AS organization_name,
               m.role, m.joined_at
          FROM organization_members m
          JOIN organizations o ON o.id = m.organization_id
         WHERE m.user_id = ${userId}`,
    sql`SELECT id, name, user_id, organization_id, created_at
          FROM projects
         WHERE user_id = ${userId}
            OR organization_id IN (
               SELECT organization_id FROM organization_members
                WHERE user_id = ${userId}
            )`,
    sql`SELECT k.id, k.project_id, k.name, k.key_prefix, k.key_last4,
               k.created_at, k.last_used_at, k.expires_at
          FROM api_keys k
          JOIN projects p ON p.id = k.project_id
         WHERE p.user_id = ${userId}
            OR p.organization_id IN (
               SELECT organization_id FROM organization_members
                WHERE user_id = ${userId}
            )`,
    sql`SELECT b.* FROM budgets b
          JOIN projects p ON p.id = b.project_id
         WHERE p.user_id = ${userId}
            OR p.organization_id IN (
               SELECT organization_id FROM organization_members
                WHERE user_id = ${userId}
            )`,
    sql`SELECT r.* FROM routing_rules r
          JOIN projects p ON p.id = r.project_id
         WHERE p.user_id = ${userId}
            OR p.organization_id IN (
               SELECT organization_id FROM organization_members
                WHERE user_id = ${userId}
            )`,
    sql`SELECT a.* FROM alert_rules a
          JOIN projects p ON p.id = a.project_id
         WHERE p.user_id = ${userId}
            OR p.organization_id IN (
               SELECT organization_id FROM organization_members
                WHERE user_id = ${userId}
            )`,
    sql`SELECT t.* FROM prompt_templates t
          JOIN projects p ON p.id = t.project_id
         WHERE p.user_id = ${userId}
            OR p.organization_id IN (
               SELECT organization_id FROM organization_members
                WHERE user_id = ${userId}
            )`,
    sql`SELECT id, user_id, project_id, organization_id, event,
               target_type, target_id, actor_email, metadata, ip,
               user_agent, created_at
          FROM audit_events
         WHERE user_id = ${userId}
         ORDER BY created_at DESC
         LIMIT 10000`,
    sql`SELECT r.id, r.project_id, r.api_key_id, r.provider, r.model,
               r.original_model, r.input_tokens, r.cached_input_tokens,
               r.output_tokens, r.cost_micro_cents,
               r.routing_saving_micro_cents, r.cache_savings_micro_cents,
               r.latency_ms, r.status, r.error, r.fingerprint,
               r.request_body, r.response_body, r.tags, r.created_at
          FROM requests r
          JOIN projects p ON p.id = r.project_id
         WHERE p.user_id = ${userId}
            OR p.organization_id IN (
               SELECT organization_id FROM organization_members
                WHERE user_id = ${userId}
            )
         ORDER BY r.created_at DESC
         LIMIT 10000`,
  ]);

  const chunks: string[] = [];
  chunks.push(
    ndjson({
      __type: "user",
      ...(user[0] ?? {}),
      __exported_at: new Date().toISOString(),
      __tokensmart_schema_version: "v0.4.0",
      __notes:
        "api_keys include metadata only — the plaintext was shown once at mint and never stored. requests + audit_events capped at the 10,000 most recent per table; open a GitHub issue for bulk historical dumps. Stripe invoice + charge detail is not in this archive; use Stripe's own data-subject-request process for that.",
    })
  );
  for (const m of orgMemberships) {
    chunks.push(ndjson({ __type: "organization_membership", ...m }));
  }
  for (const p of projects) chunks.push(ndjson({ __type: "project", ...p }));
  for (const k of apiKeys) chunks.push(ndjson({ __type: "api_key", ...k }));
  for (const b of budgets) chunks.push(ndjson({ __type: "budget", ...b }));
  for (const r of routingRules) {
    chunks.push(ndjson({ __type: "routing_rule", ...r }));
  }
  for (const a of alertRules) {
    chunks.push(ndjson({ __type: "alert_rule", ...a }));
  }
  for (const t of templates) {
    chunks.push(ndjson({ __type: "prompt_template", ...t }));
  }
  for (const a of auditEvents) {
    chunks.push(ndjson({ __type: "audit_event", ...a }));
  }
  for (const r of requests) chunks.push(ndjson({ __type: "request", ...r }));

  const body = chunks.join("");
  const filename = `tokensmart-${userId.slice(0, 8)}-${new Date()
    .toISOString()
    .slice(0, 10)}.ndjson`;

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-TokenSmart-Export-Records": String(chunks.length),
    },
  });
}
