/**
 * End-to-end verification script.
 *
 * Spins up a mock OpenAI-compatible upstream + a real gateway against a
 * temporary SQLite DB, and exercises four scenarios that single-module
 * unit tests can't catch:
 *
 *   A.  Persistent upstream 500 → must surface as 502 from the gateway,
 *       NOT 200, even after retries are exhausted.  (failover bug fix)
 *   A2. Transient 500 then 200 → succeeds via the retry layer.
 *   B.  Concurrent burst > tiny budget → some get budget_exceeded
 *       (proves reservation logic actually pre-deducts).
 *   C.  Repeating the same prompt past threshold → loop_detected
 *       (proves DB-backed durable window works).
 *
 * Exits non-zero if any scenario fails.
 */

import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildSql } from "../src/sql-driver";

// Ports default to a high pair unlikely to collide on a fresh dev box,
// but `bun run e2e` historically hard-coded 18790/18791 and occasionally
// hit EADDRINUSE on workstations running other long-lived services on
// the same range (openclaw-gateway holds 18791 here, for example).
//
//   * Gateway port — env override is the simplest knob; the gateway
//     subprocess crashes loud-and-clear (EADDRINUSE) if the port is
//     taken, so we don't try to auto-discover.
//   * Mock upstream — set to 0 by default so the OS picks any free
//     ephemeral port. Resolved port is read off `mockServer.port`
//     after `Bun.serve` returns, so the script self-heals against
//     collisions without operator intervention. Override with
//     E2E_MOCK_PORT=<n> when a fixed port is needed (e.g. firewall
//     rules, reproducing a specific failure).
const GATEWAY_PORT = Number(process.env.E2E_GATEWAY_PORT) || 18790;
const MOCK_PORT_HINT = process.env.E2E_MOCK_PORT
  ? Number(process.env.E2E_MOCK_PORT)
  : 0;
const DEV_KEY = "tokensmart-dev-key";
const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}`;
// Filled in by startMockUpstream() once the OS-assigned port is known.
let mockUrl = "";

type MockMode =
  | { kind: "ok" }
  | { kind: "always_500" }
  | { kind: "five_hundred_then_ok"; remaining500s: number };

let mockMode: MockMode = { kind: "ok" };
let mockServer: ReturnType<typeof Bun.serve> | null = null;
let mockHits = 0;

function setMockMode(mode: MockMode): void {
  mockMode = mode;
  mockHits = 0;
}

function startMockUpstream(): void {
  mockServer = Bun.serve({
    port: MOCK_PORT_HINT,
    hostname: "127.0.0.1",
    async fetch(req) {
      mockHits++;
      const url = new URL(req.url);
      if (url.pathname.endsWith("/chat/completions")) {
        if (mockMode.kind === "always_500") {
          return Response.json(
            { error: { message: "mock: always 500" } },
            { status: 500 }
          );
        }
        if (mockMode.kind === "five_hundred_then_ok") {
          if (mockMode.remaining500s > 0) {
            mockMode.remaining500s--;
            return Response.json(
              { error: { message: "mock: temporary 500" } },
              { status: 500 }
            );
          }
        }
        const body = (await req.json().catch(() => ({}))) as {
          model?: string;
        };
        return Response.json(
          {
            id: `chatcmpl-mock-${Date.now()}`,
            object: "chat.completion",
            model: body.model ?? "mock-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
          { status: 200 }
        );
      }
      return Response.json({ error: "unknown route" }, { status: 404 });
    },
  });
  // `Bun.serve` resolves `port: 0` to whatever the OS handed out, so
  // we have to read it back here — every downstream consumer (the
  // gateway subprocess's OPENAI_BASE_URL, the log line) needs the
  // resolved address rather than the request hint.
  mockUrl = `http://127.0.0.1:${mockServer.port}`;
  console.log(`[e2e] mock upstream up on ${mockUrl}`);
}

async function readProjectIdFromDb(dbPath: string): Promise<string> {
  const sql = buildSql(`sqlite:${dbPath}`);
  const rows = await sql<Array<{ project_id: string }>>`
    SELECT project_id FROM api_keys WHERE key = ${DEV_KEY} LIMIT 1
  `;
  const projectId = rows[0]?.project_id;
  await (sql as unknown as { end: () => Promise<void> }).end();
  if (!projectId) throw new Error("dev api key not seeded by gateway boot");
  return projectId;
}

async function setTinyBudget(dbPath: string, projectId: string): Promise<void> {
  const sql = buildSql(`sqlite:${dbPath}`);
  await sql`DELETE FROM budgets WHERE project_id = ${projectId}`;
  await sql`
    INSERT INTO budgets (project_id, period, limit_micro_cents, enabled)
    VALUES (${projectId}, 'daily', 1000, 1)
  `;
  await (sql as unknown as { end: () => Promise<void> }).end();
}

