import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, isAuthEnabled } from "@/lib/auth";
import {
  getProviderUsageForUser,
  getWeeklyDigestPrefs,
  listCustomProvidersForUser,
  listProviderKeysForUser,
  listTopModelRejections,
  SUPPORTED_PROVIDERS,
  type CustomProviderRow,
  type ModelRejectionRow,
  type ProviderUsageSummary,
  type UserProviderKeyRow,
  type WeeklyDigestPrefs,
} from "@/lib/db";
import { isProviderKeyEncryptionConfigured } from "@/lib/crypto";
import { emailDomainWarning, isEmailConfigured } from "@/lib/email";
import {
  fetchGatewayHealth,
  type FetchResult,
  type IntegrationsSnapshot,
} from "@/lib/gateway-status";
import { isHostedMode, nextWeeklyDigestSendUtc } from "@/lib/mode";
import {
  consumeProviderKeyTestResults,
  deleteCustomProviderAction,
  deleteProviderKeyAction,
  setCustomProviderAction,
  setProviderKeyAction,
  setWeeklyDigestAction,
  testProviderKeyAction,
  toggleCustomProviderEnabledAction,
} from "./actions";
import {
  cancelAccountDeletionAction,
  markAccountForDeletionAction,
} from "./data-actions";
import { SettingsLayout } from "@/components/SettingsLayout";
import { CopyButton } from "@/components/CopyButton";
import { getDictionary } from "@/lib/i18n.server";
import type { Dictionary } from "@/i18n/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function fmtTime(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(d));
}

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
  deepseek: "DeepSeek",
  qwen: "Qwen (Dashscope)",
  doubao: "Doubao (Volcengine Ark)",
};

const ANON_TELEMETRY_CRON = `# Send yesterday's anonymous aggregate once per day.
# This never sends prompts, responses, API keys, emails, project names, or request IDs.
cd /path/to/toksuan/apps/gateway && \\
TOKENSMART_ANON_TELEMETRY=1 \\
TOKENSMART_ANON_TELEMETRY_DEPLOYMENT_ID=replace-with-random-local-id \\
  bun run send-anon-telemetry -- --yesterday`;

type GatewayAnonTelemetrySnapshot = NonNullable<
  IntegrationsSnapshot["anon_telemetry"]
>;

function SelfHostTelemetryCard({
  telemetry,
  t,
  tCopy,
}: {
  telemetry: GatewayAnonTelemetrySnapshot | null;
  t: Dictionary["settingsPage"];
  tCopy: Dictionary["copyButton"];
}) {
  const endpointHost = telemetry?.endpoint_host ?? "tokensmt.com";
  const enabled = telemetry?.enabled === true;

  return (
    <div className="card card-accent">
      <div className="card-header">
        <h2>{t.sectionTelemetryTitle}</h2>
        <div className="card-header-spacer" />
        <span
          className={enabled ? "pill pill-success" : "pill pill-neutral"}
          style={{ fontSize: 11 }}
        >
          {telemetry == null
            ? t.sectionTelemetryStatusUnknown
            : enabled
              ? t.sectionTelemetryStatusOn
              : t.sectionTelemetryStatusOff}
        </span>
      </div>
      <p
        style={{
          fontSize: 13,
          color: "var(--text-secondary)",
          lineHeight: 1.6,
          marginTop: 0,
        }}
      >
        {t.sectionTelemetryBody}
      </p>
      <div className="anon-telemetry-grid">
        <div>
          <h3>{t.sectionTelemetryWhatSent}</h3>
          <ul>
            <li>{t.sectionTelemetryWhatSentItem1}</li>
            <li>{t.sectionTelemetryWhatSentItem2}</li>
            <li>{t.sectionTelemetryWhatSentItem3}</li>
            <li>{t.sectionTelemetryWhatSentItem4}</li>
          </ul>
        </div>
        <div>
          <h3>{t.sectionTelemetryNeverSent}</h3>
          <ul>
            <li>{t.sectionTelemetryNeverSentItem1}</li>
            <li>{t.sectionTelemetryNeverSentItem2}</li>
            <li>{t.sectionTelemetryNeverSentItem3}</li>
            <li>{t.sectionTelemetryNeverSentItem4}</li>
          </ul>
        </div>
      </div>
      <div
        style={{
          display: "grid",
          gap: 8,
          marginTop: 14,
          fontSize: 12,
          color: "var(--text-muted)",
        }}
      >
        <div>
          {t.sectionTelemetryEndpointPrefix}{" "}
          <code className="code-inline">{endpointHost}</code>
          {telemetry && (
            <>
              {" · "}
              {t.sectionTelemetryThresholds}
            </>
          )}
        </div>
        <div>
          {t.sectionTelemetryDryRunHint}
          <pre className="code-block" style={{ marginTop: 8 }}>
            cd /path/to/toksuan/apps/gateway &amp;&amp;{"\n"}
            TOKENSMART_ANON_TELEMETRY_DEPLOYMENT_ID=replace-with-random-local-id{" \\\n"}
            bun run send-anon-telemetry -- --yesterday --dry-run
          </pre>
        </div>
        <div>
          {t.sectionTelemetryCronHint}
          <div style={{ marginTop: 8 }}>
            <CopyButton
              value={ANON_TELEMETRY_CRON}
              display={t.sectionTelemetryCopyCron}
              compact
              t={tCopy}
            />
          </div>
          <pre className="code-block" style={{ marginTop: 8 }}>
            {ANON_TELEMETRY_CRON}
          </pre>
        </div>
      </div>
    </div>
  );
}

