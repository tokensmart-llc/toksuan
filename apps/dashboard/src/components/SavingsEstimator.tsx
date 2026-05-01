"use client";

import { useMemo, useState } from "react";
import { getDocsHomeUrl, getDocsUrl } from "@/lib/docs-url";
import type { Dictionary } from "@/i18n/types";

/**
 * Public + signed-in savings calculator. Lives at /estimate (linked from the
 * top nav for logged-in users; also publicly reachable for prospects).
 *
 * Two estimation modes:
 *
 *   1. "Quick estimate" — two inputs (monthly spend + workload type chip),
 *      multiplied by a conservative planning range derived from the v0.0.9
 *      baseline-policy run. Good for prospects who don't want to dig up
 *      usage data; not a promise of production savings.
 *
 *   2. "Upload usage CSV" — paste or upload an OpenAI / Anthropic usage
 *      export (downloadable from each provider's billing dashboard). We
 *      parse it CLIENT-SIDE (never uploaded to TokSuan's servers — the
 *      file stays in the user's browser), apply a per-model savings
 *      heuristic, and show the breakdown by model.
 *
 * The per-model heuristic classifies models into three tiers:
 *
 *   - Frontier (gpt-5*, claude-opus*, o3/o4*) — 35–55% potential routing
 *     savings (most of these calls can be downgraded to a mid-tier model
 *     while staying within the v0.0.9 5-bucket Pareto policy)
 *   - Mid-tier (gpt-4o, sonnet-3.5/3.7, gemini-pro) — 20–35% routing
 *     savings (route trivial prompts to mini/haiku/flash)
 *   - Cheap (mini, haiku, flash, deepseek-chat) — 0–5% routing savings
 *     (already cheap; gains come from prompt-cache mostly)
 *
 * Anthropic family models get a +10–18% cache_control bonus on top of
 * routing savings (this is what the gateway auto-injects via the
 * cache-control feature in v0.0.2).
 *
 * The CSV parser is intentionally tiny + permissive — it accepts any CSV
 * with case-insensitive matching for `model`/`model_name` and
 * `cost`/`cost_usd`/`amount_usd`/`total_cost` column headers. Other columns
 * are ignored.
 *
 * Cost (intentionally NOT computed): we don't compute cost from token
 * counts when the cost column is missing — that would require shipping
 * a per-model price table that goes stale immediately. Better to prompt
 * the user to use a CSV variant that has cost included.
 */

type EstimateMode = "quick" | "csv";

type Workload = "agent" | "ide" | "chat" | "mixed";

type Tt = Dictionary["estimator"];

/**
 * Numeric planning ranges per workload bucket. Labels + explainer copy
 * live in the dictionary so they translate cleanly without duplicating
 * the percentages on each side.
 */
const SAVINGS_RANGES: Record<
  Workload,
  { lowPct: number; highPct: number; labelKey: keyof Tt; explainerKey: keyof Tt }
> = {
  agent: {
    lowPct: 35,
    highPct: 70,
    labelKey: "workloadAgentLabel",
    explainerKey: "workloadAgentExplainer",
  },
  ide: {
    lowPct: 30,
    highPct: 60,
    labelKey: "workloadIdeLabel",
    explainerKey: "workloadIdeExplainer",
  },
  chat: {
    lowPct: 25,
    highPct: 55,
    labelKey: "workloadChatLabel",
    explainerKey: "workloadChatExplainer",
  },
  mixed: {
    lowPct: 20,
    highPct: 50,
    labelKey: "workloadMixedLabel",
    explainerKey: "workloadMixedExplainer",
  },
};

