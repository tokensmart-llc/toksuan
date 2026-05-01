import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, isAuthEnabled } from "@/lib/auth";
import {
  getAuditEventsForUserFiltered,
  listEventPrefixesForUser,
  type AuditRow,
} from "@/lib/audit";
import {
  canRoleManageMembers,
  listOrganizationsForUser,
  type OrganizationMembershipRow,
} from "@/lib/db";
import { minPlanForEntitlement, planAllows } from "@/lib/plans";
import { AutoRefresh } from "@/components/AutoRefresh";
import { SettingsLayout } from "@/components/SettingsLayout";
import { getDictionary } from "@/lib/i18n.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function fmtTime(d: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(d));
}

/**
 * Map a dotted event name to a category-tone for color-coding the table row.
 * Falls back to neutral for anything we haven't categorized yet.
 */
function eventTone(event: string): "auth" | "key" | "project" | "billing" | "neutral" {
  if (event.startsWith("auth.")) return "auth";
  if (event.startsWith("api_key.")) return "key";
  if (event.startsWith("project.")) return "project";
  if (event.startsWith("billing.")) return "billing";
  return "neutral";
}

function pillClassFor(tone: ReturnType<typeof eventTone>): string {
  switch (tone) {
    case "auth":
      return "pill pill-accent";
    case "key":
      return "pill pill-warning";
    case "project":
      return "pill pill-success";
    case "billing":
      return "pill pill-purple";
    default:
      return "pill pill-neutral";
  }
}

