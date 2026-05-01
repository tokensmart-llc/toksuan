import Link from "next/link";

export type LoopTick = {
  id: string;
  created_at: Date;
  status: string;
  cost_micro_cents: number;
  is_current: boolean;
};

export type LoopTimelineProps = {
  ticks: LoopTick[];
  /** Time-axis window in ms. Defaults to: max(actual span, 60s). */
  windowMs?: number;
  height?: number;
  /**
   * Localised aria-label template for the SVG. `{n}` is substituted with
   * the number of ticks. Defaults to English when omitted so unit tests
   * and ad-hoc renders don't have to wire i18n.
   */
  ariaLabelTpl?: string;
};

const STATUS_COLOR: Record<string, string> = {
  success: "var(--success)",
  loop_detected: "var(--purple)",
  budget_exceeded: "var(--warning)",
  error: "var(--danger)",
  timeout: "var(--text-muted)",
};

function colorFor(status: string): string {
  return STATUS_COLOR[status] ?? "var(--text-muted)";
}

/**
 * Pure-SVG horizontal timeline of every request that shares this fingerprint.
 *
 * The x-axis is wall-clock; one vertical tick per call, color-coded by
 * status. The currently-viewed request gets a taller marker with a halo so
 * it's easy to find inside a 132-tick wall of loops.
 */
export function LoopTimeline({
  ticks,
  windowMs,
  height = 60,
  ariaLabelTpl = "{n} call timeline",
}: LoopTimelineProps) {
  if (ticks.length === 0) return null;

  const times = ticks.map((t) => new Date(t.created_at).getTime());
  const tMax = Math.max(...times);
  const tMin = Math.min(...times);
  const span = Math.max(tMax - tMin, windowMs ?? 60_000);
  const t0 = tMax - span;

  const width = 720;
  const padX = 8;
  const drawW = width - padX * 2;

  const xFor = (ts: number) =>
    padX + ((ts - t0) / Math.max(span, 1)) * drawW;

  const lane = height - 18;

  return (
    <div style={{ overflowX: "auto" }}>
      <svg
        width="100%"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabelTpl.replace("{n}", String(ticks.length))}
        style={{ display: "block" }}
      >
        {/* Baseline */}
        <line
          x1={padX}
          x2={width - padX}
          y1={lane}
          y2={lane}
          stroke="var(--border)"
          strokeWidth={1}
        />
        {/* Ticks */}
        {ticks.map((t) => {
          const x = xFor(new Date(t.created_at).getTime());
          const c = colorFor(t.status);
          if (t.is_current) {
            return (
              <g key={t.id}>
                <circle
                  cx={x}
                  cy={lane}
                  r={6}
                  fill="none"
                  stroke={c}
                  strokeOpacity={0.35}
                  strokeWidth={3}
                />
                <line
                  x1={x}
                  x2={x}
                  y1={lane - 18}
                  y2={lane + 8}
                  stroke={c}
                  strokeWidth={2}
                />
              </g>
            );
          }
          return (
            <Link key={t.id} href={`/requests/${t.id}`}>
              <line
                x1={x}
                x2={x}
                y1={lane - 10}
                y2={lane + 4}
                stroke={c}
                strokeWidth={1.5}
                opacity={0.85}
              >
                <title>
                  {new Date(t.created_at).toISOString()} · {t.status}
                </title>
              </line>
            </Link>
          );
        })}
        {/* Endpoint labels */}
        <text
          x={padX}
          y={height - 2}
          fill="var(--text-muted)"
          fontSize={10}
          fontFamily="var(--font-mono)"
        >
          {new Date(t0).toLocaleTimeString("en-US", { hour12: false })}
        </text>
        <text
          x={width - padX}
          y={height - 2}
          fill="var(--text-muted)"
          fontSize={10}
          fontFamily="var(--font-mono)"
          textAnchor="end"
        >
          {new Date(tMax).toLocaleTimeString("en-US", { hour12: false })}
        </text>
      </svg>
    </div>
  );
}
