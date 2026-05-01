"use server";

import { randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { logAuditEvent } from "@/lib/audit";
import { LOCALE_COOKIE } from "@/lib/i18n";
import {
  acceptInvitation,
  cancelBillingTransferIntent,
  canRoleManageMembers,
  countOrgSeatsInUse,
  createBillingTransferIntent,
  createOrganization,
  createOrganizationInvitation,
  deleteInvitation,
  findInvitationByToken,
  getMemberRole,
  getOrganizationForUser,
  getOrgOwnerPlan,
  getOrgSamlConfig,
  INVITE_ROLES,
  refreshInvitationExpiry,
  removeOrganizationMember,
  sql,
  transferOrganizationOwnership,
  updateMemberRole,
  updateOrgSamlConfig,
  type InviteRole,
} from "@/lib/db";
import { sendInviteEmail } from "@/lib/email";
import {
  minPlanForEntitlement,
  planAllows,
  seatLimitFor,
} from "@/lib/plans";

const INVITE_TTL_DAYS = 14;

async function requireSession() {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

async function actorIp(): Promise<string | null> {
  const h = await headers();
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    null
  );
}

function toastQuery(slug: string, arg?: string): string {
  const p = new URLSearchParams({ toast: slug });
  if (arg) p.set("toast_arg", arg);
  return p.toString();
}

/**
 * Read the inviter's locale cookie so emails composed inside their
 * session are in the same language. Returns `null` (→ English fallback)
 * if the cookie is unset or unreadable (e.g. action invoked outside a
 * request scope).
 */
async function readLocaleCookie(): Promise<string | null> {
  try {
    const store = await cookies();
    return store.get(LOCALE_COOKIE)?.value ?? null;
  } catch {
    return null;
  }
}

export async function createOrganizationAction(
  formData: FormData
): Promise<void> {
  const session = await requireSession();
  const name = String(formData.get("name") ?? "").trim();
  if (!name || name.length > 80) {
    redirect(`/organization?${toastQuery("org-bad-name")}`);
  }
  // Entitlement: creating an org (and thus consuming a seat-limit quota)
  // is a Team+ feature. Free/Pro users can still be INVITED to someone
  // else's org — they just can't host one themselves.
  if (!planAllows(session.user.plan, "create_organization")) {
    const required = minPlanForEntitlement("create_organization");
    redirect(
      `/organization?${toastQuery("org-plan-required", required.name)}`
    );
  }
  const org = await createOrganization(session.user.id, name);
  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    organizationId: org.id,
    event: "organization.created",
    targetType: "organization",
    targetId: org.id,
    metadata: { name: org.name },
    ip: await actorIp(),
  });
  redirect(`/organization/${org.id}?${toastQuery("org-created", org.name)}`);
}

/**
 * Mint an invitation. Caller must be owner/admin in the org.
 *
 * Idempotency note: we don't dedupe outstanding invites for the same email
 * — admins might want to re-send on purpose. The accept flow refuses to
 * double-add via the (organization_id, user_id) UNIQUE constraint, so
 * there's no risk of duplicate membership.
 */
