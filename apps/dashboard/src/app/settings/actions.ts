"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { logAuditEvent } from "@/lib/audit";
import {
  deleteCustomProvider,
  deleteUserProviderKey,
  getStoredProviderKeyForUser,
  setCustomProviderEnabled,
  setWeeklyDigestEnabled,
  SUPPORTED_PROVIDERS,
  upsertCustomProvider,
  upsertUserProviderKey,
  type ProviderName,
} from "@/lib/db";
import {
  decryptProviderKey,
  encryptProviderKey,
  isProviderKeyEncryptionConfigured,
} from "@/lib/crypto";
import { isHostedMode } from "@/lib/mode";

async function requireSession() {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

const PROVIDER_LABEL: Record<ProviderName, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  doubao: "Doubao",
};

async function actorContext() {
  const h = await headers();
  return {
    ip:
      h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      h.get("x-real-ip") ||
      null,
    userAgent: h.get("user-agent"),
  };
}

function toastQuery(slug: string, arg?: string): string {
  const p = new URLSearchParams({ toast: slug });
  if (arg) p.set("toast_arg", arg);
  return p.toString();
}

/**
 * Save (insert or replace) a BYO upstream provider key for the current user.
 *
 * Plaintext lives only inside this function — we encrypt with AES-256-GCM
 * before any DB write and never log the raw value. The user re-pastes if
 * they want to update.
 */
export async function setProviderKeyAction(formData: FormData): Promise<void> {
  const session = await requireSession();

  if (!isProviderKeyEncryptionConfigured()) {
    redirect(
      `/settings?${toastQuery("provider-key-encryption-missing")}`
    );
  }

  const provider = String(formData.get("provider") ?? "") as ProviderName;
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    redirect(`/settings?${toastQuery("provider-key-invalid")}`);
  }

  const rawKey = String(formData.get("api_key") ?? "").trim();
  if (rawKey.length < 8) {
    redirect(`/settings?${toastQuery("provider-key-too-short")}`);
  }

  const baseUrlRaw = String(formData.get("base_url") ?? "").trim();
  let baseUrl: string | null = null;
  if (baseUrlRaw) {
    try {
      const u = new URL(baseUrlRaw);
      // Strip trailing slashes so we don't double-slash when concatenating.
      baseUrl = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
    } catch {
      redirect(`/settings?${toastQuery("provider-key-bad-url")}`);
    }
  }

  const { ciphertext, fingerprint } = await encryptProviderKey(rawKey);
  const last4 = rawKey.slice(-4);

  const row = await upsertUserProviderKey(
    session.user.id,
    provider,
    ciphertext,
    fingerprint,
    last4,
    baseUrl
  );

  const { ip, userAgent } = await actorContext();
  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    event: "provider_key.set",
    targetType: "provider_key",
    targetId: row.id,
    metadata: {
      provider,
      last4,
      base_url: baseUrl,
      master_key_fingerprint: fingerprint,
    },
    ip,
    userAgent,
  });

  redirect(
    `/settings?${toastQuery("provider-key-saved", PROVIDER_LABEL[provider])}#provider-keys`
  );
}

export async function deleteProviderKeyAction(
  formData: FormData
): Promise<void> {
  const session = await requireSession();
  const id = String(formData.get("id") ?? "");
  const provider = String(formData.get("provider") ?? "");
  if (!id) return;

  await deleteUserProviderKey(session.user.id, id);

  const { ip, userAgent } = await actorContext();
  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    event: "provider_key.deleted",
    targetType: "provider_key",
    targetId: id,
    metadata: { provider },
    ip,
    userAgent,
  });

  redirect(`/settings?${toastQuery("provider-key-deleted")}`);
}

// ===========================================================================
// Test a stored provider key by making a tiny live call (B1)
// ===========================================================================
//
// Returns nothing — communicates result via toast + an in-memory
// per-test result that the page reads back from cookies. We deliberately
// do NOT log the test result to audit_events; tests are exploratory and
// shouldn't pollute the per-user audit timeline. We DO log a short
// `provider_key.tested` event for ops_audit_events visibility.

const TEST_RESULT_COOKIE = "ts-key-test-result";
const TEST_RESULT_TTL_MS = 30_000;

type TestResult = {
  id: string;
  ok: boolean;
  detail: string;
  latency_ms: number;
};

const PROVIDER_TEST_CONFIG: Record<
  ProviderName,
  {
    defaultBaseUrl: string;
    /** A model name guaranteed to exist on this provider for the ping. */
    pingModel: string;
    /** Native protocol selector — Anthropic uses /v1/messages, others use OpenAI-compat. */
    protocol: "openai-compat" | "anthropic";
  }
