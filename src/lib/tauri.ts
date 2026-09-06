/**
 * Guarded Tauri invoke wrapper.
 *
 * One job: in the Claude Code visual-iteration sandbox (`npm run
 * dev:sandbox` / `npm run tauri:dev:sandbox` with `VITE_DEV_INSTANCE=sandbox`),
 * synthesize realistic per-command responses when the real Tauri runtime
 * is absent — so the UI renders something meaningful in a plain browser
 * without a Rust sidecar. In every other context, defer to the real
 * `invoke` from `@tauri-apps/api/core` unchanged.
 *
 * The main `npm run tauri dev` instance (the user's personal dev wallet)
 * is unaffected — `VITE_DEV_INSTANCE` is unset there, so this wrapper is
 * a pass-through.
 *
 * See CONTRIBUTING.md § "Isolated Dev Iteration Sandbox" for the bigger
 * picture. The mock catalog lives in `./tauri-mocks.ts`.
 */
import { invoke as tauriInvoke, type InvokeArgs } from "@tauri-apps/api/core";
import { getMock, getFetchMock } from "./tauri-mocks";

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: {
    invoke?: (cmd: string, args?: unknown) => Promise<unknown>;
    [k: string]: unknown;
  };
};

// Snapshot BEFORE we install any shim, so we can tell apart "real Tauri
// runtime present" from "our shim". The check has to run once at module
// init — `import.meta.env.VITE_DEV_INSTANCE` is statically resolvable so
// dead-code elimination drops the whole mock branch in production builds.
const realTauriPresent: boolean =
  typeof window !== "undefined" &&
  !!(window as TauriWindow).__TAURI_INTERNALS__;

const isClaudeSandbox: boolean =
  typeof import.meta !== "undefined" &&
  import.meta.env?.VITE_DEV_INSTANCE === "sandbox";

/**
 * Per-command log throttle for the sandbox mock announcement.
 *
 * The line is genuinely useful ("which command did the wrapper synthesize?")
 * and was unconditional. On 2026-08-28 a runaway UTXO gap walk turned that
 * into ~3,000 `plugin:store|set` lines PER SECOND, which starved the renderer
 * and made Playwright screenshots time out — the log volume became a fault of
 * its own on top of the bug it was reporting.
 *
 * So: log the first `LOG_BURST` calls of each command verbatim, then once per
 * `LOG_SUMMARY_MS` emit a count instead. A caller that fires a command twice
 * still shows both lines; a caller stuck in a loop shows a rate, which is more
 * diagnostic than the flood ever was. Per-command, so a chatty command can
 * never mask a quiet one.
 */
const LOG_BURST = 5;
const LOG_SUMMARY_MS = 2000;
const mockLogState = new Map<string, { count: number; lastSummary: number }>();

function logMockCall(cmd: string): void {
  const now = Date.now();
  const st = mockLogState.get(cmd) ?? { count: 0, lastSummary: now };
  st.count += 1;
  if (st.count <= LOG_BURST) {
    // eslint-disable-next-line no-console
    console.info(`[tauri-mock] returning mock data for ${cmd}`);
    st.lastSummary = now;
  } else if (now - st.lastSummary >= LOG_SUMMARY_MS) {
    // eslint-disable-next-line no-console
    console.info(
      `[tauri-mock] ${cmd} — ${st.count} calls so far (throttled; ` +
        `>${LOG_BURST} calls means a caller is looping, which is worth a look)`,
    );
    st.lastSummary = now;
  }
  mockLogState.set(cmd, st);
}

/**
 * Plugin-store and a few other `@tauri-apps/plugin-*` packages call
 * `invoke` from `@tauri-apps/api/core` directly — bypassing this
 * wrapper. To intercept that traffic too, install a global stub on
 * `window.__TAURI_INTERNALS__` so the SDK's own invoke routes through
 * our mock. Only installed in the dev sandbox + when no real Tauri
 * runtime is present. Never touches production behaviour.
 */
