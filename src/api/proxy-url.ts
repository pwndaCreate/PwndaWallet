/**
 * Pure URL logic for the swap-relay server setting: validation and
 * precedence. No Tauri imports — unit-testable in isolation, and shared by
 * `api/proxy.ts` (runtime) and the Settings card (input validation).
 *
 * Why validation is strict:
 *   - https-only (loopback excepted) because the relay carries quote and
 *     address data and the enrollment pubkey - never over plain http to a
 *     remote host.
 *   - no path prefixes: X-Client-Sig signs the request PATH as the server
 *     sees it. A base URL like `https://x/relay` would make the client sign
 *     `/api/...` while the server receives `/relay/api/...` — every signed
 *     call 401s in a way that looks like an enrollment bug. Refuse up front
 *     with the reason instead.
 *   - no userinfo/query/fragment: never meaningful for a base URL; presence
 *     means the user pasted something they didn't intend.
 */

/** Production default. Override precedence: user setting > VITE_PROXY_URL > this. */
export const DEFAULT_PROXY_URL = "https://wallet.pwnda.org";

export interface ProxyUrlValidation {
  ok: boolean;
  /** Normalized origin form (`scheme://host[:port]`) when ok. */
  url?: string;
  /** Human-readable reason when not ok. */
  error?: string;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/**
 * Validate a user-entered server URL. Returns the normalized ORIGIN
 * (lowercased scheme+host, default port elided) as the canonical value —
 * the same normalization the Rust side keys auth state by, so one server
 * never gets two enrollment entries from spelling variants.
 */
export function validateProxyUrl(input: string): ProxyUrlValidation {
  const raw = input.trim();
  if (!raw) {
    return { ok: false, error: "Server URL is empty." };
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: "Not a valid URL (include the scheme, e.g. https://...)." };
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackHost(u.hostname))) {
    return {
      ok: false,
      error: "Use https:// - plain http is allowed only for localhost dev servers.",
    };
  }
  if (u.username || u.password) {
    return { ok: false, error: "Credentials in the URL are not allowed." };
  }
  if (u.search) {
    return { ok: false, error: "A base URL cannot carry a query string." };
  }
  if (u.hash) {
    return { ok: false, error: "A base URL cannot carry a #fragment." };
  }
  if (u.pathname !== "/") {
    return {
      ok: false,
      error:
        "Path prefixes are not supported - request signing covers the path as the server sees it.",
    };
  }
  return { ok: true, url: u.origin };
}

/**
 * Resolve the effective proxy URL: valid user override, else build-time env
 * value, else the production default. An INVALID override is ignored here
 * (never persisted by the setter, but a hand-edited store entry must not
 * brick startup) — the resolver always yields a usable URL.
 */
export function resolveProxyUrl(
  override: string | null | undefined,
  envUrl: string | null | undefined
): string {
  if (override) {
    const v = validateProxyUrl(override);
    if (v.ok && v.url) return v.url;
  }
  if (envUrl && envUrl.trim().length > 0) return envUrl.trim();
  return DEFAULT_PROXY_URL;
}