export async function inviteMemberAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const orgId = String(formData.get("org_id") ?? "");
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "member") as InviteRole;
  if (!INVITE_ROLES.includes(role)) {
    redirect(`/organization/${orgId}?${toastQuery("org-bad-role")}`);
  }
  if (!email || !email.includes("@")) {
    redirect(`/organization/${orgId}?${toastQuery("org-bad-email")}`);
  }
  const callerRole = await getMemberRole(session.user.id, orgId);
  if (!callerRole || !canRoleManageMembers(callerRole)) {
    redirect(`/organization/${orgId}?${toastQuery("org-not-allowed")}`);
  }

  const org = await getOrganizationForUser(session.user.id, orgId);
  if (!org) {
    redirect(`/organization?${toastQuery("org-not-found")}`);
  }

  // Seat-limit enforcement is keyed on the OWNER's plan, not the
  // caller's. A Team-plan-owner's admin can invite up to that owner's
  // 5-seat cap regardless of the admin's personal plan tier.
  const ownerPlan = await getOrgOwnerPlan(orgId);
  const seatCap = seatLimitFor(ownerPlan);
  if (Number.isFinite(seatCap)) {
    const inUse = await countOrgSeatsInUse(orgId);
    if (inUse >= seatCap) {
      redirect(
        `/organization/${orgId}?${toastQuery("org-seat-limit", String(seatCap))}`
      );
    }
  }

  const token = randomBytes(32).toString("hex");
  const inv = await createOrganizationInvitation({
    orgId,
    email,
    role,
    invitedByUserId: session.user.id,
    token,
    ttlDays: INVITE_TTL_DAYS,
  });

  // Fire-and-forget the email; failure is logged + won't block the action.
  // The token also lands in stdout for dev installs.
  // Locale: use the inviter's cookie locale (they're the one composing
  // the invitation; matches what they were just looking at). For invitees
  // who already have a TokSuan account we could look up their own
  // `users.preferred_locale`, but for cold invites that column is NULL
  // anyway — so the inviter's pick is the best signal we have.
  const inviterLocale = await readLocaleCookie();
  sendInviteEmail({
    to: email,
    organizationName: org.name,
    inviterEmail: session.user.email,
    role,
    token,
    locale: inviterLocale,
  }).catch((e) =>
    console.warn(
      "[tokensmart-org] invite email failed:",
      e instanceof Error ? e.message : e
    )
  );

  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    organizationId: orgId,
    event: "organization.invited",
    targetType: "organization_invitation",
    targetId: inv.id,
    metadata: { email, role, organization_id: orgId },
    ip: await actorIp(),
  });

  redirect(`/organization/${orgId}?${toastQuery("org-invited", email)}`);
}

/**
 * Resend an invitation: bumps the row's `expires_at` to now+14d and
 * re-fires the email with the SAME token. Safer than minting a new
 * token because any in-flight accept link the invitee already clicked
 * keeps working.
 *
 * Idempotent — clicking Resend 5 times just keeps pushing expires_at
 * forward; the invitee always sees the same token in their inbox.
 */
export async function resendInvitationAction(
  formData: FormData
): Promise<void> {
  const session = await requireSession();
  const orgId = String(formData.get("org_id") ?? "");
  const invitationId = String(formData.get("invitation_id") ?? "");
  const callerRole = await getMemberRole(session.user.id, orgId);
  if (!callerRole || !canRoleManageMembers(callerRole)) {
    redirect(`/organization/${orgId}?${toastQuery("org-not-allowed")}`);
  }

  const refreshed = await refreshInvitationExpiry({
    orgId,
    invitationId,
    ttlDays: INVITE_TTL_DAYS,
  });
  if (!refreshed) {
    redirect(`/organization/${orgId}?${toastQuery("org-invite-bad-token")}`);
  }

  // Look up org name for the email template — refreshInvitationExpiry
  // doesn't JOIN (it's keyed on invitation_id + org_id so the target is
  // unambiguous without the join).
  const org = await getOrganizationForUser(session.user.id, orgId);
  if (org) {
    const inviterLocale = await readLocaleCookie();
    sendInviteEmail({
      to: refreshed.email,
      organizationName: org.name,
      inviterEmail: session.user.email,
      role: refreshed.role,
      token: refreshed.token,
      locale: inviterLocale,
    }).catch((e) =>
      console.warn(
        "[tokensmart-org] resend invite email failed:",
        e instanceof Error ? e.message : e
      )
    );
  }

  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    organizationId: orgId,
    event: "organization.invitation_resent",
    targetType: "organization_invitation",
    targetId: invitationId,
    metadata: {
      organization_id: orgId,
      email: refreshed.email,
      new_expires_at: refreshed.expires_at.toISOString(),
    },
    ip: await actorIp(),
  });

  redirect(
    `/organization/${orgId}?${toastQuery("org-invite-resent", refreshed.email)}`
  );
}

export async function revokeInvitationAction(
  formData: FormData
): Promise<void> {
  const session = await requireSession();
  const orgId = String(formData.get("org_id") ?? "");
  const invitationId = String(formData.get("invitation_id") ?? "");
  const callerRole = await getMemberRole(session.user.id, orgId);
  if (!callerRole || !canRoleManageMembers(callerRole)) {
    redirect(`/organization/${orgId}?${toastQuery("org-not-allowed")}`);
  }
  await deleteInvitation(orgId, invitationId);
  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    organizationId: orgId,
    event: "organization.invitation_revoked",
    targetType: "organization_invitation",
    targetId: invitationId,
    metadata: { organization_id: orgId },
    ip: await actorIp(),
  });
  redirect(`/organization/${orgId}?${toastQuery("org-invite-revoked")}`);
}

