/**
 * Frontend wrapper around the Rust `http_proxy_call` Tauri command.
 *
 * Use this any time a chain adapter needs to hit a public chain-data API
 * that rejects requests carrying the Tauri webview origin (`tauri://localhost`
 * / `https://tauri.localhost`). The Rust side enforces a host-suffix
 * allowlist (see `src-tauri/src/http_proxy.rs::ALLOWED_HOST_SUFFIXES`) and
 * https-only — keep both sides in sync when adding a new endpoint.
 */

import { invoke } from "../lib/tauri";

export interface ProxyResponse {
  status: number;
  body: string;
  headers: Array<[string, string]>;
}

interface RawResponse {
  status: number;
  body: string;
  headers: Array<[string, string]>;
}

/** Raw call. Caller parses the body. */
export async function httpProxyCall(opts: {
  method: "GET" | "POST";
  url: string;
  body?: string;
  headers?: Record<string, string>;
}): Promise<ProxyResponse> {
  const headersArr = opts.headers
    ? Object.entries(opts.headers).map(([name, value]) => ({ name, value }))
    : undefined;
  const raw = await invoke<RawResponse>("http_proxy_call", {
    method: opts.method,
    url: opts.url,
    body: opts.body,
    headers: headersArr,
  });
  return raw;
}

/**
 * GET that parses JSON. Throws on non-2xx with the raw body in the message.
 *
 * **Does NOT include `X-Client-Sig` auth headers.** Routes through the
 * Rust `http_proxy_call` host-allowlist (see `http_proxy.rs::
 * ALLOWED_HOST_SUFFIXES`) so the call gets past the Tauri webview's
 * origin restrictions, but no client-signature header is attached.
 *
 * Use only for public, read-only endpoints (chain-data APIs, the
 * Pwnda proxy's `/api/intents/tokens` catalog, etc.).
 *
 * For endpoints behind `X-Client-Sig` auth (quote / build / track /
 * notify-deposit), use the dedicated `swap_proxy_*` Tauri commands
 * in `src/api/proxy.ts` — those run through `swap::proxy` on the
 * Rust side, which owns the per-install ed25519 keypair and signs
 * outbound requests automatically.
 */
export async function proxyGetJson<T = any>(
  url: string,
  headers?: Record<string, string>
): Promise<T> {
  const r = await httpProxyCall({ method: "GET", url, headers });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`HTTP ${r.status} from ${url}: ${r.body.slice(0, 200)}`);
  }
  return JSON.parse(r.body) as T;
}

/** POST JSON, parse JSON. Auto-sets Content-Type and Accept. */
export async function proxyPostJson<T = any>(
  url: string,
  body: unknown,
  extraHeaders?: Record<string, string>
): Promise<T> {
  const r = await httpProxyCall({
    method: "POST",
    url,
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(extraHeaders ?? {}),
    },
  });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`HTTP ${r.status} from ${url}: ${r.body.slice(0, 200)}`);
  }
  return JSON.parse(r.body) as T;
}
