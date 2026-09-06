# PwndaWallet — Design Agent Handoff

**Audience:** a design-focused agent (or human designer) rebuilding, updating, or
extending PwndaWallet's UI. Read this file first, top to bottom. It is
self-sufficient on purpose: some agent-instruction files in this repo (CLAUDE.md
and friends) are gitignored and may not exist in your checkout, so every rule you
must inherit is restated here.

Written 2026-08-28 from a full code inventory + a live sandbox tour of every panel
in both layouts. The per-surface deep map lives in
`PwndaWalletVault/wiki/synthesis/design-surface-map.md` — this file orients; that
file specifies.

---

## 1 · What you are designing

PwndaWallet is a **Tauri 2 + React 19 + TypeScript** desktop crypto wallet
(Windows-first) with three shipped surfaces from one codebase:

| Surface | What | Window | Root |
|---|---|---|---|
| **Landscape** (default) | Sidebar-rail desktop layout | 1280×720 | `src/features/landscape/LandscapeRoot.tsx` |
| **Portrait** | Phone-shaped column layout | 560×860 | `src/ViewRouter.tsx` |
| **PwndaLite** | Separate mining-only product | — | `src-lite/` (imports `src/features/mining/**` + `src/components/**` only) |

Feature areas: multi-chain **wallet** (~27 chains incl. independent-seed
Monero/Zephyr/Zano), **mining** (CPU+GPU, real miner processes), **swap** (NEAR
Intents aggregation + a peer-to-peer atomic-swap engine — "Pwnda Grove", a bundled
BasicSwap node), **activity**, **settings**, **multi-wallet vault**, and a
portrait-only **auth/onboarding** flow.

**The aesthetic** is a committed terminal/hacktivist language: pure black, one
terminal-green accent `#00ff66`, zero border-radius, JetBrains Mono + Press Start
2P, uppercase tracked eyebrows, CRT scanlines, and a signature
**scramble-decode** text effect. This is brand, not decoration — see § 4.

---

## 2 · How to see the app (non-negotiable mechanics)

The user's personal dev wallet — real seed, real funds history — runs on
`npm run dev` / `npm run tauri dev` at port **1420**. **Never run those, and never
point a browser tool at 1420.**

Your surface is the isolated sandbox:

```bash
npm run dev:claude        # browser-only, port 1421, every backend call mocked
npm run tauri:dev:claude  # full app on 1421 when you need real Rust sidecars
```

- Auth is bypassed (`VITE_SKIP_AUTH`) — the app boots straight to the wallet.
- Backend `invoke` calls return mock data from `src/lib/tauri-mocks.ts`; each one
  logs `[tauri-mock] returning mock data for <cmd>`.
- **Scenarios** come from `VITE_MOCK_STATE` in `.env.claude.local` (gitignored;
  documented in `.env.claude.local.example`): `idle`, `mining_active_24hr`,
  `gpu_mining_active`, `cpu_gpu_mining_active`, `wallet_populated`, `degraded`,
  `utxo_change_stranded`. Env is read at **server start** — switching scenario
  means restarting the dev server.
- All scenarios are usable. (`wallet_populated` used to flood the console with
  ~3k store-writes/sec and starve screenshots — fixed 2026-08-28 by making the
  mock answer "unused" for every address past each chain's index-0, so the UTXO
  gap walk terminates. See `PwndaWalletVault/log.md`.)
- **Landscape in the browser sandbox:** `localStorage.setItem("pwnda-layout",
  "landscape")` then reload, viewport 1280×720. Portrait: `"portrait"`, 560×860.
  (A `getCurrentWindow` TypeError in the console is expected browser-sandbox
  noise — the window-resize side effect has no browser mock.)
- **Sandbox amnesia:** the mocked plugin-store is in-memory, so opt-ins (mining,
  swap node) reset on every reload. Re-click through the wizard; it is two clicks.
