-- TokenSmart — Shadow A/B embedding similarity (v0.2.0)
--
-- Additive + idempotent. Safe on DBs already past 006.
--
-- Adds `similarity` to `ab_results` so the dashboard's Quality Proof card
-- can graduate from "shadow returned 2xx" (a coarse signal) to "shadow
-- response was semantically equivalent to the primary" (a real quality
-- signal).
--
-- Computed by gateway/src/shadow.ts AFTER the shadow call returns:
--
--   primary_embedding = embed(primary_response_content)
--   shadow_embedding  = embed(shadow_response_content)
--   similarity = cosine(primary_embedding, shadow_embedding)   -- in [-1, 1]
--                                                              -- typically [0, 1]
--
-- NULL = not computed. Reasons we might skip computation:
--   - TOKENSMART_QUALITY_EMBED_MODEL is unset (operator hasn't enabled it)
--   - Either response was an error / empty
--   - The embed call itself failed (we never want to retry blocking the row)
--
-- Why a single column not a JSONB blob: the dashboard only needs the scalar.
-- We don't store the embeddings themselves — they're large (1536 floats per
-- row even for the cheapest models) and we already store the response_body
-- so anyone wanting to recompute can do it offline.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ab_results' AND column_name = 'similarity'
  ) THEN
    ALTER TABLE ab_results
      ADD COLUMN similarity REAL;
  END IF;
END$$;

-- Range constraint (best-effort — we still allow NULL).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'ab_results' AND column_name = 'similarity'
      AND constraint_name = 'ab_results_similarity_range'
  ) THEN
    BEGIN
      ALTER TABLE ab_results
        ADD CONSTRAINT ab_results_similarity_range
        CHECK (similarity IS NULL OR (similarity >= -1.0 AND similarity <= 1.0));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END$$;

-- Optional partial index for the dashboard aggregate query — only indexes
-- the rows that actually carry a value, so untagged installs pay no cost.
CREATE INDEX IF NOT EXISTS idx_ab_results_similarity
  ON ab_results (similarity)
  WHERE similarity IS NOT NULL;
