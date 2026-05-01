import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, isAuthEnabled } from "@/lib/auth";
import {
  listOrganizationsForUser,
  listPendingInvitationsForEmail,
  type OrganizationInvitationRow,
  type OrganizationMembershipRow,
} from "@/lib/db";
import { acceptInvitationAction, createOrganizationAction } from "./actions";
import { minPlanForEntitlement, planAllows, planFromId } from "@/lib/plans";
import { SettingsLayout } from "@/components/SettingsLayout";
import { getDictionary } from "@/lib/i18n.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function fmtTime(d: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(d));
}

export default async function OrganizationListPage() {
  if (!isAuthEnabled()) redirect("/");
  const session = await getSession();
  if (!session) redirect("/login");

  let orgs: OrganizationMembershipRow[] = [];
  let pendingInvites: OrganizationInvitationRow[] = [];
  let dbError: string | null = null;
  try {
    [orgs, pendingInvites] = await Promise.all([
      listOrganizationsForUser(session.user.id),
      listPendingInvitationsForEmail(session.user.email),
    ]);
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  const canCreateOrg = planAllows(session.user.plan, "create_organization");
  const requiredPlanForOrg = minPlanForEntitlement("create_organization");
  const currentPlanName = planFromId(session.user.plan).name;
  const { locale, t } = await getDictionary();
  const tOrg = t.organization;

  return (
    <SettingsLayout t={t.nav}>
      <h1>{t.nav.settingsTeam}</h1>
      <p className="tagline">{tOrg.tagline}</p>

      {dbError && (
        <div className="card card-danger">
          <strong>{tOrg.dbErrTitle}</strong>
          <br />
          <span style={{ color: "var(--text-muted)" }}>{dbError}</span>
        </div>
      )}

      {/* Pending invitations addressed to me */}
      {pendingInvites.length > 0 && (
        <div className="card card-accent">
          <div className="card-header">
            <h2 style={{ color: "var(--accent)" }}>{tOrg.pendingTitle}</h2>
          </div>
          <div style={{ display: "grid", gap: 12 }}>
            {pendingInvites.map((i) => (
              <div
                key={i.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: 12,
                  padding: "10px 12px",
                  background: "var(--surface)",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                }}
              >
                <div style={{ fontSize: 13 }}>
                  <strong>{i.organization_name}</strong>
                  <span
                    className="pill pill-neutral"
                    style={{ marginLeft: 8 }}
                  >
                    {i.role}
                  </span>
                  <div
                    className="muted"
                    style={{ fontSize: 11, marginTop: 2 }}
                  >
                    {tOrg.invitedByPrefix}
                    {i.invited_by_email ?? "—"}
                    {tOrg.invitedByExpires}
                    {fmtTime(i.expires_at, locale)}
                  </div>
                </div>
                <form action={acceptInvitationAction}>
                  <input type="hidden" name="token" value={i.token} />
                  <button type="submit" className="btn btn-primary btn-sm">
                    {tOrg.acceptBtn}
                  </button>
                </form>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Existing memberships */}
      <div className="card">
        <div className="card-header">
          <h2>{tOrg.yourTeamsTitle}</h2>
          <div className="card-header-spacer" />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            {orgs.length}
            {orgs.length === 1
              ? tOrg.teamsCountSingular
              : tOrg.teamsCountPlural}
          </span>
        </div>
        {orgs.length === 0 ? (
          <div
            style={{
              padding: "20px 16px",
              fontSize: 13,
              color: "var(--text-secondary)",
              lineHeight: 1.55,
            }}
          >
            <strong>{tOrg.emptyTitle}</strong>
            <br />
            {tOrg.emptyBody1}
            <strong>{requiredPlanForOrg.name}</strong>
            {tOrg.emptyBody2}
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{tOrg.colName}</th>
                <th>{tOrg.colRole}</th>
                <th>{tOrg.colMembers}</th>
                <th>{tOrg.colJoined}</th>
              </tr>
            </thead>
            <tbody>
              {orgs.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link
                      href={`/organization/${o.id}`}
                      style={{
                        color: "var(--accent)",
                        textDecoration: "none",
                        fontWeight: 500,
                      }}
                    >
                      {o.name}
                    </Link>
                  </td>
                  <td>
                    <span className="pill pill-neutral">{o.role}</span>
                  </td>
                  <td className="muted">{o.member_count}</td>
                  <td className="muted">{fmtTime(o.joined_at, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Create new org */}
      <div
        className="card"
        style={{
          borderLeftWidth: 4,
          borderLeftStyle: "solid",
          borderLeftColor: "var(--accent)",
        }}
      >
        <div className="card-header">
          <h2>{tOrg.createTitle}</h2>
          <div className="card-header-spacer" />
          {canCreateOrg ? (
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
              {tOrg.createOwnerNote}
            </span>
          ) : (
            <span
              className="pill pill-neutral"
              style={{ fontSize: 11, color: "var(--warning)" }}
            >
              {requiredPlanForOrg.name}
              {tOrg.createPlanRequiredSuffix}
            </span>
          )}
        </div>
        {canCreateOrg ? (
          <form
            action={createOrganizationAction}
            style={{ display: "flex", gap: 8, alignItems: "center" }}
          >
            <input
              name="name"
              type="text"
              required
              placeholder={tOrg.createNamePlaceholder}
              className="input"
              style={{ flex: 1 }}
            />
            <button type="submit" className="btn btn-primary">
              {tOrg.createBtn}
            </button>
          </form>
        ) : (
          <div
            style={{
              padding: "8px 0 4px",
              fontSize: 13,
              color: "var(--text-secondary)",
              lineHeight: 1.6,
            }}
          >
            {tOrg.createGatedBodyPrefix}
            <strong>{requiredPlanForOrg.name}</strong>
            {tOrg.createGatedBodyMid}
            <strong>{currentPlanName}</strong>
            <Link href="/billing">{tOrg.createGatedBodyPlanLink}</Link>
            {tOrg.createGatedBodySuffix}
          </div>
        )}
      </div>
    </SettingsLayout>
  );
}