if (!realTauriPresent && isClaudeSandbox && typeof window !== "undefined") {
  (window as TauriWindow).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: unknown) => {
      logMockCall(cmd);
      return getMock(cmd, args);
    },
    transformCallback: () => 0,
    convertFileSrc: (path: string) => path,
  };

  // window.fetch shim. Many chain adapters call `fetch()` DIRECTLY (BTC, ERG,
  // ALGO/TRX/HBAR balance, EVM JSON-RPC via ethers, ...) — bypassing the
  // `http_proxy_call` invoke wrapper — and would CORS-fail in browser-only
  // mode. Intercept the URLs `dispatchUrl` knows about and synthesize a
  // Response; pass everything else (Vite assets, HMR, unmatched hosts) through
  // untouched. See [[sandbox-demo-mode-improvements]] Fix 1a.
  //
  // Tier C: `VITE_SANDBOX_NETWORK=real` disables the shim so the (world-public,
  // zero-risk) BIP39 test seed hits real read-only RPCs for true on-chain data.
  const sandboxNetwork = import.meta.env?.VITE_SANDBOX_NETWORK;
  if (sandboxNetwork !== "real" && typeof window.fetch === "function") {
    const realFetch = window.fetch.bind(window);
    window.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      let url = "";
      try {
        url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url;
      } catch {
        url = "";
      }
      const method = String(
        init?.method ??
          (typeof input === "object" && input && "method" in input
            ? (input as Request).method
            : "GET") ??
          "GET",
      ).toUpperCase();
      // Extract the request body as text. ethers v6 (used for every EVM
      // JSON-RPC call) encodes its body to a Uint8Array, NOT a string — so
      // decode bytes too, or the JSON-RPC envelope is never recognized and the
      // call leaks to the real network (CORS-fails). Mirrors sol-wallet.ts.
      let bodyText: string | undefined;
      const rawBody = init?.body;
      if (typeof rawBody === "string") bodyText = rawBody;
      else if (rawBody instanceof Uint8Array) bodyText = new TextDecoder().decode(rawBody);
      else if (rawBody instanceof ArrayBuffer)
        bodyText = new TextDecoder().decode(new Uint8Array(rawBody));
      let body: unknown = undefined;
      if (bodyText) {
        try {
          body = JSON.parse(bodyText);
        } catch {
          body = bodyText;
        }
      }
      const mock = getFetchMock(url, method, body);
      if (mock) {
        // eslint-disable-next-line no-console
        console.info(
          `[tauri-mock] fetch shim serviced ${method} ${url.slice(0, 80)}`,
        );
        return new Response(mock.body, {
          status: mock.status,
          headers: { "content-type": "application/json" },
        });
      }
      return realFetch(input, init);
    };
  }
}

/**
 * Drop-in replacement for `@tauri-apps/api/core`'s `invoke`. Generic
 * signature mirrors the upstream type so callers can pass `<T>` exactly
 * as before. Call sites should import from `@/lib/tauri` (or the
 * relative path) — never from `@tauri-apps/api/core` directly.
 */
export async function invoke<T = unknown>(
  cmd: string,
  args?: InvokeArgs,
): Promise<T> {
  if (realTauriPresent) {
    return tauriInvoke<T>(cmd, args);
  }
  if (isClaudeSandbox) {
    logMockCall(cmd);
    return getMock<T>(cmd, args);
  }
  // No sandbox AND no Tauri: defer to the real invoke so the same
  // "Tauri runtime missing" error surfaces as it would today. We do
  // NOT silently fake data in the main browser-only dev flow — that's
  // a footgun for the user's actual wallet UX.
  return tauriInvoke<T>(cmd, args);
}

// Re-export for callers that referenced the secondary `InvokeArgs` type
// alongside `invoke`.
export type { InvokeArgs };
