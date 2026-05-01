type Tone = "accent" | "success" | "warning" | "danger" | "purple" | "neutral";

type ShareBarProps = {
  value: number;
  max: number;
  tone?: Tone;
  /** Width of the track in px. Defaults 120px so the bar always fits a typical table cell. */
  width?: number;
};

/**
 * Tiny proportion bar for inline use in tables. Renders `value / max` as a
 * thin bar — good for "this model ate 85% of the spend" without needing a
 * whole chart.
 */
export function ShareBar({
  value,
  max,
  tone = "accent",
  width = 120,
}: ShareBarProps) {
  const pct =
    max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const color =
    tone === "neutral" ? "var(--text-muted)" : `var(--${tone})`;
  return (
    <div className="share-bar" style={{ width }}>
      <div
        className="share-bar-fill"
        style={{ width: `${pct}%`, background: color }}
      />
    </div>
  );
}
