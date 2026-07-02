import { dispatchAlert } from "./alerts";
import { detectProjectAnomaly } from "./anomaly";
import { dbBackend, listProjectsWithAlerts } from "./db";

/**
 * Background cost-anomaly monitor.
 *
 * Runs on a fixed interval, scans every project that has at least one
 * enabled `cost_anomaly` alert rule, and dispatches an alert when the
 * detector flags. A per-project cooldown prevents the same flagged hour
 * from blasting the same webhook every cycle until the spike subsides.
 *
 * In-memory cooldown matches the rest of the gateway's "process-local"
 * convention (loop-detector, pricing cache). When we promote to Redis for
 * horizontal scale, this map joins the loop-detector's window store.
 */

// Default: scan every 10 minutes. Configurable via env for tests / demos.
const SCAN_EVERY_MS =
  Number(process.env.TOKENSMART_ANOMALY_SCAN_MS) || 10 * 60 * 1000;
// Don't re-alert the same project for 6h after we've flagged it. Spikes that
// last longer than that will re-fire once the cooldown elapses, which is the
// behavior an operator actually wants.
const COOLDOWN_MS =
  Number(process.env.TOKENSMART_ANOMALY_COOLDOWN_MS) || 6 * 60 * 60 * 1000;

const cooldown = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;

async function runOnce(): Promise<void> {
  let projects: Array<{ project_id: string }>;
  try {
    projects = await listProjectsWithAlerts("cost_anomaly");
  } catch (err) {
    console.error("[anomaly-monitor] failed to list subscribed projects:", err);
    return;
  }
  if (projects.length === 0) return;

  const now = Date.now();
  await Promise.all(
    projects.map(async ({ project_id }) => {
      const lastAlerted = cooldown.get(project_id) ?? 0;
      if (now - lastAlerted < COOLDOWN_MS) return;

      let verdict;
      try {
        verdict = await detectProjectAnomaly(project_id);
      } catch (err) {
        console.error(
          `[anomaly-monitor] detection failed for ${project_id}:`,
          err
        );
        return;
      }
      if (!verdict.flagged) return;

      cooldown.set(project_id, now);

      const liftPct =
        verdict.baselineMeanMicroCents > 0
          ? (verdict.recentMicroCents / verdict.baselineMeanMicroCents - 1) * 100
          : null;

      dispatchAlert(project_id, "cost_anomaly", {
        recent_hour: verdict.recentHour,
        recent_micro_cents: verdict.recentMicroCents,
        baseline_mean_micro_cents: verdict.baselineMeanMicroCents,
        baseline_std_micro_cents: verdict.baselineStdMicroCents,
        z_score: Number(verdict.zScore.toFixed(2)),
        sample_count: verdict.sampleCount,
        lift_pct: liftPct == null ? null : Number(liftPct.toFixed(1)),
        cooldown_ms: COOLDOWN_MS,
      });

      console.log(
        `[anomaly-monitor] flagged ${project_id}: $${(verdict.recentMicroCents / 100_000).toFixed(4)} ` +
          `vs $${(verdict.baselineMeanMicroCents / 100_000).toFixed(4)} baseline ` +
          `(z=${verdict.zScore.toFixed(1)})`
      );
    })
  );
}

export function startCostAnomalyMonitor(): void {
  if (timer) return;

  if (process.env.TOKENSMART_ANOMALY_MONITOR_ENABLED !== "1") {
    console.log(
      "[anomaly-monitor] disabled (set TOKENSMART_ANOMALY_MONITOR_ENABLED=1 to enable)."
    );
    return;
  }

  // SQLite single-binary trial doesn't ship the cost-anomaly query path
  // (it's z-score over hourly buckets — the SQL uses Postgres-only
  // window/lateral patterns we deliberately didn't translate). The
  // detector is a hosted-tier feature; suppress the timer cleanly so
  // we don't spam logs with "relation requests does not exist"-style
  // crashes.
  if (dbBackend === "sqlite") {
    console.log(
      "[anomaly-monitor] disabled in SQLite trial mode (use Postgres for cost-anomaly alerts)."
    );
    return;
  }

  // First scan after one full interval — gateway just booted, nothing useful
  // to compare yet.
  timer = setInterval(() => {
    runOnce().catch((err) =>
      console.error("[anomaly-monitor] scan crashed:", err)
    );
  }, SCAN_EVERY_MS);

  // Don't keep the Bun process alive purely for this timer — if the HTTP
  // server is shutting down we want to exit immediately.
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref?: () => void }).unref?.();
  }

  console.log(
    `[anomaly-monitor] scanning every ${Math.round(SCAN_EVERY_MS / 1000)}s, cooldown ${Math.round(COOLDOWN_MS / 60_000)}m`
  );
}

export function stopCostAnomalyMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