export async function changeMemberRoleAction(
  formData: FormData
): Promise<void> {
  const session = await requireSession();
  const orgId = String(formData.get("org_id") ?? "");
  const memberId = String(formData.get("member_id") ?? "");
  const newRole = String(formData.get("role") ?? "member") as InviteRole;
  if (!INVITE_ROLES.includes(newRole)) {
    redirect(`/organization/${orgId}?${toastQuery("org-bad-role")}`);
  }
  const callerRole = await getMemberRole(session.user.id, orgId);
  if (!callerRole || !canRoleManageMembers(callerRole)) {
    redirect(`/organization/${orgId}?${toastQuery("org-not-allowed")}`);
  }
  await updateMemberRole(orgId, memberId, newRole);
  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    organizationId: orgId,
    event: "organization.role_changed",
    targetType: "organization_member",
    targetId: memberId,
    metadata: { organization_id: orgId, role: newRole },
    ip: await actorIp(),
  });
  redirect(`/organization/${orgId}?${toastQuery("org-role-changed")}`);
}

/**
 * Owner self-transfer: the current owner designates an existing member
 * as the new owner; they themselves drop to `admin`. In-product path
 * replacing the old "CLI-only" footer note. Only the current owner can
 * trigger this (caller role check), and the successor must already
 * be a member (see DB helper).
 *
 * Note: the Stripe subscription paying for the org stays on the old
 * owner — transferring ownership doesn't touch billing. If the new
 * owner wants to move billing to their own Stripe customer, they'd
 * do that via /billing and the old owner would cancel theirs. We
 * document this in the dialog copy below rather than trying to
 * auto-migrate subscriptions (which has a real "what if the new
 * owner's card is declined" failure mode that's worse than asking).
 */
export async function transferOwnershipAction(
  formData: FormData
): Promise<void> {
  const session = await requireSession();
  const orgId = String(formData.get("org_id") ?? "");
  const successorUserId = String(formData.get("successor_user_id") ?? "");
  const confirm = String(formData.get("confirm_org_name") ?? "").trim();
  const transferBilling = formData.get("transfer_billing") === "1";

  const org = await getOrganizationForUser(session.user.id, orgId);
  if (!org) {
    redirect(`/organization?${toastQuery("org-not-found")}`);
  }
  if (confirm !== org.name) {
    redirect(
      `/organization/${orgId}?${toastQuery("org-transfer-confirm-mismatch")}`
    );
  }

  const result = await transferOrganizationOwnership({
    orgId,
    currentOwnerUserId: session.user.id,
    successorUserId,
  });
  if (!result.ok) {
    const slug =
      result.reason === "not_owner"
        ? "org-transfer-not-owner"
        : result.reason === "no_successor"
          ? "org-transfer-bad-successor"
          : "org-transfer-same-user";
    redirect(`/organization/${orgId}?${toastQuery(slug)}`);
  }

  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    organizationId: orgId,
    event: "organization.ownership_transferred",
    targetType: "organization",
    targetId: orgId,
    metadata: { successor_user_id: successorUserId, transfer_billing: transferBilling },
    ip: await actorIp(),
  });

  // Billing-transfer intent is OPT-IN — by default the Stripe
  // subscription stays on the old owner (safe posture; auto-swapping
  // has a real "new owner's card declines" failure mode). When the
  // box is ticked, we write an intent row that surfaces on both
  // parties' /billing pages. Actual subscription swap is manual for
  // now (new owner pays, old owner cancels) — we do NOT touch Stripe
  // from this path.
  if (transferBilling) {
    // Look up the old owner's current subscription so the intent
    // remembers which sub to eventually cancel. Null if they're on
    // Free — which is fine, no subscription to move.
    const subRows = await sql<{ stripe_subscription_id: string | null }[]>`
      SELECT stripe_subscription_id FROM users WHERE id = ${session.user.id}
    `;
    const fromSub = subRows[0]?.stripe_subscription_id ?? null;
    const intent = await createBillingTransferIntent({
      organizationId: orgId,
      fromUserId: session.user.id,
      toUserId: successorUserId,
      fromStripeSubscriptionId: fromSub,
    });
    if (intent.ok) {
      await logAuditEvent({
        userId: session.user.id,
        actorEmail: session.user.email,
        organizationId: orgId,
        event: "billing.transfer_intent_created",
        targetType: "billing_transfer_intent",
        targetId: intent.intent.id,
        metadata: {
          to_user_id: successorUserId,
          from_stripe_subscription_id: fromSub,
        },
        ip: await actorIp(),
      });
      // Best-effort notification to the new owner. If email isn't
      // configured, the intent still appears on their /billing page
      // when they next log in.
      sql<{ email: string }[]>`
        SELECT email FROM users WHERE id = ${successorUserId} LIMIT 1
      `
        .then(async (rows) => {
          const to = rows[0]?.email;
          if (!to) return;
          console.log(
            `[tokensmart-billing-transfer] intent ${intent.intent.id} — notify ${to}`
          );
        })
        .catch(() => {
          /* non-fatal */
        });
    }
    // If ok=false (already_pending), the UI will still redirect to
    // success — the earlier intent still applies. We don't want to
    // fail the ownership transfer on a billing-intent conflict.
  }

  redirect(`/organization/${orgId}?${toastQuery("org-transfer-complete")}`);
}

