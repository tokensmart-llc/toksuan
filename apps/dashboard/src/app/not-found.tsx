import Link from "next/link";
import { getDictionary } from "@/lib/i18n.server";

/**
 * 404 page — triggered by `notFound()` from a server component OR by
 * navigating to a route the App Router can't match. Keep it branded
 * and short; the Next.js default is a generic white "This page could
 * not be found" line that reads broken.
 */
export default async function NotFound() {
  const { t } = await getDictionary();
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
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>{t.errors.notFoundTitle}</h1>
        <p
          style={{
            fontSize: 13,
            color: "var(--text-secondary)",
            lineHeight: 1.55,
            marginBottom: 14,
          }}
        >
          {t.errors.notFoundBodyPrefix}
          <a
            href="https://github.com/tokensmart-llc/toksuan/issues/new/choose"
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--accent)" }}
          >
            {t.errors.notFoundBodyLink}
          </a>
          {t.errors.notFoundBodySuffix}
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Link href="/dashboard" className="btn btn-primary">
            {t.errors.notFoundBackBtn}
          </Link>
          <Link href="/estimate" className="btn">
            {t.errors.notFoundEstimatorBtn}
          </Link>
        </div>
      </div>
    </main>
  );
}
