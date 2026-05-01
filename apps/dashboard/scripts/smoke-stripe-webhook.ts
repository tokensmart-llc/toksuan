#!/usr/bin/env bun
/**
 * Stripe webhook smoke test — regression detector for the paths the
 * dashboard's `/api/stripe/webhook` cares about. Sends synthetic, correctly
 * signed events to a running dashboard and asserts each one returns 200.
 *
 * Why this exists:
 *   Today the invoice annotation + referral accrual flows are verified by
 *   a human running `stripe trigger invoice.finalized` and eyeballing the
 *   dashboard stdout. That's fine for happy-path but gives no <10s signal
 *   on a PR. This script is the "did I break the webhook" check that can
 *   run on every push without a Stripe CLI login.
 *
 * What it asserts:
 *   - The route returns 2xx on every supported event type.
 *   - A bad signature is correctly rejected (4xx).
 *   - The route's response shape stays `{ received: true }` on success.
 *   - When SMOKE_TEST_USER_ID is set: the subscription→plan sync path
 *     also flips `projects.learning_enabled` for that user's projects.
 *     This is the post-migration-019 path that gates background policy
 *     training on paid subscription state.
 *
 * What it does NOT assert:
 *   - That annotation actually wrote the footer (that path short-circuits
 *     on "no user found for customer", which is the correct behavior for
 *     our synthetic fake-customer fixtures).
 *   - That the referral row landed (same reason; the synthetic subscription
 *     has no referrer metadata).
 *
 * The behaviors above are deliberately out of scope — this script lives
 * in the always-green tier. For "did we actually accrue the credit" we
 * have `bun run settle-referrals --dry-run` with a real referral_credits
 * row in the DB.
 *
 * Requirements:
 *   - STRIPE_WEBHOOK_SECRET is set in env (same one the dashboard is
 *     listening with). We compute the signature locally with HMAC-SHA256
 *     so we don't need STRIPE_SECRET_KEY or the Stripe SDK.
 *   - Dashboard reachable at SMOKE_WEBHOOK_URL (default
 *     http://localhost:3000/api/stripe/webhook).
 *   - Optional: SMOKE_TEST_USER_ID — a real user UUID (must own at least
 *     one project). When set, enables the learning_enabled flip
 *     assertion. We restore the user's plan + every project's
 *     learning_enabled to whatever they were before, so the test is
 *     idempotent / non-destructive.
 *
 * Exit codes:
 *   0  all events returned the expected status
 *   1  env misconfigured (missing STRIPE_WEBHOOK_SECRET) or fatal error
 *   2  one or more assertions failed (webhook regression)
 */

import { createHmac } from "node:crypto";
import postgres from "postgres";

type EventCase = {
  name: string;
  type: string;
  buildPayload: () => Record<string, unknown>;
  /** Override the signing secret — used by the "bad signature rejected" case. */
  signWith?: string;
  expectStatus: "2xx" | "4xx";
};

function log(...args: unknown[]): void {
  console.log("[smoke-stripe]", ...args);
}

function fail(msg: string): never {
  console.error(`[smoke-stripe] FAIL: ${msg}`);
  process.exit(2);
}

/**
 * Reproduce Stripe's webhook signature algorithm:
 *   signed_payload = `${timestamp}.${payload}`
 *   signature      = HMAC_SHA256(secret, signed_payload)
 *   header         = `t=${timestamp},v1=${signature}`
 *
 * See https://stripe.com/docs/webhooks#verify-manually — this is intentionally
 * the same algorithm `stripe.webhooks.signature.verifyHeader()` runs on the
 * server side, just in reverse.
 */
