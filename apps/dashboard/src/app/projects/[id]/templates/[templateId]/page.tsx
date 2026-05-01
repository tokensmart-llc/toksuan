import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession, isAuthEnabled } from "@/lib/auth";
import {
  getProjectForUser,
  getPromptTemplate,
  listPromptTemplateVersions,
  type PromptTemplateRow,
  type PromptTemplateVersionRow,
} from "@/lib/db";
import { CopyButton } from "@/components/CopyButton";
import {
  deletePromptTemplateAction,
  pinPromptTemplateVersionAction,
  savePromptTemplateAction,
} from "../actions";
import { getDictionary } from "@/lib/i18n.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function fmtTime(d: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(d));
}

export default async function TemplateDetailPage({
  params,
}: {
  params: Promise<{ id: string; templateId: string }>;
}) {
  if (!isAuthEnabled()) redirect("/");
  const session = await getSession();
  if (!session) redirect("/login");
  const { id, templateId } = await params;

  const project = await getProjectForUser(session.user.id, id);
  if (!project) notFound();

  let template: PromptTemplateRow | null = null;
  let versions: PromptTemplateVersionRow[] = [];
  try {
    template = await getPromptTemplate(project.id, templateId);
    if (template) {
      versions = await listPromptTemplateVersions(template.id);
    }
  } catch {
    // surfaced via not-found below
  }

  if (!template) notFound();

  const { locale, t } = await getDictionary();
  const tt = t.promptTemplates;

  // Templated bits — pre-substitute so the JSX stays clean.
  const activeVersionTitle = tt.detailActiveVersionTpl.replace(
    "{n}",
    String(template.current_version)
  );
  const appendNextVersionLabel = tt.detailAppendNextVersionTpl.replace(
    "{n}",
    String(template.current_version + 1)
  );
  const appendSubmitLabel = tt.detailAppendSubmitTpl.replace(
    "{n}",
    String(template.current_version + 1)
  );
  const deleteSubmitLabel = tt.detailDeleteSubmitTpl.replace(
    "{name}",
    template.name
  );

  return (
    <main>
      <Link
        href={`/projects/${project.id}/templates`}
        className="back-link"
      >
        {tt.detailBackBtn}
      </Link>

      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <h1 style={{ marginBottom: 0 }}>
          <code style={{ fontFamily: "var(--font-mono)" }}>
            {template.name}
          </code>
        </h1>
        <span className="pill pill-accent">v{template.current_version}</span>
        <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
          · {versions.length}
          {versions.length === 1
            ? tt.detailVersionsCountSingular
            : tt.detailVersionsCountPlural}
        </span>
      </div>
      {template.description && (
        <p className="tagline" style={{ marginTop: 6 }}>
          {template.description}
        </p>
      )}

      {/* Active version */}
      <div className="card">
        <div className="card-header">
          <h2>{activeVersionTitle}</h2>
          <div className="card-header-spacer" />
          <CopyButton
            value={template.current_body ?? ""}
            display={tt.detailCopyBodyLabel}
            t={t.copyButton}
          />
        </div>
        <pre
          className="code-block"
          style={{
            whiteSpace: "pre-wrap",
            maxHeight: 480,
            overflow: "auto",
          }}
        >
          {template.current_body ?? tt.detailEmptyBody}
        </pre>
      </div>

      {/* Append a new version */}
      <div
        className="card"
        style={{
          borderLeftWidth: 4,
          borderLeftStyle: "solid",
          borderLeftColor: "var(--accent)",
        }}
      >
        <div className="card-header">
          <h2>{tt.detailAppendTitle}</h2>
          <div className="card-header-spacer" />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            {appendNextVersionLabel}
          </span>
        </div>
        <form
          action={savePromptTemplateAction}
          style={{ display: "grid", gap: 12 }}
        >
          <input type="hidden" name="project_id" value={project.id} />
          <input type="hidden" name="name" value={template.name} />
          <textarea
            name="body"
            required
            rows={10}
            className="input"
            defaultValue={template.current_body ?? ""}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              resize: "vertical",
              padding: 10,
            }}
          />
          <input
            name="note"
            type="text"
            placeholder={tt.detailAppendNotePlaceholder}
            className="input"
          />
          <div>
            <button type="submit" className="btn btn-primary">
              {appendSubmitLabel}
            </button>
          </div>
        </form>
      </div>

      {/* Version history */}
      <div className="card">
        <div className="card-header">
          <h2>{tt.detailHistoryTitle}</h2>
          <div className="card-header-spacer" />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            {tt.detailHistoryNewestFirst}
          </span>
        </div>
        {versions.length === 0 ? (
          <div className="empty">{tt.detailHistoryEmpty}</div>
        ) : (
          <div style={{ display: "grid", gap: 14 }}>
            {versions.map((v) => {
              const isActive = v.version === template.current_version;
              return (
                <div
                  key={v.id}
                  className="card"
                  style={{
                    margin: 0,
                    background: "var(--surface)",
                    borderColor: isActive ? "var(--accent)" : "var(--border)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 10,
                      flexWrap: "wrap",
                    }}
                  >
                    <strong style={{ fontFamily: "var(--font-mono)" }}>
                      v{v.version}
                    </strong>
                    {isActive && (
                      <span className="pill pill-accent">
                        {tt.detailHistoryActivePill}
                      </span>
                    )}
                    <span
                      style={{ color: "var(--text-muted)", fontSize: 12 }}
                    >
                      {fmtTime(v.created_at, locale)}
                    </span>
                    {v.created_by_email && (
                      <span
                        style={{
                          color: "var(--text-muted)",
                          fontSize: 11,
                        }}
                      >
                        {tt.detailHistoryByPrefix}
                        {v.created_by_email}
                      </span>
                    )}
                    <div style={{ flex: 1 }} />
                    {!isActive && (
                      <form action={pinPromptTemplateVersionAction}>
                        <input
                          type="hidden"
                          name="project_id"
                          value={project.id}
                        />
                        <input
                          type="hidden"
                          name="template_id"
                          value={template.id}
                        />
                        <input
                          type="hidden"
                          name="version"
                          value={String(v.version)}
                        />
                        <button
                          type="submit"
                          className="btn btn-sm"
                          title={tt.detailHistoryPinTitle}
                        >
                          {tt.detailHistoryPinBtn}
                        </button>
                      </form>
                    )}
                  </div>
                  {v.note && (
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--text-secondary)",
                        marginTop: 6,
                        marginBottom: 6,
                        fontStyle: "italic",
                      }}
                    >
                      {v.note}
                    </div>
                  )}
                  <pre
                    className="code-block"
                    style={{
                      whiteSpace: "pre-wrap",
                      maxHeight: 200,
                      overflow: "auto",
                      marginTop: 8,
                    }}
                  >
                    {v.body}
                  </pre>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Danger zone */}
      <div
        className="card card-danger"
        style={{
          marginTop: 24,
        }}
      >
        <div className="card-header">
          <h2 style={{ color: "var(--danger)" }}>{tt.detailDangerTitle}</h2>
        </div>
        <div
          style={{
            fontSize: 13,
            color: "var(--text-secondary)",
            lineHeight: 1.55,
            marginBottom: 10,
          }}
        >
          {tt.detailDangerBody}
        </div>
        <form action={deletePromptTemplateAction}>
          <input type="hidden" name="project_id" value={project.id} />
          <input type="hidden" name="template_id" value={template.id} />
          <button type="submit" className="btn btn-danger">
            {deleteSubmitLabel}
          </button>
        </form>
      </div>
    </main>
  );
}
