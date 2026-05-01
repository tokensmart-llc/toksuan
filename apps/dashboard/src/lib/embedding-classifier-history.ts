/**
 * Read-side helpers for the per-project embedding classifier changelog.
 *
 * Mirrors `policy-history.ts` 1:1 — same shape, same security boundary,
 * same design choices around returning metadata by default and asking
 * for the full payload only on the detail page. Kept in a separate
 * file (rather than folded into policy-history.ts) so the two
 * subsystems can evolve independently without cross-contamination.
 *
 * All queries go through the existing project-scoped sql client.
 * Authorization happens at the page layer.
 */

import { sql } from "./db";

export type ClassifierStatus = "pending" | "active" | "superseded" | "rejected";
export type ClassifierSource = "nightly_retrain" | "manual" | "rollback" | "backfill";

export type ProjectClassifierRow = {
  id: string;
  project_id: string;
  version: number;
  status: ClassifierStatus;
  source: ClassifierSource;
  sample_count: number;
  task_type_accuracy: number | null;
  complexity_accuracy: number | null;
  notes: string | null;
  generated_at: Date;
  activated_at: Date | null;
};

export type ProjectClassifierDetail = ProjectClassifierRow & {
  /** Full ClassifierArtifact JSON (schema_version, encoder, heads,
   *  per-class metrics, trained_on, validation). Shape documented in
   *  `apps/gateway/src/policy/embedding-classifier.ts`. We keep it as
   *  `unknown` at the DB boundary so the page component validates
   *  shape before rendering — never crash on a hand-edited row. */
  payload: unknown;
};

/**
 * List the most recent N classifier versions for a project, newest first.
 * Default 50 — matches the policy-history limit so the two history
 * tables have consistent scroll depth.
 */
export async function listProjectClassifiers(
  projectId: string,
  limit = 50
): Promise<ProjectClassifierRow[]> {
  return sql<ProjectClassifierRow[]>`
    SELECT id, project_id, version, status, source, sample_count,
           task_type_accuracy, complexity_accuracy, notes,
           generated_at, activated_at
    FROM project_embedding_classifiers
    WHERE project_id = ${projectId}
    ORDER BY version DESC
    LIMIT ${limit}
  `;
}

/**
 * Fetch one classifier version including the full payload. Used by
 * the detail / per-class-metrics panel — never on list view because
 * a ~70KB JSONB blob per row would blow out the table.
 */
