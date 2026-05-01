import { sql } from "./db";

/**
 * Per-project cost anomaly detector.
 *
 * Mirrors the dashboard's `lib/anomaly.ts` logic but runs against ONE project
 * at a time so the background monitor can dispatch a per-project alert with
 * the right webhook target.
 *
 * Methodology: hourly success-spend buckets over the last `baselineDays`
 * days. Compare the most recent fully-elapsed hour's spend against the
 * baseline mean + sample stddev. Flag iff `z >= 3` AND absolute lift is
 * meaningful (`>= 500 micro_cents` = $0.005).
 */

export type ProjectAnomaly = {
  flagged: boolean;
  recentMicroCents: number;
  baselineMeanMicroCents: number;
  baselineStdMicroCents: number;
  zScore: number;
  recentHour: string;
  sampleCount: number;
};

const MIN_BASELINE_HOURS = 6;
const Z_THRESHOLD = 3;
const MIN_LIFT_MICRO_CENTS = 500; // $0.005

export async function detectProjectAnomaly(
  projectId: string,
  baselineDays = 14
): Promise<ProjectAnomaly> {
  const rows = await sql<{ bucket: Date; cost_micro_cents: string }[]>`
    SELECT DATE_TRUNC('hour', created_at) AS bucket,
           COALESCE(SUM(cost_micro_cents), 0)::bigint AS cost_micro_cents
      FROM requests
     WHERE project_id = ${projectId}
       AND status = 'success'
       AND created_at >= NOW() - (${baselineDays} || ' days')::INTERVAL
       AND created_at <  DATE_TRUNC('hour', NOW())
     GROUP BY 1
     ORDER BY 1 DESC
  `;

  if (rows.length < MIN_BASELINE_HOURS) {
    return {
      flagged: false,
      recentMicroCents: 0,
      baselineMeanMicroCents: 0,
      baselineStdMicroCents: 0,
      zScore: 0,
      recentHour: "",
      sampleCount: rows.length,
    };
  }

  const recent = rows[0];
  const baseline = rows.slice(1).map((r) => Number(r.cost_micro_cents));
  const recentVal = Number(recent.cost_micro_cents);

  const mean = baseline.reduce((a, b) => a + b, 0) / baseline.length;
  const variance =
    baseline.reduce((acc, v) => acc + (v - mean) ** 2, 0) /
    Math.max(baseline.length - 1, 1);
  const std = Math.sqrt(variance);

  const z = std > 0 ? (recentVal - mean) / std : 0;
  const flagged = z >= Z_THRESHOLD && recentVal - mean >= MIN_LIFT_MICRO_CENTS;

  return {
    flagged,
    recentMicroCents: recentVal,
    baselineMeanMicroCents: Math.round(mean),
    baselineStdMicroCents: Math.round(std),
    zScore: z,
    recentHour: new Date(recent.bucket).toISOString().slice(0, 13),
    sampleCount: baseline.length,
  };
}
