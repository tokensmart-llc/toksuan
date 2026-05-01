"use client";

import { useMemo, useState, useEffect } from "react";
import { setBudgetAction } from "@/app/projects/actions";
import type { Dictionary } from "@/i18n/types";

const MICRO_PER_USD = 100_000;

export type Period = "daily" | "monthly";

type Preset = {
  /** Numeric amount used as the `{usd}` substitution in the dictionary
   *  template. Whole-dollar so the same value reads cleanly in EN
   *  ("$1/day") and CN ("$1/天"). */
  amount: number;
  period: Period;
  usd: string;
};

/** Catalog of preset amounts. Display labels are computed at render
 *  time from `t.presetDailyTpl` / `t.presetMonthlyTpl` so EN and CN
 *  format the chip text the same way (currency glyph + per-period
 *  word) without forking the catalog. */
const PRESETS: Preset[] = [
  { amount: 1, period: "daily", usd: "1.00" },
  { amount: 5, period: "daily", usd: "5.00" },
  { amount: 10, period: "daily", usd: "10.00" },
  { amount: 50, period: "monthly", usd: "50.00" },
  { amount: 200, period: "monthly", usd: "200.00" },
  { amount: 500, period: "monthly", usd: "500.00" },
];

function presetLabel(
  p: Preset,
  t: Pick<
    Dictionary["forms"]["budget"],
    "presetDailyTpl" | "presetMonthlyTpl"
  >
): string {
  const tpl = p.period === "daily" ? t.presetDailyTpl : t.presetMonthlyTpl;
  return tpl.replace("{usd}", String(p.amount));
}

export interface BudgetFormProps {
  projectId: string;
  /** Optional existing budget to edit. When set, the form pre-fills and submits an upsert. */
  initial?: {
    period: Period;
    limit_micro_cents: number;
    enabled: boolean;
  };
  /** Past-spend context for the contextual preview line. */
  context: {
    spend_24h_micro_cents: number;
    spend_7d_micro_cents: number;
    spend_30d_micro_cents: number;
  };
  /** Compact mode (used inside an existing-budget table row for inline edit). */
  compact?: boolean;
  /** Called when the user finishes (compact mode collapses). */
  onClose?: () => void;
  /** Localised strings resolved on the server. */
  t: Dictionary["forms"]["budget"];
}

function fmtUsd(microCents: number, digits = 4): string {
  if (microCents === 0) return "$0";
  const usd = microCents / MICRO_PER_USD;
  if (usd >= 100) return `$${usd.toFixed(2)}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(digits)}`;
}

function parseUsdToMicro(input: string): number | null {
  const cleaned = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * MICRO_PER_USD);
}

