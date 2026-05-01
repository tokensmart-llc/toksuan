import { NextResponse, type NextRequest } from "next/server";
import {
  attributeReferralFromCookie,
  consumeLogin,
  createSession,
  setSessionCookie,
} from "@/lib/auth";
import { logAuditEvent } from "@/lib/audit";
import { checkAuthIpLimit } from "@/lib/rate-limit";
import { safeRelayPath } from "@/lib/saml";

/**
 * Magic-link handler: `/login/verify?token=...&next=/some/path`.
 *
 * Lets the user sign in by clicking the URL we printed to the console (or
 * emailed) instead of typing a 6-digit code. Same consumeLogin() path as
 * the OTP form.
 *
 * `next` is the post-login destination (e.g. the org-invite-accept page)
 * — sanitised through `safeRelayPath` so an attacker can't craft a magic
 * link that drops users on a phishing page after login.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = req.nextUrl.searchParams.get("token");
  const nextPath = safeRelayPath(req.nextUrl.searchParams.get("next"));
  if (!token) {
    return NextResponse.redirect(new URL("/login?error=missing-token", req.url));
  }

  // IP throttle. Token space is 2^256 so brute-force is infeasible,
  // but we still cap per-IP activity to catch probes / enumeration
  // (e.g. a scanner trying every token in a leaked log).
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    null;
  const ipCheck = checkAuthIpLimit(ip);
  if (!ipCheck.allowed) {
    return new NextResponse("Too many login attempts. Try again shortly.", {
      status: 429,
      headers: { "Retry-After": String(ipCheck.retryAfterSeconds) },
    });
  }

  const user = await consumeLogin({ token });
  if (!user) {
    // Preserve next across the error retry so the user doesn't lose
    // their original destination when they request a fresh code.
    const errUrl = new URL("/login?error=invalid-token", req.url);
    if (nextPath !== "/") errUrl.searchParams.set("next", nextPath);
    return NextResponse.redirect(errUrl);
  }

  const session = await createSession(user.id);
  await setSessionCookie(session);
  await attributeReferralFromCookie(user.id);

  await logAuditEvent({
    userId: user.id,
    actorEmail: user.email,
    event: "auth.login",
    metadata: { method: "magic-link" },
    ip:
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      null,
    userAgent: req.headers.get("user-agent"),
  });

  return NextResponse.redirect(new URL(nextPath, req.url));
}
