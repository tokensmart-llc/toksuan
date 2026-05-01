-- 028: Aggregate telemetry for models the gateway rejected at resolve time.
--
-- Background. Every time `resolveProvider` returns `no_template` (we
-- don't recognize the model name) OR `no_credentials` (we recognize
-- the provider but have no key configured for it), the user sees a
-- 400. Today those rejections are invisible to operators — they
-- scroll past in gateway logs and no aggregated signal reaches the
-- dashboard.
--
-- With this table we can answer: "which models are users trying to
-- use that we don't support?" The answer drives two decisions:
--   1. Where to focus L2 pricing-catalog additions (the most-wanted
--      new model names)
--   2. Which L4 custom providers to suggest to individual users
--      ("you tried `grok-2-latest` 47 times this week — here's how
--      to register xAI as a custom provider")
--
-- Shape is AGGREGATE (one row per model+reason+project tuple), not
-- per-request. A per-request log would bloat `requests` and pay dozens
-- of insert-per-second; this table's hot-path write is an UPSERT that
-- increments a counter + stamps `last_seen`. Hundreds of requests per
-- second against a single popular-but-unsupported model all hit the
-- same row, with the UPDATE cost dominated by index lookup + tuple
-- rewrite — constant per row, irrespective of traffic.
--
-- Why not just scan `requests` for status='error'? Rejected requests
-- are NOT inserted into `requests` — the resolver fails BEFORE any
-- DB write on the request path. We track them here on purpose so
-- operators see the signal even though no full request row exists.

CREATE TABLE IF NOT EXISTS ops_model_rejections (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Lowercased model string the caller sent. Case-normalized here
    -- so `gpt-5` and `GPT-5` aggregate into one row.
    model           TEXT NOT NULL,
    -- Built-in provider NAME if we inferred one from prefix, else NULL.
    -- Populated for `no_credentials` rejections (we know it's anthropic,
    -- we just don't have a key); NULL for `no_template` rejections.
    provider_guess  TEXT,
    -- Reason enum: `no_template` (model doesn't match any known
    -- provider), `no_credentials` (template matched but no key). Kept
    -- as TEXT + CHECK so we can extend without ALTER TYPE.
    reason          TEXT NOT NULL CHECK (reason IN ('no_template', 'no_credentials')),
    -- Project (if authenticated). NULL for public / health-probe style
    -- rejections that slip past auth. Optional — the operator-view
    -- aggregates across all projects anyway.
    project_id      UUID REFERENCES projects(id) ON DELETE SET NULL,
    hit_count       BIGINT NOT NULL DEFAULT 0,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Natural upsert key: the tuple we increment against. The partial-NULL
-- handling (project_id) is explicit — Postgres 15+ `NULLS NOT DISTINCT`
-- treats two NULL project_ids as equal, which is what we want so a
-- stream of unauthed rejections collapses into one row per model.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ops_model_rejections_model_reason_project
    ON ops_model_rejections (model, reason, COALESCE(project_id::text, ''));

-- Hot-path operator query: "top-N rejected models in the last N days".
-- Index on last_seen_at so the WHERE filter prunes quickly.
CREATE INDEX IF NOT EXISTS idx_ops_model_rejections_last_seen
    ON ops_model_rejections (last_seen_at DESC);
