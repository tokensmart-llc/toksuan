"use client";

import Link from "next/link";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { Dictionary } from "@/i18n/types";

/**
 * Two-column shell for `/projects/[id]` with TAB SEMANTICS.
 *
 * Layout responsibilities:
 *   - Sidebar carries every project-level identifier and live status:
 *     project name, LIVE/updated indicator, short-form project id with
 *     copy button. Main column shouldn't repeat any of these — they
 *     would compete with the active section's own heading.
 *   - Main column shows ONLY the active section's content, headed by
 *     that section's human-readable label (looked up from the same
 *     `groups` array that drives the sidebar). Switching tabs is hash-
 *     driven (`/projects/<id>#alerts`) so reload + share-link preserve
 *     the active section without server round-trips.
 *
 * Section visibility is implemented via `<ProjectSection>` wrapper
 * Client Components reading `useActiveSection()` from the context
 * provided here. Children of inactive sections aren't mounted at all
 * (ProjectSection returns `null`), which keeps the page free of
 * scroll-jacking from off-screen forms with their own input state.
 */

const ActiveSectionContext = createContext<string>("api-keys");
const PENDING_PROJECT_SECTION_KEY = "tokensmart:pending-project-section";
const PROJECT_SECTION_PREFIX = "tokensmart:project-section:";

/** Used by `<ProjectSection>` to decide whether to render its children.
 *  Exported so the wrapper Client Component can read the same context
 *  without importing this whole layout module. */
export function useActiveSection(): string {
  return useContext(ActiveSectionContext);
}

type SectionItem = {
  id: string;
  label: string;
  /** Optional: hide this item from the sidebar when the section
   *  doesn't exist on this particular page render (e.g. Get started
   *  is only shown for empty-state projects). */
  visible?: boolean;
};

type SectionGroup = {
  group: string;
  items: SectionItem[];
};

type ProjectDetailLayoutProps = {
  projectName: string;
  /** Whether the empty-state "Next: send your first request" card is
   *  currently rendered on the page. Drives whether the sidebar shows
   *  the Get started entry AND drives the default active section
   *  (a brand-new project lands on Get started; a configured project
   *  lands on API keys, the surface users come back for most). */
  hasGettingStarted?: boolean;
  /** Localised sidebar labels resolved on the server. Keeps this client
   *  component free of cookie reads (no hydration mismatches) and
   *  lets the same component drive both English and Chinese without
   *  branching. */
  t: Dictionary["projects"];
  children: ReactNode;
};

