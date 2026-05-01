import type { ReactNode } from "react";
import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { getSession, isAuthEnabled } from "@/lib/auth";
import { getProjectForUser, sql } from "@/lib/db";
import {
  extractValidationView,
  formatAccuracy,
  getProjectClassifier,
  getProjectClassifierSummary,
  listProjectClassifiers,
} from "@/lib/embedding-classifier-history";
import type {
  ClassifierStatus,
  ClassifierValidationView,
  PerClassMetricRow,
  ProjectClassifierRow,
  ProjectClassifierSummary,
} from "@/lib/embedding-classifier-history";
import { planAllows, minPlanForEntitlement } from "@/lib/plans";
import {
  setClassifierLearningEnabledAction,
  rollbackClassifierAction,
} from "./actions";
import { getDictionary } from "@/lib/i18n.server";
import type { Dictionary } from "@/i18n/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Per-project embedding-classifier changelog.
 *
 * One row per classifier version produced by the nightly retrain (or
 * manual / rollback / backfill invocations). Four sections:
 *
 *   1. Toast banner    — feedback on pause/resume/rollback actions
 *   2. Active card     — version, accuracies, sample count, pause/resume
 *   3. Per-class panel — precision/recall/support for the ACTIVE version
 *                        (pulls payload for the one active row only; the
 *                        ~70KB JSON stays off the list view)
 *   4. History table   — versions with rollback buttons on superseded rows
 *
 * All controls gated on the same `background_policy_training` entitlement
 * as the routing-policy page. Free users see the UI but get an upgrade
 * toast on submit.
 */

function fmtDateTime(d: Date | null, locale: string): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(d));
}

function statusPillClass(status: ClassifierStatus): string {
  switch (status) {
    case "active":
      return "pill pill-success";
    case "pending":
      return "pill pill-warning";
    case "superseded":
      return "pill pill-neutral";
    case "rejected":
      return "pill pill-danger";
  }
}

function accuracyColor(
  tone: "ok" | "warn" | "bad" | "none"
): React.CSSProperties {
  switch (tone) {
    case "ok":
      return { color: "var(--text-success, #1d7a3e)" };
    case "warn":
      return { color: "var(--text-warning, #9c6b00)" };
    case "bad":
      return { color: "var(--text-danger, #b42318)" };
    default:
      return { color: "var(--text-muted)" };
  }
}

export default async function ProjectClassifierChangelogPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    toast?: string;
    to?: string;
    new?: string;
    detail?: string;
  }>;
}) {
  if (!isAuthEnabled()) redirect("/");
  const session = await getSession();
  if (!session) redirect("/login");

  const { id: projectId } = await params;
  const sp = await searchParams;
  const project = await getProjectForUser(session.user.id, projectId);
  if (!project) notFound();

  let rows: ProjectClassifierRow[] = [];
  let summary: ProjectClassifierSummary | null = null;
  let activeValidation: ClassifierValidationView | null = null;
  let dbError: string | null = null;
  let learningEnabled = false;
  try {
    [rows, summary] = await Promise.all([
      listProjectClassifiers(projectId, 50),
      getProjectClassifierSummary(projectId),
    ]);
    const flag = await sql<{ learning_enabled: boolean }[]>`
      SELECT learning_enabled FROM projects WHERE id = ${projectId}
    `;
    learningEnabled = flag[0]?.learning_enabled ?? false;
    // Only the ACTIVE row's payload is pulled back for the per-class
    // metrics panel — we don't want to drag 50 × 70KB of JSONB across
    // the list view.
    if (summary && summary.active_version != null) {
      const detail = await getProjectClassifier(
        projectId,
        summary.active_version
      );
      if (detail) {
        activeValidation = extractValidationView(detail.payload);
      }
    }
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  const activeRow = rows.find((r) => r.status === "active") ?? null;
  const canTrain = planAllows(session.user.plan, "background_policy_training");
  const requiredPlanName = minPlanForEntitlement(
    "background_policy_training"
  ).name;

  const { locale, t } = await getDictionary();
  const tc = t.classifier;

  return (
    <main>
      <Link href={`/projects/${projectId}`} className="back-link">
        ← {project.name}
      </Link>
      <h1>{tc.title}</h1>
      <p className="tagline">{tc.tagline}</p>

      {sp.toast && <ToastBanner toast={sp.toast} sp={sp} tc={tc} />}

      {dbError && (
        <section className="card" style={{ marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>{tc.dbErrTitle}</h2>
          <p style={{ margin: 0, fontSize: 14, color: "var(--text-muted)" }}>
            {dbError}
          </p>
          <p
            style={{
              marginTop: 12,
              marginBottom: 0,
              fontSize: 13,
              color: "var(--text-muted)",
            }}
          >
            {tc.dbErrHint}
          </p>
        </section>
      )}

      {/* =================== Active card ==================== */}
      <section className="card" style={{ marginTop: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h2 style={{ margin: 0 }}>{tc.activeTitle}</h2>
          {activeRow ? (
            <span className={statusPillClass(activeRow.status)}>
              v{activeRow.version}
            </span>
          ) : (
            <span className="pill pill-neutral">
              {tc.activeNoVersionPill}
            </span>
          )}
        </div>
        {activeRow ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 16,
              marginTop: 16,
            }}
          >
            <StatTile
              label={tc.tileTaskTypeAcc}
              accuracy={activeRow.task_type_accuracy}
            />
            <StatTile
              label={tc.tileComplexityAcc}
              accuracy={activeRow.complexity_accuracy}
            />
            <Tile
              label={tc.tileTrainedOn}
              value={tc.tileTrainedOnRowsTpl.replace(
                "{n}",
                activeRow.sample_count.toLocaleString()
              )}
            />
            <Tile
              label={tc.tileActivated}
              value={fmtDateTime(activeRow.activated_at, locale)}
            />
            {summary && summary.rejected_30d > 0 && (
              <Tile
                label={tc.tileRejected30d}
                value={String(summary.rejected_30d)}
                tone="warn"
              />
            )}
          </div>
        ) : (
          <EmptyStateActive
            learningEnabled={learningEnabled}
            hasHistory={summary != null && summary.total_versions > 0}
            canTrain={canTrain}
            requiredPlanName={requiredPlanName}
            tc={tc}
          />
        )}

        {/* pause/resume */}
        <div
          style={{
            marginTop: 18,
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <form action={setClassifierLearningEnabledAction}>
            <input type="hidden" name="project_id" value={projectId} />
            <input
              type="hidden"
              name="enabled"
              value={learningEnabled ? "false" : "true"}
            />
            <button
              type="submit"
              className={learningEnabled ? "btn-secondary" : "btn-primary"}
              disabled={!canTrain && !learningEnabled}
            >
              {learningEnabled ? tc.pauseTrainingBtn : tc.resumeTrainingBtn}
            </button>
          </form>
          <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
            {learningEnabled ? tc.trainingOnNote : tc.trainingPausedNote}
            {!canTrain && !learningEnabled && (
              <>
                {tc.trainingRequiresPrefix}
                <strong>{requiredPlanName}</strong>
                {tc.trainingRequiresSuffix}
              </>
            )}
          </span>
        </div>
      </section>

      {/* =================== Per-class metrics panel ==================== */}
      {activeValidation && activeValidation.n_validation > 0 && (
        <section className="card" style={{ marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>{tc.perClassTitle}</h2>
          <p
            style={{
              fontSize: 13,
              color: "var(--text-muted)",
              marginTop: 0,
            }}
          >
            {tc.perClassBodyTpl.replace(
              "{n}",
              activeValidation.n_validation.toLocaleString()
            )}
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: 18,
              marginTop: 12,
            }}
          >
            <PerClassTable
              title={tc.perClassTaskTypeHead}
              rows={activeValidation.task_type_per_class}
              tc={tc}
            />
            <PerClassTable
              title={tc.perClassComplexityHead}
              rows={activeValidation.complexity_per_class}
              tc={tc}
            />
          </div>
        </section>
      )}

      {/* =================== History table ==================== */}
      <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>{tc.historyTitle}</h2>
        {rows.length === 0 ? (
          <p style={{ color: "var(--text-muted)", margin: 0 }}>
            {tc.historyEmptyPrefix}
            <code>
              bun run train-embedding-classifier -- --project {projectId}
            </code>
            {tc.historyEmptySuffix}
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              className="table"
              style={{ minWidth: 860, width: "100%", fontSize: 13 }}
            >
              <thead>
                <tr>
                  <th>{tc.colV}</th>
                  <th>{tc.colStatus}</th>
                  <th>{tc.colSource}</th>
                  <th>{tc.colTaskTypeAcc}</th>
                  <th>{tc.colComplexityAcc}</th>
                  <th>{tc.colSamples}</th>
                  <th>{tc.colGenerated}</th>
                  <th>{tc.colNotes}</th>
                  <th style={{ width: 120 }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <HistoryRow
                    key={r.id}
                    row={r}
                    projectId={projectId}
                    canRollback={canTrain}
                    tc={tc}
                    locale={locale}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warn";
}) {
  return (
    <div className="card-inline" style={{ padding: 12 }}>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{label}</div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 600,
          marginTop: 4,
          color:
            tone === "warn"
              ? "var(--text-warning, #9c6b00)"
              : "var(--text-strong)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function StatTile({
  label,
  accuracy,
}: {
  label: string;
  accuracy: number | null;
}) {
  const a = formatAccuracy(accuracy);
  return (
    <div className="card-inline" style={{ padding: 12 }}>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{label}</div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 600,
          marginTop: 4,
          ...accuracyColor(a.tone),
        }}
      >
        {a.text}
      </div>
    </div>
  );
}

function PerClassTable({
  title,
  rows,
  tc,
}: {
  title: string;
  rows: PerClassMetricRow[];
  tc: Dictionary["classifier"];
}) {
  if (rows.length === 0) {
    return (
      <div>
        <h3 style={{ marginTop: 0, marginBottom: 8 }}>{title}</h3>
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
          {tc.perClassEmpty}
        </p>
      </div>
    );
  }
  return (
    <div>
      <h3 style={{ marginTop: 0, marginBottom: 8 }}>{title}</h3>
      <table className="table" style={{ width: "100%", fontSize: 13 }}>
        <thead>
          <tr>
            <th>{tc.perClassColClass}</th>
            <th>{tc.perClassColPrecision}</th>
            <th>{tc.perClassColRecall}</th>
            <th>{tc.perClassColSupport}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const p = formatAccuracy(r.precision);
            const rc = formatAccuracy(r.recall);
            return (
              <tr key={r.label}>
                <td>
                  <code>{r.label}</code>
                </td>
                <td style={accuracyColor(p.tone)}>{p.text}</td>
                <td style={accuracyColor(rc.tone)}>{rc.text}</td>
                <td style={{ color: "var(--text-muted)" }}>
                  {r.support.toLocaleString()}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HistoryRow({
  row,
  projectId,
  canRollback,
  tc,
  locale,
}: {
  row: ProjectClassifierRow;
  projectId: string;
  canRollback: boolean;
  tc: Dictionary["classifier"];
  locale: string;
}) {
  const tt = formatAccuracy(row.task_type_accuracy);
  const cx = formatAccuracy(row.complexity_accuracy);
  const canTargetRollback = row.status === "superseded";
  return (
    <tr>
      <td style={{ fontWeight: 600 }}>v{row.version}</td>
      <td>
        <span className={statusPillClass(row.status)}>{row.status}</span>
      </td>
      <td style={{ color: "var(--text-muted)" }}>{row.source}</td>
      <td style={accuracyColor(tt.tone)}>{tt.text}</td>
      <td style={accuracyColor(cx.tone)}>{cx.text}</td>
      <td style={{ color: "var(--text-muted)" }}>
        {row.sample_count.toLocaleString()}
      </td>
      <td style={{ color: "var(--text-muted)" }}>
        {fmtDateTime(row.generated_at, locale)}
      </td>
      <td
        style={{
          fontSize: 12,
          color: "var(--text-muted)",
          maxWidth: 320,
          wordBreak: "break-word",
        }}
      >
        {row.notes ?? "—"}
      </td>
      <td>
        {canTargetRollback && (
          <form action={rollbackClassifierAction}>
            <input type="hidden" name="project_id" value={projectId} />
            <input type="hidden" name="version" value={row.version} />
            <button
              type="submit"
              className="btn-secondary"
              style={{ fontSize: 12, padding: "4px 10px" }}
              disabled={!canRollback}
              title={
                canRollback
                  ? tc.rollbackTooltipReadyTpl.replace(
                      "{n}",
                      String(row.version)
                    )
                  : tc.rollbackTooltipGated
              }
            >
              {tc.rollbackBtn}
            </button>
          </form>
        )}
      </td>
    </tr>
  );
}

function EmptyStateActive({
  learningEnabled,
  hasHistory,
  canTrain,
  requiredPlanName,
  tc,
}: {
  learningEnabled: boolean;
  hasHistory: boolean;
  canTrain: boolean;
  requiredPlanName: string;
  tc: Dictionary["classifier"];
}) {
  return (
    <div
      style={{
        marginTop: 16,
        padding: 16,
        background: "var(--surface-muted)",
        borderRadius: 6,
      }}
    >
      <p style={{ margin: 0, fontSize: 14 }}>{tc.emptyActiveBody}</p>
      <p
        style={{
          margin: "8px 0 0 0",
          fontSize: 13,
          color: "var(--text-muted)",
        }}
      >
        {hasHistory ? (
          <>{tc.emptyActiveHasHistory}</>
        ) : !learningEnabled && !canTrain ? (
          <>
            {tc.emptyActiveUpgradePrefix}
            <Link href="/billing" style={{ color: "var(--accent)" }}>
              {tc.emptyActiveUpgradeLinkPrefix}
              <strong>{requiredPlanName}</strong>
              {tc.emptyActiveUpgradeLinkSuffix}
            </Link>
            {tc.emptyActiveUpgradeSuffix}
          </>
        ) : !learningEnabled ? (
          <>{tc.emptyActiveResumeMsg}</>
        ) : (
          <>{tc.emptyActiveLearningOnMsg}</>
        )}
      </p>
    </div>
  );
}

function ToastBanner({
  toast,
  sp,
  tc,
}: {
  toast: string;
  sp: { to?: string; new?: string; detail?: string };
  tc: Dictionary["classifier"];
}) {
  let kind: "ok" | "warn" | "bad" = "ok";
  let message: ReactNode;
  switch (toast) {
    case "learning_resumed":
      message = tc.toastLearningResumed;
      break;
    case "learning_paused":
      message = tc.toastLearningPaused;
      kind = "warn";
      break;
    case "upgrade_required_for_learning":
      message = (
        <>
          {tc.toastUpgradeRequiredPrefix}
          <Link href="/billing" style={{ color: "var(--accent)" }}>
            {tc.toastUpgradeRequiredLink}
          </Link>
          {tc.toastUpgradeRequiredSuffix}
        </>
      );
      kind = "warn";
      break;
    case "rollback_complete":
      message = tc.toastRollbackCompleteTpl
        .replace("{from}", sp.to ?? "?")
        .replace("{to}", sp.new ?? "?");
      break;
    case "rollback_failed":
      message = tc.toastRollbackFailedTpl.replace(
        "{detail}",
        sp.detail ?? tc.toastRollbackFailedNoDetail
      );
      kind = "bad";
      break;
    default:
      return null;
  }
  const bg =
    kind === "ok"
      ? "var(--surface-success, #e6f9ed)"
      : kind === "warn"
        ? "var(--surface-warning, #fff4e5)"
        : "var(--surface-danger, #fce8e6)";
  return (
    <div
      role="status"
      style={{
        padding: "10px 14px",
        borderRadius: 6,
        background: bg,
        margin: "16px 0 0 0",
        fontSize: 13,
      }}
    >
      {message}
    </div>
  );
}
