/**
 * v0.6.7 — auto-fallback end-to-end: rewrite 4xx triggers a one-shot
 * retry against the caller's original model, response 200s.
 *
 * Symmetric to `failed-request-observability.test.ts` (same env-seed
 * + dynamic-import + skip-if-Postgres-unreachable pattern). Sets up:
 *   - a fixture project with a routing_rule rewriting
 *     `gpt-fake-original` → `gpt-fake-rewritten`
 *   - a mocked global fetch that 400s when the rewritten model is
 *     called, 200s when the original model is called
 *
 * Asserts:
 *   - The chat request returns 200 (auto-fallback rescued the call)
 *   - The X-Tokensmart-Landed-Model header reflects the original
 *     (post-fallback) model
 *   - The DB row carries `tags.auto_fallback = "rewrite_4xx_fallback"`
 */

process.env.DATABASE_URL = ":memory:";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "sk-test-fixture";
// Disable baseline policy so the routing rule is the only thing
// rewriting models (otherwise baseline could fire on top of the rule).
process.env.TOKENSMART_BASELINE_POLICY_ENABLED = "0";
process.env.TOKENSMART_CACHE_ENABLED = "0";
// Disable the LLM judge — the routing rule fires on a complexity
// threshold check; we want a deterministic "low complexity" path
// without burning real upstream calls for the judge.
delete process.env.TOKENSMART_CLASSIFIER_MODEL;

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { Hono } from "hono";
import { randomUUID, createHash } from "node:crypto";

const FIXTURE_PROJECT_ID = `00000000-0000-4000-b000-${Math.floor(
  Math.random() * 1e12
)
  .toString(16)
  .padStart(12, "0")}`;
const FIXTURE_API_KEY_PLAINTEXT = `ts_test_${randomUUID().replace(/-/g, "")}`;
const FIXTURE_API_KEY_HASH = createHash("sha256")
  .update(FIXTURE_API_KEY_PLAINTEXT)
  .digest("hex");

const ASKED_MODEL = "gpt-fake-original";
const REWRITTEN_MODEL = "gpt-fake-rewritten";

type GatewaySql = (typeof import("../src/db"))["sql"];
let app: Hono;
let sql: GatewaySql;
let dbReachable = false;

const originalFetch = globalThis.fetch;
type MockCall = { model: string };
let mockCalls: MockCall[] = [];

function installMockFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!url.includes("/chat/completions")) {
      // Pass through for anything else (e.g. health probes).
      return originalFetch(input, init);
    }
    const body = init?.body
      ? (JSON.parse(String(init.body)) as { model?: string; messages?: unknown })
      : {};
    const model = body.model ?? "(none)";

    // The LLM-judge complexity scorer (TOKENSMART_CLASSIFIER_MODEL) hits
    // chat completions too, with a system prompt that tells it to "reply
    // with EXACTLY one number from 0 to 100". That call rides the same
    // global fetch as the real upstream — return a low-complexity
    // sentinel so the heuristic + LLM-judge layer completes cleanly,
    // and DON'T record it in mockCalls (the test assertions are about
    // the routing flow's chat-completions hits, not the classifier's
    // sidecar call). Recognized by the system prompt wording, which
    // is stable across the codebase. When the env doesn't set a
    // judge model, this branch never fires + the heuristic is used
    // directly.
    const messages = Array.isArray(body.messages)
      ? (body.messages as Array<{ role?: string; content?: unknown }>)
      : [];
    const isJudgeCall = messages.some(
      (m) =>
        m?.role === "system" &&
        typeof m.content === "string" &&
        m.content.includes("rate task complexity")
    );
    if (isJudgeCall) {
      return Response.json(
        {
          id: `judge-mock-${Date.now()}`,
          object: "chat.completion",
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "20" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 1, total_tokens: 31 },
        },
        { status: 200 }
      );
    }

    mockCalls.push({ model });

    if (model === REWRITTEN_MODEL) {
      // Mimic an OpenAI-compatible proxy returning a model-invalid 400.
      return Response.json(
        {
          error: {
            message: `Unknown model: ${model}`,
            type: "invalid_request_error",
          },
        },
        { status: 400 }
      );
    }
    if (model === ASKED_MODEL) {
      // Original model works — honor the caller's intent.
      return Response.json(
        {
          id: `chatcmpl-mock-${Date.now()}`,
          object: "chat.completion",
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok from original" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        },
        { status: 200 }
      );
    }
    return Response.json(
      { error: { message: `unexpected mock-fetch model: ${model}` } },
      { status: 500 }
    );
  }) as typeof fetch;
}