async function clearBudget(dbPath: string, projectId: string): Promise<void> {
  const sql = buildSql(`sqlite:${dbPath}`);
  await sql`DELETE FROM budget_reservations WHERE project_id = ${projectId}`;
  await sql`DELETE FROM budgets WHERE project_id = ${projectId}`;
  await (sql as unknown as { end: () => Promise<void> }).end();
}

async function clearLoopState(dbPath: string, projectId: string): Promise<void> {
  const sql = buildSql(`sqlite:${dbPath}`);
  await sql`DELETE FROM loop_events WHERE project_id = ${projectId}`;
  await (sql as unknown as { end: () => Promise<void> }).end();
}

async function waitForGateway(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${GATEWAY_URL}/health`);
      if (r.ok) return;
    } catch {
      // gateway not up yet
    }
    await Bun.sleep(200);
  }
  throw new Error(`gateway did not come up within ${timeoutMs}ms`);
}

function startGateway(dbPath: string): Subprocess {
  const child = spawn({
    cmd: ["bun", "run", "src/index.ts"],
    cwd: path.resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      PORT: String(GATEWAY_PORT),
      NODE_ENV: "development",
      DATABASE_URL: `sqlite:${dbPath}`,
      OPENAI_API_KEY: "sk-mock-fake-key",
      OPENAI_BASE_URL: mockUrl + "/v1",
      TOKENSMART_AUTO_MIGRATE: "1",
      TOKENSMART_BASELINE_POLICY_ENABLED: "0",
      TOKENSMART_CACHE_ENABLED: "0",
      TOKENSMART_RETRY_MAX_ATTEMPTS: "2",
      TOKENSMART_RETRY_BASE_DELAY_MS: "10",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Pipe gateway stdout to our stdout but prefix it for clarity.
  void (async () => {
    const reader = child.stdout.getReader();
    const dec = new TextDecoder();
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      process.stdout.write("[gw] " + dec.decode(r.value));
    }
  })();
  void (async () => {
    const reader = child.stderr.getReader();
    const dec = new TextDecoder();
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      process.stderr.write("[gw err] " + dec.decode(r.value));
    }
  })();
  return child;
}

function gatewayHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_KEY}`,
  };
}

async function chatRequest(
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {}
): Promise<{
  status: number;
  json: unknown;
  requestId: string | null;
}> {
  const r = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { ...gatewayHeaders(), ...extraHeaders },
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await r.json();
  } catch {
    json = null;
  }
  return {
    status: r.status,
    json,
    requestId:
      r.headers.get("x-tokensmart-request-id") ??
      r.headers.get("x-request-id"),
  };
}

type ScenarioResult = {
  name: string;
  passed: boolean;
  detail: string;
};

const results: ScenarioResult[] = [];

async function scenarioOpenclawAttribution(
  dbPath: string,
  projectId: string
): Promise<void> {
  const name =
    "D. OpenClaw attribution: response carries X-Request-Id and session/turn tags persist";
  setMockMode({ kind: "ok" });
  const r = await chatRequest(
    {
      model: "gpt-4o-mini",
      messages: [
        { role: "user", content: `attribution probe ${Math.random()}` },
      ],
    },
    {
      "x-ts-agent": "openclaw",
      "x-ts-session": "s_e2e_42",
      "x-ts-turn": "7",
      "x-ts-channel": "ide",
      "x-ts-tag": "feature=test_harness",
    }
  );
  const sql = buildSql(`sqlite:${dbPath}`);
  let rowFound = false;
  let tagsOk = false;
  if (r.requestId) {
    const rows = await sql<Array<{ id: string; tags: string }>>`
      SELECT id, tags FROM requests WHERE id = ${r.requestId} LIMIT 1
    `;
    if (rows[0]) {
      rowFound = true;
      const t = JSON.parse(rows[0].tags) as Record<string, string>;
      tagsOk =
        t.agent === "openclaw" &&
        t.session === "s_e2e_42" &&
        t.turn === "7" &&
        t.channel === "ide" &&
        t.feature === "test_harness";
    }
  }
  await (sql as unknown as { end: () => Promise<void> }).end();
  results.push({
    name,
    passed: r.status === 200 && r.requestId != null && rowFound && tagsOk,
    detail: `status=${r.status}, request_id=${r.requestId}, row_found=${rowFound}, tags_ok=${tagsOk}`,
  });
}

async function scenarioPersistentUpstream5xx(): Promise<void> {
  const name = "A. persistent upstream 5xx → 502 (was: silently 200)";
  setMockMode({ kind: "always_500" });
  const r = await chatRequest({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "scenario A unique probe" }],
  });
  const passed = r.status === 502;
  let detail = `status=${r.status}, mock_hits=${mockHits}`;
  if (!passed) {
    detail += `; body=${JSON.stringify(r.json).slice(0, 200)}`;
  }
  results.push({ name, passed, detail });
}

async function scenarioRecoverableRetrySucceeds(): Promise<void> {
  const name = "A2. transient 500 then 200 → succeeds via retry";
  setMockMode({ kind: "five_hundred_then_ok", remaining500s: 1 });
  const r = await chatRequest({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "scenario A2 unique probe" }],
  });
  const passed = r.status === 200;
  results.push({
    name,
    passed,
    detail: `status=${r.status}, mock_hits=${mockHits}`,
  });
}

