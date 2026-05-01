#!/usr/bin/env bun
/**
 * One-shot fixture to simulate the full per-tenant embedding-classifier
 * pipeline end-to-end in dev.
 *
 * Flow:
 *   1. Upgrade a target user (default you@example.com) to plan='pro'
 *      so the entitlement gate + learning_enabled semantics kick in.
 *   2. Ensure a project named `pro-test` exists for that user, with
 *      learning_enabled=TRUE and a default API key.
 *   3. Seed ~120 synthetic `requests` rows across the 4 task_types and
 *      3 complexity buckets so the training script has enough signal
 *      to actually converge (the script's `--min-rows` floor is 50).
 *      created_at is spread over the last 10 days so the chronological
 *      80/20 split puts varied distribution on both sides.
 *   4. Seed ~25 `ab_results` rows joining back to a subset of the
 *      requests, with mixed similarities so the training script's
 *      shadow-refinement path fires:
 *        - 12 high-similarity (≥0.95) → refine to `simple`
 *        - 8 low-similarity (<0.7)    → refine to `hard`
 *        - 5 errored shadows          → refine to `hard`
 *
 * Run with:
 *   bun run seed-pro-test             (uses defaults)
 *   bun run seed-pro-test -- --reset  (drops everything seeded before re-seeding)
 *
 * After this runs, kick off training:
 *   bun run train-embedding-classifier -- --project <uuid> --lookback-days 30
 *
 * NOT safe on a shared DB — this is a dev-loop fixture. The seeded rows
 * are fingerprinted `seed-pro-test-*` so the optional --reset targets
 * only them for cleanup.
 */

import { sql } from "../src/db";

// =========================================================================
// Fixture corpus
// =========================================================================
//
// Each entry is shape-equivalent to an OpenAI chat completion body.
// Content is picked so the HEURISTIC classifier produces the intended
// (task_type, complexity) label — that's what the training pipeline
// seeds its weak labels from. Mixing English + CJK exercises the v2
// multilingual encoder we just landed.

