import Stripe from "stripe";
import { sql } from "./db";
import {
  countRefereePaidInvoices,
  insertReferralCreditIfNew,
  listPendingReferralCredits,
  markReferralCreditApplied,
} from "./db";
import { stripePriceIdForPlan, type PlanId } from "./plans";

// --- Referral program constants ------------------------------------------
//
// The economics of the program — kept in one place so future tweaks are a
// one-liner. Defaults match the marketing copy on /referrals:
//   - 20% commission on each invoice the referee pays
//   - capped at 12 months of accumulated invoices per referee
// 12 months × $29 Pro × 20% = $69.60 lifetime cap on a Pro referee.
//   - Team: 12 × $99 × 20% = $237.60
//   - Scale: 12 × $499 × 20% = $1197.60
export const REFERRAL_COMMISSION_RATE = 0.2;
export const REFERRAL_MAX_INVOICES_PER_REFEREE = 12;

function baseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_BASE_URL?.replace(/\/$/, "") ??
    "http://localhost:3000"
  );
}

/** Stripe client instance. Returns null when the key isn't set so callers
 *  can surface a user-friendly "billing disabled" state instead of crashing.
 *
 *  `apiVersion` follows whatever the installed stripe SDK considers "latest".
 *  We deliberately don't pin a string here:
 *    - pinning means every SDK bump breaks TypeScript until we also bump the
 *      string in lockstep (this is exactly the error that shipped earlier)
 *    - our webhook handler only reads stable fields (status, metadata,
 *      items[0].price.id, subscription.id) that are source-of-truth across
 *      every `.acacia` revision Stripe has shipped
 *  If Stripe ever ships a breaking change in a future family we'll pin
 *  explicitly and guard the webhook handler accordingly.
 */
export function stripeClient(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key);
}

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/**
 * Find-or-create the Stripe customer for a user. Cached back onto the users
 * row so we don't create a new customer on every upgrade click.
 */
export async function ensureCustomer(
  user: { id: string; email: string; name: string | null; stripe_customer_id?: string | null }
): Promise<string> {
  if (user.stripe_customer_id) return user.stripe_customer_id;

  const stripe = stripeClient();
  if (!stripe) {
    throw new Error("STRIPE_SECRET_KEY is not configured.");
  }

  // Double-check the DB in case another request beat us.
  const existing = await sql<{ stripe_customer_id: string | null }[]>`
    SELECT stripe_customer_id FROM users WHERE id = ${user.id}
  `;
  const cached = existing[0]?.stripe_customer_id ?? null;
  if (cached) return cached;

  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name ?? undefined,
    metadata: { tokensmart_user_id: user.id },
  });
  await sql`
    UPDATE users SET stripe_customer_id = ${customer.id} WHERE id = ${user.id}
  `;
  return customer.id;
}

export async function createCheckoutSession(args: {
  user: { id: string; email: string; name: string | null };
  plan: Exclude<PlanId, "free">;
}): Promise<{ url: string }> {
  const stripe = stripeClient();
  if (!stripe) throw new Error("STRIPE_SECRET_KEY is not configured.");

  const priceId = stripePriceIdForPlan(args.plan);
  if (!priceId) {
    throw new Error(
      `No Stripe price ID for plan '${args.plan}'. Set STRIPE_PRICE_${args.plan.toUpperCase()} in the env.`
    );
  }

  const customerId = await ensureCustomer(args.user);

  // Stamp the referrer onto subscription metadata so every invoice this
  // subscription generates can credit the right referrer at webhook time.
  // Looked up from the user's `referred_by_user_id` (set once on signup
  // by the login flow when ?ref=<code> was present). Empty string when
  // the user wasn't referred — Stripe rejects null in metadata values.
  const refRows = await sql<{ referred_by_user_id: string | null }[]>`
    SELECT referred_by_user_id FROM users WHERE id = ${args.user.id} LIMIT 1
  `;
  const referrerId = refRows[0]?.referred_by_user_id ?? "";

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: args.user.id,
    line_items: [{ price: priceId, quantity: 1 }],
    allow_promotion_codes: true,
    // Stripe Tax: compute + collect sales tax from the customer's billing
    // address. Requires an active tax registration for the jurisdiction
    // (e.g. Washington) plus a tax code + tax_behavior on each price. We
    // force a full billing address at checkout and write it back to the
    // Customer (customer_update.address) so the tax engine has a location
    // and every recurring subscription invoice reuses it.
    automatic_tax: { enabled: true },
    billing_address_collection: "required",
    customer_update: { address: "auto" },
    success_url: `${baseUrl()}/billing?status=success`,
    cancel_url: `${baseUrl()}/billing?status=cancel`,
    metadata: {
      tokensmart_user_id: args.user.id,
      tokensmart_plan: args.plan,
      tokensmart_referrer_user_id: referrerId,
    },
    subscription_data: {
      metadata: {
        tokensmart_user_id: args.user.id,
        tokensmart_plan: args.plan,
        tokensmart_referrer_user_id: referrerId,
      },
    },
  });

  if (!session.url) throw new Error("Stripe returned no checkout URL.");
  return { url: session.url };
}