/**
 * Cancel a pending billing-transfer intent. Either party may cancel
 * (the `from_user_id` old owner or the `to_user_id` new owner); the
 * DB helper enforces that via its WHERE clause.
 */
export async function cancelBillingTransferIntentAction(
  formData: FormData
): Promise<void> {
  const session = await requireSession();
  const intentId = String(formData.get("intent_id") ?? "");
  const ok = await cancelBillingTransferIntent({
    intentId,
    byUserId: session.user.id,
  });
  if (!ok) {
    redirect(`/billing?${toastQuery("billing-transfer-cancel-failed")}`);
  }
  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    event: "billing.transfer_intent_cancelled",
    targetType: "billing_transfer_intent",
    targetId: intentId,
    ip: await actorIp(),
  });
  redirect(`/billing?${toastQuery("billing-transfer-cancelled")}`);
}

export async function removeMemberAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const orgId = String(formData.get("org_id") ?? "");
  const memberId = String(formData.get("member_id") ?? "");
  const callerRole = await getMemberRole(session.user.id, orgId);
  if (!callerRole || !canRoleManageMembers(callerRole)) {
    redirect(`/organization/${orgId}?${toastQuery("org-not-allowed")}`);
  }
  await removeOrganizationMember(orgId, memberId);
  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    organizationId: orgId,
    event: "organization.member_removed",
    targetType: "organization_member",
    targetId: memberId,
    metadata: { organization_id: orgId },
    ip: await actorIp(),
  });
  redirect(`/organization/${orgId}?${toastQuery("org-member-removed")}`);
}

export async function acceptInvitationAction(
  formData: FormData
): Promise<void> {
  const session = await requireSession();
  const token = String(formData.get("token") ?? "");
  const inv = await findInvitationByToken(token);
  if (!inv || inv.accepted_at || inv.expires_at < new Date()) {
    redirect(`/organization?${toastQuery("org-invite-bad-token")}`);
  }
  // Email match is enforced loosely — exact lowercase compare. Mismatches
  // could happen if a user switched primary email after the invite went
  // out; force them to re-request to keep audit trail honest.
  if (inv.email.toLowerCase() !== session.user.email.toLowerCase()) {
    redirect(`/organization?${toastQuery("org-invite-email-mismatch")}`);
  }
  const result = await acceptInvitation({
    invitationId: inv.id,
    userId: session.user.id,
  });
  if (!result) {
    redirect(`/organization?${toastQuery("org-invite-bad-token")}`);
  }
  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    organizationId: result.orgId,
    event: "organization.invitation_accepted",
    targetType: "organization",
    targetId: result.orgId,
    metadata: { role: result.role },
    ip: await actorIp(),
  });
  redirect(`/organization/${result.orgId}?${toastQuery("org-joined")}`);
}

/**
 * Save SSO/SAML configuration on an organization. Restricted to org
 * owners + admins (canRoleManageMembers). The full per-field rules
 * (mode allowed values, mutual-exclusivity of metadata XML vs manual
 * IdP entry) live below — intentionally explicit so a UI tweak doesn't
 * silently change validation.
 */
