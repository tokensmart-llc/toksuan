import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession, isAuthEnabled } from "@/lib/auth";
import {
  ALERT_EVENT_TYPES,
  getProjectForUser,
  getProjectSpendContext,
  listAlertRulesForProject,
  listApiKeysForProject,
  listBudgetsForProject,
  listProviderKeysForUser,
  listRoutingRulesForProject,
} from "@/lib/db";
// The old project header (name, project uuid, live-refresh pill) was folded
// into ProjectDetailLayout's sidebar or removed. CopyButton stays imported for
// in-section use (smoke-pair copy buttons and one-time key reveal).
import { CopyButton } from "@/components/CopyButton";
import { BudgetForm } from "@/components/BudgetForm";
import { BudgetEditableRow } from "@/components/BudgetEditableRow";
import { RoutingRuleForm } from "@/components/RoutingRuleForm";
import { RoutingRuleEditableRow } from "@/components/RoutingRuleEditableRow";
import { AlertRuleForm } from "@/components/AlertRuleForm";
import { ProjectDetailLayout } from "@/components/ProjectDetailLayout";
import { ProjectSection } from "@/components/ProjectSection";
import {
  peekRevealedKey,
  createApiKeyAction,
  deleteAlertRuleAction,
  deleteApiKeyAction,
  rotateApiKeyAction,
  testAlertRuleAction,
} from "../actions";
import { RevealOnce } from "@/components/RevealOnce";
import {
  getPublicGatewayApiUrl,
  getPublicGatewayChatUrl,
} from "@/lib/public-url";
import { getDocsUrl } from "@/lib/docs-url";
import {
  fmtMicroCentsUsd,
  getProjectPolicySummary,
  type ProjectPolicySummary,
} from "@/lib/policy-history";
import { getDictionary } from "@/lib/i18n.server";
import { fetchBaselinePolicyMirror } from "@/lib/baseline-policy-mirror";
import { fetchGatewayHealth } from "@/lib/gateway-status";
import { describeAlertEvent } from "@/lib/alert-event-copy";
import {
  callableProviderSet,
  pickSmokePair,
  smokePairExpectedSavingsMicroCents,
  suggestUnlockProviders,
  type SmokePair,
} from "@/lib/smoke-model";
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

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!isAuthEnabled()) redirect("/");
  const session = await getSession();
  if (!session) redirect("/login");

  const { id } = await params;
  const project = await getProjectForUser(session.user.id, id);
  if (!project) notFound();

  const [keys, budgets, routingRules, alertRules, spendContext, policySummary, providerKeys, baselinePolicy, gatewayHealth] = await Promise.all([
    listApiKeysForProject(project.id),
    listBudgetsForProject(project.id),
    listRoutingRulesForProject(project.id),
    listAlertRulesForProject(project.id),
    getProjectSpendContext(project.id),
    getProjectPolicySummary(project.id),
    listProviderKeysForUser(session.user.id),
    fetchBaselinePolicyMirror(),
    fetchGatewayHealth(),
  ]);
  // Whether the gateway has RESEND_API_KEY set (alert emails are
  // actually delivered) vs log-only mode. Used to render the truthful
  // notice in the Alerts panel below — no longer the unconditional
  // "email never sends today" warning that was wrong for hosted prod
  // and any self-hosted operator who'd already wired RESEND_API_KEY.
  const alertEmailConfigured =
    gatewayHealth.ok && gatewayHealth.data.integrations.alert_email?.configured === true;
  const alertEmailFrom =
    gatewayHealth.ok ? gatewayHealth.data.integrations.alert_email?.from ?? null : null;
  // READ-ONLY peek — actual cookie deletion is fired client-side from
  // <RevealOnce> below so we don't trip Next 15's render-phase
  // cookies-are-immutable rule.
  const justCreatedKey = await peekRevealedKey();

  // Pick a smoke pair driven by the live baseline policy, splitting
  // the contract along the gateway billing model:
  //
  //   * `asked` is fixed to the priciest model in one of the user's
  //     BYO families that the policy has training data for — the
  //     family's flagship. The user's own credentials get charged on
  //     this side, which is the whole point of BYO keys.
  //
  //   * `route_to` is whatever the policy says is cheapest acceptable
  //     in the same bucket, regardless of which family. When the
  //     gateway has env credentials for that family, runtime actually
  //     routes there. When it doesn't, runtime falls through to the
  //     next-cheapest the gateway CAN reach, and the receipt's
  //     "landed" line tells the truth.
  //
  // pickSmokePair returns null only when none of the user's BYO
  // providers appear in the policy at all (e.g. only `custom:*`
  // upstreams, or no BYO yet). In that case we fall back to a small
  // "add a provider key" prompt — the only state where we can't put
  // anything useful in the curl.
  const byoProviders = providerKeys.map((k) => k.provider);
  const envProviders = baselinePolicy?.env_providers ?? [];
  const smokePair: SmokePair | null = pickSmokePair(
    baselinePolicy,
    byoProviders,
    envProviders
  );
  const callableProviders = callableProviderSet(byoProviders, envProviders);
  const unlockProviderHints = smokePair
    ? []
    : suggestUnlockProviders(baselinePolicy, callableProviders, 3);
  // Both the model AND the prompt come from the smoke pair: the prompt
  // is hand-tuned per bucket so the runtime task classifier maps it
  // back into the same bucket the asked model lives in.
  const smokeMessage = smokePair
    ? JSON.stringify(smokePair.prompt)
    : null;
  const firstRequestCurl =
    justCreatedKey && smokePair && smokeMessage
      ? `curl ${getPublicGatewayChatUrl()} \\
  -H "Authorization: Bearer ${justCreatedKey}" \\
  -H "Content-Type: application/json" \\
  -H "x-ts-agent: first-demo" \\
  -H "x-ts-session: first-receipt" \\
  -H "x-ts-turn: 1" \\
  -d '{
    "model": "${smokePair.asked.model}",
    "messages": [{"role": "user", "content": ${smokeMessage}}]
  }'`
      : null;
  const firstRequestCurlTemplate =
    smokePair && smokeMessage
      ? `curl ${getPublicGatewayChatUrl()} \\
  -H "Authorization: Bearer ts_your_project_key_here" \\
  -H "Content-Type: application/json" \\
  -H "x-ts-agent: first-demo" \\
  -H "x-ts-session: first-receipt" \\
  -H "x-ts-turn: 1" \\
  -d '{
    "model": "${smokePair.asked.model}",
    "messages": [{"role": "user", "content": ${smokeMessage}}]
  }'`
      : null;
  const showFirstRequestNudge =
    !justCreatedKey && spendContext.recent_call_count_24h === 0;

  const { t } = await getDictionary();
  const tProjects = t.projects;

  return (
    <ProjectDetailLayout
      projectName={project.name}
      hasGettingStarted={showFirstRequestNudge}
      t={tProjects}
    >
      {/* Page header used to live here (project name h1 + project-id
          tagline + AutoRefresh). Project name + short uuid moved into
          the sidebar; AutoRefresh was removed entirely (the project
          detail surfaces don't show second-tick data the way the
          Dashboard does, so the live indicator was just visual
          noise). The main column now opens straight into the active
          section's heading so short tabs no longer look 'orphaned'
          under a tall page header. */}

      {justCreatedKey && (
        <RevealOnce>
          <div className="card card-success">
            <h3 style={{ color: "var(--success)" }}>{tProjects.revealHeading}</h3>
            <p
              style={{
                fontSize: 13,
                color: "var(--text-secondary)",
                margin: "0 0 10px",
              }}
            >
              {tProjects.revealBody}
            </p>
            <CopyButton value={justCreatedKey} t={t.copyButton} />
            {firstRequestCurl && smokePair ? (
              <div style={{ marginTop: 16 }}>
                <h3 style={{ color: "var(--text)", marginBottom: 8 }}>
                  {tProjects.revealUseInAgent}
                </h3>
                <SmokePairSummary smokePair={smokePair} t={tProjects} />
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                    gap: 10,
                    marginBottom: 12,
                  }}
                >
                  {[
                    ["base_url", getPublicGatewayApiUrl()],
                    ["api_key", justCreatedKey],
                    ["asked_model", smokePair.asked.model],
                  ].map(([label, value]) => (
                    <div
                      key={label}
                      style={{
                        border: "1px solid var(--border)",
                        borderRadius: 10,
                        padding: 10,
                        background: "var(--surface)",
                      }}
                    >
                      <div className="stat-label">{label}</div>
                      <CopyButton value={value} display={value} compact />
                    </div>
                  ))}
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--text-secondary)",
                    marginBottom: 8,
                  }}
                >
                  {tProjects.revealOrCopyCurl}
                </div>
                <pre className="code-block" style={{ fontSize: 11, lineHeight: 1.5 }}>
                  {firstRequestCurl}
                </pre>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <CopyButton
                    value={firstRequestCurl}
                    display={tProjects.revealCopyCurlBtn}
                    compact
                    t={t.copyButton}
                  />
                  <Link href="/dashboard" className="btn btn-sm btn-primary">
                    {tProjects.revealOpenDashboard}
                  </Link>
                </div>
              </div>
            ) : (
              <NoRoutableDemoHint
                providerKeys={providerKeys.map((k) => k.provider)}
                unlockProviderHints={unlockProviderHints}
                policyVersion={baselinePolicy?.version ?? null}
                t={tProjects}
              />
            )}
          </div>
        </RevealOnce>
      )}

      {showFirstRequestNudge && (
        <ProjectSection id="getting-started">
        <section
          className="card card-accent"
          style={{
            marginBottom: 24,
            borderLeftWidth: 4,
            borderLeftStyle: "solid",
            borderLeftColor: "var(--accent)",
          }}
        >
          <div className="card-header">
            <h2>{tProjects.gettingStartedTitle}</h2>
            <div className="card-header-spacer" />
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
              {tProjects.gettingStartedHeaderHint}
            </span>
          </div>
          <p
            style={{
              fontSize: 13,
              color: "var(--text-secondary)",
              lineHeight: 1.55,
              margin: "0 0 12px",
            }}
          >
            {tProjects.gettingStartedBody}
          </p>
          {keys.length === 0 ? (
            <form
              action={createApiKeyAction}
              style={{ display: "flex", gap: 10, flexWrap: "wrap" }}
            >
              <input type="hidden" name="project_id" value={project.id} />
              <input
                name="name"
                placeholder={tProjects.gettingStartedKeyNamePlaceholder}
                required
                className="input"
                style={{ flex: "1 1 220px", maxWidth: 360 }}
              />
              <button type="submit" className="btn btn-primary">
                {tProjects.gettingStartedCreateBtn}
              </button>
            </form>
          ) : (
            <>
              <div
                style={{
                  padding: 12,
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  background: "var(--surface)",
                  fontSize: 13,
                  color: "var(--text-secondary)",
                  lineHeight: 1.55,
                  marginBottom: 12,
                }}
              >
                {tProjects.gettingStartedExistingHint
                  .replace("{n}", String(keys.length))
                  .replace("{s}", keys.length === 1 ? "" : "s")}
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
                <form
                  action={createApiKeyAction}
                  style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: 0 }}
                >
                  <input type="hidden" name="project_id" value={project.id} />
                  <input
                    name="name"
                    placeholder={tProjects.gettingStartedFreshKeyName}
                    required
                    className="input"
                    style={{ width: 240 }}
                  />
                  <button type="submit" className="btn btn-primary">
                    {tProjects.gettingStartedFreshBtn}
                  </button>
                </form>
                <Link href="/dashboard" className="btn">
                  {tProjects.gettingStartedAlreadySent}
                </Link>
              </div>
              {smokePair && firstRequestCurlTemplate ? (
                <>
                  <SmokePairSummary smokePair={smokePair} t={tProjects} />
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                      gap: 10,
                      marginBottom: 12,
                    }}
                  >
                    {[
                      ["base_url", getPublicGatewayApiUrl()],
                      ["api_key", "ts_your_project_key_here"],
                      ["asked_model", smokePair.asked.model],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        style={{
                          border: "1px solid var(--border)",
                          borderRadius: 10,
                          padding: 10,
                          background: "var(--surface)",
                        }}
                      >
                        <div className="stat-label">{label}</div>
                        <CopyButton value={value} display={value} compact />
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
                    {tProjects.gettingStartedTemplateHint}
                  </div>
                  <pre className="code-block" style={{ fontSize: 11, lineHeight: 1.5 }}>
                    {firstRequestCurlTemplate}
                  </pre>
                </>
              ) : (
                <NoRoutableDemoHint
                  providerKeys={providerKeys.map((k) => k.provider)}
                  unlockProviderHints={unlockProviderHints}
                  policyVersion={baselinePolicy?.version ?? null}
                  t={tProjects}
                />
              )}
            </>
          )}
        </section>
        </ProjectSection>
      )}

      {/* Routing-policy mini card. Glance-level signal so users
          don't have to click into /policy to know whether the
          background-trained policy is on, what version is live,
          and whether it actually saved money in the last 30 days.
          Click-through links to the full changelog page. */}
      <ProjectSection id="policy">
      <PolicyMiniCard projectId={project.id} summary={policySummary} t={tProjects} />
      </ProjectSection>

      {/* Integration recipe */}
      <ProjectSection id="setup">
      <details className="card card-accent details-card">
        <summary className="card-header details-summary">
          <h2>{tProjects.setupTitle}</h2>
          <div className="card-header-spacer" />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            {tProjects.setupHeaderHint}
          </span>
          <span className="details-toggle" aria-hidden="true" />
        </summary>
        <div
          style={{
            fontSize: 13,
            color: "var(--text-secondary)",
            display: "grid",
            gap: 10,
          }}
        >
          <div>{tProjects.setupBody}</div>

          <div
            style={{
              paddingTop: 8,
              borderTop: "1px solid var(--border)",
              fontSize: 13,
            }}
          >
            <strong style={{ color: "var(--text)" }}>
              {tProjects.setupResolveTitle}
            </strong>
            <ul
              style={{
                margin: "6px 0 0 0",
                paddingLeft: 18,
                lineHeight: 1.6,
              }}
            >
              <li>
                <strong>{tProjects.setupResolve1Title}</strong>{" "}
                {tProjects.setupResolve1Body}
              </li>
              <li>
                <strong>{tProjects.setupResolve2Title}</strong>{" "}
                {tProjects.setupResolve2BodyPrefix}
                <Link
                  href="/settings#provider-keys"
                  style={{ color: "var(--accent)" }}
                >
                  {tProjects.setupResolve2BodyLink}
                </Link>
                {tProjects.setupResolve2BodySuffix}
              </li>
              <li>
                <strong>{tProjects.setupResolve3Title}</strong>{" "}
                {tProjects.setupResolve3BodyPrefix}
                <Link
                  href="/settings#provider-keys"
                  style={{ color: "var(--accent)" }}
                >
                  {tProjects.setupResolve3BodyLink1}
                </Link>
                {tProjects.setupResolve3BodyMid}
                <Link
                  href="https://github.com/tokensmart-llc/toksuan/issues/new/choose"
                  target="_blank"
                  style={{ color: "var(--accent)" }}
                >
                  {tProjects.setupResolve3BodyLink2}
                </Link>
                {tProjects.setupResolve3BodySuffix}
              </li>
              <li>
                <strong>{tProjects.setupResolve4Title}</strong>{" "}
                {tProjects.setupResolve4Body}
              </li>
            </ul>
          </div>

          <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
            {tProjects.setupPrincipleBodyPrefix}
            <Link
              href={getDocsUrl("docs/integrations/README.md")}
              style={{ color: "var(--accent)" }}
              target="_blank"
              rel="noreferrer"
            >
              {tProjects.setupPrincipleBodyLink}
            </Link>
            {tProjects.setupPrincipleBodySuffix}
          </div>
        </div>
      </details>
      </ProjectSection>

      {/* Keys */}
      <ProjectSection id="api-keys">
      <div className="card">
        <div className="card-header">
          <h2>{tProjects.apiKeysTitle}</h2>
          <div className="card-header-spacer" />
          <form
            action={createApiKeyAction}
            style={{ display: "flex", gap: 8 }}
          >
            <input type="hidden" name="project_id" value={project.id} />
            <input
              name="name"
              placeholder={tProjects.apiKeysNamePlaceholder}
              required
              className="input"
              style={{ width: 180 }}
            />
            <button type="submit" className="btn btn-primary btn-sm">
              {tProjects.apiKeysNewBtn}
            </button>
          </form>
        </div>

        {keys.length === 0 ? (
          <div className="empty">{tProjects.apiKeysEmpty}</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{tProjects.apiKeysColName}</th>
                <th>{tProjects.apiKeysColKey}</th>
                <th>{tProjects.apiKeysColCreated}</th>
                <th>{tProjects.apiKeysColLastUsed}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const display =
                  k.key_prefix && k.key_last4
                    ? `${k.key_prefix}…${k.key_last4}`
                    : k.key ?? "—";
                // Soft-rotate grace-period rendering. `expires_at` is
                // non-null only on the "old half" of a v0.4.x rotate;
                // the key is still accepted by the gateway until this
                // timestamp passes, then findApiKey filters it out.
                const inGracePeriod =
                  k.expires_at !== null &&
                  k.expires_at !== undefined &&
                  new Date(k.expires_at).getTime() > Date.now();
                const graceMsLeft = inGracePeriod
                  ? new Date(k.expires_at as Date).getTime() - Date.now()
                  : 0;
                const graceLabel = (() => {
                  if (!inGracePeriod) return null;
                  const hours = Math.floor(graceMsLeft / 3_600_000);
                  const mins = Math.floor(
                    (graceMsLeft % 3_600_000) / 60_000
                  );
                  if (hours >= 1)
                    return tProjects.apiKeysGraceExpiresHM
                      .replace("{h}", String(hours))
                      .replace("{m}", String(mins));
                  return tProjects.apiKeysGraceExpiresM.replace(
                    "{m}",
                    String(mins)
                  );
                })();
                return (
                  <tr key={k.id}>
                    <td>
                      {k.name ?? "—"}
                      {inGracePeriod && (
                        <div
                          style={{
                            fontSize: 10,
                            color: "var(--warning)",
                            marginTop: 2,
                            fontWeight: 500,
                          }}
                        >
                          {tProjects.apiKeysGracePrefix}
                          {graceLabel}
                        </div>
                      )}
                    </td>
                    <td>
                      {k.key ? (
                        <CopyButton value={k.key} t={t.copyButton} />
                      ) : (
                        <code className="code-inline" title={tProjects.apiKeysHashedAtRestTooltip}>
                          {display}
                        </code>
                      )}
                    </td>
                    <td className="muted">{fmtTime(k.created_at)}</td>
                    <td className="muted">
                      {k.last_used_at
                        ? fmtTime(k.last_used_at)
                        : tProjects.apiKeysLastUsedNever}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <div
                        style={{
                          display: "inline-flex",
                          gap: 6,
                          justifyContent: "flex-end",
                        }}
                      >
                        {!inGracePeriod && (
                          <form action={rotateApiKeyAction}>
                            <input
                              type="hidden"
                              name="project_id"
                              value={project.id}
                            />
                            <input type="hidden" name="key_id" value={k.id} />
                            <button
                              type="submit"
                              className="btn btn-sm btn-ghost"
                              title={tProjects.apiKeysRotateTitle}
                            >
                              {tProjects.apiKeysRotateBtn}
                            </button>
                          </form>
                        )}
                        <form action={deleteApiKeyAction}>
                          <input
                            type="hidden"
                            name="project_id"
                            value={project.id}
                          />
                          <input type="hidden" name="key_id" value={k.id} />
                          <button
                            type="submit"
                            className="btn btn-sm btn-danger"
                            title={
                              inGracePeriod
                                ? tProjects.apiKeysDeleteNowTitle
                                : undefined
                            }
                          >
                            {inGracePeriod
                              ? tProjects.apiKeysDeleteNowBtn
                              : tProjects.apiKeysDeleteBtn}
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <p
        style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 24 }}
      >
        {tProjects.apiKeysFootnote}
      </p>
      </ProjectSection>

      {/* ================= Cost-attribution tags hint ================= */}
      {/* Surfaces the x-ts-tag header feature for users who don't know it
          exists. The "Spend by tag" card on the dashboard home only renders
          when at least one request has tags — chicken-and-egg without this
          educational hint. Discoverability fix added 2026-04-23. */}
      <ProjectSection id="tags">
      <div className="card" style={{ marginTop: 32 }}>
        <div className="card-header">
          <h2>{tProjects.tagsTitle}</h2>
        </div>
        <p
          style={{
            fontSize: 13,
            color: "var(--text-secondary)",
            lineHeight: 1.55,
            margin: "0 0 14px 0",
          }}
        >
          {tProjects.tagsBodyPrefix}
          <code className="code-inline">x-ts-tag</code>
          {tProjects.tagsBodyMid}
          <strong>{t.dashboard.sectionSpendByTag}</strong>
          {tProjects.tagsBodySuffix}
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 16,
            marginTop: 8,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                marginBottom: 6,
              }}
            >
              {tProjects.tagsExampleCurl}
            </div>
            <pre
              className="code-block"
              style={{ fontSize: 11, lineHeight: 1.5, margin: 0 }}
            >{`curl ${getPublicGatewayChatUrl()} \\
  -H "Authorization: Bearer ts_..." \\
  -H "Content-Type: application/json" \\
  -H "x-ts-tag: feature=summarize,team=growth,user=u_42" \\
  -d '{"model":"gpt-4o-mini","messages":[...]}'`}</pre>
          </div>
          <div>
            <div
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                marginBottom: 6,
              }}
            >
              {tProjects.tagsExamplePythonSdk}
            </div>
            <pre
              className="code-block"
              style={{ fontSize: 11, lineHeight: 1.5, margin: 0 }}
            >{`client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[...],
    extra_headers={
        "x-ts-tag": "feature=summarize,team=growth"
    },
)`}</pre>
          </div>
        </div>

        <div
          style={{
            marginTop: 14,
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <CopyButton
            value="x-ts-tag: feature=summarize,team=growth,user=u_42"
            display={tProjects.tagsCopyHeaderBtn}
            t={t.copyButton}
          />
          <span
            style={{ fontSize: 11, color: "var(--text-muted)" }}
          >
            {tProjects.tagsCommonDimsPrefix}
            <code className="code-inline">feature</code>
            {tProjects.tagsCommonDimsSeparator}
            <code className="code-inline">team</code>
            {tProjects.tagsCommonDimsSeparator}
            <code className="code-inline">user</code>
            {tProjects.tagsCommonDimsSeparator}
            <code className="code-inline">env</code>
            {tProjects.tagsCommonDimsSeparator}
            <code className="code-inline">customer</code>
            {tProjects.tagsCommonDimsSeparator}
            <code className="code-inline">experiment</code>
            {tProjects.tagsCommonDimsSuffix}
          </span>
        </div>

        <div
          style={{
            marginTop: 14,
            fontSize: 11,
            color: "var(--text-muted)",
            lineHeight: 1.5,
          }}
        >
          {tProjects.tagsFrameworksHintPrefix}
          <a
            href={getDocsUrl("docs/integrations/README.md")}
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--accent)" }}
          >
            {tProjects.tagsFrameworksHintLink}
          </a>
          {tProjects.tagsFrameworksHintSuffix}
        </div>
      </div>
      </ProjectSection>

      {/* ================= Prompt templates teaser ================= */}
      {/* Surfaces the prompt-template registry. Heavy CRUD + per-version
          editor lives on `/projects/[id]/templates`; this teaser exists
          so users find the feature + understand the runtime header from
          the project home. */}
      <ProjectSection id="templates">
      <div className="card" style={{ marginTop: 32 }}>
        <div className="card-header">
          <h2>{tProjects.templatesTitle}</h2>
          <div className="card-header-spacer" />
          <Link
            href={`/projects/${project.id}/templates`}
            className="btn btn-sm"
          >
            {tProjects.templatesManageBtn}
          </Link>
        </div>
        <div
          style={{
            fontSize: 13,
            color: "var(--text-secondary)",
            lineHeight: 1.55,
          }}
        >
          {tProjects.templatesBodyPrefix}
          <code className="code-inline">x-ts-template: &lt;name&gt;</code>
          {tProjects.templatesBodyMid}
          <code className="code-inline">x-ts-template: name@3</code>
          {tProjects.templatesBodySuffix}
        </div>
        <pre
          className="code-block"
          style={{ marginTop: 12, fontSize: 11, lineHeight: 1.5 }}
        >
{`curl ${getPublicGatewayChatUrl()} \\
  -H "Authorization: Bearer ts_..." \\
  -H "Content-Type: application/json" \\
  -H "x-ts-template: my-template" \\
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role":"user","content":"Review {{code}}"}],
    "ts_template_vars": {"code": "function foo(){return 1;}"}
  }'`}
        </pre>
        <div
          style={{
            fontSize: 11.5,
            color: "var(--text-muted)",
            marginTop: 8,
          }}
        >
          {tProjects.templatesVarsHintPrefix}
          <code className="code-inline">{`{{double-braces}}`}</code>
          {tProjects.templatesVarsHintMid1}
          <code className="code-inline">ts_template_vars</code>
          {tProjects.templatesVarsHintMid2}
          <code className="code-inline">x-ts-template-vars</code>
          {tProjects.templatesVarsHintMid3}
          <code className="code-inline">tags.template</code>
          {tProjects.templatesVarsHintMid4}
          <code className="code-inline">tags.template_version</code>
          {tProjects.templatesVarsHintMid5}
        </div>
      </div>
      </ProjectSection>

      {/* ================= Budgets ================= */}
      <ProjectSection id="budgets">
      <div className="card" style={{ marginTop: 32 }}>
        <div className="card-header">
          <h2>{tProjects.budgetsTitle}</h2>
          <div className="card-header-spacer" />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            {budgets.length}
            {tProjects.budgetsActiveSuffix}
          </span>
        </div>

        <BudgetForm
          projectId={project.id}
          context={spendContext}
          t={t.forms.budget}
        />

        {budgets.length === 0 ? (
          <div className="empty">{tProjects.budgetsEmpty}</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{tProjects.budgetsColPeriod}</th>
                <th className="numeric">{tProjects.budgetsColLimit}</th>
                <th>{tProjects.budgetsColStatus}</th>
                <th>{tProjects.budgetsColUpdated}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {budgets.map((b) => {
                // Forecast only for the budget's PERIOD spend window. We
                // approximate "current day" with 24h and "current month"
                // with 30d — close enough for ETA copy without a new
                // SQL roundtrip per-budget. Burn rate is the recent
                // 4h average computed in spendContext.
                const periodSpend =
                  b.period === "daily"
                    ? spendContext.spend_24h_micro_cents
                    : spendContext.spend_30d_micro_cents;
                const remaining = Math.max(
                  0,
                  b.limit_micro_cents - periodSpend
                );
                const burn = spendContext.recent_hourly_burn_micro_cents;
                const hoursToExhaustion =
                  burn > 0 ? remaining / burn : null;
                return (
                  <BudgetEditableRow
                    key={b.id}
                    budget={{
                      id: b.id,
                      project_id: project.id,
                      period: b.period as "daily" | "monthly",
                      limit_micro_cents: b.limit_micro_cents,
                      enabled: b.enabled,
                      updated_at: b.updated_at,
                    }}
                    context={spendContext}
                    forecast={{
                      hours_to_exhaustion: hoursToExhaustion,
                      current_spend_micro_cents: periodSpend,
                      burn_per_hour_micro_cents: burn,
                    }}
                    t={t.forms.budget}
                  />
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      </ProjectSection>

      {/* ================= Routing rules ================= */}
      <ProjectSection id="routing">
      <div className="card">
        <div className="card-header">
          <h2>{tProjects.routingTitle}</h2>
          <div className="card-header-spacer" />
          <Link
            href={`/projects/${project.id}/policy`}
            style={{ fontSize: 12, color: "var(--text-muted)" }}
            title={tProjects.routingPolicyChangelogTooltip}
          >
            {tProjects.routingPolicyChangelog}
          </Link>
          <Link
            href={`/projects/${project.id}/classifier`}
            style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: 12 }}
            title={tProjects.routingClassifierChangelogTooltip}
          >
            {tProjects.routingClassifierChangelog}
          </Link>
          <span style={{ color: "var(--text-muted)", fontSize: 12, marginLeft: 12 }}>
            {routingRules.length}
            {tProjects.routingConfiguredSuffix}
          </span>
        </div>

        <RoutingRuleForm projectId={project.id} t={t.forms.routing} />

        {routingRules.length === 0 ? (
          <div className="empty">{tProjects.routingEmpty}</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{tProjects.routingColMode}</th>
                <th>{tProjects.routingColFromPattern}</th>
                <th>{tProjects.routingColToModel}</th>
                <th>{tProjects.routingColShadow}</th>
                <th className="numeric">{tProjects.routingColThreshold}</th>
                <th>{tProjects.routingColSample}</th>
                <th>{tProjects.routingColStatus}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {routingRules.map((r) => (
                <RoutingRuleEditableRow
                  key={r.id}
                  rule={{
                    id: r.id,
                    project_id: project.id,
                    enabled: r.enabled,
                    threshold: r.threshold,
                    from_pattern: r.from_pattern,
                    to_model: r.to_model,
                    shadow_to_model: r.shadow_to_model,
                    mode: r.mode,
                    sample_rate: r.sample_rate,
                  }}
                  t={t.forms.routing}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
      </ProjectSection>

      {/* ================= Alert subscriptions ================= */}
      <ProjectSection id="alerts">
      <div className="card">
        <div className="card-header">
          <h2>{tProjects.alertsTitle}</h2>
          <div className="card-header-spacer" />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            {alertRules.length}
            {tProjects.alertsSubscribedSuffix}
          </span>
        </div>

        {/* Lifted to a Client Component so we can keep React state
            across saves (revalidatePath, no redirect) and surface a
            transient "✓ Saved" pill — same UX as Routing rules and
            Budgets. `eventTypes` is plumbed in instead of imported
            directly inside the Client Component, because pulling the
            runtime const from `@/lib/db` would drag postgres into the
            client bundle. See `apps/dashboard/src/components/AlertRuleForm.tsx`. */}
        <AlertRuleForm
          projectId={project.id}
          eventTypes={ALERT_EVENT_TYPES}
          t={t.forms.alert}
          tEvents={t.forms.alertEvents}
        />
        <div
          style={{
            margin: "0 0 12px",
            color: "var(--text-muted)",
            fontSize: 11.5,
            display: "grid",
            gap: 8,
          }}
        >
          {/* Email-delivery posture. The previous version dumped
              RESEND_API_KEY / RESEND_FROM env-var names straight into
              the user-facing notice — fine for self-hosted operators,
              terrifying for hosted-mode end users who can't change
              gateway env vars. Split into a one-line user-friendly
              status + a collapsible <details> for operators. */}
          {alertEmailConfigured ? (
            <div
              style={{
                color: "var(--success)",
                fontWeight: 500,
                fontSize: 11.5,
              }}
            >
              {tProjects.alertsEmailOk}
              {alertEmailFrom ? (
                <>
                  {tProjects.alertsEmailOkFromPrefix}
                  <code className="code-inline">{alertEmailFrom}</code>)
                </>
              ) : null}
              .
            </div>
          ) : (
            <div>
              <div
                style={{
                  color: "var(--warning)",
                  fontWeight: 500,
                  fontSize: 11.5,
                }}
              >
                {tProjects.alertsEmailNotConfigured}
              </div>
              <details className="inline-details">
                <summary>{tProjects.alertsEmailSelfHostSummary}</summary>
                <div
                  style={{
                    marginTop: 6,
                    color: "var(--text-muted)",
                    fontSize: 11.5,
                    lineHeight: 1.5,
                  }}
                >
                  {tProjects.alertsEmailSelfHostBody}
                </div>
              </details>
            </div>
          )}
          <div>{tProjects.alertsFooter}</div>
        </div>

        {alertRules.length === 0 ? (
          <div className="empty">{tProjects.alertsEmpty}</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{tProjects.alertsColNotifyWhen}</th>
                <th>{tProjects.alertsColSendTo}</th>
                <th>{tProjects.alertsColEmail}</th>
                <th>{tProjects.alertsColStatus}</th>
                <th>{tProjects.alertsColCreated}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {alertRules.map((a) => (
                <tr key={a.id}>
                  <td>
                    {/* Same human-readable label the form's dropdown
                        uses — never the raw machine name like
                        `budget_exceeded`, which made the saved row
                        look like a different thing than the form. */}
                    <span className="pill pill-accent">
                      {describeAlertEvent(a.event_type, t.forms.alertEvents).title}
                    </span>
                  </td>
                  <td
                    style={{
                      maxWidth: 280,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={a.webhook_url ?? undefined}
                  >
                    {a.webhook_url ? (
                      <code className="code-inline">{a.webhook_url}</code>
                    ) : (
                      <span style={{ color: "var(--text-muted)" }}>—</span>
                    )}
                  </td>
                  <td className="muted">{a.email ?? "—"}</td>
                  <td>
                    <span
                      className={
                        a.enabled ? "pill pill-success" : "pill pill-neutral"
                      }
                    >
                      {a.enabled
                        ? tProjects.alertsStatusEnabled
                        : tProjects.alertsStatusDisabled}
                    </span>
                  </td>
                  <td className="muted">{fmtTime(a.created_at)}</td>
                  <td style={{ textAlign: "right" }}>
                    {/* Show Test for any rule with at least one configured
                        target (webhook OR email). Was previously gated on
                        webhook only — that left email-only rows with no
                        way to verify the Resend wiring on the gateway.

                        Inline accent color so Test reads as the helpful
                        primary action on the row (operators want to test
                        a fresh subscription) while Delete (red `btn-danger`)
                        stays as the destructive cue. Without this, Delete's
                        red drew the eye more than the safer Test action. */}
                    {(a.webhook_url || a.email) && (
                      <form
                        action={testAlertRuleAction}
                        style={{ display: "inline", marginRight: 6 }}
                      >
                        <input
                          type="hidden"
                          name="project_id"
                          value={project.id}
                        />
                        <input type="hidden" name="id" value={a.id} />
                        <button
                          type="submit"
                          className="btn btn-sm btn-ghost"
                          style={{
                            color: "var(--accent)",
                            borderColor: "var(--accent)",
                          }}
                        >
                          {tProjects.alertsTestBtn}
                        </button>
                      </form>
                    )}
                    <form
                      action={deleteAlertRuleAction}
                      style={{ display: "inline" }}
                    >
                      <input type="hidden" name="project_id" value={project.id} />
                      <input type="hidden" name="id" value={a.id} />
                      <button type="submit" className="btn btn-sm btn-danger">
                        {tProjects.alertsDeleteBtn}
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      </ProjectSection>
    </ProjectDetailLayout>
  );
}

/**
 * Format a micro_cents number as a US-dollar string suited to the magnitudes
 * that show up on a single-call smoke test (sub-cent up to a few cents).
 *
 * Local copy rather than reusing `fmtMicroCentsUsd` from policy-history.ts
 * because that helper takes `bigint` for the 30d aggregation case;
 * smoke-pair savings come from `Number` math on policy-bucket entries.
 */
function fmtMicroCentsAsUsd(uc: number): string {
  if (!Number.isFinite(uc) || uc <= 0) return "$0";
  const usd = uc / 100_000;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(6)}`;
}

/**
 * Above-the-curl explainer for the chosen smoke pair. The pair always
 * carries a (asked, route_to) tuple: asked is from one of the user's
 * BYO families (so their key gets exercised + billed) and route_to is
 * whatever the live policy says is cheapest acceptable IN A FAMILY THE
 * GATEWAY CAN ACTUALLY REACH (BYO ∪ env). The picker pre-filters route
 * candidates by reachability to mirror the runtime's exclude-and-retry
 * loop — the dashboard prediction matches what `applyBaselineRouting`
 * does at request time without asking the user to add another key just
 * to see the demo work.
 *
 * Single-BYO callers fall naturally into same-family routing
 * (claude-opus-4-7 → claude-haiku-4-5, gpt-5.5 → o4-mini, etc.) because
 * those are the cheaper bucket entries the gateway can reach. Multi-BYO
 * callers pick up cross-family routes when the cheapest reachable
 * option crosses families.
 */
function SmokePairSummary({
  smokePair,
  t,
}: {
  smokePair: SmokePair;
  t: Dictionary["projects"];
}) {
  const savedUsd = fmtMicroCentsAsUsd(
    smokePairExpectedSavingsMicroCents(smokePair)
  );
  const sameFamily = smokePair.asked.provider === smokePair.route_to.provider;
  return (
    <p
      style={{
        fontSize: 13,
        color: "var(--text-secondary)",
        margin: "0 0 10px",
        lineHeight: 1.55,
      }}
    >
      {t.smokeIntroPrefix}
      <strong>{smokePair.asked.provider}</strong>
      {t.smokeIntroFamilyMid}
      <code className="code-inline">{smokePair.asked.model}</code>
      {t.smokeIntroBucketMid}
      <code className="code-inline">{smokePair.bucket}</code>
      {t.smokeIntroBucketSuffix}
      <strong>{smokePair.asked.provider}</strong>
      {t.smokeKeyDirectPrefix}
      <code className="code-inline">{smokePair.route_to.model}</code>
      {sameFamily ? (
        <>{t.smokeSameFamilyNote}</>
      ) : (
        <> ({smokePair.route_to.provider})</>
      )}
      {t.smokeSavingsSuffix.replace("{usd}", savedUsd)}
    </p>
  );
}

/**
 * Truly-empty fallback. Only fires when the user has no provider in the
 * loaded baseline policy at all (e.g. they registered only a custom
 * upstream we haven't benchmarked, or they haven't added any provider
 * key in hosted mode and the gateway has no env credentials either). In
 * that case we can't pick a working asked model, so we step the user
 * through adding a provider whose models we've measured.
 */
function NoRoutableDemoHint({
  providerKeys,
  unlockProviderHints,
  policyVersion,
  t,
}: {
  providerKeys: ReadonlyArray<string>;
  unlockProviderHints: ReadonlyArray<string>;
  policyVersion: string | null;
  t: Dictionary["projects"];
}) {
  const presentLabel =
    providerKeys.length === 0
      ? t.noRoutableNoKey
      : t.noRoutableNoneInPolicy.replace("{keys}", providerKeys.join(", "));
  return (
    <div
      style={{
        marginTop: 16,
        padding: 12,
        border: "1px solid var(--border)",
        borderRadius: 10,
        background: "var(--surface)",
        fontSize: 13,
        color: "var(--text-secondary)",
        lineHeight: 1.55,
      }}
    >
      <strong style={{ color: "var(--text)" }}>{t.noRoutableTitle}</strong>
      <p style={{ margin: "6px 0 10px" }}>
        {t.noRoutableBody
          .replace("{prefix}", presentLabel)
          .replace("{policyVer}", policyVersion ? ` (${policyVersion})` : "")}
      </p>
      {unlockProviderHints.length > 0 && (
        <p style={{ margin: "0 0 10px" }}>
          {t.noRoutableUnlockPrefix}
          {unlockProviderHints.map((p, i) => (
            <span key={p}>
              {i > 0 &&
                (i === unlockProviderHints.length - 1
                  ? t.noRoutableUnlockOr
                  : t.noRoutableUnlockComma)}
              <strong>{p}</strong>
            </span>
          ))}
          .
        </p>
      )}
      <Link
        href="/settings#provider-keys"
        className="btn btn-sm btn-primary"
      >
        {t.noRoutableAddBtn}
      </Link>
    </div>
  );
}

/**
 * Compact "what's the policy doing for me" card for the project home.
 * Three states:
 *   - never trained        → "Shipped baseline · learning <on/off>"
 *   - trained + active     → "v17 · saved $42 last 30d · learning <on/off>"
 *   - trained + paused     → as above with a muted pill
 *
 * Always renders a Policy changelog → link so the operator can drill in.
 * Deliberately tasteful + small — this is the teaser, the real surface
 * is /projects/<id>/policy.
 */
function PolicyMiniCard({
  projectId,
  summary,
  t,
}: {
  projectId: string;
  summary: ProjectPolicySummary;
  t: Dictionary["projects"];
}) {
  const totalSaved =
    summary.routing_savings_30d_uc + summary.cache_savings_30d_uc;
  const totalSavedUsd = fmtMicroCentsUsd(totalSaved);
  const versionLabel = summary.active_version
    ? `v${summary.active_version}`
    : t.policyShippedBaseline;
  const trainedSamples = summary.active_sample_count;
  // "Onboarding" — show a different sub-line when the project is
  // paid + learning-on but has never been trained yet. The user
  // needs to know they should set up a shadow rule, not just stare
  // at a "Shipped baseline" pill forever wondering when v1 will
  // appear. (It won't appear until shadow data starts landing.)
  const needsShadowSetup =
    !summary.has_history && summary.learning_enabled;

  return (
    <div className="card">
      <div className="card-header">
        <h2>{t.policyTitle}</h2>
        <div className="card-header-spacer" />
        <Link
          href={`/projects/${projectId}/policy`}
          style={{ fontSize: 12, color: "var(--text-muted)" }}
        >
          {t.policyChangelogLink}
        </Link>
      </div>
      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          padding: "8px 0 4px",
        }}
      >
        <div>
          <div
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            {t.policyActiveLabel}
          </div>
          <div
            style={{
              fontSize: 18,
              fontWeight: 600,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {versionLabel}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {summary.active_version
              ? `${t.policyTrainedSamplesPrefix}${trainedSamples.toLocaleString()}${trainedSamples === 1 ? t.policyTrainedSamplesSingular : t.policyTrainedSamplesPlural}`
              : summary.has_history
                ? t.policyNoActive
                : t.policyNeverTrained}
          </div>
        </div>

        <div>
          <div
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            {t.policySaved30dLabel}
          </div>
          <div
            style={{
              fontSize: 18,
              fontWeight: 600,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {totalSavedUsd}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {t.policySaved30dNote}
          </div>
        </div>

        <div>
          <div
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            {t.policyLearningLabel}
          </div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>
            <span
              className={
                summary.learning_enabled ? "pill pill-success" : "pill pill-neutral"
              }
              style={{ fontSize: 13 }}
            >
              {summary.learning_enabled
                ? t.policyLearningOn
                : t.policyLearningPaused}
            </span>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {summary.learning_enabled
              ? t.policyLearningOnNote
              : summary.has_history
                ? t.policyLearningFrozen
                : t.policyLearningEmptyNote}
          </div>
        </div>
      </div>

      {needsShadowSetup && (
        <div
          style={{
            marginTop: 12,
            paddingTop: 10,
            borderTop: "1px solid var(--border)",
            fontSize: 12,
            color: "var(--text-muted)",
          }}
        >
          {t.policyShadowSetupBodyPrefix}
          <a href="#routing" style={{ color: "var(--text-secondary)" }}>
            {t.policyShadowSetupRoutingLink}
          </a>
          {t.policyShadowSetupMid}
          <Link
            href={`/projects/${projectId}/policy`}
            style={{ color: "var(--text-secondary)" }}
          >
            {t.policyShadowSetupPolicyLink}
          </Link>
          {t.policyShadowSetupSuffix}
        </div>
      )}
    </div>
  );
}