function HostedTelemetryInfoCard({
  t,
}: {
  t: Dictionary["settingsPage"];
}) {
  return (
    <div className="card card-accent">
      <div className="card-header">
        <h2>{t.hostedTelemetryTitle}</h2>
        <div className="card-header-spacer" />
        <span className="pill pill-success" style={{ fontSize: 11 }}>
          {t.hostedTelemetryPill}
        </span>
      </div>
      <p
        style={{
          fontSize: 13,
          color: "var(--text-secondary)",
          lineHeight: 1.6,
          marginTop: 0,
        }}
      >
        {t.hostedTelemetryBody}
      </p>
      <div className="anon-telemetry-grid">
        <div>
          <h3>{t.hostedTelemetryWhat}</h3>
          <ul>
            <li>{t.hostedTelemetryWhat1}</li>
            <li>{t.hostedTelemetryWhat2}</li>
            <li>{t.hostedTelemetryWhat3}</li>
            <li>{t.hostedTelemetryWhat4}</li>
          </ul>
        </div>
        <div>
          <h3>{t.hostedTelemetryHow}</h3>
          <ul>
            <li>{t.hostedTelemetryHow1}</li>
            <li>{t.hostedTelemetryHow2}</li>
            <li>{t.hostedTelemetryHow3}</li>
            <li>{t.hostedTelemetryHow4}</li>
          </ul>
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        <Link href="/state-of-agent-spend" className="btn btn-sm">
          {t.hostedTelemetryViewProof}
        </Link>
      </div>
    </div>
  );
}

