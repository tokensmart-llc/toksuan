import type { CSSProperties } from "react";

/**
 * TokSuan brand mark.
 *
 * The square mark is a compact "TS" monogram. Keep the mark intentionally
 * simple: at nav/favicon sizes extra flourishes read like dirt, not meaning.
 *
 *   - TS initials -> TokSuan
 *   - Blue T      -> tracked tokens / spend control
 *   - Green S     -> savings
 *
 * Brand colors are hardcoded (deliberately NOT `var(--accent)` etc.) so
 * the mark renders identically across themes - a logo should not change
 * color when the user flips light/dark. If these hex values change, also
 * update the favicon and OG eyebrow so the brand stays consistent across
 * in-app, browser tab, and social unfurls:
 *
 *   - apps/dashboard/src/app/icon.tsx
 *   - apps/dashboard/src/app/opengraph-image.tsx
 */
const BRAND_BG = "#0F172A";
const BRAND_TOKEN = "#6CB6FF";
const BRAND_SAVINGS = "#5DD592";

type LogoProps = {
  size?: number;
  /** When true (default), render just the square mark - what the nav and
   * the auth card use. When false, render the inline lockup (mark plus
   * wordmark, with an optional tagline below). */
  markOnly?: boolean;
  /** Only meaningful when `markOnly` is false. Adds the
   * "Spend control and routing for AI agents" tagline under the wordmark. */
  withTagline?: boolean;
  style?: CSSProperties;
};

export function Logo({
  size = 22,
  markOnly = true,
  withTagline = false,
  style,
}: LogoProps) {
  const mark = (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      style={style}
    >
      {/* Square plate. Deep navy so the mark pops on any surface
        - light theme cards, dark theme nav, browser tab favicon. */}
      <rect width="24" height="24" rx="6" fill={BRAND_BG} />

      <text
        x="11.1"
        y="15.8"
        textAnchor="end"
        fontFamily="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
        fontSize="10"
        fontWeight="800"
        letterSpacing="-0.7"
        fill={BRAND_TOKEN}
      >
        T
      </text>
      <text
        x="11.4"
        y="15.8"
        fontFamily="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
        fontSize="10"
        fontWeight="800"
        letterSpacing="-0.7"
        fill={BRAND_SAVINGS}
      >
        S
      </text>
    </svg>
  );

  if (markOnly) return mark;

  // Inline lockup. Wordmark inherits theme colors via CSS variables so
  // it sits well next to surrounding nav/card text - only the mark
  // itself stays brand-stable.
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: withTagline ? "flex-start" : "center",
        gap: 10,
      }}
    >
      {mark}
      <span style={{ display: "grid", gap: 2 }}>
        <span
          style={{
            fontWeight: 600,
            letterSpacing: "0.005em",
            color: "var(--text)",
            lineHeight: 1.1,
            fontSize: Math.max(13, Math.round(size * 0.62)),
          }}
        >
          TokSuan
        </span>
        {withTagline && (
          <span
            style={{
              fontSize: Math.max(10, Math.round(size * 0.42)),
              color: "var(--text-secondary)",
              lineHeight: 1.25,
              fontWeight: 400,
              letterSpacing: "0.01em",
            }}
          >
            Spend control and routing for AI agents
          </span>
        )}
      </span>
    </span>
  );
}
