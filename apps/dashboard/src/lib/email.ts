import { Resend } from "resend";
import { getDictionaryFor, isLocale, type Locale } from "./i18n";

/**
 * Transactional email via Resend.
 *
 * Gated on `RESEND_API_KEY`. When not set, `isEmailConfigured()` returns
 * false and callers fall back to logging the OTP to stdout — that's the
 * dev ergonomics we want: your local install never needs to configure
 * SMTP just to test a login.
 *
 * Localisation: every body builder takes a `Locale` arg. Callers thread
 * it from a request cookie (login) or from `users.preferred_locale`
 * (org invites + cron weekly digest). Unknown / missing locale falls
 * back to English via `pickLocale()`.
 */

const DEFAULT_FROM = "TokSuan <onboarding@resend.dev>";

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

/** Module-init one-shot stderr warning so `docker logs dashboard` carries
 * the email-domain misconfiguration signal without requiring the operator
 * to navigate to /settings to discover it. The dashboard has no formal
 * boot hook in App Router; importing email.ts on first server-side render
 * is the closest thing. */
{
  const warn = (() => {
    if (!process.env.RESEND_API_KEY) return null;
    const from = process.env.RESEND_FROM ?? DEFAULT_FROM;
    const m = /@([A-Za-z0-9_.\-]+)(?:>|$)/.exec(from);
    const domain = m?.[1]?.toLowerCase() ?? null;
    if (domain === "resend.dev") return "RESEND_FROM uses unverified resend.dev domain — login emails will likely Spam-bin.";
    return null;
  })();
  if (warn) console.warn(`[tokensmart-email] ${warn}`);
}

/**
 * `RESEND_FROM` is unverified-domain when it points at Resend's shared
 * `@resend.dev` address (the default). That address works for testing
 * but: (a) Gmail / Outlook frequently mark it as Spam, (b) Resend
 * rate-limits it aggressively, (c) end-users see an `@resend.dev` From
 * line that doesn't match the brand they signed up for. For any
 * production install the operator MUST verify their own domain in
 * Resend and set `RESEND_FROM=Brand <login@your-verified-domain>`.
 *
 * Returns the human-readable reason if the configuration is suspicious,
 * `null` if everything looks fine. Used by `/settings → System
 * integrations` to surface a yellow warning, and by gateway boot to
 * print a one-time stderr line so `docker logs` always carries the
 * signal.
 */
export function emailDomainWarning(): string | null {
  if (!process.env.RESEND_API_KEY) return null;
  const from = process.env.RESEND_FROM ?? DEFAULT_FROM;
  // Match either explicit `Name <addr@domain>` or bare `addr@domain`
  // and pull the domain off. Anything past the `@` until `>` or EOL.
  const m = /@([A-Za-z0-9_.\-]+)(?:>|$)/.exec(from);
  const domain = m?.[1]?.toLowerCase() ?? null;
  if (!domain) {
    return "RESEND_FROM is set but no email domain could be parsed from it; verify the address shape `Name <addr@domain>`.";
  }
  if (domain === "resend.dev") {
    return "RESEND_FROM is using the unverified shared `@resend.dev` sender. Gmail/Outlook will likely Spam-bin login emails and Resend will rate-limit aggressively. Verify your own domain in Resend and set RESEND_FROM=Brand <login@your-verified-domain>.";
  }
  return null;
}

function baseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_BASE_URL?.replace(/\/$/, "") ??
    "http://localhost:3000"
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Resolve an arbitrary locale string (or null/undefined) to a supported
 *  `Locale`. Falls back to `en` when the input isn't a known locale. */
function pickLocale(locale: string | null | undefined): Locale {
  return locale != null && isLocale(locale) ? locale : "en";
}

/** `<html lang>` value to stamp on the outer email shell — drives the
 *  language attribute Gmail / Apple Mail use for screen-reader hints. */
function htmlLangFor(locale: Locale): string {
  return locale === "zh-CN" ? "zh-CN" : "en";
}

/** Replace `{name}` placeholders in a template. Mirrors the dashboard's
 *  `t.X.Y.replace("{n}", ...)` pattern so the dictionary keys stay
 *  format-compatible across surfaces. */
