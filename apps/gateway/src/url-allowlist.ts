/**
 * Egress URL allowlist used by every outbound HTTP target the gateway
 * stitches in from user-controlled input — custom-provider base URLs, BYO
 * provider key `base_url` overrides, and alert webhooks.
 *
 * The check is intentionally conservative: HTTPS only, hostname-based, with
 * an IP-literal fallback so the obvious loopback / private / link-local
 * targets are rejected by default. Self-host operators that intentionally
 * route to private networks (e.g. an internal vLLM, an in-cluster webhook)
 * can opt in with `TOKENSMART_ALLOW_PRIVATE_PROVIDER_URLS=1`.
 *
 * Caveats:
 *   - DNS rebinding (`127.0.0.1.nip.io`) is not fully solved here; we catch
 *     the obvious literal and label-resolved patterns, but the real defense
 *     is platform-side egress filtering or socket-time IP enforcement. This
 *     allowlist is defense-in-depth, not the primary control.
 *   - We don't synchronously resolve hostnames (TOCTOU between resolve and
 *     fetch). For deployments that need hard guarantees, ship behind a
 *     reverse proxy that blocks RFC1918 / loopback at the network layer.
 */

const RFC1918_HINT_HOSTNAMES = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata.googleapis.com",
  "metadata",
]);

const REBIND_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".intranet",
  ".home.arpa",
  ".nip.io",
  ".sslip.io",
  ".xip.io",
  ".traefik.me",
];

function privateIpv4(host: string): boolean {
  const parts = host.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // RFC 5737 docs / TEST-NET
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a === 100 && b >= 64 && b <= 127) return true; // CGN
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function privateIpv6(host: string): boolean {
  // host already had brackets stripped. Lowercase and split on `::` to
  // collapse unspecified.
  const lower = host.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower === "0:0:0:0:0:0:0:1" || lower === "0:0:0:0:0:0:0:0") return true;
  // Link-local fe80::/10
  if (/^fe[89ab][0-9a-f]?:/.test(lower)) return true;
  // ULA fc00::/7
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  // IPv4-mapped IPv6 like ::ffff:127.0.0.1
  const v4MappedMatch = lower.match(/^::ffff:([0-9.]+)$/);
  if (v4MappedMatch && privateIpv4(v4MappedMatch[1]!)) return true;
  return false;
}

/**
 * Returns `true` when the URL is a public HTTPS endpoint we're willing to
 * dispatch to from operator-controlled input. `false` otherwise.
 *
 * Set `TOKENSMART_ALLOW_PRIVATE_PROVIDER_URLS=1` to bypass — explicit opt-in
 * for self-hosted/private-network deployments that intentionally route to
 * RFC1918 / loopback / link-local targets (internal vLLM, on-cluster webhook,
 * etc.).
 */
export function isPublicEgressUrlAllowed(rawUrl: string): boolean {
  if (process.env.TOKENSMART_ALLOW_PRIVATE_PROVIDER_URLS === "1") return true;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (RFC1918_HINT_HOSTNAMES.has(host)) return false;
  for (const suffix of REBIND_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) return false;
  }
  if (privateIpv4(host)) return false;
  if (host.includes(":") && privateIpv6(host)) return false;
  return true;
}
