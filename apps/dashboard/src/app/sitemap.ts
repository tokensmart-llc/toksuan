import type { MetadataRoute } from "next";

/**
 * Minimal sitemap — lists only the surfaces we actually want indexed
 * (same set as `robots.ts` `allow`). Refreshed when the build runs;
 * everything is dynamic, not ISR, so the timestamps below are the
 * right "last meaningful change" signal for search engines.
 */
function origin(): string {
  const raw = process.env.NEXT_PUBLIC_BASE_URL?.trim();
  if (!raw) return "http://localhost:3000";
  return raw.replace(/\/+$/, "");
}

export default function sitemap(): MetadataRoute.Sitemap {
  const base = origin();
  const now = new Date();
  return [
    {
      url: `${base}/`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${base}/estimate`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 1.0,
    },
    {
      url: `${base}/login`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.3,
    },
  ];
}