export function BudgetForm({
  projectId,
  initial,
  context,
  compact = false,
  onClose,
  t,
}: BudgetFormProps) {
  const [period, setPeriod] = useState<Period>(initial?.period ?? "daily");
  const [limitUsd, setLimitUsd] = useState<string>(
    initial ? (initial.limit_micro_cents / MICRO_PER_USD).toString() : ""
  );
  const [enabled, setEnabled] = useState<boolean>(initial?.enabled ?? true);
  // Fade preview in/out smoothly when the value first becomes parseable.
  const [hasInteracted, setHasInteracted] = useState<boolean>(!!initial);

  useEffect(() => {
    if (limitUsd.length > 0) setHasInteracted(true);
  }, [limitUsd]);

  const limitMicroCents = useMemo(
    () => parseUsdToMicro(limitUsd),
    [limitUsd]
  );

  const preview = useMemo(() => {
    if (limitMicroCents == null || limitMicroCents <= 0) return null;
    if (period === "daily") {
      const monthlyEquivMicro = limitMicroCents * 30;
      const past24h = context.spend_24h_micro_cents;
      const past7d = context.spend_7d_micro_cents;
      const ratio = past24h > 0 ? (past24h / limitMicroCents) * 100 : null;
      return {
        equivalent: t.previewMonthlyEquiv.replace(
          "{amount}",
          fmtUsd(monthlyEquivMicro)
        ),
        context:
          ratio == null
            ? t.previewNoTraffic24h
            : t.previewPast24hLine
                .replace("{spent}", fmtUsd(past24h))
                .replace("{pct}", ratio.toFixed(0)) +
              t.previewPast7dSuffix.replace("{spent}", fmtUsd(past7d)),
        warning:
          ratio != null && ratio > 100
            ? t.previewWarn24hOver
            : ratio != null && ratio > 80
              ? t.previewWarn24hHigh
              : null,
      };
    }
    // monthly
    const dailyEquivMicro = limitMicroCents / 30;
    const past30d = context.spend_30d_micro_cents;
    const ratio = past30d > 0 ? (past30d / limitMicroCents) * 100 : null;
    return {
      equivalent: t.previewDailyEquivAvg.replace(
        "{amount}",
        fmtUsd(dailyEquivMicro)
      ),
      context:
        ratio == null
          ? t.previewNoTraffic30d
          : t.previewPast30dLine
              .replace("{spent}", fmtUsd(past30d))
              .replace("{pct}", ratio.toFixed(0)),
      warning:
        ratio != null && ratio > 100
          ? t.previewWarn30dOver
          : ratio != null && ratio > 80
            ? t.previewWarn30dHigh
            : null,
    };
  }, [limitMicroCents, period, context, t]);

  // Sub-cent hint shows once the input dips below 1 cent
  const isSubCent =
    limitMicroCents != null && limitMicroCents > 0 && limitMicroCents < 100;

  const applyPreset = (p: Preset) => {
    setPeriod(p.period);
    setLimitUsd(p.usd);
    setHasInteracted(true);
  };

  // Transient "✓ Saved" pill — `setBudgetAction` now uses
  // `revalidatePath` (no redirect on success) so this form's React
  // state survives saves. The pill is the success signal in place of
  // the URL-driven toast; auto-clears after 2.5s. Same pattern as
  // RoutingRuleForm.
  const [savedAt, setSavedAt] = useState<number | null>(null);
  useEffect(() => {
    if (savedAt == null) return;
    const tm = setTimeout(() => setSavedAt(null), 2500);
    return () => clearTimeout(tm);
  }, [savedAt]);

  return (
    <form
      action={async (fd) => {
        await setBudgetAction(fd);
        // Action returns normally now (no redirect on success); flash a
        // confirmation. For the editing flow `onClose` collapses the
        // row so the pill is invisible there — fine, the row reverting
        // to view mode + the table reflecting the new value is the
        // signal in that path.
        setSavedAt(Date.now());
        onClose?.();
      }}
      className={compact ? "budget-form budget-form-compact" : "budget-form"}
    >
      <input type="hidden" name="project_id" value={projectId} />

      {!compact && (
        <div className="budget-presets">
          <span className="budget-presets-label">{t.presetsLabel}</span>
          {PRESETS.map((p) => {
            const label = presetLabel(p, t);
            return (
              <button
                key={`${p.period}:${p.usd}`}
                type="button"
                className={`budget-preset ${
                  period === p.period && limitUsd === p.usd
                    ? "budget-preset-active"
                    : ""
                }`}
                onClick={() => applyPreset(p)}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      <div className="budget-form-row">
        <select
          name="period"
          className="input"
          value={period}
          onChange={(e) => setPeriod(e.target.value as Period)}
        >
          <option value="daily">{t.periodDaily}</option>
          <option value="monthly">{t.periodMonthly}</option>
        </select>
        <div style={{ position: "relative", flex: 1 }}>
          <input
            name="limit_usd"
            type="text"
            inputMode="decimal"
            placeholder={t.limitPlaceholder}
            className="input"
            value={limitUsd}
            onChange={(e) => setLimitUsd(e.target.value)}
            required
            autoFocus={compact}
          />
        </div>
        <label className="budget-enabled">
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

      {/* Live preview — shown only after user has interacted */}
      {hasInteracted && (
        <div className="budget-preview">
          {preview ? (
            <>
              <div className="budget-preview-line budget-preview-equiv">
                {preview.equivalent}
              </div>
              <div className="budget-preview-line">{preview.context}</div>
              {preview.warning && (
                <div className="budget-preview-line budget-preview-warn">
                  ⚠ {preview.warning}
                </div>
              )}
              {isSubCent && (
                <div className="budget-preview-line budget-preview-hint">
                  {t.previewSubCentHint}
                </div>
              )}
            </>
          ) : (
            <div className="budget-preview-line budget-preview-hint">
              {t.previewEnterAmount}
            </div>
          )}
        </div>
      )}
    </form>
  );
}