export async function createPortalSession(args: {
  user: { id: string; email: string; name: string | null; stripe_customer_id: string | null };
}): Promise<{ url: string }> {
  const stripe = stripeClient();
  if (!stripe) throw new Error("STRIPE_SECRET_KEY is not configured.");

  const customerId = await ensureCustomer(args.user);
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${baseUrl()}/billing`,
  });
  return { url: session.url };
}

/**
 * Annotate a finalized invoice with a "TokSuan saved $X this period"
 * footer + a `Saved by TokSuan` custom field. Both end up in the email
 * Stripe sends to the customer, so the invoice arrival becomes a
 * "you're ahead by $X" moment instead of a "you owe $29" moment.
 *
 * Best-effort + idempotent: on any error we log and return — the invoice
 * still goes out untouched. Skips drafts (only `finalized` and after).
 *
 * Implementation:
 *   1. Look up the user via `customer` → `users.stripe_customer_id`
 *   2. Sum `routing_saving_micro_cents + cache_savings_micro_cents` over
 *      the invoice period (period_start..period_end on the line item)
 *   3. Update `invoice.footer` + `invoice.custom_fields` with the savings
 *
 * Stripe permits up to 4 custom fields per invoice. We add 1.
 */
export async function annotateInvoiceWithSavings(
  invoice: Stripe.Invoice
): Promise<void> {
  if (!invoice.id || invoice.status === "draft") return;

  const stripe = stripeClient();
  if (!stripe) return;

  const customerId =
    typeof invoice.customer === "string"
      ? invoice.customer
      : invoice.customer?.id;
  if (!customerId) return;

  const userRows = await sql<{ id: string }[]>`
    SELECT id FROM users WHERE stripe_customer_id = ${customerId} LIMIT 1
  `;
  const userId = userRows[0]?.id;
  if (!userId) return;

  // Period = the invoice line item's period (or fall back to last 30 days).
  // Stripe puts the period on each line; for a typical subscription invoice
  // the first line carries the relevant window.
  const line = invoice.lines.data[0];
  const periodStart = line?.period?.start
    ? new Date(line.period.start * 1000)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const periodEnd = line?.period?.end
    ? new Date(line.period.end * 1000)
    : new Date();

  const savedRows = await sql<{ saved: string }[]>`
    SELECT
      COALESCE(SUM(r.routing_saving_micro_cents + r.cache_savings_micro_cents), 0)::bigint
        AS saved
      FROM requests r
      JOIN projects p ON p.id = r.project_id
     WHERE p.user_id = ${userId}
       AND r.created_at >= ${periodStart}
       AND r.created_at <  ${periodEnd}
       AND r.status = 'success'
  `;
  const savedMicroCents = Number(savedRows[0]?.saved ?? 0);
  if (savedMicroCents <= 0) return; // nothing to brag about

  const savedUsd = (savedMicroCents / 100_000).toFixed(2);
  const subtotalUsd = (invoice.subtotal / 100).toFixed(2);
  const ratio = invoice.subtotal > 0
    ? (savedMicroCents / 100_000 / (invoice.subtotal / 100)).toFixed(1)
    : null;

  const footer =
    `TokSuan saved you $${savedUsd} this period via routing + prompt-cache discounts. ` +
    (ratio
      ? `That's ${ratio}× this subscription. `
      : "") +
    `Detail at ${(process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "")}.`;

  // custom_fields are user-readable label/value pairs that show up in the
  // invoice's "Memo" section. Up to 4; we set one.
  const customFields: Stripe.InvoiceUpdateParams.CustomField[] = [
    {
      name: "Saved by TokSuan",
      value: `$${savedUsd} (${ratio ? `${ratio}× this bill` : "this period"})`,
    },
  ];

  await stripe.invoices.update(invoice.id, {
    footer,
    custom_fields: customFields,
    metadata: {
      ...(invoice.metadata ?? {}),
      tokensmart_saved_micro_cents: String(savedMicroCents),
    },
  });
}