beforeAll(async () => {
  const { runPendingMigrations } = await import("../src/migrate");
  const dbModule = await import("../src/db");
  const { chatRoutes } = await import("../src/routes/chat");
  sql = dbModule.sql;

  try {
    await Promise.race([
      sql<Array<{ ok: number }>>`SELECT 1 AS ok`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("probe timeout")), 2000)
      ),
    ]);
    dbReachable = true;
  } catch (err) {
    console.log(
      `[rewrite-fallback-e2e] DB not reachable (${(err as Error).message}); skipping.`
    );
    return;
  }

  app = new Hono();
  app.route("/", chatRoutes);

  await runPendingMigrations();
  await sql`DELETE FROM requests WHERE project_id = ${FIXTURE_PROJECT_ID}`.catch(
    () => {}
  );
  await sql`DELETE FROM routing_rules WHERE project_id = ${FIXTURE_PROJECT_ID}`.catch(
    () => {}
  );
  await sql`DELETE FROM api_keys WHERE project_id = ${FIXTURE_PROJECT_ID}`.catch(
    () => {}
  );
  await sql`DELETE FROM projects WHERE id = ${FIXTURE_PROJECT_ID}`.catch(
    () => {}
  );
  await sql`
    INSERT INTO projects (id, name) VALUES (${FIXTURE_PROJECT_ID}, 'rewrite-fallback-e2e-test')
  `;
  await sql`
    INSERT INTO api_keys (project_id, name, key, key_hash, key_prefix, key_last4)
    VALUES (
      ${FIXTURE_PROJECT_ID},
      'rewrite-fallback-e2e-key',
      ${FIXTURE_API_KEY_PLAINTEXT},
      ${FIXTURE_API_KEY_HASH},
      ${FIXTURE_API_KEY_PLAINTEXT.slice(0, 7)},
      ${FIXTURE_API_KEY_PLAINTEXT.slice(-4)}
    )
  `;
  // Routing rule with high threshold so it ALWAYS fires regardless of
  // the request's complexity score. Pattern matches the literal asked
  // model name. `enabled` uses the JS boolean — postgres.js binds it as
  // BOOLEAN; the SQLite shim coerces to INTEGER 0/1 transparently. Don't
  // pass a literal `1` here: Postgres rejects it as type-mismatch on the
  // BOOLEAN column.
  await sql`
    INSERT INTO routing_rules (
      project_id, enabled, threshold, from_pattern, to_model, mode
    ) VALUES (
      ${FIXTURE_PROJECT_ID}, ${true}, 100.0,
      ${"^" + ASKED_MODEL + "$"},
      ${REWRITTEN_MODEL},
      'route'
    )
  `;
});

