import type { MetadataRoute } from "next";

/**
 * Robots directives for the dashboard origin.
 *
 * Public surfaces (should be crawled + indexed):
 *   /          — brand hero on the dashboard root (most users never see
 *                this unsigned-in, but it's reachable in single-tenant
 *                mode and acts as a fallback landing page)
 *   /estimate  — public savings calculator. This is the page we actively
 *                want Google / Bing to rank for "llm savings calculator"
 *                style queries.
 *   /login     — the sign-in page itself. Crawlable so the rest of the
 *                app is discoverable in site-link search results.
 *
 * Private surfaces (NEVER indexed — all are auth-gated anyway, but this
 * belt-and-braces keeps them out of site-operator snapshots + prevents
 * leaked URLs from getting cached by Googlebot before an access-control
 * fix lands):
 *   /audit, /billing, /organization, /projects, /referrals, /requests,
 *   /settings, /sso, /logout, /api
 *
 * The sitemap declaration relies on `NEXT_PUBLIC_BASE_URL` being set on
 * the hosted deploy. Self-hosted installs just get a sensible fallback.
 */
function origin(): string {
  const raw = process.env.NEXT_PUBLIC_BASE_URL?.trim();
  if (!raw) return "http://localhost:3000";
  return raw.replace(/\/+$/, "");
}

export default function robots(): MetadataRoute.Robots {
  const base = origin();
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/estimate", "/login"],
        disallow: [
          "/audit",
          "/audit/",
          "/billing",
          "/billing/",
          "/organization",
          "/organization/",
          "/projects",
          "/projects/",
          "/referrals",
          "/referrals/",
          "/requests",
          "/requests/",
          "/settings",
          "/settings/",
          "/sso/",
          "/logout",
          "/api/",
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
