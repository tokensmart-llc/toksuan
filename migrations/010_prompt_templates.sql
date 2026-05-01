-- TokenSmart — Prompt template registry + version history (v0.2.x)
--
-- Additive + idempotent. Closes the OSS-audit functional gap #5c
-- (vs PromptLayer / LangSmith / Helicone "save and version your prompts"
-- feature).
--
-- Data model — append-only versioning:
--   prompt_templates          : project-scoped, named container (one row per
--                              "this is the recipe for our code-reviewer")
--   prompt_template_versions  : append-only history (one row per save).
--                              `current_version` on the parent always
--                              points at the version currently considered
--                              "latest" — defaults to highest version
--                              number; the user can pin to an older
--                              version via UI to roll back without
--                              losing the newer revisions.
--
-- The body is stored as plain text (templating syntax is up to the
-- caller — typical convention is `{{variable}}` Handlebars-style; the
-- gateway will expose a future `x-ts-template` header that does the
-- substitution. v0.2.x ships the registry only; substitution comes
-- when the first paying customer asks for it.

CREATE TABLE IF NOT EXISTS prompt_templates (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    -- The version row currently considered "active". The gateway resolves
    -- `x-ts-template: <name>` to (project, name, current_version) → body.
    current_version     INTEGER NOT NULL DEFAULT 1,
    description         TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, name)
);

CREATE INDEX IF NOT EXISTS idx_prompt_templates_project
  ON prompt_templates (project_id, name);

CREATE TABLE IF NOT EXISTS prompt_template_versions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id         UUID NOT NULL REFERENCES prompt_templates(id) ON DELETE CASCADE,
    version             INTEGER NOT NULL,
    body                TEXT NOT NULL,
    -- Optional one-line note about what changed in this version (UI shows
    -- it in the version-list timeline, like a commit message).
    note                TEXT,
    created_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (template_id, version)
);

CREATE INDEX IF NOT EXISTS idx_prompt_template_versions_template
  ON prompt_template_versions (template_id, version DESC);
