"use client";

import { useState } from "react";
import { setBudgetAction } from "@/app/projects/actions";
import type { Dictionary } from "@/i18n/types";

type Preset = {
  amount: number;
  period: "daily" | "monthly";
  usd: string;
};

/** Preset catalog. The user-visible label is computed at render time from
 *  `t.presetDailyTpl` / `t.presetMonthlyTpl` so the chip text follows
 *  the locale (e.g. "$5/day" vs "$5/天") without hardcoding English in
 *  the picker. */
const PRESETS: Preset[] = [
  { amount: 1, period: "daily", usd: "1.00" },
  { amount: 5, period: "daily", usd: "5.00" },
  { amount: 10, period: "daily", usd: "10.00" },
  { amount: 50, period: "monthly", usd: "50.00" },
];

function presetLabel(
  p: Preset,
  t: Pick<
    Dictionary["forms"]["quickBudget"],
    "presetDailyTpl" | "presetMonthlyTpl"
  >
): string {
  const tpl = p.period === "daily" ? t.presetDailyTpl : t.presetMonthlyTpl;
  return tpl.replace("{usd}", String(p.amount));
}

export interface QuickBudgetCTAProps {
  /**
   * Projects the user owns. The CTA shows a dropdown when there's more
   * than one, defaults to the first listed.
   */
  projects: Array<{ id: string; name: string }>;
  /** Localised strings resolved on the server. */
  t: Dictionary["forms"]["quickBudget"];
}

export function QuickBudgetCTA({ projects, t }: QuickBudgetCTAProps) {
  const [projectId, setProjectId] = useState<string>(
    projects[0]?.id ?? ""
  );
  const [preset, setPreset] = useState<(typeof PRESETS)[number]>(
    PRESETS[1]! // $5/day default — most common starting point
  );

  if (projects.length === 0) return null;

  return (
    <div className="budget-cta">
      <div className="budget-cta-icon" aria-hidden>$</div>
      <div className="budget-cta-body">
        <div className="budget-cta-title">{t.title}</div>
        <form
          action={async (fd) => {
            await setBudgetAction(fd);
          }}
          className="budget-cta-form"
        >
          <input type="hidden" name="period" value={preset.period} />
          <input type="hidden" name="limit_usd" value={preset.usd} />
          <input type="hidden" name="enabled" value="on" />

          <span className="budget-cta-sub">{t.capLabel}</span>

          <select
            value={`${preset.period}:${preset.usd}`}
            onChange={(e) => {
              const [p, u] = e.target.value.split(":");
              const next =
                PRESETS.find((x) => x.period === p && x.usd === u) ??
                PRESETS[1]!;
              setPreset(next);
            }}
            className="input"
          >
            {PRESETS.map((p) => (
              <option
                key={`${p.period}:${p.usd}`}
                value={`${p.period}:${p.usd}`}
              >
                {presetLabel(p, t)}
              </option>
            ))}
          </select>

          {projects.length > 1 && (
            <>
              <span className="budget-cta-sub">{t.onLabel}</span>
              <select
                name="project_id"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="input"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </>
          )}
          {projects.length === 1 && (
            <input type="hidden" name="project_id" value={projects[0]!.id} />
          )}

          <button type="submit" className="btn btn-primary btn-sm">
            {t.enableBtn}
          </button>
        </form>
      </div>
    </div>
  );
}
