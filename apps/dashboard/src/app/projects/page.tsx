import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, isAuthEnabled } from "@/lib/auth";
import { listProjectsForUser } from "@/lib/db";
import { getDictionary } from "@/lib/i18n.server";
import { createProjectAction, deleteProjectAction } from "./actions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function fmtDate(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(d));
}

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams?: Promise<{ toast?: string; toast_arg?: string }>;
}) {
  if (!isAuthEnabled()) redirect("/");
  const session = await getSession();
  if (!session) redirect("/login");

  const sp = searchParams ? await searchParams : {};
  const projects = await listProjectsForUser(session.user.id);
  const providerJustSaved = sp.toast === "provider-key-saved";
  const firstProject = projects[0] ?? null;
  const { t } = await getDictionary();
  const tProj = t.projects;

  return (
    <main>
      <h1>{tProj.listTitle}</h1>
      <p className="tagline">{tProj.listTagline}</p>

      {providerJustSaved && (
        <div
          className="card card-success"
          style={{
            marginBottom: 24,
            borderLeftWidth: 4,
            borderLeftStyle: "solid",
            borderLeftColor: "var(--success)",
          }}
        >
          <div className="card-header">
            <h2>{tProj.providerJustSavedTitle}</h2>
          </div>
          <p
            style={{
              fontSize: 13,
              color: "var(--text-secondary)",
              lineHeight: 1.55,
              margin: "0 0 12px 0",
            }}
          >
            {tProj.providerJustSavedBody}
          </p>
          {firstProject ? (
            <Link href={`/projects/${firstProject.id}`} className="btn btn-primary">
              {tProj.providerJustSavedCta.replace("{project}", firstProject.name)}
            </Link>
          ) : (
            <form action={createProjectAction} style={{ display: "flex", gap: 10 }}>
              <input type="hidden" name="name" value="default-agent-poc" />
              <button type="submit" className="btn btn-primary">
                {tProj.createButton}
              </button>
            </form>
          )}
        </div>
      )}

      {projects.length === 0 && !providerJustSaved && (
        <div
          className="card card-accent"
          style={{
            marginBottom: 24,
            borderLeftWidth: 4,
            borderLeftStyle: "solid",
            borderLeftColor: "var(--accent)",
          }}
        >
          <div className="card-header">
            <h2>{tProj.fastPathTitle}</h2>
          </div>
          <p
            style={{
              fontSize: 13,
              color: "var(--text-secondary)",
              lineHeight: 1.55,
              margin: "0 0 12px 0",
            }}
          >
            {tProj.fastPathBody}
          </p>
          <form action={createProjectAction} style={{ display: "flex", gap: 10 }}>
            <input type="hidden" name="name" value="default-agent-poc" />
            <button type="submit" className="btn btn-primary">
              {tProj.fastPathCreateBtn}
            </button>
            <Link href="/settings#provider-keys" className="btn">
              {tProj.fastPathAddKeyBtn}
            </Link>
          </form>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <h2>{tProj.createButton}</h2>
        </div>
        <form
          action={createProjectAction}
          style={{ display: "flex", gap: 10 }}
        >
          <input
            name="name"
            placeholder={tProj.namePlaceholder}
            required
            className="input"
            style={{ flex: 1 }}
          />
          <button type="submit" className="btn btn-primary">
            {t.common.create}
          </button>
        </form>
      </div>

      <div className="card">
        <div className="card-header">
          <h2>{tProj.listTitle}</h2>
          <div className="card-header-spacer" />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            {projects.length}
          </span>
        </div>
        {projects.length === 0 ? (
          <div className="empty">{tProj.emptyBody}</div>
        ) : (
          <table className="data-table clickable">
            <thead>
              <tr>
                <th>{tProj.listColName}</th>
                <th>{tProj.listColCreated}</th>
                <th>{tProj.listColProjectId}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => {
                const href = `/projects/${p.id}`;
                return (
                  <tr key={p.id}>
                    <td>
                      <Link href={href} className="row-link">
                        <strong>{p.name}</strong>
                      </Link>
                    </td>
                    <td>
                      <Link
                        href={href}
                        className="row-link"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        {fmtDate(p.created_at)}
                      </Link>
                    </td>
                    <td>
                      <Link
                        href={href}
                        className="row-link"
                        style={{ color: "var(--text-muted)" }}
                      >
                        <code className="code-inline">{p.id}</code>
                      </Link>
                    </td>
                    <td style={{ padding: "10px 14px", textAlign: "right" }}>
                      <form action={deleteProjectAction}>
                        <input type="hidden" name="project_id" value={p.id} />
                        <button
                          type="submit"
                          className="btn btn-sm btn-danger"
                          title={tProj.listDeleteTitle}
                        >
                          {tProj.cardDelete}
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
