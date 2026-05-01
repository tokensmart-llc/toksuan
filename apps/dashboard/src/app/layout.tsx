import type { Metadata } from "next";
import { getSession, isAuthEnabled } from "@/lib/auth";
import { getDictionary } from "@/lib/i18n.server";
import { getDocsHomeUrl } from "@/lib/docs-url";
import { AppNav } from "@/components/AppNav";
import { AppFooter } from "@/components/AppFooter";
import { ToastHost } from "@/components/ToastHost";
import { themeBootScript } from "@/components/ThemeToggle";
import "./globals.css";

/**
 * Default OG / Twitter metadata. Overridable per-page via route-level
 * `export const metadata` — `/estimate` does this to put a workload-
 * specific headline on the social card.
 *
 * `metadataBase` drives the absolute URL used for the OG image; set
 * `NEXT_PUBLIC_BASE_URL` on hosted deploys so shared links show a
 * preview on X / LinkedIn / Reddit / Slack / Discord unfurls.
 */
const BRAND_DESCRIPTION =
  "Change one base_url so your agent bill becomes visible, capped, and " +
  "automatically cheaper when the per-request receipt proves the trade worked. " +
  "AI spend control plane for text, vision, and tool-using agents.";

function metadataBaseOrigin(): URL {
  const raw = process.env.NEXT_PUBLIC_BASE_URL?.trim();
  try {
    return new URL(raw && raw.length > 0 ? raw : "http://localhost:3000");
  } catch {
    return new URL("http://localhost:3000");
  }
}

export const metadata: Metadata = {
  metadataBase: metadataBaseOrigin(),
  title: {
    default: "TokSuan — Spend control and routing for AI agents",
    template: "%s · TokSuan",
  },
  description: BRAND_DESCRIPTION,
  applicationName: "TokSuan",
  openGraph: {
    type: "website",
    siteName: "TokSuan",
    title: "TokSuan — Spend control and routing for AI agents",
    description: BRAND_DESCRIPTION,
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: "TokSuan — Spend control and routing for AI agents",
    description: BRAND_DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = isAuthEnabled() ? await getSession() : null;
  // Resolve the user's locale once at the layout level so every server
  // component below sees the same dictionary AND so the html `lang`
  // attribute matches what we actually render. Marketing pages also
  // call `getDictionary()` themselves; React de-dupes the cookie read
  // because both calls land in the same request.
  const { locale, t } = await getDictionary();
  // The `<html lang>` value follows the locale so screen readers,
  // browser translation prompts, and Lighthouse all classify the page
  // correctly. We map our internal locale codes to BCP-47 tags here
  // (today both happen to coincide; this stays explicit for clarity).
  const htmlLang = locale === "zh-CN" ? "zh-CN" : "en";

  return (
    <html lang={htmlLang} data-theme="light" suppressHydrationWarning>
      <head>
        {/* Sets data-theme BEFORE React paints so explicit user theme
         *  choices survive full reloads (including language switches). */}
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      {/*
       * `suppressHydrationWarning` on <body> because browser password
       * managers (LastPass, 1Password, Bitwarden) inject extra DOM
       * (e.g. `<div data-lastpass-icon-root>`) BEFORE React hydrates,
       * which otherwise shows a dev-only "Hydration failed" overlay
       * on every page load for users with those extensions. Our own
       * code never server-renders different content than client —
       * this prop only silences the extension-injected diff.
       * https://github.com/vercel/next.js/discussions/52197
       */}
      <body suppressHydrationWarning>
        {session && (
          <AppNav
            email={session.user.email}
            docsHomeUrl={getDocsHomeUrl()}
            locale={locale}
            t={t.nav}
            tTheme={t.themeToggle}
          />
        )}
        {children}
        {session && (
          <AppFooter docsHomeUrl={getDocsHomeUrl()} t={t.nav} />
        )}
        <ToastHost />
      </body>
    </html>
  );
}
