import { env, findProviderTemplate, pickProvider, type ProviderConfig } from "./config";
import {
  decryptProviderKey,
  getActiveKeyProvider,
} from "./crypto";
import {
  backfillUserProviderKeyFingerprint,
  getUserProviderKey,
  listUserCustomProviders,
  type StoredCustomProvider,
} from "./db";
import { isPublicEgressUrlAllowed } from "./url-allowlist";

/**
 * Backward-compatible shim. Prefer the shared `isPublicEgressUrlAllowed`
 * helper for any new outbound URL check.
 */
function customProviderUrlAllowed(rawUrl: string): boolean {
  return isPublicEgressUrlAllowed(rawUrl);
}

/**
 * Pick the right `ProviderConfig` to forward a request with.
 *
 * Resolution order (first match wins):
 *   1. **User-defined custom providers** (L4) — a `user_custom_providers`
 *      row whose `model_prefix` matches the incoming model string. Lets a
 *      user wire up Groq / xAI / Mistral / local vLLM / any
 *      OpenAI-compatible endpoint we don't ship a static template for.
 *   2. **Static template catalog** (L1) — one of the six providers
 *      TokSuan ships recognizers for. If matched AND the user has a
 *      `user_provider_keys` row for that provider, that BYO key wins;
 *      otherwise we use the gateway's env-configured key.
 *   3. If nothing matches → `no_template`. If template matched but no
 *      credentials available → `no_credentials`.
 *
 * Custom-provider lookup failures (DB error) and BYO decrypt failures
 * silently fall through to the next tier. We log loudly so an operator
 * can investigate, but a single broken row never takes down the path.
 */
export type ResolveResult =
  | { ok: true; config: ProviderConfig; source: "custom" | "byo" | "env" }
  | {
      ok: false;
      reason: "no_template" | "no_credentials";
      providerName?: string;
    };

export async function resolveProvider(
  userId: string | null,
  model: string
): Promise<ResolveResult> {
  // --- 1. Custom providers (L4) — first chance for the user's own wiring.
  if (userId) {
    try {
      const custom = await matchCustomProvider(userId, model);
      if (custom) return custom;
    } catch (err) {
      console.error(
        `[provider-resolve] custom provider lookup failed for user ${userId}:`,
        err
      );
      // Fall through to static template path — a broken custom-provider
      // registry must not black-hole every request.
    }
  }

  const template = findProviderTemplate(model);
  if (!template) return { ok: false, reason: "no_template" };

  if (userId) {
    try {
      const stored = await getUserProviderKey(userId, template.name);
      if (stored) {
        if (
          stored.base_url != null &&
          !customProviderUrlAllowed(stored.base_url.replace(/\/+$/, ""))
        ) {
          console.warn(
            `[provider-resolve] provider key ${stored.id} has a blocked base_url override. ` +
              `Use https public endpoints, or set TOKENSMART_ALLOW_PRIVATE_PROVIDER_URLS=1 for self-hosted/private-network deployments.`
          );
        } else {
          const apiKey = await decryptProviderKey(
            stored.encrypted_key,
            stored.master_key_fingerprint
          );

          // Legacy rows from before migration 004 have no fingerprint stamp.
          // Now that we've successfully decrypted it, stamp it with whatever
          // provider actually produced this ciphertext. For NULL-fingerprint
          // rows that's always the env provider (they predate KMS support).
          if (stored.master_key_fingerprint == null) {
            const activeProvider = getActiveKeyProvider();
            if (activeProvider.name === "env") {
              // Only backfill when env is still the active backend — if KMS
              // is active, stamping an env fingerprint would confuse the
              // migration script. Better to leave NULL and let migrate-to-kms
              // re-encrypt.
              const fp = activeProvider.currentFingerprint();
              backfillUserProviderKeyFingerprint(stored.id, fp).catch((e) =>
                console.warn(
                  `[provider-resolve] fingerprint backfill failed for ${stored.id}:`,
                  e
                )
              );
            }
          }

          return {
            ok: true,
            source: "byo",
            config: {
              name: template.name,
              apiKey,
              baseUrl: stored.base_url ?? template.baseUrl,
              matches: template.matches,
            },
          };
        }
      }
    } catch (err) {
      console.error(
        `[provider-resolve] BYO key lookup/decrypt failed for user ${userId} provider ${template.name}:`,
        err
      );
    }
  }

  const envCfg = pickProvider(model, env.providers);
  if (envCfg) return { ok: true, source: "env", config: envCfg };

  return { ok: false, reason: "no_credentials", providerName: template.name };
}

/**
 * Check the user's custom-provider registry for a `model_prefix` match.
 * Returns a ready-to-forward `ProviderConfig` when matched, else null.
 *
 * Match semantics:
 *   - Case-insensitive prefix on the lowercased model string.
 *   - `listUserCustomProviders` already returned rows ordered by
 *     `length(model_prefix) DESC`, so the most-specific match wins.
 *     That makes `groq/mixtral` beat `groq/` when both are registered.
 *   - `encrypted_key` is optional; an empty auth key is valid for
 *     local / internal endpoints. We pass through as empty string so
 *     the upstream sees no Authorization header.
 *   - Decrypt failures are CAUGHT here (not re-thrown) so one broken
 *     row doesn't lose the rest of the user's registered upstreams —
 *     the caller just moves on to the next resolution tier.
 */
async function matchCustomProvider(
  userId: string,
  model: string
): Promise<Extract<ResolveResult, { ok: true }> | null> {
  const rows = await listUserCustomProviders(userId);
  if (rows.length === 0) return null;
  const needle = model.toLowerCase();
  for (const row of rows) {
    const prefix = row.model_prefix.toLowerCase();
    if (!needle.startsWith(prefix)) continue;
    const apiKey = await decryptCustomProviderKey(row);
    if (apiKey === null) continue; // broken row — skip, try the next
    const baseUrl = row.base_url.replace(/\/+$/, "");
    if (!customProviderUrlAllowed(baseUrl)) {
      console.warn(
        `[provider-resolve] custom provider ${row.id} has a blocked base_url. ` +
          `Use https public endpoints, or set TOKENSMART_ALLOW_PRIVATE_PROVIDER_URLS=1 for self-hosted/private-network deployments.`
      );
      continue;
    }
    return {
      ok: true,
      source: "custom",
      config: {
        // `name` is used for key-pool rotation + pricing lookup; for
        // custom providers we namespace under `custom:<id>` so the
        // key-rotator's per-provider pools stay isolated and we don't
        // accidentally merge the user's Groq quota into the built-in
        // `openai` pool.
        name: `custom:${row.id}`,
        apiKey,
        baseUrl,
        // Prefix-match closure mirrors the static templates' `matches`
        // shape. Inexpensive closure — same semantics used at lookup.
        matches: (m: string) => m.toLowerCase().startsWith(prefix),
      },
    };
  }
  return null;
}

/**
 * Decrypt a custom-provider key, or return null for "don't forward an
 * Authorization header". Malformed ciphertext returns null too — logged
 * but not thrown, so one corrupt row doesn't affect peers.
 */
async function decryptCustomProviderKey(
  row: StoredCustomProvider
): Promise<string | null> {
  if (!row.encrypted_key) return ""; // legitimate "no auth" case
  try {
    return await decryptProviderKey(
      row.encrypted_key,
      row.master_key_fingerprint
    );
  } catch (err) {
    console.error(
      `[provider-resolve] failed to decrypt custom-provider key for id=${row.id}:`,
      err
    );
    return null;
  }
}
