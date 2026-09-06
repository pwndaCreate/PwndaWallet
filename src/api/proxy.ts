/**
 * Typed client for the wallet **swap relay** (the no-funds swap-coordination
 * server at `wallet.pwnda.org` — quotes/intents for the Swap tab, with
 * ed25519 X-Client-Sig auth). In the project's "proxy" taxonomy this is
 * **(C) the swap relay** — NOT the mining SOCKS5 privacy proxy (B,
 * `proxy_pool.rs` / `ProxyModePanel`) and NOT the RPC/CORS relay (D,
 * `http_proxy.rs`). The historical `proxy`/`swap_proxy_*` names below are
 * kept as-is (API contract) — the pure-wallet cutover relabelled only
 * comments + UI. See the vault's proxy-taxonomy note.
 *
 * Every call routes through the Tauri Rust core (`swap_*` / `intents_*`
 * commands) — never `fetch` from the webview directly. This:
 *   - keeps the proxy URL out of the JS bundle (it's set by env at startup),
 *   - enforces our CSP without `connect-src` to upstream APIs,
 *   - lets the Rust core reuse the proxy URL across signing/broadcast paths,
 *   - is the architecture mandated by the integration plan §4.5.
 *
 * The Rust core also owns the per-install ed25519 X-Client-Sig keypair —
 * this file only exposes the public surface (status, pubkey, enroll, test).
 */
import { invoke } from "../lib/tauri";
import type {
  IntentsDepositSubmit,
  IntentsQuoteRequest,
  IntentsQuoteResponse,
  IntentsStatusResponse,
  SwapKitQuoteRequest,
  SwapKitQuoteResponse,
  SwapKitSwapRequest,
  SwapKitSwapResponse,
  SwapKitTrackRequest,
  SwapKitTrackResponse,
} from "../lib/proxy-types";

import { DEFAULT_PROXY_URL, resolveProxyUrl, validateProxyUrl } from "./proxy-url";

export { DEFAULT_PROXY_URL, validateProxyUrl };

let proxyConfigured = false;
let activeProxyUrl: string | null = null;

/**
 * Store key for the user's server override (Settings -> SWAP RELAY).
 * Persisted in the same tauri-plugin-store file as the other non-secret
 * settings; readable before vault unlock (configureProxy runs at startup).
 */
const PROXY_URL_OVERRIDE_KEY = "proxyUrlOverride";

function envProxyUrl(): string | null {
  return (import.meta.env.VITE_PROXY_URL as string | undefined) ?? null;
}

async function readOverride(): Promise<string | null> {
  try {
    const { getStore } = await import("../store");
    const store = await getStore();
    const v = await store.get<string | null>(PROXY_URL_OVERRIDE_KEY);
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    // Browser dev / store unavailable — behave as if no override is set.
    return null;
  }
}

/**
 * Configure the proxy URL on the Rust side. Call once at app startup.
 * Precedence: persisted user override (Settings) > `VITE_PROXY_URL` >
 * the production default.
 *
 * Side-effect: the Rust core also generates / loads the per-install
 * ed25519 keypair on this call, persists the public key alongside the
 * vault, and reads back the cached enrolled-at + clock-skew offset FOR
 * THIS SERVER (auth state is keyed by server origin).
 */
export async function configureProxy(): Promise<void> {
  if (proxyConfigured) return;
  const url = resolveProxyUrl(await readOverride(), envProxyUrl());
  await invoke<void>("swap_set_proxy_url", { url });
  activeProxyUrl = url;
  proxyConfigured = true;
}

/** The URL the Rust core is currently pointed at (null before configure). */
export function getActiveProxyUrl(): string | null {
  return activeProxyUrl;
}

/** True when a user override (not the env/default URL) is in effect. */
export function isCustomProxyActive(): boolean {
  return activeProxyUrl !== null && activeProxyUrl !== resolveProxyUrl(null, envProxyUrl());
}

/** The persisted user override, or null when running on the default. */
export async function getProxyUrlOverride(): Promise<string | null> {
  return readOverride();
}

/**
 * Set (or clear, with null/empty) the user's server override, persist it,
 * and repoint the Rust core immediately. Throws with a human-readable
 * message when the URL fails validation — nothing is persisted or applied
 * in that case. Returns the URL now in effect.
 *
 * Switching servers intentionally does NOT auto-enroll: the per-origin
 * auth state means a first visit to a new server reads "not enrolled",
 * and the Settings card surfaces that with its Re-enroll action so
 * introducing this wallet to a new server stays a visible, user-chosen
 * step. (The signed-call path still auto-re-enrolls on AUTH_REQUIRED, so
 * a swap attempt recovers on its own.)
 */
