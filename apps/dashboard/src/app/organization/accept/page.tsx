import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, isAuthEnabled } from "@/lib/auth";
import { findInvitationByToken } from "@/lib/db";
import { getDictionary } from "@/lib/i18n.server";
import { acceptInvitationAction } from "../actions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Localised expiry-date helper. Defers to `Intl.DateTimeFormat` with a
 * locale tag so EN renders "12/24/2026" while CN renders "2026/12/24".
 * Kept inline (not pulled into a shared util) because this is the only
 * page that surfaces an absolute expiry date — the rest of the app
 * uses relative time.
 */
function fmtExpiry(d: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(d));
}

export default async function AcceptInvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  if (!isAuthEnabled()) redirect("/");
  const { token } = await searchParams;
  if (!token) redirect("/organization?toast=org-invite-bad-token");

  // Force a sign-in first so the accept binds to a real user. The
  // middleware preserves the full accept URL (including ?token) in
  // `?next=` when it bounces to /login, and the login flow redirects
  // back here after the session lands — so clicking an invite email
  // works end-to-end even if the user was logged out when they opened
  // the link.
  const session = await getSession();
  if (!session) {
    redirect(
      `/login?next=${encodeURIComponent(`/organization/accept?token=${token}`)}`
    );
  }

  const { locale, t } = await getDictionary();
  const ti = t.inviteAccept;

  const inv = await findInvitationByToken(token);
  if (!inv) {
    return (
      <main style={{ maxWidth: 560 }}>
        <h1>{ti.pageTitle}</h1>
        <div className="card card-danger">
          <strong>{ti.notFoundTitle}</strong>
          <br />
          {ti.notFoundBody}
        </div>
        <Link href="/organization" className="btn">
          {ti.backToOrgs}
        </Link>
      </main>
    );
  }

  if (inv.accepted_at) {
    return (
      <main style={{ maxWidth: 560 }}>
        <h1>{ti.alreadyAcceptedTitle}</h1>
        <div className="card card-warning">
          {ti.alreadyAcceptedBodyPrefix}
          <strong>{inv.organization_name}</strong>
          {ti.alreadyAcceptedBodySuffix}
        </div>
        <Link
          href={`/organization/${inv.organization_id}`}
          className="btn btn-primary"
        >
          {ti.openOrgBtn}
        </Link>
      </main>
    );
  }

  if (inv.expires_at < new Date()) {
    return (
      <main style={{ maxWidth: 560 }}>
        <h1>{ti.expiredTitle}</h1>
        <div className="card card-warning">
          {ti.expiredBodyTpl
            .split("{date}")
            .flatMap((part, i, arr) =>
              i < arr.length - 1
                ? [
                    part,
                    <strong key={i}>
                      {fmtExpiry(inv.expires_at, locale)}
                    </strong>,
                  ]
                : [part]
            )}
        </div>
        <Link href="/organization" className="btn">
          {ti.backToOrgs}
        </Link>
      </main>
    );
  }

  const emailMismatch =
    inv.email.toLowerCase() !== session.user.email.toLowerCase();

  // Split the join-title template so the org name keeps its <strong>
  // styling regardless of where `{org}` falls in the locale's word
  // order. zh-CN: "加入 {org}", en: "Join {org}".
  const joinTitleParts = ti.joinTitleTpl.split("{org}");

  return (
    <main style={{ maxWidth: 560 }}>
      <h1>
        {joinTitleParts[0]}
        {joinTitleParts.length > 1 && (
          <>
            <strong>{inv.organization_name}</strong>
            {joinTitleParts[1]}
          </>
        )}
      </h1>
      <p
        style={{
          color: "var(--text-secondary)",
          fontSize: 14,
          lineHeight: 1.6,
        }}
      >
        {ti.introBodyPrefix}
        <strong>{inv.organization_name}</strong>
        {ti.introBodyMid}
        <span className="pill pill-neutral">{inv.role}</span>
        {ti.introBodySuffix}
      </p>

      <div className="card">
        <div style={{ fontSize: 13, marginBottom: 12 }}>
          <div>
            <strong>{ti.rowInvitedLabel}</strong>{" "}
            <code className="code-inline">{inv.email}</code>
          </div>
          <div>
            <strong>{ti.rowSignedInLabel}</strong>{" "}
            <code className="code-inline">{session.user.email}</code>
          </div>
          <div>
            <strong>{ti.rowInvitedByLabel}</strong>{" "}
            <code className="code-inline">
              {inv.invited_by_email ?? "—"}
            </code>
          </div>
        </div>

        {emailMismatch && (
          <div className="card card-danger" style={{ marginBottom: 12 }}>
            <strong>{ti.emailMismatchTitle}</strong>
            <br />
            {ti.emailMismatchBodyPrefix}
            <code>{session.user.email}</code>
            {ti.emailMismatchBodyMid}
            <code>{inv.email}</code>
            {ti.emailMismatchBodySuffix}
          </div>
        )}

        <form action={acceptInvitationAction}>
          <input type="hidden" name="token" value={inv.token} />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={emailMismatch}
          >
            {ti.acceptBtn}
          </button>
        </form>
      </div>
    </main>
  );
}
