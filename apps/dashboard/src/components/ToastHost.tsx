"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { en } from "@/i18n/en";
import { zhCN } from "@/i18n/zh-CN";
import type { Dictionary } from "@/i18n/types";

/**
 * Minimal toast surface driven by URL. Server actions trigger feedback by
 * redirecting to a path with `?toast=<slug>` (and optional `&toast_arg=...`);
 * this component reads it, shows the notice for a few seconds, then strips
 * the query params so refreshing doesn't re-show the toast.
 *
 * Locale handling: ToastHost lives in `app/layout.tsx` and the server can't
 * pass it props per-render (each toast slug is a distinct redirect). We
 * read `<html lang>` (set by the layout from the cookie) on the client to
 * pick the right dictionary slice. Same approach as `app/error.tsx`.
 */

type ToastMessage = {
  kind: "success" | "danger";
  text: string;
  actionHref?: string;
  actionLabel?: string;
};

function pickT(): Dictionary {
  if (typeof document === "undefined") return en;
  return document.documentElement.lang === "zh-CN" ? zhCN : en;
}

/** Replace `{arg}` (and other named placeholders) in a template string. */
function fill(tpl: string, vars: Record<string, string>): string {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{${k}}`, v);
  }
  return out;
}

function messageFor(
  slug: string,
  arg: string | null,
  d: Dictionary
): ToastMessage | null {
  const t = d.toasts;
  switch (slug) {
    case "project-created":
      return {
        kind: "success",
        text: arg ? fill(t.projectCreated, { arg }) : t.projectCreatedNoArg,
      };
    case "project-deleted":
      return {
        kind: "success",
        text: arg ? fill(t.projectDeleted, { arg }) : t.projectDeletedNoArg,
      };
    case "key-created":
      return { kind: "success", text: t.keyCreated };
    case "key-name-required":
      return { kind: "danger", text: t.keyNameRequired };
    case "key-create-failed":
      return { kind: "danger", text: t.keyCreateFailed };
    case "key-created-no-reveal":
      return { kind: "danger", text: t.keyCreatedNoReveal };
    case "key-deleted":
      return { kind: "success", text: t.keyDeleted };
    case "key-rotated":
      return { kind: "success", text: t.keyRotated };
    case "key-rotate-not-found":
      return { kind: "danger", text: t.keyRotateNotFound };
    case "budget-saved":
      return { kind: "success", text: t.budgetSaved };
    case "budget-deleted":
      return { kind: "success", text: t.budgetDeleted };
    case "budget-invalid":
      return { kind: "danger", text: t.budgetInvalid };
    case "routing-saved":
      return { kind: "success", text: t.routingSaved };
    case "routing-deleted":
      return { kind: "success", text: t.routingDeleted };
    case "routing-locked":
      return { kind: "success", text: t.routingLocked };
    case "test-key-ok":
      return { kind: "success", text: t.testKeyOk };
    case "test-key-fail":
      return { kind: "danger", text: t.testKeyFail };
    case "alert-test-ok":
      // `arg` is the per-channel summary built by `summarizeTestResult`
      // in projects/actions.ts (e.g. "webhook ok, email ok"). Falls back
      // to the generic line for older redirects without an arg.
      return {
        kind: "success",
        text: arg ? fill(t.alertTestOk, { arg }) : t.alertTestOkNoArg,
      };
    case "digest-enabled":
      return { kind: "success", text: t.digestEnabled };
    case "digest-enabled-hosted":
      return { kind: "success", text: t.digestEnabledHosted };
    case "digest-disabled":
      return { kind: "success", text: t.digestDisabled };
    case "alert-test-fail":
      // Specific reason takes priority over a generic message — operators
      // can tell the difference between "webhook 404" / "RESEND_API_KEY
      // not set" / "TOKENSMART_INTERNAL_TOKEN not set on the dashboard".
      if (arg === "no-internal-token") {
        return { kind: "danger", text: t.alertTestFailNoInternalToken };
      }
      if (arg === "no-target") {
        return { kind: "danger", text: t.alertTestFailNoTarget };
      }
      return {
        kind: "danger",
        text: arg
          ? fill(t.alertTestFailWithReason, { arg })
          : t.alertTestFailNoReason,
      };
    case "routing-invalid":
      return { kind: "danger", text: t.routingInvalid };
    case "routing-bad-regex":
      return { kind: "danger", text: t.routingBadRegex };
    case "alert-saved":
      return { kind: "success", text: t.alertSaved };
    case "alert-deleted":
      return { kind: "success", text: t.alertDeleted };
    case "alert-no-target":
      return { kind: "danger", text: t.alertNoTarget };
    case "alert-bad-url":
      return { kind: "danger", text: t.alertBadUrl };
    case "alert-invalid":
      return { kind: "danger", text: t.alertInvalid };
    case "provider-key-saved":
      return {
        kind: "success",
        text: arg
          ? fill(t.providerKeySaved, { arg })
          : t.providerKeySavedNoArg,
      };
    case "provider-key-deleted":
      return { kind: "success", text: t.providerKeyDeleted };
    case "provider-key-encryption-missing":
      return { kind: "danger", text: t.providerKeyEncryptionMissing };
    case "provider-key-invalid":
      return { kind: "danger", text: t.providerKeyInvalid };
    case "provider-key-too-short":
      return { kind: "danger", text: t.providerKeyTooShort };
    case "provider-key-bad-url":
      return { kind: "danger", text: t.providerKeyBadUrl };
    case "referral-code-ready":
      return {
        kind: "success",
        text: arg
          ? fill(t.referralCodeReady, { arg })
          : t.referralCodeReadyNoArg,
      };
    case "referral-settled":
      return {
        kind: "success",
        text: arg
          ? fill(t.referralSettled, { arg })
          : t.referralSettledNoArg,
      };
    case "referral-settle-unauth":
      return { kind: "danger", text: t.referralSettleUnauth };
    case "request-replay-queued":
      return {
        kind: "success",
        text: arg
          ? fill(t.requestReplayQueued, { arg })
          : t.requestReplayQueuedNoArg,
      };
    case "request-replay-failed":
      if (arg === "set-internal-replay-env") {
        return { kind: "danger", text: t.requestReplayFailedNoEnv };
      }
      return {
        kind: "danger",
        text: arg
          ? fill(t.requestReplayFailedWithReason, { arg })
          : t.requestReplayFailedNoReason,
      };
    case "template-saved":
      return { kind: "success", text: t.templateSaved };
    case "template-deleted":
      return { kind: "success", text: t.templateDeleted };
    case "template-bad-input":
      return { kind: "danger", text: t.templateBadInput };
    case "org-created":
      return {
        kind: "success",
        text: arg ? fill(t.orgCreated, { arg }) : t.orgCreatedNoArg,
      };
    case "org-bad-name":
      return { kind: "danger", text: t.orgBadName };
    case "org-bad-role":
      return { kind: "danger", text: t.orgBadRole };
    case "org-bad-email":
      return { kind: "danger", text: t.orgBadEmail };
    case "org-not-allowed":
      return { kind: "danger", text: t.orgNotAllowed };
    case "org-not-found":
      return { kind: "danger", text: t.orgNotFound };
    case "org-invited":
      return {
        kind: "success",
        text: arg ? fill(t.orgInvited, { arg }) : t.orgInvitedNoArg,
      };
    case "org-invite-revoked":
      return { kind: "success", text: t.orgInviteRevoked };
    case "org-invite-resent":
      return {
        kind: "success",
        text: arg
          ? fill(t.orgInviteResent, { arg })
          : t.orgInviteResentNoArg,
      };
    case "org-transfer-complete":
      return { kind: "success", text: t.orgTransferComplete };
    case "org-transfer-not-owner":
      return { kind: "danger", text: t.orgTransferNotOwner };
    case "org-transfer-bad-successor":
      return { kind: "danger", text: t.orgTransferBadSuccessor };
    case "org-transfer-same-user":
      return { kind: "danger", text: t.orgTransferSameUser };
    case "org-transfer-confirm-mismatch":
      return { kind: "danger", text: t.orgTransferConfirmMismatch };
    case "account-delete-confirm-mismatch":
      return { kind: "danger", text: t.accountDeleteConfirmMismatch };
    case "account-delete-scheduled":
      return { kind: "success", text: t.accountDeleteScheduled };
    case "account-delete-cancelled":
      return { kind: "success", text: t.accountDeleteCancelled };
    case "account-delete-org-owner":
      return {
        kind: "danger",
        text: arg
          ? fill(t.accountDeleteOrgOwner, { arg })
          : t.accountDeleteOrgOwnerNoArg,
      };
    case "billing-transfer-cancelled":
      return { kind: "success", text: t.billingTransferCancelled };
    case "billing-transfer-cancel-failed":
      return { kind: "danger", text: t.billingTransferCancelFailed };
    case "billing-transfer-completed":
      return { kind: "success", text: t.billingTransferCompleted };
    case "org-role-changed":
      return { kind: "success", text: t.orgRoleChanged };
    case "org-member-removed":
      return { kind: "success", text: t.orgMemberRemoved };
    case "org-invite-bad-token":
      return { kind: "danger", text: t.orgInviteBadToken };
    case "org-invite-email-mismatch":
      return { kind: "danger", text: t.orgInviteEmailMismatch };
    case "org-joined":
      return { kind: "success", text: t.orgJoined };
    case "org-plan-required":
      return {
        kind: "danger",
        text: arg
          ? fill(t.orgPlanRequired, { arg })
          : t.orgPlanRequiredNoArg,
        actionHref: "/billing",
        actionLabel: t.actionViewPlans,
      };
    case "org-seat-limit":
      return {
        kind: "danger",
        text: arg ? fill(t.orgSeatLimit, { arg }) : t.orgSeatLimitNoArg,
        actionHref: "/billing",
        actionLabel: t.actionViewPlans,
      };
    // SSO/SAML save flow on /organization/[id]. saveOrgSamlConfigAction
    // emits these slugs; without entries here the toast was silently
    // empty on every save / validation failure.
    case "sso-saved":
      return { kind: "success", text: t.ssoSaved };
    case "sso-no-permission":
      return { kind: "danger", text: t.ssoNoPermission };
    case "sso-bad-mode":
      return { kind: "danger", text: t.ssoBadMode };
    case "sso-bad-default-role":
      return { kind: "danger", text: t.ssoBadDefaultRole };
    case "sso-bad-domain":
      return { kind: "danger", text: t.ssoBadDomain };
    case "sso-incomplete":
      return { kind: "danger", text: t.ssoIncomplete };
    default:
      return null;
  }
}

function ToastInner() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const slug = params.get("toast");
  const arg = params.get("toast_arg");

  const [active, setActive] = useState<ToastMessage | null>(null);
  // Resolve dictionary once on mount — `<html lang>` is set by the
  // server-rendered RootLayout before hydration so this is stable for the
  // lifetime of the page (a locale change forces a full reload via the
  // Server Action that writes the cookie + revalidates).
  const dict = useMemo(() => pickT(), []);

  useEffect(() => {
    if (!slug) {
      setActive(null);
      return;
    }
    const msg = messageFor(slug, arg, dict);
    if (!msg) return;

    setActive(msg);

    // Strip `toast` / `toast_arg` params so reloading doesn't re-show.
    const next = new URLSearchParams(params.toString());
    next.delete("toast");
    next.delete("toast_arg");
    const q = next.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });

    const timer = window.setTimeout(() => setActive(null), 3200);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, arg, dict]);

  if (!active) return null;

  return (
    <div className="toast-host">
      <div className={`toast toast-${active.kind}`}>
        <span className={`toast-dot toast-dot-${active.kind}`} />
        <span>{active.text}</span>
        {active.actionHref && active.actionLabel && (
          <a href={active.actionHref} style={{ color: "inherit", fontWeight: 600 }}>
            {active.actionLabel}
          </a>
        )}
      </div>
    </div>
  );
}

export function ToastHost() {
  // useSearchParams must be inside a Suspense boundary per Next 15.
  return (
    <Suspense fallback={null}>
      <ToastInner />
    </Suspense>
  );
}