export function ProjectDetailLayout({
  projectName,
  hasGettingStarted = false,
  t,
  children,
}: ProjectDetailLayoutProps) {
  // Sidebar grouping is ordered by usage frequency — high-frequency
  // configuration surfaces (API keys, budgets, routing, alerts) come
  // first because users come back to them every time they tweak a
  // project. Reference surfaces (the live policy view + the one-time
  // setup instructions) live below — they're useful but you don't
  // build a daily habit around opening them. The earlier "Overview"
  // grouping put Setup instructions and Routing policy on top, which
  // wasted the sidebar's most prominent slots on items most users
  // visit < once a month.
  //
  // Get started is rendered above all groups, and only on empty-state
  // projects, so the brand-new flow has a single obvious next step
  // without permanently squatting on the sidebar.
  const groups: SectionGroup[] = useMemo(
    () => [
      {
        group: t.sidebarGroupConfigure,
        items: [
          { id: "api-keys", label: t.sidebarApiKeys },
          { id: "budgets", label: t.sidebarBudgets },
          { id: "routing", label: t.sidebarRouting },
          { id: "alerts", label: t.sidebarAlerts },
          { id: "templates", label: t.sidebarTemplates },
          { id: "tags", label: t.sidebarTags },
        ],
      },
      {
        group: t.sidebarGroupReference,
        items: [
          { id: "policy", label: t.sidebarPolicy },
          { id: "setup", label: t.sidebarSetup },
        ],
      },
    ],
    [t]
  );

  // Get started is special-cased because it only exists when the
  // project is empty AND it's the recommended landing tab in that
  // case. We surface it as a single accent-styled item above the
  // grouped lists so it reads as "do this first" rather than as
  // peer #1 of #6 in the Configure group.
  const gettingStartedItem: SectionItem | null = hasGettingStarted
    ? { id: "getting-started", label: t.sidebarGettingStarted }
    : null;

  const allItems = useMemo(
    () =>
      [
        ...(gettingStartedItem ? [gettingStartedItem] : []),
        ...groups.flatMap((g) => g.items.filter((i) => i.visible !== false)),
      ],
    [groups, gettingStartedItem]
  );
  const allIds = useMemo(() => allItems.map((i) => i.id), [allItems]);
  const defaultSection = hasGettingStarted ? "getting-started" : "api-keys";

  // Active section state lives on the client only — driven by URL hash
  // so reload / share-link preserves it. We hydrate from `null` (not
  // the URL) so SSR markup matches first client render — the actual
  // hash read happens in the effect below.
  const [active, setActive] = useState<string>(defaultSection);
  useEffect(() => {
    const storageKey = `${PROJECT_SECTION_PREFIX}${window.location.pathname}`;

    const sync = () => {
      const hash = window.location.hash.slice(1);
      if (hash && allIds.includes(hash)) {
        setActive(hash);
        try {
          sessionStorage.setItem(storageKey, hash);
        } catch {
          /* ignore blocked sessionStorage */
        }
        return;
      }

      // Locale switches may lose the URL fragment in the browser/Next
      // navigation layer. Recover from a one-shot pending value written
      // by <LanguageToggle>, then fall back to the last section used for
      // this exact project URL. This makes language changes preserve
      // `#setup` even if the reload lands on `/projects/:id`.
      let restored: string | null = null;
      try {
        restored =
          sessionStorage.getItem(PENDING_PROJECT_SECTION_KEY) ??
          sessionStorage.getItem(storageKey);
        sessionStorage.removeItem(PENDING_PROJECT_SECTION_KEY);
      } catch {
        restored = null;
      }

      if (restored && allIds.includes(restored)) {
        setActive(restored);
        window.history.replaceState(null, "", `#${restored}`);
        try {
          sessionStorage.setItem(storageKey, restored);
        } catch {
          /* ignore blocked sessionStorage */
        }
      } else {
        setActive(defaultSection);
      }
    };
    sync();
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, [allIds, defaultSection]);

  const activeLabel =
    allItems.find((i) => i.id === active)?.label ?? t.sidebarMainTitleFallback;

  // Click handler shared by every sidebar link. We update React state
  // directly and then write the hash with History API instead of relying
  // on native fragment navigation. Native anchors race badly with hidden
  // tab panels: the browser tries to jump to a hidden <section>, while
  // React flips visibility a tick later. On brand-new projects (where
  // "Get started" is the default) that produced the visible symptom of
  // Routing rules flashing briefly and then snapping back to the default
  // tab. The URL still gets a shareable hash, and back/forward still
  // works via the hashchange/popstate listeners above.
  const onSidebarClick = (
    event: MouseEvent<HTMLAnchorElement>,
    sectionId: string
  ) => {
    event.preventDefault();
    if (!allIds.includes(sectionId)) return;
    setActive(sectionId);
    if (typeof window !== "undefined") {
      window.history.pushState(null, "", `#${sectionId}`);
      try {
        sessionStorage.setItem(
          `${PROJECT_SECTION_PREFIX}${window.location.pathname}`,
          sectionId
        );
      } catch {
        /* ignore blocked sessionStorage */
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  return (
    <ActiveSectionContext.Provider value={active}>
      <div className="project-shell">
        <aside className="project-sidebar">
          <Link href="/projects" className="project-sidebar-back">
            {t.sidebarBackAll}
          </Link>
          <div className="project-sidebar-name" title={projectName}>
            {projectName}
          </div>
          {/* The sidebar previously surfaced a short-form project uuid
              + copy button + AutoRefresh indicator below the project
              name. Both were removed — they served engineering corner
              cases (support tickets, gateway log correlation, second-
              tick data) that don't apply to typical hosted users, and
              they only added visual noise to the sidebar navigation.
              The full uuid is still available in the URL bar for the
              rare cases where it's needed. */}
          <nav
            className="project-sidebar-nav"
            aria-label={t.sidebarAriaLabel}
            role="tablist"
            aria-orientation="vertical"
          >
            {gettingStartedItem && (
              <div className="project-sidebar-group">
                <a
                  href={`#${gettingStartedItem.id}`}
                  role="tab"
                  className={
                    "project-sidebar-link project-sidebar-link-accent" +
                    (active === gettingStartedItem.id ? " is-active" : "")
                  }
                  aria-selected={active === gettingStartedItem.id}
                  aria-controls={gettingStartedItem.id}
                  onClick={(event) =>
                    onSidebarClick(event, gettingStartedItem.id)
                  }
                >
                  {gettingStartedItem.label}
                </a>
              </div>
            )}
            {groups.map((group) => {
              const visibleItems = group.items.filter(
                (item) => item.visible !== false
              );
              if (visibleItems.length === 0) return null;
              return (
                <div key={group.group} className="project-sidebar-group">
                  <div className="project-sidebar-group-title">{group.group}</div>
                  {visibleItems.map((item) => {
                    const isActive = item.id === active;
                    return (
                      <a
                        key={item.id}
                        href={`#${item.id}`}
                        role="tab"
                        className={
                          "project-sidebar-link" + (isActive ? " is-active" : "")
                        }
                        aria-selected={isActive}
                        aria-controls={item.id}
                        onClick={(event) => onSidebarClick(event, item.id)}
                      >
                        {item.label}
                      </a>
                    );
                  })}
                </div>
              );
            })}
          </nav>
        </aside>
        <main className="project-main">
          {/* The active section's label is the page heading. No project
              name here — that's the sidebar's job. This keeps each
              section's content the visual focus and stops short tabs
              (e.g. a single collapsed Setup instructions card) from
              looking 'orphaned' under a giant project header. */}
          <h1 className="project-main-title">{activeLabel}</h1>
          {children}
        </main>
      </div>
    </ActiveSectionContext.Provider>
  );
}
