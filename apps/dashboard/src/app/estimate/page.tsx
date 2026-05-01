import type { Metadata } from "next";
import Link from "next/link";
import { getSession, isAuthEnabled } from "@/lib/auth";
import { getDictionary } from "@/lib/i18n.server";
import { SavingsEstimator } from "@/components/SavingsEstimator";

// Locale-aware metadata: the layout's `title.template` wraps the
// per-page title with "· TokSuan" automatically. The OG/Twitter cards
// follow the same locale because Next.js calls `generateMetadata` per
// request, with the same cookie-derived locale that the page render
// uses.
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getDictionary();
  const description = t.estimate.metaDescription;
  const ogTitle = t.estimate.title;
  return {
    title: t.estimate.metaTitle,
    description,
    openGraph: {
      title: ogTitle,
      description,
      url: "/estimate",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: ogTitle,
      description,
    },
  };
}

export const dynamic = "force-dynamic";

export default async function EstimatePage(): Promise<React.ReactElement> {
  // Anonymous visitors — the public marketing path — don't see the
  // global AppNav (it only renders for signed-in users), and previously
  // had no in-page nav either. Drop a single "← Home" link so they can
  // get back to the landing page without using browser back. Signed-in
  // users already have AppNav above and don't need this.
  const session = isAuthEnabled() ? await getSession() : null;
  const { t } = await getDictionary();

  return (
    <main>
      {!session && (
        <Link href="/" className="back-link">
          {t.common.backHome}
        </Link>
      )}
      <h1>{t.estimate.title}</h1>
      <p className="tagline">{t.estimate.subtitle}</p>

      <SavingsEstimator t={t.estimator} />
    </main>
  );
}
