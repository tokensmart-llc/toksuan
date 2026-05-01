import { NextResponse, type NextRequest } from "next/server";
import { getOrgSamlConfig } from "@/lib/db";
import { spMetadataXml } from "@/lib/saml";

/**
 * SP metadata XML — IdP admins fetch this URL once during initial
 * configuration. Returns 404 unless `?org=<id>` is supplied AND the org
 * has SAML enabled (mode != 'off').
 *
 * Cached for 1 hour by the CDN — metadata is stable across deploys
 * because SP entityID and ACS URL come from NEXT_PUBLIC_BASE_URL, which
 * doesn't change without an explicit env update.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const orgId = req.nextUrl.searchParams.get("org");
  if (!orgId) {
    return NextResponse.json(
      { error: "Missing ?org=<organization_id>." },
      { status: 400 }
    );
  }
  const cfg = await getOrgSamlConfig(orgId);
  if (!cfg || cfg.saml_enforcement_mode === "off") {
    return NextResponse.json(
      { error: "SAML is not configured for this organization." },
      { status: 404 }
    );
  }
  let xml: string;
  try {
    xml = spMetadataXml(cfg);
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to generate metadata XML.",
      },
      { status: 500 }
    );
  }
  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/samlmetadata+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