function fill(tpl: string, vars: Record<string, string>): string {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{${k}}`, v);
  }
  return out;
}

export type SendLoginEmailArgs = {
  to: string;
  code: string;
  token: string;
  ttlMinutes: number;
  /** Optional safe relative path to bounce the user to after the
   * magic link consumes. When unset, lands on `/`. Already sanitised
   * by the caller via `safeRelayPath`. */
  nextPath?: string;
  /** Recipient's preferred locale (cookie OR `users.preferred_locale`).
   *  When omitted falls back to English. */
  locale?: string | null;
};

export type SendResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Send the sign-in code. Never throws — on failure, returns
 * `{ ok: false, error }` so the login flow can continue (the OTP is also
 * logged to stdout, so in dev a failed send doesn't lock anyone out).
 */
export async function sendLoginEmail(
  args: SendLoginEmailArgs
): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }

  const resend = new Resend(apiKey);
  const from = process.env.RESEND_FROM ?? DEFAULT_FROM;
  const locale = pickLocale(args.locale);
  const t = getDictionaryFor(locale).emails;
  const linkParams = new URLSearchParams({ token: args.token });
  if (args.nextPath && args.nextPath !== "/") {
    linkParams.set("next", args.nextPath);
  }
  const link = `${baseUrl()}/login/verify?${linkParams.toString()}`;

  try {
    const { error } = await resend.emails.send({
      from,
      to: args.to,
      subject: fill(t.otpSubjectTpl, { code: args.code }),
      text: [
        fill(t.otpTextLine1, { code: args.code }),
        "",
        t.otpTextLink,
        link,
        "",
        fill(t.otpTextExpiry, { ttl: String(args.ttlMinutes) }),
        t.otpTextFooter,
      ].join("\n"),
      html: buildHtml(args.code, link, args.ttlMinutes, locale),
    });
    if (error) {
      const msg =
        typeof error === "string"
          ? error
          : error && typeof error === "object" && "message" in error
          ? String((error as { message: unknown }).message)
          : JSON.stringify(error);
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// --- Organization invitation email ---------------------------------------

export type SendInviteEmailArgs = {
  to: string;
  organizationName: string;
  inviterEmail: string;
  role: "admin" | "member" | "viewer";
  token: string;
  /** Recipient's preferred locale. Resolved by the caller from
   *  `users.preferred_locale` if the invitee already has an account,
   *  or from the inviter's preference for cold invites. */
  locale?: string | null;
};

/**
 * Send an org-invite email. Same fail-soft posture as `sendLoginEmail` —
 * any failure is returned, never thrown. The full magic link is also
 * logged to stdout so dev installs can use it without configuring email.
 */
export async function sendInviteEmail(
  args: SendInviteEmailArgs
): Promise<SendResult> {
  const link = `${baseUrl()}/organization/accept?token=${encodeURIComponent(
    args.token
  )}`;
  console.log(
    `[tokensmart-org] invitation issued for ${args.to} → ${args.organizationName} (${args.role}). ` +
      `Accept link: ${link}`
  );

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }

  const resend = new Resend(apiKey);
  const from = process.env.RESEND_FROM ?? DEFAULT_FROM;
  const locale = pickLocale(args.locale);
  const t = getDictionaryFor(locale).emails;
  const safeOrg = escapeHtml(args.organizationName);
  const safeInviter = escapeHtml(args.inviterEmail);
  const safeRole = escapeHtml(args.role);
  const lang = htmlLangFor(locale);
  try {
    const { error } = await resend.emails.send({
      from,
      to: args.to,
      subject: fill(t.inviteSubject, {
        inviter: args.inviterEmail,
        org: args.organizationName,
      }),
      text: [
        fill(t.inviteTextLine1, {
          inviter: args.inviterEmail,
          org: args.organizationName,
          role: args.role,
        }),
        "",
        t.inviteTextLink,
        link,
        "",
        t.inviteTextFooter1,
        t.inviteTextFooter2,
      ].join("\n"),
      html: `<!doctype html>
<html lang="${lang}">
<body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Helvetica,Arial,sans-serif;">
  <p>${fill(t.inviteHtmlLine, {
    inviter: safeInviter,
    org: safeOrg,
    role: safeRole,
  })}</p>
  <p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#5b8def;color:#fff;border-radius:6px;text-decoration:none;font-family:system-ui,sans-serif">${t.inviteHtmlBtn}</a></p>
  <p style="color:#666;font-size:12px">${t.inviteHtmlFallback}<code>${link}</code></p>
  <p style="color:#666;font-size:12px">${t.inviteHtmlFooter}</p>
</body>
</html>`,
    });
    if (error) {
      const msg =
        typeof error === "string"
          ? error
          : error && typeof error === "object" && "message" in error
          ? String((error as { message: unknown }).message)
          : JSON.stringify(error);
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// --- Weekly savings digest ------------------------------------------------

export type WeeklyDigestArgs = {
  to: string;
  /** First-name greeting; falls back to the dictionary's "there" / "同学"
   *  when the user didn't set a name. */
  recipientName: string | null;
  totalSavingMicroCents: number;
  routingSavingMicroCents: number;
  cacheSavingMicroCents: number;
  routingRequestCount: number;
  cacheHitCount: number;
  loopsPreventedCount: number;
  budgetBlockedCount: number;
  totalSpendMicroCents: number;
  /** Top routed pairs by savings, e.g. [{from: "gpt-4o", to: "gpt-4o-mini", saved_micro_cents: 12345}, ...] */
  topRoutes: Array<{
    from_model: string;
    to_model: string;
    request_count: number;
    saved_micro_cents: number;
  }>;
  /**
   * Per-user unsubscribe URL. Produced by `buildUnsubscribeUrl` after
   * `getOrCreateUnsubscribeToken`. Required — we won't send a digest
   * without a working opt-out link (CAN-SPAM § 5(a)(5) + Gmail bulk
   * sender policy both require one).
   */
  unsubscribeUrl: string;
  /** Recipient's preferred locale (from `users.preferred_locale`). */
  locale?: string | null;
};

function fmtUsdSmart(microCents: number): string {
  const usd = microCents / 100_000;
  if (usd === 0) return "$0";
  if (usd >= 100) return `$${usd.toFixed(2)}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(6)}`;
}

/**
 * Send the weekly savings digest. Same fail-soft contract as
 * `sendLoginEmail`: never throws, returns `{ok:false, error}` on failure
 * so the cron script can keep iterating other recipients.
 */
export async function sendWeeklyDigestEmail(
  args: WeeklyDigestArgs
): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }

  const resend = new Resend(apiKey);
  const from = process.env.RESEND_FROM ?? DEFAULT_FROM;
  const locale = pickLocale(args.locale);
  const t = getDictionaryFor(locale).emails;
  const greeting =
    args.recipientName?.trim() || t.digestGreetingFallbackName;
  const totalUsd = fmtUsdSmart(args.totalSavingMicroCents);
  const subject = fill(t.digestSubjectTpl, { amount: totalUsd });

  try {
    const { error } = await resend.emails.send({
      from,
      to: args.to,
      subject,
      text: buildDigestText(args, greeting, totalUsd, locale),
      html: buildDigestHtml(args, greeting, totalUsd, locale),
      // RFC 2369 + RFC 8058 one-click unsubscribe. Gmail, Apple Mail,
      // Yahoo render a button in the message header when both headers
      // are present; clicking it POSTs to the URL below without ever
      // taking the user out of the inbox.
      headers: {
        "List-Unsubscribe": `<${args.unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    if (error) {
      const msg =
        typeof error === "string"
          ? error
          : error && typeof error === "object" && "message" in error
            ? String((error as { message: unknown }).message)
            : JSON.stringify(error);
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildDigestText(
  args: WeeklyDigestArgs,
  greeting: string,
  totalUsd: string,
  locale: Locale
): string {
  const t = getDictionaryFor(locale).emails;
  const dashboardUrl = (
    process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000"
  ).replace(/\/$/, "");
  const lines = [
    fill(t.digestGreeting, { name: greeting }),
    "",
    fill(t.digestRecapLine, { amount: totalUsd }),
    "",
    `  ${t.digestRoutingLabel}        ${fmtUsdSmart(args.routingSavingMicroCents)} ${fill(t.digestRoutingNote, { n: String(args.routingRequestCount) })}`,
    `  ${t.digestCacheLabel}   ${fmtUsdSmart(args.cacheSavingMicroCents)} ${fill(t.digestCacheNote, { n: String(args.cacheHitCount) })}`,
  ];
  if (args.loopsPreventedCount > 0 || args.budgetBlockedCount > 0) {
    lines.push(
      `  ${t.digestAlsoCaughtLabel}    ${fill(t.digestAlsoCaughtNote, {
        loops: String(args.loopsPreventedCount),
        budget: String(args.budgetBlockedCount),
      })}`
    );
  }
  if (args.topRoutes.length > 0) {
    lines.push("", t.digestTopRoutesLabel);
    for (const r of args.topRoutes.slice(0, 5)) {
      lines.push(
        `  ${r.from_model} → ${r.to_model}  ${fmtUsdSmart(r.saved_micro_cents)} (${r.request_count} ${t.digestHtmlReqAbbrev.trim()})`
      );
    }
  }
  lines.push(
    "",
    fill(t.digestTotalSpendLabel, {
      amount: fmtUsdSmart(args.totalSpendMicroCents),
    }),
    "",
    fill(t.digestViewDashboardLabel, { url: dashboardUrl }),
    "",
    fill(t.digestUnsubscribeLine, { url: args.unsubscribeUrl }),
    t.digestUnsubscribeNote,
    "—",
    t.digestFooterTagline
  );
  return lines.join("\n");
}

function buildDigestHtml(
  args: WeeklyDigestArgs,
  greeting: string,
  totalUsd: string,
  locale: Locale
): string {
  const t = getDictionaryFor(locale).emails;
  const lang = htmlLangFor(locale);
  const dashboardUrl = (
    process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000"
  ).replace(/\/$/, "");
  const safeGreeting = escapeHtml(greeting);
  const topRoutesHtml = args.topRoutes
    .slice(0, 5)
    .map(
      (r) =>
        `<tr><td style="padding:6px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#9aa3ad;">${escapeHtml(r.from_model)} → ${escapeHtml(r.to_model)}</td><td style="padding:6px 0;text-align:right;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#5fbf6c;">${fmtUsdSmart(r.saved_micro_cents)}</td><td style="padding:6px 0 6px 12px;text-align:right;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#6b7380;">${args.routingRequestCount}${t.digestHtmlReqAbbrev}</td></tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="${lang}">
<body style="margin:0;padding:40px 20px;background:#0b0d10;color:#e6e8eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;">
    <tr><td style="background:#14181f;border:1px solid #1f242b;border-radius:12px;padding:32px;">
      <div style="font-size:14px;font-weight:600;margin-bottom:24px;color:#e6e8eb;">${t.digestHtmlBrand}</div>
      <p style="font-size:14px;color:#9aa3ad;margin:0 0 8px;">${escapeHtml(fill(t.digestGreeting, { name: safeGreeting }))}</p>
      <p style="font-size:14px;color:#9aa3ad;margin:0 0 24px;line-height:1.5;">${escapeHtml(t.digestIntro)}</p>
      <div style="background:#0b0d10;border:1px solid #1f242b;border-radius:8px;padding:24px;text-align:center;margin-bottom:24px;">
        <div style="font-size:13px;color:#5fbf6c;letter-spacing:0.05em;text-transform:uppercase;font-weight:600;margin-bottom:8px;">${t.digestHtmlSavedLabel}</div>
        <div style="font-size:42px;font-weight:600;letter-spacing:-0.02em;color:#5fbf6c;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(totalUsd)}</div>
        <div style="font-size:12px;color:#6b7380;margin-top:8px;">${t.digestHtmlVsSpendPrefix}${escapeHtml(fmtUsdSmart(args.totalSpendMicroCents))}${t.digestHtmlVsSpendSuffix}</div>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #1f242b;font-size:13px;color:#9aa3ad;">${t.digestRoutingLabel.replace(/[:：]$/, "")}</td>
          <td style="padding:10px 0;border-bottom:1px solid #1f242b;text-align:right;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#e6e8eb;">${escapeHtml(fmtUsdSmart(args.routingSavingMicroCents))}</td>
          <td style="padding:10px 0 10px 12px;border-bottom:1px solid #1f242b;text-align:right;font-size:11px;color:#6b7380;">${args.routingRequestCount}${t.digestHtmlReqsSuffix}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #1f242b;font-size:13px;color:#9aa3ad;">${t.digestCacheLabel.replace(/[:：]$/, "")}</td>
          <td style="padding:10px 0;border-bottom:1px solid #1f242b;text-align:right;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#e6e8eb;">${escapeHtml(fmtUsdSmart(args.cacheSavingMicroCents))}</td>
          <td style="padding:10px 0 10px 12px;border-bottom:1px solid #1f242b;text-align:right;font-size:11px;color:#6b7380;">${args.cacheHitCount}${t.digestHtmlHitsSuffix}</td>
        </tr>
        ${
          args.loopsPreventedCount > 0 || args.budgetBlockedCount > 0
            ? `<tr><td style="padding:10px 0;font-size:13px;color:#9aa3ad;">${t.digestHtmlAlsoCaught}</td><td colspan="2" style="padding:10px 0;text-align:right;font-size:12px;color:#6b7380;">${args.loopsPreventedCount}${t.digestHtmlLoopsSuffix} · ${args.budgetBlockedCount}${t.digestHtmlOverBudgetSuffix}</td></tr>`
            : ""
        }
      </table>
      ${
        topRoutesHtml
          ? `<div style="font-size:12px;color:#9aa3ad;margin-bottom:8px;font-weight:600;">${t.digestHtmlTopRoutesLabel}</div><table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">${topRoutesHtml}</table>`
          : ""
      }
      <a href="${escapeHtml(dashboardUrl)}" style="display:block;text-align:center;background:#6cb6ff;color:#071320;font-weight:600;text-decoration:none;padding:12px 16px;border-radius:6px;margin-bottom:8px;font-size:14px;">${t.digestHtmlViewBtn}</a>
      <p style="color:#6b7380;font-size:11px;line-height:1.5;margin:16px 0 0;text-align:center;">
        ${t.digestHtmlUnsubPrefix}
        <a href="${escapeHtml(args.unsubscribeUrl)}" style="color:#9aa3ad;text-decoration:underline;">${t.digestHtmlUnsubLink}</a>${t.digestHtmlUnsubSuffix}
      </p>
    </td></tr>
  </table>
  <p style="max-width:560px;margin:16px auto 0;color:#6b7380;font-size:11px;text-align:center;">${t.digestFooterTagline}</p>
</body>
</html>`;
}

function buildHtml(
  code: string,
  link: string,
  ttlMinutes: number,
  locale: Locale
): string {
  const t = getDictionaryFor(locale).emails;
  const lang = htmlLangFor(locale);
  const safeLink = escapeHtml(link);
  const safeCode = escapeHtml(code);

  // Inline-style email — no stylesheet, no external resources. Optimised for
  // Gmail / Outlook rendering, which is why the colors are hardcoded rather
  // than pulled from the CSS variables.
  return `<!doctype html>
<html lang="${lang}">
<body style="margin:0;padding:40px 20px;background:#0b0d10;color:#e6e8eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;">
    <tr>
      <td style="background:#14181f;border:1px solid #1f242b;border-radius:12px;padding:32px;">
        <div style="font-size:14px;font-weight:600;letter-spacing:0.01em;margin-bottom:20px;color:#e6e8eb;">${t.otpHtmlBrand}</div>
        <h1 style="font-size:20px;margin:0 0 8px;letter-spacing:-0.005em;color:#e6e8eb;font-weight:600;">${t.otpHeading}</h1>
        <p style="color:#9aa3ad;font-size:14px;line-height:1.5;margin:0 0 24px;">${t.otpIntro}</p>
        <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:32px;letter-spacing:0.3em;text-align:center;background:#0b0d10;border:1px solid #1f242b;border-radius:8px;padding:20px;margin-bottom:20px;color:#e6e8eb;">${safeCode}</div>
        <a href="${safeLink}" style="display:block;text-align:center;background:#6cb6ff;color:#071320;font-weight:600;text-decoration:none;padding:12px 16px;border-radius:6px;margin-bottom:24px;font-size:14px;">${t.otpHtmlSignInBtn}</a>
        <p style="color:#6b7380;font-size:12px;line-height:1.5;margin:0;">${fill(t.otpTextExpiry, { ttl: String(ttlMinutes) })} ${t.otpFooter}</p>
      </td>
    </tr>
  </table>
  <p style="max-width:480px;margin:16px auto 0;color:#6b7380;font-size:11px;text-align:center;">${t.digestFooterTagline}</p>
</body>
</html>`;
}
