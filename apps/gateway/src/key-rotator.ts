/**
 * Per-provider API-key rotator with round-robin selection + cooldown on
 * rate-limited (HTTP 429) keys.
 *
 * The single most-requested production feature on top of failover: when
 * OpenAI's per-organization rate limits start biting, you typically have
 * several billing org keys you can rotate through. This module lets the
 * gateway pick a fresh key per request and temporarily benches keys that
 * just got 429'd, so a single rate-limit-hot key doesn't block the whole
 * pool while it cools down.
 *
 * Configuration is comma-separated env values that the existing key envs
 * understand. Backward compatible — a single key still works, it's just a
 * pool of size 1.
 *
 *   OPENAI_API_KEY=sk-...,sk-...,sk-...
 *   ANTHROPIC_API_KEY=sk-ant-...,sk-ant-...
 *
 * Cooldown defaults: 30 seconds (typical OpenAI 429 retry-after window).
 * Configurable via TOKENSMART_KEY_COOLDOWN_MS.
 *
 * The selection strategy is intentionally simple:
 *   1. Filter keys whose cooldown hasn't expired
 *   2. Pick the round-robin next from the remaining set
 *   3. If ALL keys are cooling down, return the next-to-expire one anyway
 *      (better to retry than to fail with no key)
 *
 * Per-key state is in-memory only — gateway restart resets all cooldowns.
 * Acceptable for v0; promote to Redis when horizontally scaling (same
 * comment as on the loop detector).
 */

import type { ProviderName } from "./pricing";

const DEFAULT_COOLDOWN_MS = 30_000;

function getCooldownMs(): number {
  const raw = process.env.TOKENSMART_KEY_COOLDOWN_MS;
  if (!raw) return DEFAULT_COOLDOWN_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_COOLDOWN_MS;
}

export type KeyPool = {
  keys: string[];
  /** Round-robin cursor. */
  next: number;
  /** Per-key timestamp (ms) until which the key is benched. 0 = available. */
  cooldownUntil: Map<string, number>;
};

const POOLS = new Map<ProviderName, KeyPool>();

/**
 * Parse a comma-separated key string into a pool. Whitespace tolerated.
 * A single key stays a 1-element pool — the existing call sites work
 * unchanged because all the `next()` / `markRateLimited()` plumbing
 * degenerates into "always return the one key".
 */
export function buildKeyPool(commaSeparated: string): KeyPool {
  const keys = commaSeparated
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  return {
    keys,
    next: 0,
    cooldownUntil: new Map(),
  };
}

/**
 * Register a pool for a provider. Idempotent — replaces any existing pool.
 * Logs a one-line summary at boot when pool size > 1.
 */
export function registerKeyPool(provider: ProviderName, pool: KeyPool): void {
  POOLS.set(provider, pool);
  if (pool.keys.length > 1) {
    console.log(
      `[tokensmart] key pool for ${provider}: ${pool.keys.length} keys, round-robin + ${getCooldownMs()}ms 429-cooldown`
    );
  }
}

/**
 * Pick the next available key from the provider's pool.
 *
 *   - Returns the canonical key string (NOT a copy — keys are immutable)
 *   - Skips keys whose cooldown hasn't expired
 *   - If every key is cooling down, returns the one whose cooldown expires
 *     first (so the caller still has SOMETHING to retry with — better than
 *     failing the request with "no keys available")
 *   - Returns null only if the pool is empty
 */
export function pickKey(provider: ProviderName): string | null {
  const pool = POOLS.get(provider);
  if (!pool || pool.keys.length === 0) return null;
  if (pool.keys.length === 1) return pool.keys[0];

  const now = Date.now();
  const n = pool.keys.length;
  let chosen: string | null = null;

  // First try: find the next round-robin key that isn't cooling down.
  for (let i = 0; i < n; i++) {
    const idx = (pool.next + i) % n;
    const key = pool.keys[idx];
    const until = pool.cooldownUntil.get(key) ?? 0;
    if (until <= now) {
      chosen = key;
      pool.next = (idx + 1) % n;
      return chosen;
    }
  }

  // Fallback: every key is benched. Return the one closest to expiring,
  // with no cursor advance — caller will likely 429 again and we'll
  // refresh the cooldown.
  let earliest = Infinity;
  let earliestKey: string = pool.keys[0];
  for (const k of pool.keys) {
    const until = pool.cooldownUntil.get(k) ?? 0;
    if (until < earliest) {
      earliest = until;
      earliestKey = k;
    }
  }
  return earliestKey;
}

/**
 * Mark `key` as rate-limited. Bench it for `cooldown_ms` milliseconds.
 * Caller hands us a key that just returned 429 from upstream; we put it
 * on the bench so the next request picks a different one.
 *
 * If `retryAfterMs` is provided (e.g. parsed from upstream `Retry-After`
 * header), use it; otherwise fall back to the configured default.
 */
export function markRateLimited(
  provider: ProviderName,
  key: string,
  retryAfterMs?: number
): void {
  const pool = POOLS.get(provider);
  if (!pool || !pool.keys.includes(key)) return;
  const cooldown =
    retryAfterMs && retryAfterMs > 0 && retryAfterMs < 600_000
      ? retryAfterMs
      : getCooldownMs();
  pool.cooldownUntil.set(key, Date.now() + cooldown);
}

/**
 * Snapshot of pool health for /health, dashboard, or future ops UI.
 * Returns `available` count (keys not currently cooling down) and
 * `total` (all keys in the pool).
 */
export function poolStats(provider: ProviderName): {
  total: number;
  available: number;
} {
  const pool = POOLS.get(provider);
  if (!pool) return { total: 0, available: 0 };
  const now = Date.now();
  let available = 0;
  for (const k of pool.keys) {
    if ((pool.cooldownUntil.get(k) ?? 0) <= now) available++;
  }
  return { total: pool.keys.length, available };
}

/** Test-only: clear all pools so each test starts fresh. */
export function _resetForTests(): void {
  POOLS.clear();
}