const FIXTURES: Array<{
  label: string; // for logging only
  repeat: number; // how many variants we want from this template
  tools: boolean; // if true, body.tools gets populated
  content: string[];
}> = [
  // --- chat / simple ---
  // Deliberately capped at ~18 so we don't drown the other classes on
  // 4-class cross-entropy. A real tenant naturally has this skew too,
  // but for a clean training demo we balance harder.
  {
    label: "chat:simple (english greetings)",
    repeat: 10,
    tools: false,
    content: [
      "hi",
      "hello there",
      "thanks!",
      "ok got it",
      "yo",
      "good morning",
      "how's it going",
      "test",
      "ping",
      "just saying hi",
    ],
  },
  {
    label: "chat:simple (cjk greetings)",
    repeat: 8,
    tools: false,
    content: [
      "你好",
      "嗨",
      "谢谢",
      "好的",
      "明白了",
      "こんにちは",
      "ありがとう",
      "おはよう",
    ],
  },

  // --- chat / medium --- non-trivial conversational but not code/reasoning
  {
    label: "chat:medium (casual longer questions)",
    repeat: 14,
    tools: false,
    content: [
      "What's a good book on distributed systems for someone with 5 years of experience?",
      "Can you recommend some podcasts about startup founders?",
      "我想去日本旅游,有什么好的城市推荐吗",
      "帮我想一个给团队团建活动的主题",
      "What are some hobbies that don't require a lot of equipment to start?",
      "Any tips for staying productive while working from home?",
      "我最近想学做菜,从哪些菜开始比较好入门",
      "Suggest a few weekend trip ideas near San Francisco",
      "What's the deal with this new AI agent trend everyone's talking about",
      "有没有什么适合通勤时听的中文播客",
      "How should I think about negotiating my next job offer?",
      "Recommend some Netflix shows from the last year that are worth watching",
      "What's your take on remote-first vs hybrid culture for a seed-stage startup?",
      "给我几个在家就能做的轻度健身动作建议",
    ],
  },

  // --- code / medium --- bump to balance
  {
    label: "code:medium (english refactor/bug)",
    repeat: 22,
    tools: false,
    content: [
      "Refactor this function to be more readable: `def foo(x): return x*2 if x>0 else -x`",
      "Why is my Python function returning None instead of the computed value?",
      "Fix the bug in this TypeScript code: const users = await fetch('/api/users').json();",
      "Help me unittest this validator function",
      "How do I import a CSV file in Python without pandas?",
      "Write a function that parses ISO8601 dates",
      "My pytest test is failing with 'module not found', what's wrong",
      "Refactor this JS code to use async/await instead of .then()",
      "How do I compile a single C file with gcc on macOS",
      "What's wrong with this class definition: `class Foo { constructor() {} }`",
      "Write a SQL query to find duplicate rows",
      "Debug this stack trace: TypeError: cannot read property 'map' of undefined",
      "Help me refactor this Rust code to use the `?` operator instead of nested match",
      "Convert this C# class to Kotlin — both implement the same business logic",
      "Write a Python decorator that retries a function on exception with exponential backoff",
      "How do I make this Go function thread-safe without using a global mutex?",
      "My React useEffect runs twice in strict mode — is that a bug?",
      "Fix the memory leak in this Node.js Express middleware",
      "Why does my unit test pass locally but fail in CI?",
      "Write a TypeScript type guard that narrows unknown to a specific shape",
      "Debug this compile error: `expected 2 arguments, got 3`",
      "Refactor this imperative loop into a map/filter chain",
    ],
  },
  {
    label: "code:medium (cjk refactor/bug)",
    repeat: 14,
    tools: false,
    content: [
      "请帮我重构这个函数,让它更易读",
      "这段代码一直报错,帮我看看哪里的问题",
      "这个 Python 函数为什么返回 None?",
      "帮我写一个单元测试验证这个解析器",
      "把这段 JavaScript 改写成 TypeScript",
      "编译时报错 cannot find module,怎么排查",
      "実装したいメソッドのコードを書いてください",
      "このエラーのデバッグ方法を教えてください",
      "这个 SQL 查询为什么这么慢,帮我优化一下",
      "重构这段代码让它线程安全",
      "这段 Go 代码有什么 bug",
      "帮我 debug 一下这个单元测试为什么 fail",
      "解释一下这段 Rust 代码为什么编译不过",
      "帮我把这个同步代码改写成异步",
    ],
  },

  // --- code / hard ---
  {
    label: "code:hard (multi-file / architectural)",
    repeat: 10,
    tools: false,
    content: [
      "I have a distributed job queue written in Go that's dropping tasks under high load. Help me refactor the worker pool so it can handle bursts without data loss. Consider backpressure, graceful shutdown, retry semantics, and at-least-once delivery guarantees. Here's the current code: ```go\nfunc (w *Worker) Run(ctx context.Context) error { for { select { case t := <-w.queue: if err := w.process(t); err != nil { log.Error(err) } case <-ctx.Done(): return nil } } }\n```",
      "Refactor this 500-line React component into smaller composable pieces. It manages form state, API fetching, URL query params, and a nested modal. I want each concern separated.",
      "Design a Python library for structured concurrency similar to Trio. It must support task cancellation, error propagation, and timeout-scoped nurseries. Provide the public API surface plus a minimal implementation.",
      "Implement a lock-free single-producer single-consumer ring buffer in Rust. Include benchmarks against a mutex-based version. Explain memory ordering requirements for each atomic operation.",
      "Help me design the schema and query patterns for a multi-tenant analytics table that will hold 100M+ rows. Queries are bounded by tenant_id and time range. Discuss the trade-offs between partitioning by tenant_id vs by time.",
      "Write a production-grade TypeScript type-safe ORM wrapper around the `pg` driver. Support transactions, migrations, prepared statements, and JSON columns.",
      "Refactor this Kubernetes operator to be idempotent across reconciler restarts. Right now it double-creates resources on controller crash.",
      "Implement a distributed rate limiter using Redis + Lua that's correct under network partitions. Include the exact Lua script plus the Go client that uses it.",
      "Design the data model for a collaborative document editor with OT-style concurrent edits. Cover the server-side merge algorithm and the client-side undo stack.",
      "Help me write a custom memory allocator in C++ tuned for a game engine with many small short-lived allocations. Compare bump vs pool vs slab strategies.",
    ],
  },

  // --- reasoning / medium + hard ---
  {
    label: "reasoning:medium+hard (english)",
    repeat: 16,
    tools: false,
    content: [
      "Prove that the sum of two even numbers is always even.",
      "Derive the closed form of the Fibonacci sequence.",
      "Analyze the trade-offs between microservices and monoliths for a team of 10 engineers.",
      "Explain why the Byzantine Generals Problem is unsolvable with fewer than 3f+1 nodes.",
      "Compare eventual consistency and strong consistency for a shopping cart system.",
      "Evaluate the argument that unit tests produce diminishing returns past 80% coverage.",
      "Derive why binary search is O(log n). Be precise about the recurrence.",
      "Explain how consensus via Raft differs from Paxos, and when you'd pick one over the other.",
      "Critique this argument: 'microservices always improve scalability'.",
      "What are the implications of the CAP theorem for building a global payments ledger?",
      "Analyze why the two-generals problem shows synchronous agreement is impossible over an async network.",
      "Derive the expected number of hash collisions for n items hashed into b buckets.",
      "Compare the space/time trade-offs of bloom filters vs cuckoo filters.",
      "Explain and justify when it's correct to use vector clocks vs hybrid logical clocks.",
      "Evaluate the soundness of the argument that open-source always leads to better security.",
      "Reason through whether a 99.99% SLA is achievable with a single cloud region.",
    ],
  },
  {
    label: "reasoning:medium+hard (cjk)",
    repeat: 10,
    tools: false,
    content: [
      "请证明对于任何正整数 n,1+2+...+n = n(n+1)/2",
      "论证 monorepo 相对于 multirepo 对小团队的收益和风险",
      "推导 BFS 的时间复杂度,并解释为什么是 O(V+E)",
      "分析微服务架构在 10 人团队中的权衡,给出推荐方案",
      "为什么 Paxos 协议需要 2f+1 个节点才能容忍 f 个故障?请给出严格推导",
      "この問題の解法を論理的に説明してください",
      "论证为什么最终一致性对电商购物车是可接受的",
      "推导归并排序的渐进时间复杂度,并严格证明",
      "比较 B 树和 LSM 树作为数据库索引的权衡",
      "分析 CAP 定理对跨区域数据库的设计影响",
    ],
  },

  // --- tool_use / medium --- bump too
  {
    label: "tool_use:medium (english, tools attached)",
    repeat: 14,
    tools: true,
    content: [
      "Look up today's weather in San Francisco and summarize the forecast.",
      "Search my calendar for meetings tomorrow and reply to the ones I can skip.",
      "Find the latest pull requests on my team's repo and flag any that need review.",
      "Check my inbox for anything from Sarah in the last 3 days.",
      "Search our codebase for usages of the deprecated `oldAuthenticate` function.",
      "Query the analytics DB for our p95 latency over the last week.",
      "Pull the last 10 Slack messages from the #incidents channel and summarize.",
      "Find all Jira tickets labeled 'regression' that are still open.",
      "Look up our current on-call rotation and ping the primary.",
      "Search our docs wiki for the incident response runbook.",
      "Check the build status on our main branch and report any failures.",
      "Find the top 5 customers by last-month spend and prepare a short brief.",
      "Schedule a 30-minute meeting with the platform team sometime next week.",
      "Pull our latest deployment log and summarize any errors.",
    ],
  },
];