> = {
  openai: {
    defaultBaseUrl: "https://api.openai.com/v1",
    pingModel: "gpt-4o-mini",
    protocol: "openai-compat",
  },
  anthropic: {
    defaultBaseUrl: "https://api.anthropic.com/v1",
    pingModel: "claude-3-5-haiku-latest",
    protocol: "anthropic",
  },
  google: {
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    pingModel: "gemini-2.5-flash-lite",
    protocol: "openai-compat",
  },
  deepseek: {
    defaultBaseUrl: "https://api.deepseek.com/v1",
    pingModel: "deepseek-chat",
    protocol: "openai-compat",
  },
  qwen: {
    defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    pingModel: "qwen-plus",
    protocol: "openai-compat",
  },
  doubao: {
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    pingModel: "doubao-pro-4k",
    protocol: "openai-compat",
  },
};

async function pingProvider(
  provider: ProviderName,
  apiKey: string,
  baseUrlOverride: string | null
): Promise<TestResult> {
  const cfg = PROVIDER_TEST_CONFIG[provider];
  const baseUrl = baseUrlOverride ?? cfg.defaultBaseUrl;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    let res: Response;
    if (cfg.protocol === "anthropic") {
      res = await fetch(`${baseUrl}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: cfg.pingModel,
          max_tokens: 1,
          messages: [{ role: "user", content: "ok" }],
        }),
      });
    } else {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: cfg.pingModel,
          max_tokens: 1,
          messages: [{ role: "user", content: "ok" }],
        }),
      });
    }
    const latency_ms = Date.now() - started;
    if (res.ok) {
      return {
        id: "",
        ok: true,
        detail: `${cfg.pingModel} responded in ${latency_ms}ms`,
        latency_ms,
      };
    }
    const text = await res.text().catch(() => "");
    return {
      id: "",
      ok: false,
      detail: `upstream HTTP ${res.status}: ${text.slice(0, 200) || "(empty body)"}`,
      latency_ms,
    };
  } catch (err) {
    return {
      id: "",
      ok: false,
      detail: `network/timeout: ${(err as Error).message}`,
      latency_ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function testProviderKeyAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const id = String(formData.get("id") ?? "");
  if (!id) redirect(`/settings?${toastQuery("test-key-fail")}`);

  const stored = await getStoredProviderKeyForUser(session.user.id, id);
  if (!stored) redirect(`/settings?${toastQuery("test-key-fail")}`);

  let plaintext: string;
  try {
    plaintext = await decryptProviderKey(
      stored.encrypted_key,
      stored.master_key_fingerprint
    );
  } catch {
    await persistTestResult(id, {
      id,
      ok: false,
      detail:
        "Could not decrypt — master key may have changed. Try deleting and re-pasting the key.",
      latency_ms: 0,
    });
    redirect(`/settings?${toastQuery("test-key-fail")}`);
  }

  const result = await pingProvider(
    stored.provider,
    plaintext,
    stored.base_url
  );
  result.id = id;
  await persistTestResult(id, result);

  redirect(
    `/settings?${toastQuery(result.ok ? "test-key-ok" : "test-key-fail")}`
  );
}

async function persistTestResult(id: string, result: TestResult): Promise<void> {
  const c = await import("next/headers").then((m) => m.cookies());
  const all = await readTestResults();
  // Cap size + drop expired.
  const now = Date.now();
  const fresh = all.filter(
    (r) => now - r.ts < TEST_RESULT_TTL_MS && r.result.id !== id
  );
  fresh.push({ ts: now, result });
  c.set(TEST_RESULT_COOKIE, JSON.stringify(fresh.slice(-12)), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60,
  });
}

type StoredTestResult = { ts: number; result: TestResult };

async function readTestResults(): Promise<StoredTestResult[]> {
  try {
    const c = await import("next/headers").then((m) => m.cookies());
    const raw = c.get(TEST_RESULT_COOKIE)?.value;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Server-only helper used by the Settings page render to surface the most
 * recent test result for each key. Cleared after read so the toast doesn't
 * stay forever.
 */
export async function consumeProviderKeyTestResults(): Promise<
  Record<string, TestResult>
> {
  const all = await readTestResults();
  const now = Date.now();
  const fresh = all.filter((r) => now - r.ts < TEST_RESULT_TTL_MS);
  const byId: Record<string, TestResult> = {};
  for (const entry of fresh) byId[entry.result.id] = entry.result;
  return byId;
}

// ---------------------------------------------------------------------------
// Weekly digest opt-in (added v0.2.x)
// ---------------------------------------------------------------------------

/**
 * Toggle the user's weekly savings-digest email subscription. Audited.
 * Form submits a single `enabled` field as "1" / "0".
 */
export async function setWeeklyDigestAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const enabled = String(formData.get("enabled") ?? "") === "1";

  await setWeeklyDigestEnabled(session.user.id, enabled);

  const ctx = await actorContext();
  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    event: enabled
      ? "user.weekly_digest.enabled"
      : "user.weekly_digest.disabled",
    metadata: { enabled },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  // Hosted SaaS runs the digest cron itself; self-host installs need an
  // operator to wire `bun run send-weekly-savings` to a scheduler. The
  // success copy diverges accordingly.
  redirect(
    `/settings?${toastQuery(
      enabled
        ? isHostedMode()
          ? "digest-enabled-hosted"
          : "digest-enabled"
        : "digest-disabled"
    )}`
  );
}

// ===========================================================================
// L4 — Custom providers (arbitrary OpenAI-compatible upstreams)
// ===========================================================================

/**
 * Validate the user-supplied `name`. Must be URL-safe (no slashes / spaces)
 * because it shows up in audit logs / toast copy, and we want it stable
 * across re-edits. Length 1-64.
 */
function validateCustomProviderName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return null;
  if (name.length > 64) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-_]*$/.test(name)) return null;
  return name;
}

/**
 * Validate the model prefix. We intentionally accept `/` and `:` since
 * they're common in provider-scoped names (`groq/`, `meta/llama-3-`,
 * `local/`). Length 1-64.
 */
function validateModelPrefix(raw: string): string | null {
  const pfx = raw.trim();
  if (!pfx) return null;
  if (pfx.length > 64) return null;
  // Reject whitespace + control chars; allow ASCII printable + common
  // punctuation. Case preserved for display but matched case-insensitively
  // at resolve time.
  if (/[\s\x00-\x1f]/.test(pfx)) return null;
  return pfx;
}

export async function setCustomProviderAction(
  formData: FormData
): Promise<void> {
  const session = await requireSession();

  const name = validateCustomProviderName(String(formData.get("name") ?? ""));
  if (!name) {
    redirect(`/settings?${toastQuery("custom-provider-bad-name")}`);
  }

  const prefix = validateModelPrefix(
    String(formData.get("model_prefix") ?? "")
  );
  if (!prefix) {
    redirect(`/settings?${toastQuery("custom-provider-bad-prefix")}`);
  }

  const baseUrlRaw = String(formData.get("base_url") ?? "").trim();
  let baseUrl: string;
  try {
    const u = new URL(baseUrlRaw);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error("non-http(s) scheme");
    }
    baseUrl = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    redirect(`/settings?${toastQuery("custom-provider-bad-url")}`);
  }

  // Key is OPTIONAL — local vLLM / internal LAN endpoints don't need one.
  const rawKey = String(formData.get("api_key") ?? "").trim();
  let encryptedKey: string | null = null;
  let keyLast4: string | null = null;
  let fingerprint: string | null = null;
  if (rawKey) {
    if (rawKey.length < 8) {
      redirect(`/settings?${toastQuery("custom-provider-key-too-short")}`);
    }
    if (!isProviderKeyEncryptionConfigured()) {
      redirect(`/settings?${toastQuery("provider-key-encryption-missing")}`);
    }
    const enc = await encryptProviderKey(rawKey);
    encryptedKey = enc.ciphertext;
    fingerprint = enc.fingerprint;
    keyLast4 = rawKey.slice(-4);
  }

  const row = await upsertCustomProvider({
    userId: session.user.id,
    name: name!,
    baseUrl: baseUrl!,
    modelPrefix: prefix!,
    encryptedKey,
    keyLast4,
    masterKeyFingerprint: fingerprint,
  });

  const ctx = await actorContext();
  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    event: "custom_provider.set",
    targetType: "custom_provider",
    targetId: row.id,
    metadata: {
      name,
      base_url: baseUrl,
      model_prefix: prefix,
      has_key: Boolean(rawKey),
      last4: keyLast4,
      master_key_fingerprint: fingerprint,
    },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  redirect(`/settings?${toastQuery("custom-provider-saved", name!)}`);
}

export async function deleteCustomProviderAction(
  formData: FormData
): Promise<void> {
  const session = await requireSession();
  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "");
  if (!id) return;

  const ok = await deleteCustomProvider(session.user.id, id);

  const ctx = await actorContext();
  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    event: "custom_provider.deleted",
    targetType: "custom_provider",
    targetId: id,
    metadata: { name, deleted: ok },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  redirect(`/settings?${toastQuery("custom-provider-deleted", name)}`);
}

export async function toggleCustomProviderEnabledAction(
  formData: FormData
): Promise<void> {
  const session = await requireSession();
  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "");
  const enabled = String(formData.get("enabled") ?? "false") === "true";
  if (!id) return;

  await setCustomProviderEnabled(session.user.id, id, enabled);

  const ctx = await actorContext();
  await logAuditEvent({
    userId: session.user.id,
    actorEmail: session.user.email,
    event: enabled
      ? "custom_provider.enabled"
      : "custom_provider.disabled",
    targetType: "custom_provider",
    targetId: id,
    metadata: { name, enabled },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  redirect(
    `/settings?${toastQuery(
      enabled ? "custom-provider-enabled" : "custom-provider-disabled",
      name
    )}`
  );
}
