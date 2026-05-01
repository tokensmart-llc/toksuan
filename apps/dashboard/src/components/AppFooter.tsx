"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Dictionary } from "@/i18n/types";

type AppFooterProps = {
  docsHomeUrl: string;
  /** Translated footer strings — same `nav` slice as AppNav since the
   *  link labels overlap and the toggle copy is shared. */
  t: Dictionary["nav"];
};

/**
 * Slim app-wide footer.
 *
 * Surfaces the "occasional / public-facing" links that used to clutter
 * the top nav (Trust, Estimate, Docs) plus a self-host CTA. Showing them
 * in a footer means they're always one scroll away without competing
 * with the daily-use navigation. Hidden on:
 *
 *   - The public landing page (`/`) — that page has its own marketing
 *     footer with a different visual treatment.
 *   - Auth pages (`/login`, `/sso/saml/*`) — the login form should be
 *     focused; rendering a "Trust / Estimate" row underneath looks
 *     promotional rather than functional.
 *
 * Auth-gated separately: the layout only mounts AppFooter when there's
 * a session, so anonymous /trust visitors don't see it either.
 */
export function AppFooter({ docsHomeUrl, t }: AppFooterProps) {
  const pathname = usePathname();

  if (
    pathname === "/" ||
    pathname === "/login" ||
    pathname.startsWith("/sso/")
  ) {
    return null;
  }

  return (
    <footer className="app-footer">
      <div className="app-footer-inner">
        <div className="app-footer-row">
          <Link href="/trust" className="app-footer-link">
            {t.trust}
          </Link>
          <Link href="/estimate" className="app-footer-link">
            {t.estimator}
          </Link>
          <Link href="/state-of-agent-spend" className="app-footer-link">
            {t.stateOfSpend}
          </Link>
          <a
            href={docsHomeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="app-footer-link"
          >
            {t.docs}
          </a>
          <a
            href="https://github.com/tokensmart-llc/toksuan"
            target="_blank"
            rel="noopener noreferrer"
            className="app-footer-link"
          >
            {t.selfHost}
          </a>
        </div>
        <div className="app-footer-meta">{t.footerMeta}</div>
      </div>
    </footer>
  );
}