function summarizeMetadata(row: AuditRow): string {
  const md = row.metadata ?? {};
  const parts: string[] = [];
  for (const [k, v] of Object.entries(md)) {
    if (v == null) continue;
    const str = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}=${str}`);
  }
  return parts.join(" · ");
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    event?: string;
    since?: string;
    until?: string;
    scope?: string;
  }>;
}) {
  if (!isAuthEnabled()) redirect("/");
  const session = await getSession();
  if (!session) redirect("/login");

  const params = await searchParams;
  const eventPrefix = params.event?.trim() || null;
  const sinceIso = params.since?.trim() || null;
  const untilIso = params.until?.trim() || null;
  const scopeParam = params.scope?.trim() || null;

  // Org-scope access list: owner + admin roles ONLY. Member / viewer
  // roles stay on personal scope — they shouldn't be able to see other
  // members' audit events. This mirrors GitHub's org-audit gating.
  let orgMemberships: OrganizationMembershipRow[] = [];
  try {
    orgMemberships = await listOrganizationsForUser(session.user.id);
  } catch {
    /* org list failure degrades to personal scope — safe */
  }
  const manageableOrgs = orgMemberships.filter((m) =>
    canRoleManageMembers(m.role)
  );
  // Resolve the requested scope to a concrete org id — only when the
  // caller has admin rights on it; otherwise silently fall back to
  // personal.
  const scopeOrg =
    scopeParam && scopeParam !== "personal"
      ? (manageableOrgs.find((m) => m.id === scopeParam) ?? null)
      : null;
  const activeScope: "personal" | { org: OrganizationMembershipRow } =
    scopeOrg ? { org: scopeOrg } : "personal";

  let rows: AuditRow[] = [];
  let prefixes: string[] = [];
  let dbError: string | null = null;
  try {
    [rows, prefixes] = await Promise.all([
      getAuditEventsForUserFiltered({
        userId: session.user.id,
        eventPrefix,
        sinceIso,
        untilIso,
        scopeOrganizationId:
          activeScope === "personal" ? null : activeScope.org.id,
        limit: 500,
      }),
      listEventPrefixesForUser(
        session.user.id,
        activeScope === "personal" ? null : activeScope.org.id
      ),
    ]);
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  const canExport = planAllows(session.user.plan, "audit_csv_export");
  const requiredPlanForExport = minPlanForEntitlement("audit_csv_export").name;

  // Preserve active filters + scope in the Export links so the
  // download matches what the user is currently seeing.
  const exportQuery = new URLSearchParams();
  if (eventPrefix) exportQuery.set("event", eventPrefix);
  if (sinceIso) exportQuery.set("since", sinceIso);
  if (untilIso) exportQuery.set("until", untilIso);
  if (activeScope !== "personal")
    exportQuery.set("scope", activeScope.org.id);
  const exportQs = exportQuery.toString() ? `&${exportQuery.toString()}` : "";
  const anyFilterActive = Boolean(eventPrefix || sinceIso || untilIso);

  // Captured at the start of this server render so <AutoRefresh> can show a
  // stable "updated Xs ago" label. See components/AutoRefresh.tsx.
  const renderedAt = Date.now();
  const { locale, t } = await getDictionary();
  const tAudit = t.audit;

  return (
    <SettingsLayout t={t.nav}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 14,
          flexWrap: "wrap",
        }}
      >
        <h1 style={{ margin: 0 }}>{t.nav.settingsAudit}</h1>
        <AutoRefresh renderedAt={renderedAt} t={t.common.autoRefresh} />
      </div>
      <p className="tagline">
        {tAudit.tagline}
      </p>

      {/* Scope switcher — visible when the user is owner/admin on any
          org. Defaults to personal scope; admin-level users can pivot
          to org-wide to see every member's events. Member / viewer
          roles don't see this strip at all (`manageableOrgs` is empty
          for them). */}
      {manageableOrgs.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 16,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {tAudit.scopeLabel}
          </span>
          <Link
            href="/audit"
            className={`pill ${
              activeScope === "personal" ? "pill-accent" : "pill-neutral"
            }`}
            style={{ fontSize: 12, textDecoration: "none" }}
          >
            {activeScope === "personal" ? "● " : ""}
            {tAudit.scopePersonal}
          </Link>
          {manageableOrgs.map((m) => (
            <Link
              key={m.id}
              href={`/audit?scope=${m.id}`}
              className={`pill ${
                activeScope !== "personal" && activeScope.org.id === m.id
                  ? "pill-accent"
                  : "pill-neutral"
              }`}
              style={{ fontSize: 12, textDecoration: "none" }}
              title={tAudit.scopeOrgTitleTpl
                .replace("{name}", m.name)
                .replace("{role}", m.role)}
            >
              {activeScope !== "personal" && activeScope.org.id === m.id
                ? "● "
                : ""}
              {m.name} · {tAudit.scopeOrgSuffix}
            </Link>
          ))}
        </div>
      )}

      {dbError && (
        <div className="card card-danger">
          <strong>{tAudit.dbErrTitle}</strong>
          <br />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            {dbError}
          </span>
        </div>
      )}

      {!dbError && (
        <div className="card">
          <div className="card-header">
            <h2>{tAudit.recentTitle}</h2>
            <div className="card-header-spacer" />
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
              {rows.length}{" "}
              {rows.length === 1 ? tAudit.eventSingular : tAudit.eventPlural}
              {anyFilterActive && tAudit.filteredSuffix}
            </span>
            {canExport ? (
              <>
                <a
                  href={`/audit/export?format=csv${exportQs}`}
                  download
                  className="btn btn-sm"
                  style={{
                    marginLeft: 12,
                    textDecoration: "none",
                    fontSize: 12,
                  }}
                  title={tAudit.exportCsvTitle}
                >
                  {tAudit.exportCsvBtn}
                </a>
                <a
                  href={`/audit/export?format=json${exportQs}`}
                  download
                  className="btn btn-sm btn-ghost"
                  style={{
                    marginLeft: 6,
                    textDecoration: "none",
                    fontSize: 12,
                  }}
                  title={tAudit.exportJsonTitle}
                >
                  {tAudit.exportJsonBtn}
                </a>
              </>
            ) : (
              <Link
                href="/billing"
                className="btn btn-sm btn-ghost"
                style={{
                  marginLeft: 12,
                  textDecoration: "none",
                  fontSize: 12,
                }}
                title={tAudit.exportGatedTitleTpl.replace(
                  "{plan}",
                  requiredPlanForExport
                )}
              >
                {tAudit.exportGatedBtnTpl.replace(
                  "{plan}",
                  requiredPlanForExport
                )}
              </Link>
            )}
          </div>

          {/* Filter bar — GET form submits to /audit with query params so
              filters survive share-a-link + back-button. Empty values
              stay out of the URL via `name=""` being omitted by the
              submit. Scope is carried as a hidden input so changing
              filters doesn't drop the current org-scope selection. */}
          <form
            method="get"
            action="/audit"
            style={{
              display: "grid",
              gap: 10,
              gridTemplateColumns:
                "minmax(160px, 1fr) minmax(160px, 1fr) minmax(160px, 1fr) auto auto",
              alignItems: "end",
              padding: "4px 0 14px",
            }}
          >
            {activeScope !== "personal" && (
              <input type="hidden" name="scope" value={activeScope.org.id} />
            )}
            <label className="field" style={{ marginBottom: 0 }}>
              <span
                className="field-label"
                style={{ fontSize: 11, color: "var(--text-muted)" }}
              >
                {tAudit.filterEventLabel}
              </span>
              <select
                name="event"
                defaultValue={eventPrefix ?? ""}
                className="input"
              >
                <option value="">{tAudit.filterAllEvents}</option>
                {prefixes.map((p) => (
                  <option key={p} value={`${p}.`}>
                    {p}.*
                  </option>
                ))}
              </select>
            </label>
            <label className="field" style={{ marginBottom: 0 }}>
              <span
                className="field-label"
                style={{ fontSize: 11, color: "var(--text-muted)" }}
              >
                {tAudit.filterSinceLabel}
              </span>
              <input
                type="datetime-local"
                name="since"
                defaultValue={sinceIso ?? ""}
                className="input"
              />
            </label>
            <label className="field" style={{ marginBottom: 0 }}>
              <span
                className="field-label"
                style={{ fontSize: 11, color: "var(--text-muted)" }}
              >
                {tAudit.filterUntilLabel}
              </span>
              <input
                type="datetime-local"
                name="until"
                defaultValue={untilIso ?? ""}
                className="input"
              />
            </label>
            <button type="submit" className="btn btn-sm btn-primary">
              {tAudit.filterApplyBtn}
            </button>
            {anyFilterActive && (
              <Link href="/audit" className="btn btn-sm btn-ghost">
                {tAudit.filterClearBtn}
              </Link>
            )}
          </form>
          {rows.length === 0 ? (
            <div className="empty">
              {tAudit.emptyBody}
            </div>
          ) : (
            // Wrap the table so it horizontally scrolls within the card on
            // narrow viewports instead of clipping the IP column off-screen.
            // Belt + suspenders alongside the per-cell wrapping below.
            <div style={{ overflowX: "auto" }}>
              <table
                className="data-table"
                style={{ minWidth: 720, width: "100%" }}
              >
                <thead>
                  <tr>
                    <th>{tAudit.colTime}</th>
                    <th>{tAudit.colEvent}</th>
                    <th>{tAudit.colProject}</th>
                    <th>{tAudit.colTarget}</th>
                    {/* Merged "Metadata + IP" into one column. IP was being
                        clipped off the right edge of the card; folding it
                        into a small footer line under the metadata wraps
                        cleanly at any viewport width. */}
                    <th>{tAudit.colDetails}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const tone = eventTone(r.event);
                    const meta = summarizeMetadata(r);
                    return (
                      <tr key={r.id}>
                        <td className="muted" style={{ whiteSpace: "nowrap" }}>
                          {fmtTime(r.created_at, locale)}
                        </td>
                        <td>
                          <span className={pillClassFor(tone)}>
                            {r.event}
                          </span>
                        </td>
                        <td>
                          {r.project_id ? (
                            <Link
                              href={`/projects/${r.project_id}`}
                              className="row-link"
                              style={{ color: "var(--text)" }}
                            >
                              {r.project_name ?? r.project_id.slice(0, 8)}
                            </Link>
                          ) : (
                            <span style={{ color: "var(--text-muted)" }}>
                              —
                            </span>
                          )}
                        </td>
                        <td className="muted">
                          {r.target_type ? (
                            <code className="code-inline">
                              {r.target_type}
                              {r.target_id
                                ? `:${r.target_id.slice(0, 8)}`
                                : ""}
                            </code>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td
                          className="muted"
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: 11.5,
                            maxWidth: 360,
                            // Wrap instead of nowrap+ellipsis — long metadata
                            // strings push to a second line in the cell
                            // instead of overflowing the row.
                            whiteSpace: "normal",
                            wordBreak: "break-word",
                            lineHeight: 1.45,
                          }}
                          title={meta}
                        >
                          {meta || (
                            <span style={{ color: "var(--text-muted)" }}>
                              —
                            </span>
                          )}
                          {r.ip && (
                            <div
                              style={{
                                marginTop: 4,
                                fontSize: 10.5,
                                color: "var(--text-muted)",
                              }}
                            >
                              {tAudit.ipPrefix} {r.ip}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </SettingsLayout>
  );
}
