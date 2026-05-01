import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { env } from "./config";
import { createCorsMiddleware } from "./cors";
import { initProviderRegistry } from "./crypto";
import { healthRoutes } from "./routes/health";
import { chatRoutes } from "./routes/chat";
import { internalRoutes } from "./routes/internal";
import { startCostAnomalyMonitor } from "./monitor";
import {
  loadBaselinePolicy,
  loadEmbeddingClassifier,
  startBaselinePolicyFileWatcher,
  startEmbeddingClassifierFileWatcher,
  subscribeToBaselinePolicyReload,
  subscribeToEmbeddingClassifierReload,
  subscribeToPolicyInvalidations,
  subscribeToProjectEmbeddingInvalidations,
} from "./policy";
import { initOtel } from "./otel";
import { runPendingMigrations } from "./migrate";
import { sql, dbBackend } from "./db";

const app = new Hono();

// Request logger runs FIRST so OPTIONS preflights + CORS-rejected
// requests stay visible — operators debugging a "CORS blocked my
// fetch" bug need to see them in the access log. Downstream
// middlewares (including CORS) can still short-circuit; the logger's
// `await next()` resolves and prints the final status either way.
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  console.log(`${c.req.method} ${c.req.path} → ${c.res.status} (${ms}ms)`);
});

// CORS — opt-in via TOKENSMART_CORS_ALLOW_ORIGINS. Unset = off (the
// right default; server-to-server SDK calls never trigger CORS).
// When set, unlocks browser-side integrations like Vercel AI SDK
// `useChat` running client-side, web playgrounds, and extensions.
app.use("*", createCorsMiddleware());

app.route("/", healthRoutes);
app.route("/", chatRoutes);
app.route("/", internalRoutes);

app.notFound((c) => c.json({ error: { message: "Not found" } }, 404));

app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: { message: "Internal server error" } }, 500);
});

// DB schema sync — applies any migrations not yet recorded in
// `schema_migrations`. Idempotent. Crashes the boot loud-and-clear if a
// migration fails to apply (better than serving traffic against a
// half-migrated DB). Runs BEFORE anything else touches Postgres.
{
  const summary = await runPendingMigrations();
  if (summary.applied.length > 0) {
    console.log(
      `[migrate] applied ${summary.applied.length} new migration(s); ${summary.alreadyApplied} were already in sync.`
    );
  } else if (summary.dir) {
    console.log(
      `[migrate] schema in sync (${summary.alreadyApplied} migrations applied previously).`
    );
  }
  if (summary.drifted.length > 0) {
    console.warn(
      `[migrate] ⚠ ${summary.drifted.length} migration file(s) have been edited since application: ${summary.drifted.join(", ")}. Migrations are append-only — create a new file instead.`
    );
  }
}

// Belt-and-braces: enforce dev-seed-key removal on EVERY production
// boot, not just the boot that first applied migration 017. Catches
// edge cases the migration alone misses — e.g. a dev-mode install that
// gets re-deployed under NODE_ENV=production after 017 was already
// recorded as "applied" with the dev GUC. Idempotent + cheap (single
// indexed delete on a table small enough to scan in microseconds).
if (process.env.NODE_ENV === "production" && dbBackend === "postgres") {
  try {
    const removed = await sql<{ id: string }[]>`
      DELETE FROM api_keys
       WHERE key = 'tokensmart-dev-key'
          OR key_hash = ENCODE(DIGEST('tokensmart-dev-key', 'sha256'), 'hex')
       RETURNING id
    `;
    if (removed.length > 0) {
      console.warn(
        `[security] removed ${removed.length} well-known dev seed API key(s) on production boot. ` +
          `If you need a usable key, mint a fresh one via the dashboard or the projects/api_keys table.`
      );
    }
  } catch (err) {
    console.warn(
      `[security] dev-seed-cleanup probe failed: ${err instanceof Error ? err.message : String(err)} ` +
        `(non-fatal; the seed is also removed by migration 017 at first boot).`
    );
  }
}

