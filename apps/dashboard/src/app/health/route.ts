import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json({
    ok: true,
    service: "tokensmart-dashboard",
  });
}
