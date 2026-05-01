/**
 * Prompt template runtime substitution (v0.3.x).
 *
 * The dashboard at `/projects/[id]/templates` is the CRUD + version-history
 * surface. Customers store named, versioned templates per-project. At
 * runtime they reference one via the `x-ts-template` request header and
 * we substitute Handlebars-style `{{var}}` placeholders.
 *
 * Header format:
 *   x-ts-template: <name>           → uses the template's `current_version`
 *   x-ts-template: <name>@<int>     → pins to that exact version
 *   x-ts-template: <name>@latest    → same as no-version (current_version)
 *
 * Variable sources (merged, later wins):
 *   1. body.ts_template_vars   (preferred — supports large multi-line values)
 *   2. x-ts-template-vars      (header, JSON-encoded; convenient for tiny vars)
 *
 * Where the rendered template lands:
 *   - The template body becomes a system message.
 *   - If `messages[0]` already has role=system, it is REPLACED.
 *   - Otherwise we PREPEND a new {role:"system", content: rendered}.
 *
 * The rendered body is also subject to substitution itself, AND we run
 * substitution over every existing message's `content` (string parts only)
 * so customers can use the same placeholders inline in their user message
 * for ergonomics.
 *
 * Naming + size caps mirror the dashboard's `pattern="[A-Za-z0-9_.\-]{1,64}"`.
 *
 * Failure posture:
 *   - Bad header format → 400 (clear error message), request blocked.
 *   - Unknown template / version → 400.
 *   - Missing variable → leaves the literal `{{var}}` in place (loud in
 *     output, easy to spot during dev). Does NOT throw.
 *
 * The substitution is intentionally MINIMAL Handlebars — only `{{name}}`
 * with optional surrounding whitespace, single-segment names. No helpers,
 * no conditionals. Customers needing rich logic should render in their own
 * app code; the gateway is a switchyard, not a templating engine.
 */
import { sql } from "./db";

const NAME_RE = /^[A-Za-z0-9_.\-]{1,64}$/;

export type TemplateRef =
  | { ok: true; name: string; version: number | null }
  | { ok: false; error: string };

/**
 * Parse the `x-ts-template` header into name + optional pinned version.
 * Returns null when the header is absent (no-op on the request path).
 */
export function parseTemplateRef(
  raw: string | null | undefined
): TemplateRef | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const at = trimmed.indexOf("@");
  let name: string;
  let version: number | null = null;
  if (at < 0) {
    name = trimmed;
  } else {
    name = trimmed.slice(0, at).trim();
    const v = trimmed.slice(at + 1).trim();
    if (v.toLowerCase() === "latest" || v === "") {
      version = null;
    } else {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) {
        return {
          ok: false,
          error: `Bad x-ts-template version pin '${v}'. Use a positive integer or 'latest'.`,
        };
      }
      version = n;
    }
  }

  if (!NAME_RE.test(name)) {
    return {
      ok: false,
      error: `Bad x-ts-template name '${name}'. Allowed: A-Z a-z 0-9 _ . -, 1-64 chars.`,
    };
  }
  return { ok: true, name, version };
}

/**
 * Parse the optional `x-ts-template-vars` JSON-encoded header. Always
 * returns a plain object; bad JSON is logged and treated as empty so a
 * stray header doesn't take down the request path.
 */
export function parseTemplateVarsHeader(
  raw: string | null | undefined
): Record<string, string | number | boolean | null> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, string | number | boolean | null>;
    }
  } catch {
    // fall through
  }
  return {};
}

export type TemplateLookup =
  | {
      ok: true;
      template_id: string;
      name: string;
      version: number;
      body: string;
    }
  | { ok: false; error: string };

/**
 * Fetch the template body from Postgres. Scoped by project so two projects
 * can reuse the same template name.
 */
export async function loadTemplate(
  projectId: string,
  ref: { name: string; version: number | null }
): Promise<TemplateLookup> {
  const tplRows = await sql<
    { id: string; current_version: number }[]
  >`
    SELECT id, current_version
      FROM prompt_templates
     WHERE project_id = ${projectId} AND name = ${ref.name}
     LIMIT 1
  `;
  const tpl = tplRows[0];
  if (!tpl) {
    return {
      ok: false,
      error: `No prompt template named '${ref.name}' on this project.`,
    };
  }
  const wantVersion = ref.version ?? tpl.current_version;
  const verRows = await sql<{ body: string }[]>`
    SELECT body FROM prompt_template_versions
     WHERE template_id = ${tpl.id} AND version = ${wantVersion}
     LIMIT 1
  `;
  const ver = verRows[0];
  if (!ver) {
    return {
      ok: false,
      error: `Prompt template '${ref.name}' has no version ${wantVersion}.`,
    };
  }
  return {
    ok: true,
    template_id: tpl.id,
    name: ref.name,
    version: wantVersion,
    body: ver.body,
  };
}

/**
 * Substitute `{{var}}` placeholders. Whitespace tolerant — `{{ name }}` and
 * `{{name}}` both match. Unknown variables are left untouched (visible to
 * the model so the developer notices the typo on first call).
 */
export function renderTemplate(
  body: string,
  vars: Record<string, unknown>
): string {
  return body.replace(/\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}/g, (full, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return full;
    const v = vars[name];
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    try {
      return JSON.stringify(v);
    } catch {
      return full;
    }
  });
}

/**
 * Apply rendered template to the request body in place.
 *
 * Guarantees:
 *   - mutates `body.messages` (replaces the existing system message OR
 *     prepends a new one)
 *   - removes the `ts_template_vars` field (it's a TokSuan-only knob,
 *     forwarding it would confuse upstream providers that strict-validate)
 *   - applies the same substitution to existing message contents (string
 *     content only — multi-part / vision content is left as-is so we don't
 *     accidentally break image refs)
 */
export function applyTemplateToBody(
  body: { messages?: unknown; ts_template_vars?: unknown; [k: string]: unknown },
  rendered: string,
  vars: Record<string, unknown>
): void {
  const messages = Array.isArray(body.messages)
    ? (body.messages as Array<Record<string, unknown>>)
    : [];

  for (const m of messages) {
    if (typeof m.content === "string") {
      m.content = renderTemplate(m.content, vars);
    }
  }

  const sysMsg = { role: "system", content: rendered };
  if (messages.length > 0 && messages[0]!.role === "system") {
    messages[0] = sysMsg;
  } else {
    messages.unshift(sysMsg);
  }
  body.messages = messages;

  if ("ts_template_vars" in body) {
    delete body.ts_template_vars;
  }
}
