"use client";

import { useEffect, useState } from "react";
import { createAlertRuleAction } from "@/app/projects/actions";
// `import type` is erased by the TypeScript compiler — pulling
// `AlertEventType` from `@/lib/db` does NOT drag postgres-js (a
// node-only package) into the client bundle. The runtime list of
// allowed event types is passed as a prop from the server component.
import type { AlertEventType } from "@/lib/db";
import { describeAlertEvent } from "@/lib/alert-event-copy";
import type { Dictionary } from "@/i18n/types";

/**
 * Add-an-alert-subscription form, extracted from `/projects/[id]` as a
 * Client Component so we can give it the same "form state survives
 * save" UX as `RoutingRuleForm` and `BudgetForm`. Operators commonly
 * subscribe several alerts in a row (one webhook for `budget_exceeded`,
 * another for `loop_detected`, etc.) and used to lose their typed
 * webhook URL every time they saved — `createAlertRuleAction` redirected
 * back to the project page, which reset the form's defaults.
 *
 * Layout note (2026-04-27 rewrite): the previous version was a 5-column
 * horizontal grid that crammed an event dropdown, a webhook URL input,
 * an email input, and a submit button onto one row. The dropdown
 * displayed raw machine names (`budget_exceeded`, `loop_detected`...)
 * and the inputs had only placeholder text, no visible labels — first-
 * time users had no way to tell what each field was for, whether both
 * were required, or what a "webhook" was. Founder feedback was
 * specifically: "this is too academic, normal users won't get it."
 *
 * The current layout uses three rows with explicit labels + a one-line
 * helper for each field. Event names are mapped to short human-readable
 * sentences that explain WHEN the alert fires, not just what database
 * column it maps to.
 */

export interface AlertRuleFormProps {
  projectId: string;
  /** Allowed event types — passed in by the server component
   *  (`ALERT_EVENT_TYPES` from `@/lib/db`). Plumbed as a prop instead
   *  of imported here directly because importing the runtime const
   *  from `@/lib/db` would force `postgres` (node-only) into the
   *  client bundle and break the build. */
  eventTypes: readonly AlertEventType[];
  /** Localised strings for this form. */
  t: Dictionary["forms"]["alert"];
  /** Localised event-copy slice for the dropdown options + helper. */
  tEvents: Dictionary["forms"]["alertEvents"];
}

export function AlertRuleForm({
  projectId,
  eventTypes,
  t,
  tEvents,
}: AlertRuleFormProps) {
  const [eventType, setEventType] = useState<AlertEventType>(eventTypes[0]);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [email, setEmail] = useState("");

  // Same auto-fading "✓ Saved" pattern as RoutingRuleForm + BudgetForm.
  const [savedAt, setSavedAt] = useState<number | null>(null);
  useEffect(() => {
    if (savedAt == null) return;
    const tm = setTimeout(() => setSavedAt(null), 2500);
    return () => clearTimeout(tm);
  }, [savedAt]);

  const eventCopy = describeAlertEvent(eventType, tEvents);

  return (
    <form
      action={async (fd) => {
        await createAlertRuleAction(fd);
        // After save, KEEP the event-type selection (so subscribing to
        // the same kind of event for a sibling webhook is one-click)
        // but CLEAR the webhook + email fields so a typo from the
        // prior save doesn't carry into the next subscription. This
        // is the deliberate UX trade-off vs RoutingRuleForm: those 7
        // tweakable fields all want to persist; here the URL/email is
        // a uniquely-typed value per subscription.
        setWebhookUrl("");
        setEmail("");
        setSavedAt(Date.now());
      }}
      className="alert-rule-form"
    >
      <input type="hidden" name="project_id" value={projectId} />

      {/* Row 1 — event picker. Reads as "Notify me when ___". */}
      <div className="alert-field">
        <label className="alert-field-label" htmlFor="alert-event-type">
          {t.notifyMeWhen}
        </label>
        <select
          id="alert-event-type"
          name="event_type"
          className="input"
          value={eventType}
          onChange={(e) => setEventType(e.target.value as AlertEventType)}
        >
          {eventTypes.map((evt) => (
            <option key={evt} value={evt}>
              {describeAlertEvent(evt, tEvents).title}
            </option>
          ))}
        </select>
        <div className="alert-field-help">{eventCopy.desc}</div>
      </div>

      {/* Row 2 — two channels side-by-side. The "fill at least one"
          rule is enforced server-side (alert-no-target toast); we
          mirror it here in the helper line so the user knows up-front.

          Naming: the left field's value IS a webhook URL — but the word
          "webhook" doesn't mean anything to a non-engineer. The visible
          label talks about WHERE the message ends up (your Slack / 飞书
          group); the helper text uses the word "webhook" exactly once,
          as the search term you'd type into your chat tool's settings
          to find the URL to paste here. */}
      <div className="alert-channels">
        <div className="alert-field">
          <label className="alert-field-label" htmlFor="alert-webhook-url">
            {t.channelWebhookLabel}{" "}
            <span className="alert-field-optional">
              {t.channelWebhookOptional}
            </span>
          </label>
          <input
            id="alert-webhook-url"
            name="webhook_url"
            placeholder="https://hooks.slack.com/services/T…/B…/…"
            className="input"
            type="url"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
          />
          <div className="alert-field-help">
            {t.channelWebhookHelpPrefix}
            <strong>{t.channelWebhookHelpEmphasis}</strong>
            {t.channelWebhookHelpSuffix}
          </div>
        </div>

        <div className="alert-field">
          <label className="alert-field-label" htmlFor="alert-email">
            {t.channelEmailLabel}{" "}
            <span className="alert-field-optional">
              {t.channelWebhookOptional}
            </span>
          </label>
          <input
            id="alert-email"
            name="email"
            placeholder="you@example.com"
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <div className="alert-field-help">{t.channelEmailHelp}</div>
        </div>
      </div>

      {/* Row 3 — primary button on the left (where the eye lands first
          after filling the channels above), the at-least-one rule and
          the transient ✓ Saved pill follow as supporting text. */}
      <div className="alert-form-footer">
        <button type="submit" className="btn btn-primary btn-sm">
          {t.addBtn}
        </button>
        <span className="alert-form-rule">{t.atLeastOneRule}</span>
        <span className="alert-form-spacer" />
        {savedAt != null && (
          <span className="alert-saved-pill" aria-live="polite">
            {t.savedPill}
          </span>
        )}
      </div>
    </form>
  );
}
