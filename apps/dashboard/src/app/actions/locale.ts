"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  isLocale,
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE_SECONDS,
} from "@/lib/i18n";
import { getSession, isAuthEnabled } from "@/lib/auth";
import { setUserPreferredLocale } from "@/lib/db";

/**
 * Server action invoked by `<LanguageToggle>` (and the public landing
 * nav for anonymous visitors). Writes the locale cookie and bounces the
 * user back to the page they were on. Centralised so every entry point
 * uses the same cookie attributes — locale switches that disagree on
 * `path` end up creating ghost cookies that never get read.
 *
 * Form-action shape: reads `locale` and `redirect` from the FormData so
 * the toggle works without JavaScript on the page (progressive
 * enhancement — a `<form action={setLocaleAction}>` plus two hidden
 * inputs is enough; client transitions are an enhancement only).
 *
 * `no_redirect=1` opts out of the server-side redirect. The JS toggle
 * sets this flag because Next's RSC navigation drops the URL fragment
 * during a server-action redirect — we need a full browser reload to
 * keep the user on `/projects/abc#setup` instead of dropping them on
 * the project's default tab. The action still sets the cookie + DB
 * mirror in the same call; the client just does its own navigation.
 *
 * Safety:
 *   - The locale value is validated against `SUPPORTED_LOCALES`. Any
 *     unknown value is rejected silently (we still redirect so the
 *     caller doesn't sit on a blank page).
 *   - `redirectTo` is sanitised to a relative path with a leading `/`.
 *     Open-redirect attempts (`https://evil.example`, protocol-relative
 *     `//evil`) are dropped to "/" so we can't be tricked into bouncing
 *     a logged-in user off-domain.
 *
 * DB persistence:
 *   - For logged-in users we ALSO mirror the cookie into
 *     `users.preferred_locale` (migration 033) so cron-driven email
 *     sends — which have no cookie context — pick the right language.
 *     Best-effort: a DB error never blocks the locale switch (we just
 *     log; the cookie still wins for the current browser session).
 */
export async function setLocaleAction(formData: FormData): Promise<void> {
  const locale = String(formData.get("locale") ?? "");
  const redirectTo = String(formData.get("redirect") ?? "/");
  const noRedirect = formData.get("no_redirect") === "1";

  if (isLocale(locale)) {
    const store = await cookies();
    store.set(LOCALE_COOKIE, locale, {
      httpOnly: false,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: LOCALE_COOKIE_MAX_AGE_SECONDS,
    });

    // Mirror to DB for logged-in users so email cron sees the same value.
    if (isAuthEnabled()) {
      try {
        const session = await getSession();
        if (session) {
          await setUserPreferredLocale(session.user.id, locale);
        }
      } catch (err) {
        console.warn(
          "[tokensmart-i18n] failed to persist preferred_locale:",
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  // The JS toggle handles its own navigation via `window.location.reload`
  // so the URL fragment (e.g. `/projects/abc#setup`) is preserved across
  // the locale change. Server-action `redirect()` would otherwise route
  // through Next's RSC client which strips the fragment.
  if (noRedirect) return;

  redirect(safeRedirect(redirectTo));
}

function safeRedirect(target: string | undefined | null): string {
  if (!target) return "/";
  const t = target.trim();
  if (t.length === 0) return "/";
  // Reject absolute URLs and protocol-relative URLs.
  if (/^[a-z][a-z0-9+\-.]*:/i.test(t)) return "/";
  if (t.startsWith("//")) return "/";
  // Require leading slash so we always stay on-origin.
  return t.startsWith("/") ? t : `/${t}`;
}
