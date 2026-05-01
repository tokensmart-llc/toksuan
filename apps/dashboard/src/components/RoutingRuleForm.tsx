"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  previewRoutingRuleAction,
  setRoutingRuleAction,
} from "@/app/projects/actions";
import type { RoutingMatchPreview, RoutingMode } from "@/lib/db";
import type { Dictionary } from "@/i18n/types";

const MICRO_PER_USD = 100_000;

// =========================================================================
// Known model catalog
// =========================================================================
//
// Curated dropdown content so users don't have to type/regex. Grouped by
// provider with rough quality/cost tier annotations to help them reason
// about routing decisions visually. Models that don't appear here can
// still be entered via the regex / "advanced" toggle.

type ModelOption = {
  value: string;
  label: string;
  /** Display tier — rendered as a colored dot next to the option. */
  tier: "frontier" | "mid" | "cheap";
};

/**
 * Curated dropdown content. Synced with the public policy-supported model
 * catalog — the models we price-track and expose in routing rules. Older
 * Claude 3.x / GPT-4o-class names are kept as
 * "legacy" so users with existing rules (or hand-typed model names)
 * keep finding them in the picker.
 *
 * Within each provider, options are roughly ordered frontier → mid →
 * cheap so the flagship is at the top. Tiers drive the colored dot
 * next to the option in the model picker; they're rough categorical
 * hints, not exact pricing tiers.
 *
 * If the policy-supported model catalog changes, keep
 * this in sync — the dropdown is the only place users SEE which models
 * are first-class citizens. Anything not here is still selectable via
 * the regex-mode toggle.
 */
