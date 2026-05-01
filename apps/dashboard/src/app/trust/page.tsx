import type { Metadata } from "next";
import Link from "next/link";
import { getDocsUrl } from "@/lib/docs-url";
import { fetchGatewayHealth } from "@/lib/gateway-status";
import { getSession, isAuthEnabled } from "@/lib/auth";
import { getDictionary } from "@/lib/i18n.server";
import { SettingsLayout } from "@/components/SettingsLayout";
import type { Dictionary } from "@/i18n/types";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getDictionary();
  return {
    title: t.trust.metaTitle,
    description: t.trust.metaDescription,
  };
}

function statusPill(
  enabled: boolean,
  tTrust: Dictionary["trust"]
): React.ReactElement {
  return (
    <span
      className={enabled ? "pill pill-accent" : "pill pill-neutral"}
      style={{
        color: enabled ? "var(--success)" : "var(--text-muted)",
        fontSize: 11,
      }}
    >
      {enabled ? tTrust.statusEnabled : tTrust.statusNotConfigured}
    </span>
  );
}

export default async function TrustPage(): Promise<React.ReactElement> {
  const gatewayHealth = await fetchGatewayHealth();
  const integrations = gatewayHealth.ok ? gatewayHealth.data.integrations : null;

  // Trust page is dual-purpose: a settings-family page for signed-in users
  // (the same shell as Account & keys / Billing / etc) AND a standalone
  // marketing surface for unauthenticated procurement reviewers. We only
  // wrap with SettingsLayout when there's a session — anonymous visitors
  // shouldn't see a sidebar with links that all redirect to /login.
  const session = isAuthEnabled() ? await getSession() : null;
  const { t } = await getDictionary();
  const tTrust = t.trust;

  // The four "Trust items" cards — built from the dictionary so the
  // titles + bodies localise together with the rest of the page.
  const trustItems: ReadonlyArray<{ title: string; body: string }> = [
    { title: tTrust.items.byoTitle, body: tTrust.items.byoBody },
    { title: tTrust.items.kmsTitle, body: tTrust.items.kmsBody },
    { title: tTrust.items.bodyTitle, body: tTrust.items.bodyBody },
    { title: tTrust.items.selfHostTitle, body: tTrust.items.selfHostBody },
  ];

  const trustBody = (
    <>
      <h1>{tTrust.title}</h1>
      <p className="tagline">{tTrust.tagline}</p>

      <div
        className="card card-accent"
        style={{
          marginBottom: 24,
          borderLeftWidth: 4,
          borderLeftStyle: "solid",
          borderLeftColor: "var(--accent)",
        }}
      >
        <h2>{tTrust.shortVersionTitle}</h2>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: "var(--text-secondary)" }}>
          {tTrust.shortVersionBody}
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: 16,
          marginBottom: 24,
        }}
      >
        {trustItems.map((item) => (
          <div className="card" key={item.title} style={{ marginBottom: 0 }}>
            <h3>{item.title}</h3>
            <p
              style={{
                fontSize: 13,
                color: "var(--text-secondary)",
                lineHeight: 1.55,
                marginBottom: 0,
              }}
            >
              {item.body}
            </p>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-header">
          <h2>{tTrust.liveTitle}</h2>
          <div className="card-header-spacer" />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            {tTrust.liveSubtitle}
          </span>
        </div>
        {!integrations ? (
          <div
            style={{
              padding: 12,
              border: "1px solid var(--warning)",
              borderRadius: 8,
              color: "var(--warning)",
              background: "var(--surface)",
              fontSize: 13,
            }}
          >
            {tTrust.liveGatewayUnreachablePrefix}{" "}
            <code className="code-inline">
              {gatewayHealth.ok ? "" : gatewayHealth.error}
            </code>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{tTrust.liveColControl}</th>
                <th>{tTrust.liveColStatus}</th>
                <th>{tTrust.liveColWhy}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{tTrust.liveByoControl}</td>
                <td>
                  <code className="code-inline">{integrations.crypto.backend}</code>
                </td>
                <td>{tTrust.liveByoWhy}</td>
              </tr>
              <tr>
                <td>{tTrust.liveBodyStorageControl}</td>
                <td>
                  <code className="code-inline">
                    {integrations.request_body_storage?.mode ?? "sample"}
                  </code>
                </td>
                <td>{tTrust.liveBodyStorageWhy}</td>
              </tr>
              <tr>
                <td>{tTrust.liveQualityControl}</td>
                <td>{statusPill(integrations.quality.enabled, tTrust)}</td>
                <td>{tTrust.liveQualityWhy}</td>
              </tr>
              <tr>
                <td>{tTrust.liveReplayControl}</td>
                <td>{statusPill(!!integrations.internal_replay?.enabled, tTrust)}</td>
                <td>{tTrust.liveReplayWhy}</td>
              </tr>
              <tr>
                <td>{tTrust.liveOtelControl}</td>
                <td>{statusPill(integrations.otel.enabled, tTrust)}</td>
                <td>{tTrust.liveOtelWhy}</td>
              </tr>
              <tr>
                <td>{tTrust.liveBaselineControl}</td>
                <td>
                  {integrations.baseline_policy.enabled
                    ? tTrust.liveBaselineBucketsTpl.replace(
                        "{n}",
                        String(integrations.baseline_policy.buckets)
                      )
                    : tTrust.statusDisabled}
                </td>
                <td>{tTrust.liveBaselineWhy}</td>
              </tr>
            </tbody>
          </table>
        )}
        <p
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            lineHeight: 1.55,
            marginTop: 10,
          }}
        >
          {tTrust.liveSettingsPrefix}
          <Link href="/settings" style={{ color: "var(--accent)" }}>
            {tTrust.liveSettingsLink}
          </Link>
          {tTrust.liveSettingsSuffix}
        </p>
      </div>

      <div className="card">
        <div className="card-header">
          <h2>{tTrust.dataTitle}</h2>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>{tTrust.dataColData}</th>
              <th>{tTrust.dataColWhere}</th>
              <th>{tTrust.dataColWhy}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{tTrust.dataPrompt}</td>
              <td>{tTrust.dataPromptWhere}</td>
              <td>{tTrust.dataPromptWhy}</td>
            </tr>
            <tr>
              <td>{tTrust.dataApiKey}</td>
              <td>{tTrust.dataApiKeyWhere}</td>
              <td>{tTrust.dataApiKeyWhy}</td>
            </tr>
            <tr>
              <td>{tTrust.dataByoKey}</td>
              <td>{tTrust.dataByoKeyWhere}</td>
              <td>{tTrust.dataByoKeyWhy}</td>
            </tr>
            <tr>
              <td>{tTrust.dataBilling}</td>
              <td>{tTrust.dataBillingWhere}</td>
              <td>{tTrust.dataBillingWhy}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="card-header">
          <h2>{tTrust.reliabilityTitle}</h2>
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: "var(--text-secondary)" }}>
          {tTrust.reliabilityBody}
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <a
            href={getDocsUrl("SECURITY.md")}
            target="_blank"
            rel="noreferrer"
            className="btn"
          >
            {tTrust.docsSecurity}
          </a>
          <a
            href={getDocsUrl("docs/trust/dpa-template.md")}
            target="_blank"
            rel="noreferrer"
            className="btn"
          >
            {tTrust.docsDpa}
          </a>
          <a
            href={getDocsUrl("docs/trust/sub-processors.md")}
            target="_blank"
            rel="noreferrer"
            className="btn"
          >
            {tTrust.docsSubProcessors}
          </a>
          <a
            href={getDocsUrl("docs/production-runbook.md")}
            target="_blank"
            rel="noreferrer"
            className="btn"
          >
            {tTrust.docsRunbook}
          </a>
          <Link href="/billing" className="btn btn-primary">
            {tTrust.backToBilling}
          </Link>
        </div>
      </div>
    </>
  );

  return session ? (
    <SettingsLayout t={t.nav}>{trustBody}</SettingsLayout>
  ) : (
    <main>{trustBody}</main>
  );
}
