import { NextResponse } from "next/server";
import { getSession, isAuthEnabled } from "@/lib/auth";
import { getAuditEventsForUserFiltered } from "@/lib/audit";
import { canRoleManageMembers, getMemberRole } from "@/lib/db";
import { minPlanForEntitlement, planAllows } from "@/lib/plans";

/**
 * Streaming-friendly CSV export of the current user's audit log.
 *
 * GET /audit/export[?limit=N]
 *
 * Why CSV: every compliance team's first ask is "give me a CSV". JSON is
 * possible too — add an `.json` variant later if anyone asks.
 *
 * Auth: same gate as /audit. Self-hosted single-tenant mode (no auth) gets
 * a 404 since the export is meaningless without a user scope.
 *
 * The download filename includes today's date so a customer can keep
 * monthly CSVs organised on disk: `tokensmart-audit-2026-04-22.csv`.
 *
 * Limit defaults to 5000 rows. For larger exports, run a SQL dump directly
 * — this endpoint is sized for "human-skimmable monthly archive", not
 * "everything since the dawn of time."
 */
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 5000;
const MAX_LIMIT = 50_000;

const COLUMNS = [
  "created_at",
  "event",
  "project_id",
  "project_name",
  "target_type",
  "target_id",
  "actor_email",
  "ip",
  "user_agent",
  "metadata",
] as const;

/**
 * RFC 4180-compatible CSV field escaping. Handles embedded commas, quotes,
 * and newlines by wrapping in double quotes and doubling internal quotes.
 * Numbers / null get coerced to "" or their string form.
 */
function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s =
    v instanceof Date
      ? v.toISOString()
      : typeof v === "object"
        ? JSON.stringify(v)
        : String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function GET(req: Request): Promise<Response> {
  if (!isAuthEnabled()) {
    // Guard message previously said "hosted mode" — the actual gate
    // is "per-user audit scope", which only exists when auth is on.
    // Single-tenant installs can query ops_audit_events directly from
    // Postgres for operator-level forensics.
    return new NextResponse(
      "Audit export requires per-user scope, which is only available " +
        "when auth is enabled (TOKENSMART_AUTH_ENABLED=1). Single-tenant " +
        "installs can query audit_events / ops_audit_events directly.",
      { status: 404 }
    );
  }
  const session = await getSession();
  if (!session) {
    // Match the page-level redirect shape — but as JSON since this is an
    // API route. Browsers following the link will redirect via middleware.
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // Entitlement: CSV export of audit events is a Team+ feature per the
  // billing page's "Audit log CSV export (compliance)" bullet. Free/Pro
  // users still see the audit log on /audit — they just can't bulk-export.
  if (!planAllows(session.user.plan, "audit_csv_export")) {
    const required = minPlanForEntitlement("audit_csv_export");
    return new NextResponse(
      `Audit CSV export requires the ${required.name} plan. Upgrade at /billing.`,
      { status: 402 }
    );
  }

  const url = new URL(req.url);
  const limitRaw = url.searchParams.get("limit");
  const limit = (() => {
    const n = limitRaw ? Number(limitRaw) : DEFAULT_LIMIT;
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
    return Math.min(n, MAX_LIMIT);
  })();

  // Filters — same names as /audit page so the user can copy URLs back
  // and forth between browsing and exporting.
  const format = (url.searchParams.get("format") ?? "csv").toLowerCase();
  const eventPrefix = url.searchParams.get("event")?.trim() || null;
  const sinceIso = url.searchParams.get("since")?.trim() || null;
  const untilIso = url.searchParams.get("until")?.trim() || null;
  const scopeParam = url.searchParams.get("scope")?.trim() || null;

  // Org-scope: the `scope=<org-uuid>` URL parameter asks for every
  // member's events. Authorize BEFORE querying — only org owner/admin
  // may view the org-wide log. A forged scope UUID from a Free user
  // silently degrades to personal scope (same behavior as /audit).
  let scopeOrganizationId: string | null = null;
  if (scopeParam && scopeParam !== "personal") {
    const role = await getMemberRole(session.user.id, scopeParam).catch(
      () => null
    );
    if (role && canRoleManageMembers(role)) {
      scopeOrganizationId = scopeParam;
    }
  }

  const rows = await getAuditEventsForUserFiltered({
    userId: session.user.id,
    eventPrefix,
    sinceIso,
    untilIso,
    scopeOrganizationId,
    limit,
  });

  const filenameBase = `tokensmart-audit-${todayIsoDate()}`;

  if (format === "json" || format === "ndjson") {
    // NDJSON — one event per line. SIEM ingestion (Datadog, Splunk HEC,
    // Elasticsearch bulk API) consumes this shape directly without
    // having to re-parse a single giant JSON array.
    const body = rows
      .map((r) => JSON.stringify(r))
      .join("\n");
    return new NextResponse(body ? `${body}\n` : "", {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filenameBase}.ndjson"`,
        "Cache-Control": "no-store",
        "X-TokenSmart-Audit-Rows": String(rows.length),
      },
    });
  }

  const header = COLUMNS.join(",");
  const body = rows
    .map((r) => {
      const record: Record<(typeof COLUMNS)[number], unknown> = {
        created_at: r.created_at,
        event: r.event,
        project_id: r.project_id,
        project_name: r.project_name,
        target_type: r.target_type,
        target_id: r.target_id,
        actor_email: r.actor_email,
        ip: r.ip,
        user_agent: r.user_agent,
        metadata: r.metadata,
      };
      return COLUMNS.map((c) => csvField(record[c])).join(",");
    })
    .join("\n");

  return new NextResponse(`${header}\n${body}\n`, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filenameBase}.csv"`,
      "Cache-Control": "no-store",
      // Help compliance teams know what they're looking at without opening
      // the file: row count is in the header so a `curl -I` shows it.
      "X-TokenSmart-Audit-Rows": String(rows.length),
    },
  });
}