/**
 * Apply an incoming subscription state to our users table. Safe to call
 * repeatedly from webhooks; overwrites plan + subscription id atomically
 * based on the subscription's current state.
 */
export async function syncSubscriptionToUser(
  subscription: Stripe.Subscription
): Promise<void> {
  // Always act on the LIVE subscription, never the event's snapshot.
  //
  // Stripe resends the ORIGINAL payload on manual "Resend" / automatic
  // retries, and can deliver customer.subscription.* events out of order.
  // Both cases can carry a stale `incomplete` / `past_due` status from
  // creation time that would otherwise clobber an already-active
  // subscription back down to `free`. Re-fetching by id makes this handler
  // idempotent and order-independent: whatever order the events arrive in,
  // we resolve to the subscription's current truth. Falls back to the event
  // payload if the fetch fails so a transient Stripe outage never drops the
  // update entirely.
  let sub = subscription;
  const stripe = stripeClient();
  if (stripe && subscription.id) {
    try {
      sub = await stripe.subscriptions.retrieve(subscription.id);
    } catch (e) {
      console.warn(
        `[stripe] syncSubscriptionToUser could not re-fetch ${subscription.id}; using event payload:`,
        e instanceof Error ? e.message : e
      );
    }
  }

  // Prefer the freshly-fetched metadata; fall back to the event's copy.
  const metadata = { ...subscription.metadata, ...sub.metadata };
  const userId = (metadata.tokensmart_user_id as string | undefined) ?? null;
  if (!userId) return;

  const metaPlan = metadata.tokensmart_plan as PlanId | undefined;
  const priceId = sub.items.data[0]?.price.id;
  let plan: PlanId = metaPlan ?? "free";
  if (!metaPlan && priceId) {
    // Match against both monthly + annual price IDs for each tier so
    // either subscription cadence resolves the same plan.
    if (
      priceId === process.env.STRIPE_PRICE_PRO ||
      priceId === process.env.STRIPE_PRICE_PRO_ANNUAL
    )
      plan = "pro";
    else if (
      priceId === process.env.STRIPE_PRICE_TEAM ||
      priceId === process.env.STRIPE_PRICE_TEAM_ANNUAL
    )
      plan = "team";
    else if (
      priceId === process.env.STRIPE_PRICE_SCALE ||
      priceId === process.env.STRIPE_PRICE_SCALE_ANNUAL
    )
      plan = "scale";
  }

  const active = sub.status === "active" || sub.status === "trialing";
  const effectivePlan: PlanId = active ? plan : "free";

  await sql`
    UPDATE users
       SET plan = ${effectivePlan},
           stripe_subscription_id = ${active ? sub.id : null}
     WHERE id = ${userId}
  `;

  // Background policy training is a paid feature (Pro/Team/Scale).
  // Toggle every project the user owns when the subscription state
  // changes:
  //   - paid + active   → learning_enabled = TRUE  (cloud cron picks them up)
  //   - free / cancelled→ learning_enabled = FALSE (cron skips them)
  //
  // Self-hosted users never reach this path (no Stripe webhook in their
  // deployment); they manage learning_enabled themselves with a SQL
  // UPDATE per `docs/self-host-retrain.md`.
  //
  // Best-effort — never fails the webhook on this. The retrain cron is
  // resilient to flag drift; worst case a Pro user has to wait one
  // night for the flag to flip on their next subscription update event,
  // OR an admin runs `bun run retrain-project -- --project <id>`
  // manually as an apology.
  await syncProjectLearningFlag(userId, effectivePlan).catch((e) =>
    console.warn(
      "[stripe] learning_enabled sync failed for user",
      userId,
      ":",
      e instanceof Error ? e.message : e
    )
  );

  // Billing-transfer completion: when the new owner's subscription
  // becomes active, look for a pending intent that names THIS user
  // as the `to_user_id` — if one exists, mark it complete and
  // cancel the old owner's Stripe subscription. Scoped to
  // `from_stripe_subscription_id` so a random new Pro checkout
  // never accidentally cancels anyone else's subscription.
  if (active) {
    await completePendingBillingTransferFor(userId).catch((e) =>
      console.warn(
        "[stripe] billing-transfer completion failed:",
        e instanceof Error ? e.message : e
      )
    );
  }
}

