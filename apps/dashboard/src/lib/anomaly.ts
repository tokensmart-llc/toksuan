import { sql } from "./db";

/**
 * Cost anomaly detection.
 *
 * Take hourly spend buckets for the last `baselineDays` days, compute the
 * mean + sample stddev, then compare the most recent fully-elapsed hour.
 * Anything above mean + 3σ AND meaningfully different in absolute terms is
 * flagged. Elapsed-time bucketing avoids the trivial "spend so far today is
 * higher than yesterday's full day" trap.
 *
 * The verdict is intentionally conservative — we'd rather miss a real spike
 * than cry wolf. False alerts make the user dismiss every banner forever.
 */

type Scope = string[] | undefined;

export type AnomalyVerdict = {
  flagged: boolean;
  reason: string | null;
  recentMicroCents: number;
  baselineMeanMicroCents: number;
  baselineStdMicroCents: number;
  zScore: number;
  recentHour: string; // ISO yyyy-mm-ddTHH (for display)
  /**
   * Number of usable baseline samples. Below ~24 the verdict is statistically
   * meaningless; UI should suppress the banner.
   */
  sampleCount: number;
};

const projectScopeForR = (scope: Scope) => {
  if (scope === undefined) return sql`TRUE`;
  if (scope.length === 0) return sql`FALSE`;
  return sql`r.project_id = ANY(${scope}::uuid[])`;
};

export async function detectSpendAnomaly(
  scope?: Scope,
  baselineDays = 14
): Promise<AnomalyVerdict> {
  // Bucket by hour. We exclude the CURRENT in-progress hour from both the
  // baseline AND the recent comparison so we never compare a partial bucket
  // against full ones.
  const rows = await sql<{ bucket: Date; cost_micro_cents: string }[]>`
    SELECT DATE_TRUNC('hour', r.created_at) AS bucket,
           COALESCE(SUM(r.cost_micro_cents), 0)::bigint AS cost_micro_cents
      FROM requests r
     WHERE (${projectScopeForR(scope)})
       AND r.status = 'success'
       AND r.created_at >= NOW() - (${baselineDays} || ' days')::INTERVAL
       AND r.created_at <  DATE_TRUNC('hour', NOW())
     GROUP BY 1
     ORDER BY 1 DESC
  `;

  if (rows.length < 6) {
    return {
      flagged: false,
      reason: null,
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

  // Two guardrails before we flag:
  //   1. z-score >= 3  (strict so we don't cry wolf on noisy baselines)
  //   2. absolute lift >= 500 micro_cents (= $0.005). Below this anything is
  //      noise from a single small request, not worth alerting.
  const flagged = z >= 3 && recentVal - mean >= 500;

  const reason = flagged
    ? `Last hour spent ${microUsd(recentVal)} — ${z.toFixed(1)}σ above the ${baseline.length}-hour baseline of ${microUsd(mean)}.`
    : null;

  return {
    flagged,
    reason,
    recentMicroCents: recentVal,
    baselineMeanMicroCents: Math.round(mean),
    baselineStdMicroCents: Math.round(std),
    zScore: z,
    recentHour: new Date(recent.bucket).toISOString().slice(0, 13),
    sampleCount: baseline.length,
  };
}

function microUsd(mc: number): string {
  return `$${(mc / 100_000).toFixed(4)}`;
}