const MODEL_GROUPS: Array<{ provider: string; options: ModelOption[] }> = [
  {
    provider: "OpenAI",
    options: [
      // 2026 roster
      { value: "gpt-5.5", label: "gpt-5.5", tier: "frontier" },
      { value: "gpt-4o", label: "gpt-4o", tier: "frontier" },
      { value: "o4-mini", label: "o4-mini", tier: "mid" },
      // legacy / still callable
      { value: "gpt-5.2", label: "gpt-5.2", tier: "frontier" },
      { value: "o1-preview", label: "o1-preview", tier: "frontier" },
      { value: "o1-mini", label: "o1-mini", tier: "mid" },
      { value: "gpt-4o-mini", label: "gpt-4o-mini", tier: "cheap" },
    ],
  },
  {
    provider: "Anthropic",
    options: [
      // 2026 roster
      { value: "claude-opus-4-7", label: "claude-opus-4-7", tier: "frontier" },
      { value: "claude-sonnet-4-6", label: "claude-sonnet-4-6", tier: "frontier" },
      {
        value: "claude-sonnet-4-5-20250929",
        label: "claude-sonnet-4-5",
        tier: "frontier",
      },
      {
        value: "claude-haiku-4-5-20251001",
        label: "claude-haiku-4-5",
        tier: "cheap",
      },
      // legacy
      {
        value: "claude-3-7-sonnet-latest",
        label: "claude-3-7-sonnet",
        tier: "frontier",
      },
      {
        value: "claude-3-5-sonnet-latest",
        label: "claude-3-5-sonnet",
        tier: "frontier",
      },
      {
        value: "claude-3-5-haiku-latest",
        label: "claude-3-5-haiku",
        tier: "cheap",
      },
    ],
  },
  {
    provider: "Google Gemini",
    options: [
      // 2026 roster — gemini-3.1-pro-preview is `enabled: false` in the
      // bench roster (quota-blocked) but listed here so users can still
      // configure rules anticipating it once the quota lands.
      {
        value: "gemini-3.1-pro-preview",
        label: "gemini-3.1-pro-preview",
        tier: "frontier",
      },
      {
        value: "gemini-3-flash-preview",
        label: "gemini-3-flash-preview",
        tier: "mid",
      },
      {
        value: "gemini-3.1-flash-lite-preview",
        label: "gemini-3.1-flash-lite-preview",
        tier: "cheap",
      },
      // legacy
      {
        value: "gemini-2.5-flash",
        label: "gemini-2.5-flash",
        tier: "mid",
      },
      {
        value: "gemini-2.5-flash-lite",
        label: "gemini-2.5-flash-lite",
        tier: "cheap",
      },
    ],
  },
  {
    provider: "DeepSeek",
    options: [
      // 2026 roster
      { value: "deepseek-v4-pro", label: "deepseek-v4-pro", tier: "frontier" },
      { value: "deepseek-v4-flash", label: "deepseek-v4-flash", tier: "cheap" },
      // legacy / still callable
      {
        value: "deepseek-reasoner",
        label: "deepseek-reasoner",
        tier: "mid",
      },
      { value: "deepseek-chat", label: "deepseek-chat", tier: "cheap" },
    ],
  },
  {
    provider: "Qwen",
    options: [
      // 2026 roster
      { value: "qwen3.6-plus", label: "qwen3.6-plus", tier: "mid" },
      { value: "qwen3.6-flash", label: "qwen3.6-flash", tier: "cheap" },
      { value: "qwen3-coder-plus", label: "qwen3-coder-plus", tier: "mid" },
      {
        value: "qwen3-next-80b-a3b-thinking",
        label: "qwen3-next-80b-thinking",
        tier: "mid",
      },
      // legacy
      {
        value: "qwen3-next-80b-a3b-instruct",
        label: "qwen3-next-80b-instruct",
        tier: "mid",
      },
      { value: "qwen-max", label: "qwen-max", tier: "mid" },
      { value: "qwen-plus", label: "qwen-plus", tier: "cheap" },
    ],
  },
  {
    provider: "Doubao",
    options: [
      // 2026 roster — entire group is new in the picker. Doubao isn't
      // in the legacy list at all.
      {
        value: "doubao-seed-2-0-pro-260215",
        label: "doubao-seed-2-0-pro",
        tier: "frontier",
      },
      {
        value: "doubao-seed-2-0-code-preview-260215",
        label: "doubao-seed-2-0-code",
        tier: "mid",
      },
      {
        value: "doubao-seed-2-0-lite-260215",
        label: "doubao-seed-2-0-lite",
        tier: "cheap",
      },
      {
        value: "doubao-seed-2-0-mini-260215",
        label: "doubao-seed-2-0-mini",
        tier: "cheap",
      },
    ],
  },
];

// =========================================================================
// Threshold landmark prompts
// =========================================================================
//
// Anchors the abstract 0..1 complexity score in human-readable examples so
// the user knows where to put the slider. Values are illustrative; the
// gateway's actual heuristic in classifier.ts may score these slightly
// differently in practice.

type LandmarkExampleKey =
  | "landmarkExample1"
  | "landmarkExample2"
  | "landmarkExample3"
  | "landmarkExample4"
  | "landmarkExample5"
  | "landmarkExample6";

/**
 * Six anchor scores. The `example` field is a *key* into
 * `t.forms.routing.*` so the prompt next to each chip follows the
 * locale (e.g. "你好" stays "你好" in zh, "hi" in en). Resolved at
 * render time once the dictionary is in scope.
 */
const THRESHOLD_LANDMARKS: Array<{
  score: number;
  exampleKey: LandmarkExampleKey;
}> = [
  { score: 0.05, exampleKey: "landmarkExample1" },
  { score: 0.2, exampleKey: "landmarkExample2" },
  { score: 0.4, exampleKey: "landmarkExample3" },
  { score: 0.6, exampleKey: "landmarkExample4" },
  { score: 0.8, exampleKey: "landmarkExample5" },
  { score: 0.95, exampleKey: "landmarkExample6" },
];

// =========================================================================
// Presets — the most common rules people actually want to set
// =========================================================================

