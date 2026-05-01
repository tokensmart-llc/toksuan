"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  attributeReferralFromCookie,
  consumeLogin,
  createSession,
  isEmailConfigured,
  setSessionCookie,
  startLogin,
} from "@/lib/auth";
import { logAuditEvent } from "@/lib/audit";
import { findOrgByEmailDomain } from "@/lib/db";
import {
  checkAuthIpLimit,
  checkOtpRequestLimit,
  isOtpVerifyLocked,
  recordOtpVerifyFailure,
  resetOtpVerifyFailures,
} from "@/lib/rate-limit";
import { emailDomain, safeRelayPath } from "@/lib/saml";

/** Extract client IP from the standard proxy headers, falling back
 *  to null when the request came over a socket with no x-forwarded-*. */
async function actorIp(): Promise<string | null> {
  const h = await headers();
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    null
  );
}

/**
 * Discriminant: `stage`. Success is represented by `redirect()` short-
 * circuiting the action — there is intentionally NO `{ ok: true }` variant
 * in this union, because if we returned it to the client it would mean the
 * user's session cookie was set but the browser kept the login form mounted.
 * If you ever need a "linger on page after login" UX, add a variant and
 * update `login/page.tsx` to handle it.
 */
export type LoginState =
  | { ok: false; stage: "email"; error?: string }
  | { ok: false; stage: "code"; email: string; error?: string; note?: string };

/**
 * Stage 1: user submits email. We always advance to the code stage, even if
 * the email doesn't exist yet — that's how we do passwordless signup and
 * signin with the same form without leaking whether an account exists.
 */
export async function requestLogin(
  _prev: LoginState,
  formData: FormData
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const next = safeRelayPath(String(formData.get("next") ?? ""));
  if (!email || !email.includes("@")) {
    return { ok: false, stage: "email", error: "Enter a valid email address." };
  }

  // IP-scope rate limit first — catches bulk enumeration (one IP
  // probing 1000 emails) regardless of which email is submitted.
  const ip = await actorIp();
  const ipCheck = checkAuthIpLimit(ip);
  if (!ipCheck.allowed) {
    return {
      ok: false,
      stage: "email",
      error: `Too many login attempts. Try again in ${ipCheck.retryAfterSeconds}s.`,
    };
  }

  // Email-scope rate limit — caps inbox floods against a specific
  // user. Surfaces a helpful countdown instead of a generic error
  // so a legitimate user who clicked Continue twice sees why.
  const emailCheck = await checkOtpRequestLimit(email).catch(() => ({
    allowed: true as const,
  }));
  if (!emailCheck.allowed) {
    return {
      ok: false,
      stage: "email",
      error: `We already sent a code to ${email} recently. Check your inbox or wait ${emailCheck.retryAfterSeconds}s before requesting another.`,
    };
  }

  // SSO short-circuit: if the email's domain matches an org with SAML
  // enabled (mode in {'optional', 'required'}), redirect the user
  // through their IdP instead of mailing an OTP. `'required'` is hard
  // (no OTP fallback ever); `'optional'` here STILL takes precedence
  // because the user explicitly typed their email and we want the SSO
  // experience to be the path of least resistance — the rare user who
  // needs OTP can hit /login?force_otp=1 (TBD; v0.3 has no UI for it).
  const domain = emailDomain(email);
  if (domain) {
    try {
      const orgCfg = await findOrgByEmailDomain(domain);
      if (orgCfg) {
        // Server actions can't call NextResponse.redirect — use Next's
        // `redirect()` which throws a special signal Next catches and
        // turns into a 302.
        redirect(
          `/sso/saml/login?org=${orgCfg.organization_id}&next=${encodeURIComponent(next)}`
        );
      }
    } catch (err) {
      // `redirect()` throws — re-throw so Next handles it. Any other
      // failure (e.g. DB unreachable) falls through to OTP, which is
      // the safer degradation: a broken SAML config shouldn't lock
      // every user out of email-OTP login.
      if (err && typeof err === "object" && "digest" in err) throw err;
      console.warn(
        "[tokensmart-auth] SAML domain lookup failed; falling back to OTP:",
        err
      );
    }
  }

  await startLogin(email, next);
  return {
    ok: false,
    stage: "code",
    email,
    note: isEmailConfigured()
      ? "Check your inbox for a 6-digit code. It expires in 15 minutes."
      : "Sent. This install has no email delivery configured — grab the code from the dashboard server console.",
  };
}

/**
 * Stage 2: user submits the OTP. On success we set the session cookie and
 * redirect to the dashboard — so this server action never returns a
 * "successful" state (the redirect short-circuits the flow).
 */
export async function verifyLogin(
  _prev: LoginState,
  formData: FormData
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const code = String(formData.get("code") ?? "").trim();
  const next = safeRelayPath(String(formData.get("next") ?? ""));
  if (!email || !code) {
    return {
      ok: false,
      stage: "code",
      email,
      error: "Email and code are both required.",
    };
  }

  // IP throttle + email brute-force lockout. The verify lockout lives
  // in-process (no DB row per failed attempt) — 15min window, 10
  // failures lock the email for another 15min. Successful verify
  // clears the counter below so a legitimate user isn't penalised
  // for a typo.
  const ip = await actorIp();
  const ipCheck = checkAuthIpLimit(ip);
  if (!ipCheck.allowed) {
    return {
      ok: false,
      stage: "code",
      email,
      error: `Too many attempts from your IP. Try again in ${ipCheck.retryAfterSeconds}s.`,
    };
  }
  const emailLock = isOtpVerifyLocked(email);
  if (emailLock.locked) {
    return {
      ok: false,
      stage: "code",
      email,
      error: `Too many incorrect codes. This email is locked for ${Math.ceil(emailLock.retryAfterSeconds / 60)} more minute(s). Request a fresh code once the lock lifts.`,
    };
  }

  // SAML enforcement: if the email's domain is locked to 'required' SSO,
  // refuse OTP even with a valid code. (A determined attacker who has
  // both the email AND the OTP shouldn't bypass the org's SSO policy.)
  // 'optional' mode lets OTP through — that's the whole point of
  // 'optional'.
  const domain = emailDomain(email);
  if (domain) {
    try {
      const orgCfg = await findOrgByEmailDomain(domain);
      if (orgCfg && orgCfg.saml_enforcement_mode === "required") {
        return {
          ok: false,
          stage: "email",
          error: `${domain} requires single sign-on. Re-enter your email to be redirected to your identity provider.`,
        };
      }
    } catch {
      // DB issue → safer to allow OTP than to lock everyone out.
    }
  }

  const user = await consumeLogin({ email, code });
  if (!user) {
    recordOtpVerifyFailure(email);
    return {
      ok: false,
      stage: "code",
      email,
      error: "Code is invalid or expired. Request a new one.",
    };
  }
  // Wipe the failure counter so a typo earlier in the session
  // doesn't haunt this email after a successful login.
  resetOtpVerifyFailures(email);

  const token = await createSession(user.id);
  await setSessionCookie(token);
  await attributeReferralFromCookie(user.id);

  const h = await headers();
  await logAuditEvent({
    userId: user.id,
    actorEmail: user.email,
    event: "auth.login",
    metadata: { method: "otp" },
    ip:
      h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      h.get("x-real-ip") ||
      null,
    userAgent: h.get("user-agent"),
  });

  redirect(next);
}