export async function getProjectClassifier(
  projectId: string,
  version: number
): Promise<ProjectClassifierDetail | null> {
  const rows = await sql<ProjectClassifierDetail[]>`
    SELECT id, project_id, version, status, source, sample_count,
           task_type_accuracy, complexity_accuracy, notes,
           generated_at, activated_at, payload
    FROM project_embedding_classifiers
    WHERE project_id = ${projectId} AND version = ${version}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Quick boolean — has this project ever had a classifier artifact
 * (even a rejected one)? Drives the empty-state nudge.
 */
export async function projectHasClassifierHistory(
  projectId: string
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM project_embedding_classifiers WHERE project_id = ${projectId}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

/**
 * Compact summary for the project's home-page mini-card. Returns
 * everything the card needs in one round-trip:
 *
 *   - active_version: null for "no per-project classifier yet"
 *   - active accuracies so the card can render a 0-1 bar inline
 *   - rejected_count_30d to flag tenants whose retrains keep failing
 *     the quality floor (suspicious — worth investigating)
 */
export type ProjectClassifierSummary = {
  active_version: number | null;
  active_sample_count: number;
  active_activated_at: Date | null;
  active_task_type_accuracy: number | null;
  active_complexity_accuracy: number | null;
  /** Count of ANY rows for this project. Drives has_history gating. */
  total_versions: number;
  /** Rejected versions in the last 30d. ≥3 means "something's off". */
  rejected_30d: number;
};

export async function getProjectClassifierSummary(
  projectId: string
): Promise<ProjectClassifierSummary> {
  const rows = await sql<
    {
      active_version: number | null;
      active_sample_count: number | null;
      active_activated_at: Date | null;
      active_task_type_accuracy: number | null;
      active_complexity_accuracy: number | null;
      total_versions: string | null;
      rejected_30d: string | null;
    }[]
  >`
    SELECT
      (SELECT version              FROM project_embedding_classifiers WHERE project_id = ${projectId} AND status = 'active' LIMIT 1) AS active_version,
      (SELECT sample_count         FROM project_embedding_classifiers WHERE project_id = ${projectId} AND status = 'active' LIMIT 1) AS active_sample_count,
      (SELECT activated_at         FROM project_embedding_classifiers WHERE project_id = ${projectId} AND status = 'active' LIMIT 1) AS active_activated_at,
      (SELECT task_type_accuracy   FROM project_embedding_classifiers WHERE project_id = ${projectId} AND status = 'active' LIMIT 1) AS active_task_type_accuracy,
      (SELECT complexity_accuracy  FROM project_embedding_classifiers WHERE project_id = ${projectId} AND status = 'active' LIMIT 1) AS active_complexity_accuracy,
      (SELECT COUNT(*) FROM project_embedding_classifiers WHERE project_id = ${projectId})::bigint AS total_versions,
      (SELECT COUNT(*) FROM project_embedding_classifiers
         WHERE project_id = ${projectId}
           AND status = 'rejected'
           AND generated_at > NOW() - INTERVAL '30 days')::bigint AS rejected_30d
  `;
  const r = rows[0];
  return {
    active_version: r?.active_version ?? null,
    active_sample_count: Number(r?.active_sample_count ?? 0),
    active_activated_at: r?.active_activated_at ?? null,
    active_task_type_accuracy: r?.active_task_type_accuracy ?? null,
    active_complexity_accuracy: r?.active_complexity_accuracy ?? null,
    total_versions: Number(r?.total_versions ?? 0),
    rejected_30d: Number(r?.rejected_30d ?? 0),
  };
}

/**
 * Pull the per-class precision/recall/support from the artifact's
 * validation block. Returns null when the row's payload doesn't carry
 * the per-class structure (older v0.6.0 artifact, or malformed).
 *
 * Shape matches the `PerClassMetrics` type defined in
 * `apps/gateway/src/policy/embedding-classifier.ts`.
 */
export type PerClassMetricRow = {
  label: string;
  precision: number | null;
  recall: number | null;
  support: number;
};

export type ClassifierValidationView = {
  task_type_accuracy: number | null;
  complexity_accuracy: number | null;
  n_validation: number;
  task_type_per_class: PerClassMetricRow[];
  complexity_per_class: PerClassMetricRow[];
};

export function extractValidationView(
  payload: unknown
): ClassifierValidationView | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const v = p.validation as Record<string, unknown> | undefined;
  if (!v) return null;

  const taskTypeAcc =
    typeof v.task_type_accuracy === "number" ? v.task_type_accuracy : null;
  const complexityAcc =
    typeof v.complexity_accuracy === "number" ? v.complexity_accuracy : null;
  const n = typeof v.n_validation === "number" ? v.n_validation : 0;

  const tt = extractPerClass(v.task_type_per_class);
  const cx = extractPerClass(v.complexity_per_class);

  return {
    task_type_accuracy: taskTypeAcc,
    complexity_accuracy: complexityAcc,
    n_validation: n,
    task_type_per_class: tt,
    complexity_per_class: cx,
  };
}

function extractPerClass(raw: unknown): PerClassMetricRow[] {
  if (!raw || typeof raw !== "object") return [];
  const out: PerClassMetricRow[] = [];
  for (const [label, v] of Object.entries(raw)) {
    if (!v || typeof v !== "object") continue;
    const m = v as Record<string, unknown>;
    out.push({
      label,
      precision: typeof m.precision === "number" ? m.precision : null,
      recall: typeof m.recall === "number" ? m.recall : null,
      support: typeof m.support === "number" ? m.support : 0,
    });
  }
  return out;
}

/**
 * Render an accuracy value as a percentage string with the color cue
 * the dashboard uses — green for ≥ 0.80, yellow for 0.60–0.80, red
 * for < 0.60. Returns both the string and a suggested Tailwind
 * text-color class so the caller doesn't re-implement the thresholds.
 */
export function formatAccuracy(acc: number | null): {
  text: string;
  tone: "ok" | "warn" | "bad" | "none";
} {
  if (acc == null) return { text: "—", tone: "none" };
  const pct = `${(acc * 100).toFixed(1)}%`;
  if (acc >= 0.8) return { text: pct, tone: "ok" };
  if (acc >= 0.6) return { text: pct, tone: "warn" };
  return { text: pct, tone: "bad" };
}