type Preset = {
  id: string;
  /** Pulled from the localised dictionary at render time. */
  labelKey: "preset1Label" | "preset2Label" | "preset3Label" | "preset4Label";
  descKey: "preset1Desc" | "preset2Desc" | "preset3Desc" | "preset4Desc";
  fromPattern: string;
  toModel: string;
  threshold: number;
  mode: RoutingMode;
  shadowToModel?: string;
  /**
   * Optional preset for sample_rate. Shadow / both presets ship with
   * 0.05 so picking the preset gives the user a complete, sensible
   * shadow rule (not just a rule that fires on every match and
   * doubles their bill).
   */
  sampleRate?: number | null;
};

const PRESETS: Preset[] = [
  {
    id: "gpt-cheap",
    labelKey: "preset1Label",
    descKey: "preset1Desc",
    fromPattern: "^gpt-(4|5)",
    toModel: "gpt-4o-mini",
    threshold: 0.4,
    mode: "route",
  },
  {
    id: "claude-cheap",
    labelKey: "preset2Label",
    descKey: "preset2Desc",
    fromPattern: "^claude-3-(5|7)-sonnet",
    toModel: "claude-3-5-haiku-latest",
    threshold: 0.4,
    mode: "route",
  },
  {
    id: "ab-deepseek",
    labelKey: "preset3Label",
    descKey: "preset3Desc",
    fromPattern: "^gpt-",
    toModel: "deepseek-chat",
    threshold: 1,
    mode: "shadow",
    shadowToModel: "deepseek-chat",
    sampleRate: 0.05,
  },
  {
    id: "qwen-cheap",
    labelKey: "preset4Label",
    descKey: "preset4Desc",
    fromPattern: ".+",
    toModel: "qwen3-next-80b-a3b-instruct",
    threshold: 0.5,
    mode: "route",
  },
];

// =========================================================================
// Component
// =========================================================================

export interface RoutingRuleFormProps {
  projectId: string;
  /** Optional initial values when editing an existing rule. */
  initial?: {
    from_pattern: string;
    to_model: string;
    threshold: number;
    mode: RoutingMode;
    shadow_to_model: string | null;
    enabled: boolean;
    /** Optional sampling rate in [0, 1]. NULL = always fire on match. */
    sample_rate?: number | null;
  };
  compact?: boolean;
  onClose?: () => void;
  /** Localised strings resolved on the server. */
  t: Dictionary["forms"]["routing"];
}

/**
 * Sampling rate presets the form exposes as one-click buttons.
 *
 * `null` = the legacy "fire on every match" behavior — what every rule
 * created before migration 020 has, and what we want most ROUTE rules
 * to keep (you don't want to randomly skip routing 95% of the time).
 *
 * The four sub-100% values are tuned for the per-project policy
 * training pipeline:
 *
 *   - 100% — calibration burst on a brand-new candidate model. First
 *            day or two; then dial down.
 *   - 10%  — generous steady state. Get to "enough samples to update
 *            the bucket" within hours on a busy project.
 *   - 5%   — recommended steady state. Balances cost-of-learning vs
 *            convergence time. Default suggested in the empty-state UI.
 *   - 1%   — very high-traffic project that already has good
 *            estimates and just wants drift detection.
 */
const SAMPLE_RATE_PRESETS: Array<{
  value: number | null;
  /** Either a fixed numeric label like "100%" / "10%" (not translated;
   *  it's a number) or `null` to use the dictionary's `Always` label. */
  label: string | null;
  /** Dictionary key for the description. */
  descKey:
    | "sampleRateAlwaysDesc"
    | "sampleRate100Desc"
    | "sampleRate10Desc"
    | "sampleRate5Desc"
    | "sampleRate1Desc";
}> = [
  { value: null, label: null, descKey: "sampleRateAlwaysDesc" },
  { value: 1.0, label: "100%", descKey: "sampleRate100Desc" },
  { value: 0.1, label: "10%", descKey: "sampleRate10Desc" },
  { value: 0.05, label: "5%", descKey: "sampleRate5Desc" },
  { value: 0.01, label: "1%", descKey: "sampleRate1Desc" },
];

