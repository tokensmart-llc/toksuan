"use client";

import { useEffect, useState } from "react";
import type { Dictionary } from "@/i18n/types";

type Theme = "light" | "dark";
const STORAGE_KEY = "tokensmart-theme";

function currentTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return (document.documentElement.dataset.theme as Theme | undefined) ?? "light";
}

export function ThemeToggle({
  t,
}: {
  /** Localised aria-label / tooltip strings. Pages pass `t.themeToggle`
   *  resolved via `getDictionary()`. */
  t: Dictionary["themeToggle"];
}) {
  const [theme, setTheme] = useState<Theme>("light");

  // Mirror whatever the inline <head> script already set.
  useEffect(() => {
    setTheme(currentTheme());
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* localStorage blocked (incognito, etc.) — just don't persist */
    }
  }

  const isDark = theme === "dark";
  const label = isDark ? t.switchToLight : t.switchToDark;

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label={label}
      title={label}
    >
      {isDark ? (
        // Sun (currently dark → click to go light)
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2" />
          <path d="M12 20v2" />
          <path d="m4.93 4.93 1.41 1.41" />
          <path d="m17.66 17.66 1.41 1.41" />
          <path d="M2 12h2" />
          <path d="M20 12h2" />
          <path d="m6.34 17.66-1.41 1.41" />
          <path d="m19.07 4.93-1.41 1.41" />
        </svg>
      ) : (
        // Moon (currently light → click to go dark)
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}

/**
 * Inline `<script>` body. Runs before React hydrates so the theme token
 * values are applied before first paint (no flash). Reads
 * `localStorage['tokensmart-theme']` first. If the user hasn't explicitly
 * chosen a theme, default to the product's daylight palette instead of
 * following OS auto-dark (which made language switches turn "evening"
 * colored when macOS crossed into dark mode).
 */
export const themeBootScript = `
(function () {
  try {
    var stored = localStorage.getItem(${JSON.stringify(STORAGE_KEY)});
    var theme = stored === 'light' || stored === 'dark' ? stored : 'light';
    document.documentElement.dataset.theme = theme;
  } catch (_) {
    document.documentElement.dataset.theme = 'light';
  }
})();
`;
