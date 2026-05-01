"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import type { Dictionary } from "@/i18n/types";

/**
 * Two-column shell used by every page in the "account & operations"
 * family (Settings / Members / Billing / Audit / Referrals / Trust).
 *
 * Pattern: same as Vercel / GitHub / Stripe / Linear settings — left
 * sidebar lists every section so the user can see all surfaces at once
 * and hop between them in one click. Replaced an earlier horizontal
 * sub-tab strip; horizontal works for ≤4 tabs but the sidebar is the
 * de-facto standard for SaaS settings panels and reads as a single
 * coherent "settings workspace" instead of a row of unrelated tabs.
 *
 * URL shapes are unchanged — `/settings`, `/organization`, `/billing`,
 * `/audit`, `/referrals`, `/trust` all still resolve as standalone
 * pages. This component just provides a shared chrome so the sidebar
 * follows the user across every section without breaking deep links.
 *
 * Trust is a special case: the page is publicly accessible (procurement
 * reviewers must be able to read it without an account). The Trust page
 * conditionally renders this shell only when there's a session — see
 * `apps/dashboard/src/app/trust/page.tsx`.
 */

type SidebarItem = {
  href: string;
  label: string;
  /** Optional alternate prefix used to mark the tab active when the user
   *  has drilled into a sub-page (e.g. `/organization/[id]` should keep
   *  the Members tab lit). */
  matchPrefix?: string;
};

function isActive(item: SidebarItem, pathname: string): boolean {
  if (item.matchPrefix) {
    return (
      pathname === item.matchPrefix ||
      pathname.startsWith(item.matchPrefix + "/")
    );
  }
  return pathname === item.href;
}

/** Default English labels — used by `<SettingsLayout>` when a Server
 *  Component caller doesn't pass a localised slice (anonymous Trust
 *  visitors are the main case; they don't have a session, but the
 *  layout can still render). Mirrors the `nav` slice of the dictionary
 *  so swapping in a translated copy is a single prop change. */
const FALLBACK_NAV: Pick<
  Dictionary["nav"],
  | "settings"
  | "settingsAccount"
  | "settingsTeam"
  | "settingsBilling"
  | "settingsAudit"
  | "settingsReferrals"
  | "settingsTrust"
  | "settingsBack"
  | "settingsAriaLabel"
> = {
  settings: "Settings",
  settingsAccount: "Account & keys",
  settingsTeam: "Team",
  settingsBilling: "Billing & plan",
  settingsAudit: "Audit log",
  settingsReferrals: "Referrals",
  settingsTrust: "Security & trust",
  settingsBack: "← Dashboard",
  settingsAriaLabel: "Settings sub-navigation",
};

export type SettingsLayoutProps = {
  children: ReactNode;
  /** Localised sidebar copy. Pages pass `t.nav` from the server-resolved
   *  dictionary; omit to use English fallbacks. */
  t?: Dictionary["nav"];
};

export function SettingsLayout({ children, t }: SettingsLayoutProps) {
  const pathname = usePathname();
  const labels = t ?? FALLBACK_NAV;
  const sidebarItems: SidebarItem[] = [
    { href: "/settings", label: labels.settingsAccount },
    // Labelled "Team" rather than "Members" or "Organizations" — the
    // page covers BOTH the team workspace concept (the org) AND the
    // members inside it.
    {
      href: "/organization",
      label: labels.settingsTeam,
      matchPrefix: "/organization",
    },
    { href: "/billing", label: labels.settingsBilling },
    { href: "/audit", label: labels.settingsAudit },
    { href: "/referrals", label: labels.settingsReferrals },
    { href: "/trust", label: labels.settingsTrust },
  ];
  return (
    <div className="settings-shell">
      <aside
        className="settings-sidebar"
        aria-label={labels.settingsAriaLabel}
      >
        {/* Explicit "back to dashboard" affordance. AppNav at the top
         *  also has a Dashboard link, but Settings pages are long forms
         *  and users frequently scroll past the sticky AppNav into the
         *  form — leaving the sidebar as the closest visible escape.
         *  Mirrors `.project-sidebar-back`. */}
        <Link href="/dashboard" className="settings-sidebar-back">
          {labels.settingsBack}
        </Link>
        <div className="settings-sidebar-title">{labels.settings}</div>
        <nav className="settings-sidebar-nav">
          {sidebarItems.map((item) => {
            const active = isActive(item, pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={
                  "settings-sidebar-link" + (active ? " is-active" : "")
                }
                aria-current={active ? "page" : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <main className="settings-main">{children}</main>
    </div>
  );
}