function fmtUsd(n: number): string {
  if (n >= 10000) return `$${(n / 1000).toFixed(1)}k`;
  if (n >= 1000) return `$${n.toFixed(0)}`;
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// ---------------------------------------------------------------------------
// Per-model savings heuristic (CSV mode)
// ---------------------------------------------------------------------------

type ModelClass = "frontier" | "mid" | "cheap" | "unknown";

type ModelSavingProfile = {
  /** Estimated routing-savings percentage. */
  routingPct: number;
  /** Estimated cache-savings percentage (Anthropic family gets a bonus). */
  cachePct: number;
  /** Combined upper bound — capped at 80% to avoid runaway estimates. */
  combinedPct: number;
  tier: ModelClass;
};

function classifyModel(model: string): ModelSavingProfile {
  const m = model.toLowerCase();

  // Anthropic family — auto cache_control gives a real boost, but keep the
  // estimator conservative until the user's own dashboard proves more.
  const anthropicCacheBonus = /claude/i.test(m) ? 18 : 5;

  // Frontier models — most routable to mid-tier
  if (/gpt-5|opus|o[34]-|gemini-.*-ultra/.test(m)) {
    const routing = 45;
    return {
      routingPct: routing,
      cachePct: anthropicCacheBonus,
      combinedPct: clamp(routing + anthropicCacheBonus * 0.4, 0, 65),
      tier: "frontier",
    };
  }

  // Mid-tier — route trivial prompts to mini/haiku/flash
  // gpt-4o (without -mini), sonnet, gemini-pro, deepseek-reasoner
  if (
    /gpt-4o(?!-mini)|sonnet|gemini-2\.5-pro|deepseek-reasoner|qwen.*max|gpt-4-turbo/.test(
      m
    )
  ) {
    const routing = 28;
    return {
      routingPct: routing,
      cachePct: anthropicCacheBonus,
      combinedPct: clamp(routing + anthropicCacheBonus * 0.5, 0, 55),
      tier: "mid",
    };
  }

  // Already cheap — minimal routing potential, gains come from cache
  if (
    /mini|haiku|flash|deepseek-chat|qwen.*turbo|3\.5-turbo|nano|small/.test(m)
  ) {
    const routing = 3;
    return {
      routingPct: routing,
      cachePct: anthropicCacheBonus,
      combinedPct: clamp(routing + anthropicCacheBonus * 0.6, 0, 30),
      tier: "cheap",
    };
  }

  // Unknown / unclassified — assume mid-tier conservatively
  return {
    routingPct: 20,
    cachePct: anthropicCacheBonus,
    combinedPct: clamp(20 + anthropicCacheBonus * 0.4, 0, 45),
    tier: "unknown",
  };
}

// ---------------------------------------------------------------------------
// CSV parser — intentionally tiny + permissive
// ---------------------------------------------------------------------------

type CsvRow = {
  model: string;
  costUsd: number;
};

type CsvAnalysis = {
  rows: CsvRow[];
  totalCostUsd: number;
  /** Per-model rollup with savings estimate. */
  byModel: Array<{
    model: string;
    costUsd: number;
    estSavedUsd: number;
    profile: ModelSavingProfile;
  }>;
  totalEstSavedUsd: number;
  /** What fraction of the input rows we successfully parsed. */
  parseRate: number;
  rowCountSeen: number;
};

/**
 * Find a column index by case-insensitive partial header match.
 * Returns -1 if no header matches any of the candidates.
 */
function findColIndex(headers: string[], candidates: string[]): number {
  const lc = headers.map((h) => h.trim().toLowerCase());
  for (const c of candidates) {
    const cl = c.toLowerCase();
    const i = lc.findIndex((h) => h === cl);
    if (i >= 0) return i;
  }
  // Fallback to partial match
  for (const c of candidates) {
    const cl = c.toLowerCase();
    const i = lc.findIndex((h) => h.includes(cl));
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Minimal CSV split that handles quoted fields with embedded commas.
 * Not a full RFC 4180 parser (no escaped quotes, no multiline fields)
 * but enough for the OpenAI / Anthropic / OpenRouter usage exports we
 * actually see in practice.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === "," && !inQuote) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim().replace(/^"|"$/g, ""));
}

