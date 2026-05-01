"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { logAuditEvent } from "@/lib/audit";
import {
  createCheckoutSession,
  createPortalSession,
  isStripeConfigured,
} from "@/lib/stripe";
import type { PlanId } from "@/lib/plans";

async function requireUser() {
  const session = await getSession();
  if (!session) redirect("/login");
  return session.user;
}

async function actorIp(): Promise<string | null> {
  const h = await headers();
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    null
  );
}

export async function upgradeToAction(formData: FormData): Promise<void> {
  if (!isStripeConfigured()) {
    throw new Error(
      "Billing is not configured on this deployment. Set STRIPE_SECRET_KEY + STRIPE_PRICE_PRO/TEAM/SCALE."
    );
  }
  const user = await requireUser();
  const plan = String(formData.get("plan") ?? "") as PlanId;
  if (plan !== "pro" && plan !== "team" && plan !== "scale") {
    throw new Error(`Invalid upgrade target: ${plan}`);
  }
  const { url } = await createCheckoutSession({ user, plan });

  await logAuditEvent({
    userId: user.id,
    actorEmail: user.email,
    event: "billing.checkout",
    targetType: "plan",
    targetId: plan,
    metadata: { from_plan: user.plan, to_plan: plan },
    ip: await actorIp(),
  });

  redirect(url);
}

export async function manageSubscriptionAction(): Promise<void> {
  if (!isStripeConfigured()) {
    throw new Error("Billing is not configured on this deployment.");
  }
  const user = await requireUser();
  const row = await sql<{ stripe_customer_id: string | null }[]>`
    SELECT stripe_customer_id FROM users WHERE id = ${user.id}
  `;
  const { url } = await createPortalSession({
    user: { ...user, stripe_customer_id: row[0]?.stripe_customer_id ?? null },
  });

  await logAuditEvent({
    userId: user.id,
    actorEmail: user.email,
    event: "billing.portal",
    metadata: { plan: user.plan },
    ip: await actorIp(),
  });

  redirect(url);
}