export async function setProxyUrlOverride(input: string | null): Promise<string> {
  let normalized: string | null = null;
  if (input && input.trim().length > 0) {
    const v = validateProxyUrl(input);
    if (!v.ok || !v.url) throw new Error(v.error ?? "Invalid server URL.");
    normalized = v.url;
  }
  try {
    const { getStore } = await import("../store");
    const store = await getStore();
    await store.set(PROXY_URL_OVERRIDE_KEY, normalized);
    await store.save();
  } catch {
    // Persistence failure is non-fatal: the override still applies for
    // this session; next launch falls back to env/default.
  }
  const url = resolveProxyUrl(normalized, envProxyUrl());
  await invoke<void>("swap_set_proxy_url", { url });
  activeProxyUrl = url;
  proxyConfigured = true;
  return url;
}

/** Throws if `configureProxy` hasn't run yet. Useful for early misuse detection. */
function ensure() {
  if (!proxyConfigured) {
    throw new Error("proxy not configured — call configureProxy() at startup");
  }
}

// ---------- proxy auth surface ----------

export interface ProxyStatus {
  url: string | null;
  pubkey: string | null;
  enrolled: boolean;
  enrolledAt: string | null;
  clockOffsetSecs: number;
}

export interface EnrollResult {
  enrolled: boolean;
  already: boolean;
  status: number;
  body: string;
}

export interface ConnectionRow {
  status: number;
  body: string;
  error: string | null;
}

export interface ConnectionTest {
  healthz: ConnectionRow;
  tokens: ConnectionRow;
}

/** Snapshot the proxy auth state — URL, pubkey, enrolled badge, clock offset. */
export async function getProxyStatus(): Promise<ProxyStatus> {
  ensure();
  return invoke<ProxyStatus>("swap_proxy_get_status");
}

/** Returns the per-install public key (base64). Errors if not yet initialized. */
export async function getProxyPubkey(): Promise<string> {
  ensure();
  return invoke<string>("swap_proxy_get_pubkey");
}

/**
 * Auto-allowlist this client on the proxy. Idempotent — safe to call multiple
 * times. Returns the structured result so the UI can show the right toast.
 */
export async function enrollWithProxy(): Promise<EnrollResult> {
  ensure();
  return invoke<EnrollResult>("swap_proxy_enroll");
}

/**
 * Settings → Test Connection. Hits unsigned `/healthz` and the
 * `GET /api/intents/tokens` catalog (server-exempted from SigAuth)
 * and returns both rows for display. Either call can fail at the
 * network layer — surface those via `error`.
 *
 * When `full` is true, the response bodies are returned untruncated
 * (suitable for catalog inspection from DevTools, e.g.
 * `JSON.parse(r.tokens.body)`). When omitted or false, bodies are
 * truncated to 240 chars with a literal `…` ellipsis — readable for
 * the connection-test UI but NOT JSON-parseable.
 *
 * Renamed from `testProxyConnection` 2026-05-26 — the old name
 * implied a binary "did it work" check but the return shape is a
 * sampled connection-test envelope. The deprecated alias below
 * keeps the old name working for any consumer that already imports
 * it.
 */
export async function swapProxyHealthCheck(
  opts: { full?: boolean } = {}
): Promise<ConnectionTest> {
  ensure();
  return invoke<ConnectionTest>("swap_proxy_health_check", { full: opts.full ?? false });
}

/**
 * @deprecated Use `swapProxyHealthCheck()` instead. Renamed 2026-05-26
 * to make the truncation behavior explicit. This alias forwards to
 * the new command (which calls the old Rust command name internally
 * for one more release cycle). Remove after 2026-09 once consumers
 * have migrated.
 */
export async function testProxyConnection(): Promise<ConnectionTest> {
  return swapProxyHealthCheck();
}

// ---------- SwapKit ----------

export async function getSwapKitQuote(
  req: SwapKitQuoteRequest
): Promise<SwapKitQuoteResponse> {
  ensure();
  return invoke<SwapKitQuoteResponse>("swap_get_quote", { req });
}

export async function buildSwapKitTx(
  req: SwapKitSwapRequest
): Promise<SwapKitSwapResponse> {
  ensure();
  return invoke<SwapKitSwapResponse>("swap_build_tx", { req });
}

export async function trackSwapKitSwap(
  req: SwapKitTrackRequest
): Promise<SwapKitTrackResponse> {
  ensure();
  return invoke<SwapKitTrackResponse>("swap_track", { req });
}

// ---------- NEAR Intents ----------

export async function getIntentsQuote(
  req: IntentsQuoteRequest
): Promise<IntentsQuoteResponse> {
  ensure();
  return invoke<IntentsQuoteResponse>("intents_quote", { req });
}

export async function notifyIntentsDeposit(
  req: IntentsDepositSubmit
): Promise<unknown> {
  ensure();
  return invoke("intents_deposit_submit", { req });
}

export async function getIntentsStatus(
  depositAddress: string
): Promise<IntentsStatusResponse> {
  ensure();
  return invoke<IntentsStatusResponse>("intents_status", { depositAddress });
}