export default async function SettingsPage() {
  if (!isAuthEnabled()) redirect("/");
  const session = await getSession();
  if (!session) redirect("/login");

  const encryptionReady = isProviderKeyEncryptionConfigured();
  let keys: UserProviderKeyRow[] = [];
  let customProviders: CustomProviderRow[] = [];
  let rejections: ModelRejectionRow[] = [];
  let usage: ProviderUsageSummary[] = [];
  let digestPrefs: WeeklyDigestPrefs = { enabled: false, last_sent_at: null };
  let dbError: string | null = null;
  try {
    [keys, customProviders, rejections, usage, digestPrefs] = await Promise.all([
      listProviderKeysForUser(session.user.id),
      listCustomProvidersForUser(session.user.id),
      listTopModelRejections({ sinceDays: 7, limit: 10 }),
      getProviderUsageForUser(session.user.id, 24 * 30),
      getWeeklyDigestPrefs(session.user.id),
    ]);
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  // Gateway integrations status — separate fetch so a gateway-down doesn't
  // take out the BYO-keys flow on this page.
  const gatewayHealth: FetchResult = await fetchGatewayHealth();

  const haveByProvider = new Map(keys.map((k) => [k.provider, k]));
  const usageByProvider = new Map(usage.map((u) => [u.provider, u]));
  const testResults = await consumeProviderKeyTestResults();
  const MICRO_PER_USD = 100_000;
  const fmtUsd = (mc: number) => `$${(mc / MICRO_PER_USD).toFixed(4)}`;
  const fmtRel = (d: Date | null): string | null => {
    if (!d) return null;
    const ms = Date.now() - new Date(d).getTime();
    const m = Math.round(ms / 60_000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  };

  // Pending-deletion countdown — non-null when the user has clicked
  // "Delete my account" but is still within the 30d grace window.
  const deletionScheduledAt = session.user.deleted_at
    ? new Date(session.user.deleted_at)
    : null;
  const deletionHardAt = deletionScheduledAt
    ? new Date(deletionScheduledAt.getTime() + 30 * 24 * 60 * 60 * 1000)
    : null;
  const daysUntilHardDelete =
    deletionHardAt != null
      ? Math.max(
          0,
          Math.ceil((deletionHardAt.getTime() - Date.now()) / 86_400_000)
        )
      : null;

  const { t } = await getDictionary();

  return (
    <SettingsLayout t={t.nav}>
      <h1>{t.settings.title}</h1>
      <p className="tagline">{t.settings.tagline}</p>

      {deletionScheduledAt && deletionHardAt && (
        <div className="card card-danger" style={{ marginBottom: 24 }}>
          <h3 style={{ color: "var(--danger)" }}>
            {t.settingsPage.deletionScheduledTitle}
          </h3>
          <div
            style={{
              fontSize: 13,
              color: "var(--text-secondary)",
              lineHeight: 1.6,
              marginTop: 6,
            }}
          >
            {t.settingsPage.deletionScheduledBodyPrefix}
            {fmtTime(deletionScheduledAt)}
            {t.settingsPage.deletionScheduledBodyMid}
            <strong>{fmtTime(deletionHardAt)}</strong>{" "}
            (<strong>
              {daysUntilHardDelete}
              {daysUntilHardDelete === 1
                ? t.settingsPage.deletionScheduledBodyDay
                : t.settingsPage.deletionScheduledBodyDays}
            </strong>
            {t.settingsPage.deletionScheduledBodySuffix}
          </div>
          <form
            action={cancelAccountDeletionAction}
            style={{ marginTop: 12 }}
          >
            <button type="submit" className="btn btn-primary btn-sm">
              {t.settingsPage.deletionCancelBtn}
            </button>
          </form>
        </div>
      )}

      {/* Self-host / OSS operator gets the actionable 'paste this env var'
          warning. Hosted tenants can't fix this from their side (it'd mean
          the platform operator's KMS is misconfigured — already surfaced
          on /health and to on-call), so we suppress the banner in hosted
          mode rather than hand a customer a command they can't run. */}
      {!encryptionReady && !isHostedMode() && (
        <div className="card card-warning">
          <h3 style={{ color: "var(--warning)" }}>
            Encryption key not configured
          </h3>
          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            BYO provider keys require{" "}
            <code className="code-inline">TOKENSMART_PROVIDER_KEY_ENCRYPTION</code>{" "}
            to be set on BOTH the dashboard and gateway processes (same value
            in both). Generate with:
          </div>
          <pre className="code-block" style={{ marginTop: 10 }}>
            openssl rand -hex 32
          </pre>
        </div>
      )}

      {/* Email-deliverability footgun: RESEND_API_KEY is set but RESEND_FROM
          is on the unverified shared resend.dev domain. Self-hosters who
          configure Resend without verifying their own domain see signup
          OTPs land in Spam. Hide in hosted mode for the same reason as
          the encryption banner above (operator-fix-only). */}
      {!isHostedMode() && isEmailConfigured() &&
        (() => {
          const warn = emailDomainWarning();
          if (!warn) return null;
          return (
            <div className="card card-warning">
              <h3 style={{ color: "var(--warning)" }}>
                Email sender domain not verified
              </h3>
              <div
                style={{
                  fontSize: 13,
                  color: "var(--text-secondary)",
                  lineHeight: 1.55,
                }}
              >
                {warn}
              </div>
              <pre className="code-block" style={{ marginTop: 10 }}>
                {`RESEND_FROM=TokSuan <login@your-verified-domain>`}
              </pre>
            </div>
          );
        })()}

      {dbError && (
        <div className="card card-danger">
          <strong>Database not reachable.</strong>
          <br />
          <span style={{ color: "var(--text-muted)" }}>{dbError}</span>
        </div>
      )}

      {isHostedMode() ? (
        <HostedTelemetryInfoCard t={t.settingsPage} />
      ) : (
        <SelfHostTelemetryCard
          telemetry={
            gatewayHealth.ok
              ? (gatewayHealth.data.integrations.anon_telemetry ?? null)
              : null
          }
          t={t.settingsPage}
          tCopy={t.copyButton}
        />
      )}

      {/* (Form moved BELOW "Your provider keys" — typical SaaS pattern is
          "see what you have first, then add new". Form follows.) */}

      {/* Existing keys.
          `id="provider-keys"` is the anchor target for in-app deep
          links from /dashboard, /projects, etc. (`/settings#provider-
          keys`) AND for the post-save redirect in `setProviderKeyAction`.
          Without this id the anchor was a no-op and browsers landed
          at the top of the long /settings page after every save —
          users with one key already in the table couldn't find the
          form below it without scrolling, which is the "where do I
          add another?" UX bug. */}
      <div id="provider-keys" className="card">
        <div className="card-header">
          <h2>{t.settingsPage.yourProviderKeysTitle}</h2>
          <div className="card-header-spacer" />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            {t.settingsPage.yourProviderKeysCount.replace(
              "{n}",
              String(keys.length)
            )}
          </span>
          {/* Discoverable entry point to the form below, so users who
              already have at least one key don't have to scan the page
              for "where do I add another?". The link jumps to the
              accent-bordered form card; it's a plain anchor (not a
              router-Link) because the target lives on the same page. */}
          {keys.length > 0 && (
            <a
              href="#add-provider-key"
              className="btn btn-sm btn-primary"
              style={{
                marginLeft: 12,
                textDecoration: "none",
                fontSize: 12,
              }}
            >
              {t.settingsPage.yourProviderKeysAddAnother}
            </a>
          )}
        </div>

        {keys.length === 0 ? (
          <div
            style={{
              padding: "20px 16px",
              fontSize: 13,
              color: "var(--text-secondary)",
              lineHeight: 1.55,
            }}
          >
            <div style={{ marginBottom: 6 }}>
              <strong>{t.settingsPage.providerKeysNoneTitle}</strong>{" "}
              {t.settingsPage.providerKeysNoneBody1}
            </div>
            <div style={{ marginBottom: 6 }}>
              {t.settingsPage.providerKeysNoneBody2}
            </div>
            <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
              {t.settingsPage.providerKeysNoneHint}
            </div>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.settingsPage.providerColProvider}</th>
                <th>{t.settingsPage.providerColKey}</th>
                <th>{t.settingsPage.providerColUsage30d}</th>
                <th>{t.settingsPage.providerColHealth}</th>
                <th>{t.settingsPage.providerColUpdated}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const u = usageByProvider.get(k.provider);
                const test = testResults[k.id];
                const lastUsedRel = u ? fmtRel(u.last_used_at) : null;
                const lastErrorRel = u ? fmtRel(u.last_error_at) : null;
                return (
                  <tr key={k.id}>
                    <td>
                      <span className="pill pill-accent">
                        {PROVIDER_LABELS[k.provider] ?? k.provider}
                      </span>
                      {k.base_url && (
                        <div
                          className="muted"
                          style={{ fontSize: 10, marginTop: 2 }}
                          title={k.base_url}
                        >
                          base_url override
                        </div>
                      )}
                    </td>
                    <td>
                      <code className="code-inline" title={t.settingsPage.apiKeyHashedAtRestTooltip}>
                        …{k.key_last4}
                      </code>
                      <div
                        className="muted"
                        style={{ fontSize: 10, marginTop: 2 }}
                        title={`master key fp: ${k.master_key_fingerprint ?? "legacy"}`}
                      >
                        {k.master_key_fingerprint ? (
                          <code className="code-inline">
                            {k.master_key_fingerprint.slice(0, 14)}…
                          </code>
                        ) : (
                          <span style={{ color: "var(--text-muted)" }}>
                            legacy fp
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      {u && u.request_count > 0 ? (
                        <>
                          <div
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontSize: 13,
                            }}
                          >
                            {fmtUsd(u.total_cost_micro_cents)}
                          </div>
                          <div
                            className="muted"
                            style={{ fontSize: 10, marginTop: 2 }}
                          >
                            {u.request_count.toLocaleString()}
                            {u.request_count === 1
                              ? t.settingsPage.providerUsageReqSingular
                              : t.settingsPage.providerUsageReqPlural}
                          </div>
                        </>
                      ) : (
                        <span style={{ color: "var(--text-muted)" }}>
                          {t.settingsPage.providerHealthNoTraffic}
                        </span>
                      )}
                    </td>
                    <td>
                      {test ? (
                        <span
                          className={
                            test.ok ? "pill pill-success" : "pill pill-danger"
                          }
                          title={test.detail}
                        >
                          {test.ok
                            ? t.settingsPage.providerHealthTestOk
                            : t.settingsPage.providerHealthTestFail}
                        </span>
                      ) : lastErrorRel ? (
                        <span
                          className="pill pill-warning"
                          title={t.settingsPage.providerLastErrorTooltip}
                        >
                          {t.settingsPage.providerColLastErrorPrefix}
                          {lastErrorRel}
                        </span>
                      ) : lastUsedRel ? (
                        <span
                          className="pill pill-success"
                          title={t.settingsPage.providerLastSuccessTooltip}
                        >
                          {t.settingsPage.providerHealthUsedPrefix}
                          {lastUsedRel}
                        </span>
                      ) : (
                        <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
                          —
                        </span>
                      )}
                      {test && !test.ok && (
                        <div
                          className="muted"
                          style={{
                            fontSize: 10,
                            marginTop: 4,
                            maxWidth: 240,
                            overflowWrap: "anywhere",
                          }}
                        >
                          {test.detail}
                        </div>
                      )}
                    </td>
                    <td className="muted">{fmtTime(k.updated_at)}</td>
                    <td style={{ textAlign: "right" }}>
                      <form
                        action={testProviderKeyAction}
                        style={{ display: "inline", marginRight: 6 }}
                      >
                        <input type="hidden" name="id" value={k.id} />
                        <button type="submit" className="btn btn-sm btn-ghost">
                          {t.settingsPage.providerActionTest}
                        </button>
                      </form>
                      <form
                        action={deleteProviderKeyAction}
                        style={{ display: "inline" }}
                      >
                        <input type="hidden" name="id" value={k.id} />
                        <input
                          type="hidden"
                          name="provider"
                          value={k.provider}
                        />
                        <button type="submit" className="btn btn-sm btn-danger">
                          {t.settingsPage.providerActionDelete}
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ===== Add or replace form (now BELOW the existing-keys list) ===== */}
      {/* Subtle accent border draws the eye to "this is your action" without
          needing the heavy filled card-accent style (which on light theme
          rendered as a jarring dark block). Polished 2026-04-23.
          `id="add-provider-key"` is the target for the "+ Add another"
          link in the existing-keys card header — keeps the
          "I already have a key, where do I add the next one?" path
          one click away. */}
      <div
        id="add-provider-key"
        className="card"
        style={{
          marginTop: 24,
          borderLeftWidth: 4,
          borderLeftStyle: "solid",
          borderLeftColor: "var(--accent)",
        }}
      >
        <div className="card-header">
          <h2>{t.settingsPage.addProviderTitle}</h2>
          <div className="card-header-spacer" />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            {t.settingsPage.addProviderSubtitle}
          </span>
        </div>

        <form
          action={setProviderKeyAction}
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(160px, 200px) 1fr auto",
            gridTemplateAreas: `
              "provider api_key save"
              "base_url base_url base_url"
            `,
            gap: 10,
            alignItems: "center",
          }}
        >
          <select
            name="provider"
            className="input"
            defaultValue={SUPPORTED_PROVIDERS[0]}
            required
            style={{ gridArea: "provider" }}
          >
            {SUPPORTED_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABELS[p] ?? p}
                {haveByProvider.has(p) ? " (replace)" : ""}
              </option>
            ))}
          </select>
          <input
            name="api_key"
            type="password"
            placeholder={t.settingsPage.addProviderKeyPlaceholder}
            className="input"
            autoComplete="off"
            required
            disabled={!encryptionReady}
            style={{ gridArea: "api_key", minWidth: 0 }}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!encryptionReady}
            style={{ gridArea: "save" }}
          >
            {t.settingsPage.addProviderSaveCta}
          </button>
          <input
            name="base_url"
            type="url"
            placeholder={t.settingsPage.addProviderCustomBaseUrl}
            className="input"
            disabled={!encryptionReady}
            style={{ gridArea: "base_url", minWidth: 0 }}
          />
        </form>
        <div
          style={{
            margin: "10px 0 0",
            color: "var(--text-muted)",
            fontSize: 11.5,
            lineHeight: 1.5,
          }}
        >
          <div>{t.settingsPage.addProviderCustomBaseUrlHelp}</div>
          <div style={{ marginTop: 6 }}>
            {t.settingsPage.addProviderRoutingHint}
          </div>
          <div style={{ marginTop: 6 }}>
            {t.settingsPage.addProviderStorageHint}
          </div>
        </div>
      </div>

      {/* =================================================================
           L5 — Model rejection telemetry (top-N last 7 days)
           =================================================================
           What models did users try to use that we couldn't route? Two
           reasons:
             - no_template: no provider recognizer matches the model name
             - no_credentials: provider matched, no key configured
           Used as the feedback loop into L2 (catalog refreshes) and L4
           (custom-provider suggestions). Only renders when there's
           actually something to show — if the table's empty the panel
           hides so the settings page doesn't get visually noisy. */}
      {rejections.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h2>{t.settingsPage.rejectedTitle}</h2>
            <div className="card-header-spacer" />
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
              {t.settingsPage.rejectedSubtitle.replace(
                "{n}",
                String(rejections.length)
              )}
            </span>
          </div>
          <div
            style={{
              fontSize: 12.5,
              color: "var(--text-secondary)",
              marginBottom: 12,
              lineHeight: 1.55,
            }}
          >
            {t.settingsPage.rejectedIntro}
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.settingsPage.rejectedColModel}</th>
                <th>{t.settingsPage.rejectedColReason}</th>
                <th>{t.settingsPage.rejectedColProvider}</th>
                <th>{t.settingsPage.rejectedColHits}</th>
                <th>{t.settingsPage.rejectedColProjects}</th>
                <th>{t.settingsPage.rejectedColLastSeen}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rejections.map((r) => {
                const isNoCreds = r.reason === "no_credentials";
                const fixText = isNoCreds
                  ? t.settingsPage.rejectedActionAddKey.replace(
                      "{provider}",
                      r.provider_guess ?? "provider"
                    )
                  : t.settingsPage.rejectedActionRegister;
                const fixHref = isNoCreds
                  ? "#" // provider-keys form is above, anchor-less for now
                  : "#custom-providers";
                return (
                  <tr key={`${r.model}-${r.reason}`}>
                    <td>
                      <code className="code-inline">{r.model}</code>
                    </td>
                    <td>
                      <span
                        className={
                          isNoCreds ? "pill pill-warning" : "pill pill-danger"
                        }
                      >
                        {r.reason}
                      </span>
                    </td>
                    <td style={{ fontSize: 12, color: "var(--text-muted)" }}>
                      {r.provider_guess ?? "—"}
                    </td>
                    <td
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontWeight: 600,
                      }}
                    >
                      {Number(r.hit_count).toLocaleString()}
                    </td>
                    <td style={{ color: "var(--text-muted)", fontSize: 12 }}>
                      {r.project_count}
                    </td>
                    <td style={{ color: "var(--text-muted)", fontSize: 12 }}>
                      {fmtTime(r.last_seen_at)}
                    </td>
                    <td>
                      <a
                        href={fixHref}
                        className="btn btn-secondary"
                        style={{ fontSize: 12, padding: "4px 10px" }}
                      >
                        {fixText}
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* =================================================================
           L4 — Custom upstream providers (arbitrary OpenAI-compatible)
           =================================================================
           Anything we don't ship a native recognizer for — Groq, xAI,
           Mistral direct, self-hosted vLLM / Ollama / TGI, a corporate
           private endpoint. User registers (name, base_url, model_prefix,
           optional key) and the gateway's resolver picks it up
           BEFORE the six built-in templates.

           See migration 027 + apps/gateway/src/provider-resolve.ts. */}
      <div id="custom-providers" className="card">
        <div className="card-header">
          <h2>{t.settingsPage.customTitle}</h2>
          <div className="card-header-spacer" />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            {t.settingsPage.customCount.replace(
              "{n}",
              String(customProviders.length)
            )}
          </span>
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: "var(--text-secondary)",
            marginBottom: 14,
            lineHeight: 1.55,
          }}
        >
          {t.settingsPage.customIntro}
        </div>

        {customProviders.length > 0 && (
          <table className="data-table" style={{ marginBottom: 14 }}>
            <thead>
              <tr>
                <th>{t.settingsPage.customColName}</th>
                <th>{t.settingsPage.customColPrefix}</th>
                <th>{t.settingsPage.customColBaseUrl}</th>
                <th>{t.settingsPage.customColKey}</th>
                <th>{t.settingsPage.customColStatus}</th>
                <th style={{ width: 180 }}></th>
              </tr>
            </thead>
            <tbody>
              {customProviders.map((cp) => (
                <tr
                  key={cp.id}
                  style={{ opacity: cp.enabled ? 1 : 0.55 }}
                >
                  <td>
                    <code className="code-inline">{cp.name}</code>
                  </td>
                  <td>
                    <code className="code-inline">{cp.model_prefix}</code>
                  </td>
                  <td
                    style={{
                      fontSize: 12,
                      maxWidth: 320,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={cp.base_url}
                  >
                    {cp.base_url}
                  </td>
                  <td>
                    {cp.key_last4 ? (
                      <code className="code-inline">…{cp.key_last4}</code>
                    ) : (
                      <span
                        style={{
                          color: "var(--text-muted)",
                          fontSize: 12,
                        }}
                      >
                        {t.settingsPage.customNoAuth}
                      </span>
                    )}
                  </td>
                  <td>
                    <span
                      className={
                        cp.enabled ? "pill pill-success" : "pill pill-neutral"
                      }
                    >
                      {cp.enabled
                        ? t.settingsPage.customEnabledPill
                        : t.settingsPage.customDisabledPill}
                    </span>
                  </td>
                  <td style={{ display: "flex", gap: 6 }}>
                    <form action={toggleCustomProviderEnabledAction}>
                      <input type="hidden" name="id" value={cp.id} />
                      <input type="hidden" name="name" value={cp.name} />
                      <input
                        type="hidden"
                        name="enabled"
                        value={cp.enabled ? "false" : "true"}
                      />
                      <button
                        type="submit"
                        className="btn"
                        style={{ fontSize: 12, padding: "4px 10px" }}
                      >
                        {cp.enabled
                          ? t.settingsPage.customDisableBtn
                          : t.settingsPage.customEnableBtn}
                      </button>
                    </form>
                    <form action={deleteCustomProviderAction}>
                      <input type="hidden" name="id" value={cp.id} />
                      <input type="hidden" name="name" value={cp.name} />
                      <button
                        type="submit"
                        className="btn btn-danger"
                        style={{ fontSize: 12, padding: "4px 10px" }}
                      >
                        {t.settingsPage.customDeleteBtn}
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <form
          action={setCustomProviderAction}
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(140px, 180px) minmax(140px, 180px) 1fr auto",
            gridTemplateAreas: `
              "name prefix base_url save"
              "api_key api_key api_key api_key"
            `,
            gap: 10,
            alignItems: "center",
          }}
        >
          <input
            name="name"
            placeholder={t.settingsPage.customNamePlaceholder}
            className="input"
            required
            pattern="[a-zA-Z0-9][a-zA-Z0-9-_]*"
            maxLength={64}
            title="1-64 chars, alphanumeric + dash + underscore"
            style={{ gridArea: "name" }}
          />
          <input
            name="model_prefix"
            placeholder={t.settingsPage.customPrefixPlaceholder}
            className="input"
            required
            maxLength={64}
            title={t.settingsPage.customPrefixTooltip}
            style={{ gridArea: "prefix" }}
          />
          <input
            name="base_url"
            type="url"
            placeholder={t.settingsPage.customBaseUrlPlaceholder}
            className="input"
            required
            style={{ gridArea: "base_url", minWidth: 0 }}
          />
          <button
            type="submit"
            className="btn btn-primary"
            style={{ gridArea: "save" }}
          >
            {t.settingsPage.customRegisterCta}
          </button>
          <input
            name="api_key"
            type="password"
            placeholder={t.settingsPage.customApiKeyPlaceholder}
            className="input"
            autoComplete="off"
            style={{ gridArea: "api_key", minWidth: 0 }}
          />
        </form>
        <div
          style={{
            marginTop: 10,
            color: "var(--text-muted)",
            fontSize: 11.5,
            lineHeight: 1.55,
          }}
        >
          <div>{t.settingsPage.customWireFormatHint}</div>
          <div style={{ marginTop: 6 }}>{t.settingsPage.customPricingHint}</div>
          <div style={{ marginTop: 6 }}>
            {t.settingsPage.customResolutionHint}
          </div>
        </div>
      </div>

      {/* ===== System integrations status (gateway-driven) ===== */}
      {/* Surfaces env-var-configured features so the operator can see at
          a glance what's wired up. Reads from gateway /health (cached 30s).
          Discoverability fix added 2026-04-23 — without this panel, OTel /
          failover / multi-key / quality-embedding were all invisible. */}
      <div className="card" style={{ marginTop: 32 }}>
        <div className="card-header">
          <h2>{t.settingsPage.sysIntegrationsTitle}</h2>
          <div className="card-header-spacer" />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            {t.settingsPage.sysIntegrationsSource}
          </span>
        </div>
        {!gatewayHealth.ok ? (
          <div
            style={{
              padding: 12,
              borderRadius: 8,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              fontSize: 13,
              color: "var(--text-secondary)",
            }}
          >
            <strong>Gateway not reachable.</strong> Make sure{" "}
            <code className="code-inline">apps/gateway</code> is running and
            the dashboard&apos;s{" "}
            <code className="code-inline">GATEWAY_URL</code> points at it.
            <br />
            <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
              {gatewayHealth.error}
            </span>
          </div>
        ) : (
          (() => {
            const i = gatewayHealth.data.integrations;
            type Row = {
              key: string;
              title: string;
              enabled: boolean;
              detail: React.ReactNode;
              hint: string;
            };
            const tSp = t.settingsPage;
            const rows: Row[] = [
              {
                key: "failover",
                title: tSp.sysFailoverTitle,
                enabled: i.failover.enabled,
                detail: i.failover.enabled ? (
                  <ul
                    style={{
                      margin: 0,
                      padding: 0,
                      listStyle: "none",
                      fontSize: 12,
                      fontFamily: "var(--font-mono)",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {i.failover.rules.map((r) => (
                      <li key={`${r.from}->${r.to}`}>
                        {r.from} → {r.to}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                    {tSp.sysFailoverStatusEmpty}
                  </span>
                ),
                hint: tSp.sysFailoverHint,
              },
              {
                key: "key-pools",
                title: tSp.sysMultiKeyTitle,
                enabled: i.key_pools.some((p) => p.total > 1),
                detail:
                  i.key_pools.length === 0 ? (
                    <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                      {tSp.sysMultiKeySingle}
                    </span>
                  ) : (
                    <ul
                      style={{
                        margin: 0,
                        padding: 0,
                        listStyle: "none",
                        fontSize: 12,
                        fontFamily: "var(--font-mono)",
                        color: "var(--text-secondary)",
                      }}
                    >
                      {i.key_pools.map((p) => (
                        <li key={p.provider}>
                          {p.provider}:{" "}
                          <strong
                            style={{
                              color:
                                p.available === p.total
                                  ? "var(--success)"
                                  : "var(--warning)",
                            }}
                          >
                            {p.available}/{p.total}
                          </strong>{" "}
                          {p.total === 1
                            ? tSp.sysMultiKeySingle
                            : tSp.sysMultiKeyHint}
                        </li>
                      ))}
                    </ul>
                  ),
                hint: tSp.sysMultiKeyHint,
              },
              {
                key: "otel",
                title: tSp.sysOtelTitle,
                enabled: i.otel.enabled,
                detail: i.otel.enabled ? (
                  <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                    →{" "}
                    <code className="code-inline">{i.otel.endpoint_host}</code>
                    <br />
                    service.name ={" "}
                    <code className="code-inline">{i.otel.service_name}</code>
                  </div>
                ) : (
                  <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                    {tSp.sysOtelStatusEmpty}
                  </span>
                ),
                hint: tSp.sysOtelHint,
              },
              {
                key: "quality",
                title: tSp.sysQualityEmbedTitle,
                enabled: i.quality.enabled,
                detail: i.quality.enabled ? (
                  <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                    Model:{" "}
                    <code className="code-inline">{i.quality.model}</code>
                    <br />
                    Provider:{" "}
                    <code className="code-inline">{i.quality.provider}</code>
                  </div>
                ) : (
                  <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                    {tSp.sysQualityEmbedStatusEmpty}
                  </span>
                ),
                hint: tSp.sysQualityEmbedHint,
              },
              {
                key: "crypto",
                title: tSp.sysByoEncTitle,
                enabled: i.crypto.backend !== "disabled",
                detail: (
                  <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                    {i.crypto.backend === "aws-kms" && <>{tSp.sysCryptoAws}</>}
                    {i.crypto.backend === "gcp-kms" && <>{tSp.sysCryptoGcp}</>}
                    {i.crypto.backend === "env-master-key" && (
                      <>{tSp.sysCryptoEnvMaster}</>
                    )}
                    {i.crypto.backend === "disabled" && (
                      <>{tSp.sysByoEncStatusEmpty}</>
                    )}
                  </div>
                ),
                hint: tSp.sysByoEncHint,
              },
              {
                key: "semantic-cache",
                title: tSp.sysCacheTitle,
                enabled: !!i.semantic_cache?.enabled,
                detail: i.semantic_cache?.enabled ? (
                  <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                    {tSp.sysCacheMaxEntries}{" "}
                    <code className="code-inline">
                      {i.semantic_cache.max_entries}
                    </code>
                    <br />
                    {tSp.sysCacheTtl}{" "}
                    <code className="code-inline">
                      {i.semantic_cache.ttl_seconds}s
                    </code>
                    <br />
                    {tSp.sysCacheSimThreshold}{" "}
                    <code className="code-inline">
                      {i.semantic_cache.similarity_threshold > 0
                        ? i.semantic_cache.similarity_threshold.toFixed(2)
                        : "off (exact only)"}
                    </code>
                  </div>
                ) : (
                  <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                    {tSp.sysCacheDisabled}
                  </span>
                ),
                hint: tSp.sysCacheHint,
              },
              {
                key: "policy",
                title: tSp.sysBaselineTitle,
                enabled: i.baseline_policy.enabled,
                detail: i.baseline_policy.enabled ? (
                  <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                    {tSp.sysBaselineVersion}{" "}
                    <code className="code-inline">
                      {i.baseline_policy.version ?? "(none)"}
                    </code>
                    <br />
                    {tSp.sysBaselineBuckets.replace(
                      "{n}",
                      String(i.baseline_policy.buckets)
                    )}
                  </div>
                ) : (
                  <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                    {tSp.sysBaselineDisabled}
                  </span>
                ),
                hint: tSp.sysBaselineHint,
              },
            ];
            return (
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: 28 }}></th>
                    <th>{tSp.sysIntegrationsCol1}</th>
                    <th>{tSp.sysIntegrationsCol2}</th>
                    <th>{tSp.sysIntegrationsCol3}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key}>
                      <td>
                        <span
                          style={{
                            display: "inline-block",
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            background: r.enabled
                              ? "var(--success)"
                              : "var(--text-muted)",
                          }}
                          aria-label={r.enabled ? t.common.active : t.common.inactive}
                        />
                      </td>
                      <td>
                        <strong style={{ fontSize: 13 }}>{r.title}</strong>
                      </td>
                      <td>{r.detail}</td>
                      <td
                        style={{
                          fontSize: 11,
                          color: "var(--text-muted)",
                          lineHeight: 1.5,
                          maxWidth: 360,
                        }}
                      >
                        {r.hint}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          })()
        )}
      </div>

      {/* ===== Email preferences (weekly digest opt-in) ===== */}
      {/* Surfaces the existing weekly-savings-digest cron script. Without
          this UI the script exists but nobody knew to opt in. Discoverability
          fix added 2026-04-23. CAN-SPAM/GDPR posture: opt-in, not opt-out. */}
      <div className="card" style={{ marginTop: 32 }}>
        <div className="card-header">
          <h2>{t.settingsPage.emailPrefsTitle}</h2>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: 1, minWidth: 280 }}>
            <div style={{ fontWeight: 500, fontSize: 14, marginBottom: 6 }}>
              {t.settingsPage.emailWeeklyTitle}
            </div>
            <div
              style={{
                fontSize: 13,
                color: "var(--text-secondary)",
                lineHeight: 1.55,
              }}
            >
              {t.settingsPage.emailWeeklyBody}
            </div>
            <div
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                marginTop: 8,
              }}
            >
              {digestPrefs.last_sent_at
                ? `${t.settingsPage.emailLastSentPrefix} ${fmtTime(digestPrefs.last_sent_at)} (${fmtRel(digestPrefs.last_sent_at) ?? "—"})`
                : isHostedMode()
                  ? t.settingsPage.emailNeverSentHosted.replace(
                      "{when}",
                      fmtTime(nextWeeklyDigestSendUtc())
                    )
                  : t.settingsPage.emailNeverSentSelfHost}
            </div>
            {isHostedMode() ? (
              digestPrefs.enabled && (
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text-muted)",
                    marginTop: 4,
                    lineHeight: 1.5,
                  }}
                >
                  {t.settingsPage.emailNextDigestPrefix}
                  {fmtTime(nextWeeklyDigestSendUtc())}
                  {t.settingsPage.emailNextDigestSuffix}
                </div>
              )
            ) : (
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  marginTop: 4,
                  lineHeight: 1.5,
                }}
              >
                {t.settingsPage.emailOperatorNote}
              </div>
            )}
          </div>
          <form action={setWeeklyDigestAction} data-weekly-digest-form>
            <input
              type="hidden"
              name="enabled"
              value={digestPrefs.enabled ? "0" : "1"}
            />
            <button
              type="submit"
              className={`btn ${digestPrefs.enabled ? "" : "btn-primary"}`}
            >
              {digestPrefs.enabled
                ? t.settingsPage.emailUnsubscribeBtn
                : t.settingsPage.emailSubscribeBtn}
            </button>
            <div
              style={{
                fontSize: 11,
                color: digestPrefs.enabled
                  ? "var(--success)"
                  : "var(--text-muted)",
                marginTop: 6,
                textAlign: "center",
                fontWeight: digestPrefs.enabled ? 500 : 400,
              }}
            >
              {digestPrefs.enabled
                ? t.settingsPage.emailSubscribed
                : t.settingsPage.emailUnsubscribed}
            </div>
          </form>
        </div>
      </div>

      {/* ===== Data & privacy ===================================== */}
      {/* DPA § 7 commits to: export on demand, delete within 30 days of
          termination. Both paths are now self-serve. */}
      <div className="card" style={{ marginTop: 32 }}>
        <div className="card-header">
          <h2>{t.settingsPage.privacyTitle}</h2>
          <div className="card-header-spacer" />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            {t.settingsPage.privacySubtitle}
          </span>
        </div>

        <div
          style={{
            display: "grid",
            gap: 16,
          }}
        >
          {/* Export */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto",
              gap: 16,
              alignItems: "center",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 500, fontSize: 14, marginBottom: 4 }}>
                {t.settingsPage.privacyExportTitle}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  lineHeight: 1.6,
                }}
              >
                {t.settingsPage.privacyExportBody}
              </div>
            </div>
            <a
              href="/settings/data/export"
              download
              className="btn btn-sm"
              style={{ textDecoration: "none" }}
            >
              {t.settingsPage.privacyExportCta}
            </a>
          </div>

          {/* Delete */}
          {!deletionScheduledAt && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: 16,
                alignItems: "center",
                padding: "14px 14px",
                background: "var(--danger-weak)",
                borderRadius: 6,
                border: "1px solid var(--danger)",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  style={{ fontWeight: 500, fontSize: 14, marginBottom: 4 }}
                >
                  {t.settingsPage.privacyDeleteTitle}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--text-secondary)",
                    lineHeight: 1.6,
                  }}
                >
                  {t.settingsPage.privacyDeleteBody}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text-muted)",
                    marginTop: 8,
                  }}
                >
                  {t.settingsPage.privacyDeleteConfirmHint}
                </div>
              </div>
              <form
                action={markAccountForDeletionAction}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <input
                  name="confirm"
                  type="text"
                  required
                  autoComplete="off"
                  placeholder={t.settingsPage.privacyDeletePlaceholder}
                  className="input"
                  style={{ width: 160, fontSize: 12 }}
                />
                <button type="submit" className="btn btn-sm btn-danger">
                  {t.settingsPage.privacyDeleteSchedule}
                </button>
              </form>
            </div>
          )}
        </div>
      </div>
    </SettingsLayout>
  );
}
