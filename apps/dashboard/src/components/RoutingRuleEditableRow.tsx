"use client";

import { useState } from "react";
import { RoutingRuleForm } from "./RoutingRuleForm";
import { deleteRoutingRuleAction } from "@/app/projects/actions";
import type { RoutingMode } from "@/lib/db";
import type { Dictionary } from "@/i18n/types";

export interface RoutingRuleEditableRowProps {
  rule: {
    id: string;
    project_id: string;
    enabled: boolean;
    threshold: number;
    from_pattern: string;
    to_model: string;
    shadow_to_model: string | null;
    mode: RoutingMode;
    sample_rate: number | null;
  };
  /** Localised strings. */
  t: Dictionary["forms"]["routing"];
}

/**
 * Render the sample_rate cell content. NULL renders as a soft "always"
 * pill (legacy default — every pre-migration-020 rule looks like this).
 * Sub-1 values render as a percentage with two-tier precision so 0.5%
 * still reads correctly.
 */
function sampleRateLabel(
  rate: number | null,
  t: Dictionary["forms"]["routing"]
): string {
  if (rate == null || rate >= 1) return t.rowSampleAlways;
  if (rate <= 0) return t.rowSampleNever;
  if (rate < 0.01) return `${(rate * 100).toFixed(2)}%`;
  return `${Math.round(rate * 100)}%`;
}

export function RoutingRuleEditableRow({
  rule,
  t,
}: RoutingRuleEditableRowProps) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <tr>
        <td colSpan={8} style={{ padding: "12px" }}>
          <RoutingRuleForm
            projectId={rule.project_id}
            initial={{
              from_pattern: rule.from_pattern,
              to_model: rule.to_model,
              threshold: rule.threshold,
              mode: rule.mode,
              shadow_to_model: rule.shadow_to_model,
              enabled: rule.enabled,
              sample_rate: rule.sample_rate,
            }}
            compact
            onClose={() => setEditing(false)}
            t={t}
          />
        </td>
      </tr>
    );
  }

  // sample_rate gets a softer pill style when it's the legacy default
  // — visually nudges users toward seeing "always" as the baseline,
  // and bright/colored only when they've explicitly opted into a
  // sub-100% rate. We never use a danger color here because a low
  // sample rate isn't an error condition; it's a conscious tradeoff.
  const isLegacyAlways = rule.sample_rate == null;

  return (
    <tr>
      <td>
        <span className="pill pill-accent">{rule.mode}</span>
      </td>
      <td>
        <button
          type="button"
          className="routing-from-edit"
          onClick={() => setEditing(true)}
          title={t.rowEditTitle}
        >
          <code className="code-inline">{rule.from_pattern}</code>
        </button>
      </td>
      <td>
        <code className="code-inline">{rule.to_model}</code>
      </td>
      <td>
        {rule.shadow_to_model ? (
          <code className="code-inline">{rule.shadow_to_model}</code>
        ) : (
          <span style={{ color: "var(--text-muted)" }}>—</span>
        )}
      </td>
      <td className="numeric">{rule.threshold.toFixed(2)}</td>
      <td>
        <span
          className={isLegacyAlways ? "pill pill-neutral" : "pill pill-purple"}
          title={
            isLegacyAlways
              ? t.rowSampleAlwaysTooltip
              : t.rowSampleSubTooltip.replace(
                  "{label}",
                  sampleRateLabel(rule.sample_rate, t)
                )
          }
        >
          {sampleRateLabel(rule.sample_rate, t)}
        </span>
      </td>
      <td>
        <span
          className={
            rule.enabled ? "pill pill-success" : "pill pill-neutral"
          }
        >
          {rule.enabled ? t.rowEnabledPill : t.rowDisabledPill}
        </span>
      </td>
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
          action={deleteRoutingRuleAction}
          style={{ display: "inline" }}
        >
          <input type="hidden" name="project_id" value={rule.project_id} />
          <input type="hidden" name="id" value={rule.id} />
          <button type="submit" className="btn btn-sm btn-danger">
            {t.rowDeleteBtn}
          </button>
        </form>
      </td>
    </tr>
  );
}
