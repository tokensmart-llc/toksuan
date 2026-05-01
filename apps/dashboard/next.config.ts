import type { NextConfig } from "next";

/**
 * Security-relevant response headers applied globally.
 *
 * What each does + why we chose the value:
 *
 *   X-Frame-Options: DENY
 *     Block clickjacking (no iframe embedding at all). Dashboard has
 *     no legitimate embed use case; flip to SAMEORIGIN if we ever
 *     build an internal embed.
 *
 *   X-Content-Type-Options: nosniff
 *     Stops browsers from guessing content-type on served assets
 *     (historical XSS vector on .js served with wrong MIME type).
 *     Zero downside; always on.
 *
 *   Referrer-Policy: strict-origin-when-cross-origin
 *     Leak just the origin (not the path) on cross-origin nav, and
 *     nothing on http→https downgrades. Balances analytics with not
 *     leaking referring dashboard URLs (which can contain IDs) to
 *     third parties the user clicks through to.
 *
 *   Permissions-Policy
 *     Explicitly deny hardware access for a dashboard that has no
 *     reason to use it. Belt-and-braces against future XSS + third-
 *     party-script compromise.
 *
 *   Strict-Transport-Security (HSTS) — PRODUCTION ONLY
 *     Tell browsers to always use HTTPS for this origin for 2 years
 *     + all subdomains, and be preload-list-eligible. Never send this
 *     over HTTP or in dev — once a browser remembers an HSTS pin it
 *     will refuse plain HTTP to that origin, which breaks `localhost`
 *     HTTP dev.
 *
 * Things we DO NOT set:
 *   - Content-Security-Policy: the Next.js RSC payload uses inline
 *     scripts that would need `'unsafe-inline'` or a per-render
 *     nonce. Getting CSP right without breaking streaming RSC is a
 *     separate sprint; we'd rather ship no CSP than a broken
 *     permissive one that gives false compliance signal.
 *   - X-XSS-Protection: deprecated by all major browsers in favor of
 *     CSP. Modern recommendation is to omit or set to "0".
 */
const BASE_SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: [
      "accelerometer=()",
      "camera=()",
      "geolocation=()",
      "gyroscope=()",
      "magnetometer=()",
      "microphone=()",
      "payment=()",
      "usb=()",
    ].join(", "),
  },
];

const PROD_ONLY_HEADERS =
  process.env.NODE_ENV === "production"
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ]
    : [];

const config: NextConfig = {
  reactStrictMode: true,
  // `standalone` emits a self-contained `server.js` bundle into
  // `.next/standalone`. The Dockerfile copies that directory so the
  // production image doesn't need `node_modules` at runtime.
  output: "standalone",
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [...BASE_SECURITY_HEADERS, ...PROD_ONLY_HEADERS],
      },
    ];
  },
};

export default config;