// =========================================================================
// Persisted form preferences (browser-local, per project)
// =========================================================================
//
// When the user creates a NEW rule, the form's defaults come from this
// localStorage cache instead of the hardcoded `route / 0.4 / null`.
// What we persist is intentionally the small "rule shape" decisions —
// mode / threshold / sample_rate — NOT the rule-specific fields like
// `from_pattern` and `to_model` (those are unique per rule, pre-filling
// them would surface the EXACT rule the user just saved, which feels
// like the form didn't react to the save). With this, the natural
// "I'm setting up a few similar shadow rules in a row" flow keeps the
// shadow + 5% sample selection sticky across page refreshes.
//
// Scoped per-project so two projects with different routing styles
// don't trample each other.
//
// Skipped on the EDIT flow (`initial != null`) because editing an
// existing rule shouldn't shift the "new rule" defaults — we keep
// those two surfaces independent.

const PREFS_STORAGE_KEY_PREFIX = "tokensmart:routing-rule-form:";

type RoutingFormPrefs = {
  mode: RoutingMode;
  threshold: number;
  sampleRate: number | null;
};

function loadPersistedPrefs(projectId: string): RoutingFormPrefs | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(
      PREFS_STORAGE_KEY_PREFIX + projectId
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RoutingFormPrefs>;
    // Validate every field — a corrupt cache should never crash the
    // form. Each guard falls back to the original hardcoded default.
    const mode: RoutingMode =
      parsed.mode === "shadow" ||
      parsed.mode === "both" ||
      parsed.mode === "route"
        ? parsed.mode
        : "route";
    const threshold =
      typeof parsed.threshold === "number" &&
      parsed.threshold >= 0 &&
      parsed.threshold <= 1
        ? parsed.threshold
        : 0.4;
    const sampleRate =
      parsed.sampleRate === null ||
      (typeof parsed.sampleRate === "number" &&
        parsed.sampleRate >= 0 &&
        parsed.sampleRate <= 1)
        ? (parsed.sampleRate ?? null)
        : null;
    return { mode, threshold, sampleRate };
  } catch {
    return null;
  }
}

function savePersistedPrefs(
  projectId: string,
  prefs: RoutingFormPrefs
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      PREFS_STORAGE_KEY_PREFIX + projectId,
      JSON.stringify(prefs)
    );
  } catch {
    // Quota / disabled storage — non-fatal; the form just falls back
    // to hardcoded defaults on next mount.
  }
}

function findKnownModel(value: string): boolean {
  return MODEL_GROUPS.some((g) => g.options.some((o) => o.value === value));
}

function tierColor(tier: ModelOption["tier"]): string {
  switch (tier) {
    case "frontier":
      return "var(--purple)";
    case "mid":
      return "var(--accent)";
    case "cheap":
      return "var(--success)";
  }
}

function tierLabel(
  tier: ModelOption["tier"],
  t: Dictionary["forms"]["routing"]
): string {
  switch (tier) {
    case "frontier":
      return t.tierFrontier;
    case "mid":
      return t.tierMid;
    case "cheap":
      return t.tierCheap;
  }
}

