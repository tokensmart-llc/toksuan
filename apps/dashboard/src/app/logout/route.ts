import { NextResponse, type NextRequest } from "next/server";
import { destroySession, getSession, SESSION_COOKIE } from "@/lib/auth";
import { logAuditEvent } from "@/lib/audit";

/**
 * Sign out.
 *
 * IMPORTANT: we clear the cookie on the OUTGOING `NextResponse` — calling
 * `cookies().delete(...)` inside a route handler only mutates the request
 * cookie jar, not the response sent back to the browser, so the user would
 * still appear signed in on the next page. Writing via `response.cookies`
 * forces a real `Set-Cookie: ...; Max-Age=0` header.
 */
async function handle(req: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  if (session) {
    await destroySession(session.token);
    await logAuditEvent({
      userId: session.user.id,
      actorEmail: session.user.email,
      event: "auth.logout",
      ip:
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        req.headers.get("x-real-ip") ||
        null,
      userAgent: req.headers.get("user-agent"),
    });
  }

  const response = NextResponse.redirect(new URL("/login", req.url));
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    expires: new Date(0),
  });
  // Belt-and-braces: if some upstream cache (or `<Link>` soft-nav) would have
  // kept the old shell, this header pushes the browser to revalidate.
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}

// Accept both GET (anchor link) and POST (form).
export const GET = handle;
export const POST = handle;
