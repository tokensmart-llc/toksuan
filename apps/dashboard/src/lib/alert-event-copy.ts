/**
 * Human-readable copy for each alert event type the gateway can fire.
 *
 * Pulled out of `AlertRuleForm.tsx` so both the client form (the
 * dropdown) AND the server-rendered project page (the subscriptions
 * table's EVENT column) share the same wording. Without this, the
 * form showed "Spending hits a budget cap" but the saved row in the
 * table dropped back to the raw machine name `budget_exceeded`, which
 * made users wonder whether they'd actually saved the same thing.
 *
 * Locale support: this map now takes a localised slice of the
 * dictionary (`Dictionary["forms"]["alertEvents"]`) and returns the
 * matching `{ title, desc }` for the requested event type. Callers
 * resolve the slice once at render time (server pages via
 * `getDictionary()`, client components via a prop) and thread it
 * through.
 *
 * `import type` is used in the client component for `AlertEventType`;
 * the runtime const map below is pure mapping logic with zero
 * transitive deps, so this module is safe for client + server bundles
 * alike (no postgres-js drag-in like `@/lib/db` would cause).
 */

import type { AlertEventType } from "@/lib/db";
import type { Dictionary } from "@/i18n/types";

export type AlertEventCopySlice = Dictionary["forms"]["alertEvents"];

/** Convenience accessor with a graceful fallback. If the gateway ever
 *  ships a new event type before the dashboard knows about it, the
 *  table won't render `undefined` — it'll fall back to the raw machine
 *  name (still ugly, but useful enough to debug). */
export function describeAlertEvent(
  eventType: AlertEventType | string,
  t: AlertEventCopySlice
): {
  title: string;
  desc: string;
} {
  switch (eventType) {
    case "budget_exceeded":
      return t.budgetExceeded;
    case "loop_detected":
      return t.loopDetected;
    case "cost_anomaly":
      return t.costAnomaly;
    case "retrain_failed":
      return t.retrainFailed;
    default:
      return { title: eventType, desc: "" };
  }
}
