import { cookies } from "next/headers";
import type { Dictionary } from "@/i18n/types";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  getDictionaryFor,
  isLocale,
  type Locale,
} from "./i18n";

/**
 * Server-only side of the i18n machinery. Lives in its own file because
 * `next/headers` is forbidden in Client Component bundles — pulling it
 * into `lib/i18n.ts` (shared by `<LanguageToggle>`) would refuse to
 * compile with "You're importing a component that needs next/headers".
 *
 * Next.js still enforces the server-only boundary via `next/headers`
 * itself: any accidental client-side import of this file fails with
 * the same compile-time error you'd get from importing `cookies()`
 * directly.
 */

/**
 * Read the current locale from the request cookie. Returns
 * `DEFAULT_LOCALE` for unauthenticated visitors who haven't set the
 * toggle yet.
 */
export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  const raw = store.get(LOCALE_COOKIE)?.value;
  return isLocale(raw) ? raw : DEFAULT_LOCALE;
}

/**
 * Server-component convenience: fetch the locale AND its dictionary in
 * one `await`. Use this in every page-level Server Component:
 *
 * ```ts
 * const { locale, t } = await getDictionary();
 * return <h1>{t.dashboard.heroTitle}</h1>;
 * ```
 */
export async function getDictionary(): Promise<{
  locale: Locale;
  t: Dictionary;
}> {
  const locale = await getLocale();
  return { locale, t: getDictionaryFor(locale) };
}
