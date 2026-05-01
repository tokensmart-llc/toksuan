import { ImageResponse } from "next/og";

/**
 * Dynamically generated favicon. 32x32 PNG rendered from a small React
 * tree at build/request time via Next 15's ImageResponse (Satori under
 * the hood).
 *
 * Visually mirrors the in-app `<Logo />` mark: a deep-navy rounded
 * square with a compact "TS" monogram.
 *
 * Brand hex values must stay in sync with:
 *   - apps/dashboard/src/components/Logo.tsx
 *   - apps/dashboard/src/app/opengraph-image.tsx
 */
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

const BG = "#0F172A";
const TOKEN = "#6CB6FF";
const SAVINGS = "#5DD592";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: BG,
          borderRadius: 7,
          fontFamily: "Inter, Arial, sans-serif",
          fontSize: 13,
          fontWeight: 800,
          letterSpacing: -1.2,
        }}
      >
        <span style={{ color: TOKEN }}>T</span>
        <span style={{ color: SAVINGS }}>S</span>
      </div>
    ),
    size
  );
}
