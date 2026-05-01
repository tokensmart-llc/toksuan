import { sql } from "./db";

/**
 * Free-form ledger of human-meaningful actions taken on the dashboard.
 *
 * Anything a hosted user might want to retroactively explain or dispute lands
 * here: who logged in, who minted / deleted an API key, who changed a budget,
 * who upgraded the plan. Designed to be append-only and cheap to write — the
 * /audit page reads at most a few hundred recent rows.
 *
 * Events use a dotted namespace:
 *   auth.login          login.verify | login.magic-link
 *   auth.logout
 *   project.created
 *   api_key.created     api_key.deleted
 *   budget.set          budget.deleted
 *   billing.upgrade     billing.portal
 */
export type AuditInput = {
  userId: string | null;
  actorEmail?: string | null;
  projectId?: string | null;
  organizationId?: string | null;
  event: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
};

export async function logAuditEvent(input: AuditInput): Promise<void> {
  // Derive organization_id from project_id when the caller didn't
  // supply one explicitly. Cheap per-insert lookup; keeps old
  // callsites correct without forcing every one of them to know
  // which project belongs to which org.
  let orgId: string | null = input.organizationId ?? null;
  if (orgId === null && input.projectId) {
    try {
      const rows = await sql<{ organization_id: string | null }[]>`
        SELECT organization_id FROM projects WHERE id = ${input.projectId} LIMIT 1
      `;
      orgId = rows[0]?.organization_id ?? null;
    } catch {
      /* non-fatal — the column accepts null */
    }
  }
  try {
    await sql`
      INSERT INTO audit_events (
        user_id, project_id, organization_id, event, target_type, target_id,
        actor_email, metadata, ip, user_agent
      ) VALUES (
        ${input.userId},
        ${input.projectId ?? null},
        ${orgId},
        ${input.event},
        ${input.targetType ?? null},
        ${input.targetId ?? null},
        ${input.actorEmail ?? null},
        ${sql.json((input.metadata ?? {}) as Parameters<typeof sql.json>[0])},
        ${input.ip ?? null},
        ${input.userAgent ?? null}
      )
    `;
  } catch (err) {
    // Audit logging must never break the action it's tracking.
    console.error("[audit] insert failed:", err);
  }
}

export type AuditRow = {
  id: string;
  user_id: string | null;
  project_id: string | null;
  event: string;
  target_type: string | null;
  target_id: string | null;
  actor_email: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  user_agent: string | null;
  created_at: Date;
  project_name: string | null;
};

/**
 * Recent audit rows for the given user. We always scope by user_id rather
 * than project — auth events fire before any project context exists, and the
 * user wants to see their own login history alongside their project changes.
 */
export async function getAuditEventsForUser(
  userId: string,
  limit = 200
): Promise<AuditRow[]> {
  return sql<AuditRow[]>`
    SELECT a.id, a.user_id, a.project_id, a.event, a.target_type, a.target_id,
           a.actor_email, a.metadata, a.ip, a.user_agent, a.created_at,
           p.name AS project_name
      FROM audit_events a
      LEFT JOIN projects p ON p.id = a.project_id
     WHERE a.user_id = ${userId}
     ORDER BY a.created_at DESC
     LIMIT ${limit}
  `;
}

/**
 * Filtered query for the /audit page. Accepts optional filter criteria
 * that compose with `AND`; empty / null filters are no-ops so the
 * caller can pass whatever the URL search params gave them.
 *
 * Supports `event` prefix matching (e.g. `auth.` matches `auth.login`
 * + `auth.logout` + `auth.sso.*`) because dotted namespaces in our
 * event-name convention are the natural grouping.
 *
 * Narrow result set is capped at 5000 rows — any real forensics case
 * with more rows than that should use the JSON export endpoint, which
 * streams without the DB having to buffer everything in one go.
 */
export async function getAuditEventsForUserFiltered(args: {
  userId: string;
  eventPrefix?: string | null;
  sinceIso?: string | null;
  untilIso?: string | null;
  projectId?: string | null;
  /**
   * Org-scope toggle. When set, caller MUST have already verified the
   * user is owner/admin of this org (via `canRoleManageMembers`). Query
   * returns every event in that org instead of just the user's own.
   * `null` / undefined = personal scope (default, pre-v0.4 behavior).
   */
  scopeOrganizationId?: string | null;
  limit?: number;
}): Promise<AuditRow[]> {
  const limit = Math.min(Math.max(args.limit ?? 500, 1), 5000);
  const eventPattern: string | null = args.eventPrefix
    ? `${args.eventPrefix.replace(/[%_]/g, "\\$&")}%`
    : null;
  const sinceIso: string | null = args.sinceIso ?? null;
  const untilIso: string | null = args.untilIso ?? null;
  const projectId: string | null = args.projectId ?? null;
  const scopeOrgId: string | null = args.scopeOrganizationId ?? null;

  // Scope is polymorphic on `scopeOrgId`: when non-null, return every
  // event in that org (owner/admin only — caller guards); when null,
  // return just the user's personal events. Keeping the branch inside
  // the SQL (rather than two named functions) means filter semantics
  // are identical across scopes and adding a new filter costs one
  // line here rather than two.
  const rows = await sql<AuditRow[]>`
    SELECT a.id, a.user_id, a.project_id, a.event, a.target_type, a.target_id,
           a.actor_email, a.metadata, a.ip, a.user_agent, a.created_at,
           p.name AS project_name
      FROM audit_events a
      LEFT JOIN projects p ON p.id = a.project_id
     WHERE (
       (${scopeOrgId}::uuid IS NULL AND a.user_id = ${args.userId})
       OR
       (${scopeOrgId}::uuid IS NOT NULL AND a.organization_id = ${scopeOrgId}::uuid)
     )
       AND (${eventPattern}::text IS NULL OR a.event LIKE ${eventPattern})
       AND (${sinceIso}::timestamptz IS NULL OR a.created_at >= ${sinceIso}::timestamptz)
       AND (${untilIso}::timestamptz IS NULL OR a.created_at <  ${untilIso}::timestamptz)
       AND (${projectId}::uuid       IS NULL OR a.project_id = ${projectId}::uuid)
     ORDER BY a.created_at DESC
     LIMIT ${limit}
  `;
  return rows;
}

/**
 * Distinct event-name prefixes present in the current user's log.
 * Feeds the `/audit` filter dropdown so admins can pick from actual
 * event categories without guessing (`auth.` / `api_key.` / `budget.`
 * / etc). Mirrors the scope of `getAuditEventsForUserFiltered`.
 */
export async function listEventPrefixesForUser(
  userId: string,
  scopeOrganizationId: string | null = null
): Promise<string[]> {
  const scopeOrgId: string | null = scopeOrganizationId;
  const rows = await sql<{ prefix: string }[]>`
    SELECT DISTINCT split_part(event, '.', 1) AS prefix
      FROM audit_events
     WHERE (
       (${scopeOrgId}::uuid IS NULL AND user_id = ${userId})
       OR
       (${scopeOrgId}::uuid IS NOT NULL AND organization_id = ${scopeOrgId}::uuid)
     )
     ORDER BY prefix
  `;
  return rows.map((r) => r.prefix).filter(Boolean);
}
