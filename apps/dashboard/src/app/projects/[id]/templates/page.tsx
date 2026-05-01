import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession, isAuthEnabled } from "@/lib/auth";
import {
  getProjectForUser,
  listPromptTemplatesForProject,
  type PromptTemplateRow,
} from "@/lib/db";
import { savePromptTemplateAction } from "./actions";
import { getPublicGatewayChatUrl } from "@/lib/public-url";
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

export default async function TemplatesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!isAuthEnabled()) redirect("/");
  const session = await getSession();
  if (!session) redirect("/login");
  const { id } = await params;

  const project = await getProjectForUser(session.user.id, id);
  if (!project) notFound();

  let templates: PromptTemplateRow[] = [];
  let dbError: string | null = null;
  try {
    templates = await listPromptTemplatesForProject(project.id);
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  const { locale, t } = await getDictionary();
  const tt = t.promptTemplates;

  return (
    <main>
      <Link href={`/projects/${project.id}`} className="back-link">
        ← {project.name}
      </Link>
      <h1>{tt.title}</h1>
      <p className="tagline">{tt.tagline}</p>

      {dbError && (
        <div className="card card-danger">
          <strong>{tt.dbErrTitle}</strong>
          <br />
          <span style={{ color: "var(--text-muted)" }}>{dbError}</span>
        </div>
      )}

      {/* Existing templates */}
      <div className="card">
        <div className="card-header">
          <h2>{tt.yourTitle}</h2>
          <div className="card-header-spacer" />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            {templates.length}
            {templates.length === 1 ? tt.countSingular : tt.countPlural}
          </span>
        </div>
        {templates.length === 0 ? (
          <div
            style={{
              padding: "20px 16px",
              fontSize: 13,
              color: "var(--text-secondary)",
              lineHeight: 1.55,
            }}
          >
            <strong>{tt.emptyTitle}</strong>
            {tt.emptyBodyPrefix}
            <code className="code-inline">code-reviewer</code>
            {tt.emptyBodyMid}
            <code className="code-inline">summarizer-strict</code>
            {tt.emptyBodySuffix}
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{tt.colName}</th>
                <th>{tt.colActiveVersion}</th>
                <th>{tt.colVersions}</th>
                <th>{tt.colUpdated}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {templates.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link
                      href={`/projects/${project.id}/templates/${row.id}`}
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 13,
                        color: "var(--accent)",
                        textDecoration: "none",
                      }}
                    >
                      {row.name}
                    </Link>
                    {row.description && (
                      <div
                        className="muted"
                        style={{ fontSize: 11, marginTop: 2 }}
                      >
                        {row.description}
                      </div>
                    )}
                  </td>
                  <td>
                    <code className="code-inline">
                      v{row.current_version}
                    </code>
                  </td>
                  <td className="muted">{row.version_count}</td>
                  <td className="muted">
                    {fmtTime(row.updated_at, locale)}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <Link
                      href={`/projects/${project.id}/templates/${row.id}`}
                      className="btn btn-sm btn-ghost"
                    >
                      {tt.openBtn}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Create / append form. Same form does both:
          - new template (name not in use yet → version 1)
          - new version on existing template (name matches → bump version) */}
      <div
        className="card"
        style={{
          marginTop: 24,
          borderLeftWidth: 4,
          borderLeftStyle: "solid",
          borderLeftColor: "var(--accent)",
        }}
      >
        <div className="card-header">
          <h2>{tt.formTitle}</h2>
          <div className="card-header-spacer" />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            {tt.formReusing}
          </span>
        </div>
        <form
          action={savePromptTemplateAction}
          style={{ display: "grid", gap: 12 }}
        >
          <input type="hidden" name="project_id" value={project.id} />
          <div
            style={{
              display: "grid",
              gap: 12,
              gridTemplateColumns: "1fr 1fr",
            }}
          >
            <label className="field">
              <span className="field-label">{tt.formNameLabel}</span>
              <input
                name="name"
                type="text"
                required
                pattern="[A-Za-z0-9_.\-]{1,64}"
                placeholder={tt.formNamePlaceholder}
                className="input"
              />
            </label>
            <label className="field">
              <span className="field-label">{tt.formDescriptionLabel}</span>
              <input
                name="description"
                type="text"
                placeholder={tt.formDescriptionPlaceholder}
                className="input"
              />
            </label>
          </div>

          <label className="field">
            <span className="field-label">{tt.formBodyLabel}</span>
            <textarea
              name="body"
              required
              rows={8}
              className="input"
              placeholder={tt.formBodyPlaceholder}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                resize: "vertical",
                padding: 10,
              }}
            />
          </label>

          <label className="field">
            <span className="field-label">{tt.formNoteLabel}</span>
            <input
              name="note"
              type="text"
              placeholder={tt.formNotePlaceholder}
              className="input"
            />
          </label>

          <div>
            <button type="submit" className="btn btn-primary">
              {tt.formSaveBtn}
            </button>
          </div>
        </form>
        <div
          style={{
            marginTop: 10,
            fontSize: 11,
            color: "var(--text-muted)",
            lineHeight: 1.5,
          }}
        >
          <strong>{tt.formSyntaxHintPrefix}</strong>
          {tt.formSyntaxHintSuffix}
        </div>
      </div>

      {/* Runtime usage card — only render if there's at least one template
          to reference. Otherwise it's noise on a fresh project. */}
      {templates.length > 0 && (
        <div className="card" style={{ marginTop: 24 }}>
          <div className="card-header">
            <h2>{tt.runtimeTitle}</h2>
            <div className="card-header-spacer" />
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
              {tt.runtimeHeaderHint}
            </span>
          </div>
          <div
            style={{
              padding: "4px 0 6px",
              fontSize: 13,
              color: "var(--text-secondary)",
              lineHeight: 1.55,
            }}
          >
            {tt.runtimeBody}
          </div>
          <pre
            style={{
              padding: 12,
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              background: "var(--code-bg)",
              borderRadius: 6,
              overflowX: "auto",
              lineHeight: 1.55,
              margin: "10px 0 6px",
            }}
          >
{`curl -s ${getPublicGatewayChatUrl()} \\
  -H "Authorization: Bearer $TOKENSMART_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "x-ts-template: ${templates[0]!.name}" \\
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role":"user","content":"Review {{code}}"}],
    "ts_template_vars": {"code": "function foo(){return 1;}"}
  }'`}
          </pre>
          <ul
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              lineHeight: 1.7,
              margin: "8px 0 0 18px",
              paddingLeft: 0,
            }}
          >
            <li>
              {tt.runtimeBullet1Prefix}
              <code className="code-inline">x-ts-template: name@3</code>
              {tt.runtimeBullet1Mid}
              <code className="code-inline">
                v{templates[0]!.current_version}
              </code>{" "}
              for{" "}
              <code className="code-inline">{templates[0]!.name}</code>
              {tt.runtimeBullet1Suffix}
            </li>
            <li>
              {tt.runtimeBullet2Prefix}
              <code className="code-inline">ts_template_vars</code>
              {tt.runtimeBullet2Mid}
              <code className="code-inline">x-ts-template-vars</code>
              {tt.runtimeBullet2Suffix}
            </li>
            <li>{tt.runtimeBullet3}</li>
            <li>
              {tt.runtimeBullet4Prefix}
              <code className="code-inline">template=name</code>
              {tt.runtimeBullet4Mid}
              <code className="code-inline">template_version=N</code>
              {tt.runtimeBullet4Suffix}
            </li>
          </ul>
        </div>
      )}
    </main>
  );
}