// =========================================================================
// Helpers
// =========================================================================

function randomSpread(n: number): number {
  // [0, n) with a slight bias toward the recent end so validation split
  // sees diverse recent examples.
  const r = Math.random() ** 1.3; // skew toward 0 → recent
  return Math.floor(r * n);
}

function buildRequestBody(content: string, tools: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content },
    ],
  };
  if (tools) {
    body.tools = [
      {
        type: "function",
        function: {
          name: "search",
          description: "Search an index",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "get_time",
          description: "Return the current time",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
  }
  return body;
}

// Generate slightly-varied copies of a template so FINGERPRINTS aren't
// identical (otherwise the gateway's loop detector would flag them).
function varyContent(base: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) out.push(base);
    else {
      // Append a small inline marker. Still routes to the same
      // heuristic bucket but produces a distinct fingerprint.
      out.push(`${base} (#${i + 1})`);
    }
  }
  return out;
}

// =========================================================================
// Main
// =========================================================================

const RESET = process.argv.includes("--reset");
const FINGERPRINT_PREFIX = "seed-pro-test-";
const TARGET_EMAIL =
  process.env.SEED_USER_EMAIL ?? "you@example.com";
const PROJECT_NAME =
  process.env.SEED_PROJECT_NAME ?? "pro-test";