- Expected console noise (do not chase): `[tauri-mock] …`, `[claude-sandbox]
  active…`, `[dev-bypass] …`, `WebSocket connection to 'ws://127.0.0.1:…' failed`
  (the swap tracker's event feed — browser sandbox always falls back to polling),
  `[refreshBalance] failed`, CORS failures on public coin-stats endpoints
  (whattomine, ravencoin.network, localmonero). Anything else red is yours.
- **Screenshots** go to `screenshots/` (gitignored), named
  `<panel>-<change-id>-<n>.png`. A full current-state tour from 2026-08-28 sits in
  `screenshots/design-handoff/` for before/after comparison.

**The primitives playground** is the catalog: every primitive in every state, a
token/theme/motion inspector, and "compositions" that render real views against a
MockProvider.

```bash
npm run dev:catalog -- --port 1421 --strictPort   # NOT the bare script — it defaults to 1420
```

Stop `dev:claude` first (one 1421 at a time). `?theme=amber|green|cyan|red` and
`?pulse=700&hover=240` override tokens live; `npm run snapshot:catalog` snapshots
the whole catalog for before/after diffs. (`DESIGN.md`'s port table predates the
sandbox rule — where they disagree, this section wins for agents.)

---

## 3 · Where design truth lives (read in this order)

1. **`DESIGN.md`** (repo root) — design-system architecture, scaffolding scripts
   (`npm run new-primitive`, `new-token`, `gen-tokens`, `check-tokens`,
   `legacy-css-usage`), boundary rules for the design layer.
2. **`src/design/BEHAVIORS.md`** — the behavior contract. Every motion is tiered
   **signature / structural / decorative**; signature behaviors (scramble decode,
   hover-scramble, chromatic wordmark, CRT scanlines, blink cursor) are
   brand-load-bearing and must survive any redesign exactly.
3. **`src/design/tokens.ts`** — single source of truth for every color, type,
   space, and motion token. Generated outputs (`styles/tokens.css`, `tokens.json`,
   `keyframes.css`) are **never hand-edited**; run `npm run gen-tokens`.
4. **`src/design/primitives/*.md`** — per-primitive contracts (Btn, Card, KvRow,
   MiniSpark, ProgressBar, Dot, ST, …), co-located with the code.
5. **`PwndaWalletVault/wiki/concepts/design-system.md`** — aesthetic principles,
   voice & copy ("commands, not suggestions", blunt errors, no emoji).
6. **`PwndaWalletVault/wiki/synthesis/design-surface-map.md`** — the per-surface
   map: render order, every button label, states + how to reproduce them, backend
   touchpoints, parity gaps, and the numbered findings register (F1–F14).
7. **`PwndaWalletVault/wiki/synthesis/surfaces-matrix.md`** — which of the three
   products each shared block reaches (blast radius before you edit).
8. **`UX_REVIEW.md`** — the persona-driven audit protocol, if the user asks for a
   "UX review" (a different exercise from design work; don't self-trigger it).

New-surface documentation shape:
`PwndaWalletVault/wiki/concepts/design-surface-template.md`.

---

## 4 · Design review — where the system is strong and where it is weak

An honest evaluation from reading the design layer end-to-end and touring every
panel live (2026-08-28).

**Strengths — build on these, don't fight them:**

- **Token discipline is real.** One typed source (`tokens.ts`) generates CSS +
  JSON + d.ts + keyframes; `check-tokens` enforces sync; themes swap only
  `accent.*`. Retiming every animation project-wide is a one-token edit.
- **The behavior contract is unusual and valuable.** Signature/structural/
  decorative tiering means you can renovate visuals aggressively while knowing
  exactly which five interactions ARE the brand.
- **Primitives are documented where they live** (co-located `.md`s) and have a
  live catalog with per-behavior sliders and real-view compositions.
- **Long-running operations are architected for.** Swap trackers are hoisted
  above both view routers because a 30–90 min atomic swap outlives any tab; the
  re-entry panel (`Peer-to-peer swap in progress`) exists because closing the
  tracker once stranded users. Keep this property in any nav redesign.
- **Honesty affordances are a design value here**: `—` instead of `$0` when data
  is absent, `N of M chain explorers unreachable`, spread verdict sentences,
  "refund is a normal outcome" education, per-stage pool-probe failure copy with
  actual remedies. Treat these as product voice, not filler.
- **The isolation story** (sandbox + mock states + parity tests) makes visual
  iteration safe and repeatable.

**Weaknesses — the real work for a design pass:**

1. **Two primitive generations coexist on live surfaces** (F12). `Btn`/`Card`
   next to raw `.qbtn`/`btn-link`/`mine-*` classes and heavy inline styles;
   `legacy.css` is frozen but still load-bearing (`npm run legacy-css-usage`
   maps it). The system is modularized; the *consumption* is not.
2. **Portrait and landscape are hand-forked, not variant-rendered.** Mining alone
   has ~15 portrait blocks missing from landscape and unit-formatting that
   disagrees on the same screen (F5). Activity has three parallel swap-row
   copies (F9). The surfaces-matrix documents which forks are deliberate;
   everything else is drift.
3. **Dead chrome ships.** Two of six portrait swap router tabs are silent no-ops
   (F2); desk UI mounts but is unreachable (F3); a `qr` button that only copies
   has promised "modal coming in v2.1" since April (F7).
4. **Feature reach differs by layout without signposting**: multi-wallet CRUD,
   the unified portfolio, and the tx detail rail are landscape-only (F10);
   several Settings cards are portrait-only. A user switching layouts loses
   capabilities silently.
5. **Navigation dead-ends**: five sub-views drop the BottomNav entirely (F8),
   and first-use Mine is a two-step wizard detour that ends in Settings.
6. **Copy contradictions survive** (F4: "no fees" wizard vs "~3% dev fee target"
   proxy panel) because user-facing strings are only partially centralized
   (`src/design/copy.ts` exists but is not the single home yet).
7. **Density/space use in landscape is uneven**: swap is a 540px column centered
   in 1280px while wallet/mine use all three columns; the settings toggle uses a
   full-saturation green fill no other active state uses.

The numbered findings (F1–F12) with file anchors are in the surface map § 12.
Fix or consciously accept — don't rediscover.

---

## 5 · Backend in one page (for button placement and state design)

You do not need Rust to design this app. You need to know **what each surface
talks to, how fast it answers, and what can fail** — that dictates spinners,
optimism, and progress affordances. ~127 Tauri commands exist; they cluster:

| Domain | Commands (shape) | Latency / failure profile | Design implication |
|---|---|---|---|
| **Mining control** | `start_xmrig`, `start_gpu_miner`, `stop_*`, `is_mining` | Start takes seconds (process spawn + UAC once/session); GPU first-hashrate 30–90s (DAG) | `Starting...` state exists; DAG-warming hint exists — keep both. Stop is instant. |
| **Mining telemetry** | `get_xmrig_snapshot`, `get_gpu_miner_snapshot` | Polled every 2s, cheap | Charts/counters can be live; portrait throttles repaints to 12s for memory — do not remove (measured ~1600 MB/h leak). |
| **Miner setup** | `check_miners_exist`, `download_miners`, Defender exclusions | Downloads are long, staged (`downloading` → `extracting`) | Determinate + indeterminate progress both needed. |
| **Pool network** | `ping_pools`, `ping_pool` (deep), `fetch_pool_stats` | Internet; fails in categorized stages (dns/tcp/tls/stratum) | Per-stage remedy copy is a feature; pool stats are opt-in (privacy: address leaves the machine). |
| **Chain balances/prices** | TS adapters + public RPCs (no invoke) | Rate-limited, flaky; cached (`balance-cache`, `tx-cache.json`) | Always render stale-with-timestamp over blank; `—` not `$0`; per-chain error isolation. |
| **XMR/ZPH/ZANO sidecars** | `xmr_*`, `zph_*`, `zano_*` (start/stop RPC, `*_rpc_call`, node probes) | Local wallet-RPC process; sync takes minutes–hours | Sync cards with progress + "history after sync" states; Send disabled until synced (Monero). |
| **Swap — NEAR Intents route** | `swap_get_quote`, `swap_sign_*`, `swap_broadcast`, `swap_track` | Quote ~1s (500ms debounce, 30s auto-refresh); settle minutes | Quote card + confirm modal + tracked history. |
| **Swap — P2P / Grove** | `swap_sidecar_*` (~30) wrapping a local BasicSwap node's HTTP API + a WebSocket doorbell | Engine is a local process the user opts into; book reads ~instant when synced; **swaps run 30–90 min**; refunds are NORMAL outcomes | The whole taker journey (offer book → spread gate → confirm → tracker) is specified in map § 6. Tracker must survive navigation and app restarts. Engine's own balances ≠ user wallet balances — never blur that line. |
| **Swap — desk** | `desk_*` | Retired route | Archival UI only (map § 7). Don't design new desk surfaces. |
| **Vault** | No invoke — AES-GCM in the frontend (`src/crypto.ts`) | Unlock does PBKDF2 (600k iters) — a real pause | `Decrypting vault...` state is honest; keep it. |

**Pwnda Grove**, precisely: PWNDA's pinned-and-patched distribution of the
BasicSwap engine, run as a local sidecar ("swap node"). The UI never calls it
"Grove" — user-facing copy says "swap node" / "peer-to-peer". Identity and
patch-stamp story: `PwndaWalletVault/wiki/synthesis/pwnda-grove.md`.

**Addresses:** every chain's receive address is derived in the frontend
(`src/wallets/*`); UTXO chains additionally have an account-wide scanned address
list (`UtxoAccountCard`) with a restore-safety warning — a funds-safety surface,
read `wiki/synthesis/utxo-account-scanning.md` before restyling it. Receive
today = copy only (F7).

---

## 6 · Hard rules you inherit (restated because CLAUDE.md is untracked)

1. **Landscape-first.** Landscape is the primary surface; portrait inherits.
   Never ship a portrait-only feature UI. The BasicSwap taker flow shipped
   portrait-only in Aug 2026: landscape's P2P tab existed, was selectable, and
   led to an empty screen for weeks. `landscapeRouterParity.test.ts` now asserts
   actual component imports — extend it when you add router-reachable features.
   Prefer one shared component mounted by both roots (the
   `BasicswapStrip`/`SidecarConfirmModal`/`DeskConfirmModal` pattern, or a
   `compact` prop) over parallel implementations.
2. **Sandbox only** (§ 2). Port 1421, never 1420, never `npm run dev`.
3. **Visual verification is mandatory for anything visible.** Type-checks pass
   while layouts break. Loop: sandbox → navigate to EVERY affected panel (both
   layouts) → focused screenshots → console check → clean stop. If you cannot
   run a browser, say "tsc clean, did not visually verify" — never a silent
   "done". Real precedent: an optional prop typechecked, 1049 tests passed, and
   the button simply wasn't in the DOM; only the visual pass caught it.
4. **Module boundaries.** `BOUNDARIES.md` + `npm run check-boundaries` before
   done. The design layer imports nothing from features/store/state; mining must
   stay wallet-free (PwndaLite links it). Cross-feature imports only via the
   target's `index.ts`.
5. **Files needing explicit permission to touch:** `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `vite.config.ts`,
   `BOUNDARIES.md`+`scripts/check-boundaries.mjs`, `src/lib/tauri.ts`,
   `src/store.ts` schema, `src/crypto.ts`, `src-tauri/tauri.claude.conf.json`.
   Also: never hand-edit generated token CSS (`gen-tokens` regenerates).
6. **Behavior tiers.** Signature behaviors replicate exactly; structural ones may
   be swapped for equivalent feedback; decorative ones are yours. When in doubt,
   `src/design/BEHAVIORS.md` is the contract.
7. **Voice.** Commands not suggestions (`START MINING`), blunt errors, uppercase
   tracked eyebrows, tabular numerals on every figure, **no emoji anywhere**
   (status = 6×6 squares), no rounded corners, no gradients/imagery beyond the
   ASCII logo, brackets only in the wordmark.
8. **Wiki maintenance.** Any change to a documented surface updates its wiki
   pages (design-surface-map entry included) + `PwndaWalletVault/index.md` +
   a dated `log.md` entry. Bugs you hit get a log entry with symptom (verbatim),
   root cause, **how it was detected**, fix, verification.
9. **Git authorship.** Commits carry ONLY the user's identity
   (`user <pwndamining@gmail.com>`). **No `Co-Authored-By: Claude`, no agent
   attribution, ever.**
10. **Money-moving boundaries.** Design/UI work never arms funded swap drives or
    broadcasts transactions. Fund-adjacent surfaces (`UtxoAccountCard`'s
    ConsolidatePanel signs and broadcasts; SendModal; swap confirms) get extra
    review care — a "one-line style edit" there reaches three products
    (surfaces-matrix).

---

## 7 · The design-change workflow (checklist)

1. **Scope:** read the surface's entry in the map; open `surfaces-matrix.md` for
   every shared block you'll touch; note which of F1–F12 you might fix or
   invalidate.
2. **System first:** if the change is expressible as tokens or a primitive
   variant, do it there (`tokens.ts` → `gen-tokens`; `npm run new-primitive` for
   new ones + Showcase + `.md`). Never fork a primitive per-surface — add a
   variant prop (`compact`, `variant="full"` precedents).
3. **Build landscape first**, mount portrait from the same component, then Lite
   if mining/components are involved.
4. **Static gates:** `npm run check-types` · `npm run check-boundaries` ·
   `npm run check-tokens` · `npm run test` (extend
   `landscapeRouterParity.test.ts` if you added a router-reachable feature).
5. **Visual loop** (§ 2): every affected panel, both layouts, focused
   screenshots, console vs allow-list, clean server stop.
6. **Docs:** update the surface-map entry (labels/order/states), surfaces-matrix
   row if a block's reach changed, primitive `.md`s, `index.md` line, `log.md`
   entry. Delete fixed findings from the register.
7. **Ship:** conventional commit, user's authorship only.

---

## 8 · Starting points, ranked (if the user asks "where should design effort go?")

1. **Unify the primitive layer on live surfaces** (F12) — biggest leverage,
   mechanical, low-risk with the visual loop; `legacy-css-usage` gives the
   worklist.
2. **Kill dead chrome** (F2, F3, F7) — trust repair: no tab, button, or promise
   that does nothing.
3. **Landscape/portrait parity sweep** (F5, F9, F10) — decide per gap:
   variant-prop merge, deliberate divergence (document it), or drop.
4. **Receive/QR** (F7) — small, user-visible, already promised in-product.
5. **Navigation dead-ends** (F8) + first-run Mine journey — nav-model polish.
6. **Data-absent consistency** (F6) — one formatting rule, three headers.

Each maps to concrete files via the findings register. F1 (sandbox flood), F13
(Zano unreachable) and F14 (swap-node health timeout) were fixed 2026-08-28 —
the register marks them struck through, with the mechanism kept because all three
are reachability/observability faults whose SHAPE recurs in this codebase.