export function RoutingRuleForm({
  projectId,
  initial,
  compact,
  onClose,
  t,
}: RoutingRuleFormProps) {
  // Pattern starts as a literal anchored model name in non-edit mode so the
  // user doesn't see scary regex unless they ask for it.
  const [fromMode, setFromMode] = useState<"model" | "regex">(
    initial && !findKnownModel(initial.from_pattern.replace(/^\^|\$$/g, ""))
      ? "regex"
      : "model"
  );
  const [fromValue, setFromValue] = useState<string>(
    initial?.from_pattern ?? "gpt-5.2"
  );
  const [toModel, setToModel] = useState<string>(
    initial?.to_model ?? "gpt-4o-mini"
  );
  const [threshold, setThreshold] = useState<number>(
    initial?.threshold ?? 0.4
  );
  const [mode, setMode] = useState<RoutingMode>(initial?.mode ?? "route");
  const [shadowToModel, setShadowToModel] = useState<string>(
    initial?.shadow_to_model ?? ""
  );
  const [enabled, setEnabled] = useState<boolean>(initial?.enabled ?? true);
  // sample_rate state. `null` is "always fire" (legacy default); a
  // number in [0, 1] is the random-draw probability. Editing a rule
  // that has no sample_rate set comes in as null, preserving the
  // existing semantics until the user explicitly picks a sub-100%
  // option. We deliberately don't auto-pick 5% on new shadow/both
  // rules — picking a sampling rate is a real product decision the
  // user should make themselves; we just surface the recommendation
  // in the helper text below the buttons.
  const [sampleRate, setSampleRate] = useState<number | null>(
    initial?.sample_rate ?? null
  );

  const [preview, setPreview] = useState<RoutingMatchPreview | null>(null);
  const [previewLoading, startPreview] = useTransition();

  // Transient "✓ Saved" indicator next to the submit button. Replaces
  // the URL-driven toast for the success path — `setRoutingRuleAction`
  // now uses `revalidatePath` instead of `redirect(...?toast=...)` so
  // form state survives a save (operators editing 7 fields don't want
  // them snapping back to defaults). The badge auto-clears after 2.5s
  // so it never piles up if someone hammers Save.
  const [savedAt, setSavedAt] = useState<number | null>(null);
  useEffect(() => {
    if (savedAt == null) return;
    const t = setTimeout(() => setSavedAt(null), 2500);
    return () => clearTimeout(t);
  }, [savedAt]);

  // Cross-refresh persistence: on the new-rule flow, restore mode +
  // threshold + sample_rate from the per-project localStorage cache.
  // Done in `useEffect` (not in the `useState` initializer) because
  // `localStorage` doesn't exist during SSR — reading it inside the
  // initializer would either crash or cause a hydration mismatch.
  // Brief flicker (initial render = hardcoded defaults, then snap to
  // restored values within the first paint) is acceptable for a form;
  // way better than the user wondering why their picked Shadow mode
  // disappeared on refresh.
  useEffect(() => {
    if (initial) return; // editing an existing rule — its own values win
    const persisted = loadPersistedPrefs(projectId);
    if (!persisted) return;
    setMode(persisted.mode);
    setThreshold(persisted.threshold);
    setSampleRate(persisted.sampleRate);
  }, [initial, projectId]);

  // The actual regex sent to the gateway: literal model names get anchored
  // automatically so "gpt-5.2" doesn't accidentally match "gpt-5.21".
  const effectivePattern = useMemo(() => {
    if (fromMode === "regex") return fromValue.trim();
    const escaped = fromValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return `^${escaped}$`;
  }, [fromMode, fromValue]);

  // Debounced preview fetch on pattern change
  useEffect(() => {
    if (!effectivePattern) {
      setPreview(null);
      return;
    }
    const t = setTimeout(() => {
      startPreview(async () => {
        const result = await previewRoutingRuleAction({
          projectId,
          fromPattern: effectivePattern,
        });
        setPreview(result);
      });
    }, 300);
    return () => clearTimeout(t);
  }, [projectId, effectivePattern]);

  const applyPreset = (p: Preset) => {
    // Try to reduce regex to model picker if it's a literal anchored name.
    const literalMatch = p.fromPattern.match(/^\^([\w./-]+)\$$/);
    if (literalMatch && findKnownModel(literalMatch[1])) {
      setFromMode("model");
      setFromValue(literalMatch[1]);
    } else {
      setFromMode("regex");
      setFromValue(p.fromPattern);
    }
    setToModel(p.toModel);
    setThreshold(p.threshold);
    setMode(p.mode);
    setShadowToModel(p.shadowToModel ?? "");
    // Apply the preset's sample_rate (or reset to "always" when the
    // preset doesn't specify one). Without this, switching from a
    // shadow-mode preset to a route-mode preset would leave a stale
    // 5% sample-rate sitting around silently — which we don't want
    // for ROUTE rules (those should always fire).
    setSampleRate(p.sampleRate ?? null);
  };

  return (
    <form
      action={async (fd) => {
        // Inject the computed effective pattern (rather than the model
        // dropdown's value) so the gateway gets a real regex.
        fd.set("from_pattern", effectivePattern);
        // sample_rate: empty string = legacy "fire on every match";
        // a number = the random-draw probability. We always set the
        // field (rather than relying on an HTML input being present)
        // so a SHADOW rule that the user explicitly switched to
        // "Always" still clears any stale per-rule sample_rate.
        fd.set("sample_rate", sampleRate == null ? "" : String(sampleRate));
        // Mode is rendered as `<button type="button">` cards (NOT radios)
        // so the click handler can call `setMode(m)` directly without
        // relying on label-implicit-radio-association — that pattern
        // was unreliable for some users (clicking "Route+Shadow" left
        // the "Route" card visually selected). We keep React state as
        // the single source of truth and stamp it into the FormData
        // here so submission is byte-identical regardless of which
        // card the user last clicked.
        fd.set("mode", mode);
        await setRoutingRuleAction(fd);
        // Action now uses revalidatePath (no redirect on success) so
        // control returns here and we can flash a transient confirmation.
        // For the editing flow `onClose` collapses the row immediately;
        // for the new-rule flow the form stays open so the user can
        // tweak + save again, and the "✓ Saved" pill is the only
        // post-save signal besides the new row appearing in the table.
        setSavedAt(Date.now());
        // Persist the rule-shape decisions for the next page load on
        // this project. Only on the new-rule flow — editing a rule
        // shouldn't reshape the new-rule defaults.
        if (!initial) {
          savePersistedPrefs(projectId, { mode, threshold, sampleRate });
        }
        onClose?.();
      }}
      className={compact ? "routing-form routing-form-compact" : "routing-form"}
    >
      <input type="hidden" name="project_id" value={projectId} />

      {!compact && (
        <div className="routing-presets">
          <span className="routing-presets-label">{t.presetsLabel}</span>
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="routing-preset"
              title={t[p.descKey]}
              onClick={() => applyPreset(p)}
            >
              {t[p.labelKey]}
            </button>
          ))}
        </div>
      )}

      {/* From model pattern */}
      <div className="routing-field">
        <label className="routing-field-label">
          {t.whenAsks}
          <button
            type="button"
            className="routing-field-toggle"
            onClick={() =>
              setFromMode(fromMode === "model" ? "regex" : "model")
            }
          >
            {fromMode === "model" ? t.switchToRegex : t.switchToModel}
          </button>
        </label>
        {fromMode === "model" ? (
          <select
            className="input"
            value={fromValue}
            onChange={(e) => setFromValue(e.target.value)}
          >
            {MODEL_GROUPS.map((g) => (
              <optgroup key={g.provider} label={g.provider}>
                {g.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        ) : (
          <input
            className="input"
            placeholder={t.regexPlaceholder}
            value={fromValue}
            onChange={(e) => setFromValue(e.target.value)}
          />
        )}
      </div>

      {/* To model */}
      <div className="routing-field">
        <label className="routing-field-label">{t.routeTo}</label>
        <select
          name="to_model"
          className="input"
          value={toModel}
          onChange={(e) => setToModel(e.target.value)}
          required
        >
          {MODEL_GROUPS.map((g) => (
            <optgroup key={g.provider} label={g.provider}>
              {g.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <div className="routing-tier-row">
          {MODEL_GROUPS.flatMap((g) => g.options)
            .filter((o) => o.value === toModel)
            .map((o) => (
              <span
                key={o.value}
                className="routing-tier-badge"
                style={{ color: tierColor(o.tier) }}
              >
                ● {tierLabel(o.tier, t)}
                {t.tierSuffix}
              </span>
            ))}
        </div>
      </div>

      {/* Threshold slider */}
      <div className="routing-field">
        <label className="routing-field-label">
          {t.thresholdLabel}
          <span className="routing-threshold-value">
            {threshold.toFixed(2)}
          </span>
        </label>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
          className="routing-slider"
          name="threshold"
        />
        <div className="routing-landmarks">
          {THRESHOLD_LANDMARKS.map((lm) => {
            const matched = lm.score <= threshold;
            const example = t[lm.exampleKey];
            const tooltip = t.landmarkTooltipTpl.replace(
              "{score}",
              lm.score.toFixed(2)
            );
            return (
              <div
                key={lm.score}
                className={`routing-landmark ${matched ? "matched" : ""}`}
                title={tooltip}
              >
                <span className="routing-landmark-marker">
                  {matched ? "✓" : "·"}
                </span>
                <span className="routing-landmark-text">{example}</span>
                <span className="routing-landmark-score">
                  {lm.score.toFixed(2)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Mode cards.
          Refactored from `<label><input type="radio" /></label>` to
          `<button type="button">` because the label-implicit-radio
          association was firing unreliably for some users — clicking
          "Route + Shadow" sometimes left "Route" visually selected
          even though the React click handler had run. The `<button>`
          fires `onClick` directly, no chain through hidden radios, no
          label-retargeting quirks. Form submission picks up `mode`
          from the form action's `fd.set("mode", mode)` call instead
          of from a radio input value.

          `aria-pressed` keeps screen-reader semantics correct for the
          three-state toggle (the buttons are ALL submit-blockers via
          `type="button"` so they never accidentally submit the form). */}
      <div className="routing-field">
        <label className="routing-field-label">{t.modeLabel}</label>
        <div className="routing-modes">
          {(["route", "shadow", "both"] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`routing-mode-card ${mode === m ? "selected" : ""}`}
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
            >
              <div className="routing-mode-card-title">
                {m === "route" && t.modeRouteTitle}
                {m === "shadow" && t.modeShadowTitle}
                {m === "both" && t.modeBothTitle}
              </div>
              <div className="routing-mode-card-body">
                {m === "route" && (
                  <>
                    {t.modeRouteBodyPrefix}
                    <code>model</code>
                    {t.modeRouteBodySuffix}
                  </>
                )}
                {m === "shadow" && <>{t.modeShadowBody}</>}
                {m === "both" && <>{t.modeBothBody}</>}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Shadow target — only relevant for shadow / both modes */}
      {(mode === "shadow" || mode === "both") && (
        <div className="routing-field">
          <label className="routing-field-label">{t.shadowTargetLabel}</label>
          <select
            name="shadow_to_model"
            className="input"
            value={shadowToModel}
            onChange={(e) => setShadowToModel(e.target.value)}
          >
            <option value="">
              {mode === "both"
                ? t.shadowTargetDefaultBoth
                : t.shadowTargetPick}
            </option>
            {MODEL_GROUPS.map((g) => (
              <optgroup key={g.provider} label={g.provider}>
                {g.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      )}

      {/* Sample rate — applies to every mode but matters most for
          shadow / both. Renders as a row of preset chips so the user
          doesn't have to type a probability they only kind-of
          understand. The "Always" chip preserves the legacy "fire on
          every match" behavior every pre-migration-020 rule has, so
          updating an old ROUTE rule via this form doesn't accidentally
          start dropping 95% of routings. */}
      <div className="routing-field">
        <label className="routing-field-label">{t.sampleRateLabel}</label>
        <div
          style={{
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          {SAMPLE_RATE_PRESETS.map((p) => {
            const selected =
              (sampleRate == null && p.value == null) ||
              (sampleRate != null && p.value != null && Math.abs(sampleRate - p.value) < 1e-9);
            // The "Always" preset uses a translated label; numeric
            // presets carry a baked-in "100%" / "10%" etc. that's the
            // same in every locale.
            const presetLabel = p.label ?? t.sampleRateAlwaysLabel;
            return (
              <button
                key={presetLabel}
                type="button"
                className={`routing-preset ${selected ? "selected" : ""}`}
                title={t[p.descKey]}
                onClick={() => setSampleRate(p.value)}
                style={
                  selected
                    ? {
                        background: "var(--accent)",
                        color: "var(--bg-base)",
                        borderColor: "var(--accent)",
                      }
                    : undefined
                }
              >
                {presetLabel}
              </button>
            );
          })}
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            marginTop: 6,
          }}
        >
          {sampleRate == null ? (
            <>
              {t.sampleAlwaysExplain}
              {mode === "shadow" || mode === "both" ? (
                <>
                  {t.sampleAlwaysShadowExplainPrefix}
                  <code>{mode}</code>
                  {t.sampleAlwaysShadowExplainSuffix}
                </>
              ) : (
                <>{t.sampleAlwaysRouteExplain}</>
              )}
            </>
          ) : (
            <>
              {t.sampleSubExplainPrefix}
              <strong>
                {(sampleRate * 100).toFixed(sampleRate < 0.01 ? 2 : 0)}%
              </strong>
              {t.sampleSubExplainOf}
              {mode === "shadow" || mode === "both" ? (
                <>
                  {t.sampleSubExplainShadowSuffix.replace(
                    "{pct}",
                    (sampleRate * 100).toFixed(0)
                  )}
                </>
              ) : (
                <>
                  {t.sampleSubExplainRouteSuffix.replace(
                    "{pct}",
                    (100 - sampleRate * 100).toFixed(0)
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* Live "what would this rule have done in the last 7d" preview */}
      <div className="routing-preview">
        <div className="routing-preview-label">{t.previewLabel}</div>
        {previewLoading ? (
          <div className="routing-preview-line">{t.previewLoading}</div>
        ) : preview ? (
          preview.matched_request_count === 0 ? (
            <div className="routing-preview-line routing-preview-hint">
              {t.previewEmpty}
            </div>
          ) : (
            <>
              <div className="routing-preview-line">
                <strong>{preview.matched_request_count}</strong>
                {preview.matched_request_count === 1
                  ? t.previewMatchedSingular
                  : t.previewMatchedPlural}
                {t.previewMatchedSpentSuffix.replace(
                  "{spent}",
                  `$${(
                    preview.matched_total_cost_micro_cents / MICRO_PER_USD
                  ).toFixed(4)}`
                )}
              </div>
              {preview.sample_models.length > 0 && (
                <div className="routing-preview-line routing-preview-hint">
                  {t.previewModelsHit}{" "}
                  {preview.sample_models.map((m, i) => (
                    <span key={m}>
                      <code className="code-inline">{m}</code>
                      {i < preview.sample_models.length - 1 ? " · " : ""}
                    </span>
                  ))}
                </div>
              )}
              <div className="routing-preview-line routing-preview-hint">
                {t.previewThresholdHint.replace("{n}", threshold.toFixed(2))}
              </div>
            </>
          )
        ) : (
          <div className="routing-preview-line routing-preview-hint">
            {t.previewUnavailable}
          </div>
        )}
      </div>

      {/* Footer: enabled + submit */}
      <div className="routing-form-footer">
        <label className="routing-enabled">
          <input
            type="checkbox"
            name="enabled"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          {t.enabledLabel}
        </label>
        <button type="submit" className="btn btn-primary btn-sm">
          {initial ? t.updateBtn : t.saveBtn}
        </button>
        {savedAt != null && (
          <span
            style={{
              color: "var(--success)",
              fontSize: 12,
              fontWeight: 500,
              // `aria-live="polite"` so screen-readers announce the
              // save without yanking focus from the form. The visible
              // pill auto-fades via the `savedAt` timeout above.
            }}
            aria-live="polite"
          >
            {t.savedPill}
          </span>
        )}
        {compact && onClose && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onClose}
          >
            {t.cancelBtn}
          </button>
        )}
      </div>
    </form>
  );
}