async function scenarioLoopDetector(dbPath: string, projectId: string): Promise<void> {
  const name = "C. identical prompt past threshold → loop_detected (durable)";
  await clearLoopState(dbPath, projectId);
  setMockMode({ kind: "ok" });
  const body = {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "loop-detect probe constant" }],
  };
  let lastStatus = 0;
  let lastJson: unknown = null;
  // Default threshold is 10. Fire enough to trip it.
  for (let i = 0; i < 12; i++) {
    const r = await chatRequest(body);
    lastStatus = r.status;
    lastJson = r.json;
    if (r.status === 403) break;
  }
  const isLoop =
    lastStatus === 403 &&
    typeof lastJson === "object" &&
    lastJson !== null &&
    JSON.stringify(lastJson).includes("loop_detected");

  let durableCount = 0;
  if (isLoop) {
    const sql = buildSql(`sqlite:${dbPath}`);
    const rows = await sql<Array<{ total: number }>>`
      SELECT COUNT(*) AS total FROM loop_events WHERE project_id = ${projectId}
    `;
    durableCount = Number(rows[0]?.total ?? 0);
    await (sql as unknown as { end: () => Promise<void> }).end();
  }
  results.push({
    name,
    passed: isLoop && durableCount > 0,
    detail: `final_status=${lastStatus}, durable_loop_rows=${durableCount}, body=${JSON.stringify(
      lastJson
    ).slice(0, 200)}`,
  });
}

async function scenarioBudgetReservation(
  dbPath: string,
  projectId: string
): Promise<void> {
  const name = "B. concurrent burst > budget → some get budget_exceeded";
  setMockMode({ kind: "ok" });
  await setTinyBudget(dbPath, projectId);

  // Each probe message is unique to avoid loop detector false positive.
  const inflight: Promise<{ status: number; json: unknown }>[] = [];
  for (let i = 0; i < 8; i++) {
    inflight.push(
      chatRequest({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: `budget burst probe ${i} ${Math.random()}`,
          },
        ],
      })
    );
  }
  const all = await Promise.all(inflight);
  const blockedCount = all.filter(
    (r) => r.status === 429 && JSON.stringify(r.json).includes("budget_exceeded")
  ).length;

  let pendingReservations = 0;
  let releasedReservations = 0;
  const sql = buildSql(`sqlite:${dbPath}`);
  const pendingRows = await sql<Array<{ total: number }>>`
    SELECT COUNT(*) AS total FROM budget_reservations
    WHERE project_id = ${projectId} AND status = 'pending'
  `;
  pendingReservations = Number(pendingRows[0]?.total ?? 0);
  const releasedRows = await sql<Array<{ total: number }>>`
    SELECT COUNT(*) AS total FROM budget_reservations
    WHERE project_id = ${projectId} AND status = 'released'
  `;
  releasedReservations = Number(releasedRows[0]?.total ?? 0);
  await (sql as unknown as { end: () => Promise<void> }).end();
  await clearBudget(dbPath, projectId);

  // Pass criteria:
  //   1. Some requests blocked (reservation actually gates concurrency).
  //   2. After completion, no pending reservations leaked.
  const passed = blockedCount > 0 && pendingReservations === 0;
  results.push({
    name,
    passed,
    detail: `requests=${all.length}, budget_blocked=${blockedCount}, leftover_pending=${pendingReservations}, released=${releasedReservations}`,
  });
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "tokensmart-e2e-"));
  const dbPath = path.join(tmp, "e2e.db");
  console.log(`[e2e] tmp dir: ${tmp}`);
  startMockUpstream();
  const gateway = startGateway(dbPath);
  let exitCode = 0;
  try {
    await waitForGateway();
    console.log("[e2e] gateway ready");
    const projectId = await readProjectIdFromDb(dbPath);
    console.log(`[e2e] dev project_id=${projectId}`);

    await scenarioPersistentUpstream5xx();
    await scenarioRecoverableRetrySucceeds();
    await scenarioBudgetReservation(dbPath, projectId);
    await scenarioLoopDetector(dbPath, projectId);
    await scenarioOpenclawAttribution(dbPath, projectId);
  } catch (err) {
    console.error("[e2e] aborted:", err);
    exitCode = 1;
  } finally {
    if (mockServer) mockServer.stop(true);
    gateway.kill("SIGTERM");
    await gateway.exited.catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  }

  let failed = 0;
  console.log("\n=== e2e verification results ===");
  for (const r of results) {
    const tag = r.passed ? "PASS" : "FAIL";
    console.log(`${tag}  ${r.name}`);
    console.log(`      ${r.detail}`);
    if (!r.passed) failed++;
  }
  if (failed > 0 || exitCode !== 0) {
    console.error(`\n${failed} scenario(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll e2e scenarios passed.");
}

await main();
