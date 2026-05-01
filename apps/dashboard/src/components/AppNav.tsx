"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/Logo";
import { LanguageToggle } from "@/components/LanguageToggle";
import { ThemeToggle } from "@/components/ThemeToggle";
import type { Dictionary } from "@/i18n/types";
import type { Locale } from "@/lib/i18n";

type AppNavProps = {
  email: string;
  docsHomeUrl: string;
  /** Locale resolved on the server. We never read the cookie on the
   *  client to keep SSR/CSR markup consistent. */
  locale: Locale;
  /** Translated nav strings — only the `nav` slice of the dictionary
   *  to keep the component prop surface narrow. */
  t: Dictionary["nav"];
  /** Translated theme-toggle aria/tooltip labels. */
  tTheme: Dictionary["themeToggle"];
};

/**
 * Top-level navigation.
 *
 * Slimmed from 12 links down to 5 daily-use surfaces (2026-04-27). The
 * removed items still have full standalone pages — they just live one
 * click deeper, accessed through SettingsLayout's sidebar (account-family
 * pages: Members / Billing / Audit / Referrals / Trust) or through the
 * AppFooter (Estimate). Reasoning: a 12-item top nav forced users to
 * scan the whole bar every page load even though most users hit
 * Audit / Referrals / Trust < once a month.
 *
 * The pages themselves and their URLs are unchanged so deep links from
 * docs / emails / external bookmarks continue to resolve.
 */
export function AppNav({ email, docsHomeUrl, locale, t, tTheme }: AppNavProps) {
  const pathname = usePathname();

  if (pathname === "/") return null;

  return (
    <nav className="app-nav">
      <div className="app-nav-inner">
        <Link href="/" className="app-nav-brand">
          <span className="app-nav-brand-mark">
            <Logo size={22} />
          </span>
          TokSuan
        </Link>
        <div className="app-nav-links">
          <Link href="/dashboard" className="app-nav-link">
            {t.dashboard}
          </Link>
          <Link href="/projects" className="app-nav-link">
            {t.projects}
          </Link>
          <Link href="/agents" className="app-nav-link">
            {t.agents}
          </Link>
          <Link href="/routing-quality" className="app-nav-link">
            {t.routing}
          </Link>
          <Link href="/settings" className="app-nav-link">
            {t.settings}
          </Link>
          <a
            href={docsHomeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="app-nav-link"
          >
            {t.docs}
          </a>
        </div>
        <div style={{ flex: 1 }} />
        <LanguageToggle locale={locale} />
        <ThemeToggle t={tTheme} />
        <span className="app-nav-email">{email}</span>
        <a href="/logout" className="app-nav-link">
          {t.signOut}
        </a>
      </div>
    </nav>
  );
}
