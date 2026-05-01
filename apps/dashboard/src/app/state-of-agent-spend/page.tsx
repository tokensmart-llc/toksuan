import fs from "node:fs/promises";
import path from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { LanguageToggle } from "@/components/LanguageToggle";
import { getSession, isAuthEnabled } from "@/lib/auth";
import {
  fetchBaselinePolicyMirror,
  type BaselinePolicyMirror,
  type PolicyBucketMirror,
  type PolicyModelMirror,
} from "@/lib/baseline-policy-mirror";
import { getDocsUrl } from "@/lib/docs-url";
import { getDictionary } from "@/lib/i18n.server";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getDictionary();
  return {
    title: t.stateOfSpend.metaTitle,
    description: t.stateOfSpend.metaDescription,
  };
}

export const dynamic = "force-dynamic";
export const revalidate = 0;

type LocalPolicyArtifact = {
  version?: string | null;
  buckets?: Array<{
    task_type: string;
    complexity: string;
    max_quality: number;
    models: Array<PolicyModelMirror & { n?: number }>;
  }>;
};

type RoutingWin = {
  bucket: string;
  taskType: string;
  complexity: string;
  asked: PolicyModelMirror;
  landed: PolicyModelMirror;
  savedMicroCents: number;
  savingsPct: number;
  qualityDelta: number;
};

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
  deepseek: "DeepSeek",
  qwen: "Qwen / DashScope",
  doubao: "Doubao / Volcengine",
  openrouter: "OpenRouter",
};

/** Numeric privacy thresholds. The labels are localised at render time
 *  so the page can switch to Chinese without re-shaping this constant. */
const PRIVACY_THRESHOLD_VALUES = ["5+", "3+", "100+", "7"] as const;

