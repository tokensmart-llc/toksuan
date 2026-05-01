import { NextResponse, type NextRequest } from "next/server";
import {
  isUnsubscribableList,
  unsubscribeByToken,
} from "@/lib/unsubscribe";

/**
 * RFC 8058 one-click unsubscribe endpoint.
 *
 * Gmail, Apple Mail, Yahoo render a one-click unsubscribe button next
 * to the sender when the message carries both:
 *   List-Unsubscribe: <https://app/unsubscribe?...>, <mailto:...>
 *   List-Unsubscribe-Post: List-Unsubscribe=One-Click
 *
 * Clicking the button POSTs `List-Unsubscribe=One-Click` (form-encoded)
 * to the first URL. This endpoint accepts that shape AND a plain POST
 * with the token in the query string; either way, flips the flag and
 * returns 200 without redirecting (one-click UX).
 *
 * No CSRF protection: the token itself is the credential (256 bits of
 * entropy), and the action is trivially reversible from /settings by
 * the authenticated user.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function doUnsubscribe(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const token = (url.searchParams.get("t") ?? "").trim();
  const listCandidate = (url.searchParams.get("list") ?? "weekly_digest").trim();
  if (!isUnsubscribableList(listCandidate)) {
    return new NextResponse("Unknown list", { status: 400 });
  }
  if (!token) {
    return new NextResponse("Missing token", { status: 400 });
  }
  const result = await unsubscribeByToken(token, listCandidate).catch(
    () => ({ ok: false as const })
  );
  if (!result.ok) {
    return new NextResponse("Invalid or expired unsubscribe link.", {
      status: 404,
    });
  }
  return NextResponse.json({ ok: true, list: listCandidate });
}

export async function POST(req: NextRequest): Promise<Response> {
  return doUnsubscribe(req);
}

// Some mail clients still issue GET on the List-Unsubscribe URL even
// when the message carries List-Unsubscribe-Post. Accept it here too
// — same idempotent flip, returns 200. The HTML-rendering confirmation
// page lives at `/unsubscribe` (no `/api/` prefix); this one is the
// machine-readable endpoint.
export async function GET(req: NextRequest): Promise<Response> {
  return doUnsubscribe(req);
}
