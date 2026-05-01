import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession, isAuthEnabled } from "@/lib/auth";
import {
  canRoleManageMembers,
  getOrganizationForUser,
  getOrgOwnerPlan,
  INVITE_ROLES,
  listOrganizationInvitations,
  listOrganizationMembers,
  type OrganizationInvitationRow,
  type OrganizationMemberRow,
  type OrganizationMembershipRow,
} from "@/lib/db";
import {
  changeMemberRoleAction,
  inviteMemberAction,
  loadOrgSamlConfigForUI,
  removeMemberAction,
  resendInvitationAction,
  revokeInvitationAction,
  saveOrgSamlConfigAction,
  transferOwnershipAction,
} from "../actions";
import { getDocsUrl } from "@/lib/docs-url";
import {
  minPlanForEntitlement,
  planAllows,
  planFromId,
  seatLimitFor,
} from "@/lib/plans";
import { getDictionary } from "@/lib/i18n.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Locale-aware date+time formatter. EN renders MM/DD/YYYY HH:mm, CN
 *  renders YYYY/MM/DD HH:mm — Intl handles the swap once we pass the
 *  right tag. We don't fork between the two locales further; the
 *  dashboard's other tables use the same shape. */
function fmtTime(d: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(d));
}

export default async function OrganizationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!isAuthEnabled()) redirect("/");
  const session = await getSession();
  if (!session) redirect("/login");
  const { id } = await params;

  let org: OrganizationMembershipRow | null = null;
  let members: OrganizationMemberRow[] = [];
  let invitations: OrganizationInvitationRow[] = [];
  let samlCfg: Awaited<ReturnType<typeof loadOrgSamlConfigForUI>> = null;
  let ownerPlan: string | null = null;
  try {
    org = await getOrganizationForUser(session.user.id, id);
    if (org) {
      [members, invitations, samlCfg, ownerPlan] = await Promise.all([
        listOrganizationMembers(org.id),
        listOrganizationInvitations(org.id),
        loadOrgSamlConfigForUI(org.id),
        getOrgOwnerPlan(org.id),
      ]);
    }
  } catch {
    /* surfaced via not-found below */
  }
  if (!org) notFound();

  const canManage = canRoleManageMembers(org.role);
  // Entitlement gating — UI mirrors server actions so users see locked
  // state before they click, not after a redirect-with-error.
  const seatCap = seatLimitFor(ownerPlan);
  const seatsInUse = members.length + invitations.length;
  const seatLimitReached = Number.isFinite(seatCap) && seatsInUse >= seatCap;
  const samlAllowedForOrg = planAllows(ownerPlan, "configure_saml");
  const samlRequiredPlan = minPlanForEntitlement("configure_saml").name;
  const ownerPlanLabel = planFromId(ownerPlan).name;
  const acsUrl = `${
    process.env.NEXT_PUBLIC_BASE_URL?.replace(/\/$/, "") ||
    "http://localhost:3000"
  }/sso/saml/acs?org=${org.id}`;
  const metadataUrl = `${
    process.env.NEXT_PUBLIC_BASE_URL?.replace(/\/$/, "") ||
    "http://localhost:3000"
  }/sso/saml/metadata?org=${org.id}`;

  const { locale, t } = await getDictionary();
  const td = t.organizationDetail;

  // Localised "{used}/{cap} seats ({plan})" — built once so the
  // span below stays readable.
  const seatsLabel = td.membersSeatsTpl
    .replace("{used}", String(seatsInUse))
    .replace("{cap}", String(seatCap))
    .replace("{plan}", ownerPlanLabel);

  return (
    <main>
      <Link href="/organization" className="back-link">
        {td.backToList}
      </Link>
      <h1>{org.name}</h1>
      <p className="tagline">
        {td.yourRoleLabel}{" "}
        <span className="pill pill-neutral">{org.role}</span>{" "}
        {!canManage && (
          <span style={{ color: "var(--text-muted)", marginLeft: 8 }}>
            {td.cantManageNote}
          </span>
        )}
      </p>

      {/* Members */}
      <div className="card">
        <div className="card-header">
          <h2>{td.membersTitle}</h2>
          <div className="card-header-spacer" />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            {members.length}
            {td.membersActiveSuffix}
            {invitations.length > 0 && (
              <>
                {" · "}
                {invitations.length}
                {td.membersPendingSuffix}
              </>
            )}
            {Number.isFinite(seatCap) && (
              <>
                {" · "}
                <span
                  style={{
                    color: seatLimitReached
                      ? "var(--danger)"
                      : "var(--text-muted)",
                    fontWeight: seatLimitReached ? 500 : 400,
                  }}
                >
                  {seatsLabel}
                </span>
              </>
            )}
          </span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>{td.memberColEmail}</th>
              <th>{td.memberColRole}</th>
              <th>{td.memberColJoined}</th>
              {canManage && <th></th>}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const isOwner = m.role === "owner";
              const isSelf = m.user_id === session.user.id;
              return (
                <tr key={m.id}>
                  <td>
                    <code className="code-inline">{m.email}</code>
                    {isSelf && (
                      <span
                        className="muted"
                        style={{ fontSize: 11, marginLeft: 6 }}
                      >
                        {td.memberSelfBadge}
                      </span>
                    )}
                  </td>
                  <td>
                    {canManage && !isOwner && !isSelf ? (
                      <form
                        action={changeMemberRoleAction}
                        style={{ display: "inline-flex", gap: 6 }}
                      >
                        <input type="hidden" name="org_id" value={org.id} />
                        <input
                          type="hidden"
                          name="member_id"
                          value={m.id}
                        />
                        <select
                          name="role"
                          defaultValue={m.role}
                          className="input"
                          style={{ height: 28, fontSize: 12, padding: "2px 6px" }}
                        >
                          {INVITE_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                        <button
                          type="submit"
                          className="btn btn-sm btn-ghost"
                        >
                          {td.memberSaveRoleBtn}
                        </button>
                      </form>
                    ) : (
                      <span className="pill pill-neutral">{m.role}</span>
                    )}
                  </td>
                  <td className="muted">{fmtTime(m.joined_at, locale)}</td>
                  {canManage && (
                    <td style={{ textAlign: "right" }}>
                      {!isOwner && !isSelf && (
                        <form
                          action={removeMemberAction}
                          style={{ display: "inline" }}
                        >
                          <input
                            type="hidden"
                            name="org_id"
                            value={org.id}
                          />
                          <input
                            type="hidden"
                            name="member_id"
                            value={m.id}
                          />
                          <button
                            type="submit"
                            className="btn btn-sm btn-danger"
                          >
                            {td.memberRemoveBtn}
                          </button>
                        </form>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pending invitations */}
      {canManage && (
        <div className="card">
          <div className="card-header">
            <h2>{td.invitesTitle}</h2>
            <div className="card-header-spacer" />
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
              {invitations.length}
              {td.invitesPendingSuffix}
            </span>
          </div>
          {invitations.length === 0 ? (
            <div
              className="empty"
              style={{ fontSize: 13, color: "var(--text-secondary)" }}
            >
              {td.invitesEmpty}
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>{td.inviteColEmail}</th>
                  <th>{td.inviteColRole}</th>
                  <th>{td.inviteColInvitedBy}</th>
                  <th>{td.inviteColExpires}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <code className="code-inline">{i.email}</code>
                    </td>
                    <td>
                      <span className="pill pill-neutral">{i.role}</span>
                    </td>
                    <td className="muted">
                      {i.invited_by_email ?? "—"}
                    </td>
                    <td className="muted">
                      {fmtTime(i.expires_at, locale)}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <div
                        style={{
                          display: "inline-flex",
                          gap: 6,
                          justifyContent: "flex-end",
                        }}
                      >
                        <form action={resendInvitationAction}>
                          <input
                            type="hidden"
                            name="org_id"
                            value={org.id}
                          />
                          <input
                            type="hidden"
                            name="invitation_id"
                            value={i.id}
                          />
                          <button
                            type="submit"
                            className="btn btn-sm btn-ghost"
                            title={td.inviteResendTooltip}
                          >
                            {td.inviteResendBtn}
                          </button>
                        </form>
                        <form action={revokeInvitationAction}>
                          <input
                            type="hidden"
                            name="org_id"
                            value={org.id}
                          />
                          <input
                            type="hidden"
                            name="invitation_id"
                            value={i.id}
                          />
                          <button
                            type="submit"
                            className="btn btn-sm btn-danger"
                          >
                            {td.inviteRevokeBtn}
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Invite form */}
      {canManage && (
        <div
          className="card"
          style={{
            borderLeftWidth: 4,
            borderLeftStyle: "solid",
            borderLeftColor: "var(--accent)",
          }}
        >
          <div className="card-header">
            <h2>{td.inviteFormTitle}</h2>
            {seatLimitReached && (
              <>
                <div className="card-header-spacer" />
                <span
                  className="pill pill-neutral"
                  style={{ fontSize: 11, color: "var(--danger)" }}
                >
                  {td.inviteFormSeatLimitPill}
                </span>
              </>
            )}
          </div>
          {seatLimitReached ? (
            <div
              style={{
                padding: "16px 4px 8px",
                fontSize: 13,
                color: "var(--text-secondary)",
                lineHeight: 1.6,
              }}
            >
              {td.inviteFormSeatLimitBodyPrefix}
              <strong>{ownerPlanLabel}</strong>
              {td.inviteFormSeatLimitBodyMid}
              <strong>{seatCap}</strong>
              {td.inviteFormSeatLimitBodySuffix}
              <Link href="/billing">{td.inviteFormBillingLink}</Link>
              {/* "to invite more" sentence-end is woven into the
                  suffix in EN; CN uses 升级即可邀请更多. Keep both
                  flavors inside the dictionary so each locale can
                  shape the sentence its own way without us splicing
                  punctuation in TSX. */}
            </div>
          ) : (
            <form
              action={inviteMemberAction}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 140px auto",
                gap: 10,
                alignItems: "center",
              }}
            >
              <input type="hidden" name="org_id" value={org.id} />
              <input
                name="email"
                type="email"
                required
                placeholder={td.inviteFormEmailPlaceholder}
                className="input"
              />
              <select name="role" defaultValue="member" className="input">
                {INVITE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <button type="submit" className="btn btn-primary">
                {td.inviteFormSendBtn}
              </button>
            </form>
          )}
          <div
            style={{
              marginTop: 10,
              fontSize: 11,
              color: "var(--text-muted)",
              lineHeight: 1.55,
            }}
          >
            <strong>{td.inviteFormRolesHelpPrefix}</strong>:{" "}
            <strong>admin</strong> {td.inviteFormRolesHelpAdminBody}{" "}
            <strong>member</strong> {td.inviteFormRolesHelpMemberBody}{" "}
            <strong>viewer</strong> {td.inviteFormRolesHelpViewerBody}{" "}
            {td.inviteFormRolesHelpOwnerHint}
          </div>
          <div
            style={{
              marginTop: 6,
              fontSize: 11,
              color: "var(--text-muted)",
              lineHeight: 1.55,
            }}
          >
            <strong>{td.inviteFormDeliveryHelpPrefix}</strong>
            {td.inviteFormDeliveryHelpSuffix}
          </div>
        </div>
      )}

      {/* SSO / SAML config — owners + admins can edit; everyone else
          sees the read-only summary so non-admins know whether SSO is
          on and what domain it covers. */}
      <div
        className="card"
        style={{
          marginTop: 24,
          borderLeftWidth: 4,
          borderLeftStyle: "solid",
          borderLeftColor: "var(--accent)",
        }}
      >
        <div className="card-header">
          <h2>{td.ssoTitle}</h2>
          <div className="card-header-spacer" />
          {samlAllowedForOrg ? (
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
              {td.ssoModeLabel}{" "}
              <code className="code-inline">
                {samlCfg?.saml_enforcement_mode ?? "off"}
              </code>
            </span>
          ) : (
            <span
              className="pill pill-neutral"
              style={{ fontSize: 11, color: "var(--warning)" }}
            >
              {samlRequiredPlan}
              {td.ssoPlanRequiredSuffix}
            </span>
          )}
        </div>

        {!samlAllowedForOrg ? (
          <div
            style={{
              padding: "12px 0",
              fontSize: 13,
              color: "var(--text-secondary)",
              lineHeight: 1.6,
            }}
          >
            {td.ssoPlanGatedBodyPrefix}
            <strong>{samlRequiredPlan}</strong>
            {td.ssoPlanGatedBodyMid1}
            <strong>{ownerPlanLabel}</strong>
            {td.ssoPlanGatedBodyMid2}
            {td.ssoPlanGatedBodyDocsPrefix}
            <Link href={getDocsUrl("docs/integrations/sso-okta.md")}>
              {td.ssoPlanGatedBodyDocsLinkText}
            </Link>
            {td.ssoPlanGatedBodyDocsSuffix}
          </div>
        ) : !canManage ? (
          <div
            style={{
              padding: "12px 0",
              fontSize: 13,
              color: "var(--text-secondary)",
              lineHeight: 1.55,
            }}
          >
            {td.ssoReadOnlyPrefix}
            <strong>{samlCfg?.saml_enforcement_mode ?? "off"}</strong>
            {td.ssoReadOnlyDomainSuffix}
            {samlCfg?.saml_email_domain
              ? ` (@${samlCfg.saml_email_domain})`
              : ""}
            {td.ssoReadOnlyAdminNote}
          </div>
        ) : (
          <>
            <div
              style={{
                padding: "4px 0 12px",
                fontSize: 13,
                color: "var(--text-secondary)",
                lineHeight: 1.55,
              }}
            >
              {td.ssoIdpHelpBody}
            </div>
            <div
              style={{
                display: "grid",
                gap: 6,
                fontSize: 12,
                marginBottom: 12,
                padding: "10px 12px",
                background: "var(--code-bg)",
                borderRadius: 6,
                fontFamily: "var(--font-mono)",
              }}
            >
              <div>
                <span style={{ color: "var(--text-muted)" }}>
                  {td.ssoAcsLabel}
                </span>{" "}
                {acsUrl}
              </div>
              <div>
                <span style={{ color: "var(--text-muted)" }}>
                  {td.ssoEntityIdLabel}
                </span>{" "}
                {metadataUrl}
              </div>
            </div>

            <form
              action={saveOrgSamlConfigAction}
              style={{ display: "grid", gap: 12 }}
            >
              <input type="hidden" name="org_id" value={org.id} />

              <div
                style={{
                  display: "grid",
                  gap: 12,
                  gridTemplateColumns: "1fr 1fr 1fr",
                }}
              >
                <label className="field">
                  <span className="field-label">
                    {td.ssoEnforcementLabel}
                  </span>
                  <select
                    name="saml_enforcement_mode"
                    defaultValue={samlCfg?.saml_enforcement_mode ?? "off"}
                    className="input"
                  >
                    <option value="off">{td.ssoEnforcementOff}</option>
                    <option value="optional">
                      {td.ssoEnforcementOptional}
                    </option>
                    <option value="required">
                      {td.ssoEnforcementRequired}
                    </option>
                  </select>
                </label>

                <label className="field">
                  <span className="field-label">
                    {td.ssoEmailDomainLabel}
                  </span>
                  <input
                    name="saml_email_domain"
                    type="text"
                    defaultValue={samlCfg?.saml_email_domain ?? ""}
                    placeholder={td.ssoEmailDomainPlaceholder}
                    pattern="[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"
                    className="input"
                  />
                </label>

                <label className="field">
                  <span className="field-label">
                    {td.ssoJitDefaultRoleLabel}
                  </span>
                  <select
                    name="saml_default_role"
                    defaultValue={samlCfg?.saml_default_role ?? "member"}
                    className="input"
                  >
                    <option value="viewer">viewer</option>
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                  </select>
                </label>
              </div>

              <label className="field">
                <span className="field-label">{td.ssoMetadataXmlLabel}</span>
                <textarea
                  name="saml_idp_metadata_xml"
                  rows={6}
                  defaultValue={samlCfg?.saml_idp_metadata_xml ?? ""}
                  placeholder={td.ssoMetadataXmlPlaceholder}
                  className="input"
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    resize: "vertical",
                    padding: 10,
                  }}
                />
              </label>

              <details
                style={{ fontSize: 12, color: "var(--text-secondary)" }}
              >
                <summary
                  style={{
                    cursor: "pointer",
                    padding: "6px 0",
                    color: "var(--text-secondary)",
                  }}
                >
                  {td.ssoManualToggleLabel}
                </summary>
                <div
                  style={{
                    display: "grid",
                    gap: 10,
                    marginTop: 10,
                    paddingLeft: 8,
                    borderLeft: "2px solid var(--border)",
                  }}
                >
                  <label className="field">
                    <span className="field-label">
                      {td.ssoIdpEntityIdLabel}
                    </span>
                    <input
                      name="saml_idp_entity_id"
                      type="text"
                      defaultValue={samlCfg?.saml_idp_entity_id ?? ""}
                      placeholder={td.ssoIdpEntityIdPlaceholder}
                      className="input"
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">
                      {td.ssoIdpSsoUrlLabel}
                    </span>
                    <input
                      name="saml_idp_sso_url"
                      type="url"
                      defaultValue={samlCfg?.saml_idp_sso_url ?? ""}
                      placeholder={td.ssoIdpSsoUrlPlaceholder}
                      className="input"
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">
                      {td.ssoIdpCertLabel}
                    </span>
                    <textarea
                      name="saml_idp_x509_cert"
                      rows={5}
                      defaultValue={samlCfg?.saml_idp_x509_cert ?? ""}
                      placeholder={
                        "-----BEGIN CERTIFICATE-----\nMIID...\n-----END CERTIFICATE-----"
                      }
                      className="input"
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        resize: "vertical",
                        padding: 10,
                      }}
                    />
                  </label>
                </div>
              </details>

              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button type="submit" className="btn btn-primary">
                  {td.ssoSaveBtn}
                </button>
                {samlCfg?.saml_enforcement_mode &&
                  samlCfg.saml_enforcement_mode !== "off" && (
                    <a
                      href={`/sso/saml/login?org=${org.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btn-sm btn-ghost"
                    >
                      {td.ssoTestLoginBtn}
                    </a>
                  )}
              </div>

              <div
                style={{
                  marginTop: 4,
                  fontSize: 11,
                  color: "var(--text-muted)",
                  lineHeight: 1.6,
                }}
              >
                <strong>{td.ssoReferenceTitle}</strong>
                {td.ssoReferenceBodyPrefix}
                <a
                  href="https://samltest.id"
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "var(--accent)" }}
                >
                  {td.ssoReferenceBodyLinkText}
                </a>
                {td.ssoReferenceBodySuffix}
              </div>
            </form>
          </>
        )}
      </div>

      {/* Transfer ownership — owner-only. Replaces the old
          "CLI-only" note: the sole-owner-leaves-company case used to
          be a 2am support ticket because the only way out was a
          direct DB edit. Now it's a guarded in-product action, with
          a confirm-by-typing-org-name guardrail. */}
      {org.role === "owner" &&
        members.filter((m) => m.role !== "owner").length > 0 && (
          <div
            className="card"
            style={{
              marginTop: 24,
              borderLeftWidth: 4,
              borderLeftStyle: "solid",
              borderLeftColor: "var(--danger)",
            }}
          >
            <div className="card-header">
              <h2>{td.transferTitle}</h2>
              <div className="card-header-spacer" />
              <span
                className="pill pill-neutral"
                style={{ fontSize: 11, color: "var(--danger)" }}
              >
                {td.transferOwnerOnlyPill}
              </span>
            </div>
            <div
              style={{
                fontSize: 13,
                color: "var(--text-secondary)",
                lineHeight: 1.6,
                marginBottom: 14,
              }}
            >
              {td.transferBodyPrefix}
              <strong>owner</strong>
              {td.transferBodyMid1}
              <strong>admin</strong>
              {td.transferBodyMid2}
              <strong>{td.transferConfirmCodeWord}</strong>
              {td.transferBodyMid3}
              <Link href="/billing">{td.transferBillingLink}</Link>
              {td.transferBodySuffix}
              <code className="code-inline">{org.name}</code>.
            </div>
            <form
              action={transferOwnershipAction}
              style={{
                display: "grid",
                gap: 10,
                alignItems: "center",
              }}
            >
              <input type="hidden" name="org_id" value={org.id} />
              <div
                style={{
                  display: "grid",
                  gap: 10,
                  gridTemplateColumns: "1fr 1fr auto",
                  alignItems: "center",
                }}
              >
                <select
                  name="successor_user_id"
                  required
                  className="input"
                  defaultValue=""
                >
                  <option value="" disabled>
                    {td.transferSelectPlaceholder}
                  </option>
                  {members
                    .filter((m) => m.role !== "owner")
                    .map((m) => (
                      <option key={m.user_id} value={m.user_id}>
                        {m.email} ({m.role})
                      </option>
                    ))}
                </select>
                <input
                  name="confirm_org_name"
                  type="text"
                  required
                  placeholder={td.transferConfirmPlaceholderTpl.replace(
                    "{name}",
                    org.name
                  )}
                  className="input"
                  autoComplete="off"
                />
                <button type="submit" className="btn btn-danger">
                  {td.transferSubmitBtn}
                </button>
              </div>
              <label
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "flex-start",
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  lineHeight: 1.55,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  name="transfer_billing"
                  value="1"
                  style={{ marginTop: 3, flexShrink: 0 }}
                />
                <span>
                  <strong>{td.transferBillingLabel}</strong>
                  {td.transferBillingBodyPrefix}
                  <Link href="/billing">{td.transferBillingLink}</Link>
                  {td.transferBillingBodyMid}
                  <strong>{td.transferConfirmCodeWord}</strong>
                  {td.transferBillingBodySuffix}
                </span>
              </label>
            </form>
          </div>
        )}
    </main>
  );
}
