"use client";

import Link from "next/link";
import { useEffect, useMemo } from "react";
import { en } from "@/i18n/en";
import { zhCN } from "@/i18n/zh-CN";

/**
 * Root error boundary. Replaces Next.js's default "Application error"
 * white page with a branded message. The digest is the server-side
 * error hash from the Next.js stack — we surface it so a user emailing
 * support can quote it and we can grep server logs directly.
 *
 * `reset` is Next's way of re-mounting the subtree that threw; it
 * retries the most recent navigation, which is the right fix for
 * ~90% of transient failures (stale RSC cache, DB blipped, etc.).
 *
 * Locale handling: this component is client-side and the server can't
 * pass props to it, so we read `<html lang>` (set by `app/layout.tsx`
 * from the cookie) to pick the right dictionary slice. Falls back to
 * English when the lang attribute is absent or unrecognised — safe
 * because the error page is rendered as a last-ditch fallback anyway.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Shows up in the browser console for anyone with devtools open.
    // The server side logs the full stack separately.
    console.error("[tokensmart] dashboard route error:", error);
  }, [error]);

  const t = useMemo(() => {
    if (typeof document === "undefined") return en.errorBoundary;
    const lang = document.documentElement.lang;
    return lang === "zh-CN" ? zhCN.errorBoundary : en.errorBoundary;
  }, []);

  return (
    <main
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "60vh",
        padding: 24,
      }}
    >
      <div className="card" style={{ maxWidth: 520, width: "100%" }}>
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>{t.title}</h1>
        <p
          style={{
            fontSize: 13,
            color: "var(--text-secondary)",
            lineHeight: 1.55,
            marginBottom: 14,
          }}
        >
          {t.bodyPrefix}
          <a
            href="https://github.com/tokensmart-llc/toksuan/issues/new/choose"
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--accent)" }}
          >
            {t.bodyLink}
          </a>
          {t.bodySuffix}
        </p>
        {error.digest && (
          <pre
            className="code-block"
            style={{ fontSize: 11, marginBottom: 14 }}
          >
            {t.digestLabel} {error.digest}
          </pre>
        )}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={reset}
            className="btn btn-primary"
          >
            {t.retryBtn}
          </button>
          <Link href="/dashboard" className="btn">
            {t.backBtn}
          </Link>
        </div>
      </div>
    </main>
  );
}