async function main(): Promise<void> {
  console.log(`[seed] target user: ${TARGET_EMAIL}`);
  console.log(`[seed] target project name: ${PROJECT_NAME}`);
  console.log(`[seed] reset mode: ${RESET}`);

  // --- 1. user → pro ---
  const userRows = await sql<{ id: string; email: string; plan: string }[]>`
    SELECT id, email, plan FROM users
    WHERE email = ${TARGET_EMAIL} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (userRows.length === 0) {
    console.error(`[seed] user ${TARGET_EMAIL} not found — bail out`);
    process.exit(1);
  }
  const user = userRows[0];
  if (user.plan !== "pro") {
    await sql`UPDATE users SET plan = 'pro' WHERE id = ${user.id}`;
    console.log(`[seed] upgraded ${TARGET_EMAIL} from ${user.plan} → pro`);
  } else {
    console.log(`[seed] user already on pro`);
  }

  // --- 2. project ---
  const existingProjects = await sql<{ id: string; name: string; learning_enabled: boolean }[]>`
    SELECT id, name, learning_enabled FROM projects
    WHERE user_id = ${user.id} AND name = ${PROJECT_NAME}
  `;
  let projectId: string;
  if (existingProjects.length === 0) {
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO projects (user_id, name, learning_enabled)
      VALUES (${user.id}, ${PROJECT_NAME}, TRUE)
      RETURNING id
    `;
    projectId = inserted[0].id;
    console.log(`[seed] created project ${PROJECT_NAME} = ${projectId}`);
  } else {
    projectId = existingProjects[0].id;
    if (!existingProjects[0].learning_enabled) {
      await sql`UPDATE projects SET learning_enabled = TRUE WHERE id = ${projectId}`;
      console.log(`[seed] flipped learning_enabled TRUE on existing project`);
    } else {
      console.log(`[seed] project exists + already has learning_enabled`);
    }
  }

  // --- optional reset ---
  if (RESET) {
    const deletedRequests = await sql`
      DELETE FROM requests
      WHERE project_id = ${projectId}
        AND fingerprint LIKE ${FINGERPRINT_PREFIX + "%"}
      RETURNING id
    `;
    const deletedAb = await sql`
      DELETE FROM ab_results
      WHERE project_id = ${projectId}
        AND fingerprint LIKE ${FINGERPRINT_PREFIX + "%"}
      RETURNING id
    `;
    const deletedArtifacts = await sql`
      DELETE FROM project_embedding_classifiers
      WHERE project_id = ${projectId}
      RETURNING id
    `;
    console.log(
      `[seed] reset: dropped ${deletedRequests.length} requests, ${deletedAb.length} ab_results, ${deletedArtifacts.length} classifier versions`
    );
  }

  // --- 3. seed requests ---
  // Spread over the last 10 days. Using one INSERT statement with a
  // VALUES list would be fastest but we want per-row varied created_at,
  // tags, etc — batching via unnest/jsonb would be over-engineering.
  const nowMs = Date.now();
  const tenDaysMs = 10 * 24 * 3600 * 1000;

  let insertedRequests = 0;
  const seededRequestIds: { id: string; content: string; tools: boolean }[] = [];
  for (const f of FIXTURES) {
    const needed = f.repeat;
    const variedContents: string[] = [];
    // Fill up to `needed` by cycling the base contents with varied suffix.
    for (let i = 0; i < needed; i++) {
      const base = f.content[i % f.content.length];
      variedContents.push(...varyContent(base, 1));
      if (i >= f.content.length) {
        // Already over the base list — the last push was a suffixed copy,
        // but varyContent only returned 1 element. Re-call with a unique
        // seed to actually differ:
        variedContents[variedContents.length - 1] = `${base} (#${i + 1})`;
      }
    }

    for (const content of variedContents.slice(0, needed)) {
      const body = buildRequestBody(content, f.tools);
      const createdAt = new Date(nowMs - randomSpread(tenDaysMs));
      const fingerprint =
        FINGERPRINT_PREFIX +
        Math.random().toString(36).slice(2, 12);
      const inserted = await sql<{ id: string }[]>`
        INSERT INTO requests (
          project_id, provider, model, status, request_body,
          created_at, fingerprint, input_tokens, output_tokens,
          cost_micro_cents, tags
        ) VALUES (
          ${projectId},
          'openai',
          'gpt-4o-mini',
          'success',
          ${sql.json(body)},
          ${createdAt},
          ${fingerprint},
          ${40 + Math.floor(Math.random() * 200)},
          ${40 + Math.floor(Math.random() * 100)},
          ${10 + Math.floor(Math.random() * 500)},
          ${sql.json({ seeded: "seed-pro-test", label: f.label })}
        )
        RETURNING id
      `;
      seededRequestIds.push({
        id: inserted[0].id,
        content,
        tools: f.tools,
      });
      insertedRequests++;
    }
  }
  console.log(`[seed] inserted ${insertedRequests} requests`);

  // --- 4. seed ab_results (shadow refinement) ---
  // Pick 25 requests and attach shadow rows with varied similarity so
  // the training's complexity refinement path fires. We deliberately
  // pick CODE + REASONING requests for the high-similarity "this is
  // simple after all" signal so the training learns that some
  // heuristic-mediums collapse to simple.
  const shadowTargets = seededRequestIds
    .sort(() => Math.random() - 0.5)
    .slice(0, 25);
  let insertedAb = 0;
  for (let i = 0; i < shadowTargets.length; i++) {
    const t = shadowTargets[i];
    let similarity: number | null;
    let status: "success" | "error" = "success";
    if (i < 12) similarity = 0.96 + Math.random() * 0.03; // high
    else if (i < 20) similarity = 0.5 + Math.random() * 0.15; // low
    else {
      similarity = null;
      status = "error"; // errored shadow → refine to hard
    }
    const fingerprint = FINGERPRINT_PREFIX + "ab-" + i;
    await sql`
      INSERT INTO ab_results (
        project_id, primary_request_id,
        primary_model, primary_provider,
        primary_input_tokens, primary_output_tokens, primary_cost_micro_cents,
        shadow_model, shadow_provider,
        shadow_input_tokens, shadow_output_tokens, shadow_cost_micro_cents,
        shadow_status, similarity, fingerprint
      ) VALUES (
        ${projectId}, ${t.id},
        'gpt-5.2', 'openai',
        ${60 + Math.floor(Math.random() * 100)},
        ${40 + Math.floor(Math.random() * 100)},
        ${500 + Math.floor(Math.random() * 500)},
        'gpt-4o-mini', 'openai',
        ${60 + Math.floor(Math.random() * 100)},
        ${40 + Math.floor(Math.random() * 100)},
        ${30 + Math.floor(Math.random() * 50)},
        ${status}, ${similarity}, ${fingerprint}
      )
    `;
    insertedAb++;
  }
  console.log(`[seed] inserted ${insertedAb} ab_results`);

  // --- 5. report ---
  const counts = await sql<
    {
      request_count: string;
      ab_count: string;
      classifier_versions: string;
    }[]
  >`
    SELECT
      (SELECT COUNT(*) FROM requests WHERE project_id = ${projectId})::text AS request_count,
      (SELECT COUNT(*) FROM ab_results WHERE project_id = ${projectId})::text AS ab_count,
      (SELECT COUNT(*) FROM project_embedding_classifiers WHERE project_id = ${projectId})::text AS classifier_versions
  `;
  const c = counts[0];
  console.log(`\n[seed] done — project state:`);
  console.log(`  project_id           : ${projectId}`);
  console.log(`  user                 : ${TARGET_EMAIL} (pro)`);
  console.log(`  learning_enabled     : TRUE`);
  console.log(`  total requests       : ${c.request_count}`);
  console.log(`  total ab_results     : ${c.ab_count}`);
  console.log(`  classifier versions  : ${c.classifier_versions}`);
  console.log();
  console.log(`Next: run training against this project`);
  console.log(`  cd apps/gateway`);
  console.log(
    `  TOKENSMART_EMBEDDING_CLASSIFIER_ENABLED=0 \\`
  );
  console.log(
    `    bun run train-embedding-classifier -- --project ${projectId} --lookback-days 30`
  );
  console.log();
  console.log(`Then visit the dashboard:`);
  console.log(`  http://localhost:3000/projects/${projectId}/classifier`);
}

await main()
  .catch((err) => {
    console.error("seed-pro-test: fatal:", err);
    process.exit(1);
  })
  .finally(async () => {
    try {
      await sql.end({ timeout: 5 });
    } catch {
      // ignore
    }
  });