// Single-tenant prod bootstrap. Without this, a self-hoster who follows
// docker-compose.prod.yml with TOKENSMART_AUTH_ENABLED=0 is in a dead
// end after migration 017 clears the well-known dev key: no usable API
// key exists AND the dashboard's /projects + /settings pages hard-gate
// on auth (they redirect to /). Multi-tenant prod (auth=1) doesn't
// need this — users sign up and claim projects through the dashboard.
//
// Only mint when (a) NODE_ENV=production, (b) auth is explicitly off,
// (c) Postgres backend, and (d) literally zero rows in api_keys. The
// key is freshly random per boot with no keys — anyone running
// `TRUNCATE api_keys` to start over gets a new bootstrap key on the
// next boot, which is the intended emergency-reset UX.
//
// Output goes to stderr + stdout so container log tailers pick it up
// regardless of which stream they scrape. It's printed exactly once,
// plaintext — same deal as the dashboard's 120s reveal cookie for
// user-minted keys.
if (
  process.env.NODE_ENV === "production" &&
  process.env.TOKENSMART_AUTH_ENABLED !== "1" &&
  dbBackend === "postgres"
) {
  try {
    const existing = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM api_keys
    `;
    if (Number(existing[0]?.count ?? 0) === 0) {
      // Ensure a project the key can attach to. The seed project
      // `00000000-...001` might have been created by initdb.d; if
      // not, create a fresh "default" project with a random UUID.
      const projectRows = await sql<{ id: string }[]>`
        SELECT id FROM projects ORDER BY created_at ASC LIMIT 1
      `;
      let projectId = projectRows[0]?.id;
      if (!projectId) {
        const created = await sql<{ id: string }[]>`
          INSERT INTO projects (name)
          VALUES ('default')
          RETURNING id
        `;
        projectId = created[0]!.id;
      }

      // `ts_` + 48 random hex chars (~192 bits of entropy). Matches the
      // key shape users see minted from the dashboard.
      const plaintext = `ts_${randomBytes(24).toString("hex")}`;
      const keyHash = createHash("sha256").update(plaintext).digest("hex");
      const keyPrefix = plaintext.slice(0, 7);
      const keyLast4 = plaintext.slice(-4);

      await sql`
        INSERT INTO api_keys (project_id, name, key_hash, key_prefix, key_last4)
        VALUES (${projectId}, 'bootstrap', ${keyHash}, ${keyPrefix}, ${keyLast4})
      `;

      const banner = "═".repeat(72);
      const lines = [
        "",
        banner,
        "[bootstrap] Single-tenant prod mode detected, no API keys in DB.",
        "[bootstrap] Minted a one-time bootstrap key. Copy it NOW — it is",
        "[bootstrap] only shown in these logs (we store a SHA-256 hash).",
        "",
        `[bootstrap]   ${plaintext}`,
        "",
        "[bootstrap] Use it as:  Authorization: Bearer <key>",
        "[bootstrap] To rotate it later, TRUNCATE api_keys + restart the",
        "[bootstrap] gateway; a fresh bootstrap key will be minted. For",
        "[bootstrap] multi-user prod, set TOKENSMART_AUTH_ENABLED=1.",
        banner,
        "",
      ];
      // Write to stderr only — `docker logs` merges both streams, and
      // printing the plaintext key twice just expands the surface area
      // for log aggregators / security scanners. Operators who route
      // stdout and stderr separately still grep `[bootstrap]` on
      // stderr, which is the standard place for boot-time notices.
      console.warn(lines.join("\n"));
    }
  } catch (err) {
    console.warn(
      `[bootstrap] unable to auto-mint bootstrap key: ${err instanceof Error ? err.message : String(err)}. ` +
        `Mint one manually or enable auth.`
    );
  }
}

// Dynamic import of KMS SDK(s) when configured — keeps idle bundles small.
await initProviderRegistry();

// Eager-load the baseline routing policy so boot logs show it's active
// (or silently absent) instead of waiting for the first request. The
// loader caches, so this costs one fs.readFileSync at startup.
loadBaselinePolicy();

// v0.6.5 hot-reload for the baseline policy: file watcher (single-node
// self-host) + pg_notify (`tokensmart_baseline_reload` channel — multi-
// replica). Both opt-in; either signal path converges on the same
// debounced `reloadBaselinePolicy()` which also flushes the per-(project,
// tag) loader cache so SQLite + no-active-row-postgres callers see the
// new artifact within the debounce window. Closes the v0.6.4 follow-up:
// Policy artifact refresh no longer needs an operator-initiated gateway restart.
startBaselinePolicyFileWatcher();

// Same for the embedding-based task classifier (opt-in via
// TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED + an artifact written by
// `bun run train-embedding-classifier`). When disabled OR no
// artifact is present this is a silent no-op and the heuristic
// classifier handles everything — the boot log will be quiet.
loadEmbeddingClassifier();

// Hot-reload plumbing for the embedding classifier: filesystem
// watcher (single-node self-host) + pg_notify subscriber (multi-
// replica cloud). Either signal path converges on the same debounced
// `reloadEmbeddingClassifier()`. Both are opt-in; both are no-ops
// when the classifier itself is disabled. File watcher never throws;
// LISTEN failure degrades to file-watch-only.
startEmbeddingClassifierFileWatcher();
if (dbBackend === "postgres") {
  // Baseline policy reload notifications. Policy generators send one
  // automatically when it has DB access; operators can also fire it
  // manually via `psql -c "SELECT pg_notify('tokensmart_baseline_reload', '')"`.
  await subscribeToBaselinePolicyReload(sql).catch((err: unknown) => {
    console.warn(
      `[bootstrap] baseline-policy LISTEN subscribe failed: ${err instanceof Error ? err.message : String(err)} — continuing without it`
    );
  });
  // Global artifact reload path (file content change or manual
  // `SELECT pg_notify(..., '')`).
  await subscribeToEmbeddingClassifierReload(sql).catch((err: unknown) => {
    console.warn(
      `[bootstrap] embedding-classifier LISTEN subscribe failed: ${err instanceof Error ? err.message : String(err)} — continuing without it`
    );
  });
  // Per-project cache invalidation path (training CLI emits
  // `{project_id, version}` on the same channel after a successful
  // promotion). Both subscribers LISTEN on the same channel and
  // filter by payload shape — see each module for the split.
  await subscribeToProjectEmbeddingInvalidations().catch((err: unknown) => {
    console.warn(
      `[bootstrap] per-project embedding-classifier LISTEN subscribe failed: ${err instanceof Error ? err.message : String(err)} — continuing without it`
    );
  });
}

// Cross-replica policy cache invalidation: subscribe to Postgres
// LISTEN/NOTIFY so a retrain on any replica drops THIS replica's
// cached entry within milliseconds, instead of waiting out the 60s
// loader TTL. Failure is non-fatal (degrades to TTL-only).
await subscribeToPolicyInvalidations().catch((err: unknown) => {
  console.warn(
    `[bootstrap] policy invalidation subscribe failed: ${err instanceof Error ? err.message : String(err)} — continuing without it`
  );
});

// OTel tracing — no-op when OTEL_EXPORTER_OTLP_ENDPOINT isn't set, so
// self-hosted single-tenant installs pay zero cost.
initOtel();

console.log(`TokSuan gateway listening on http://localhost:${env.PORT}`);
console.log(`  • POST /v1/chat/completions  (OpenAI-compatible)`);
console.log(`  • GET  /health`);
console.log(`  • Database: ${env.DATABASE_URL.replace(/:[^:@]+@/, ":****@")}`);

startCostAnomalyMonitor();

export default {
  port: env.PORT,
  fetch: app.fetch,
};
