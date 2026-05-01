-- TokenSmart — Routing savings (v0.0.9)
--
-- Additive + idempotent. Safe on DBs already past 004.
--
-- Adds per-request `routing_saving_micro_cents` so the dashboard can show
-- a "saved $X" hero number without recomputing pricing on every read.
--
-- Written by gateway `routes/chat.ts` at request completion when we know
-- the routed-to model's real usage. Formula:
--
--   would_have_cost = calcCostMicroCents(
--     original_provider, original_model,
--     input_tokens, output_tokens, cached_input_tokens
--   )
--   routing_saving = max(0, would_have_cost - cost_micro_cents)
--
-- This intentionally uses the routed model's actual token counts to price
-- the counterfactual. A more exhaustive approach (re-tokenize the prompt
-- with the original model's tokenizer) would be marginally more accurate
-- for reasoning models where output-token distributions differ — but it
-- also opens a "TokenSmart retroactively changed my savings number"
-- footgun if upstream pricing shifts. Storing the value at write time
-- freezes it to the price that was in effect at that moment.

-- Safe on first-time run via ALTER … IF NOT EXISTS idiom.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'requests' AND column_name = 'routing_saving_micro_cents'
  ) THEN
    ALTER TABLE requests
      ADD COLUMN routing_saving_micro_cents BIGINT NOT NULL DEFAULT 0;
  END IF;
END$$;

-- Fast WHERE-is-routed aggregation on the dashboard home query.
CREATE INDEX IF NOT EXISTS idx_requests_routing_saving_created
  ON requests (created_at DESC)
  WHERE routing_saving_micro_cents > 0;
