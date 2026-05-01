import type { ReactNode } from "react";

export type DailyBar = {
  key: string;
  label: string;
  value: number;
  tooltip?: string;
};

type Tone = "accent" | "success" | "warning" | "danger" | "purple";

type DailyBarsProps = {
  data: DailyBar[];
  tone?: Tone;
  height?: number;
  /** Optional overlay shown in the top-right (e.g. "max $0.1330 · Apr 21"). */
  axisNote?: ReactNode;
  /**
   * Optional reference line — same units as `data[].value`. Renders as a
   * dashed horizontal line over the bars with a small label on the right.
   * Used for "your daily budget is here" overlay on the home dashboard.
   */
  referenceLine?: { value: number; label: string };
};

/**
 * Pure-CSS daily bar chart. No charting library; bars are just divs on a
 * grid, sized by percentage of the max value in the series. Hover shows the
 * raw value via the native `title` attribute.
 */
export function DailyBars({
  data,
  tone = "accent",
  height = 140,
  axisNote,
  referenceLine,
}: DailyBarsProps) {
  // The chart's vertical scale must accommodate any reference line that
  // sticks above the tallest bar — otherwise the budget line gets clipped.
  const dataMax = Math.max(...data.map((d) => d.value), 0);
  const max = referenceLine
    ? Math.max(dataMax, referenceLine.value * 1.05)
    : dataMax;
  const color = `var(--${tone})`;

  // Reference line position: distance from the BOTTOM of the chart, in %.
  const refPct =
    referenceLine && max > 0 ? (referenceLine.value / max) * 100 : 0;

  return (
    <div className="daily-bars">
      {axisNote && <div className="daily-bars-axis">{axisNote}</div>}
      <div
        className="daily-bars-row"
        style={{ height, position: "relative" }}
      >
        {data.map((d) => {
          const pct =
            max > 0 && d.value > 0
              ? Math.max(2, Math.round((d.value / max) * 100))
              : 0;
          return (
            <div
              key={d.key}
              className="daily-bar"
              title={d.tooltip ?? `${d.label}: ${d.value}`}
            >
              <div
                className="daily-bar-fill"
                style={{
                  height: `${pct}%`,
                  background: color,
                  opacity: d.value === 0 ? 0 : 1,
                }}
              />
            </div>
          );
        })}
        {referenceLine && refPct > 0 && refPct <= 100 && (
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: `${refPct}%`,
              borderTop: "1px dashed var(--warning)",
              opacity: 0.7,
              pointerEvents: "none",
            }}
            aria-label={referenceLine.label}
          >
            <span
              style={{
                position: "absolute",
                right: 0,
                top: -16,
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                color: "var(--warning)",
                background: "var(--surface)",
                padding: "0 4px",
              }}
            >
              {referenceLine.label}
            </span>
          </div>
        )}
      </div>
      <div className="daily-bars-labels">
        {data.map((d) => (
          <div key={`${d.key}-label`} className="daily-bars-label">
            {d.label}
          </div>
        ))}
      </div>
    </div>
  );
}
