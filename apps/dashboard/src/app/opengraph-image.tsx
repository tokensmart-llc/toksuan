import { ImageResponse } from "next/og";

/**
 * Default Open Graph / Twitter card image for the dashboard origin.
 *
 * Matches the hero typography treatment on `/` (big verb contrast,
 * single accent color, no emoji). Generated at build time by Next 15's
 * ImageResponse - no static asset to maintain, one source of truth
 * with the in-app hero.
 *
 * Route-level metadata in `/estimate` / future landing pages overrides
 * this if they ship their own `opengraph-image.tsx`.
 *
 * Brand hex values must stay in sync with:
 *   - apps/dashboard/src/components/Logo.tsx
 *   - apps/dashboard/src/app/icon.tsx
 */

export const alt =
  "TokSuan - See it - Cap it - Shrink it -> Keep it running.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BG = "#0E1622";
const TEXT = "#D8DDE4";
const MUTED = "#93A1AF";
const ACCENT = "#6CB6FF";
const SAVINGS = "#5DD592";
const MARK_BG = "#0F172A";

// Mini brand mark - same TS monogram as the favicon, scaled up so it
// reads cleanly inside the OG card. Use plain text so the ImageResponse
// endpoint remains deterministic and does not depend on external assets.
const MARK_SIZE = 56;

// Stick to the ImageResponse edge renderer's built-in fonts so the image
// is emitted without a Google Fonts fetch. That keeps the build
// deterministic, the OG endpoint independent of outbound DNS, and the
// output stable in airgap / strict-egress deploys. If we ever want a
// branded font we can bundle the TTF via `ImageResponse({ fonts })`.
export default function OG() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          background: BG,
        }}
      >
        {/* Eyebrow / logo mark row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 18,
            marginBottom: 36,
          }}
        >
          <div
            style={{
              width: MARK_SIZE,
              height: MARK_SIZE,
              borderRadius: 12,
              background: MARK_BG,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "Inter, Arial, sans-serif",
              fontSize: 24,
              fontWeight: 800,
              letterSpacing: -2,
            }}
          >
            <span style={{ color: ACCENT }}>T</span>
            <span style={{ color: SAVINGS }}>S</span>
          </div>
          <div
            style={{
              fontSize: 28,
              fontWeight: 700,
              color: TEXT,
              letterSpacing: "0.02em",
              display: "flex",
            }}
          >
            TokSuan
          </div>
        </div>

        {/* Brand hero - the same typographic contrast the dashboard home
           uses. Verbs heavy + accent, connectives light + muted. */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "baseline",
            gap: 18,
            fontSize: 84,
            lineHeight: 1.05,
            letterSpacing: "-0.02em",
          }}
        >
          <span
            style={{ color: ACCENT, fontWeight: 800, display: "flex" }}
          >
            See
          </span>
          <span style={{ color: MUTED, fontWeight: 300, display: "flex" }}>
            it
          </span>
          <span style={{ color: MUTED, fontWeight: 300, display: "flex" }}>
            -
          </span>
          <span
            style={{ color: ACCENT, fontWeight: 800, display: "flex" }}
          >
            Cap
          </span>
          <span style={{ color: MUTED, fontWeight: 300, display: "flex" }}>
            it
          </span>
          <span style={{ color: MUTED, fontWeight: 300, display: "flex" }}>
            -
          </span>
          <span
            style={{ color: ACCENT, fontWeight: 800, display: "flex" }}
          >
            Shrink
          </span>
          <span style={{ color: MUTED, fontWeight: 300, display: "flex" }}>
            it
          </span>
          <span style={{ color: MUTED, fontWeight: 300, display: "flex" }}>
            {"->"}
          </span>
          <span
            style={{ color: SAVINGS, fontWeight: 800, display: "flex" }}
          >
            Keep
          </span>
          <span style={{ color: MUTED, fontWeight: 300, display: "flex" }}>
            it running.
          </span>
        </div>

        {/* Footer tagline */}
        <div
          style={{
            marginTop: 44,
            fontSize: 26,
            color: TEXT,
            opacity: 0.85,
            lineHeight: 1.4,
            display: "flex",
          }}
        >
          Spend control and routing for AI agents - change one base_url
        </div>
      </div>
    ),
    size
  );
}
