"use client";

import { useState } from "react";
import { BudgetForm, type Period } from "./BudgetForm";
import { deleteBudgetAction } from "@/app/projects/actions";
import type { Dictionary } from "@/i18n/types";

const MICRO_PER_USD = 100_000;

function fmtMicroAsUsd(microCents: number, digits = 4): string {
  return `$${(microCents / MICRO_PER_USD).toFixed(digits)}`;
}

function fmtTime(d: Date | string): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(d));
}

export interface ForecastInfo {
  /** Hours from now until current period spend hits the budget at the recent burn rate. null if no forecast. */
  hours_to_exhaustion: number | null;
  /** Current period spend toward this budget, in micro cents. */
  current_spend_micro_cents: number;
  /** Recent burn rate ($/hour) for context. */
  burn_per_hour_micro_cents: number;
}

export interface BudgetEditableRowProps {
  budget: {
    id: string;
    project_id: string;
    period: Period;
    limit_micro_cents: number;
    enabled: boolean;
    updated_at: Date | string;
  };
  context: {
    spend_24h_micro_cents: number;
    spend_7d_micro_cents: number;
    spend_30d_micro_cents: number;
  };
  forecast?: ForecastInfo;
  /** Localised strings. */
  t: Dictionary["forms"]["budget"];
}

function fmtForecast(
  f: ForecastInfo,
  period: Period,
  t: Dictionary["forms"]["budget"]
): string | null {
  if (f.hours_to_exhaustion == null) return null;
  if (f.burn_per_hour_micro_cents <= 0) return null;
  const periodLabel =
    period === "daily" ? t.forecastTodayLabel : t.forecastMonthLabel;
  const h = f.hours_to_exhaustion;
  if (h < 1) {
    const m = Math.max(1, Math.round(h * 60));
    return t.forecastEtaMinutes
      .replace("{n}", String(m))
      .replace("{periodLabel}", periodLabel);
  }
  if (h < 24) {
    return t.forecastEtaHours
      .replace("{n}", h.toFixed(1))
      .replace("{periodLabel}", periodLabel);
  }
  if (h < 24 * 14) {
    return t.forecastEtaDays
      .replace("{n}", (h / 24).toFixed(1))
      .replace("{periodLabel}", periodLabel);
  }
  return null; // too distant to be useful
}

export function BudgetEditableRow({
  budget,
  context,
  forecast,
  t,
}: BudgetEditableRowProps) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <tr>
        <td colSpan={5} style={{ padding: "12px" }}>
          <BudgetForm
            projectId={budget.project_id}
            initial={{
              period: budget.period,
              limit_micro_cents: budget.limit_micro_cents,
              enabled: budget.enabled,
            }}
            context={context}
            compact
            onClose={() => setEditing(false)}
            t={t}
          />
        </td>
      </tr>
    );
  }

  const forecastText = forecast ? fmtForecast(forecast, budget.period, t) : null;
  const periodSpendPct =
    forecast && budget.limit_micro_cents > 0
      ? Math.min(
          100,
          (forecast.current_spend_micro_cents / budget.limit_micro_cents) * 100
        )
      : null;

  // Period column shows the localised label rather than the raw key so
  // the table reads naturally in both EN ("Daily" / "Monthly") and CN
  // ("日预算" / "月预算").
  const periodLabel =
    budget.period === "daily" ? t.periodDaily : t.periodMonthly;

  return (
    <tr>
      <td>{periodLabel}</td>
      <td className="numeric">
        <button
          type="button"
          className="budget-limit-edit"
          onClick={() => setEditing(true)}
          title={t.rowEditTitle}
        >
          {fmtMicroAsUsd(budget.limit_micro_cents)}
        </button>
        {forecastText && (
          <div className="budget-forecast">{forecastText}</div>
        )}
        {periodSpendPct != null && periodSpendPct > 0 && (
          <div className="budget-mini-progress">
            <div
              className="budget-mini-progress-fill"
              style={{
                width: `${periodSpendPct}%`,
                background:
                  periodSpendPct >= 100
                    ? "var(--danger)"
                    : periodSpendPct >= 80
                      ? "var(--warning)"
                      : "var(--success)",
              }}
            />
          </div>
        )}
      </td>
      <td>
        <span
          className={
            budget.enabled ? "pill pill-success" : "pill pill-neutral"
          }
        >
          {budget.enabled ? t.rowEnabledPill : t.rowDisabledPill}
        </span>
      </td>
      <td className="muted">{fmtTime(budget.updated_at)}</td>
      <td style={{ textAlign: "right" }}>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setEditing(true)}
          style={{ marginRight: 6 }}
        >
          {t.rowEditBtn}
        </button>
        <form
          action={deleteBudgetAction}
          style={{ display: "inline" }}
        >
          <input type="hidden" name="project_id" value={budget.project_id} />
          <input type="hidden" name="id" value={budget.id} />
          <button type="submit" className="btn btn-sm btn-danger">
            {t.rowDeleteBtn}
          </button>
        </form>
      </td>
    </tr>
  );
}
