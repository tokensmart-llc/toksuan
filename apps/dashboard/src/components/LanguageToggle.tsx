"use client";

import { useTransition, type MouseEvent } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { setLocaleAction } from "@/app/actions/locale";
import {
  getDictionaryFor,
  otherLocale,
  otherLocaleLabel,
  type Locale,
} from "@/lib/i18n";

const PENDING_PROJECT_SECTION_KEY = "tokensmart:pending-project-section";

type LanguageToggleProps = {
  /** Current locale resolved on the server. We never read the cookie
   *  on the client to avoid hydration mismatches — the parent is
   *  responsible for passing the resolved value. */
  locale: Locale;
  /** Visual variant. `nav` matches `.app-nav-link` (signed-in chrome).
   *  `landing` is the slightly bigger marketing-style link used in the
   *  public landing nav strip. Same className today; the prop exists
   *  so we can diverge later without touching every call site. */
  variant?: "nav" | "landing";
};

/**
 * Single-action toggle: clicking it switches to the OPPOSITE locale and
 * keeps the user on the same page — including the URL fragment, so a
 * tabbed view such as `/projects/abc#setup` stays on Setup instructions
 * rather than snapping back to the project's default tab.
 *
 * Implementation notes:
 *
 *   - Wrapped in a real `<form action={setLocaleAction}>` so the toggle
 *     still works without JavaScript (progressive enhancement). The
 *     no-JS path uses the server action's normal `redirect()` and loses
 *     the fragment, but keeps the locale switch functional.
 *
 *   - When JS is on we intercept the click, call the action with
 *     `no_redirect=1` (which sets the cookie + DB mirror but doesn't
 *     redirect), then trigger `window.location.reload()`. The browser
 *     reload is what preserves the current URL fragment — Next's RSC
 *     client strips fragments during a server-action redirect, which
 *     is why we cannot rely on `redirect()` for the JS path.
 */
export function LanguageToggle({
  locale,
  variant = "nav",
}: LanguageToggleProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  // Used by the no-JS form fallback only. The JS path reads the live
  // `window.location` at click time, which already includes the hash.
  const search = searchParams.toString();
  const noJsRedirect = search ? `${pathname}?${search}` : pathname;

  const target = otherLocale(locale);
  const label = otherLocaleLabel(locale);
  const className = variant === "landing" ? "app-nav-link" : "app-nav-link";
  // Pull the LIVE locale's dictionary so the aria-label is in the
  // language the user is currently reading (it announces the switch).
  const t = getDictionaryFor(locale).languageToggle;
  const ariaLabel = t.switchToTpl.replace("{label}", label);

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    if (typeof window === "undefined") return;
    // Stop the form from also submitting via React's `<form action>`
    // path — the JS flow below replaces it.
    event.preventDefault();

    // Project detail tabs are hash/ARIA controlled. In some Next/browser
    // paths the fragment is lost across the locale switch, so persist the
    // currently selected tab as a one-shot fallback that
    // <ProjectDetailLayout> consumes after reload.
    try {
      const selectedProjectTab = document.querySelector<HTMLElement>(
        ".project-sidebar-nav [role='tab'][aria-selected='true']"
      );
      const section =
        selectedProjectTab?.getAttribute("aria-controls") ??
        window.location.hash.slice(1);
      if (section) sessionStorage.setItem(PENDING_PROJECT_SECTION_KEY, section);
    } catch {
      /* ignore blocked sessionStorage */
    }

    const fd = new FormData();
    fd.set("locale", target);
    fd.set("redirect", noJsRedirect);
    fd.set("no_redirect", "1");

    startTransition(async () => {
      try {
        await setLocaleAction(fd);
      } catch {
        /* Network failures fall through to the reload — the cookie may
           not have been set, but the user can simply click again. */
      }
      // Full reload preserves the current URL (path + query + hash)
      // and forces the server to render the new locale's RSC tree
      // plus the html `lang` attribute.
      window.location.reload();
    });
  }

  return (
    <form action={setLocaleAction} style={{ display: "inline-flex" }}>
      <input type="hidden" name="locale" value={target} />
      <input type="hidden" name="redirect" value={noJsRedirect} />
      <button
        type="submit"
        className={className}
        aria-label={ariaLabel}
        onClick={handleClick}
        disabled={isPending}
        style={{
          background: "transparent",
          border: "none",
          padding: "4px 0",
          cursor: "pointer",
          font: "inherit",
        }}
      >
        {label}
      </button>
    </form>
  );
}