/**
 * Set `projects.learning_enabled` for every project this user owns,
 * based on whether their plan now entitles them to background
 * training. Idempotent — running it on an already-correct user is a
 * no-op write.
 *
 * This is the only place that flips the flag from a billing event.
 * Operators can flip it manually for self-host deployments or for
 * one-off "give this customer a free trial of learning" toggles.
 */
async function syncProjectLearningFlag(
  userId: string,
  plan: PlanId
): Promise<void> {
  // pro / team / scale all get learning. free does not.
  const enabled = plan === "pro" || plan === "team" || plan === "scale";
  await sql`
    UPDATE projects
       SET learning_enabled = ${enabled}
     WHERE user_id = ${userId}
       AND learning_enabled IS DISTINCT FROM ${enabled}
  `;
}

/**
 * Internal: part of the A5-follow-up flow. Called from
 * `syncSubscriptionToUser` when an incoming subscription belongs to
 * a user who is the designated `to_user_id` of a pending
 * billing-transfer intent. Cancels the old owner's subscription in
 * Stripe (recorded as `from_stripe_subscription_id` on the intent
 * row — NOT the old owner's current stripe_subscription_id, because
 * that could have been changed in the meantime) and marks the
 * intent complete. Both sides of the intent see a "billing
 * transferred" banner on their next /billing visit.
 */
