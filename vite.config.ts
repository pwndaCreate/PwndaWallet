import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

const host = process.env.TAURI_DEV_HOST;

// `VITE_BUILD_VARIANT=lite` selects the Pwnda Lite mining-only product.
// Affects three things:
//   1. The dev/build entry HTML (`index-lite.html` instead of `index.html`).
//   2. Vite's project root so `index-lite.html` is treated as the entry.
//   3. The build output directory (`dist-lite/` instead of `dist/`).
// See PwndaWalletVault/wiki/synthesis/pwnda-lite-plan.md.
const isLite = process.env.VITE_BUILD_VARIANT === "lite";

// `VITE_ENTRY=catalog` or `VITE_ENTRY=web` switches the Vite entry HTML
// to the dedicated design catalog / pure-web full-app surfaces. See
// PwndaWalletVault/wiki/synthesis/design-system-modularization.md Phase 4.
//   - catalog: index-catalog.html → src/design/catalog/main.tsx (no Tauri)
//   - web:     index-web.html     → src/main.tsx (Tauri shimmed)
// Dev: open http://localhost:1420/<index-name>.html in a browser.
const entry = process.env.VITE_ENTRY;
const entryHtml =
  entry === "catalog"
    ? "index-catalog.html"
    : entry === "web"
    ? "index-web.html"
    : isLite
    ? "index-lite.html"
    : null;

// ---------------------------------------------------------------------------
// Vite config notes
// ---------------------------------------------------------------------------
// `wasm()` and `topLevelAwait()` are required by `tiny-secp256k1`, which
// uses the ESM "WebAssembly integration" proposal:
//
//     import * as wasm from "./secp256k1.wasm";
//
// Removing these plugins causes:
//   "ESM integration proposal for Wasm" is not supported currently.
//   Use vite-plugin-wasm or other community plugins to handle this.
//
// `topLevelAwait` is needed as a companion to `wasm` because wasm imports
// compile to top-level `await`. tiny-secp256k1 is used by bitcoinjs-lib
// (BTC) and the EVM-side BIP32 derivation, so removing them breaks every
// chain except XMR.
//
// `nodePolyfills` provides Node-style http/fs/stream/util/path shims that
// `ethers` (`utils/geturl.js`) and `xrpl` rely on for fetch/connection
// helpers in browser builds.
//
// Note: Monero-related WASM (`monero-ts`) was removed on 2026-04-11. The
// XMR keys/seed/address path is now pure JS via `@noble/curves` and
// `@noble/hashes` in `src/wallets/xmr-keys.ts`; chain sync/balance/send
// goes through the native `monero-wallet-rpc.exe` Tauri sidecar. No CJS
// transform shenanigans, no WASM blobs in `public/`.
//
// For the lite build: `tiny-secp256k1` / `bitcoinjs-lib` / `ethers` / `xrpl`
// are still listed in package.json but the lite bundle never imports them
// (Vite tree-shakes via the `src-lite/` entry point). The wasm/topLevelAwait
// plugins stay loaded — harmless, since they only fire when something
// imports a wasm module.
// ---------------------------------------------------------------------------

export default defineConfig(async () => ({
  plugins: [
    react(),
    nodePolyfills({
      include: ["http", "https", "fs", "stream", "util", "path"],
    }),
    wasm(),
    topLevelAwait(),
  ],
  publicDir: "public",
  clearScreen: false,
  // Lite builds use `index-lite.html` at the repo root as their entry; the
  // full wallet keeps `index.html`. `build.rollupOptions.input` could also
  // do this, but switching the root keeps the dev server entry URL the
  // same (just point `tauri dev` at the same port).
  build: entryHtml
    ? {
        rollupOptions: {
          input: entryHtml,
        },
      }
    : undefined,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