function parseUsageCsv(text: string | null): CsvAnalysis | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;

  const headers = splitCsvLine(lines[0]);
  const modelIdx = findColIndex(headers, [
    "model",
    "model_name",
    "model_id",
    "engine",
  ]);
  const costIdx = findColIndex(headers, [
    "cost_usd",
    "cost",
    "amount_usd",
    "amount",
    "total_cost",
    "total_cost_usd",
    "spend",
    "spend_usd",
    "usd",
  ]);

  if (modelIdx < 0 || costIdx < 0) {
    return {
      rows: [],
      totalCostUsd: 0,
      byModel: [],
      totalEstSavedUsd: 0,
      parseRate: 0,
      rowCountSeen: lines.length - 1,
    };
  }

  const rows: CsvRow[] = [];
  let parsed = 0;
  let seen = 0;
  for (let i = 1; i < lines.length; i++) {
    seen++;
    const cols = splitCsvLine(lines[i]);
    if (cols.length <= Math.max(modelIdx, costIdx)) continue;
    const model = cols[modelIdx];
    const costStr = cols[costIdx].replace(/[$,\s]/g, "");
    const cost = Number(costStr);
    if (!model || !Number.isFinite(cost) || cost < 0) continue;
    rows.push({ model, costUsd: cost });
    parsed++;
  }

  // Group by model
  const groupMap = new Map<string, number>();
  for (const r of rows) {
    groupMap.set(r.model, (groupMap.get(r.model) ?? 0) + r.costUsd);
  }
  const byModel = [...groupMap.entries()]
    .map(([model, costUsd]) => {
      const profile = classifyModel(model);
      const estSavedUsd = (costUsd * profile.combinedPct) / 100;
      return { model, costUsd, estSavedUsd, profile };
    })
    .sort((a, b) => b.costUsd - a.costUsd);

  const totalCostUsd = byModel.reduce((acc, r) => acc + r.costUsd, 0);
  const totalEstSavedUsd = byModel.reduce(
    (acc, r) => acc + r.estSavedUsd,
    0
  );

  return {
    rows,
    totalCostUsd,
    byModel,
    totalEstSavedUsd,
    parseRate: seen === 0 ? 0 : parsed / seen,
    rowCountSeen: seen,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface SavingsEstimatorProps {
  /** Localised strings — pass `t.estimator` from a server page. */
  t: Tt;
}

export function SavingsEstimator({
  t,
}: SavingsEstimatorProps): React.ReactElement {
  const [mode, setMode] = useState<EstimateMode>("quick");

  // Quick mode state
  const [monthlySpendStr, setMonthlySpendStr] = useState("1000");
  const [workload, setWorkload] = useState<Workload>("mixed");

  // CSV mode state
  const [csvText, setCsvText] = useState<string | null>(null);
  const [csvFilename, setCsvFilename] = useState<string | null>(null);
  const [csvParseError, setCsvParseError] = useState<string | null>(null);

  const monthlySpend = useMemo(() => {
    const n = Number(monthlySpendStr);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [monthlySpendStr]);

  const csvAnalysis = useMemo(() => parseUsageCsv(csvText), [csvText]);

  const range = SAVINGS_RANGES[workload];

  // Pick the dollar number we'll use for the result hero, based on mode.
  const { lowSaving, highSaving, midSaving, baseSpend, sourceLabel } = useMemo(() => {
    if (mode === "csv" && csvAnalysis && csvAnalysis.byModel.length > 0) {
      const total = csvAnalysis.totalEstSavedUsd;
      // CSV-derived estimates are more precise — show a tighter ±20% band
      // around the heuristic instead of the wide quick-estimate range.
      return {
        lowSaving: total * 0.8,
        highSaving: total * 1.2,
        midSaving: total,
        baseSpend: csvAnalysis.totalCostUsd,
        sourceLabel: t.resultSourceCsv.replace(
          "{n}",
          String(csvAnalysis.rowCountSeen)
        ),
      };
    }
    return {
      lowSaving: (monthlySpend * range.lowPct) / 100,
      highSaving: (monthlySpend * range.highPct) / 100,
      midSaving:
        ((monthlySpend * range.lowPct) / 100 +
          (monthlySpend * range.highPct) / 100) /
        2,
      baseSpend: monthlySpend,
      sourceLabel: t.resultSourceQuick.replace(
        "{label}",
        t[range.labelKey] as string
      ),
    };
  }, [mode, csvAnalysis, monthlySpend, range, t]);

  const PRO_PLAN_USD = 29;
  const TEAM_PLAN_USD = 99;
  const SCALE_PLAN_USD = 499;
  const dailyMidSaving = midSaving / 30;
  const proPaybackDays =
    dailyMidSaving > 0
      ? clamp(PRO_PLAN_USD / dailyMidSaving, 0.1, 31)
      : null;
  const teamPaybackDays =
    dailyMidSaving > 0
      ? clamp(TEAM_PLAN_USD / dailyMidSaving, 0.1, 31)
      : null;
  const scalePaybackDays =
    dailyMidSaving > 0
      ? clamp(SCALE_PLAN_USD / dailyMidSaving, 0.1, 31)
      : null;
  const scaleWorthwhile = midSaving >= 1_500;
  const enoughVolume = baseSpend >= 50;

  function onCsvFile(file: File): void {
    setCsvParseError(null);
    setCsvFilename(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      setCsvText(text);
      const parsed = parseUsageCsv(text);
      if (parsed && parsed.byModel.length === 0) {
        setCsvParseError(t.csvErrorMissingColsFile);
      }
    };
    reader.onerror = () => {
      setCsvParseError(t.csvErrorParseFile);
    };
    reader.readAsText(file);
  }

  function pasteCsv(text: string): void {
    setCsvFilename(t.csvFilenamePasted);
    setCsvText(text);
    setCsvParseError(null);
    const parsed = parseUsageCsv(text);
    if (parsed && parsed.byModel.length === 0) {
      setCsvParseError(t.csvErrorMissingColsPaste);
    }
  }

  function tierLabel(tier: ModelClass): string {
    switch (tier) {
      case "frontier":
        return t.breakdownTierFrontier;
      case "mid":
        return t.breakdownTierMid;
      case "cheap":
        return t.breakdownTierCheap;
      case "unknown":
        return t.breakdownTierUnknown;
    }
  }

  function tierWhy(tier: ModelClass): string {
    switch (tier) {
      case "frontier":
        return t.breakdownWhyFrontier;
      case "mid":
        return t.breakdownWhyMid;
      case "cheap":
        return t.breakdownWhyCheap;
      case "unknown":
        return t.breakdownWhyUnknown;
    }
  }

  return (
    <div style={{ display: "grid", gap: 24 }}>
      {/* Mode tabs */}
      <div
        style={{
          display: "flex",
          gap: 4,
          borderBottom: "1px solid var(--border)",
          paddingBottom: 0,
        }}
      >
        {(
          [
            { id: "quick" as const, label: t.modeQuick },
            { id: "csv" as const, label: t.modeCsv },
          ]
        ).map((tab) => {
          const active = mode === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setMode(tab.id)}
              style={{
                padding: "10px 16px",
                background: "transparent",
                border: "none",
                borderBottom: active
                  ? "2px solid var(--accent)"
                  : "2px solid transparent",
                color: active ? "var(--text)" : "var(--text-secondary)",
                cursor: "pointer",
                fontSize: 14,
                fontWeight: active ? 600 : 400,
                marginBottom: -1,
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* QUICK MODE */}
      {mode === "quick" && (
        <div className="card">
          <div className="card-header">
            <h2>{t.quickTitle}</h2>
          </div>
          <div style={{ display: "grid", gap: 18 }}>
            <div>
              <label
                htmlFor="monthly-spend"
                style={{
                  display: "block",
                  fontSize: 13,
                  color: "var(--text-secondary)",
                  marginBottom: 6,
                }}
              >
                {t.quickSpendLabel}
              </label>
              <div
                style={{ display: "flex", alignItems: "center", gap: 10 }}
              >
                <span
                  style={{
                    fontSize: 18,
                    color: "var(--text-muted)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  $
                </span>
                <input
                  id="monthly-spend"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step={50}
                  value={monthlySpendStr}
                  onChange={(e) => setMonthlySpendStr(e.target.value)}
                  placeholder="1000"
                  style={{
                    fontSize: 18,
                    padding: "8px 12px",
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                    background: "var(--surface)",
                    color: "var(--text)",
                    fontFamily: "var(--font-mono)",
                    width: 200,
                  }}
                />
                <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
                  {t.quickSpendPerMonth}
                </span>
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  marginTop: 6,
                }}
              >
                {t.quickSpendHintPrefix}
                <strong style={{ marginLeft: 6 }}>
                  {t.quickSpendHintEmphasis}
                </strong>
              </div>
            </div>

            <div>
              <div
                style={{
                  fontSize: 13,
                  color: "var(--text-secondary)",
                  marginBottom: 8,
                }}
              >
                {t.quickWorkloadPrompt}
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: 10,
                }}
              >
                {(
                  Object.entries(SAVINGS_RANGES) as [
                    Workload,
                    typeof range,
                  ][]
                ).map(([key, r]) => {
                  const active = workload === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setWorkload(key)}
                      style={{
                        textAlign: "left",
                        padding: "10px 12px",
                        borderRadius: 8,
                        border: active
                          ? "1px solid var(--accent)"
                          : "1px solid var(--border)",
                        background: active
                          ? "var(--accent-weak)"
                          : "var(--surface)",
                        color: "var(--text)",
                        cursor: "pointer",
                        fontSize: 13,
                        lineHeight: 1.4,
                      }}
                    >
                      <div style={{ fontWeight: 500, marginBottom: 4 }}>
                        {t[r.labelKey] as string}
                      </div>
                      <div
                        style={{
                          color: "var(--text-muted)",
                          fontSize: 11,
                          fontFamily: "var(--font-mono)",
                        }}
                      >
                        {t.quickPlanningRangePrefix}
                        {r.lowPct}–{r.highPct}
                        {t.quickPlanningRangeSuffix}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* CSV MODE */}
      {mode === "csv" && (
        <div className="card">
          <div className="card-header">
            <h2>{t.csvTitle}</h2>
          </div>
          <p
            style={{
              fontSize: 13,
              color: "var(--text-secondary)",
              lineHeight: 1.55,
              margin: "0 0 14px 0",
            }}
          >
            {t.csvIntroPrefix}
            <strong>{t.csvIntroEmphasis}</strong>
            {t.csvIntroSuffix}
          </p>
          <ul
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              margin: "0 0 14px 18px",
              padding: 0,
              lineHeight: 1.6,
            }}
          >
            <li>
              <strong>OpenAI</strong>:{" "}
              <a
                href="https://platform.openai.com/usage"
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--accent)" }}
              >
                platform.openai.com/usage
              </a>
              {t.csvSourceOpenAI}
            </li>
            <li>
              <strong>Anthropic</strong>:{" "}
              <a
                href="https://console.anthropic.com/settings/billing"
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--accent)" }}
              >
                console.anthropic.com/settings/billing
              </a>
              {t.csvSourceAnthropic}
            </li>
            <li>
              <strong>OpenRouter</strong>:{" "}
              <a
                href="https://openrouter.ai/activity"
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--accent)" }}
              >
                openrouter.ai/activity
              </a>
              {t.csvSourceOpenRouter}
            </li>
            <li>
              <strong>DeepSeek</strong>:{" "}
              <a
                href="https://platform.deepseek.com/usage"
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--accent)" }}
              >
                platform.deepseek.com/usage
              </a>
              {t.csvSourceDeepSeekSuffix}
            </li>
            <li>
              <strong>Qwen / 阿里百炼</strong>:{" "}
              <a
                href="https://usercenter2.aliyun.com/finance/expense-report/expense-detail"
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--accent)" }}
              >
                aliyun.com → 费用 → 账单详情
              </a>
              {t.csvSourceQwenSuffix}
            </li>
            <li>
              <strong>Doubao / 火山引擎豆包</strong>:{" "}
              <a
                href="https://console.volcengine.com/finance/bill/detail"
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--accent)" }}
              >
                console.volcengine.com/finance/bill/detail
              </a>
              {t.csvSourceDoubaoSuffix}
            </li>
            <li>
              <strong>Google / Gemini</strong>:{" "}
              <a
                href="https://aistudio.google.com/usage"
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--accent)" }}
              >
                aistudio.google.com/usage
              </a>
              {t.csvSourceGoogleSuffix}
            </li>
            <li>{t.csvSourceColumnsHint}</li>
          </ul>

          <div style={{ display: "grid", gap: 14 }}>
            <div>
              <label
                htmlFor="csv-file"
                style={{
                  display: "inline-block",
                  padding: "10px 16px",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--surface)",
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                {t.csvChooseFile}
              </label>
              <input
                id="csv-file"
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onCsvFile(f);
                }}
                style={{ display: "none" }}
              />
              {csvFilename && (
                <span
                  style={{
                    marginLeft: 12,
                    fontSize: 12,
                    color: "var(--text-muted)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {csvFilename}
                  {csvAnalysis && csvAnalysis.byModel.length > 0 && (
                    <>
                      {" · "}
                      {csvAnalysis.rowCountSeen}
                      {t.csvFileMetaRows} ·{" "}
                      {csvAnalysis.byModel.length}
                      {t.csvFileMetaModels}
                    </>
                  )}
                </span>
              )}
            </div>

            <div
              style={{ fontSize: 12, color: "var(--text-muted)" }}
            >
              {t.csvOrPaste}
            </div>

            <textarea
              placeholder={t.csvPastePlaceholder}
              rows={6}
              onChange={(e) => pasteCsv(e.target.value)}
              style={{
                width: "100%",
                padding: 10,
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--surface)",
                color: "var(--text)",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                resize: "vertical",
              }}
            />

            {csvParseError && (
              <div
                style={{
                  padding: 12,
                  borderRadius: 8,
                  border: "1px solid var(--warning)",
                  background: "var(--surface)",
                  fontSize: 12,
                  color: "var(--warning)",
                  lineHeight: 1.5,
                }}
              >
                {csvParseError}
              </div>
            )}
          </div>
        </div>
      )}

      {/* RESULT — shared between modes */}
      <div className="savings-hero">
        <div>
          <div className="savings-hero-label">{t.resultLabel}</div>
          <div className="savings-hero-value">
            {enoughVolume ? (
              <>
                {fmtUsd(lowSaving)}
                <span
                  style={{
                    fontSize: 24,
                    color: "var(--text-muted)",
                    margin: "0 8px",
                  }}
                >
                  –
                </span>
                {fmtUsd(highSaving)}
              </>
            ) : (
              <span style={{ color: "var(--text-muted)" }}>—</span>
            )}
          </div>
          <div className="savings-hero-sub">
            {enoughVolume ? (
              <>
                <strong>
                  {t.resultMidpointPrefix}
                  {fmtUsd(midSaving)}
                  {t.resultMidpointSuffix}
                </strong>
                {t.resultBasedOnPrefix}
                {fmtUsd(midSaving * 12)}
                {t.resultBasedOnSuffix.replace("{source}", sourceLabel)}
              </>
            ) : (
              <>
                {t.resultMinSpendPrefix}
                <strong>{t.resultMinSpendEmphasis}</strong>
                {t.resultMinSpendSuffix}
              </>
            )}
          </div>
        </div>
        {enoughVolume && (
          <div className="savings-hero-breakdown">
            <div className="savings-hero-breakdown-item">
              <div className="savings-hero-breakdown-label">
                {t.paybackProLabel}
              </div>
              <div className="savings-hero-breakdown-value">
                {proPaybackDays != null && proPaybackDays < 31 ? (
                  <>
                    {t.paybackPaysBackPrefix}
                    <strong>
                      {proPaybackDays < 1
                        ? `${(proPaybackDays * 24).toFixed(1)}${t.paybackHoursUnit}`
                        : `${proPaybackDays.toFixed(1)}${t.paybackDaysUnit}`}
                    </strong>
                  </>
                ) : (
                  <span style={{ color: "var(--text-muted)" }}>
                    {t.paybackNa}
                  </span>
                )}
              </div>
              <div className="savings-hero-breakdown-note">
                {t.paybackProNote}
              </div>
            </div>
            <div className="savings-hero-breakdown-item">
              <div className="savings-hero-breakdown-label">
                {t.paybackTeamLabel}
              </div>
              <div className="savings-hero-breakdown-value">
                {teamPaybackDays != null && teamPaybackDays < 31 ? (
                  <>
                    {t.paybackPaysBackPrefix}
                    <strong>
                      {teamPaybackDays < 1
                        ? `${(teamPaybackDays * 24).toFixed(1)}${t.paybackHoursUnit}`
                        : `${teamPaybackDays.toFixed(1)}${t.paybackDaysUnit}`}
                    </strong>
                  </>
                ) : (
                  <span style={{ color: "var(--text-muted)" }}>
                    {t.paybackNa}
                  </span>
                )}
              </div>
              <div className="savings-hero-breakdown-note">
                {t.paybackTeamNote}
              </div>
            </div>
            {scaleWorthwhile && (
              <div className="savings-hero-breakdown-item">
                <div className="savings-hero-breakdown-label">
                  {t.paybackScaleLabel}
                </div>
                <div className="savings-hero-breakdown-value">
                  {scalePaybackDays != null && scalePaybackDays < 31 ? (
                    <>
                      {t.paybackPaysBackPrefix}
                      <strong>
                        {scalePaybackDays < 1
                          ? `${(scalePaybackDays * 24).toFixed(1)}${t.paybackHoursUnit}`
                          : `${scalePaybackDays.toFixed(1)}${t.paybackDaysUnit}`}
                      </strong>
                    </>
                  ) : (
                    <span style={{ color: "var(--text-muted)" }}>
                      {t.paybackNa}
                    </span>
                  )}
                </div>
                <div className="savings-hero-breakdown-note">
                  {t.paybackScaleNote}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Per-model breakdown — only in CSV mode */}
      {mode === "csv" &&
        csvAnalysis &&
        csvAnalysis.byModel.length > 0 && (
          <div className="card">
            <div className="card-header">
              <h2>{t.breakdownTitle}</h2>
              <div className="card-header-spacer" />
              <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                {t.breakdownFromCsvSuffix.replace(
                  "{n}",
                  String(csvAnalysis.rowCountSeen)
                )}
              </span>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.breakdownColModel}</th>
                  <th>{t.breakdownColTier}</th>
                  <th className="numeric">{t.breakdownColSpent}</th>
                  <th className="numeric">{t.breakdownColEstSaved}</th>
                  <th className="numeric">{t.breakdownColSavedPct}</th>
                  <th>{t.breakdownColWhy}</th>
                </tr>
              </thead>
              <tbody>
                {csvAnalysis.byModel.slice(0, 30).map((row) => {
                  const pct =
                    row.costUsd > 0
                      ? (row.estSavedUsd / row.costUsd) * 100
                      : 0;
                  const tierColor =
                    row.profile.tier === "frontier"
                      ? "var(--success)"
                      : row.profile.tier === "mid"
                        ? "var(--accent)"
                        : row.profile.tier === "cheap"
                          ? "var(--text-muted)"
                          : "var(--text-secondary)";
                  return (
                    <tr key={row.model}>
                      <td>
                        <code className="code-inline">{row.model}</code>
                      </td>
                      <td>
                        <span
                          className="pill pill-neutral"
                          style={{ color: tierColor, fontSize: 11 }}
                        >
                          {tierLabel(row.profile.tier)}
                        </span>
                      </td>
                      <td className="numeric">{fmtUsd(row.costUsd)}</td>
                      <td
                        className="numeric"
                        style={{ color: "var(--success)" }}
                      >
                        {fmtUsd(row.estSavedUsd)}
                      </td>
                      <td
                        className="numeric"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {pct.toFixed(0)}%
                      </td>
                      <td
                        className="muted"
                        style={{ fontSize: 12, lineHeight: 1.4 }}
                      >
                        {tierWhy(row.profile.tier)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {csvAnalysis.byModel.length > 30 && (
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  marginTop: 8,
                }}
              >
                {t.breakdownTopNFooter.replace(
                  "{total}",
                  String(csvAnalysis.byModel.length)
                )}
              </div>
            )}
          </div>
        )}

      <div className="card">
        <div className="card-header">
          <h2>{t.howTitle}</h2>
        </div>
        <p
          style={{ fontSize: 14, lineHeight: 1.6, color: "var(--text-secondary)" }}
        >
          {mode === "csv" && csvAnalysis && csvAnalysis.byModel.length > 0
            ? t.howCsvBody
            : (t[range.explainerKey] as string)}
        </p>
        <p
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            marginTop: 12,
            lineHeight: 1.6,
          }}
        >
          {t.howFooter}
        </p>
        <p
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            marginTop: 10,
            lineHeight: 1.6,
          }}
        >
          {t.howSelfHostNote}
        </p>
      </div>

      <div className="card">
        <div className="card-header">
          <h2>{t.notYetTitle}</h2>
        </div>
        <ul
          style={{
            fontSize: 13,
            color: "var(--text-secondary)",
            lineHeight: 1.6,
            margin: "0 0 0 18px",
            padding: 0,
          }}
        >
          <li>
            {t.notYetUnder50Prefix}
            <strong>{t.notYetUnder50Spend}</strong>
            {t.notYetUnder50AmountPrefix}
            <a
              href={getDocsUrl("QUICKSTART.md#self-host--production")}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent)" }}
            >
              {t.notYetUnder50Link}
            </a>
            {t.notYetUnder50Suffix}
          </li>
          <li>{t.notYetCheapModels}</li>
          <li>
            {t.notYetSlaPrefix}
            <a
              href={getDocsUrl("docs/production-runbook.md")}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent)" }}
            >
              {t.notYetSlaLink1}
            </a>
            {t.notYetSlaMid}
            <a
              href="https://github.com/tokensmart-llc/toksuan/issues/new/choose"
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent)" }}
            >
              {t.notYetSlaLink2}
            </a>
            {t.notYetSlaSuffix}
          </li>
          <li>{t.notYetByo}</li>
        </ul>
      </div>

      <div className="card">
        <div className="card-header">
          <h2>{t.ctaTitle}</h2>
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.6 }}>{t.ctaBody}</p>
        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <a
            href="/login"
            className="btn btn-primary"
            style={{ textDecoration: "none" }}
          >
            {t.ctaStartFree}
          </a>
          <a
            href={getDocsHomeUrl()}
            target="_blank"
            rel="noreferrer"
            className="btn"
            style={{ textDecoration: "none" }}
          >
            {t.ctaSelfHostDocs}
          </a>
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            marginTop: 14,
            lineHeight: 1.5,
          }}
        >
          {t.ctaFinePrintPrefix}
          <code style={{ fontFamily: "var(--font-mono)" }}>
            {t.ctaFinePrintCode}
          </code>
          {t.ctaFinePrintSuffix}
        </div>
      </div>
    </div>
  );
}