export async function saveOrgSamlConfigAction(
  formData: FormData
): Promise<void> {
  const session = await requireSession();
  const orgId = String(formData.get("org_id") ?? "");
  if (!orgId) {
    redirect(`/organization?${toastQuery("org-not-found")}`);
  }

  // Arg order is (userId, orgId) — previous copy of this action had them
  // swapped which silently 403'd every SAML save attempt. Keep this the
  // right way round.
  const role = await getMemberRole(session.user.id, orgId);
  if (!role || !canRoleManageMembers(role)) {
    redirect(`/organization/${orgId}?${toastQuery("sso-no-permission")}`);
  }

  // SAML configuration is a Scale-only feature. Check against the
  // ORG-OWNER's plan — admins inviting configuration on someone else's
  // Team-plan org shouldn't unlock SAML just because the admin happens
  // to have a personal Scale subscription.
  const ownerPlan = await getOrgOwnerPlan(orgId);
  if (!planAllows(ownerPlan, "configure_saml")) {
    const required = minPlanForEntitlement("configure_saml");
    redirect(
      `/organization/${orgId}?${toastQuery("org-plan-required", required.name)}`
    );
  }

  const mode = String(formData.get("saml_enforcement_mode") ?? "off");
  if (!["off", "optional", "required"].includes(mode)) {
    redirect(`/organization/${orgId}?${toastQuery("sso-bad-mode")}`);
  }

  const defaultRole = String(formData.get("saml_default_role") ?? "member");
  if (!["admin", "member", "viewer"].includes(defaultRole)) {
    redirect(`/organization/${orgId}?${toastQuery("sso-bad-default-role")}`);
  }

  const rawDomain = String(formData.get("saml_email_domain") ?? "")
    .trim()
    .toLowerCase();
  // Strip a leading @ if a copy-pasted address has one.
  const domain = rawDomain.replace(/^@/, "");
  // Empty string -> NULL the column (admin clearing the field).
  if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    redirect(`/organization/${orgId}?${toastQuery("sso-bad-domain")}`);
  }

  const xml = String(formData.get("saml_idp_metadata_xml") ?? "").trim();
  const entityId = String(formData.get("saml_idp_entity_id") ?? "").trim();
  const ssoUrl = String(formData.get("saml_idp_sso_url") ?? "").trim();
  const cert = String(formData.get("saml_idp_x509_cert") ?? "").trim();

  // When mode is non-off, we need EITHER a metadata XML OR all three
  // manual fields. Refuse partial configs so the IdP redirect can never
  // produce a malformed AuthnRequest at runtime.
  if (mode !== "off") {
    const hasManual = entityId && ssoUrl && cert;
    if (!xml && !hasManual) {
      redirect(`/organization/${orgId}?${toastQuery("sso-incomplete")}`);
    }
  }

  await updateOrgSamlConfig(orgId, {
    saml_enforcement_mode: mode as "off" | "optional" | "required",
    saml_default_role: defaultRole as "admin" | "member" | "viewer",
    saml_email_domain: domain ? domain : null,
    saml_idp_metadata_xml: xml ? xml : null,
    saml_idp_entity_id: entityId ? entityId : null,
    saml_idp_sso_url: ssoUrl ? ssoUrl : null,
    saml_idp_x509_cert: cert ? cert : null,
  });

  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    organizationId: orgId,
    event: "auth.sso.config_updated",
    targetType: "organization",
    targetId: orgId,
    metadata: {
      mode,
      domain: domain || null,
      via_metadata_xml: !!xml,
      via_manual: !xml && !!entityId && !!ssoUrl && !!cert,
    },
    ip: await actorIp(),
  });

  redirect(`/organization/${orgId}?${toastQuery("sso-saved")}`);
}

/**
 * Lightweight read for the SSO admin card — re-exposed as an action so
 * the page can call it without dragging the heavy `samlify` import into
 * the page's RSC bundle. (samlify uses XML libs that bloat the
 * server-component graph.)
 */
export async function loadOrgSamlConfigForUI(
  orgId: string
): Promise<Awaited<ReturnType<typeof getOrgSamlConfig>>> {
  return getOrgSamlConfig(orgId);
}
