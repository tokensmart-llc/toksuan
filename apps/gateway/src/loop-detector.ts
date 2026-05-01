import { sql } from "./db";

/**
 * In-memory rolling loop detector.
 *
 * Keeps per-fingerprint timestamp lists, prunes entries older than
 * `windowMs`, and flags a loop when the window contains >= `threshold`
 * entries. The whole thing is process-local on purpose:
 *
 *   - Hot path adds ~microseconds of work per request.
 *   - Losing state on restart is fine for v0 — if you meaningfully loop
 *     across a restart, you'll hit the threshold again quickly.
 *   - When we horizontally scale the gateway, this gets promoted to Redis.
 *
 * Phase 2 of the 16-week plan lives here. Keep the surface tiny so we can
 * swap the backend without touching callers.
 */

export type LoopCheck =
  | { detected: false; count: number; windowMs: number; threshold: number }
  | { detected: true; count: number; windowMs: number; threshold: number };

export type LoopDetectorOptions = {
  windowMs?: number;
  threshold?: number;
  now?: () => number;
};

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_THRESHOLD = 10;

// Occasionally sweep so an abandoned fingerprint doesn't hold a slot forever.
const SWEEP_EVERY_N_CALLS = 1000;

export class LoopDetector {
  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly now: () => number;
  private readonly windows = new Map<string, number[]>();
  private callsSinceSweep = 0;

  constructor(opts: LoopDetectorOptions = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.threshold = opts.threshold ?? DEFAULT_THRESHOLD;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Record a new call for this fingerprint and return the check result.
   * The call is always counted — even a flagged loop keeps accumulating so
   * repeat attempts are visible in the data.
   */
  recordAndCheck(fingerprint: string): LoopCheck {
    const now = this.now();
    const cutoff = now - this.windowMs;

    const existing = this.windows.get(fingerprint);
    const kept = existing ? existing.filter((t) => t >= cutoff) : [];
    kept.push(now);
    this.windows.set(fingerprint, kept);

    this.maybeSweep(cutoff);

    const count = kept.length;
    if (count >= this.threshold) {
      return { detected: true, count, windowMs: this.windowMs, threshold: this.threshold };
    }
    return { detected: false, count, windowMs: this.windowMs, threshold: this.threshold };
  }

  /** Only used for tests / introspection. */
  size(): number {
    return this.windows.size;
  }

  private maybeSweep(cutoff: number): void {
    this.callsSinceSweep += 1;
    if (this.callsSinceSweep < SWEEP_EVERY_N_CALLS) return;
    this.callsSinceSweep = 0;
    for (const [fp, ts] of this.windows) {
      const kept = ts.filter((t) => t >= cutoff);
      if (kept.length === 0) this.windows.delete(fp);
      else this.windows.set(fp, kept);
    }
  }
}

// Shared singleton for the gateway process.
export const loopDetector = new LoopDetector();

export async function recordDurableLoopAndCheck(
  projectId: string,
  fingerprint: string,
  opts: LoopDetectorOptions = {}
): Promise<LoopCheck> {
  const nowFn = opts.now ?? Date.now;
  const now = nowFn();
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const cutoff = new Date(now - windowMs);
  const sweepCutoff = new Date(now - Math.max(windowMs * 12, 24 * 60 * 60 * 1000));

  return sql.begin(async (tx) => {
    await tx`
      INSERT INTO loop_events (project_id, fingerprint)
      VALUES (${projectId}, ${fingerprint})
    `;

    await tx`
      DELETE FROM loop_events
      WHERE created_at < ${sweepCutoff}
    `;

    const rows = await tx<{ total: string }[]>`
      SELECT COUNT(*)::bigint AS total
      FROM loop_events
      WHERE project_id = ${projectId}
        AND fingerprint = ${fingerprint}
        AND created_at >= ${cutoff}
    `;
    const count = Number(rows[0]?.total ?? 0);
    if (count >= threshold) {
      return { detected: true, count, windowMs, threshold };
    }
    return { detected: false, count, windowMs, threshold };
  });
}
