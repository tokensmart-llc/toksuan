type SparklineProps = {
  values: number[];
  width?: number;
  height?: number;
  /** CSS color; defaults to currentColor so it follows the surrounding text. */
  color?: string;
  /** Draw a translucent area under the line. Defaults on. */
  fill?: boolean;
  /** Draw a dot on the last point. Defaults on. */
  last?: boolean;
};

/**
 * Inline SVG sparkline. No library, no client JS. Scales values to the full
 * height; a completely-flat zero series renders as a muted baseline instead
 * of a jagged zig-zag.
 */
export function Sparkline({
  values,
  width = 96,
  height = 28,
  color = "currentColor",
  fill = true,
  last = true,
}: SparklineProps) {
  if (values.length === 0) return null;

  const n = values.length;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min;
  const allZero = max === 0;

  const xStep = n > 1 ? width / (n - 1) : 0;
  const y = (v: number) => {
    if (range === 0) return height - 2; // flat line near bottom
    return height - 2 - ((v - min) / range) * (height - 4);
  };

  const points = values.map((v, i) => [i * xStep, y(v)] as const);

  const linePath = points
    .map(([x, py], i) =>
      `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${py.toFixed(1)}`
    )
    .join(" ");
  const areaPath = `${linePath} L ${width} ${height} L 0 ${height} Z`;

  const [lastX, lastY] = points[points.length - 1];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      style={{ display: "block", color, overflow: "visible" }}
    >
      {fill && !allZero && (
        <path d={areaPath} fill={color} fillOpacity="0.12" />
      )}
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={allZero ? 0.25 : 1}
      />
      {last && !allZero && (
        <circle cx={lastX} cy={lastY} r={2.2} fill={color} />
      )}
    </svg>
  );
}
