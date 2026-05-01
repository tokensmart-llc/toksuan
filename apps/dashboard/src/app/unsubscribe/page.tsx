import Link from "next/link";
import { getDictionary } from "@/lib/i18n.server";
import {
  isUnsubscribableList,
  unsubscribeByToken,
  type UnsubscribableList,
} from "@/lib/unsubscribe";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * `/unsubscribe?t=<token>&list=weekly_digest`
 *
 * Public (no auth) — the user comes from an email footer link that
 * might have been clicked months after the session expired. The
 * token itself is the secret, stamped on `users.unsubscribe_token`
 * by `getOrCreateUnsubscribeToken` the first time we mailed this
 * user. Validated by direct DB lookup in `unsubscribeByToken`.
 *
 * The flip happens on the server during render (idempotent UPDATE
 * — if already off, still returns success). We intentionally DO
 * flip on GET despite RFC 9110 frowning on state changes under GET:
 * email clients never issue POST on link clicks, and the "one click
 * unsubscribe" contract RFC 8058 explicitly allows GET semantics
 * here. A /api/unsubscribe POST route covers the List-Unsubscribe-
 * Post header path for mail clients that DO issue POST.
 */
export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string; list?: string }>;
}) {
  const { t: tokenRaw, list: listRaw } = await searchParams;
  const token = (tokenRaw ?? "").trim();
  const listCandidate = (listRaw ?? "weekly_digest").trim();
  const list = isUnsubscribableList(listCandidate)
    ? listCandidate
    : ("weekly_digest" as const);
  const { t } = await getDictionary();
  // Map the internal list key to its localised display label. Today only
  // weekly_digest is unsubscribable; if we add more lists, extend the
  // dictionary `unsubscribe` slice with one key per list.
  const listLabels: Record<UnsubscribableList, string> = {
    weekly_digest: t.unsubscribe.listLabelWeeklyDigest,
  };
  const listLabel = listLabels[list];

  const result =
    token.length > 0
      ? await unsubscribeByToken(token, list).catch(() => ({
          ok: false as const,
        }))
      : ({ ok: false } as const);

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
      <div className="card" style={{ maxWidth: 540, width: "100%" }}>
        {result.ok ? (
          <>
            <h1 style={{ fontSize: 22, marginBottom: 8 }}>
              {t.unsubscribe.titleSuccess}
            </h1>
            <p
              style={{
                fontSize: 13.5,
                color: "var(--text-secondary)",
                lineHeight: 1.6,
                marginBottom: 14,
              }}
            >
              {t.unsubscribe.bodyPrefix}
              <strong>{result.email}</strong>
              {t.unsubscribe.bodyMid}
              <em>{listLabel}</em>
              {t.unsubscribe.bodySuffix}
            </p>
            <p
              style={{
                fontSize: 13.5,
                color: "var(--text-secondary)",
                lineHeight: 1.6,
                marginBottom: 20,
              }}
            >
              {t.unsubscribe.bodyChangedMind}
              <Link href="/settings" style={{ color: "var(--accent)" }}>
                /settings
              </Link>
              .
            </p>
            <Link href="/dashboard" className="btn">
              {t.unsubscribe.backToDashboard}
            </Link>
          </>
        ) : (
          <>
            <h1 style={{ fontSize: 22, marginBottom: 8 }}>
              {t.unsubscribe.titleInvalid}
            </h1>
            <p
              style={{
                fontSize: 13.5,
                color: "var(--text-secondary)",
                lineHeight: 1.6,
                marginBottom: 14,
              }}
            >
              {t.unsubscribe.bodyInvalid}
              <Link href="/settings" style={{ color: "var(--accent)" }}>
                /settings
              </Link>
              .
            </p>
            <Link href="/login" className="btn btn-primary">
              {t.unsubscribe.signIn}
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