afterAll(async () => {
  if (!sql || !dbReachable) return;
  await sql`DELETE FROM requests WHERE project_id = ${FIXTURE_PROJECT_ID}`.catch(
    () => {}
  );
  await sql`DELETE FROM routing_rules WHERE project_id = ${FIXTURE_PROJECT_ID}`.catch(
    () => {}
  );
  await sql`DELETE FROM api_keys WHERE project_id = ${FIXTURE_PROJECT_ID}`.catch(
    () => {}
  );
  await sql`DELETE FROM projects WHERE id = ${FIXTURE_PROJECT_ID}`.catch(
    () => {}
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  mockCalls = [];
});

async function postChat(body: Record<string, unknown>): Promise<{
  status: number;
  json: unknown;
  headers: Record<string, string>;
}> {
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${FIXTURE_API_KEY_PLAINTEXT}`,
    },
    body: JSON.stringify(body),
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json, headers };
}

describe("v0.6.7 — auto-fallback when baseline-rewritten model 4xxs", () => {
  test("400 'Unknown model' on the rewritten model triggers a one-shot retry with the original; client sees 200", async () => {
    if (!dbReachable) return;
    installMockFetch();

    const res = await postChat({
      model: ASKED_MODEL,
      messages: [{ role: "user", content: "hi" }],
    });

    // Auto-fallback rescued the call.
    expect(res.status).toBe(200);
    // Two upstream hits: one to the rewritten (400), one to the
    // original (200). The order proves the fallback fired AFTER
    // the rewrite-failure detection.
    expect(mockCalls).toEqual([
      { model: REWRITTEN_MODEL },
      { model: ASKED_MODEL },
    ]);

    // Caller-visible routing-decision headers reflect the FINAL
    // model (the original, post-fallback).
    expect(res.headers["x-tokensmart-asked-model"]).toBe(ASKED_MODEL);
    expect(res.headers["x-tokensmart-landed-model"]).toBe(ASKED_MODEL);

    // Wait briefly for the row insert to flush.
    await new Promise((r) => setTimeout(r, 50));

    const requestId = res.headers["x-tokensmart-request-id"];
    const rows = await sql<
      Array<{
        status: string;
        model: string;
        provider: string;
        tags: unknown;
      }>
    >`
      SELECT status, model, provider, tags
      FROM requests
      WHERE id = ${requestId!}
      LIMIT 1
    `;
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row!.status).toBe("success");
    expect(row!.model).toBe(ASKED_MODEL);

    // Tag breadcrumb so operators can sort/filter to see how often the
    // safety net fires (target: very rarely; high rate = stale policy
    // artifact). SQLite stores JSON as text; Postgres jsonb auto-parses.
    const tags: Record<string, string> =
      typeof row!.tags === "string"
        ? (JSON.parse(row!.tags) as Record<string, string>)
        : (row!.tags as Record<string, string>);
    expect(tags.auto_fallback).toBe("rewrite_4xx_fallback");
  });

  test("when fallback ALSO fails, original 4xx surfaces to caller (don't compound failures)", async () => {
    if (!dbReachable) return;
    // Both upstream calls return 400 — the fallback also fails.
    // (Judge complexity calls bypass mockCalls — same reasoning as
    // installMockFetch above.)
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!url.includes("/chat/completions")) {
        return originalFetch(input, init);
      }
      const body = init?.body
        ? (JSON.parse(String(init.body)) as { model?: string; messages?: unknown })
        : {};
      const messages = Array.isArray(body.messages)
        ? (body.messages as Array<{ role?: string; content?: unknown }>)
        : [];
      const isJudgeCall = messages.some(
        (m) =>
          m?.role === "system" &&
          typeof m.content === "string" &&
          m.content.includes("rate task complexity")
      );
      if (isJudgeCall) {
        return Response.json(
          {
            id: `judge-mock-${Date.now()}`,
            object: "chat.completion",
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "20" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 30, completion_tokens: 1, total_tokens: 31 },
          },
          { status: 200 }
        );
      }
      mockCalls.push({ model: body.model ?? "(none)" });
      return Response.json(
        {
          error: {
            message: `Unknown model: ${body.model}`,
            type: "invalid_request_error",
          },
        },
        { status: 400 }
      );
    }) as typeof fetch;

    const res = await postChat({
      model: ASKED_MODEL,
      messages: [{ role: "user", content: "hi" }],
    });

    // Caller sees the upstream's 400 message verbatim. The chat
    // handler proxies the 400 status code through to the client.
    expect(res.status).toBe(400);
    // Two upstream hits — fallback was attempted but also 400'd.
    expect(mockCalls).toHaveLength(2);

    await new Promise((r) => setTimeout(r, 50));

    const requestId = res.headers["x-tokensmart-request-id"];
    const rows = await sql<Array<{ status: string; tags: unknown }>>`
      SELECT status, tags FROM requests WHERE id = ${requestId!} LIMIT 1
    `;
    const row = rows[0]!;
    expect(row.status).toBe("error");
    const tags: Record<string, string> =
      typeof row.tags === "string"
        ? (JSON.parse(row.tags) as Record<string, string>)
        : (row.tags as Record<string, string>);
    // The "_failed" suffix is the operator-visible breadcrumb for
    // "we tried the safety net and it didn't help" — distinct from
    // the success case's plain "rewrite_4xx_fallback".
    expect(tags.auto_fallback).toBe("rewrite_4xx_fallback_failed");
  });

  test("env opt-out (TOKENSMART_REWRITE_FALLBACK_ENABLED=0) skips the fallback entirely", async () => {
    if (!dbReachable) return;
    installMockFetch();
    process.env.TOKENSMART_REWRITE_FALLBACK_ENABLED = "0";
    try {
      const res = await postChat({
        model: ASKED_MODEL,
        messages: [{ role: "user", content: "hi" }],
      });
      // Fallback disabled → caller sees the upstream 400 from the
      // rewritten model.
      expect(res.status).toBe(400);
      // Single upstream hit — no fallback attempt.
      expect(mockCalls).toEqual([{ model: REWRITTEN_MODEL }]);
    } finally {
      delete process.env.TOKENSMART_REWRITE_FALLBACK_ENABLED;
    }
  });
});
