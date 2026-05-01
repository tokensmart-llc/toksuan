import { NextResponse, type NextRequest } from "next/server";
import type Stripe from "stripe";
import {
  annotateInvoiceWithSavings,
  recordReferralCreditFromInvoice,
  stripeClient,
  syncSubscriptionToUser,
} from "@/lib/stripe";

// Stripe needs the raw body to verify the signature, so we must opt out of
// any automatic body parsing / caching.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const stripe = stripeClient();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripe || !webhookSecret) {
    return NextResponse.json(
      { error: "Billing not configured on this deployment." },
      { status: 503 }
    );
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature" }, { status: 400 });
  }

  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[stripe] webhook signature verification failed:", msg);
    return NextResponse.json({ error: `Signature: ${msg}` }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        // If the session is for a subscription, pull the subscription and sync.
        if (session.subscription && typeof session.subscription === "string") {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          await syncSubscriptionToUser(sub);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed": {
        const sub = event.data.object as Stripe.Subscription;
        await syncSubscriptionToUser(sub);
        break;
      }
      case "invoice.finalized": {
        // Inject a "TokSuan saved you $X this period" line into the
        // invoice footer + a custom field, so the email Stripe sends to
        // the customer reframes the $29/$99 charge as "you came out ahead".
        // Best-effort — never fails the webhook on this. Stripe still
        // sends the invoice if we crash.
        const invoice = event.data.object as Stripe.Invoice;
        await annotateInvoiceWithSavings(invoice).catch((e) =>
          console.warn("[stripe-webhook] annotateInvoiceWithSavings failed:", e)
        );
        console.log(
          `[stripe-webhook] handled invoice.finalized id=${invoice.id ?? "?"}`
        );
        break;
      }
      case "invoice.paid": {
        // Two independent things happen on a successful payment:
        //   1. Annotate (already wired via invoice.finalized for the email)
        //   2. Record a referral commission row IF this referee was
        //      brought in via someone else's referral code. Idempotent
        //      on the (referee_invoice_id) UNIQUE constraint, so even
        //      if Stripe retries this webhook 5×, only one row lands.
        const invoice = event.data.object as Stripe.Invoice;
        await recordReferralCreditFromInvoice(invoice).catch((e) =>
          console.warn(
            "[stripe-webhook] recordReferralCreditFromInvoice failed:",
            e
          )
        );
        console.log(
          `[stripe-webhook] handled invoice.paid id=${invoice.id ?? "?"}`
        );
        break;
      }
      default:
        console.log(`[stripe-webhook] ignored event type=${event.type}`);
        break;
    }
  } catch (err) {
    console.error(`[stripe] failed to process ${event.type}:`, err);
    // Return 500 so Stripe retries — better than silently dropping a state change.
    return NextResponse.json({ error: "Handler error" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
