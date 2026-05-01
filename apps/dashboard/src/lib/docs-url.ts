/**
 * Documentation URL resolver. Every in-app link to an integration
 * guide, SECURITY.md, README section, etc. flows through this helper
 * so operators can point the dashboard at their own docs mirror
 * without editing component source.
 *
 * Resolution order:
 *   1. `NEXT_PUBLIC_DOCS_URL` — operator-configured base (e.g.
 *      `https://docs.tokensmt.com` or `https://mycompany.example/ts-docs`)
 *   2. `https://github.com/tokensmart-llc/toksuan/blob/main` — the
 *      canonical source of truth while the repo is the public face
 *
 * Hosted deploys at tokensmt.com should set `NEXT_PUBLIC_DOCS_URL=
 * https://tokensmt.com/docs` once we stand the marketing site's docs
 * section up — that keeps the in-app "see integration guides" link
 * pointing at a branded URL instead of dumping users into GitHub.
 *
 * The `NEXT_PUBLIC_` prefix is mandatory — this helper runs on both
 * server and client paths (layout nav, home onboarding card, etc.)
 * and Next 15 only ships `NEXT_PUBLIC_*` env vars to the browser
 * bundle.
 */

const DEFAULT_DOCS_BASE = "https://github.com/tokensmart-llc/toksuan/blob/main";

function base(): string {
  const fromEnv = process.env.NEXT_PUBLIC_DOCS_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  return DEFAULT_DOCS_BASE;
}

/**
 * Build a documentation URL for a repo-relative path.
 *
 *   getDocsUrl("docs/integrations/cursor.md")
 *   getDocsUrl("SECURITY.md#reliability-posture")
 *
 * Leading slashes are tolerated. Hash fragments are preserved.
 */
export function getDocsUrl(repoRelativePath: string): string {
  const trimmed = repoRelativePath.replace(/^\/+/, "");
  return `${base()}/${trimmed}`;
}

/** Origin-only docs URL, for use as a top-nav "Docs" link target. */
export function getDocsHomeUrl(): string {
  return base();
}
