"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSession, userOwnsProject } from "@/lib/auth";
import { logAuditEvent } from "@/lib/audit";
import {
  deletePromptTemplate,
  pinPromptTemplateVersion,
  upsertPromptTemplateVersion,
} from "@/lib/db";

async function requireSession() {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

async function actorIp(): Promise<string | null> {
  const h = await headers();
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    null
  );
}

function templateNameValid(name: string): boolean {
  // Stable URL-safe slug-ish identifier. Forbid spaces, weird chars; allow
  // letters/digits/dash/underscore/dot. 1..64 chars. This becomes part of
  // the eventual `x-ts-template: <name>` header — keep it ASCII-clean.
  return /^[A-Za-z0-9_.-]{1,64}$/.test(name);
}

export async function savePromptTemplateAction(
  formData: FormData
): Promise<void> {
  const session = await requireSession();
  const projectId = String(formData.get("project_id") ?? "");
  if (!(await userOwnsProject(session.user.id, projectId))) {
    redirect("/projects");
  }

  const name = String(formData.get("name") ?? "").trim();
  const body = String(formData.get("body") ?? "");
  const note = String(formData.get("note") ?? "").trim() || null;
  const description =
    String(formData.get("description") ?? "").trim() || null;

  if (!name || !templateNameValid(name) || !body) {
    redirect(
      `/projects/${projectId}/templates?toast=template-bad-input`
    );
  }

  const { templateId, version } = await upsertPromptTemplateVersion({
    projectId,
    name,
    body,
    description,
    note,
    createdByUserId: session.user.id,
  });

  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    projectId,
    event: "prompt_template.saved",
    targetType: "prompt_template",
    targetId: templateId,
    metadata: { name, version, body_chars: body.length, note },
    ip: await actorIp(),
  });

  redirect(
    `/projects/${projectId}/templates/${templateId}?toast=template-saved`
  );
}

export async function pinPromptTemplateVersionAction(
  formData: FormData
): Promise<void> {
  const session = await requireSession();
  const projectId = String(formData.get("project_id") ?? "");
  if (!(await userOwnsProject(session.user.id, projectId))) {
    redirect("/projects");
  }
  const templateId = String(formData.get("template_id") ?? "");
  const version = Number(formData.get("version") ?? "0");
  if (!templateId || !Number.isInteger(version) || version < 1) {
    redirect(`/projects/${projectId}/templates`);
  }
  await pinPromptTemplateVersion(projectId, templateId, version);
  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    projectId,
    event: "prompt_template.pinned",
    targetType: "prompt_template",
    targetId: templateId,
    metadata: { version },
    ip: await actorIp(),
  });
  redirect(`/projects/${projectId}/templates/${templateId}?toast=template-saved`);
}

export async function deletePromptTemplateAction(
  formData: FormData
): Promise<void> {
  const session = await requireSession();
  const projectId = String(formData.get("project_id") ?? "");
  if (!(await userOwnsProject(session.user.id, projectId))) {
    redirect("/projects");
  }
  const templateId = String(formData.get("template_id") ?? "");
  if (!templateId) {
    redirect(`/projects/${projectId}/templates`);
  }
  await deletePromptTemplate(projectId, templateId);
  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    projectId,
    event: "prompt_template.deleted",
    targetType: "prompt_template",
    targetId: templateId,
    metadata: {},
    ip: await actorIp(),
  });
  redirect(`/projects/${projectId}/templates?toast=template-deleted`);
}