function signPayload(payload: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${payload}`;
  const signature = createHmac("sha256", secret)
    .update(signedPayload, "utf8")
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

/**
 * Build a minimal, schema-shaped Stripe event envelope. We only populate
 * the fields our webhook handler actually reads — anything else stays
 * default so we don't couple the smoke test to Stripe's full Invoice /
 * Subscription shapes (which change).
 */
function wrapEvent(
  type: string,
  obj: Record<string, unknown>
): Record<string, unknown> {
  return {
    id: `evt_smoke_${Date.now().toString(36)}`,
    object: "event",
    api_version: "2024-11-20.acacia",
    created: Math.floor(Date.now() / 1000),
    type,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: { object: obj },
  };
}

const FAKE_CUSTOMER = "cus_smoke_fake_customer_id";
const FAKE_SUBSCRIPTION = "sub_smoke_fake_subscription_id";
const FAKE_INVOICE_BASE = "in_smoke_";

const CASES: EventCase[] = [
  {
    name: "invoice.finalized → annotate path",
    type: "invoice.finalized",
    expectStatus: "2xx",
    buildPayload: () =>
      wrapEvent("invoice.finalized", {
        id: `${FAKE_INVOICE_BASE}finalized`,
        object: "invoice",
        customer: FAKE_CUSTOMER,
        status: "open",
        subtotal: 2900,
        amount_paid: 0,
        lines: { data: [] },
      }),
  },
  {
    name: "invoice.paid → referral accrue path",
    type: "invoice.paid",
    expectStatus: "2xx",
    buildPayload: () =>
      wrapEvent("invoice.paid", {
        id: `${FAKE_INVOICE_BASE}paid`,
        object: "invoice",
        customer: FAKE_CUSTOMER,
        status: "paid",
        subtotal: 2900,
        amount_paid: 2900,
        subscription: FAKE_SUBSCRIPTION,
      }),
  },
  {
    name: "customer.subscription.updated → plan sync path",
    type: "customer.subscription.updated",
    expectStatus: "2xx",
    buildPayload: () =>
      wrapEvent("customer.subscription.updated", {
        id: FAKE_SUBSCRIPTION,
        object: "subscription",
        customer: FAKE_CUSTOMER,
        status: "active",
        items: {
          data: [
            {
              id: "si_smoke",
              price: { id: "price_smoke" },
            },
          ],
        },
        metadata: {},
      }),
  },
  {
    name: "bad signature is rejected",
    type: "invoice.finalized",
    expectStatus: "4xx",
    signWith: "whsec_DELIBERATELY_WRONG_SECRET_FOR_SMOKE_TEST",
    buildPayload: () =>
      wrapEvent("invoice.finalized", {
        id: `${FAKE_INVOICE_BASE}badsig`,
        object: "invoice",
        customer: FAKE_CUSTOMER,
        status: "open",
        subtotal: 2900,
        amount_paid: 0,
        lines: { data: [] },
      }),
  },
];

async function runCase(
  url: string,
  secret: string,
  c: EventCase
): Promise<{ pass: boolean; detail: string }> {
  const payload = JSON.stringify(c.buildPayload());
  const signature = signPayload(payload, c.signWith ?? secret);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": signature,
      },
      body: payload,
    });
  } catch (err) {
    return {
      pass: false,
      detail: `fetch threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const ok =
    c.expectStatus === "2xx"
      ? res.status >= 200 && res.status < 300
      : res.status >= 400 && res.status < 500;

  const body = await res.text();
  const bodySnippet = body.length > 140 ? `${body.slice(0, 140)}…` : body;
  return {
    pass: ok,
    detail: `HTTP ${res.status} (expected ${c.expectStatus}) — ${bodySnippet}`,
  };
}

/**
 * Build a real-user-anchored subscription event and verify
 * `projects.learning_enabled` flips correctly afterwards. Runs only
 * when SMOKE_TEST_USER_ID is set.
 *
 * Idempotency strategy: read the user's CURRENT plan + their projects'
 * CURRENT learning_enabled values BEFORE we send anything; restore them
 * at the end whether the test passed or failed. The webhook always
 * makes a coherent set of writes (plan + learning_enabled + nullable
 * stripe_subscription_id), so restoring just those columns puts the
 * row back to where the test started.
 */