async function completePendingBillingTransferFor(
  userId: string
): Promise<void> {
  const rows = await sql<{
    id: string;
    organization_id: string;
    from_user_id: string;
    from_stripe_subscription_id: string | null;
  }[]>`
    SELECT id, organization_id, from_user_id, from_stripe_subscription_id
      FROM billing_transfer_intents
     WHERE to_user_id = ${userId}
       AND completed_at IS NULL
       AND cancelled_at IS NULL
       AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1
  `;
  const intent = rows[0];
  if (!intent) return;

  const stripe = stripeClient();
  if (intent.from_stripe_subscription_id && stripe) {
    try {
      await stripe.subscriptions.cancel(intent.from_stripe_subscription_id);
    } catch (err) {
      // Old subscription might already be cancelled / deleted — log
      // and continue. The intent still flips to complete; operators
      // can reconcile manually if Stripe state diverges.
      console.warn(
        `[stripe] could not cancel old sub ${intent.from_stripe_subscription_id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  await sql`
    UPDATE billing_transfer_intents
       SET completed_at = NOW()
     WHERE id = ${intent.id}
  `;

  console.log(
    `[stripe] billing-transfer intent ${intent.id} completed — from ${intent.from_user_id} to ${userId}`
  );
}

// --- Referral commission accounting --------------------------------------
//
// Wiring: Stripe `invoice.paid` → `recordReferralCreditFromInvoice` →
// `referral_credits` row (idempotent on referee_invoice_id). A separate
// settle pass (`settlePendingReferralCredits`) calls
// `Stripe.Customers.createBalanceTransaction` to actually grant the
// credit on the referrer's customer balance. We separate "record" from
// "apply" so a burst of webhook deliveries doesn't fan out into a burst
// of Stripe API calls.

/**
 * Called from the Stripe `invoice.paid` webhook. If the paying user was
 * referred (subscription.metadata.tokensmart_referrer_user_id), record
 * a 20%-commission row in `referral_credits`, capped at the first
 * `REFERRAL_MAX_INVOICES_PER_REFEREE` invoices per referee.
 *
 * Idempotent on (referee_invoice_id) — duplicate webhook deliveries
 * silently no-op via the UNIQUE constraint.
 *
 * Best-effort: any error is logged but never thrown. The webhook return
 * path stays clean so other handlers (subscription sync, invoice
 * annotation) keep firing.
 */
export async function recordReferralCreditFromInvoice(
  invoice: Stripe.Invoice
): Promise<void> {
  if (!invoice.id || invoice.status !== "paid") return;
  if (invoice.amount_paid <= 0) return; // $0 invoice (trial / 100% coupon)

  // Resolve the referee user via the subscription metadata. Subscription
  // metadata > invoice metadata because Stripe doesn't always copy
  // metadata onto the auto-generated renewal invoices.
  const subId =
    typeof invoice.subscription === "string"
      ? invoice.subscription
      : invoice.subscription?.id;
  if (!subId) return;

  const stripe = stripeClient();
  if (!stripe) return;

  const sub = await stripe.subscriptions.retrieve(subId);
  const refereeUserId = sub.metadata?.tokensmart_user_id;
  const referrerUserId = sub.metadata?.tokensmart_referrer_user_id;
  if (!refereeUserId || !referrerUserId) return;

  // Cap: only the first 12 invoices count for commission.
  const already = await countRefereePaidInvoices(refereeUserId);
  if (already >= REFERRAL_MAX_INVOICES_PER_REFEREE) return;

  // Compute commission. We use `subtotal` (pre-tax, pre-discount) in
  // micro_cents to stay consistent with the rest of the codebase. Stripe
  // gives us cents; convert to micro_cents.
  const subtotalMicroCents = invoice.subtotal * 1000;
  const creditMicroCents = Math.floor(
    subtotalMicroCents * REFERRAL_COMMISSION_RATE
  );
  if (creditMicroCents <= 0) return;

  await insertReferralCreditIfNew({
    referrerUserId,
    refereeUserId,
    refereeInvoiceId: invoice.id,
    refereeInvoiceSubtotalMicroCents: subtotalMicroCents,
    creditMicroCents,
  }).catch((e) =>
    console.warn("[stripe] insertReferralCreditIfNew failed:", e)
  );
}

/**
 * Iterate pending referral credits and grant them on the referrer's
 * Stripe customer balance. Designed to run from a cron / on-demand
 * action — not from the webhook hot path.
 *
 * Behavior:
 *   - Skips referrers who don't yet have a Stripe customer (they haven't
 *     started a subscription themselves; we hold the credit).
 *   - Calls `customers.createBalanceTransaction` with a NEGATIVE amount
 *     (Stripe convention: negative = credit). Returned txn id is stamped
 *     onto the row so the next pass skips it.
 *   - Errors are logged per-row; one failing row doesn't block the rest.
 *
 * Returns a summary so a manual run can tell you what happened.
 */
export async function settlePendingReferralCredits(opts: {
  limit?: number;
  dryRun?: boolean;
} = {}): Promise<{ applied: number; skipped: number; errors: number }> {
  const stripe = stripeClient();
  if (!stripe) {
    return { applied: 0, skipped: 0, errors: 0 };
  }
  const pending = await listPendingReferralCredits(opts.limit ?? 100);
  let applied = 0;
  let skipped = 0;
  let errors = 0;
  for (const row of pending) {
    if (!row.referrer_stripe_customer_id) {
      skipped++;
      continue; // referrer has no Stripe customer yet — hold the credit
    }
    if (opts.dryRun) {
      applied++;
      continue;
    }
    try {
      // Stripe wants integer cents. Convert from our micro_cents.
      const cents = Math.floor(row.credit_micro_cents / 1000);
      if (cents <= 0) {
        skipped++;
        continue;
      }
      const txn = await stripe.customers.createBalanceTransaction(
        row.referrer_stripe_customer_id,
        {
          amount: -cents, // negative = credit
          currency: "usd",
          description: `TokSuan referral commission (invoice ${row.referee_invoice_id})`,
          metadata: {
            tokensmart_referral_credit_id: row.id,
            tokensmart_referee_invoice_id: row.referee_invoice_id,
          },
        }
      );
      await markReferralCreditApplied(row.id, txn.id);
      applied++;
    } catch (err) {
      console.error(
        `[stripe] failed to settle referral credit ${row.id}:`,
        err instanceof Error ? err.message : err
      );
      errors++;
    }
  }
  return { applied, skipped, errors };
}
