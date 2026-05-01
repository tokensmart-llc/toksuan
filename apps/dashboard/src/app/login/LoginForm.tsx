"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { Logo } from "@/components/Logo";
import type { Dictionary } from "@/i18n/types";
import { requestLogin, verifyLogin, type LoginState } from "./actions";

const INITIAL: LoginState = { ok: false, stage: "email" };

/** Seconds the Resend button stays disabled after a successful resend. Prevents
 * accidental double-clicks AND signals to the user that the action took
 * effect (the visible countdown is the affordance). 30s is short enough to
 * recover from a real bounce, long enough to discourage spam. */
const RESEND_COOLDOWN_S = 30;

/**
 * Client-side half of the login page. The server wrapper (`page.tsx`)
 * computes `hostedMode` from the server env and passes it down, which
 * lets us hide the "dev installs: code also printed to server log"
 * footer for hosted customers — that line makes sense to a self-hoster
 * reading their own server stdout, but reads as "is my email broken?"
 * to a paying customer in production.
 */
export function LoginForm({
  hostedMode,
  nextPath,
  t,
}: {
  hostedMode: boolean;
  /** Safe relative path the user will be bounced to after sign-in.
   * Comes from middleware's `?next=` redirect; the server sanitises
   * this via `safeRelayPath` before passing it down, so by the time
   * it reaches the form it's always either "/" or "/<something>". */
  nextPath: string;
  /** Translated strings for the login page (server-resolved). */
  t: Dictionary["login"];
}) {
  const [state, submit] = useActionState<LoginState, FormData>(
    async (prev, formData) => {
      const stage = String(formData.get("stage") ?? "email");
      if (stage === "email") return requestLogin(prev, formData);
      return verifyLogin(prev, formData);
    },
    INITIAL
  );

  const codeState = state.stage === "code" ? state : null;
  const stage = state.stage;

  // Resend feedback. `resendAt` is the wall-clock timestamp the cooldown
  // ends; we render a per-second countdown ("Resend in 28s") so the user
  // has unambiguous evidence the click took effect — without this the only
  // signal was the `note` field flipping to the same string it already had.
  const [resendAt, setResendAt] = useState<number | null>(null);
  const [resendPending, startResendTransition] = useTransition();
  const [resendTick, setResendTick] = useState(0);
  useEffect(() => {
    if (resendAt == null) return;
    const id = setInterval(() => setResendTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [resendAt]);
  const cooldownLeft =
    resendAt != null
      ? Math.max(0, Math.ceil((resendAt - Date.now()) / 1000))
      : 0;
  // `resendTick` is referenced just to keep the linter from optimizing
  // out the interval (the value itself is irrelevant — we read Date.now()
  // afresh on each render).
  void resendTick;

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="auth-brand-mark">
            <Logo size={28} />
          </span>
          TokSuan
        </div>

        <h1 style={{ fontSize: 20, marginBottom: 6 }}>
          {codeState ? t.titleCode : t.titleEmail}
        </h1>
        <p
          style={{
            color: "var(--text-secondary)",
            fontSize: 13,
            margin: "0 0 20px",
          }}
        >
          {codeState
            ? `${t.sentToPrefix}${codeState.email}${t.sentToSuffix}`
            : t.subtitleEmail}
        </p>

        <form action={submit} style={{ display: "grid", gap: 14 }}>
          <input type="hidden" name="stage" value={stage} />
          {/* Carry the post-login destination through the 2-step OTP
             flow. Both requestLogin and verifyLogin read this field. */}
          <input type="hidden" name="next" value={nextPath} />

          <label className="field">
            <span className="field-label">{t.fieldEmail}</span>
            <input
              name="email"
              type="email"
              required
              autoFocus={!codeState}
              defaultValue={codeState?.email ?? ""}
              readOnly={!!codeState}
              placeholder={t.placeholderEmail}
              className="input"
            />
          </label>

          {codeState && (
            <label className="field">
              <span className="field-label">{t.fieldCode}</span>
              <input
                name="code"
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                required
                autoFocus
                placeholder={t.placeholderCode}
                className="input input-otp"
              />
            </label>
          )}

          {state.error && (
            <div style={{ color: "var(--danger)", fontSize: 12 }}>
              {state.error}
            </div>
          )}

          {codeState?.note && (
            <div style={{ color: "var(--success)", fontSize: 12 }}>
              {codeState.note}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              type="submit"
              className="btn btn-primary"
              style={{ flex: codeState ? 1 : undefined }}
            >
              {codeState ? t.verify : t.continue}
            </button>
            {codeState && (
              <button
                type="button"
                disabled={resendPending || cooldownLeft > 0}
                onClick={() => {
                  startResendTransition(() => {
                    const resent = new FormData();
                    resent.set("stage", "email");
                    resent.set("email", codeState.email);
                    // Thread next= through the resend path too, so the
                    // eventual verify still lands on the right page.
                    resent.set("next", nextPath);
                    submit(resent);
                    setResendAt(Date.now() + RESEND_COOLDOWN_S * 1000);
                  });
                }}
                className="btn"
                title={
                  cooldownLeft > 0
                    ? t.resendTooltipDisabled
                    : t.resendTooltipReady
                }
              >
                {resendPending
                  ? t.sending
                  : cooldownLeft > 0
                    ? t.resendIn.replace("{seconds}", String(cooldownLeft))
                    : t.resend}
              </button>
            )}
          </div>
        </form>

        {!hostedMode && (
          <p
            style={{
              color: "var(--text-muted)",
              fontSize: 11.5,
              marginTop: 24,
              marginBottom: 0,
            }}
          >
            {t.devLogHint}
          </p>
        )}
      </div>
    </div>
  );
}
