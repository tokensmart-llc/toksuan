"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Dictionary } from "@/i18n/types";

type Props = {
  /**
   * Background refresh interval, in ms, while the tab is visible. Default 30s.
   * The dashboard home issues ~15 SQL queries per render; 30s keeps the load
   * trivial while still feeling live. A focus / visibilitychange event
   * *always* triggers an immediate refresh regardless of this interval.
   */
  intervalMs?: number;
  /**
   * Server-side `Date.now()` from when the page finished rendering. Used only
   * to drive the "updated Xs ago" label — the actual refresh cadence is
   * controlled by `intervalMs` + visibility events.
   */
  renderedAt: number;
  /**
   * Localised labels. Optional so legacy / operator-only call sites
   * (admin/hosted) can render the indicator without piping the
   * dictionary through. When omitted we fall back to the English copy
   * baked into the dictionary so the indicator never goes blank.
   */
  t?: Dictionary["common"]["autoRefresh"];
};

const FALLBACK: Dictionary["common"]["autoRefresh"] = {
  live: "Live · updated ",
  updating: "updating…",
  justNow: "just now",
  secondsAgo: "{n}s ago",
  minutesAgo: "{n}m ago",
  title:
    "Auto-refreshes every {n}s and immediately when you return to this tab.",
};

/**
 * Client-side "live" refresher for the dashboard home.
 *
 * Triggers `router.refresh()` (re-runs the server component tree — no full
 * page reload, no client-state loss) in three cases:
 *   1. Every `intervalMs` while the tab is visible.
 *   2. Immediately when the tab regains visibility (switching back from
 *      another tab / app).
 *   3. Immediately on window `focus`.
 *
 * Pauses the interval when the tab is hidden so a backgrounded dashboard
 * doesn't keep hammering Postgres. An `inFlight` guard coalesces the
 * visibilitychange + focus double-fire that some browsers emit.
 *
 * Also renders a small "Live · updated Xs ago" indicator. The label is
 * hydration-safe: the initial client render matches the server (empty /
 * "updating…") and the relative timestamp populates after mount.
 */
export function AutoRefresh({ intervalMs = 30_000, renderedAt, t }: Props) {
  const router = useRouter();
  const inFlight = useRef(false);
  const [secondsAgo, setSecondsAgo] = useState<number | null>(null);

  useEffect(() => {
    let intervalId: number | null = null;

    const refresh = () => {
      if (inFlight.current) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      inFlight.current = true;
      router.refresh();
      // router.refresh() is fire-and-forget from a client perspective; release
      // the lock shortly after so a wedged call can't permanently block
      // future refreshes. 2s is well above typical server-component render
      // time on this page.
      window.setTimeout(() => {
        inFlight.current = false;
      }, 2_000);
    };

    const startInterval = () => {
      if (intervalId !== null) return;
      intervalId = window.setInterval(refresh, intervalMs);
    };

    const stopInterval = () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        refresh();
        startInterval();
      } else {
        stopInterval();
      }
    };

    const onFocus = () => {
      refresh();
    };

    startInterval();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);

    return () => {
      stopInterval();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [router, intervalMs]);

  // Separate 1s ticker just for the "updated Xs ago" label. Kept out of the
  // refresh effect so changing the label doesn't re-subscribe the visibility
  // listeners.
  useEffect(() => {
    const update = () =>
      setSecondsAgo(Math.max(0, Math.round((Date.now() - renderedAt) / 1000)));
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, [renderedAt]);

  const labels = t ?? FALLBACK;
  const relative =
    secondsAgo === null
      ? labels.updating
      : secondsAgo < 5
        ? labels.justNow
        : secondsAgo < 60
          ? labels.secondsAgo.replace("{n}", String(secondsAgo))
          : labels.minutesAgo.replace(
              "{n}",
              String(Math.round(secondsAgo / 60))
            );

  return (
    <span
      className="auto-refresh-indicator"
      title={labels.title.replace("{n}", String(Math.round(intervalMs / 1000)))}
      aria-live="polite"
    >
      <span className="auto-refresh-dot" aria-hidden="true" />
      {labels.live}
      {relative}
    </span>
  );
}
