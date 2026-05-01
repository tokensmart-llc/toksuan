import { en } from "@/i18n/en";
import { zhCN } from "@/i18n/zh-CN";
import type { Dictionary } from "@/i18n/types";

/**
 * Locale machinery for the user-facing surface of the dashboard.
 *
 * SAFE FOR BOTH SERVER AND CLIENT — this file MUST NOT import anything
 * from `next/headers` (which is server-only) because Client Components
 * (`LanguageToggle`, etc.) need access to `Locale`, `otherLocale`, and
 * `getDictionaryFor`. The cookie-reading helpers live in
 * `lib/i18n.server.ts` and pull the dictionary out of this module.
 *
 * Scope (deliberately narrow):
 *   - Marketing surfaces, login, dashboard summary, projects, settings,
 *     agents, requests, billing, and emails carry first-class CN copy.
 *   - Deep operator surfaces (admin/hosted, audit detail, organization
 *     SAML, templates, policy/classifier history) intentionally stay
 *     English. They're for engineers who can read the original, and
 *     translating them turns every new feature into a double-write
 *     chore.
 *
 * Persistence:
 *   - First-touch detection via `Accept-Language` is intentionally NOT
 *     implemented. We don't want to flip a returning English user to
 *     Chinese just because they're on a CN-region browser; some teams
 *     have mixed setups. The user picks once via the toggle in the nav,
 *     and the choice is persisted in the `ts_locale` cookie.
 */

export type Locale = "en" | "zh-CN";

export const SUPPORTED_LOCALES: readonly Locale[] = ["en", "zh-CN"] as const;

export const DEFAULT_LOCALE: Locale = "en";

/** Cookie name. Public (not httpOnly) so a future client toggle can read it
 *  without a round-trip; the server is still the source of truth on render. */
export const LOCALE_COOKIE = "ts_locale";

/** Cookie lifetime. One year — the toggle is a "set and forget" preference,
 *  not a session-scoped one. */
export const LOCALE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

/**
 * Synchronous dictionary lookup. Use this when you already have the
 * locale value (e.g. a Client Component received it as a prop). No DB
 * hits, no cookie reads — it's just a map lookup.
 */
export function getDictionaryFor(locale: Locale): Dictionary {
  return locale === "zh-CN" ? zhCN : en;
}

/** Render a label like "中文" / "English" for the OPPOSITE locale, used by
 *  the toggle button to communicate "click to switch to X". */
export function otherLocaleLabel(current: Locale): string {
  return current === "zh-CN" ? "English" : "中文";
}

/** The locale we'd switch INTO when the toggle is clicked. */
export function otherLocale(current: Locale): Locale {
  return current === "zh-CN" ? "en" : "zh-CN";
}
