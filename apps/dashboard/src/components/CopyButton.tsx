"use client";

import { useEffect, useRef, useState } from "react";
import type { Dictionary } from "@/i18n/types";

type CopyButtonProps = {
  value: string;
  /** Display text (usually the value itself). Defaults to `value`. */
  display?: string;
  /** Compact = no label text next to the value (just icon + value + icon on hover). */
  compact?: boolean;
  /** Optional localised copy / copied labels. When omitted the button
   *  falls back to English defaults — useful for the public landing
   *  page where threading the dictionary into every nested copy chip
   *  would be more code than the labels save. */
  t?: Dictionary["copyButton"];
};

const FALLBACK_T: Dictionary["copyButton"] = {
  copyTooltip: "Copy to clipboard",
  copiedTooltip: "Copied",
  copyLabel: "copy",
  copiedLabel: "copied",
};

export function CopyButton({
  value,
  display,
  compact = false,
  t,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  const labels = t ?? FALLBACK_T;

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard API can fail (iframes, insecure context) — fall back to execCommand
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* give up silently; copy just didn't happen */
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      className={`copy-btn${copied ? " copy-btn-copied" : ""}`}
      title={copied ? labels.copiedTooltip : labels.copyTooltip}
      aria-label={copied ? labels.copiedTooltip : labels.copyTooltip}
    >
      <span className="copy-btn-value">{display ?? value}</span>
      {!compact && (
        <span className="copy-btn-label">
          {copied ? labels.copiedLabel : labels.copyLabel}
        </span>
      )}
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flex: "0 0 12px", color: copied ? "var(--success)" : "var(--text-muted)" }}
        aria-hidden
      >
        {copied ? (
          <polyline points="20 6 9 17 4 12" />
        ) : (
          <>
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </>
        )}
      </svg>
    </button>
  );
}