function fmtMicroUsd(uc: number): string {
  const usd = uc / 100_000;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(6)}`;
}

function fmtPct(n: number): string {
  return `${Math.round(n)}%`;
}

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

function bucketLabel(bucket: RoutingWin): string {
  return `${bucket.taskType}:${bucket.complexity}`;
}

/**
 * Marketing/public page data source.
 *
 * Preferred: ask the live gateway for `/baseline-policy`, so hosted pages
 * reflect the deployed policy artifact. Fallback: read the checked-in
 * artifact from `apps/gateway/src/policy/baseline-policy.json` so `next build`
 * and local marketing pages still render when the gateway is down.
 *
 * Important product boundary: this is NOT hosted aggregate telemetry. It is a
 * public policy preview. The page labels it that way everywhere so we don't
 * imply real customer traffic before the privacy-thresholded aggregate
 * pipeline exists.
 */
async function loadPolicyPreview(): Promise<BaselinePolicyMirror | null> {
  const live = await fetchBaselinePolicyMirror();
  if (live?.enabled && live.buckets.length > 0) return live;

  try {
    const raw = await fs.readFile(
      path.join(
        process.cwd(),
        "../gateway/src/policy/baseline-policy.json"
      ),
      "utf8"
    );
    const artifact = JSON.parse(raw) as LocalPolicyArtifact;
    const buckets = artifact.buckets;
    if (!Array.isArray(buckets)) return null;
    return {
      enabled: true,
      version: artifact.version ?? null,
      env_providers: [],
      buckets: buckets.map((b) => ({
        task_type: b.task_type,
        complexity: b.complexity,
        max_quality: b.max_quality,
        models: b.models.map((m) => ({
          model: m.model,
          provider: m.provider,
          avg_cost_micro_cents: m.avg_cost_micro_cents,
          quality_score: m.quality_score,
        })),
      })),
    };
  } catch {
    return null;
  }
}

function pickWins(policy: BaselinePolicyMirror | null): RoutingWin[] {
  if (!policy?.enabled) return [];
  const wins: RoutingWin[] = [];

  for (const bucket of policy.buckets) {
    const maxQuality = bucket.max_quality;
    const qualityFloor = maxQuality - 0.2;
    const candidates = bucket.models.filter(
      (m) => m.quality_score >= qualityFloor
    );
    if (candidates.length < 2) continue;

    // Choose one expensive, credible "asked" model per provider so the table
    // doesn't turn into ten variants of the same family.
    const bestAskedByProvider = new Map<string, PolicyModelMirror>();
    for (const model of candidates) {
      const cur = bestAskedByProvider.get(model.provider);
      if (!cur || model.avg_cost_micro_cents > cur.avg_cost_micro_cents) {
        bestAskedByProvider.set(model.provider, model);
      }
    }

    for (const asked of bestAskedByProvider.values()) {
      const landed = cheapestAcceptable(bucket, candidates, asked);
      if (!landed) continue;
      const saved = asked.avg_cost_micro_cents - landed.avg_cost_micro_cents;
      if (saved <= 0) continue;
      wins.push({
        bucket: `${bucket.task_type}:${bucket.complexity}`,
        taskType: bucket.task_type,
        complexity: bucket.complexity,
        asked,
        landed,
        savedMicroCents: saved,
        savingsPct: (saved / asked.avg_cost_micro_cents) * 100,
        qualityDelta: landed.quality_score - asked.quality_score,
      });
    }
  }

  return wins
    .sort((a, b) => {
      const pct = b.savingsPct - a.savingsPct;
      if (Math.abs(pct) > 1) return pct;
      return b.savedMicroCents - a.savedMicroCents;
    })
    .slice(0, 8);
}

function cheapestAcceptable(
  bucket: PolicyBucketMirror,
  candidates: PolicyModelMirror[],
  asked: PolicyModelMirror
): PolicyModelMirror | null {
  const qualityFloor = bucket.max_quality - 0.2;
  let best: PolicyModelMirror | null = null;
  for (const model of candidates) {
    if (model.model === asked.model) continue;
    if (model.avg_cost_micro_cents >= asked.avg_cost_micro_cents) continue;
    if (model.quality_score < qualityFloor) continue;
    if (!best || model.avg_cost_micro_cents < best.avg_cost_micro_cents) {
      best = model;
    }
  }
  return best;
}

function policyStats(policy: BaselinePolicyMirror | null, wins: RoutingWin[]) {
  const providers = new Set<string>();
  const models = new Set<string>();
  for (const bucket of policy?.buckets ?? []) {
    for (const model of bucket.models) {
      providers.add(model.provider);
      models.add(model.model);
    }
  }
  const avgSavingsPct =
    wins.length > 0
      ? wins.reduce((sum, win) => sum + win.savingsPct, 0) / wins.length
      : 0;
  const maxSaved = wins.reduce(
    (max, win) => Math.max(max, win.savedMicroCents),
    0
  );
  return {
    bucketCount: policy?.buckets.length ?? 0,
    modelCount: models.size,
    providerCount: providers.size,
    avgSavingsPct,
    maxSaved,
  };
}

export default async function StateOfAgentSpendPage() {
  const session = isAuthEnabled() ? await getSession() : null;
  const { locale, t } = await getDictionary();
  const tState = t.stateOfSpend;
  const policy = await loadPolicyPreview();
  const wins = pickWins(policy);
  const stats = policyStats(policy, wins);
  const providers = [
    "OpenAI",
    "Anthropic",
    "Google",
    "DeepSeek",
    "Qwen",
    "Doubao",
    "OpenRouter",
  ];

  // Localised label list paired with the static threshold values
  // declared above. Order must match `PRIVACY_THRESHOLD_VALUES`.
  const privacyThresholds: ReadonlyArray<readonly [string, string]> = [
    [tState.privacyLabelProjects, PRIVACY_THRESHOLD_VALUES[0]],
    [tState.privacyLabelOrgs, PRIVACY_THRESHOLD_VALUES[1]],
    [tState.privacyLabelRequests, PRIVACY_THRESHOLD_VALUES[2]],
    [tState.privacyLabelWindow, PRIVACY_THRESHOLD_VALUES[3]],
  ];

  const signalCards: ReadonlyArray<readonly [string, string]> = [
    [tState.signal1Title, tState.signal1Body],
    [tState.signal2Title, tState.signal2Body],
    [tState.signal3Title, tState.signal3Body],
    [tState.signal4Title, tState.signal4Body],
  ];

  return (
    <main className="state-page">
      {/* Public marketing nav. Only rendered for anonymous visitors —
       *  signed-in users already see the global AppNav at the very top
       *  of the document, and rendering this strip on top of it produces
       *  a confusing double-nav row where the brand link points back to
       *  `/` (the public landing) instead of `/dashboard`. */}
      {!session && (
        <nav className="landing-nav" aria-label={tState.publicNavAriaLabel}>
          <Link
            href="/"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              color: "var(--text)",
              fontWeight: 700,
              textDecoration: "none",
            }}
          >
            <Logo size={30} markOnly={false} />
          </Link>
          <div style={{ flex: 1 }} />
          <Link href="/estimate" className="app-nav-link">
            {tState.navEstimate}
          </Link>
          <Link href="/trust" className="app-nav-link">
            {tState.navTrust}
          </Link>
          <LanguageToggle locale={locale} variant="landing" />
          <Link href="/login?next=/dashboard" className="btn btn-primary">
            {tState.navStart}
          </Link>
        </nav>
      )}

      <section className="state-hero">
        <div>
          <div className="brand-hero-eyebrow">{tState.eyebrow}</div>
          <h1 className="brand-hero-title">{tState.title}</h1>
          <p className="brand-hero-subtitle">{tState.subtitle}</p>
          <div className="state-hero-actions">
            <Link href="/estimate" className="btn btn-primary">
              {tState.ctaEstimate}
            </Link>
            <Link href="/trust" className="btn">
              {tState.ctaTrust}
            </Link>
          </div>
        </div>
        <div className="state-mode-card">
          <span className="pill pill-accent">{tState.modePillPreview}</span>
          <h2>{tState.modeTitle}</h2>
          <p>{tState.modeBody}</p>
          <div className="state-policy-meta">
            <span>{tState.modePolicyLabel}</span>
            <code className="code-inline">
              {policy?.version ?? tState.policyUnavailable}
            </code>
          </div>
        </div>
      </section>

      <section className="state-proof-grid" aria-label={tState.proofGridAriaLabel}>
        {[
          [String(stats.bucketCount), tState.statBuckets],
          [String(stats.modelCount), tState.statModels],
          [String(stats.providerCount), tState.statProviders],
          [
            wins.length > 0 ? fmtPct(stats.avgSavingsPct) : t.common.none,
            tState.statAvgSavings,
          ],
        ].map(([value, label]) => (
          <div key={label}>
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))}
      </section>

      <section className="landing-section">
        <div className="landing-section-heading">
          <div>
            <div className="brand-hero-eyebrow">{tState.routingWinsEyebrow}</div>
            <h2 className="landing-section-title">{tState.routingWinsTitle}</h2>
          </div>
          <Link href="/routing-quality" className="btn">
            {tState.routingWinsCta}
          </Link>
        </div>
        <p className="landing-section-copy">{tState.routingWinsBody}</p>
        {wins.length === 0 ? (
          <div className="empty" style={{ marginTop: 20 }}>
            {tState.routingWinsEmpty}
          </div>
        ) : (
          <div className="state-wins-table" role="table" aria-label={tState.routingWinsTableAriaLabel}>
            <div className="state-wins-row state-wins-head" role="row">
              <div>{tState.routingWinsAsked}</div>
              <div>{tState.routingWinsLanded}</div>
              <div>{tState.routingWinsBucket}</div>
              <div>{tState.routingWinsSavings}</div>
              <div>{tState.routingWinsGuardrail}</div>
            </div>
            {wins.map((win) => (
              <div
                className="state-wins-row"
                role="row"
                key={`${win.bucket}:${win.asked.model}:${win.landed.model}`}
              >
                <div>
                  <code className="code-inline">{win.asked.model}</code>
                  <span>{providerLabel(win.asked.provider)}</span>
                </div>
                <div>
                  <code className="code-inline">{win.landed.model}</code>
                  <span>{providerLabel(win.landed.provider)}</span>
                </div>
                <div>
                  <span className="pill pill-neutral">{bucketLabel(win)}</span>
                </div>
                <div>
                  <strong>{fmtPct(win.savingsPct)}</strong>
                  <span>
                    {fmtMicroUsd(win.savedMicroCents)}
                    {tState.routingWinsPerSampleSuffix}
                  </span>
                </div>
                <div>
                  <span className="pill pill-success">
                    {tState.routingWinsQualityPass}
                  </span>
                  <span>
                    {win.qualityDelta >= 0 ? "+" : ""}
                    {win.qualityDelta.toFixed(2)} {tState.routingWinsQualityDelta}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="landing-section state-provider-section">
        <div>
          <div className="brand-hero-eyebrow">{tState.providerEyebrow}</div>
          <h2 className="landing-section-title">{tState.providerTitle}</h2>
          <p className="landing-section-copy">{tState.providerBody}</p>
        </div>
        <div className="state-provider-wall">
          {providers.map((provider) => (
            <span key={provider}>{provider}</span>
          ))}
        </div>
      </section>

      <section className="landing-section">
        <div className="landing-section-heading">
          <div>
            <div className="brand-hero-eyebrow">{tState.telemetryEyebrow}</div>
            <h2 className="landing-section-title">{tState.telemetryTitle}</h2>
          </div>
        </div>
        <div className="state-signal-grid">
          {signalCards.map(([title, body]) => (
            <div key={title} className="state-signal-card">
              <h3>{title}</h3>
              <p>{body}</p>
            </div>
          ))}
        </div>
        <div className="state-privacy-card">
          <div>
            <h3>{tState.privacyTitle}</h3>
            <p>{tState.privacyBody}</p>
          </div>
          <div className="state-thresholds">
            {privacyThresholds.map(([label, value]) => (
              <div key={label}>
                <strong>{value}</strong>
                <span>{label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="landing-final-cta">
        <div className="brand-hero-eyebrow">{tState.finalEyebrow}</div>
        <h2>{tState.finalTitle}</h2>
        <p>{tState.finalBody}</p>
        <div>
          <Link href="/estimate" className="btn">
            {tState.finalCtaEstimate}
          </Link>
          <Link href="/login?next=/dashboard" className="btn btn-primary">
            {tState.finalCtaStart}
          </Link>
          <a
            href={getDocsUrl("examples/openclaw/README.md")}
            target="_blank"
            rel="noopener noreferrer"
            className="btn"
          >
            {tState.finalCtaOpenClaw}
          </a>
        </div>
      </section>
    </main>
  );
}