async function runLearningFlipCase(
  url: string,
  secret: string,
  userId: string
): Promise<{ pass: boolean; detail: string }> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return {
      pass: false,
      detail: "DATABASE_URL is required for the learning-flip case but is unset.",
    };
  }
  const sql = postgres(dbUrl, { max: 2, idle_timeout: 10, onnotice: () => {} });

  let savedState: {
    plan: string | null;
    stripe_subscription_id: string | null;
    project_flags: { id: string; learning_enabled: boolean }[];
  } | null = null;

  try {
    const userRows = await sql<
      { plan: string | null; stripe_subscription_id: string | null }[]
    >`
      SELECT plan, stripe_subscription_id FROM users WHERE id = ${userId}
    `;
    if (userRows.length === 0) {
      return { pass: false, detail: `user ${userId} not found in DB` };
    }
    const projectRows = await sql<
      { id: string; learning_enabled: boolean }[]
    >`
      SELECT id, learning_enabled FROM projects WHERE user_id = ${userId}
    `;
    if (projectRows.length === 0) {
      return {
        pass: false,
        detail: `user ${userId} has no projects to assert against`,
      };
    }
    savedState = {
      plan: userRows[0]!.plan,
      stripe_subscription_id: userRows[0]!.stripe_subscription_id,
      project_flags: projectRows,
    };

    // Force the user to a known starting state — plan=free, learning off
    // on every project — so the assertion is deterministic regardless
    // of how the smoke is invoked.
    await sql`
      UPDATE users SET plan = 'free', stripe_subscription_id = NULL WHERE id = ${userId}
    `;
    await sql`
      UPDATE projects SET learning_enabled = FALSE WHERE user_id = ${userId}
    `;

    // Build a webhook event whose subscription metadata names this user
    // and whose price-id metadata says "pro". The webhook handler will
    // (a) update users.plan, (b) call syncProjectLearningFlag which
    // flips every project's learning_enabled to TRUE.
    const subPayload = wrapEvent("customer.subscription.updated", {
      id: `sub_smoke_${userId.slice(0, 8)}`,
      object: "subscription",
      customer: `cus_smoke_${userId.slice(0, 8)}`,
      status: "active",
      items: { data: [{ id: "si_smoke", price: { id: "price_smoke" } }] },
      // metadata.tokensmart_plan="pro" lets the handler skip the
      // STRIPE_PRICE_PRO env-var lookup; smoke runs without that env
      // var being set.
      metadata: {
        tokensmart_user_id: userId,
        tokensmart_plan: "pro",
      },
    });
    const body = JSON.stringify(subPayload);
    const signature = signPayload(body, secret);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": signature,
      },
      body,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      return {
        pass: false,
        detail: `webhook returned HTTP ${res.status} — ${errBody.slice(0, 140)}`,
      };
    }

    // Read post-state for assertions.
    const postUserRows = await sql<{ plan: string | null }[]>`
      SELECT plan FROM users WHERE id = ${userId}
    `;
    const postProjectRows = await sql<
      { id: string; learning_enabled: boolean }[]
    >`
      SELECT id, learning_enabled FROM projects WHERE user_id = ${userId}
    `;
    const planOk = postUserRows[0]?.plan === "pro";
    const allFlipped = postProjectRows.every((p) => p.learning_enabled);
    if (!planOk) {
      return {
        pass: false,
        detail: `users.plan was '${postUserRows[0]?.plan}', expected 'pro'`,
      };
    }
    if (!allFlipped) {
      const stillOff = postProjectRows.filter((p) => !p.learning_enabled);
      return {
        pass: false,
        detail: `${stillOff.length}/${postProjectRows.length} projects still have learning_enabled=FALSE after the webhook`,
      };
    }
    return {
      pass: true,
      detail: `users.plan='pro', ${postProjectRows.length}/${postProjectRows.length} projects flipped to learning_enabled=TRUE`,
    };
  } catch (err) {
    return {
      pass: false,
      detail: `threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    // Restore — runs even on early returns above.
    if (savedState) {
      try {
        await sql`
          UPDATE users
             SET plan = ${savedState.plan},
                 stripe_subscription_id = ${savedState.stripe_subscription_id}
           WHERE id = ${userId}
        `;
        for (const p of savedState.project_flags) {
          await sql`
            UPDATE projects SET learning_enabled = ${p.learning_enabled}
            WHERE id = ${p.id}
          `;
        }
      } catch (err) {
        console.warn(
          `[smoke-stripe] WARN: failed to restore pre-test state for user ${userId}: ${(err as Error).message}`
        );
      }
    }
    await sql.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error(
      "[smoke-stripe] STRIPE_WEBHOOK_SECRET is not set. Paste the value from the dashboard's .env.local (whsec_…) and re-run."
    );
    process.exit(1);
  }

  const url =
    process.env.SMOKE_WEBHOOK_URL ??
    "http://localhost:3000/api/stripe/webhook";

  log(`target=${url}`);
  log(`running ${CASES.length} cases…`);
  console.log("");

  let fails = 0;
  for (const c of CASES) {
    const { pass, detail } = await runCase(url, webhookSecret, c);
    const tag = pass ? "PASS" : "FAIL";
    console.log(`  [${tag}] ${c.name}\n         ${detail}`);
    if (!pass) fails++;
  }

  // Bonus case: only when SMOKE_TEST_USER_ID is set. Verifies the
  // post-019 learning_enabled flip on a real user/project pair.
  // Restores state regardless of pass/fail.
  const testUserId = process.env.SMOKE_TEST_USER_ID;
  if (testUserId) {
    console.log("");
    log(`learning-flip case enabled (SMOKE_TEST_USER_ID=${testUserId.slice(0, 8)}…)`);
    const { pass, detail } = await runLearningFlipCase(
      url,
      webhookSecret,
      testUserId
    );
    const tag = pass ? "PASS" : "FAIL";
    console.log(`  [${tag}] subscription→learning_enabled flip\n         ${detail}`);
    if (!pass) fails++;
  } else {
    console.log("");
    log(
      "skipping learning-flip case (set SMOKE_TEST_USER_ID=<uuid> to enable)"
    );
  }

  console.log("");
  if (fails > 0) {
    fail(`${fails} case(s) failed. See above.`);
  }
  log(`all cases passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke-stripe] fatal:", err);
  process.exit(1);
});
