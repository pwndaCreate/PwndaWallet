/**
 * Per-command mock catalog for the Claude Code sandbox.
 *
 * Scenario selection comes from `import.meta.env.VITE_MOCK_STATE`:
 *
 *   - `idle` (default) — miners detected on disk, nothing running. Pool
 *     stats absent. 24-hour history empty.
 *   - `mining_projected` — CPU XMR session AND a funded wallet, so the Mine
 *     tab's SIMPLE hero (frame 3a) has both a mined balance and prices to
 *     project it with. Everything `mining_active_24hr` does, plus balances:
 *     that scenario is deliberately unfunded, which means the hero can only
 *     ever render its `—` branch there.
 *   - `mining_active_24hr` — active CPU mining session. Live snapshot
 *     reports ~7.2 kH/s RandomX. A 24-hour persistent history is
 *     synthesized with one drop-to-zero segment (~45 min mid-window) and
 *     one transient spike to ~9 kH/s near the trailing edge. Pool stats
 *     show one online worker.
 *   - `gpu_mining_active` — active GPU mining session (Ergo / Autolykos2
 *     on SRBMiner, ~115 MH/s). `is_gpu_mining` is true and the
 *     `activeSessions` store is seeded with a GPU descriptor, so loading
 *     the sandbox reproduces "returned to the Mining tab after a
 *     mem_guard reload during GPU mining" — the post-reload rehydration
 *     path in `useMiner` (see [[webview2-memory-management]] Round 13).
 *   - `cpu_gpu_mining_active` — CONCURRENT lanes: Zephyr on CPU (~7.3
 *     kH/s) AND Ergo on GPU (~115 MH/s). Both `is_mining` + `is_gpu_mining`
 *     are true and the `activeSessions` store is seeded with BOTH lane
 *     descriptors. Reproduces the 2026-06-13 per-hardware-coin bug (after a
 *     reload the displayed lane must show its real coin AND toggling to the
 *     hidden lane must restore ITS coin — CPU→Zephyr, GPU→Ergo, not the
 *     monero/kawpow defaults) plus per-lane tile gating + the landscape
 *     hardware toggle (see [[mining-session-rehydration]]).
 *   - `wallet_populated` — a funded multi-chain wallet: real balances for
 *     every chain (EVM via the window.fetch shim's eth_getBalance, BTC/LTC
 *     esplora, ERG, ALGO/TRX/HBAR, ADA/XLM/SUI, SOL via sol_rpc_call, XRP
 *     account_info), a populated EVM Activity feed, and ACTIVE XMR/ZPH
 *     (xmr_rpc_is_running true + get_balance). Portfolio ≈ $16.9k. The
 *     scenario for verifying the wallet / activity / privacy surface (see
 *     [[sandbox-demo-mode-improvements]] Fix 1).
 *   - `degraded` — funded like wallet_populated, but prices 503 and the
 *     Ethereum-mainnet RPC errors, so the UI must render its data-absent
 *     affordances on purpose (— not $0, per-chain error isolation). Mining
 *     is active with an unhealthy reject count + null pool stats. The
 *     scenario for verifying error / empty states (Fix 3).
 *   - `swap_sidecar_idle` — funded wallet, BasicSwap sidecar OPTED IN but
 *     the node is STOPPED. The scenario for `SidecarStatusCard`'s stopped
 *     branch and for driving a start from Settings: `swap_sidecar_start`
 *     steps preparing → starting → healthy over ~3 s, and every
 *     `swap_sidecar_api_*` call before it reaches healthy fails with the
 *     backend's own "the swap node is not running".
 *   - `swap_sidecar_active` — funded wallet, node HEALTHY, book populated
 *     (7 resting offers laddered +0.2% / +1.4% / +3.2% / +7.8% / +14.2%
 *     off the sandbox market mid, so the spread gate's green, amber AND
 *     red-block bands are all reachable), plus ONE in-flight swap sitting
 *     mid-protocol at BidState 11 (`XMR_SWAP_NOSCRIPT_COIN_LOCKED`,
 *     "Scriptless coin locked").
 *   - Neither sidecar scenario opts in on your behalf anywhere else: a
 *     scenario other than these two starts `optedIn: false`, which is the
 *     fresh-install contract (nothing downloads, spawns or invokes).
 *
 * The catalog is intentionally narrow — we only synthesize commands the
 * UI actually surfaces. Anything else returns a safe default (false,
 * null, empty array, undefined) so promise chains don't reject and the
 * console-log makes the gap discoverable when a new command is added.
 *
 * ---------------------------------------------------------------------------
 * Coverage matrix (read before writing a UX review story)
 * ---------------------------------------------------------------------------
 *
 *   ✅ MOCKED (returns realistic data)
 *      - Mining lifecycle: is_mining, start/stop_xmrig, get_xmrig_snapshot,
 *        run_xmrig_benchmark, scan_msr_environment, hashrate-fix surface
 *      - Device discovery: get_cpu_info, get_gpu_info, get_cpu_thread_count
 *      - Pool integrations: fetch_pool_stats, ping_pools(_via_proxy),
 *        proxy_refresh, fetch_pool_min_payout
 *      - Miner binaries: check_miners_exist, defender exclusion checks,
 *        download_miners, delete_miners
 *      - Dev-fee accounting + session logs
 *      - Swap proxy auth surface (status, pubkey, enroll, test_connection)
 *      - Swap session: unlock, lock, get_addresses, get_*_address
 *      - Swap quote/build/track + NEAR Intents quote/deposit/status
 *      - Swap signing (returns fake signed blobs — safe in sandbox since
 *        broadcast is also mocked)
 *      - HTTP proxy with URL dispatch:
 *           CoinGecko / CoinPaprika / CryptoCompare → realistic USD prices
 *           Blockscout / Etherscan-family → empty (but valid) tx-list
 *           Anything unmatched → 503 sandbox-no-network (loud, not silent)
 *      - Plugin store (used by the 24h hashrate history persistence)
 *      - Wallet balances for EVERY chain when scenario = wallet_populated /
 *        degraded: via `http_proxy_call` (LTC/DOGE/BCH/DASH via BlockCypher/
 *        Blockchair, RVN via BlockBook/Insight, ADA Koios, XLM Horizon, SUI),
 *        via `sol_rpc_call` (SOL getBalance), and via the `window.fetch` shim
 *        in src/lib/tauri.ts for the direct-fetch chains (EVM eth_getBalance
 *        + per-host chainId, BTC/LTC esplora, ERG, ALGO/TRX/HBAR, XRP
 *        account_info). All gated on walletFunded() — idle / mining
 *        scenarios return 0 / empty.
 *        This line used to claim DOGE/BCH/DASH coverage that did not exist —
 *        true for LTC only until 2026-08-25, when the account-wide-send work
 *        needed it and it was actually built. Checked, not just extended:
 *        grep the URLs below before trusting this claim again.
 *      - EVM Activity (Etherscan-v1 txlist) when wallet_populated.
 *      - XMR/ZPH wallet RPC (xmr_rpc_call/zph_rpc_call: get_balance /
 *        get_address / get_transfers) when wallet_populated / degraded.
 *      - BasicSwap sidecar: ALL SEVEN swap_sidecar_* commands, stateful
 *        (opt_in / start / stop mutate the phase that status reports), plus
 *        an API proxy answering /json/coins, /json/wallets(/<ticker>)
 *        (ticker-keyed OBJECT, the only endpoint with deposit_address),
 *        /json/walletbalances (ARRAY, no deposit_address, ticker NOT
 *        unique — the two are different shapes and the mock keeps them
 *        different), /json/network, /json/notifications,
 *        /json/active, /json/rateslist, /json/offers(/<id>),
 *        /json/sentoffers, /json/bids(/<id>[/states]), /json/sentbids,
 *        /json/rate, /json/rates, /json/validateamount and
 *        /json/offerfeeestimate — payload shapes lifted from the vendored
 *        upstream in `upstream/basicswap/basicswap/js_server.py`.
 *
 *   ⛔ NOT MOCKABLE in browser-only mode (not a gap to file)
 *      - The `swap-sidecar-progress` EVENT. `listen()` registers its handler
 *        through `transformCallback`, which the shim in src/lib/tauri.ts
 *        stubs to `() => 0`, so no Tauri event can ever be delivered in the
 *        browser. `SidecarSetupWizard` therefore falls back to polling
 *        `swap_sidecar_status`, and that fallback is what `dev:sandbox`
 *        verifies; the progress meter itself needs `tauri:dev:sandbox`.
 *      - Writes through the sidecar API (withdraw, offers/new, bids/new,
 *        unlock, …). Rust refuses them server-side; `sidecarApi` mirrors the
 *        refusal so the sandbox is never MORE permissive than production.
 *
 *   ⛔ NOT MOCKED (intentional — flagging stories about these is a false positive)
 *      - XMR/ZPH wallet RPC in idle / mining scenarios: default to "not
 *        running" (the dev-bypass derives no XMR/ZPH seed), so their panels
 *        render the "wallet not loaded" branch — correct, NOT a regression.
 *      - UNMATCHED chain URLs: the window.fetch shim + http_proxy dispatcher
 *        only synthesize URLs `dispatchUrl()` recognizes. An unmatched chain
 *        URL still hits the real network (CORS-fails in browser-only mode).
 *        If a chain shows no balance, add a `dispatchUrl` arm — don't flag a
 *        product bug. Triage: a finding rooted in "an unmatched in-browser
 *        fetch hit CORS" is a sandbox artifact; flag the data-absent UI
 *        affordance (— vs $0), never the fetch failure itself.
 *      - Tier C: with VITE_SANDBOX_NETWORK=real the fetch shim is DISABLED so
 *        the (world-public, zero-risk) BIP39 test seed hits real read-only
 *        RPCs — expect real on-chain values, not these mocks.
 *      - Pre-vault flows: VITE_SKIP_AUTH jumps past Home/Login/Set
 *        Password/Backup/Import on mount, so those views render only when
 *        the bypass is disabled. Flagging issues with them while the
 *        bypass is active means you're reading uninitialized component
 *        state.
 *
 * Add to the matrix above whenever you extend the MOCKS dispatcher.
 */

type MockScenario =
  | "idle"
  | "mining_active_24hr"
  | "mining_projected"
  | "gpu_mining_active"
  | "cpu_gpu_mining_active"
  | "wallet_populated"
  | "degraded"
  | "swap_sidecar_idle"
  | "swap_sidecar_active"
  | "swap_sidecar_stuck"
  | "utxo_change_stranded";


/**
 * Per-chain fixtures for the `utxo_change_stranded` scenario.
 *
 * Generalised 2026-08-25 from an LTC-only fixture so BTC, DOGE, DASH and BCH
 * — which all gained account-wide SENDING the same day — are exercisable in
 * the sandbox too, not just LTC. Same shape on every chain: the DISPLAYED
 * (index-0 receive) address has history but no unspent output; the money
 * sits at change index 20, one past BIP-44's standard gap limit.
 *
 * Every address below was derived from the real adapter code against the
 * standard sandbox test seed (`abandon … about`) — each chain's own
 * `deriveFromMnemonic` / `xUtxoAccounts[0].deriveAddress`, run once via
 * `npx tsx` and the output pasted in. NOT reconstructed from a UI's truncated
 * display: an earlier attempt at the RVN fixture did that (`RDjNvZL1TJ…
 * G4eTC38V` → guessed middle), funded an address that does not exist, and the
 * scan "passed" by finding nothing — a check that cannot fail for the reason
 * it is run. Re-derive with the adapter's own code if these ever need to
 * change; never retype a card's ellipsis.
 *
 * DOGE and DASH additionally carry a `changePrevTxHex`: both are legacy
 * P2PKH, so `sendXFromAccount` needs a full previous transaction for
 * `nonWitnessUtxo`, not just a UTXO stub. Each hex is a real, self-consistent
 * (if never-broadcastable) transaction built with bitcoinjs-lib — one dummy
 * input, one output paying `changeSat` to `change20` — so that
 * `Transaction.fromHex(changePrevTxHex).getId() === changeTxid` and the
 * output's value/script match exactly what a PSBT's `nonWitnessUtxo`
 * validation expects. Regenerate with `bitcoin.Transaction` + `toOutputScript`
 * against that chain's network params if the amount or address ever changes —
 * a hand-edited hex will fail PSBT's own consistency check, which is a much
 * better failure than a silently-wrong signature.
 */
type StrandedFixture = {
  chain: "litecoin" | "bitcoin" | "dogecoin" | "dash" | "bitcoin-cash";
  receive0: string;
  change20: string;
  /** BCH only: the CashAddr form Blockchair keys its response by. */
  change20Bare?: string;
  receive0Bare?: string;
  receiveFundedSat: number;
  changeSat: number;
  changeTxid: string;
  changeVout: number;
  changePrevTxHex?: string;
};

const STRANDED_FIXTURES: StrandedFixture[] = [
  {
    chain: "litecoin",
    receive0: "ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh",
    change20: "ltc1qgyx249uatedf56zgmcczd5fpvl99xwqe4dumjh",
    receiveFundedSat: 432_888_299,
    changeSat: 402_888_049,
    changeTxid: "1f".repeat(32),
    changeVout: 1,
  },
  {
    chain: "bitcoin",
    receive0: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
    change20: "bc1qtwzctyjdc3zstm2qmzsj0eujlf8x3jla2v4zwm",
    receiveFundedSat: 12_500_000,
    changeSat: 8_400_000, // 0.084 BTC
    changeTxid: "2f".repeat(32),
    changeVout: 0,
  },
  {
    chain: "dogecoin",
    receive0: "DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC",
    change20: "DPdd2FBmNzu5t2rhP4uJ8D1fAZYqsQJszT",
    receiveFundedSat: 60_000_000_000, // 600 DOGE
    changeSat: 50_000_000_000, // 500 DOGE
    changeTxid: "123fe31bb56a1089bf4995d4b5242f04507968d96f1c1152a8c4e7d4e17f89e3",
    changeVout: 0,
    // bitcoin.Transaction, dogeNetwork (pubKeyHash 0x1e): one dummy input,
    // one P2PKH output paying 50_000_000_000 to DPdd2FBm…. See the module
    // doc above for how to regenerate this.
    changePrevTxHex:
      "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff00ffffffff0100743ba40b0000001976a914cad75b488db90d27031b0a1d6c62e3e460fa422488ac00000000",
  },
  {
    chain: "dash",
    receive0: "XoJA8qE3N2Y3jMLEtZ3vcN42qseZ8LvFf5",
    change20: "XntcDskr2nTpUwmfBPwtXi5DNnMVNqu983",
    receiveFundedSat: 150_000_000, // 1.5 DASH
    changeSat: 100_000_000, // 1 DASH
    changeTxid: "6bebd027707529e2498d91cbc2f9e268c1dd3b5d3a578dd1a97d2d9c14e949ba",
    changeVout: 0,
    // Same construction as DOGE's, dashNetwork (pubKeyHash 0x4c), 100_000_000
    // to XntcDskr2nT….
    changePrevTxHex:
      "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff00ffffffff0100e1f505000000001976a91485db23d2361d667dd40ade1d7b0ec870b8274b2588ac00000000",
  },
  {
    chain: "bitcoin-cash",
    receive0: "bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6",
    change20: "bitcoincash:qpyvfpdw07t7wwav0ldxyftehl6zp987lsdp2urcgf",
    change20Bare: "qpyvfpdw07t7wwav0ldxyftehl6zp987lsdp2urcgf",
    receive0Bare: "qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6",
    receiveFundedSat: 15_000_000, // 0.15 BCH
    changeSat: 10_000_000, // 0.1 BCH
    changeTxid: "3f".repeat(32),
    changeVout: 0,
  },
];

/** RVN index-0 (m/44'/175'/0'/0/0) of the sandbox test seed — the one
 *  address the keyless RVN mock funds, so the account walk sees exactly one
 *  used address followed by an unused run. */
const rvnFirstAddress = "RDjNvZL1TJQ7R8L23jDutdEioQG4eTC38V";

/**
 * Index-0 receive addresses of the sandbox test seed, per UTXO chain — the
 * ONLY addresses the generic (non-`utxo_change_stranded`) funded mocks report
 * as used. Everything else answers unused, which is what makes the gap walk
 * in `wallets/utxo-account.ts` terminate.
 *
 * **2026-08-28 — why this exists.** Before this, the generic branches
 * answered `funded ? defaultSat : 0` for EVERY address, so
 * `scanUtxoAccount`'s walk never saw the `gapLimit` consecutive unused
 * addresses it stops on. It ran to `walkChain`'s runaway guard instead —
 * `cursor > gapLimit * 25` = 1000 addresses per chain, ~2020 per account —
 * and every one of those landed in the UTXO account registry, then in
 * `App.tsx`'s `txPairs`, then in a `useTxHistory` cache write apiece: ~6,081
 * `plugin:store|set` calls per sweep, which starved the renderer and made
 * screenshots time out. Full write-up in `PwndaWalletVault/log.md`
 * (2026-08-28); it was F1 in `design-surface-map.md`.
 *
 * This is the same shape `rvnFirstAddress` above already used — one used
 * address followed by an unused run — generalised to the five UTXO chains.
 * A real chain answers this way, so the mock now does too.
 *
 * Values are DERIVED, not guessed: they equal `deriveUtxoAddresses(testSeed,
 * spec, 0, 0, 1)` for each chain's FIRST `utxoAccounts` spec, and are the
 * same strings `STRANDED_FIXTURES[].receive0` carries (that fixture set is
 * built from the same seed). Only the primary spec is funded — BTC's and
 * LTC's secondary legacy accounts stay empty on purpose, so the legacy
 * derivation panels keep rendering their "nothing here" branch. If a chain's
 * default derivation ever changes, re-derive rather than hand-editing.
 */
const FUNDED_ACCOUNT_ADDRESSES: ReadonlySet<string> = new Set([
  "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", // bitcoin, BIP-84 m/84'/0'/0'/0/0
  "ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh", // litecoin, BIP-84 m/84'/2'/0'/0/0
  "DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC", // dogecoin, BIP-44 m/44'/3'/0'/0/0
  "XoJA8qE3N2Y3jMLEtZ3vcN42qseZ8LvFf5", // dash, BIP-44 m/44'/5'/0'/0/0
  "bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6", // bitcoin-cash, BIP-44
  "qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6", // …and its bare CashAddr form
]);

/**
 * Does the generic funded mock consider `address` to hold coins?
 *
 * Answers for the ACCOUNT-SCAN question only. `utxo_change_stranded` has its
 * own per-address answers (`strandedRoleFor`) and is checked before this by
 * every caller — this helper is the fallback for every other scenario.
 */
function isFundedAccountAddress(address: string): boolean {
  return FUNDED_ACCOUNT_ADDRESSES.has(address);
}

/**
 * Which fixture (if any) does `address` belong to, and as which role?
 * `null` outside the scenario or for any address the fixture set doesn't
 * cover, so every other mock path is untouched.
 */
function strandedRoleFor(
  address: string,
): { fixture: StrandedFixture; role: "receive0" | "change20" } | null {
  if (scenario() !== "utxo_change_stranded") return null;
  for (const fixture of STRANDED_FIXTURES) {
    if (address === fixture.receive0 || address === fixture.receive0Bare) {
      return { fixture, role: "receive0" };
    }
    if (address === fixture.change20 || address === fixture.change20Bare) {
      return { fixture, role: "change20" };
    }
  }
  return null;
}

/** Esplora-shaped (`chain_stats`/`mempool_stats`) address stats. BTC and LTC
 *  share this shape — both go through the same blockstream/mempool.space/
 *  litecoinspace branch below. */
function strandedEsploraStats(address: string):
  | {
      chain_stats: { funded_txo_count: number; funded_txo_sum: number; spent_txo_count: number; spent_txo_sum: number; tx_count: number };
      mempool_stats: { funded_txo_count: number; funded_txo_sum: number; spent_txo_count: number; spent_txo_sum: number; tx_count: number };
    }
  | null {
  const hit = strandedRoleFor(address);
  if (!hit) return null;
  const empty = { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 };
  if (hit.role === "receive0") {
    // Funded then fully spent: balance 0 but tx_count 2. An account walk that
    // keyed on BALANCE rather than history would stop here and never look at
    // the change chain at all.
    return {
      chain_stats: { funded_txo_count: 1, funded_txo_sum: hit.fixture.receiveFundedSat, spent_txo_count: 1, spent_txo_sum: hit.fixture.receiveFundedSat, tx_count: 2 },
      mempool_stats: { ...empty },
    };
  }
  return {
    chain_stats: { funded_txo_count: 1, funded_txo_sum: hit.fixture.changeSat, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 1 },
    mempool_stats: { ...empty },
  };
}

/**
 * The same fixtures' UTXO SETS, so the spend path is exercisable and not just
 * the balance display.
 *
 * Added 2026-08-25 (LTC only, that day); generalised the same day once
 * BTC/DOGE/DASH/BCH gained account-wide sending. Until the UTXO half existed,
 * the fixture mocked address *stats* only, so the sandbox rendered the split
 * balance correctly and then reported "the account holds 0.00000000 …across 0
 * spendable output(s)" the moment anything tried to spend it — a fixture that
 * can show the incident but not reproduce its consequence cannot verify the
 * fix for it.
 */
function strandedEsploraUtxos(
  address: string,
): Array<{ txid: string; vout: number; value: number }> | null {
  const hit = strandedRoleFor(address);
  if (!hit) return null;
  if (hit.role === "change20") {
    return [{ txid: hit.fixture.changeTxid, vout: hit.fixture.changeVout, value: hit.fixture.changeSat }];
  }
  // receive0: has history but no unspent output, which is exactly why a
  // single-address signer keyed on it finds nothing to spend.
  return [];
}


/** Per-swap call counter driving the desk_status state advance. */
const deskStatusCalls = new Map<string, number>();

function scenario(): MockScenario {
  const raw =
    typeof import.meta !== "undefined"
      ? import.meta.env?.VITE_MOCK_STATE
      : undefined;
  if (raw === "mining_active_24hr") return "mining_active_24hr";
  if (raw === "mining_projected") return "mining_projected";
  if (raw === "gpu_mining_active") return "gpu_mining_active";
  if (raw === "cpu_gpu_mining_active") return "cpu_gpu_mining_active";
  if (raw === "wallet_populated") return "wallet_populated";
  if (raw === "degraded") return "degraded";
  if (raw === "swap_sidecar_idle") return "swap_sidecar_idle";
  if (raw === "swap_sidecar_active") return "swap_sidecar_active";
  if (raw === "swap_sidecar_stuck") return "swap_sidecar_stuck";
  if (raw === "utxo_change_stranded") return "utxo_change_stranded";
  return "idle";
}

// Scenarios that render a funded multi-chain wallet (real balances, tx
// history, active XMR/ZPH). `degraded` is funded too — its whole point is to
// show how a *funded* wallet degrades when prices / RPCs fail, so the
// data-absent affordances ($0-vs-— etc.) can be verified deterministically.
// The two `swap_sidecar_*` scenarios are funded too: a swap surface with zero
// balances cannot exercise amount entry, the per-coin protocol minimum, or the
// insufficient-funds branch — which is most of what there is to verify there.
/**
 * Scenarios where a CPU RandomX session is live.
 *
 * Added 2026-08-28 with `mining_projected`. A helper rather than another
 * `||` at each of the six check sites, because the previous shape guaranteed
 * that a new mining scenario would light up in some of them and not others —
 * which is how a fixture ends up half-active and the bug it was written to
 * expose stays invisible.
 */
function cpuMiningActive(): boolean {
  const s = scenario();
  return s === "mining_active_24hr" || s === "mining_projected";
}

function walletFunded(): boolean {
  const s = scenario();
  return (
    s === "wallet_populated" ||
    s === "degraded" ||
    s === "swap_sidecar_idle" ||
    s === "swap_sidecar_active" ||
    s === "swap_sidecar_stuck" ||
    // The projected-balance fixture is funded ON PURPOSE: the Mine tab's
    // SIMPLE hero multiplies a MINED XMR BALANCE by a convert rate, so a
    // scenario with mining but no balance (which is what
    // `mining_active_24hr` is) can only ever render the hero's `—` branch.
    s === "mining_projected"
  );
}

/**
 * Deterministic 32-bit string hash (FNV-1a). Seeds the mock's "live" jitter so
 * noise is STABLE across re-renders / HMR reloads — screenshots diff to zero.
 * Replaces the old `Math.random()` / `Date.now()`-seeded jitter (Fix 2).
 * Absolute timestamps stay on the real clock so relative-time UI ("23s ago")
 * and the 24h chart's wall-clock axis remain correct — see
 * [[sandbox-demo-mode-improvements]] Fix 2 (open question #2 resolved: we
 * seed the VALUES, not freeze the CLOCK).
 */
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Device profile variant for cpuInfo()/gpuInfo() — `VITE_MOCK_DEVICE`. */
function deviceVariant(): "default" | "no-gpu" | "low-end" | "multi-gpu" {
  const raw =
    typeof import.meta !== "undefined"
      ? import.meta.env?.VITE_MOCK_DEVICE
      : undefined;
  if (raw === "no-gpu" || raw === "low-end" || raw === "multi-gpu") return raw;
  return "default";
}

// ---------------------------------------------------------------------------
// Synthesized 24-hour hashrate history (Tier-2 store)
// ---------------------------------------------------------------------------

/** Shape of one minute bucket — mirrors `HashrateBucket` in
 *  `src/features/mining/hashrateHistoryStore.ts`. Inlined here to avoid
 *  pulling a feature import into `src/lib`. */
interface HashrateBucket {
  t: number;
  avg: number;
  min: number;
  max: number;
  n: number;
}

const BUCKET_MS = 60_000;
const BUCKETS_24H = 24 * 60;

/**
 * Build a 24-hour series. RandomX-ish baseline ~7.2 kH/s with light
 * noise, plus two scripted features:
 *
 *   - drop-to-zero: a contiguous 45-minute zero segment ~10 hours back
 *     (pool/network blip the user can visually identify)
 *   - spike: a 3-minute climb to ~9 kH/s ~25 min before "now" (e.g. the
 *     user disabling a background CPU hog mid-session)
 */
function build24hSeries(nowMs: number): HashrateBucket[] {
  const start = Math.floor((nowMs - BUCKETS_24H * BUCKET_MS) / BUCKET_MS) * BUCKET_MS;
  const baseline = 7200;
  const noiseAmp = 180;
  const dropStartIdx = BUCKETS_24H - 10 * 60 - 45; // ~10h before now, 45min long
  const dropEndIdx = dropStartIdx + 45;
  const spikeStartIdx = BUCKETS_24H - 25;
  const spikeEndIdx = BUCKETS_24H - 22;

  const out: HashrateBucket[] = [];
  for (let i = 0; i < BUCKETS_24H; i++) {
    const t = start + i * BUCKET_MS;
    if (i >= dropStartIdx && i < dropEndIdx) {
      out.push({ t, avg: 0, min: 0, max: 0, n: 30 });
      continue;
    }
    let avg: number;
    if (i >= spikeStartIdx && i < spikeEndIdx) {
      avg = 9050 + (i - spikeStartIdx) * 30;
    } else {
      // Deterministic pseudo-noise — sine of the index keeps the
      // generated series stable across renders / reloads.
      avg = baseline + Math.round(Math.sin(i * 0.21) * noiseAmp);
    }
    const min = Math.max(0, avg - 120);
    const max = avg + 140;
    out.push({ t, avg, min, max, n: 30 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plugin-store interception (for the persisted 24h history)
// ---------------------------------------------------------------------------
//
// `@tauri-apps/plugin-store` invokes its own commands directly against
// `window.__TAURI_INTERNALS__.invoke`. The `tauri.ts` wrapper installs a
// shim that funnels those calls here. We expose the synthesized 24h
// hashrate history when the store path matches `hashrate-history.dat`.

const STORE_FILE = "hashrate-history.dat";
const STORE_KEY = "history";

// Mining-prefs store (shared by poolPreferenceStore + activeSessionStore).
// The `activeSessions` key drives post-reload rehydration of the Mining
// view — see `src/features/mining/activeSessionStore.ts` and
// [[webview2-memory-management]] Round 13. In `gpu_mining_active` we seed
// a live GPU/Ergo descriptor so loading the sandbox reproduces "returned
// to the Mining tab after a mem_guard reload during GPU mining."
const PREFS_FILE = "mining-prefs.dat";
const ACTIVE_SESSIONS_KEY = "activeSessions";

// Resource-id → mock store-path map for the plugin-store handshake.
const storeRids = new Map<number, string>();
let nextRid = 1000;

// Stateful in-memory backing for the mocked plugin-store: `set` persists here
// and `get`/`has`/`keys`/… read from it, so an encrypted vault written in the
// sandbox (e.g. the dev-bypass seeding a v3 vault) round-trips through real
// WebCrypto. Keys never written fall through to the hardcoded scenario reads
// below, preserving existing read-only scenario behaviour.
const memStore = new Map<string, Map<string, unknown>>();
function memFor(path: string): Map<string, unknown> {
  let m = memStore.get(path);
  if (!m) {
    m = new Map();
    memStore.set(path, m);
  }
  return m;
}

function pluginStore(cmd: string, args: any): unknown {
  // Tauri 2 plugin-store commands (subject to package internals; the
  // ones we care about are `load`, `get`, `set`, `save`, `entries`,
  // `keys`). Anything we don't recognise returns null so the consumer
  // treats the entry as missing — `loadHistory` falls back to empty.
  switch (cmd) {
    case "plugin:store|load":
    case "plugin:store|create_store": {
      const path: string = (args && (args.path ?? args.file)) ?? "";
      const rid = nextRid++;
      storeRids.set(rid, path);
      return rid;
    }
    case "plugin:store|get":
    case "plugin:store|get_value":
    case "plugin:store|entry": {
      // @tauri-apps/plugin-store v2 destructures the result as
      // `[value, exists]`. Returning anything that isn't iterable
      // (e.g. `null`) crashes the call site with "is not iterable".
      const rid: number = args?.rid;
      const key: string = args?.key;
      const path = storeRids.get(rid) ?? "";
      // Stateful reads first: anything `set` in this session wins over the
      // hardcoded scenario reads (this is how the seeded vault round-trips).
      const mem = memStore.get(path);
      if (mem && mem.has(key)) return [mem.get(key), true];
      // Swap-sidecar opt-in (2026-08-19, found by the P4 Playwright pass).
      // The sidecar scenarios were unreachable without this: the mock
      // answered `swap_sidecar_opt_in_status`, but the UI does NOT read
      // opt-in over invoke — it reads the PLAINTEXT `wallet.dat` key, so it
      // can be consulted before the vault is unlocked (same rationale and
      // shape as `miningOptIn.ts`). With the key unmocked the UI correctly
      // concluded "not enabled" and gated the whole feature off, so
      // `swap_sidecar_active` could never exercise the surface it exists for.
      // Seed the key for the sidecar scenarios so the opted-in path renders.
      if (path.endsWith("wallet.dat") && key === "pwnda.swapSidecarOptedInAt") {
        const s = scenario();
        if (
          s === "swap_sidecar_active" ||
          s === "swap_sidecar_stuck" ||
          s === "swap_sidecar_idle"
        ) {
          return [Date.now() - 3 * 86_400_000, true];
        }
        return [undefined, false];
      }
      if (path.endsWith(STORE_FILE) && key === STORE_KEY) {
        if (cpuMiningActive()) {
          // Match `HashrateHistoryFile` shape. Only the
          // monero/randomx series is populated — that's the one the
          // sandbox lands on at boot. Other (chain, algo) pairs render
          // an empty 24h chart, which is fine.
          return [
            {
              version: 1,
              series: {
                "monero/randomx": build24hSeries(Date.now()),
              },
            },
            true,
          ];
        }
        return [null, false];
      }
      if (path.endsWith(PREFS_FILE) && key === ACTIVE_SESSIONS_KEY) {
        const gpuDesc = {
          hardware: "gpu",
          coin: "ergo",
          gpuAlgorithm: "autolykos",
          miner: "SRBMiner-MULTI",
          poolId: "woolypooly-ergo",
        };
        const cpuDesc = {
          hardware: "cpu",
          coin: "zephyr",
          cpuAlgorithm: "randomx",
          poolId: "herominers-zephyr",
        };
        if (scenario() === "gpu_mining_active") {
          // Mirrors the descriptor `startMining`'s GPU branch persists.
          return [{ gpu: gpuDesc }, true];
        }
        if (scenario() === "cpu_gpu_mining_active") {
          // Faithful repro of the reported bug: Zephyr on CPU + Ergo on GPU
          // concurrently. Post-reload the displayed lane (GPU) must show
          // Ergo AND toggling to CPU must show Zephyr (not the Monero
          // default) — BUG 1's per-hardware coin restore.
          return [{ cpu: cpuDesc, gpu: gpuDesc }, true];
        }
        return [null, false];
      }
      return [null, false];
    }
    case "plugin:store|set": {
      const path = storeRids.get(args?.rid) ?? "";
      memFor(path).set(args?.key, args?.value);
      return null;
    }
    case "plugin:store|delete": {
      const path = storeRids.get(args?.rid) ?? "";
      memStore.get(path)?.delete(args?.key);
      return null;
    }
    case "plugin:store|clear": {
      const path = storeRids.get(args?.rid) ?? "";
      memStore.get(path)?.clear();
      return null;
    }
    case "plugin:store|save":
      return null; // already in-memory; nothing to flush
    case "plugin:store|has": {
      const path = storeRids.get(args?.rid) ?? "";
      return memStore.get(path)?.has(args?.key) ?? false;
    }
    case "plugin:store|keys": {
      const path = storeRids.get(args?.rid) ?? "";
      return [...(memStore.get(path)?.keys() ?? [])];
    }
    case "plugin:store|values": {
      const path = storeRids.get(args?.rid) ?? "";
      return [...(memStore.get(path)?.values() ?? [])];
    }
    case "plugin:store|entries": {
      const path = storeRids.get(args?.rid) ?? "";
      return [...(memStore.get(path)?.entries() ?? [])];
    }
    case "plugin:store|length": {
      const path = storeRids.get(args?.rid) ?? "";
      return memStore.get(path)?.size ?? 0;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Mining-specific mocks
// ---------------------------------------------------------------------------

function minerStatuses(): Array<{ name: string; exists: boolean; path: string }> {
  // Every binary "exists" so the Mining panel renders past the
  // "Download miners" gate. The path strings are cosmetic.
  const sandboxBase =
    "C:\\Users\\sandbox\\AppData\\Local\\com.pwnda.wallet.sandbox-dev\\miners";
  return [
    { name: "xmrig", exists: true, path: `${sandboxBase}\\xmrig.exe` },
    { name: "SRBMiner-MULTI", exists: true, path: `${sandboxBase}\\SRBMiner-MULTI.exe` },
    { name: "lolMiner", exists: true, path: `${sandboxBase}\\lolMiner.exe` },
  ];
}

function cpuInfo() {
  // VITE_MOCK_DEVICE=low-end → a weak 4-core; otherwise the default rig.
  if (deviceVariant() === "low-end")
    return { name: "Intel Core i3-10100 4-Core Processor", threads: 8, physical_cores: 4, max_mhz: 4300 };
  return {
    name: "AMD Ryzen 9 7950X 16-Core Processor",
    threads: 32,
    physical_cores: 16,
    max_mhz: 5700,
  };
}

function gpuInfo() {
  // VITE_MOCK_DEVICE: no-gpu → [] (CPU-only branch), low-end → integrated,
  // multi-gpu → three cards; default → one RTX 4080.
  const v = deviceVariant();
  if (v === "no-gpu") return [];
  if (v === "low-end")
    return [{ name: "Intel UHD Graphics 630", vendor: "Intel", vram_bytes: 0, driver_version: "31.0.101" }];
  if (v === "multi-gpu")
    return [
      { name: "NVIDIA GeForce RTX 4080", vendor: "NVIDIA", vram_bytes: 16 * 1024 ** 3, driver_version: "552.22" },
      { name: "NVIDIA GeForce RTX 3090", vendor: "NVIDIA", vram_bytes: 24 * 1024 ** 3, driver_version: "552.22" },
      { name: "AMD Radeon RX 6800", vendor: "AMD", vram_bytes: 16 * 1024 ** 3, driver_version: "24.5.1" },
    ];
  return [
    {
      name: "NVIDIA GeForce RTX 4080",
      vendor: "NVIDIA",
      vram_bytes: 16 * 1024 ** 3,
      driver_version: "552.22",
    },
  ];
}

function hashrateFixPlan() {
  return {
    blocklistOff: true,
    sacOff: true,
    hvciOff: true,
    secureBootOff: false,
    seLockMemoryGranted: true,
    winring0Collision: null,
    collisionApps: [],
    numaNodeCount: 1,
    smtEnabled: true,
    physicalCoreCount: 16,
    logicalCoreCount: 32,
    scannedAt: Date.now(),
  };
}

function xmrigSnapshot() {
  const s = scenario();
  if (
    !cpuMiningActive() &&
    s !== "cpu_gpu_mining_active" &&
    s !== "degraded"
  )
    return null;
  // Active session: ~7.3 kH/s. Jitter is seeded (stable across reloads), not
  // time-based — so the hero hashrate doesn't bounce between screenshots.
  const jitter = (hashStr("xmrig-jitter") % 80) - 40; // fixed -40..+39
  // `degraded` surfaces an unhealthy reject count for the SESSION-card health UI.
  const rejected = s === "degraded" ? 47 : 2;
  return {
    hashrate: 7300 + jitter,
    accepted: 184,
    rejected,
    diff_current: 120000,
    ping_ms: 28,
    uptime_secs: 46 * 60 + 4,
    // Real resolved thread count (mirrors XmrigSnapshot::threads_active) —
    // 16 is a plausible "Medium" (--cpu-max-threads-hint=50) outcome, so the
    // sandbox can exercise MiningView's real-count display branch.
    threads_active: 16,
  };
}

function gpuSnapshot() {
  if (
    scenario() !== "gpu_mining_active" &&
    scenario() !== "cpu_gpu_mining_active"
  )
    return null;
  // Active Ergo / Autolykos2 session ~115 MH/s, ~46 min uptime. GPU
  // miners don't expose stratum ping, so `ping_ms` is null (the view
  // falls back to the pre-mine TCP probe latency). Seeded jitter (stable).
  const jitter = ((hashStr("gpu-jitter") % 200) - 100) * 15_000; // fixed
  return {
    hashrate: 115_000_000 + jitter,
    accepted: 142,
    rejected: 1,
    diff_current: 2_400_000,
    ping_ms: null,
    uptime_secs: 46 * 60 + 4,
  };
}

function minerStats() {
  if (!cpuMiningActive()) {
    // Pool returns "no records for this address" pre-mining. Match
    // what the adapters return for unknown miners.
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  return {
    pendingBalance: "0.00231",
    immatureBalance: "0.00098",
    totalPaid: "0.04419",
    payoutThreshold: "0.005",
    hashrate: 7240,
    hashrate1h: 7180,
    hashrate6h: 7090,
    hashrate24h: 6985,
    validShares: 184,
    invalidShares: 2,
    staleShares: 1,
    lastShare: now - 23,
    workersOnline: 1,
    fetchedAt: now,
  };
}

function pingResults(reqs: any): unknown {
  const list = Array.isArray(reqs) ? reqs : [];
  return list.map((r: any) => ({
    poolId: r?.poolId ?? "unknown",
    ok: true,
    // Seeded per-pool latency (stable across reloads) — was Math.random().
    latencyMs: 30 + (hashStr(String(r?.poolId ?? "unknown")) % 25),
    stage: "ok",
  }));
}

// ---------------------------------------------------------------------------
// http_proxy_call URL dispatcher
// ---------------------------------------------------------------------------
//
// `wallets/_proxy.ts` routes every chain-data fetch through this command.
// The plain-503 fallback the previous version returned made *every* chain
// adapter look broken in the sandbox (and the cascading "no USD prices"
// caused UXS-102, UXS-117, half of UXS-101 in the 2026-05-16 review).
// Dispatch by URL pattern to a synthesized JSON body so the wallet
// dashboard renders something realistic. Anything we don't recognise
// still 503s loudly so a missing pattern is discoverable.

const SANDBOX_PRICES_USD: Record<string, number> = {
  BTC: 95_400,
  ETH: 3_480,
  XMR: 162.3,
  SOL: 212,
  ADA: 0.94,
  BCH: 442,
  LTC: 117,
  XRP: 2.14,
  DOGE: 0.382,
  TRX: 0.224,
  AVAX: 38.6,
  POL: 0.452,
  MATIC: 0.452,
  USDT: 1.0,
  USDC: 1.0,
  ALGO: 0.418,
  HBAR: 0.281,
  FLR: 0.0249,
  RVN: 0.0217,
  CFX: 0.183,
  ERG: 1.21,
  ZEPH: 1.51,
  RUNE: 4.18,
  NEAR: 5.42,
  DASH: 22.4,
};

// CoinGecko id → ticker (inverse of TICKER_TO_COINGECKO_ID; inlined to
// avoid importing the wallets layer into src/lib).
const COINGECKO_ID_TO_TICKER: Record<string, string> = {
  monero: "XMR",
  ethereum: "ETH",
  bitcoin: "BTC",
  solana: "SOL",
  cardano: "ADA",
  ravencoin: "RVN",
  "conflux-token": "CFX",
  dogecoin: "DOGE",
  "zephyr-protocol": "ZEPH",
  "avalanche-2": "AVAX",
  "polygon-ecosystem-token": "POL",
  "flare-networks": "FLR",
  ripple: "XRP",
  tron: "TRX",
  "hedera-hashgraph": "HBAR",
  algorand: "ALGO",
  tether: "USDT",
  litecoin: "LTC",
  "bitcoin-cash": "BCH",
  ergo: "ERG",
  dash: "DASH",
};

const COINPAPRIKA_ID_TO_TICKER: Record<string, string> = {
  "xmr-monero": "XMR",
  "eth-ethereum": "ETH",
  "btc-bitcoin": "BTC",
  "sol-solana": "SOL",
  "ada-cardano": "ADA",
  "rvn-ravencoin": "RVN",
  "cfx-conflux-network": "CFX",
  "doge-dogecoin": "DOGE",
  "avax-avalanche": "AVAX",
  "pol-polygon-ecosystem-token": "POL",
  "flr-flare-network": "FLR",      // synced 2026-06-17 with TICKER_TO_COINPAPRIKA_ID
  "xrp-xrp": "XRP",
  "trx-tron": "TRX",
  "hbar-hedera-hashgraph": "HBAR", // synced 2026-06-17 (was "hbar-hedera")
  "algo-algorand": "ALGO",
  "usdt-tether": "USDT",
  "ltc-litecoin": "LTC",
  "bch-bitcoin-cash": "BCH",
  "efyt-ergo": "ERG",              // synced 2026-06-17 (was "erg-ergo")
  "dash-dash": "DASH",
  // ZEPH intentionally absent — CoinPaprika does not list Zephyr Protocol,
  // mirroring the real TICKER_TO_COINPAPRIKA_ID map.
};

function priceFor(ticker: string): number {
  const px = SANDBOX_PRICES_USD[ticker.toUpperCase()];
  // Small deterministic jitter so successive refreshes look "live" but
  // the dashboard doesn't flicker; ±0.4% based on minute-of-hour.
  if (px == null) return 0;
  // Per-ticker seeded jitter (±0.4%, stable across reloads) — was minute-based.
  const jitter = 1 + Math.sin(hashStr(ticker.toUpperCase()) / 9.55) * 0.004;
  return Math.round(px * jitter * 1e6) / 1e6;
}

function synthHistory24h(ticker: string): Array<[number, number]> {
  const base = SANDBOX_PRICES_USD[ticker.toUpperCase()] ?? 0;
  if (base === 0) return [];
  // 24 points, ~1h granularity, ±1.5% wave so sparklines are non-flat.
  const now = Date.now();
  const out: Array<[number, number]> = [];
  for (let i = 23; i >= 0; i--) {
    const t = now - i * 3_600_000;
    const wave = 1 + Math.sin((i / 23) * Math.PI * 1.6 - 0.4) * 0.015;
    out.push([t, Math.round(base * wave * 1e6) / 1e6]);
  }
  return out;
}

function proxy503(reason: string) {
  return {
    status: 503,
    body: JSON.stringify({ error: "sandbox-no-network", reason }),
    headers: [],
  };
}

// ---------------------------------------------------------------------------
// Wallet balances (populated only when walletFunded()) — native atomic units.
// ---------------------------------------------------------------------------
// Chosen to look like a real mid-size multi-chain wallet (~$15k). EVM L2s are
// left empty (realistic — few users hold on every L2). Native chains keyed by
// the same tickers as SANDBOX_PRICES_USD so the portfolio total is sensible.

// EVM native balances (wei) keyed by chainId. bigint → serialized to hex.
/** SPL balances by mint, in the mint's own decimals (both 6). */
const MOCK_SPL_UNITS: Record<string, bigint> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 260_500_000n, // USDC 260.50
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 88_000_000n,  // USDT  88.00
};

/** TRC-20 balances by contract, 6 decimals. */
const MOCK_TRC20_UNITS: Record<string, bigint> = {
  TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: 1_402_250_000n, // USDT 1,402.25
};

const MOCK_TOKEN_UNITS: Record<string, bigint> = {
  // USDC — 6 decimals except BSC (18).
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": 1_250_400_000n,          // ETH  1,250.40
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831": 310_000_000n,            // ARB    310.00
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 88_250_000n,             // BASE    88.25
  "0x0b2c639c533813f4aa9d7837caf62653d097ff85": 0n,                      // OP        0
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": 45_000_000n,             // POL     45.00
  "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e": 0n,                      // AVAX      0
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": 120_000_000_000_000_000_000n, // BSC 120.00 (18dp)
  // USDT
  "0xdac17f958d2ee523a2206206994597c13d831ec7": 640_120_000n,            // ETH    640.12
  "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7": 75_500_000n,             // AVAX    75.50
  "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58": 0n,                      // OP        0
  "0x55d398326f99059ff775485246999027b3197955": 42_000_000_000_000_000_000n,  // BSC  42.00 (18dp)
  // USDT0
  "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": 512_000_000n,            // ARB    512.00
  "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": 96_750_000n,             // POL     96.75
};

const EVM_WEI_BY_CHAINID: Record<number, bigint> = {
  1: 1_250_000_000_000_000_000n, // 1.25 ETH
  43114: 8_000_000_000_000_000_000n, // 8 AVAX
  137: 120_000_000_000_000_000_000n, // 120 POL
  14: 5_000_000_000_000_000_000_000n, // 5000 FLR
  56: 500_000_000_000_000_000n, // 0.5 BNB
  42161: 0n, // Arbitrum — empty
  8453: 0n, // Base — empty
  10: 0n, // Optimism — empty
  143: 0n, // Monad — empty
};

function bigToHex(n: bigint): string {
  return "0x" + n.toString(16);
}

/** Map an RPC/explorer URL to its EVM chainId (substring heuristic). ethers
 *  validates the network via `eth_chainId`, so this must be correct per host. */
function evmChainIdForUrl(url: string): number {
  const u = url.toLowerCase();
  if (u.includes("avax") || u.includes("avalanche")) return 43114;
  if (u.includes("polygon") || u.includes("matic")) return 137;
  if (u.includes("flare") || u.includes("/flr")) return 14;
  if (u.includes("arbitrum") || u.includes("arb")) return 42161;
  if (u.includes("optimism") || u.includes("/op")) return 10;
  if (u.includes("base")) return 8453;
  if (u.includes("bsc") || u.includes("binance")) return 56;
  if (u.includes("monad")) return 143;
  return 1; // ethereum mainnet default
}

/** One Etherscan-v1 tx-history payload (used for EVM Activity when funded). */
function etherscanTxList(): unknown {
  const now = Math.floor(Date.now() / 1000);
  return {
    status: "1",
    message: "OK",
    result: [
      {
        hash: "0x" + "ab".repeat(32),
        from: "0x9858effd232b4033e47d90003d41ec34ecaeda94",
        to: "0x000000000000000000000000000000000000dead",
        value: "120000000000000000",
        gas: "21000",
        gasUsed: "21000",
        gasPrice: "30000000000",
        timeStamp: String(now - 3600),
        blockNumber: "18000001",
        confirmations: "1200",
        isError: "0",
        txreceipt_status: "1",
        input: "0x",
        nonce: "1",
        contractAddress: "",
        functionName: "",
        methodId: "0x",
      },
      {
        hash: "0x" + "cd".repeat(32),
        from: "0x1111111111111111111111111111111111111111",
        to: "0x9858effd232b4033e47d90003d41ec34ecaeda94",
        value: "1370000000000000000",
        gas: "21000",
        gasUsed: "21000",
        gasPrice: "24000000000",
        timeStamp: String(now - 86400 * 3),
        blockNumber: "17980000",
        confirmations: "21000",
        isError: "0",
        txreceipt_status: "1",
        input: "0x",
        nonce: "0",
        contractAddress: "",
        functionName: "",
        methodId: "0x",
      },
    ],
  };
}

/** Esplora address-txs payload (BTC) when funded. */
function esploraTxs(addr: string): unknown[] {
  const now = Math.floor(Date.now() / 1000);
  return [
    {
      txid: "ab".repeat(32),
      version: 2,
      locktime: 0,
      vin: [{ prevout: { scriptpubkey_address: "bc1qsenderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", value: 6_000_000 } }],
      vout: [
        { scriptpubkey_address: addr, value: 5_000_000 },
        { scriptpubkey_address: "bc1qchangexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", value: 990_000 },
      ],
      fee: 10_000,
      status: { confirmed: true, block_height: 850_000, block_time: now - 7200 },
    },
  ];
}

/** Single JSON-RPC request → envelope (handles EVM + Sui). */
/**
 * GraphQL mock — currently Sui only.
 *
 * Shapes mirror what mainnet actually returns (verified 2026-08-14), including
 * the two traps the adapter has to handle: `coinType.repr` comes back fully
 * expanded rather than as `0x2::sui::SUI`, and `timestamp` is ISO-8601 rather
 * than epoch milliseconds. Mocking the tidied-up versions would let a bug that
 * breaks against the real chain pass here.
 *
 * Returns null for an unmatched URL so the caller falls through.
 */
function graphQlOne(
  url: string,
  body: { query: string; variables?: Record<string, unknown> },
  funded: boolean,
  degraded: boolean,
): { status: number; json?: unknown; text?: string } | null {
  if (!url.includes("sui.io") && !url.includes("sui-mainnet")) return null;

  // Sui has no fallback endpoint, so "degraded" means a total outage — the
  // adapter must reject and the UI must show "—", never "0".
  if (degraded) return { status: 503, text: "sandbox-degraded" };

  const q = body.query;
  const addr =
    typeof body.variables?.addr === "string" ? body.variables.addr : "0x0";

  if (q.includes("referenceGasPrice"))
    return { status: 200, json: { data: { epoch: { referenceGasPrice: "100" } } } };

  if (q.includes("balance(coinType"))
    return {
      status: 200,
      json: {
        data: {
          address: { balance: { totalBalance: funded ? "60000000000" : "0" } },
        },
      },
    };

  if (q.includes("transactions(")) {
    const SUI_FULL =
      "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
    const nodes = funded
      ? [
          {
            digest: "9jsBfj6ECyMwBDPVHMt9WPC3MFdbUWhT94KnTPod6Vbz",
            effects: {
              timestamp: "2026-08-01T12:00:00.000Z",
              status: "SUCCESS",
              checkpoint: { sequenceNumber: 310_000_000 },
              balanceChanges: {
                nodes: [
                  { owner: { address: addr }, coinType: { repr: SUI_FULL }, amount: "60000000000" },
                ],
              },
            },
          },
        ]
      : [];
    return {
      status: 200,
      json: {
        data: {
          address: {
            transactions: {
              pageInfo: { hasPreviousPage: false, startCursor: null },
              nodes,
            },
          },
        },
      },
    };
  }

  if (q.includes("chainIdentifier"))
    return {
      status: 200,
      json: { data: { chainIdentifier: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S" } },
    };

  return null;
}

function jsonRpcOne(url: string, req: any, funded: boolean, degraded: boolean): any {
  const id = req?.id ?? 1;
  const method: string = req?.method ?? "";
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });

  // ---- Sui (suix_*/sui_*) — DEAD UPSTREAM, mocked to match reality ----
  // Mysten permanently deactivated JSON-RPC on public fullnodes 2026-07-31.
  // The real endpoint answers HTTP 200 with a -32601 body, so the mock does
  // too: a sandbox that still returned a balance here would hide the exact
  // failure the adapter now has to survive. Live Sui data comes from the
  // GraphQL arm in `graphQlOne`.
  if (method.startsWith("suix_") || method.startsWith("sui_")) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message:
          "Method not found. JSON-RPC on public fullnodes has been deprecated. " +
          "Please migrate to gRPC or GraphQL endpoints.",
      },
    };
  }

  // ---- XRP Ledger (XRPL JSON-RPC: account_info / account_tx / ...) ----
  if (method === "account_info")
    return ok({
      account_data: { Account: req?.params?.[0]?.account ?? "rSandbox", Balance: funded ? "1500000000" : "0", Sequence: 1, OwnerCount: 0 },
      ledger_current_index: 90_000_000,
      validated: true,
      status: "success",
    }); // 1500 XRP (drops)
  if (method === "account_lines") return ok({ account: "rSandbox", lines: [], status: "success" });
  if (method === "account_tx") return ok({ account: "rSandbox", transactions: [], status: "success" });
  if (method === "server_info")
    return ok({ info: { complete_ledgers: "1-90000000", server_state: "full", validated_ledger: { seq: 90_000_000 } }, status: "success" });
  if (method === "fee") return ok({ drops: { base_fee: "10", open_ledger_fee: "10", median_fee: "5000" }, status: "success" });
  if (method === "submit") return ok({ engine_result: "tesSUCCESS", engine_result_code: 0, tx_json: { hash: "ABCDEF" }, status: "success" });

  // Per-contract ERC-20 balances for the funded scenarios, in the token's OWN
  // decimals (verified per contract in `wallets/stablecoins.ts`: BSC is 18,
  // everything else 6). Spread across networks on purpose so the stacked row
  // shows a real multi-network total rather than one populated leg.
  //
  // Keyed by lowercase contract because that is what arrives in `params[0].to`.

  // ---- EVM (eth_/net_/web3_ only — any other JSON-RPC method we don't
  //      recognise returns null so dispatchUrl passes it through). ----
  const isEvm = method.startsWith("eth_") || method.startsWith("net_") || method.startsWith("web3_");
  if (!isEvm) return null;
  const chainId = evmChainIdForUrl(url);
  // degraded: Ethereum mainnet RPC errors (proves per-chain error isolation)
  if (degraded && chainId === 1)
    return { jsonrpc: "2.0", id, error: { code: -32000, message: "sandbox-degraded: upstream unavailable" } };
  switch (method) {
    case "eth_chainId": return ok(bigToHex(BigInt(chainId)));
    case "net_version": return ok(String(chainId));
    case "eth_blockNumber": return ok("0x1126b50");
    case "eth_getBalance": return ok(bigToHex(funded ? (EVM_WEI_BY_CHAINID[chainId] ?? 0n) : 0n));
    case "eth_getTransactionCount": return ok("0x3");
    case "eth_gasPrice": return ok("0x6fc23ac00"); // 30 gwei
    case "eth_maxPriorityFeePerGas": return ok("0x77359400"); // 2 gwei
    case "eth_estimateGas": return ok("0x5208"); // 21000
    case "eth_call": {
      // ERC-20 `balanceOf`. Returned a flat 0 for every token until
      // 2026-09-02, which meant the sandbox could not exercise the stacked
      // stablecoin rows at all — they are hidden when a family holds nothing,
      // so the whole feature rendered as absent rather than as empty.
      // Funded scenarios now answer with a per-contract amount so USDC/USDT/
      // USDT0 have something to stack. Decimals are per contract (BSC is 18).
      const to = String(req?.params?.[0]?.to ?? "").toLowerCase();
      const units = funded ? (MOCK_TOKEN_UNITS[to] ?? 0n) : 0n;
      // ABI-encoded uint256: exactly 32 bytes, zero-padded. NOT `bigToHex`,
      // which yields minimal hex — that is right for `eth_getBalance` (a
      // quantity) and wrong for `eth_call` (returndata). ethers rejects the
      // short form with BAD_DATA / "invalid length for result data", so the
      // stablecoin rows silently showed nothing at all.
      return ok("0x" + units.toString(16).padStart(64, "0"));
    }
    case "eth_feeHistory":
      return ok({ oldestBlock: "0x1126b40", baseFeePerGas: ["0x6fc23ac00", "0x6fc23ac00"], gasUsedRatio: [0.5], reward: [["0x77359400"]] });
    case "eth_getBlockByNumber":
      return ok({ number: "0x1126b50", baseFeePerGas: "0x6fc23ac00", timestamp: bigToHex(BigInt(Math.floor(Date.now() / 1000))), hash: "0x" + "00".repeat(32) });
    case "eth_sendRawTransaction": return ok("0x" + "fe".repeat(32));
    case "eth_getTransactionReceipt": return ok(null);
    case "eth_getCode": return ok("0x");
    default: return ok("0x0");
  }
}

/**
 * Shared URL → response dispatcher. Used by BOTH the `http_proxy_call` invoke
 * mock and the `window.fetch` shim (src/lib/tauri.ts). Returns `{status,
 * json|text}` for a matched chain/explorer URL, or `null` for an unmatched URL
 * (caller 503s on the invoke side, passes through to real fetch on the shim
 * side). Balance arms are gated on `walletFunded()`; `degraded` forces price +
 * one-chain failures so the data-absent affordances can be verified.
 * See [[sandbox-demo-mode-improvements]] Fix 1.
 */
/**
 * A believable BasicSwap order book, shaped like the real feed.
 *
 * Field names and types are copied from a LIVE capture on 2026-08-28, not
 * from our own `BasicSwapOffer` — the publisher emits the SMSG wire shape,
 * and a fixture written from our type would have hidden exactly the
 * differences the adapter exists to absorb (`msg_id` not `offer_id`,
 * `timestamp` not `created_at`, no `expire_at`, `amount_from_str` alongside
 * an integer `amount_from`, `rate` as a float in scientific notation).
 *
 * Timestamps are generated relative to now so offers stay live as the
 * sandbox runs; one entry is deliberately EXPIRED so the liveness filter has
 * something to remove, and one carries a malformed record so the
 * drop-rather-than-default path in `normalizeOffer` is exercised in a browser
 * run and not only in unit tests.
 */
function marketsSnapshotFixture(): unknown {
  const now = Math.floor(Date.now() / 1000);
  const mk = (
    coinFrom: string,
    coinTo: string,
    fromStr: string,
    toStr: string,
    agoSec: number,
    maker: string,
    validSec = 14400,
  ) => ({
    msg_id: `0000000${maker.slice(1, 9)}${agoSec}`,
    timestamp: now - agoSec,
    protocol_version: 5,
    coin_from: coinFrom,
    coin_to: coinTo,
    amount_from_str: fromStr,
    amount_to_str: toStr,
    amount_from: Number(fromStr) * 1e8,
    amount_to: Number(toStr) * 1e8,
    min_bid_amount_str: fromStr,
    swap_type: 5,
    lock_type: 2,
    lock_value: 86400,
    fee_rate_from: 26000,
    fee_rate_to: 3452,
    amount_negotiable: true,
    rate_negotiable: false,
    auto_accept_type: 1,
    time_valid: validSec,
    rate: Number(toStr) / Number(fromStr),
    proof_address: "",
    addr_from: maker,
    bid_count: 0,
    highest_bid: null,
  });
  const offers = [
    mk("BTC", "XMR", "0.0624", "10.457", 960, "PbAiK3mVpQr7sTuvWxYzGBTB"),
    mk("BTC", "XMR", "0.0312", "5.7034", 480, "PY7BmnQvRt2sLkJhGfDcvmyX"),
    mk("XMR", "BTC", "10", "0.061757", 2160, "Ps3zKpLmNqRtVwXyZaBcD85h"),
    mk("BTC", "LTC", "0.0624", "107.73", 1980, "Pep61zsLQhMnBvCxZaSdovoV"),
    mk("LTC", "BTC", "97.9", "0.068603", 2100, "Pm1mE6HAP8kJhGfDsAqWVnTM"),
    mk("LTC", "XMR", "100", "16.667", 3300, "Pdpc9xKvBnMlQwErTyUi2ikc"),
    mk("LTC", "XMR", "56.6", "6.5962", 1500, "PanWq2ZxCvBnMlKjHgFdpcED"),
    mk("BTC", "DOGE", "0.0624", "62568.48", 2880, "PiPmL9kJhGfDsAqWzXcVBY5t"),
    mk("DOGE", "LTC", "62534.78", "98", 2400, "PpUwR4tYuIoPaSdFgHjKCyEW"),
    mk("XMR", "BCH", "1.5", "2.856", 1140, "Ps9GtYuIoPaSdFgHjKlZJism"),
    mk("LTC", "WOW", "150", "3177045.01", 10800, "PtwbN2mVcXzAsDfGhJkLNWGW"),
    // Already past its validity window — the liveness filter must drop it, and
    // the rendered count must therefore be 11, not 12.
    mk("BTC", "LTC", "0.5", "860", 20000, "PdeadOfferMustNotBeCounted", 3600),
    // Malformed on purpose: no amount strings, so `normalizeOffer` returns
    // null. A preview that rendered this as a blank row would be stating a
    // falsehood about the market.
    {
      msg_id: "malformed-record",
      timestamp: now - 300,
      coin_from: "BTC",
      coin_to: "LTC",
      time_valid: 14400,
      addr_from: "PmalformedXXXXXXXXXXXXXX",
    },
  ];
  return {
    timestamp: now - 300,
    updated_at: new Date((now - 300) * 1000).toISOString(),
    // Deliberately DISAGREES with what our own liveness rule yields, because
    // the real publisher disagrees with itself the same way (measured: their
    // active_offers 93 vs 85 computed from the records). The UI must render
    // OUR count, so a fixture that agreed would let a regression through.
    num_offers: offers.length,
    active_offers: 99,
    unique_makers: 132,
    unique_pairs: 15,
    stats: { revokes_seen: 3, revokes_matched_offer: 0, revoked_offers_dropped: 0 },
    offers,
  };
}
function dispatchUrl(
  url: string,
  method: string,
  body: any,
): { status: number; json?: unknown; text?: string } | null {
  if (!url) return null;
  const funded = walletFunded();
  const degraded = scenario() === "degraded";

  // ---- JSON-RPC POST (EVM batch-or-single, Sui, XRP). jsonRpcOne returns
  //      null for methods we don't mock → fall through to real passthrough. ----
  if (Array.isArray(body) && body.length > 0 && (body[0]?.jsonrpc || typeof body[0]?.method === "string")) {
    return { status: 200, json: body.map((b) => jsonRpcOne(url, b, funded, degraded) ?? { jsonrpc: "2.0", id: b?.id ?? 1, result: "0x0" }) };
  }
  if (body && typeof body === "object" && !Array.isArray(body) && (body.jsonrpc || typeof body.method === "string")) {
    const r = jsonRpcOne(url, body, funded, degraded);
    if (r !== null) return { status: 200, json: r };
  }

  // ---- GraphQL POST (Sui, since Mysten retired JSON-RPC on 2026-07-31) ----
  if (body && typeof body === "object" && typeof body.query === "string") {
    const g = graphQlOne(url, body, funded, degraded);
    if (g !== null) return g;
  }

  // ---- BasicSwap public market snapshot (markets.basicswapdex.com) ----
  //
  // Read by `swap-sidecar/marketsSnapshot.ts` for the pre-opt-in market
  // preview on the Swap and EARN tabs. Mocked because the preview must be
  // verifiable OFFLINE and DETERMINISTICALLY: it is the one surface whose job
  // is to say "there is a market here", so the sandbox has to be able to
  // render both that answer and its opposite on demand.
  //
  // `degraded` returns 503 rather than an empty book, because "the publisher
  // is down" and "the network is dead" are the two states the component is
  // most required to distinguish and the ones that look identical in data.
  if (url.includes("markets.basicswapdex.com/orderbook.json")) {
    if (degraded) return { status: 503, text: "sandbox-degraded" };
    return { status: 200, json: marketsSnapshotFixture() };
  }

  // ---- Price providers — degraded ⇒ 503 (test the —/$0 affordance) ----
  if (url.includes("api.coingecko.com/api/v3/simple/price")) {
    if (degraded) return { status: 503, json: { error: "sandbox-degraded" } };
    const idsMatch = /[?&]ids=([^&]+)/.exec(url);
    const ids = idsMatch ? decodeURIComponent(idsMatch[1]).split(",") : [];
    const out: Record<string, { usd: number }> = {};
    for (const id of ids) {
      const ticker = COINGECKO_ID_TO_TICKER[id];
      if (ticker) out[id] = { usd: priceFor(ticker) };
    }
    return { status: 200, json: out };
  }
  if (url.includes("api.coingecko.com/api/v3/coins/") && url.includes("/market_chart")) {
    if (degraded) return { status: 503, json: { error: "sandbox-degraded" } };
    const m = /\/coins\/([^/]+)\/market_chart/.exec(url);
    const id = m ? decodeURIComponent(m[1]) : "";
    const ticker = COINGECKO_ID_TO_TICKER[id];
    return { status: 200, json: { prices: ticker ? synthHistory24h(ticker) : [] } };
  }
  if (url.includes("api.coinpaprika.com/v1/tickers")) {
    if (degraded) return { status: 503, json: { error: "sandbox-degraded" } };
    const out: any[] = [];
    for (const [id, ticker] of Object.entries(COINPAPRIKA_ID_TO_TICKER)) {
      out.push({ id, symbol: ticker, quotes: { USD: { price: priceFor(ticker) } } });
    }
    return { status: 200, json: out };
  }
  if (url.includes("min-api.cryptocompare.com/data/pricemulti")) {
    if (degraded) return { status: 503, json: { error: "sandbox-degraded" } };
    const m = /[?&]fsyms=([^&]+)/.exec(url);
    const tickers = m ? decodeURIComponent(m[1]).split(",") : [];
    const out: Record<string, { USD: number }> = {};
    for (const t of tickers) {
      const upper = t.toUpperCase();
      if (SANDBOX_PRICES_USD[upper]) out[upper] = { USD: priceFor(upper) };
    }
    return { status: 200, json: out };
  }
  if (url.includes("min-api.cryptocompare.com/data/v2/histohour")) {
    if (degraded) return { status: 503, json: { error: "sandbox-degraded" } };
    const m = /[?&]fsym=([^&]+)/.exec(url);
    const ticker = m ? decodeURIComponent(m[1]).toUpperCase() : "";
    const points = synthHistory24h(ticker);
    if (points.length === 0) return { status: 200, json: { Response: "Error", Message: "unknown symbol" } };
    return {
      status: 200,
      json: {
        Response: "Success",
        Data: { Data: points.map(([t, close]) => ({ time: Math.floor(t / 1000), close, high: close * 1.002, low: close * 0.998, open: close, volumefrom: 0, volumeto: 0 })) },
      },
    };
  }

  // ---- NEAR Intents token catalog — primes near-intents-tokens.ts's
  //      cache (decimals + live price; 1Click doesn't publish per-asset
  //      minimums — see per-pair-minimums-research.md — so this mock
  //      doesn't invent any). A minimal but realistic set: the default
  //      ETH→BTC pair plus POL, whose HOT Omni-Bridge (`nep245:`) asset
  //      id exercises the `probeExactInputFallback` demo in intentsQuote()
  //      below. Not gated on `degraded` — an empty/failed tokens cache
  //      degrades every minimum hint to silence, which isn't a useful
  //      thing to demo here. ----
  if (url.includes("/api/intents/tokens")) {
    return {
      status: 200,
      json: [
        { assetId: "nep141:eth.omft.near", decimals: 18, blockchain: "eth", symbol: "ETH", price: priceFor("ETH") },
        { assetId: "nep141:btc.omft.near", decimals: 8, blockchain: "btc", symbol: "BTC", price: priceFor("BTC") },
        { assetId: "nep141:sol.omft.near", decimals: 9, blockchain: "sol", symbol: "SOL", price: priceFor("SOL") },
        { assetId: "nep141:wrap.near", decimals: 24, blockchain: "near", symbol: "NEAR", price: priceFor("NEAR") },
        { assetId: "nep245:v2_1.omni.hot.tg:137_11111111111111111111", decimals: 18, blockchain: "pol", symbol: "POL", price: priceFor("POL") },
      ],
    };
  }

  // ---- Zephyr Protocol scanner livestats — oracle prices + reserve audit.
  //      Drives useZphReserveInfo → ZephyrAssetsCard USD values + the reserve
  //      card. Real values captured 2026-06-29; degraded ⇒ 503 so the card's
  //      no-price ("—" / hidden total) affordance is testable. ----
  if (url.includes("zephyrprotocol.com/api/v1/livestats")) {
    if (degraded) return { status: 503, json: { error: "sandbox-degraded" } };
    return {
      status: 200,
      json: {
        reserve_ratio: 3.745686,
        reserve_ratio_ma: 3.863722,
        zeph_in_reserve: 4_269_925.67,
        zeph_in_reserve_value: 1_455_617.66,
        zeph_in_reserve_percent: 0.2321,
        zeph_circ: 11_773_131.72,
        zsd_circ: 388_598.18,
        zrs_circ: 2_550_908.7,
        zys_circ: 156_962.32,
        zeph_price: 0.3409,
        zsd_price: 1,
        zrs_price: 0.4183,
        zys_price: 1.931,
        zsd_in_yield_reserve: 303_097.75,
        zsd_in_yield_reserve_percent: 0.78,
        zys_current_variable_apy: 8.2618,
      },
    };
  }

  // ---- EVM tx history (Etherscan-v1 txlist/tokentx + Blockscout v2) ----
  if (/[?&]action=txlist/.test(url))
    return { status: 200, json: funded ? etherscanTxList() : { status: "0", message: "No transactions found", result: [] } };
  if (/[?&]action=tokentx/.test(url))
    return { status: 200, json: { status: "0", message: "No transactions found", result: [] } };
  if (/blockscout\.com\/.*\/api\/v2\/addresses\/[^/]+\/transactions/.test(url))
    return { status: 200, json: { items: [], next_page_params: null } };
  if (/[?&]action=balance/.test(url)) {
    const chainId = evmChainIdForUrl(url);
    return { status: 200, json: { status: "1", message: "OK", result: (funded ? (EVM_WEI_BY_CHAINID[chainId] ?? 0n) : 0n).toString() } };
  }

  // ---- BTC / LTC esplora (blockstream, mempool.space, litecoinspace) ----
  if (url.includes("blockstream.info/api") || url.includes("mempool.space/api") || url.includes("litecoinspace.org/api")) {
    const isLtc = url.includes("litecoinspace");
    const bal = isLtc ? 320_000_000 : 5_000_000; // 3.2 LTC / 0.05 BTC
    if (url.includes("/fee-estimates")) return { status: 200, json: { "1": 14, "3": 10, "6": 8, "144": 2 } };
    if (url.includes("/v1/fees/recommended")) return { status: 200, json: { fastestFee: 14, halfHourFee: 10, hourFee: 8, economyFee: 3, minimumFee: 1 } };
    const utxoM = /\/address\/([^/]+)\/utxo/.exec(url);
    if (utxoM) {
      const stranded = strandedEsploraUtxos(utxoM[1]);
      if (stranded)
        return {
          status: 200,
          json: stranded.map((u) => ({ ...u, status: { confirmed: true, block_height: 3_165_139 } })),
        };
      // Only the account's index-0 address holds coins — see
      // FUNDED_ACCOUNT_ADDRESSES for why answering `funded` for every address
      // made the gap walk unbounded.
      const utxoFunded = funded && isFundedAccountAddress(utxoM[1]);
      return { status: 200, json: utxoFunded ? [{ txid: "ab".repeat(32), vout: 0, value: bal, status: { confirmed: true, block_height: 850_000 } }] : [] };
    }
    const txsM = /\/address\/([^/]+)\/txs/.exec(url);
    if (txsM) return { status: 200, json: funded && isFundedAccountAddress(txsM[1]) ? esploraTxs(txsM[1]) : [] };
    const addrM = /\/address\/([^/?]+)/.exec(url);
    if (addrM) {
      // `utxo_change_stranded` reproduces the 2026-08-22 mainnet incident on
      // the sandbox's own test seed: the DISPLAYED address has history but is
      // empty (funded, then spent), and the money is on the change chain at
      // index 20 — one past BIP-44's standard gap limit of 20. It is the only
      // scenario where per-address answers differ, because it is the only one
      // whose whole point is that "the wallet" and "one address" are not the
      // same question. See `wallets/utxo-account.ts`.
      const st = strandedEsploraStats(addrM[1]);
      if (st) return { status: 200, json: { address: addrM[1], ...st } };
      const addrFunded = funded && isFundedAccountAddress(addrM[1]);
      return {
        status: 200,
        json: {
          address: addrM[1],
          chain_stats: { funded_txo_count: addrFunded ? 2 : 0, funded_txo_sum: addrFunded ? bal : 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: addrFunded ? 2 : 0 },
          mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 },
        },
      };
    }
    if (/\/tx$/.test(url) && method === "POST") return { status: 200, text: "ab".repeat(32) };
  }

  // ---- BlockCypher (LTC/DOGE/DASH) — balance, UTXO, prev-tx, broadcast, fee ----
  //
  // Generalised 2026-08-25 from an LTC-balance-only mock when DOGE and DASH
  // gained account-wide sending. BlockCypher is the FIRST source each
  // adapter's `tryEach` tries for every one of these operations (see
  // `ltc-wallet.ts`/`doge-wallet.ts`/`dash-wallet.ts`), so mocking it alone is
  // enough to make all three chains' account scans and sends deterministic —
  // LTC previously fell through two real (CORS-failing) network round-trips
  // to litecoinspace.org on every UTXO fetch; it now resolves on the first
  // try, same answer, without the wait.
  if (url.includes("api.blockcypher.com/v1/")) {
    const coinM = /\/v1\/(ltc|doge|dash)\/main(\/.*)?$/.exec(url.split("?")[0]);
    const chain = coinM
      ? ({ ltc: "litecoin", doge: "dogecoin", dash: "dash" } as const)[coinM[1] as "ltc" | "doge" | "dash"]
      : null;
    if (chain) {
      // Reasonable non-stranded funded defaults, independent per chain so a
      // debugging session can never confuse "the stranded change output" with
      // "the generic funded balance" by matching digits.
      const DEFAULT_SAT: Record<string, number> = {
        litecoin: 320_000_000, // pre-existing LTC value, unchanged
        dogecoin: 45_000_000_000, // 450 DOGE
        dash: 75_000_000, // 0.75 DASH
      };
      const defaultSat = DEFAULT_SAT[chain];

      const balM = /\/addrs\/([^/]+)\/balance/.exec(url);
      if (balM) {
        const hit = strandedRoleFor(balM[1]);
        if (hit && hit.fixture.chain === chain) {
          const sat = hit.role === "receive0" ? 0 : hit.fixture.changeSat;
          const nTx = hit.role === "receive0" ? 2 : 1;
          return { status: 200, json: { balance: sat, unconfirmed_balance: 0, final_balance: sat, n_tx: nTx, final_n_tx: nTx } };
        }
        // Index-0 only — see FUNDED_ACCOUNT_ADDRESSES.
        const addrFunded = funded && isFundedAccountAddress(balM[1]);
        const sat = addrFunded ? defaultSat : 0;
        const nTx = addrFunded ? 2 : 0;
        return { status: 200, json: { balance: sat, unconfirmed_balance: 0, final_balance: sat, n_tx: nTx, final_n_tx: nTx } };
      }

      const utxoM = /\/addrs\/([^/?]+)\?unspentOnly=true/.exec(url);
      if (utxoM) {
        const hit = strandedRoleFor(utxoM[1]);
        if (hit && hit.fixture.chain === chain) {
          const txrefs =
            hit.role === "change20"
              ? [{ tx_hash: hit.fixture.changeTxid, tx_output_n: hit.fixture.changeVout, value: hit.fixture.changeSat }]
              : [];
          return { status: 200, json: { txrefs } };
        }
        return {
          status: 200,
          json: {
            txrefs:
              funded && isFundedAccountAddress(utxoM[1])
                ? [{ tx_hash: "ab".repeat(32), tx_output_n: 0, value: defaultSat }]
                : [],
          },
        };
      }

      const txHexM = /\/txs\/([0-9a-f]+)\?includeHex=true/.exec(url);
      if (txHexM) {
        const fixture = STRANDED_FIXTURES.find((f) => f.chain === chain && f.changeTxid === txHexM[1]);
        if (fixture?.changePrevTxHex) return { status: 200, json: { hex: fixture.changePrevTxHex } };
        // A prev-tx lookup for the generic "ab".repeat(32) funded default UTXO
        // (not the stranded fixture) — a harmless one-in/one-out filler tx
        // whose only requirement is parsing as a valid transaction.
        return {
          status: 200,
          json: {
            hex: "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff00ffffffff0100e1f505000000001976a914" + "00".repeat(20) + "88ac00000000",
          },
        };
      }

      if (/\/txs\/push$/.test(url) && method === "POST") {
        return { status: 200, json: { tx: { hash: "cd".repeat(32) } } };
      }

      // Bare `/v1/<coin>/main` with no further path — the fee-oracle endpoint
      // (`fetchFeeRateBlockcypher`). Distinguished last because every other
      // branch above matches a longer, more specific path first.
      if (coinM && !coinM[2]) {
        return { status: 200, json: { medium_fee_per_kb: 100_000, high_fee_per_kb: 150_000, low_fee_per_kb: 50_000 } };
      }
    }
  }

  // ---- Blockchair (DOGE/DASH/BCH) — one endpoint serves both balance+UTXO,
  //      plus prev-tx (DOGE/DASH), broadcast, fee ----
  //
  // Added 2026-08-25 alongside BTC/DOGE/DASH/BCH's account-wide sending. None
  // of these three chains had ANY mock coverage before this — the header
  // comment's coverage matrix claimed "LTC/DOGE/BCH/DASH" balances were
  // mocked via `http_proxy_call`; that was true for LTC only. Fixed here
  // rather than just noted, since the account-send verification needs it
  // anyway and a wallet_populated pass for these three was already silently
  // hitting real (CORS-failing) network calls.
  //
  // `dashboards/address/{addr}` is the ONE Blockchair endpoint every relevant
  // caller hits — `blockchairProbe` (balance display, keyed by the BARE
  // address for BCH) and `fetchUtxosBlockchair` (UTXO fetch, keyed by
  // whatever address string built the URL) both parse the same shape, so one
  // handler answers both by keying the response under every address form the
  // fixture knows.
  // ---- haskoin-store (BTC/BCH batch probe + BCH primary) — 2026-09-04 ----
  //
  // `api.blockchain.info/haskoin-store/{btc,bch}` and `api.haskoin.com/{btc,bch}`
  // run the same software; one handler answers both. Shapes copied from the
  // live capture the same day (see the vault log): `/address/balances`
  // returns one `{address, confirmed, unconfirmed, utxo, txs, received}` row
  // per requested address, `/address/{a}/balance` one such row,
  // `/address/{a}/unspent` `[{txid, index, value, …}]`,
  // `/address/{a}/transactions/full` full transactions, `/health` the
  // height, and `POST /transactions` `{txid}`.
  //
  // Answers the SAME per-address facts the Blockchair/Esplora handlers give
  // (the stranded fixture's receive0/change20 roles, then the generic funded
  // index-0 address), so the account walk reaches the same conclusion
  // whichever source it consults first.
  {
    const hk = /(?:haskoin-store|api\.haskoin\.com)\/(btc|bch)\//.exec(url);
    if (hk) {
      const chain: "bitcoin" | "bitcoin-cash" = hk[1] === "btc" ? "bitcoin" : "bitcoin-cash";
      const defaultSat = chain === "bitcoin" ? 12_500_000 : 8_000_000; // 0.125 BTC / 0.08 BCH
      const rowFor = (raw: string) => {
        const addr = decodeURIComponent(raw);
        const hit = strandedRoleFor(addr);
        if (hit && hit.fixture.chain === chain) {
          return hit.role === "receive0"
            ? { address: addr, confirmed: 0, unconfirmed: 0, utxo: 0, txs: 2, received: hit.fixture.receiveFundedSat }
            : { address: addr, confirmed: hit.fixture.changeSat, unconfirmed: 0, utxo: 1, txs: 1, received: hit.fixture.changeSat };
        }
        return funded && isFundedAccountAddress(addr)
          ? { address: addr, confirmed: defaultSat, unconfirmed: 0, utxo: 1, txs: 2, received: defaultSat }
          : { address: addr, confirmed: 0, unconfirmed: 0, utxo: 0, txs: 0, received: 0 };
      };
      const balances = /\/address\/balances\?addresses=([^&]+)/.exec(url);
      if (balances) {
        return { status: 200, json: balances[1].split(",").map(rowFor) };
      }
      const one = /\/address\/([^/?]+)\/balance/.exec(url);
      if (one) return { status: 200, json: rowFor(one[1]) };
      const unspent = /\/address\/([^/?]+)\/unspent/.exec(url);
      if (unspent) {
        const row = rowFor(unspent[1]);
        const hit = strandedRoleFor(decodeURIComponent(unspent[1]));
        const txid = hit?.role === "change20" ? hit.fixture.changeTxid : "ab".repeat(32);
        const index = hit?.role === "change20" ? hit.fixture.changeVout : 0;
        return {
          status: 200,
          json: row.confirmed > 0 ? [{ address: row.address, txid, index, value: row.confirmed, block: { height: 967_000, position: 1 } }] : [],
        };
      }
      if (/\/address\/[^/?]+\/transactions/.test(url)) return { status: 200, json: [] };
      if (/\/health/.test(url)) return { status: 200, json: { blocks: { blocks: 967_000, headers: 967_000, ok: true }, ok: true } };
      if (/\/transactions$/.test(url) && method === "POST") return { status: 200, json: { txid: "ef".repeat(32) } };
      return { status: 404, json: { error: "not-found" } };
    }
  }

  if (url.includes("api.blockchair.com/")) {
    const coinM = /api\.blockchair\.com\/(dogecoin|dash|bitcoin-cash)\//.exec(url);
    const chain = coinM ? (coinM[1] as "dogecoin" | "dash" | "bitcoin-cash") : null;
    if (chain) {
      const DEFAULT_SAT: Record<string, number> = {
        dogecoin: 40_000_000_000, // 400 DOGE — distinct from the BlockCypher default on purpose
        dash: 60_000_000, // 0.6 DASH
        "bitcoin-cash": 8_000_000, // 0.08 BCH
      };
      const defaultSat = DEFAULT_SAT[chain];

      const addrM = /\/dashboards\/address\/([^/?]+)/.exec(url);
      if (addrM) {
        const rawAddr = decodeURIComponent(addrM[1]);
        const hit = strandedRoleFor(rawAddr);
        let entry: { address: { balance: number; transaction_count: number }; utxo: Array<{ transaction_hash: string; index: number; value: number }> };
        if (hit && hit.fixture.chain === chain) {
          entry =
            hit.role === "receive0"
              ? { address: { balance: 0, transaction_count: 2 }, utxo: [] }
              : {
                  address: { balance: hit.fixture.changeSat, transaction_count: 1 },
                  utxo: [{ transaction_hash: hit.fixture.changeTxid, index: hit.fixture.changeVout, value: hit.fixture.changeSat }],
                };
        } else {
          // Index-0 only — see FUNDED_ACCOUNT_ADDRESSES. `rawAddr` may be
          // either CashAddr form for BCH; both are in the set.
          entry =
            funded && isFundedAccountAddress(rawAddr)
              ? { address: { balance: defaultSat, transaction_count: 2 }, utxo: [{ transaction_hash: "ab".repeat(32), index: 0, value: defaultSat }] }
              : { address: { balance: 0, transaction_count: 0 }, utxo: [] };
        }
        // Key under every form a caller might index by (with/without the
        // "bitcoincash:" prefix) so both the bare-keyed probe and the
        // full-address-keyed UTXO fetch find the same entry.
        const keys = new Set([rawAddr, rawAddr.includes(":") ? rawAddr.split(":")[1] : `bitcoincash:${rawAddr}`]);
        const data: Record<string, typeof entry> = {};
        for (const k of keys) data[k] = entry;
        return { status: 200, json: { data } };
      }

      const rawTxM = /\/raw\/transaction\/([0-9a-fA-F]+)/.exec(url);
      if (rawTxM) {
        const fixture = STRANDED_FIXTURES.find((f) => f.chain === chain && f.changeTxid === rawTxM[1]);
        const hex =
          fixture?.changePrevTxHex ??
          // Filler for a prev-tx lookup that isn't the stranded fixture (the
          // generic funded-default UTXO) — only needs to parse.
          "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff00ffffffff0100e1f505000000001976a914" + "00".repeat(20) + "88ac00000000";
        return { status: 200, json: { data: { [rawTxM[1]]: { raw_transaction: hex } } } };
      }

      if (/\/push\/transaction/.test(url) && method === "POST") {
        return { status: 200, json: { data: { transaction_hash: "ef".repeat(32) } } };
      }

      if (/\/stats/.test(url)) {
        return { status: 200, json: { data: { suggested_transaction_fee_per_byte_sat: 2 } } };
      }
    }
  }

  // ---- RVN (BlockBook + Insight mirrors) ----
  //
  // Added 2026-08-25 with Ravencoin's account-wide balance. Without these the
  // scan cannot complete, and the card correctly renders "Scan incomplete (20
  // probed) — a source did not answer" — honest, but it verifies the failure
  // path rather than the fix. `details=basic` carries `txs`, which is what the
  // probe keys on: history, not balance.
  if (url.includes("blockbook.ravencoin.org")) {
    const addrM = /\/api\/v2\/address\/([^/?]+)/.exec(url);
    if (addrM) {
      // Index 0 only, matching how every other keyless mock answers: the
      // account walk then sees one used address and 20 unused ones after it.
      const isFirst = addrM[1] === rvnFirstAddress;
      return {
        status: 200,
        json: {
          address: addrM[1],
          balance: funded && isFirst ? "1450000000000" : "0", // 14,500 RVN
          unconfirmedBalance: "0",
          txs: funded && isFirst ? 3 : 0,
        },
      };
    }
    if (/\/api\/v2\/utxo\//.test(url)) return { status: 200, json: [] };
    if (/\/api\/v2\/sendtx/.test(url)) return { status: 200, json: { result: "ab".repeat(32) } };
  }
  if (url.includes("/addr/") && /rvn|ravencoin/i.test(url)) {
    if (/\/balance$/.test(url)) return { status: 200, json: 0 };
    if (/\/unconfirmedBalance$/.test(url)) return { status: 200, json: 0 };
    return { status: 200, json: { balanceSat: 0, unconfirmedBalanceSat: 0, txApperances: 0 } };
  }

  // ---- ERG (ergoplatform / sigmaspace) ----
  if (url.includes("ergoplatform.com/api/v1") || url.includes("sigmaspace.io/api/v1")) {
    if (/\/addresses\/[^/]+\/balance\/confirmed/.test(url))
      return { status: 200, json: { nanoErgs: funded ? 45_000_000_000 : 0, tokens: [] } }; // 45 ERG
    if (/\/boxes\/unspent\/byAddress\//.test(url))
      return { status: 200, json: { items: funded ? [{ boxId: "ab".repeat(32), value: 45_000_000_000, ergoTree: "0008cd", assets: [], creationHeight: 1_200_000, transactionId: "cd".repeat(32), index: 0 }] : [], total: funded ? 1 : 0 } };
    if (/\/addresses\/[^/]+\/transactions/.test(url)) return { status: 200, json: { items: [], total: 0 } };
    if (/\/info(\?|$)/.test(url)) return { status: 200, json: { height: 1_234_567, fullHeight: 1_234_567 } };
    if (/\/mempool\/transactions\/submit/.test(url) && method === "POST") return { status: 200, json: "ab".repeat(32) };
  }

  // ---- Algorand (algonode): balance direct, history via proxy ----
  if (url.includes("algonode.cloud")) {
    if (/\/v2\/accounts\/[^/]+\/transactions/.test(url)) return { status: 200, json: { transactions: [], "next-token": null } };
    if (/\/v2\/accounts\/[^/?]+/.test(url))
      return { status: 200, json: { address: "ALGOADDR", amount: funded ? 220_000_000 : 0, "min-balance": 100_000, "amount-without-pending-rewards": funded ? 220_000_000 : 0, "pending-rewards": 0, round: 30_000_000 } }; // 220 ALGO
  }

  // ---- Tron (trongrid / tronstack): balance direct, history via proxy ----
  if (url.includes("trongrid.io") || url.includes("tronstack.io")) {
    // TRC-20 `balanceOf` — `constant_result` is ABI returndata: 32 bytes,
    // NO "0x" prefix (unlike an EVM eth_call result). Getting that prefix
    // wrong decodes to zero, which is indistinguishable from an empty wallet.
    if (url.includes("/wallet/triggerconstantcontract")) {
      const contract = String(body?.contract_address ?? "");
      const units = funded ? (MOCK_TRC20_UNITS[contract] ?? 0n) : 0n;
      return {
        status: 200,
        json: {
          result: { result: true },
          constant_result: [units.toString(16).padStart(64, "0")],
        },
      };
    }
    if (/\/v1\/accounts\/[^/]+\/transactions/.test(url)) return { status: 200, json: { data: [], meta: { fingerprint: null, page_size: 0 } } };
    if (/\/v1\/accounts\/[^/?]+/.test(url))
      return { status: 200, json: { data: [{ balance: funded ? 850_000_000 : 0, address: "TRXADDR", create_time: 1_600_000_000_000 }], success: true, meta: { at: Math.floor(Date.now() / 1000) } } }; // 850 TRX
  }

  // ---- Hedera mirror node: balance direct, history via proxy ----
  if (url.includes("mirrornode.hedera.com")) {
    if (/\/api\/v1\/transactions/.test(url)) return { status: 200, json: { transactions: [], links: { next: null } } };
    if (/\/api\/v1\/accounts/.test(url)) {
      // An UNFUNDED sandbox wallet has NO Hedera account, which is a different
      // state from an account holding zero — on Hedera an account must be
      // created and paid for before it exists at all. Returning a 0-balance
      // account for the unfunded case made that state unreachable in the
      // sandbox, and it is the state `HederaSetupPanel` exists to explain.
      // `degraded` is the scenario CONTRIBUTING.md documents for "data-absent
      // affordances", and a freshly-imported seed with no Hedera account is
      // exactly that — the state `HederaSetupPanel` explains.
      if (!funded || degraded) return { status: 200, json: { accounts: [], links: { next: null } } };
      return { status: 200, json: { accounts: [{ account: "0.0.123456", balance: { balance: 120_000_000_000, timestamp: "0", tokens: [] }, key: { _type: "ED25519", key: "abcd" } }], links: { next: null } } }; // 1200 HBAR
    }
  }

  // ---- Cardano Koios (POST) ----
  if (url.includes("koios.rest/api/v1/address_info")) {
    const addr = Array.isArray(body?._addresses) ? body._addresses[0] : "addr1sandbox";
    return { status: 200, json: funded ? [{ address: addr, balance: "320000000", stake_address: null, script_address: false, utxo_set: [] }] : [] }; // 320 ADA
  }
  if (url.includes("koios.rest/api/v1/address_txs")) return { status: 200, json: [] };
  if (url.includes("koios.rest/api/v1/tx_info")) return { status: 200, json: [] };

  // ---- Stellar Horizon ----
  if (url.includes("horizon.stellar.org")) {
    if (/\/accounts\/[^/]+\/operations/.test(url)) return { status: 200, json: { _embedded: { records: [] } } };
    if (/\/accounts\/[^/?]+/.test(url))
      return { status: 200, json: { id: "XLMADDR", balances: [{ asset_type: "native", balance: funded ? "300.0000000" : "0.0000000" }] } }; // 300 XLM
  }

  // ---- Bitcore (DOGE / BCH primary balance) ----
  if (/api\.bitcore\.io\/api\/\w+\/mainnet\/address\//.test(url)) {
    const sat = funded ? (/\/BCH\/mainnet\//.test(url) ? 1_230_000 : 150_050_000_000) : 0; // 0.0123 BCH / 1500.5 DOGE
    return { status: 200, json: { confirmed: sat, unconfirmed: 0, balance: sat } };
  }

  // ---- Dash Insight (DASH primary balance) ----
  if (/insight\.dash\.org\/insight-api\/addr\//.test(url)) {
    const sat = funded ? 234_500_000 : 0; // 2.345 DASH
    return { status: 200, json: { balanceSat: sat, unconfirmedBalanceSat: 0, balance: sat / 1e8 } };
  }

  return null; // unmatched
}

// `http_proxy_call` invoke entrypoint — wraps dispatchUrl in the ProxyResponse
// envelope ({status, body: string, headers}). 503 on unmatched, loud + greppable.
function httpProxyDispatch(args: any): unknown {
  const url: string = args?.url ?? "";
  if (!url) return proxy503("missing url");
  let parsedBody: any = undefined;
  if (typeof args?.body === "string") {
    try {
      parsedBody = JSON.parse(args.body);
    } catch {
      parsedBody = args.body;
    }
  }
  const res = dispatchUrl(url, String(args?.method ?? "GET").toUpperCase(), parsedBody);
  if (!res) return proxy503(`no mock for ${url.slice(0, 100)}`);
  const bodyStr = res.text !== undefined ? res.text : JSON.stringify(res.json);
  return { status: res.status, body: bodyStr, headers: [["content-type", "application/json"]] };
}

/**
 * `window.fetch` shim entrypoint (consumed by src/lib/tauri.ts). Returns a
 * synthesized `{status, body}` for a matched chain/explorer URL, or `null` to
 * pass through to the real fetch (Vite assets, unmatched hosts). This is what
 * covers the direct-`fetch()` chains (BTC, ERG, ALGO/TRX/HBAR balance, EVM
 * JSON-RPC) that bypass `http_proxy_call`.
 */
export function getFetchMock(
  url: string,
  method: string,
  body: any,
): { status: number; body: string } | null {
  const res = dispatchUrl(url, String(method ?? "GET").toUpperCase(), body);
  if (!res) return null;
  return { status: res.status, body: res.text !== undefined ? res.text : JSON.stringify(res.json) };
}

// ---------------------------------------------------------------------------
// Swap session + quote mocks
// ---------------------------------------------------------------------------
//
// The swap surface (proxy.ts + swap-rust.ts) sits behind ~25 invoke calls.
// None were mocked previously, so any code path that called swap_unlock
// or intents_quote would crash with `undefined.then`. The mocks below
// return realistic shapes — never real signed material, never a real
// deposit address.

const FAKE_SESSION_ID = "sandbox-session-0000-0000";
const FAKE_ADDRESSES = {
  eth: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
  btc: "bc1qsandboxnotrealaddressxxxxxxxxxxxxxxxxxxxxx",
  near: "ed25519:5HXVnT5UYqcRYr1ePj8ApbeS2nNXgK5LzZNu5sandboxXXX",
  sol: "9SandboxSolanaPublicKeyDoNotUseForRealTxnsXX",
};

function swapKitQuote() {
  return {
    quoteId: "sandbox-quote-" + Math.floor(Date.now() / 1000).toString(36),
    routes: [
      {
        routeId: "sandbox-route-thorchain",
        providers: ["THORCHAIN"],
        expectedBuyAmount: "0.048612",
        fees: {
          inbound: "0.00012",
          network: "0.00007",
          affiliate: "0.0001",
          service: "0",
          outbound: "0.00009",
        },
        estimatedTime: { inbound: 60, swap: 30, outbound: 360, total: 450 },
        warnings: [],
        meta: { provider: "thorchain" },
      },
    ],
    nextActions: [],
    providerErrors: [],
  };
}

function swapKitBuildTx() {
  return {
    meta: { txType: "EVM" },
    transaction: {
      chainId: 1,
      to: "0x000000000000000000000000000000000000dEaD",
      value: "0",
      data: "0x",
      gas: 21000,
      gasPrice: 30_000_000_000,
      nonce: 0,
      from: FAKE_ADDRESSES.eth,
    },
  };
}

/**
 * Mock floor for the HOT Omni-Bridge (`nep245:`) demo below — mirrors the
 * real ~74.8 POL floor captured live against 1Click on 2026-07-01 (see
 * `intents-pair-min-probe.ts::probeExactInputFallback`).
 */
const HOT_BRIDGE_MOCK_FLOOR_ATOMIC = 75_000_000_000_000_000_000n; // 75 (18dp)

/**
 * `intents_quote` mock. Request-aware for one specific, real bug: assets
 * routed through the HOT Omni-Bridge (`nep245:` asset ids — first seen on
 * POL) answer a dry EXACT_OUTPUT probe with a generic, unparseable
 * rejection but a dry EXACT_INPUT probe with the specific "try at least N"
 * shape. Simulating that split here lets the sandbox demonstrate
 * `probeExactInputFallback` (the fix for the "minimum only shows after
 * typing" bug) without touching the real network. Every other request
 * shape (non-`nep245:` sources, or a non-dry real quote) gets the
 * original canned success below unchanged.
 */
function intentsQuote(args?: { req?: Record<string, unknown> }): unknown {
  const req = args?.req;
  const originAsset = typeof req?.originAsset === "string" ? req.originAsset : "";
  const isHotBridgeSource = originAsset.startsWith("nep245:");

  if (req?.dry === true && isHotBridgeSource) {
    if (req.swapType === "EXACT_OUTPUT") {
      throw new Error("Failed to get quote");
    }
    if (req.swapType === "EXACT_INPUT") {
      const amount = typeof req.amount === "string" ? req.amount : "";
      let amountAtomic: bigint | null = null;
      try {
        amountAtomic = BigInt(amount);
      } catch {
        amountAtomic = null;
      }
      if (amountAtomic !== null && amountAtomic < HOT_BRIDGE_MOCK_FLOOR_ATOMIC) {
        throw new Error(
          `Amount is too low for bridge, try at least ${HOT_BRIDGE_MOCK_FLOOR_ATOMIC.toString()}`,
        );
      }
    }
  }

  const now = Date.now();
  return {
    quote: {
      depositAddress: "sandbox-deposit-not-a-real-address",
      depositMemo: null,
      amountIn: "1000000000000000000",
      minAmountIn: "990000000000000000",
      amountOut: "48612000",
      minAmountOut: "48000000",
      amountInUsd: "3480.00",
      amountOutUsd: "3475.00",
      deadline: new Date(now + 15 * 60_000).toISOString(),
      timeEstimate: 480,
    },
    timestamp: new Date(now).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Solana RPC (sol_rpc_call) — dispatch by JSON-RPC method in the request body.
// Returns the {status, body} envelope sol-wallet.ts wraps into a Response.
// ---------------------------------------------------------------------------
function solRpcDispatch(args: any): unknown {
  let req: any = undefined;
  if (typeof args?.body === "string") {
    try {
      req = JSON.parse(args.body);
    } catch {
      /* leave undefined */
    }
  }
  const id = req?.id ?? 1;
  const method: string = req?.method ?? "";
  const ok = (result: unknown) => ({
    status: 200,
    body: JSON.stringify({ jsonrpc: "2.0", id, result }),
    headers: [["content-type", "application/json"]],
  });
  switch (method) {
    case "getBalance":
      return ok({ context: { slot: 250_000_000 }, value: walletFunded() ? 2_120_000_000 : 0 }); // 2.12 SOL
    case "getLatestBlockhash":
      return ok({ context: { slot: 250_000_000 }, value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 250_000_100 } });
    // NOTE the method name: web3.js's `getParsedTokenAccountsByOwner` helper
    // sends the WIRE method `getTokenAccountsByOwner` with encoding
    // jsonParsed. Mocking the helper's name instead of the wire name meant
    // this fell through to the default and returned 0, which web3.js rejects
    // with "Expected an object, but received: 0".
    case "getTokenAccountsByOwner": {
      // SPL legs. `params[1].mint` selects the token; amounts are in the
      // mint's own decimals (both 6). Returns the shape the adapter reads:
      // account.data.parsed.info.tokenAmount.amount.
      const mint = String(req?.params?.[1]?.mint ?? "");
      const units = walletFunded() ? (MOCK_SPL_UNITS[mint] ?? 0n) : 0n;
      return ok({
        context: { slot: 250_000_000 },
        value:
          units === 0n
            ? []
            : [
                {
                  // Base58 excludes 0, O, I and l — an earlier placeholder spelled
                    // "SANDBOX…" and web3.js rejected the whole response with
                    // "Non-base58 character", which surfaced as every Solana RPC
                    // endpoint appearing to fail.
                    pubkey: "11111111111111111111111111111111",
                  account: {
                    data: {
                      parsed: {
                        type: "account",
                        info: { mint, tokenAmount: { amount: units.toString(), decimals: 6 } },
                      },
                    },
                  },
                },
              ],
      });
    }
    case "getTokenAccountBalance": {
      // The non-indexed fallback the SPL adapter uses when an endpoint
      // refuses `getTokenAccountsByOwner`. The sandbox exercises the fallback
      // too, because in production most keyless endpoints ARE the fallback.
      const units = walletFunded()
        ? Object.values(MOCK_SPL_UNITS).reduce((a, b) => (a > b ? a : b), 0n)
        : 0n;
      return ok({
        context: { slot: 250_000_000 },
        value: { amount: units.toString(), decimals: 6, uiAmount: Number(units) / 1e6 },
      });
    }
    case "getSignaturesForAddress":
      return ok([]);
    case "getParsedTransaction":
    case "getTransaction":
      return ok(null);
    case "sendTransaction":
      return ok("1111111111111111111111111111111111111111111111111111111111111111");
    case "getEpochInfo":
      return ok({ epoch: 600, slotIndex: 1, slotsInEpoch: 432_000, absoluteSlot: 250_000_000, blockHeight: 230_000_000 });
    case "getFeeForMessage":
      return ok({ context: { slot: 250_000_000 }, value: 5000 });
    default:
      return ok(0);
  }
}

// ---------------------------------------------------------------------------
// XMR / ZPH wallet-rpc (xmr_rpc_call / zph_rpc_call) — dispatch by method.
// The frontend `rpc()` wrapper returns the invoke result AS the RPC `result`
// object (no {result} envelope), so we return the bare result here.
// ---------------------------------------------------------------------------
function xmrRpcDispatch(args: any, kind: "xmr" | "zph"): unknown {
  const method: string = args?.method ?? "";
  const funded = walletFunded();
  const atomic = 850_000_000_000; // 0.85 XMR (1e12 piconero)
  const height = kind === "xmr" ? 3_000_000 : 1_900_000;
  switch (method) {
    case "get_balance":
      if (kind === "zph") {
        // Multi-asset: ZPH / ZSD / ZRS / ZYS (UI labels ZEPH/ZEPHUSD/ZEPHRSV/ZEPHYRS).
        return funded
          ? {
              balances: [
                { asset_type: "ZPH", balance: 14_000_000_000_000, unlocked_balance: 14_000_000_000_000, blocks_to_unlock: 0 },
                { asset_type: "ZSD", balance: 42_000_000_000_000, unlocked_balance: 42_000_000_000_000, blocks_to_unlock: 0 },
                { asset_type: "ZRS", balance: 5_000_000_000_000, unlocked_balance: 5_000_000_000_000, blocks_to_unlock: 0 },
                { asset_type: "ZYS", balance: 3_000_000_000_000, unlocked_balance: 3_000_000_000_000, blocks_to_unlock: 0 },
              ],
            }
          : { balances: [{ asset_type: "ZPH", balance: 0, unlocked_balance: 0 }] };
      }
      return { balance: funded ? atomic : 0, unlocked_balance: funded ? atomic : 0, multisig_import_needed: false, blocks_to_unlock: 0 };
    case "get_address":
      return {
        address:
          kind === "xmr"
            ? "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A"
            : "ZEPHYR2qjmpfgEjnpvUnmcW84J5q3uvP5Z5oc8h6F9zsTrhpFkPgsandboxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        addresses: [],
      };
    case "get_height":
      return { height };
    case "get_info":
    case "get_version":
      return { height, daemon_connected: true, daemon_height: height, version: 0, synchronized: true };
    case "refresh":
      return { blocks_fetched: 0, received_money: false };
    case "get_transfers":
      return { in: [], out: [], pending: [], failed: [], pool: [] };
    case "query_key":
      return { key: "sandbox sandbox sandbox sandbox sandbox sandbox sandbox sandbox sandbox sandbox sandbox sandbox sandbox" };
    case "validate_address":
      return { valid: true, integrated: false, subaddress: false, nettype: "mainnet" };
    case "create_address":
      return { address: "8sandboxsubaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", address_index: 1 };
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// Zano wallet-rpc (zano_rpc_call) — dispatch by method.
//
// NOT folded into `xmrRpcDispatch`. Zano's JSON-RPC method names differ from
// the Monero-family ones (`getbalance`/`getaddress`, no underscore — verified
// live 2026-08-27 against a real `simplewallet.exe`; see
// `zano-integration-plan.md` Phase 3), and its response shapes are Zano's
// own (a per-asset array with `asset_info.decimal_point` embedded per row,
// not Monero's flat `{balance, unlocked_balance}` or Zephyr's
// `asset_type`-keyed array). Reusing `xmrRpcDispatch` here would mean
// mocking a protocol Zano doesn't speak.
function zanoRpcDispatch(args: any): unknown {
  const method: string = args?.method ?? "";
  const funded = walletFunded();
  // 12 decimals, matching the real wallet's verified asset_info.decimal_point
  // for native ZANO — see zano-rpc.ts::ZANO_NATIVE_DECIMALS.
  const atomic = 3_500_000_000_000; // 3.5 ZANO
  const NATIVE_ASSET_ID =
    "d6329b5b1f7c0805b5c345f4957554002a2f557845f64d7645dae0e051a6498a";
  const SANDBOX_ADDRESS =
    "ZxSandbox1111111111111111111111111111111111111111111111111111111111111111111111111111111111111";
  switch (method) {
    case "getbalance":
      return {
        balance: funded ? atomic : 0,
        unlocked_balance: funded ? atomic : 0,
        balances: [
          {
            asset_info: {
              asset_id: NATIVE_ASSET_ID,
              ticker: "ZANO",
              full_name: "Zano",
              decimal_point: 12,
              current_supply: 0,
              hidden_supply: false,
            },
            total: funded ? atomic : 0,
            unlocked: funded ? atomic : 0,
            awaiting_in: 0,
            awaiting_out: 0,
          },
        ],
      };
    case "getaddress":
      return { address: SANDBOX_ADDRESS };
    case "get_recent_txs_and_info3":
      return {
        last_item_index: 0,
        pi: {
          balance: funded ? atomic : 0,
          curent_height: 3_834_338,
          transfer_entries_count: 0,
          transfers_count: 0,
          unlocked_balance: funded ? atomic : 0,
        },
        total_transfers: 0,
      };
    case "assets_whitelist_get":
      return { global_whitelist: [] };
    case "store":
      return { wallet_file_size: 1670 };
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// BasicSwap swap-sidecar (src-tauri/src/swap_sidecar.rs)
// ---------------------------------------------------------------------------
//
// Seven commands, all mocked — an unmocked command resolves to `undefined`
// and breaks the consuming view SILENTLY, which is exactly the failure the
// coverage matrix above exists to prevent.
//
// Two things about these mocks are load-bearing:
//
//  1. **They are STATEFUL.** `swap_sidecar_opt_in` and `_start` / `_stop`
//     mutate `sidecarState`, and `_status` reads it. A fixed-response mock
//     would let the wizard's consent → install → healthy path render but never
//     exercise the transitions, which is where the bugs live (same reasoning
//     as the `desk_status` call-advance above).
//  2. **`swap_sidecar_start` resolves SLOWLY, on purpose** (~3 s, stepping
//     preparing → starting → healthy). The Rust side drives the wizard's
//     progress meter with the `swap-sidecar-progress` EVENT, and there is no
//     event bus in browser-only mode — `listen()`'s handler is registered
//     through `transformCallback`, which the shim in src/lib/tauri.ts stubs to
//     `() => 0`. So the browser sandbox verifies the wizard's PHASE-POLL
//     fallback instead; the real progress meter is only observable under
//     `npm run tauri:dev:sandbox`, where the real command runs and no mock is
//     consulted. Do not "fix" this by shortening the delay.
//  3. **They REFUSE what production refuses.** A mock that is more permissive
//     than the backend makes every sandbox / Playwright pass over the setup
//     wizard succeed unconditionally while the real path errors — a check
//     that cannot fail for the reason it is run. `sidecarStart` therefore
//     mirrors BOTH of `swap_sidecar_start`'s guards (opt-in, then R3's
//     first-prepare-needs-a-mnemonic) in the backend's own order and with the
//     backend's own wording, and `sidecarApi` mirrors the endpoint denials.
//
// Payload shapes are taken from the vendored upstream at
// `upstream/basicswap/basicswap/js_server.py` (js_coins:107, js_offers:415,
// formatBids:626, js_rate:969, js_offer_fee_estimate:1004,
// js_validateamount:1333, js_active:1554) and `ui/util.py::describeBid` — not
// invented, so a consumer written against these mocks parses the real node.

/** Upstream's `UI_HTML_PORT` / `UI_WS_PORT` defaults (prepare.py:233-234). */
const SIDECAR_HTML_PORT = 12700;
const SIDECAR_WS_PORT = 11700;

const SIDECAR_DATADIR =
  "C:\\Users\\sandbox\\AppData\\Roaming\\com.pwnda.wallet.sandbox-dev\\swap-sidecar\\datadir";

type SidecarPhaseName =
  | "stopped"
  | "preparing"
  | "starting"
  | "healthy"
  | "stopping"
  | "failed";

interface SidecarMockState {
  optedIn: boolean;
  optedInAt: string | null;
  /** "Start with the wallet" preference — the persisted one, not the effective
   *  value; PWNDA_SWAP_SIDECAR_AUTOSTART does not exist in a browser run. */
  autostart: boolean;
  phase: SidecarPhaseName;
  failReason: string;
  configured: boolean;
  runtimeInstalled: boolean;
  /** C5 — a wallet key was pushed this "session". Gates the unlock mock the
   *  same way the real supervisor's in-memory key gates the real unlock, so
   *  the manual Unlock button's WHOLE flow (key push → unlock → C8 share
   *  pass) is drivable in a browser run instead of dying at a hardcoded
   *  refusal. */
  walletKeySet: boolean;
}

/**
 * Per-coin DEX state, mirroring Rust's `CoinEnableStatus`.
 *
 * # This block exists because a card shipped unverified
 *
 * The C3 visual pass recorded that `DexCoinsSection` rendered its empty branch
 * ("No coins reported") because there was no `swap_sidecar_coin_status` mock at
 * all — so `DexCoinCard`, the component that actually holds the per-coin copy,
 * was **never rendered even once** in the sandbox. The section, its heading and
 * its empty state were all verified; the thing under them was not.
 *
 * The table below is chosen to reach every branch of that card in one screen:
 *
 * | coin | reaches |
 * |---|---|
 * | bitcoin | `canRunLean`, not configured → the Light/Local control is LIVE |
 * | litecoin | `canRunLean` + configured lean → control gone, "set when the coin was added" |
 * | particl | mandatory, full, configured |
 * | monero | remote node → `estDiskGb: 0` with no lean control (`canRunLean:false`) |
 * | dogecoin | no binary → unavailable row, no toggle |
 * | dash | configured full, `descriptorsImported` → the "keys imported" badge |
 * | bitcoincash | enabled but not configured, `consolidate` adoption |
 * | zephyr | Grove expansion Phase C: `WALLET_SIDECAR_COINS` follower, binary SEEDED (Phase A2/A4) but not enabled by default — `canShareWallet`/`canRunLean` correctly false until C-RZ lands the C9-shaped host-wallet command |
 * | zano | same follower shape, binary NOT seeded — Phase A5's build is blocked on this machine (Boost 1.84 / Docker), so this row exercises the real "no daemon binary is seeded" refusal `swap_sidecar_set_coin` gives today |
 *
 * `zephyr`/`zano` deliberately do NOT get `canShareWallet: true` or a
 * `"hostwallet"` adoption value yet: the real `swap_sidecar_coin_status`
 * (`swap_sidecar.rs:4307-4309`) computes `can_share_wallet` as `(canRunLean &&
 * lean) || coin == "monero"` — neither ZEPH nor ZANO satisfies that today,
 * because C-RZ/C-RX have not yet added their own C9-shaped commands
 * (`swap_sidecar_set_xmr_host_wallet` refuses every coin but Monero, verbatim,
 * per its own doc comment in `src/api/basicswap.ts`). Flipping these mock
 * fields ahead of that landing would show a control the real backend cannot
 * back yet — see `dexCoinRows()` below, which derives them with the SAME rule
 * Rust uses rather than a hardcoded per-coin flag, so this stays true
 * automatically once that Rust unit lands and this file is revisited.
 */
interface DexCoinMock {
  coin: string;
  ticker: string;
  enabled: boolean;
  binaryPresent: boolean;
  configured: boolean;
  adoption: "descriptor" | "consolidate" | "deposit" | "accountkey" | "hostwallet";
  descriptorsImported: boolean;
  mode: "lean" | "full";
  configuredMode: "lean" | "full" | null;
  canRunLean: boolean;
  /** Explicit DECLINE. Sharing defaults ON for a capable coin once opted in
   *  (2026-08-20), so this — not an "ack" — is what turns a row off. */
  shareWalletDeclined: boolean;
  /** Full-mode chaindata budget. `estDiskGb` is DERIVED from it and the
   *  effective mode, exactly as Rust's `est_disk_gb` does — hardcoding the
   *  final number would let a mode toggle appear to work while the figure
   *  beside it stayed put, which is the one thing this mock is here to show. */
  fullDiskGb: number;
  /** Host-wallet coin whose chainclient block exists but whose host wallet
   *  was NOT open when the node last started, so the supervisor wrote
   *  `connection_type: "none"` and the engine skipped it this session
   *  (2026-09-04, `apply_host_wallet_coin_policy`). Renders the DEX-coins
   *  "parked this session" line and drops the coin from the P2P picker's
   *  live set. Only meaningful with `configured: true`. */
  parked?: boolean;
}

let dexCoinsState: DexCoinMock[] | null = null;

function dexCoins(): DexCoinMock[] {
  if (!dexCoinsState) {
    dexCoinsState = [
      { coin: "particl", ticker: "PART", enabled: true, binaryPresent: true,
        configured: true, adoption: "deposit", descriptorsImported: false,
        mode: "full", configuredMode: "full", canRunLean: false,
        shareWalletDeclined: false, fullDiskGb: 8 },
      // Lean, NOT consented: the "Use my wallet" control is live and off.
      { coin: "bitcoin", ticker: "BTC", enabled: true, binaryPresent: true,
        configured: false, adoption: "deposit", descriptorsImported: false,
        mode: "lean", configuredMode: null, canRunLean: true,
        shareWalletDeclined: false, fullDiskGb: 15 },
      // Consented AND verified — the state that renders "same wallet as your
      // own". Reaching it needs BOTH fields, which is the distinction the UI
      // has to get right.
      { coin: "litecoin", ticker: "LTC", enabled: true, binaryPresent: true,
        configured: true, adoption: "accountkey", descriptorsImported: false,
        mode: "lean", configuredMode: "lean", canRunLean: true,
        shareWalletDeclined: false, fullDiskGb: 6 },
      // C9 consent starts OFF — nothing sets it in production yet either.
      // Flip via swap_sidecar_set_xmr_host_wallet to drive the "consented"
      // copy state in a sandbox pass.
      { coin: "monero", ticker: "XMR", enabled: true, binaryPresent: true,
        configured: true, adoption: "deposit", descriptorsImported: false,
        mode: "full", configuredMode: "full", canRunLean: false,
        shareWalletDeclined: false, fullDiskGb: 0 },
      { coin: "dogecoin", ticker: "DOGE", enabled: false, binaryPresent: false,
        configured: false, adoption: "deposit", descriptorsImported: false,
        mode: "full", configuredMode: null, canRunLean: false,
        shareWalletDeclined: false, fullDiskGb: 9 },
      { coin: "dash", ticker: "DASH", enabled: true, binaryPresent: true,
        configured: true, adoption: "descriptor", descriptorsImported: true,
        mode: "full", configuredMode: "full", canRunLean: false,
        shareWalletDeclined: false, fullDiskGb: 6 },
      // ELECTRUM_CAPABLE since Phase C unit C-R0 (2026-09-03) and in
      // DEFAULT_ENABLED_COINS since 2026-09-04, lean by default — this row
      // used to say `canRunLean: false, mode: "full"`, i.e. the pre-Grove
      // BCH, and would have rendered a Local-node cost for a coin the real
      // backend reports at zero disk.
      { coin: "bitcoincash", ticker: "BCH", enabled: true, binaryPresent: true,
        configured: false, adoption: "deposit", descriptorsImported: false,
        mode: "lean", configuredMode: null, canRunLean: true,
        shareWalletDeclined: false, fullDiskGb: 8 },
      // REMOTE_ONLY_COINS (swap_sidecar.rs): always "full"-shaped (no lean
      // option exists at all — see ELECTRUM_CAPABLE's own doc comment), and
      // est_disk_gb is unconditionally zero for them, which is why fullDiskGb
      // is 0 here rather than a real chaindata figure. In
      // DEFAULT_ENABLED_COINS since 2026-09-04 (operator's decision), so
      // `enabled: true` is what a fresh install looks like. `configured:
      // true` because this scenario's node is RUNNING and, since 2026-09-04,
      // the supervisor writes a host-wallet coin's chainclient block itself
      // before the engine starts (`ensure_host_wallet_coin_block`) instead
      // of leaving it to `prepare --addcoin`, which could never finish for
      // a host-managed wallet (the ten-minute JWT retry loop). The sandbox
      // wallet has a Zephyr account, so the host wallet-rpc is leased and
      // the coin is live: the strip dot is green and ZEPH is in the picker.
      { coin: "zephyr", ticker: "ZEPH", enabled: true, binaryPresent: true,
        configured: true, adoption: "deposit", descriptorsImported: false,
        mode: "full", configuredMode: "full", canRunLean: false,
        shareWalletDeclined: false, fullDiskGb: 0 },
      // binaryPresent flipped to true on 2026-09-04: unit A5's patched
      // `simplewallet` (generate_from_keys) was built, verified against the
      // stock binary as a negative control, staged and bundled that day, so
      // `bin/zano/` is no longer empty on a Windows install. (It was
      // honestly `false` from 2026-09-03 while the build was blocked.)
      //
      // `configured: true` + `parked: true`: the block exists (written by the
      // supervisor, as for zephyr) but the sandbox wallet has NO Zano account
      // ("not imported" on the Settings card), so there was no host
      // simplewallet to lease when the node started and the coin was parked
      // for the session. This is the one row that renders the DEX-coins
      // "parked this session" hint and the one host-wallet coin the P2P
      // picker must NOT list while the node is up.
      { coin: "zano", ticker: "ZANO", enabled: true, binaryPresent: true,
        configured: true, adoption: "deposit", descriptorsImported: false,
        mode: "full", configuredMode: "full", canRunLean: false,
        shareWalletDeclined: false, fullDiskGb: 0, parked: true },
    ];
  }
  return dexCoinsState;
}

/** Rust `est_disk_gb`, mirrored: the mode the node WILL run wins over the
 *  requested one, and a lean coin costs nothing. */
function dexDiskGb(c: DexCoinMock): number {
  const effective = c.configuredMode ?? c.mode;
  return effective === "lean" && c.canRunLean ? 0 : c.fullDiskGb;
}

function dexCoinRows(): unknown[] {
  return dexCoins().map((c) => ({
    coin: c.coin,
    ticker: c.ticker,
    enabled: c.enabled,
    binaryPresent: c.binaryPresent,
    configured: c.configured,
    adoption: c.adoption,
    descriptorsImported: c.descriptorsImported,
    mode: c.mode,
    configuredMode: c.configuredMode,
    canRunLean: c.canRunLean,
    // Mirrors Rust's own derivation (`share_flags`): capable = a lean electrum
    // coin OR a host-wallet coin (monero, and since 2026-09-04 zephyr/zano —
    // REMOTE_ONLY_COINS); shares = capable, enabled and not declined.
    // Hardcoding either would let the mock disagree with the backend about
    // the very rule this screen renders.
    canShareWallet: dexCanShare(c),
    sharesWallet: dexCanShare(c) && c.enabled && !c.shareWalletDeclined,
    // Mirrors Rust: monero-only, and it tracks the CONFIG write rather than
    // consent — so a consented-but-not-yet-restarted Monero reads false here
    // exactly as it does in production. `configured` stands in for "the node
    // has started since the choice was made", which is what the real
    // `mainwalletrpcport` write is gated on. Deliberately NOT derived from
    // `adoption`: monero never reaches `accountkey`, which is the bug this
    // field exists to make unrepresentable (2026-08-21).
    xmrHostWalletActive: c.coin === "monero" && dexHostWalletActive(c),
    // The coin-agnostic twin (2026-09-04): true for any host-wallet coin
    // whose sharing landed in the config the node booted from.
    hostWalletActive: dexHostWalletActive(c),
    // Mirrors Rust `config_coin_active`: null without a block, true with one
    // whose `connection_type` is rpc/electrum, false for a parked block
    // (`connection_type: "none"` — the zano row in this scenario).
    active: c.configured ? !c.parked : null,
    // Mirrors `CoinEnableStatus.parked_reason` (2026-09-04): the supervisor's
    // own sentence for a parked coin. The sandbox's zano row parks for the
    // reason the operator's machine did on 2026-09-04 — the wallet came up
    // after the node's config write.
    parkedReason: c.configured && c.parked
      ? "the Zano wallet was not open within 45s of the start"
      : null,
    estDiskGb: dexDiskGb(c),
  }));
}

/** Rust `share_flags`'s "can share" half, mirrored. */
function dexCanShare(c: DexCoinMock): boolean {
  return (
    (c.canRunLean && (c.configuredMode ?? c.mode) === "lean") ||
    c.coin === "monero" ||
    c.coin === "zephyr" ||
    c.coin === "zano"
  );
}

/** Rust `config_host_wallet_active`, mirrored: host-wallet coins only, and
 *  it tracks the config write (`configured` stands in for "started since
 *  the choice"), not consent alone. */
function dexHostWalletActive(c: DexCoinMock): boolean {
  return (
    (c.coin === "monero" || c.coin === "zephyr" || c.coin === "zano") &&
    c.enabled &&
    c.configured &&
    // A parked coin has a block but no `mainwalletrpcport` /
    // `scratchwalletrpcport`: the host wallet was absent, so the lease
    // writer never ran. Rust reads the port, so it reads false here too.
    !c.parked &&
    !c.shareWalletDeclined
  );
}

/** Mirrors Rust's `OptInRecord`, which is what both setters return. */
function dexOptInRecord(): unknown {
  const st = sidecar();
  const coins: Record<string, unknown> = {};
  for (const c of dexCoins()) {
    coins[c.coin] = {
      enabled: c.enabled,
      at: new Date().toISOString(),
      adoption: c.adoption,
      descriptorsImportedAt: c.descriptorsImported
        ? new Date(Date.now() - 86_400_000).toISOString()
        : null,
      firstSyncStarted: c.configured,
      mode: c.mode,
    };
  }
  return { optedIn: st.optedIn, at: st.optedInAt, autostart: st.autostart, coins };
}

function dexFind(coin: unknown): DexCoinMock {
  const key = String(coin ?? "").trim().toLowerCase();
  const hit = dexCoins().find(
    (c) => c.coin === key || c.ticker.toLowerCase() === key,
  );
  if (!hit) {
    throw new Error(
      `${JSON.stringify(coin)} is not a coin the swap node can run — expected one of: ` +
        dexCoins().map((c) => c.coin).join(", "),
    );
  }
  return hit;
}

let sidecarState: SidecarMockState | null = null;

/** Lazily seed from the scenario, then keep mutating the same object so the
 *  session's opt-in / start / stop decisions persist across calls. */
function sidecar(): SidecarMockState {
  if (!sidecarState) {
    const s = scenario();
    const active = s === "swap_sidecar_active" || s === "swap_sidecar_stuck";
    const enabled = active || s === "swap_sidecar_idle";
    sidecarState = {
      optedIn: enabled,
      optedInAt: enabled
        ? new Date(Date.now() - 3 * 86_400_000).toISOString()
        : null,
      autostart: false,
      phase: active ? "healthy" : "stopped",
      failReason: "",
      configured: enabled,
      runtimeInstalled: enabled,
      walletKeySet: false,
    };
  }
  return sidecarState;
}

/**
 * The runtime stamp the card reads. Default `ok`, because a sandbox that
 * warned about its engine on every boot would train the reader to ignore the
 * one state that matters. `VITE_MOCK_ENGINE` picks another.
 */
function mockEngineIdentity() {
  const want = (
    (import.meta as unknown as { env?: Record<string, string> }).env
      ?.VITE_MOCK_ENGINE ?? "ok"
  ).trim();
  const expected = "pwnda-grove 0.18.5+p27";
  switch (want) {
    case "drift":
      return { state: "drift", stamped: "pwnda-grove 0.18.5+p26", expected };
    case "unstamped":
      return { state: "unstamped" };
    case "none":
      return { state: "noRuntime" };
    default:
      return { state: "ok", id: expected };
  }
}

/** Mirrors Rust `SidecarStatus`. `phase` is an OBJECT because `Phase` is an
 *  internally-tagged enum (`#[serde(tag = "phase")]`) — a bare string here
 *  would let a consumer ship `status.phase === "healthy"`, which can never be
 *  true against the real backend. */
function sidecarStatus(): unknown {
  const st = sidecar();
  const running =
    st.phase === "starting" || st.phase === "healthy" || st.phase === "stopping";
  return {
    phase:
      st.phase === "failed"
        ? { phase: "failed", reason: st.failReason }
        : { phase: st.phase },
    running,
    optedIn: st.optedIn,
    htmlPort: SIDECAR_HTML_PORT,
    wsPort: SIDECAR_WS_PORT,
    portOffset: 0,
    configured: st.configured,
    runtimeInstalled: st.runtimeInstalled,
    // The engine stamp. Absent from this mock until 2026-09-05, which meant
    // `EngineDriftNote` — the card's loudest state, and the one the operator
    // asked about by name — could not be reached in the sandbox at all.
    // `VITE_MOCK_ENGINE=drift|unstamped|none` selects the others.
    engine: mockEngineIdentity(),
    datadir: SIDECAR_DATADIR,
    autostart: st.autostart,
    // The coins the RUNNING node reports — Rust reads them out of the engine
    // (`activeCoins()`: every chainclient block whose `connection_type` is
    // not "none"), so this is derived from the same rows `swap_sidecar_coin_
    // status` answers from: enabled, with a block, and not parked. Until
    // 2026-09-04 this was a hand-written four-coin list with a comment that
    // had gone stale twice over (zephyr "not in DEFAULT_ENABLED_COINS", zano
    // "no binary"), and it disagreed with the dex rows on the same screen:
    // the Settings card drew a hollow `zeph` dot next to a ZEPH row that said
    // the coin was configured. One source, like the tiles.
    coins: st.configured
      ? dexCoins()
          .filter((c) => c.enabled && c.configured && !c.parked)
          .map((c) => c.coin)
      : [],
    // Coins the repo seeds no daemon binary for — derived from the rows'
    // `binaryPresent` for the same reason. (zano left this list on
    // 2026-09-04 when unit A5's patched simplewallet was built and bundled;
    // the rows already said so, this list did not.)
    coinsUnavailable: dexCoins()
      .filter((c) => !c.binaryPresent)
      .map((c) => c.coin),
  };
}

/**
 * R3 — the refusal `swap_sidecar_start` performs rather than let
 * `basicswap-prepare` mint a swap wallet nobody has a backup of.
 *
 * **Verbatim** from `swap_sidecar.rs::check_first_prepare_gate`.
 * `__tests__/sidecarStartGate.test.ts` re-reads that literal out of the Rust
 * source and goes red if the two ever drift apart.
 */
const SIDECAR_FIRST_PREPARE_REFUSAL =
  "the vault must be unlocked to create the swap wallet";

/** The part of `SwapSidecarStartArgs` (src/api/basicswap.ts) this mock reads. */
interface SidecarStartArgs {
  /** C1 BIP85 child phrase. Only its PRESENCE reaches the gate. */
  particlMnemonic?: string;
  /** Force prepare to re-run over an install that already has a config. */
  reconfigure?: boolean;
  // `network` / `xmrRpcHost` / `xmrRpcPort` are accepted and ignored: they
  // change what the node is configured WITH, never whether it refuses.
}

function sidecarStart(rawArgs?: unknown): Promise<unknown> {
  const st = sidecar();
  const args = (rawArgs ?? {}) as SidecarStartArgs;
  if (!st.optedIn) {
    // Verbatim from swap_sidecar.rs::swap_sidecar_start's first guard.
    return Promise.reject(
      new Error(
        "the BasicSwap sidecar has not been enabled — accept the setup screen first",
      ),
    );
  }
  // `Phase::is_running()` is `Starting | Healthy | Stopping` — NOT
  // `Preparing` (swap_sidecar.rs:417). Mirrored exactly, because THIS is what
  // decides whether the R3 gate below is reached at all; the old
  // `phase === "healthy"` test also let a second start re-enter prepare from
  // `starting`, a transition `Phase::can_transition` rejects.
  if (
    st.phase === "starting" ||
    st.phase === "healthy" ||
    st.phase === "stopping"
  ) {
    return Promise.resolve(sidecarStatus());
  }

  // ── R3 — refuse a FIRST prepare with no phrase to prepare it FROM ───────
  //
  // Production, in order (swap_sidecar.rs::swap_sidecar_start):
  //
  //     run_prepare = ports.run_prepare || reconfigure || !creds_present
  //     check_first_prepare_gate(run_prepare,
  //                              particl_mnemonic.is_some(),
  //                              configured.is_some())
  //       → Err  iff  run_prepare && !has_mnemonic && !config_exists
  //
  // `st.configured` is this mock's `configured_ports_in(&datadir)` — "a
  // basicswap.json exists". `ports.run_prepare` is exactly
  // `configured.is_none()` (`plan_session_ports`), so it is DERIVED here
  // rather than tracked as its own flag.
  //
  // The credsfile disjunct is not modelled and cannot change the outcome: the
  // refusal also requires `!config_exists`, and `!config_exists` already
  // forces `ports.run_prepare = true`, so `!creds_present` can only turn a
  // true into a true.
  //
  // `hasMnemonic` is `Option::is_some`, so an EMPTY STRING counts as PRESENT
  // — Tauri hands `""` across as `Some("")` and the gate opens. Treating it
  // as absent here would make the sandbox refuse where production proceeds,
  // which is the same defect as F7 with the sign flipped.
  const configExists = st.configured;
  const runPrepare = !configExists || args.reconfigure === true;
  const hasMnemonic = typeof args.particlMnemonic === "string";
  if (runPrepare && !hasMnemonic && !configExists) {
    return Promise.reject(new Error(SIDECAR_FIRST_PREPARE_REFUSAL));
  }

  st.phase = "preparing";
  st.failReason = "";
  return new Promise((resolve) => {
    setTimeout(() => {
      st.phase = "starting";
      st.configured = true;
      st.runtimeInstalled = true;
      setTimeout(() => {
        st.phase = "healthy";
        resolve(sidecarStatus());
      }, 2200);
    }, 900);
  });
}

function sidecarStop(): Promise<unknown> {
  const st = sidecar();
  if (st.phase === "stopped") return Promise.resolve(sidecarStatus());
  st.phase = "stopping";
  return new Promise((resolve) => {
    setTimeout(() => {
      st.phase = "stopped";
      resolve(sidecarStatus());
    }, 800);
  });
}


// ── C4 / C6 — destination-pinned sweep-back (swap_bridge.rs) ───────────
//
// The mock exists mainly to keep the SECURITY PROPERTY visible in the
// sandbox, where there is no Rust to enforce it: the destination is an
// OUTPUT of prepare, and execute takes a token plus a confirm phrase and
// nothing else. `swap_bridge_execute_sweep` below THROWS if it is handed an
// address-shaped argument, so a renderer change that starts sending one is
// caught in `dev:sandbox` and not only by the Rust test suite.

/** Per-coin stand-ins for what Rust derives from the vault seed. */
const SWEEP_DESTINATIONS: Record<string, string> = {
  bitcoin: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
  litecoin: "ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh",
  dogecoin: "DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC",
  dash: "XmN1SSdVJPvBMTgHZxTpqNbhtqE4JGZ8Wc",
  bitcoincash: "bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6",
  monero:
    "48jzTPMuJvfmBjKqLBHkPnjrocz1amjMKZeAd6dbtDAgKPFsjLtnbTeXUFdVFtn8FaLPMbe4dLTjEUggWLwFwFB3Hs6VWLd",
};

const SWEEP_COIN_KEYS: Record<string, string> = {
  btc: "bitcoin",
  ltc: "litecoin",
  doge: "dogecoin",
  dash: "dash",
  bch: "bitcoincash",
  xmr: "monero",
  part: "particl",
};

function sweepCoinKey(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const want = input.trim().toLowerCase();
  if (want === "") return null;
  if (SWEEP_COIN_KEYS[want]) return SWEEP_COIN_KEYS[want];
  return Object.values(SWEEP_COIN_KEYS).includes(want) ? want : null;
}

/** The single outstanding ticket — one slot, exactly like `SweepState`. */
let sweepTicket:
  | { token: string; coin: string; destination: string; expiresAt: number }
  | null = null;

function sweepPrepare(args: any): unknown {
  const coin = sweepCoinKey(args?.coin);
  if (!coin) throw new Error(`${JSON.stringify(args?.coin)} is not a coin the swap node can run`);
  const destination = SWEEP_DESTINATIONS[coin];
  if (!destination) {
    // Mirrors the Rust refusal: PARTICL has no account of the user's own, so
    // there is nowhere to sweep it to and the mock must not invent one.
    throw new Error(
      `no sweep destination exists for ${coin} — the wallet holds no account for it`,
    );
  }
  const sweepall = coin === "monero";
  const token = Array.from({ length: 8 }, () =>
    Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, "0"),
  ).join("");
  const expiresAt = Date.now() + 120_000;
  sweepTicket = { token, coin, destination, expiresAt };
  return {
    token,
    coin,
    destination,
    amount: sweepall ? null : "0.04182000",
    sweepall,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

function sweepExecute(args: any): string {
  // The property, enforced in the sandbox too. Nothing in `basicswap.ts`
  // sends these; if something starts to, it fails loudly here.
  for (const banned of ["address", "destination", "toAddress", "to"]) {
    if (args && Object.prototype.hasOwnProperty.call(args, banned)) {
      throw new Error(
        `swap_bridge_execute_sweep must never receive a ${banned} — the ` +
          "destination is derived backend-side (contract R13)",
      );
    }
  }
  const t = sweepTicket;
  if (!t) throw new Error("no sweep is prepared — prepare one first");
  if (args?.token !== t.token) throw new Error("that sweep token is not the prepared one");
  if (Date.now() >= t.expiresAt) {
    sweepTicket = null;
    throw new Error("this sweep expired after 120 seconds — prepare a new one");
  }
  if (String(args?.confirmPhrase ?? "").trim() !== t.destination.slice(-6)) {
    throw new Error(
      "the confirmation does not match — type the last 6 characters of the destination shown on the plan",
    );
  }
  sweepTicket = null; // single use
  return "b7a1c2d3e4f5069788990aabbccddeeff00112233445566778899aabbccddeef1";
}

/** Normalize like Rust `normalize_api_path` (query stripped, `json` prefix
 *  dropped) so a caller that writes `/json/offers?x=1` and one that writes
 *  `offers` land on the same arm.
 *
 *  The traversal / percent-encoding / backslash rejections are mirrored with
 *  the backend's own wording rather than left to fall through to the
 *  allow-list: a percent-encoded dot-segment is refused for a reason the
 *  allow-list cannot express (it decodes to `..` inside the URL parser, AFTER
 *  a literal `..` check would have run — see `normalize_api_path`'s doc
 *  comment and the PROBE trace in it), and a mock that answers those with a
 *  generic "not on the allow-list" would hide which barrier actually fired. */
function sidecarPathSegs(raw: unknown): string[] {
  const p = String(raw ?? "").trim();
  if (p.length === 0) throw new Error("empty API path");
  if (p.includes("://")) throw new Error("absolute URLs are not accepted");
  if (p.includes("\\"))
    throw new Error("backslashes are not accepted in an API path");
  const segs: string[] = [];
  for (const seg of p.split(/[?#]/)[0].split("/")) {
    const s = seg.trim();
    if (s.length === 0 || s === ".") continue;
    if (s.includes("%"))
      throw new Error(
        "percent-encoding is not accepted in an API path (it decodes to a dot-segment inside the URL parser, after this check would have run)",
      );
    if (s === "..") throw new Error("path traversal is not accepted");
    if (!/^[A-Za-z0-9._-]+$/.test(s))
      throw new Error(`unexpected character in API path segment "${s}"`);
    segs.push(s);
  }
  if (segs[0]?.toLowerCase() === "json") segs.shift();
  return segs;
}

/** The Rust proxy refuses these in ANY segment position, case-insensitively
 *  (`DENIED_ENDPOINTS`). Mirrored so the sandbox demonstrates the refusal
 *  instead of silently answering a request that would be blocked in the real
 *  app — a mock that is more permissive than production is a trap. */
const SIDECAR_DENIED = [
  "getcoinseed", "setpassword", "unlock", "lock", "withdraw", "createutxo",
  "nextdepositaddr", "reseed", "rescan", "newstealthaddress", "newmwebaddress",
  "convertmweb", "watchaddress", "fixseedid", "new", "revokeoffer", "vacuumdb",
  "generatenotification", "readurl", "electrumdiscover", "getsubfeebidtx",
];

/** Fixed-dp string, matching upstream's `format_amount` (XMR/ZEPH 12, the
 *  bitcoin-family 8). */
function amt(v: number, dp: number): string {
  return v.toFixed(dp);
}

/** 56-hex-char object id — upstream ids are 28 bytes and Rust's `is_object_id`
 *  requires exactly that length, so a shorter placeholder would be refused by
 *  the real allow-list. */
function sidecarId(seed: string): string {
  const a = hashStr(seed).toString(16).padStart(8, "0");
  const b = hashStr(seed + "|b").toString(16).padStart(8, "0");
  const c = hashStr(seed + "|c").toString(16).padStart(8, "0");
  const d = hashStr(seed + "|d").toString(16).padStart(8, "0");
  const e = hashStr(seed + "|e").toString(16).padStart(8, "0");
  const f = hashStr(seed + "|f").toString(16).padStart(8, "0");
  const g = hashStr(seed + "|g").toString(16).padStart(8, "0");
  return (a + b + c + d + e + f + g).slice(0, 56);
}

/**
 * The resting offer book.
 *
 * The rate ladder is the point. Every offer's implied rate is a fixed
 * percentage off the sandbox's own market mid (XMR 162.3 / LTC 117 →
 * 1.38717949 LTC per XMR; ZEPH 1.51 / LTC 117), spanning the band the
 * execution plan measured on the live book (+0.2% to +14%, with stale bait
 * beyond). That gives the spread gate one offer per band:
 *
 *   +0.2%  GREEN  (within ~1%)
 *   +1.4%  AMBER  (~1-5%)
 *   +3.2%  AMBER
 *   +7.8%  RED    (>5% — blocked, typed override required)
 *  +14.2%  RED    (the stale-bait shape)
 *
 * Without the two red rows the block-and-override path could not be
 * demonstrated at all, and it is the safety-critical one.
 *
 * Shape follows `js_offers` (js_server.py:483-500) exactly: `coin_from` /
 * `coin_to` are COIN NAMES, not tickers; amounts and `rate` are decimal
 * strings; `rate` is denominated in `coin_to`.
 */
function sidecarOffers(): unknown[] {
  const now = Math.floor(Date.now() / 1000);
  const NETWORK_ADDR = "pwndaSandboxNetworkAddrXXXXXXXXXXXXX";
  const mk = (
    seed: string,
    coinFrom: string,
    coinTo: string,
    dpFrom: number,
    dpTo: number,
    amountFrom: number,
    rate: number,
    minBid: number,
    ageMins: number,
    addrFrom: string,
  ) => ({
    swap_type: "adaptor_sig",
    addr_from: addrFrom,
    addr_to: NETWORK_ADDR,
    offer_id: sidecarId(seed),
    created_at: now - ageMins * 60,
    expire_at: now + (60 - ageMins) * 60,
    coin_from: coinFrom,
    coin_to: coinTo,
    amount_from: amt(amountFrom, dpFrom),
    amount_to: amt(amountFrom * rate, dpTo),
    rate: amt(rate, dpTo),
    min_bid_amount: amt(minBid, dpFrom),
    is_expired: false,
    is_own_offer: false,
    is_revoked: false,
    is_public: true,
    message_nets: ["smsg"],
    auto_accept_type: 0,
    // `with_extra_info: true` fields (js_offers:539-546).
    amount_negotiable: true,
    rate_negotiable: false,
    lock_time_1: 7200,
    lock_time_2: 3600,
    feerate_from: "0.00001000",
    feerate_to: "0.00010000",
    automation_strat_id: 0,
  });

  const XMR_LTC_MID = 162.3 / 117; // 1.38717949 — sandbox price map
  const ZEPH_LTC_MID = 1.51 / 117;

  return [
    // GREEN — within ~1% of mid.
    mk("offer-green", "Monero", "Litecoin", 12, 8, 2.5, XMR_LTC_MID * 1.002, 0.05, 4, "pwndaMakerAlphaXXXXXXXXXXXXXXXXXXXX"),
    // AMBER — the ordinary working band.
    mk("offer-amber-1", "Monero", "Litecoin", 12, 8, 1.0, XMR_LTC_MID * 1.014, 0.02, 11, "pwndaMakerBravoXXXXXXXXXXXXXXXXXXXX"),
    mk("offer-amber-2", "Monero", "Litecoin", 12, 8, 0.75, XMR_LTC_MID * 1.032, 0.05, 27, "pwndaMakerCharlieXXXXXXXXXXXXXXXXXX"),
    // RED — must be BLOCKED with a typed override, never a checkbox.
    mk("offer-red-1", "Monero", "Litecoin", 12, 8, 5.0, XMR_LTC_MID * 1.078, 0.1, 52, "pwndaMakerDeltaXXXXXXXXXXXXXXXXXXXX"),
    // RED — stale-bait shape at the top of the measured band.
    mk("offer-red-2", "Monero", "Litecoin", 12, 8, 0.5, XMR_LTC_MID * 1.142, 0.01, 140, "pwndaMakerEchoXXXXXXXXXXXXXXXXXXXXX"),
    // ZEPH leg (the wallet's fork coin) — amber.
    mk("offer-zeph", "Zephyr", "Litecoin", 12, 8, 500, ZEPH_LTC_MID * 1.025, 25, 18, "pwndaMakerFoxtrotXXXXXXXXXXXXXXXXXX"),
    // Reverse direction, so a consumer cannot assume coin_from is always the
    // scriptless coin (the `bid_reversed` representation gotcha).
    mk("offer-reverse", "Litecoin", "Monero", 8, 12, 4.0, 0.7144, 0.25, 33, "pwndaMakerGolfXXXXXXXXXXXXXXXXXXXXXX"),
    // Scripted<->scripted (2026-08-22) — BasicSwap's original protocol,
    // neither leg Monero-family. Added after the operator's screenshot of
    // the node's own console showed live BTC<->LTC offers the wallet
    // refused to route to at all; this is what makes that fix reachable in
    // a browser run, and what the MIN button reads for a non-XMR pair.
    mk("offer-btc-ltc", "Bitcoin", "Litecoin", 8, 8, 0.5, 92.2, 0.02, 6, "pwndaMakerHotelXXXXXXXXXXXXXXXXXXXX"),
  ];
}

/** One in-flight bid, mid-swap. `bid_state` is the STRING upstream's
 *  `strBidState` emits, not the enum name — `XMR_SWAP_NOSCRIPT_COIN_LOCKED`
 *  (=11) renders as "Scriptless coin locked", which the execution plan's
 *  mapping table shows to the user as "Waiting for counterparty". */
function sidecarBids(): unknown[] {
  const now = Math.floor(Date.now() / 1000);
  const offers = sidecarOffers() as any[];
  const o = offers[1];
  const stuck = scenario() === "swap_sidecar_stuck";
  if (scenario() !== "swap_sidecar_active" && !stuck) return [];
  return [
    {
      bid_id: sidecarId("bid-inflight"),
      offer_id: o.offer_id,
      created_at: now - 22 * 60,
      expire_at: now + 38 * 60,
      coin_from: "Monero",
      coin_to: "Litecoin",
      amount_from: amt(0.4, 12),
      amount_to: amt(0.4 * (162.3 / 117) * 1.014, 8),
      bid_rate: amt((162.3 / 117) * 1.014, 8),
      bid_state: stuck ? "Error" : "Scriptless coin locked",
      addr_from: "pwndaSandboxBidderAddrXXXXXXXXXXXXX",
      addr_to: o.addr_to,
      tx_state_a: "Confirmed",
      tx_state_b: "Confirmed",
    },
  ];
}

/** `describeBid(..., for_api=True)` (ui/util.py:353-402). Same mid-swap state
 *  as the list row above, so a detail view opened from the list agrees with
 *  it. `state_description` is upstream's own sentence for state 11. */
function sidecarBidDetail(bidId: string): unknown {
  const now = Math.floor(Date.now() / 1000);
  const rate = (162.3 / 117) * 1.014;
  const offers = sidecarOffers() as any[];
  return {
    coin_from: "Monero",
    coin_to: "Litecoin",
    amt_from: amt(0.4, 12),
    amt_to: amt(0.4 * rate, 8),
    bid_rate: amt(rate, 8),
    ticker_from: "XMR",
    ticker_to: "LTC",
    bid_state:
      scenario() === "swap_sidecar_stuck" ? "Error" : "Scriptless coin locked",
    bid_state_ind: scenario() === "swap_sidecar_stuck" ? 23 : 11,
    state_description:
      scenario() === "swap_sidecar_stuck"
        ? "Bid error, check events for details"
        : "Both lock txs confirmed, waiting for offerer to release the LTC lock tx",
    itx_state: "Confirmed",
    ptx_state: "Confirmed",
    offer_id: offers[1].offer_id,
    addr_from: "pwndaSandboxBidderAddrXXXXXXXXXXXXX",
    addr_from_label: "",
    addr_fund_proof: null,
    created_at: now - 22 * 60,
    created_at_timestamp: now - 22 * 60,
    state_time_timestamp: now - 6 * 60,
    expired_at: now + 38 * 60,
    was_sent: true,
    was_received: false,
    initiate_tx: null,
    initiate_conf: "None",
    participate_tx: null,
    participate_conf: "None",
    show_txns: false,
    can_abandon: false,
    events: [
      { at: now - 22 * 60, desc: "Bid sent" },
      { at: now - 18 * 60, desc: "Bid accepted" },
      { at: now - 12 * 60, desc: "LTC lock tx confirmed" },
      { at: now - 6 * 60, desc: "XMR lock tx confirmed" },
    ],
    debug_ui: false,
    reverse_bid: false,
    message_nets: ["smsg"],
    bid_id: bidId,
  };
}

/** `/json/coins` (js_coins, js_server.py:103-131). Ids are upstream's `Coins`
 *  IntEnum (PART=1, LTC=3, XMR=6); ZEPH carries a placeholder id from the
 *  900+ fork band the execution plan reserves (§ Phase 0 "Coin-id band" — the
 *  real number is recorded in the harness README once picked). */
function sidecarCoins(): unknown[] {
  const st = sidecar();
  const on = st.phase === "healthy";
  return [
    { id: 1, ticker: "PART", name: "Particl", active: true, decimal_places: 8 },
    { id: 2, ticker: "BTC", name: "Bitcoin", active: false, decimal_places: 8 },
    { id: 3, ticker: "LTC", name: "Litecoin", active: on, decimal_places: 8 },
    { id: 6, ticker: "XMR", name: "Monero", active: on, decimal_places: 12 },
    { id: 7, ticker: "PART", name: "Particl Blind", active: false, decimal_places: 8, variant: "Blind" },
    { id: 8, ticker: "PART", name: "Particl Anon", active: false, decimal_places: 8, variant: "Anon" },
    { id: 18, ticker: "DOGE", name: "Dogecoin", active: false, decimal_places: 8 },
    { id: 901, ticker: "ZEPH", name: "Zephyr", active: on, decimal_places: 12 },
  ];
}

/**
 * `GET /json/wallets` — a **ticker-keyed OBJECT**.
 *
 * Upstream: `js_wallets` (js_server.py:411) falls through to
 * `getWalletsInfo({"ticker_key": True})` (basicswap.py:15559), which builds
 * `{ <TICKER>: getWalletInfo(coin) + getBlockchainInfo(coin) }`. Per-coin
 * failures land as `{name, error}` for that ticker only — the other tickers
 * survive, which is why the balances UI isolates errors per row.
 *
 * NOT the same shape as `/json/walletbalances` (see `sidecarWalletBalances`).
 * Only THIS endpoint carries `deposit_address`.
 *
 * Field set mirrors `getWalletInfo` (basicswap.py:15287-15304): the address,
 * the two decimal-string amounts, and the three booleans the C5 wallet-
 * encryption work reads (`expected_seed`, `encrypted`, `locked`).
 *
 * Note on `deposit_address`: upstream can put a human-readable PLACEHOLDER
 * here instead of an address — `"Refresh necessary"` (page_wallet.py:525),
 * `"WARNING: Unknown wallet seed"` / `"Error: unowned address"`
 * (ui/util.py:840-864). The sandbox returns real-looking addresses because
 * that is the healthy-node case; the placeholder strings are normalised to
 * `null` by `normalizeDepositAddress` in `src/api/basicswap.ts`, and that
 * mapping is unit-tested rather than mocked (a mocked placeholder would read
 * as a product bug in a UX review).
 */
function sidecarWallets(): Record<string, Record<string, unknown>> {
  const on = sidecar().phase === "healthy";
  const w = (
    name: string,
    balance: string,
    zero: string,
    blocks: number,
    deposit_address: string,
    /** Per-coin sync overrides. Omitted = fully synced when the node is up.
     *
     *  These exist because every row used to report `synced: "100.00"`, which
     *  made `syncStateOf`'s four non-synced branches unreachable in a browser
     *  run — including `not-started`, the state the user's real install was
     *  actually in (a particld at height 0 with nothing saying so). A mock
     *  that can only render the happy path cannot verify the copy that exists
     *  for the unhappy ones. */
    sync?: {
      blocks?: number;
      synced?: string;
      known_block_count?: number;
      bootstrapping?: boolean;
      connection_type?: string;
      /** Override the engine's `knownWalletSeed()` field. Default `true` —
       *  the happy path. Set `false` to reproduce the 2026-08-22 incident:
       *  a lean/C8 coin whose account key hasn't landed on the engine side
       *  yet, which the real node refuses a bid on with `"<coin> has an
       *  unexpected wallet seed and \"restrict_unknown_seed_wallets\" is
       *  enabled."` even though the wallet's own balance reads fine. */
      expected_seed?: boolean;
    },
  ) => ({
    name,
    balance: on ? balance : zero,
    unconfirmed: zero,
    immature: zero,
    blocks: sync?.blocks ?? blocks,
    synced: on ? (sync?.synced ?? "100.00") : "0.00",
    ...(sync?.known_block_count != null
      ? { known_block_count: sync.known_block_count }
      : {}),
    ...(sync?.bootstrapping ? { bootstrapping: true } : {}),
    deposit_address,
    expected_seed: sync?.expected_seed ?? true,
    encrypted: false,
    locked: false,
    connection_type: sync?.connection_type ?? "rpc",
  });
  return {
    // Mid-sync, with a target: the `syncing` branch, and the one that proves
    // the card prefers `known_block_count` over the verification percent.
    PART: w("Particl", "12.40000000", "0.00000000", 1_420_331, "PsandboxParticlDepositAddrXXXXXXXXX", {
      blocks: 412_004,
      synced: "31.40",
      known_block_count: 1_420_331,
    }),
    // Light mode: `no-chain`. A height here would be a lie — there is no
    // local chain to have one.
    LTC: w("Litecoin", "3.20000000", "0.00000000", 2_780_112, "ltc1qsandboxdepositaddrxxxxxxxxxxxxxxxxxxx", {
      blocks: 0,
      connection_type: "electrum",
    }),
    XMR: w("Monero", "0.850000000000", "0.000000000000", 3_000_000, "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A"),
    ZEPH: w("Zephyr", "14.000000000000", "0.000000000000", 1_900_000, "ZEPHYR2qjmpfgEjnpvUnmcW84J5q3uvP5Z5oc8h6F9zsTrhpFkPgsandboxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"),
  };
}

/**
 * `GET /json/walletbalances` — an **ARRAY**, not an object.
 *
 * Upstream: `js_walletbalances` (js_server.py:132-311) appends one
 * `{id, name, balance, pending, ticker, connection_type}` entry per
 * rpc/electrum-connected coin and returns the list (`:308`).
 *
 * Three differences from `/json/wallets` that this mock has to preserve or
 * the UI is being built against fiction:
 *
 *  1. It is a list. Keying it by ticker yields `{}`.
 *  2. There is **no `deposit_address`** on any entry. A deposit/receive UI
 *     cannot be built on this endpoint at all.
 *  3. **Tickers are not unique.** Particl appends PART_ANON and PART_BLIND
 *     entries that reuse `ticker: "PART"` (`:266-274`), and LTC appends an
 *     LTC_MWEB entry reusing `ticker: "LTC"` (`:298-306`). `id` is the only
 *     unique key.
 *
 * `pending` is a single combined string (unconfirmed + immature), where
 * `/json/wallets` reports `unconfirmed` and `immature` separately.
 */
function sidecarWalletBalances(): unknown[] {
  const on = sidecar().phase === "healthy";
  const bal = (v: string, zero: string) => (on ? v : zero);
  return [
    { id: 1, name: "Particl", ticker: "PART", balance: bal("12.40000000", "0.0"), pending: "0.0", connection_type: "rpc" },
    // PART_ANON / PART_BLIND: same ticker, different id. Deduping on ticker
    // silently drops or overwrites rows.
    { id: 8, name: "Particl Anon", ticker: "PART", balance: "0.0", pending: "0.0" },
    { id: 7, name: "Particl Blind", ticker: "PART", balance: "0.0", pending: "0.0" },
    { id: 3, name: "Litecoin", ticker: "LTC", balance: bal("3.20000000", "0.0"), pending: "0.0", connection_type: "rpc" },
    { id: 4, name: "Litecoin MWEB", ticker: "LTC", balance: "0.0", pending: "0.0" },
    { id: 6, name: "Monero", ticker: "XMR", balance: bal("0.850000000000", "0.0"), pending: "0.0", connection_type: "rpc" },
    { id: 901, name: "Zephyr", ticker: "ZEPH", balance: bal("14.000000000000", "0.0"), pending: "0.0", connection_type: "rpc" },
  ];
}

/**
 * The API proxy. Refuses exactly what Rust refuses (never running → error;
 * denied segment → error; unknown endpoint → error), then answers the
 * allow-listed reads.
 */
function sidecarApi(method: "GET" | "POST", rawPath: unknown, body: any): unknown {
  const st = sidecar();
  if (st.phase !== "healthy") {
    // Verbatim from swap_sidecar.rs::api_context.
    throw new Error("the swap node is not running");
  }
  const segs = sidecarPathSegs(rawPath);
  if (segs.length === 0) throw new Error("API path resolved to nothing");
  if (segs.some((s) => SIDECAR_DENIED.some((d) => s.toLowerCase() === d))) {
    throw new Error(
      `endpoint '${String(rawPath).trim()}' is not reachable through the wallet (sensitive endpoints are refused)`,
    );
  }
  const [name, ...tail] = segs;
  const nf = () =>
    new Error(
      `${method} /json/${segs.join("/")} is not reachable through the wallet (not on the read-only allow-list)`,
    );

  switch (name) {
    case "coins":
      if (method === "GET" && tail.length === 0) return sidecarCoins();
      throw nf();
    case "wallets":
      if (method !== "GET") throw nf();
      if (tail.length === 0) return sidecarWallets();
      if (tail.length === 1) {
        const w = sidecarWallets()[tail[0].toUpperCase()];
        return w ?? { error: "Unknown coin" };
      }
      throw nf();
    case "walletbalances":
      // ARRAY (js_server.py:308), NOT the ticker-keyed object /json/wallets
      // returns. Answering with the object here made every balances consumer
      // look correct in the sandbox and empty in production.
      if (method === "GET" && tail.length === 0) return sidecarWalletBalances();
      throw nf();
    case "network":
      if (method === "GET" && tail.length === 0)
        return { num_peers: 14, num_sent_network_messages: 812, num_received_network_messages: 2_904, network_addr: "pwndaSandboxNetworkAddrXXXXXXXXXXXXX" };
      throw nf();
    case "notifications":
      if (method === "GET" && tail.length === 0) return [];
      throw nf();
    case "active":
      // Upstream's in-progress-swaps summary — same single swap as /json/bids.
      if (method === "GET" && tail.length === 0) return sidecarBids();
      throw nf();
    case "rateslist":
      if (method === "GET" && tail.length === 0)
        return [{ coin_from: "XMR", coin_to: "LTC", rate: amt(162.3 / 117, 8) }];
      throw nf();
    case "offers":
    case "sentoffers": {
      const own = name === "sentoffers";
      if (tail.length === 0 && (method === "GET" || method === "POST")) {
        if (own) return [];
        const all = sidecarOffers() as any[];
        // Honour the filters the wrapper UI actually sends. Upstream matches
        // on coin id OR ticker; we match on the ticker the UI would pass.
        const want = (v: unknown) => String(v ?? "").toUpperCase();
        const nameFor: Record<string, string> = { XMR: "Monero", LTC: "Litecoin", ZEPH: "Zephyr", PART: "Particl", BTC: "Bitcoin" };
        const cf = nameFor[want(body?.coin_from)];
        const ct = nameFor[want(body?.coin_to)];
        let out = all;
        if (cf) out = out.filter((o) => o.coin_from === cf);
        if (ct) out = out.filter((o) => o.coin_to === ct);
        const limit = Number(body?.limit ?? 0);
        if (limit > 0) out = out.slice(0, limit);
        return out;
      }
      if (tail.length === 1 && method === "GET") {
        const hit = (sidecarOffers() as any[]).find((o) => o.offer_id === tail[0]);
        return hit ? [hit] : [];
      }
      throw nf();
    }
    case "bids":
    case "sentbids": {
      if (tail.length === 0 && (method === "GET" || method === "POST"))
        return sidecarBids();
      if (tail.length === 1 && method === "GET") return sidecarBidDetail(tail[0]);
      if (tail.length === 2 && tail[1] === "states" && method === "GET") {
        const now = Math.floor(Date.now() / 1000);
        return [
          [now - 22 * 60, "Sent"],
          [now - 18 * 60, "Accepted"],
          [now - 12 * 60, "Script coin locked"],
          [now - 6 * 60, "Scriptless coin locked"],
        ];
      }
      throw nf();
    }
    case "rate":
    case "rates": {
      if (method !== "POST" || tail.length > 0) throw nf();
      // js_rate:978-1001 — with a rate it returns the derived amount, else the
      // rate implied by the two amounts.
      if (body?.rate != null && body?.amt_from != null)
        return { amount_to: amt(Number(body.amt_from) * Number(body.rate), 8) };
      if (body?.rate != null && body?.amt_to != null)
        return { amount_from: amt(Number(body.amt_to) / Number(body.rate), 12) };
      const af = Number(body?.amt_from ?? 1);
      const at = Number(body?.amt_to ?? 1);
      return { rate: amt(af === 0 ? 0 : at / af, 8) };
    }
    case "validateamount": {
      if (method !== "POST" || tail.length > 0) throw nf();
      // js_validateamount:1333-1359 returns a BARE JSON STRING, not an object.
      const coin = String(body?.coin ?? "XMR").toUpperCase();
      const dp = coin === "XMR" || coin === "ZEPH" ? 12 : 8;
      const raw = Number(body?.amount ?? 0);
      const m = String(body?.method ?? "none");
      const step = Math.pow(10, -dp);
      const v = m === "rounddown" ? Math.floor(raw / step) * step : raw;
      return amt(v, dp);
    }
    case "offerfeeestimate": {
      if (method !== "POST" || tail.length > 0) throw nf();
      // js_offer_fee_estimate:1004-1038.
      const coin = String(body?.coin_from ?? "XMR").toUpperCase();
      if (coin === "XMR" || coin === "ZEPH")
        return { coin_from: coin, fee: "0.000212340000", fee_rate: "0.000019200000", fee_src: "estimatefee" };
      return { coin_from: coin, fee: "0.00002240", fee_rate: "0.00001000", fee_src: "estimatefee" };
    }
    default:
      throw nf();
  }
}

// ---------------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------------

const MOCKS: Record<string, (args: any) => unknown> = {
  // Plugin namespace
  "plugin:opener|open_url": () => null,

  // Mining: status + setup
  check_miners_exist: () => minerStatuses(),
  check_defender_exclusions: () => true,
  download_miners: () => null,
  delete_miners: () => null,
  add_defender_exclusions: () => true,
  get_miner_window_visible: () => false,
  set_miner_window_visible: (args: any) => !!args?.visible,
  scan_msr_environment: () => hashrateFixPlan(),
  msr_hard_reset: () => hashrateFixPlan(),

  // Mining: device discovery
  get_cpu_info: () => cpuInfo(),
  get_gpu_info: () => gpuInfo(),
  get_cpu_thread_count: () => 32,

  // Mining: lifecycle
  is_mining: () =>
    cpuMiningActive() ||
    scenario() === "cpu_gpu_mining_active" ||
    scenario() === "degraded",
  is_gpu_mining: () =>
    scenario() === "gpu_mining_active" ||
    scenario() === "cpu_gpu_mining_active",
  start_xmrig: () => null,
  start_gpu_miner: () => null,
  stop_xmrig: () => null,
  stop_gpu_miner: () => null,
  run_xmrig_benchmark: () => ({ hashrate: 7250, durationSecs: 30 }),

  // Mining: live snapshots
  get_xmrig_snapshot: () => xmrigSnapshot(),
  get_gpu_miner_snapshot: () => gpuSnapshot(),

  // Mining: pool integrations
  fetch_pool_stats: () => minerStats(),
  ping_pools: (args: any) => pingResults(args?.reqs),
  ping_pools_via_proxy: (args: any) => pingResults(args?.reqs),
  proxy_refresh: () => ({
    validated: [],
    candidatesFetched: 0,
    candidatesValidated: 0,
    workingCount: 0,
    lastRefreshAtMs: Date.now(),
    target: { host: "pool.example", port: 3333, ssl: false },
    sources: [],
    error: null,
  }),

  // Swap proxy auth surface — `swap_proxy_get_status` returning
  // `undefined` was crashing `App.tsx::useProxyInit` with
  // "Cannot read properties of undefined (reading 'enrolled')".
  swap_set_proxy_url: () => null,
  swap_proxy_get_status: () => ({
    url: null,
    pubkey: null,
    enrolled: false,
    enrolledAt: null,
    clockOffsetSecs: 0,
  }),
  swap_proxy_get_pubkey: () => "",
  swap_proxy_enroll: () => ({
    enrolled: false,
    already: false,
    status: 503,
    body: "sandbox: proxy enrollment not available in mock mode",
  }),
  swap_proxy_test_connection: () => ({
    healthz: { status: 503, body: "sandbox-no-network", error: null },
    tokens: { status: 503, body: "sandbox-no-network", error: null },
  }),
  // Renamed in Round 1 close-out (2026-05-26). Both names mock to the
  // same shape so a deprecated-alias caller and the new canonical
  // caller see the same response. The `full` parameter is accepted
  // but ignored in mock mode — the sandbox has nothing to return for
  // either truncation mode.
  swap_proxy_health_check: () => ({
    healthz: { status: 503, body: "sandbox-no-network", error: null },
    tokens: { status: 503, body: "sandbox-no-network", error: null },
  }),

  // HTTP proxy — URL-dispatched so price providers and chain explorers
  // get realistic responses; anything unmatched 503s loudly. See the
  // `httpProxyDispatch` doc block for the matched URL patterns and the
  // false-positive triage rule above for why we don't catch-all.
  http_proxy_call: (args: any) => httpProxyDispatch(args),

  // SOL RPC stays a blanket 503 — Solana failures are scoped to the SOL
  // adapter (one row in the wallet list) and do not break panels.
  // SOL RPC — dispatched by JSON-RPC method (getBalance returns a funded
  // value under wallet_populated/degraded; else 0). Was a blanket 503.
  sol_rpc_call: (args: any) => solRpcDispatch(args),

  // Swap session surface — without these the Swap panel crashes the
  // moment any quote/build code path runs. Signed payloads are fake;
  // broadcast also resolves locally so nothing leaves the sandbox.
  swap_unlock: () => ({
    sessionId: FAKE_SESSION_ID,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  }),
  swap_lock: () => null,
  swap_get_addresses: () => FAKE_ADDRESSES,
  swap_get_utxo_address: () => FAKE_ADDRESSES.btc,
  swap_get_solana_address: () => FAKE_ADDRESSES.sol,
  swap_get_near_address: () => ({
    accountId: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    publicKey: FAKE_ADDRESSES.near,
  }),
  swap_get_stellar_address: () => "GSANDBOXSTELLARADDRESSNOTREALXXXXXXXXXXXXXXXXXXXXXX",
  swap_get_sui_address: () => "0xsandboxsuiaddressnotrealxxxxxxxxxxxxxxxxxxxxxxxxxx",

  swap_get_quote: () => swapKitQuote(),
  swap_build_tx: () => swapKitBuildTx(),
  swap_track: () => ({ status: "pending", legs: [] }),

  intents_quote: (args: any) => intentsQuote(args),
  intents_deposit_submit: () => ({ ok: true }),
  intents_status: () => ({ status: "PENDING_DEPOSIT" }),

  // Signing — return fake-but-shape-valid blobs. We don't actually
  // broadcast anything in the sandbox.
  swap_sign_evm: () => ({ rawTx: "0xdeadbeef" }),
  swap_sign_psbt: () => ({ rawTx: "70736274ff0100..." }),
  swap_sign_near_intent: () => ({
    standard: "nep413",
    payload: {
      message: "sandbox-message",
      nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      recipient: "intents.near",
    },
    publicKey: FAKE_ADDRESSES.near,
    signature: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  }),
  swap_sign_near_tx: () => "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  swap_sign_solana: () => ({
    publicKey: FAKE_ADDRESSES.sol,
    signature: "1111111111111111111111111111111111111111111111111111111111111111",
  }),
  swap_sign_stellar_tx: () => ({ rawTx: "AAAAAAAA" }),
  swap_sign_sui_tx: () => ({ rawTx: "0x00" }),

  swap_broadcast: () => "0xsandboxtxhashnotrealxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  swap_evm_broadcast_verified: () => ({
    txHash: "0xsandboxtxhashnotrealxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    verifiedAt: new Date().toISOString(),
  }),
  swap_log_safety_incident: () => null,

  // Proxy pool state — `useProxyPool` reads this on mount before any
  // refresh has run. Returning null is the documented "no state yet"
  // shape and the UI handles it (renders "no working pools" hint).
  proxy_get_state: () => null,

  // Pool min-payout (per-pool registry lookup). Realistic-ish defaults
  // so the SESSION card's "next payout in" affordance computes a number.
  fetch_pool_min_payout: (args: any) => {
    const id = String(args?.poolId ?? "");
    const minXmr = id.startsWith("xmr") ? "0.004" : id.startsWith("zph") ? "0.1" : "0.01";
    return { minPayout: minXmr, currency: id.split("-")[0] ?? "xmr" };
  },

  // MSR env cache reader (used by Settings → diagnostics). Returns
  // whatever scan_msr_environment most recently synthesized.
  get_msr_environment: () => hashrateFixPlan(),
  get_miners_dir_path: () =>
    "C:\\Users\\sandbox\\AppData\\Local\\com.pwnda.wallet.sandbox-dev\\miners",

  // FILES ON DISK settings card — data-location paths + folder opener.
  get_data_locations: () => {
    const base = "C:\\Users\\sandbox\\AppData\\Roaming\\com.pwnda.wallet";
    return {
      dataDir: base,
      miners: `${base}\\miners`,
      moneroDaemon: `${base}\\monero`,
      zephyrDaemon: `${base}\\zephyr`,
      xmrWallets: `${base}\\xmr-wallets`,
      zphWallets: `${base}\\zph-wallets`,
    };
  },
  open_data_location: () => null,

  // Background wallet-rpc sidecar updater (sidecar_update.rs). Monero is shown
  // mid-reconcile — installed v0.18.5.0 with a newer v0.18.5.1 shipped in the
  // installer — so the "in use / shipped" divergence branch actually renders
  // in the sandbox. Zephyr is dormant (never opened), which is the other
  // branch. Between them the card's two states are both covered.
  sidecar_update_status: () => ({
    enabled: true,
    lastCheck: Math.floor(Date.now() / 1000) - 3 * 60 * 60,
    moneroInstalled: "v0.18.5.0",
    zephyrInstalled: null,
    moneroBundled: "v0.18.5.1",
    zephyrBundled: "v2.3.0",
  }),
  sidecar_update_set_enabled: () => null,
  sidecar_update_check_now: () => null,

  // ── Swap desk (pwnda-desk) ────────────────────────────────────────────
  // Mirrors the `-dev` desk's shapes so the router tab + the 8.1 tracker can
  // be built and screenshotted with no backend. The numbers are lifted from
  // the reference wire trace (0.1 XMR -> 27 ADA at mid 300, markup 0.10), so
  // what the sandbox renders lines up with what the real oracle returns.
  // Pair enablement mirrors config.harness.yaml: ADA + LTC on, AVAX gated.
  // CC-25: the sandbox's sizing verdict. Mirrors the live desk's XMR/ADA
  // window (0.12-0.5 XMR, fee-erosion) so the in-app surface can be verified
  // without a desk. `unknown` is deliberately non-empty for an out-of-range
  // amount below, so the could-not-look caveat has a way to render.
  desk_size_check: (args?: Record<string, unknown>) => {
    const amount = Number((args?.amount as string) ?? "0");
    const coin = (args?.amountCoin as string) ?? "XMR";
    // Mirrors the LIVE desk: XMR/ADA is fully measured (`unknown: []`), while
    // the halted pairs carry 5-7 unlooked-up inputs. Without that asymmetry the
    // sandbox could not render the could-not-look caveat at all, and the branch
    // this component treats as safety-critical would ship unverified.
    const pair = String((args?.pair as string) ?? "XMR/ADA").toUpperCase();
    const measured = pair === "XMR/ADA";
    const base = {
      min: measured ? "0.12" : "0.002",
      max: measured ? "0.5" : "0",
      coin: measured ? "XMR" : "ZEPH",
      minBasis: measured ? "fee-erosion" : "recovery",
      unknown: measured
        ? ([] as string[])
        : [
            "rate: neither leg-to-leg conversion could be established (an oracle leg is unusable, or the spread leaves nothing), so every floor and ceiling that crosses chains is unknown for this pair",
            "fee-erosion: the oracle mid is unusable, so the leader-chain fees could not be expressed in the size coin",
            "configured: min_size is unset for this pair, so the operator's own floor is absent",
          ],
      source: measured ? "sizing[SELL_FOLLOWER]" : "sizing[SELL_FOLLOWER] (empty - the desk could not size this direction)",
    };
    if (!measured) {
      return {
        ...base,
        verdict: "cannotJudge",
        message:
          "the desk could not look up 3 sizing input(s), so this window was never fully computed",
      };
    }
    if (coin.toUpperCase() !== "XMR") {
      return {
        ...base,
        verdict: "cannotJudge",
        message: `the window is denominated in XMR and the amount is in ${coin}; converting through an indicative mid would invent a bound neither side agreed to`,
      };
    }
    if (amount > 0 && amount < 0.12) {
      return {
        ...base,
        verdict: "belowMin",
        message:
          "Below the desk's minimum of 0.12 XMR. the four fixed chain bodies cost 0.0024 XMR (ADA lock=0.25 ADA claim=0.35 XMR lock=0.0002 XMR sweep=0.0002) and max_cost_fraction 0.02 caps that share of the trade",
      };
    }
    if (amount > 0.5) {
      return { ...base, verdict: "aboveMax", message: "Above the desk's maximum of 0.5 XMR for this direction." };
    }
    return { ...base, verdict: "within", message: "" };
  },
  desk_pairs: () => ({
    pairs: (
      [
        ["XMR", "ADA", 3, true],
        ["ZEPH", "ADA", 3, true],
        ["XMR", "LTC", 6, true],
        ["ZEPH", "LTC", 6, false],
        ["XMR", "AVAX", 12, false],
        ["ZEPH", "AVAX", 12, false],
      ] as const
    ).map(([follower, leader, minConfsLeader, enabled]) => ({
      pair: `${follower}/${leader}`,
      follower,
      leader,
      directions: ["SELL_FOLLOWER", "BUY_FOLLOWER"],
      deskRole: { SELL_FOLLOWER: "LEADER", BUY_FOLLOWER: "FOLLOWER" },
      minSize: follower === "XMR" ? "0.05" : "1.0",
      maxSize: follower === "XMR" ? "5.0" : "100.0",
      indicativeSpread: 0.1,
      quoteTtlSeconds: 30,
      t0Seconds: 1200,
      t1Seconds: 2400,
      t2Seconds: 3600,
      minConfsFollower: 10,
      minConfsLeader,
      enabled,
      halted: false,
    })),
    serverTime: Math.floor(Date.now() / 1000),
  }),

  desk_quote: (args: any) => {
    const pair = String(args?.pair ?? "XMR/ADA");
    const direction = String(args?.direction ?? "SELL_FOLLOWER");
    const amountIn = String(args?.amountIn ?? "0.1");
    const [follower, leader] = pair.split("/");
    // Follower priced in leader units. XMR/ADA = 300 matches the trace.
    const MID: Record<string, number> = { ADA: 300, LTC: 1.6, AVAX: 4.2 };
    const mid = MID[leader] ?? 300;
    const sell = direction === "SELL_FOLLOWER";
    const markup = 0.1;
    const effectiveMid = sell ? mid : 1 / mid;
    const rate = effectiveMid * (1 - markup);
    const n = Number(amountIn) || 0;
    return {
      quoteId: `q_mock_${pair.replace("/", "_")}_${direction}`,
      pair,
      direction,
      // The DESK's role: it leads when the user sells the follower.
      deskRole: sell ? "LEADER" : "FOLLOWER",
      coinIn: sell ? follower : leader,
      coinOut: sell ? leader : follower,
      amountIn,
      amountOut: String(Number((n * rate).toPrecision(8))),
      rate: String(Number(rate.toPrecision(8))),
      mid: String(effectiveMid),
      markup,
      sTotal: markup,
      expiresAt: Math.floor(Date.now() / 1000) + 30,
      minConfsIn: sell ? 10 : 3,
      minConfsOut: sell ? 3 : 10,
      t0Seconds: 1200,
      t1Seconds: 2400,
      t2Seconds: 3600,
    };
  },

  // Narrowed summary — deliberately carries NO key material, matching
  // desk::commands::DeskSwapSummary. See src/api/desk-rust.ts.
  desk_accept: (args: any) => {
    const now = Math.floor(Date.now() / 1000);
    // Echo the caller's pair/direction rather than hardcoding the SELL trace:
    // deskRole is the INVERSE of the client's role, and a mock that always
    // says LEADER makes the BUY_FOLLOWER half of the tracker untestable.
    const pair = String(args?.pair ?? "XMR/ADA");
    const direction = String(args?.direction ?? "SELL_FOLLOWER");
    return {
      swapId: "mock8f40ce4bde68391ba9ea1569349",
      pair,
      direction,
      deskRole: direction === "SELL_FOLLOWER" ? "LEADER" : "FOLLOWER",
      amountA: "27",
      amountB: "0.1",
      state: "ACCEPTED",
      scriptAddress: "addr_test_stub_8f40ce4b",
      chainBJointAddr: "xmr_stub_8f40ce4b",
      lockATxid: null,
      lockBTxid: null,
      t0: now + 1200,
      t1: now + 2400,
      t2: now + 3600,
      createdAt: now,
    };
  },

  // The desk_status mock ADVANCES through the 8.1 states across successive
  // calls rather than pinning one. A fixed A_LOCKED lets the tracker render but
  // never exercises the terminal transition - which is exactly the path that
  // writes completedAt / destTxHash / status into history, and the one most
  // likely to be wrong. Each call steps one state; the last two populate the
  // claim and sweep txids the tracker links to.
  desk_status: (args: any) => {
    const now = Math.floor(Date.now() / 1000);
    const id = String(args?.swapId ?? "mock8f40ce4bde68391ba9ea1569349");
    const seq = ["A_LOCKED", "B_LOCKED", "READY", "A_CLAIMED", "SETTLED"];
    const seen = (deskStatusCalls.get(id) ?? 0);
    deskStatusCalls.set(id, seen + 1);
    const state = seq[Math.min(seen, seq.length - 1)];
    const idx = seq.indexOf(state);
    return {
      swapId: id,
      state,
      lockATxid: "12161ff2a2c4b8e1d9f3a7c05b2e8d41",
      lockBTxid: idx >= 1 ? "639e0330d5a1c7b4e2f8096a3d5c1b77" : "",
      claimATxid: idx >= 3 ? "037cc5860d94f2a1b6e3c8d07f4a2b95" : "",
      sweepBTxid: idx >= 4 ? "f3a8be7c52d16a09c4b7e2f81a3d5906" : "",
      refundTxid: "",
      reclaimTxid: "",
      confsA: idx >= 1 ? 6 : 3,
      confsB: idx >= 2 ? 12 : 0,
      minConfsA: 3,
      minConfsB: 10,
      t0Remaining: Math.max(0, 900 - idx * 200),
      t1Remaining: Math.max(0, 2100 - idx * 200),
      readyAck: idx >= 2,
      updatedAt: now,
      error: "",
    };
  },

  desk_abort: (args: any) => ({
    swapId: String(args?.swapId ?? ""),
    state: "ABORTED",
    reservationReleased: true,
  }),

  // Empty on a fresh sandbox; the funded scenario seeds one in-flight swap so
  // the restart-rehydrate path in the tracker has something to render.
  desk_list_active: () => {
    if (scenario() !== "wallet_populated") return [];
    const now = Math.floor(Date.now() / 1000);
    return [
      {
        swapId: "mock8f40ce4bde68391ba9ea1569349",
        pair: "XMR/ADA",
        direction: "SELL_FOLLOWER",
        deskRole: "LEADER",
        amountA: "27",
        amountB: "0.1",
        state: "A_LOCKED",
        scriptAddress: "addr_test_stub_8f40ce4b",
        chainBJointAddr: "xmr_stub_8f40ce4b",
        lockATxid: "12161ff2a2c4b8e1d9f3a7c05b2e8d41",
        lockBTxid: null,
        t0: now - 300,
        t1: now + 2100,
        t2: now + 3300,
        createdAt: now - 300,
      },
    ];
  },

  // Raw hashrate getters (legacy callers that don't take the full snapshot)
  get_xmrig_hashrate: () =>
    cpuMiningActive() ? 7300 : null,
  get_gpu_miner_hashrate: () =>
    scenario() === "gpu_mining_active" ||
    scenario() === "cpu_gpu_mining_active"
      ? 115_000_000
      : null,

  // GPU benchmark — same shape as the CPU benchmark mock.
  run_gpu_miner_benchmark: () => ({ hashrate: 42_500_000, durationSecs: 60 }),

  // Frontend memory-trace export sink (no-op in the browser sandbox; the
  // real backend appends to mem-frontend-*.jsonl in a debug build).
  mem_frontend_log: () => null,
  // Native process-tree memory watchdog snapshot (mem_watch.rs). The
  // native tree RSS is the number the JS-heap trace can't see — see
  // [[webview2-memory-management]] § Round 3.
  // Deliberately NOT `cpuMiningActive()`: this fixture models the
  // long-session RSS growth from [[webview2-memory-management]] Round 3,
  // which is about the 24-hour scenario specifically, not about any CPU
  // session being live.
  mem_watch_status: () =>
    scenario() === "mining_active_24hr"
      ? {
          t: Date.now(),
          mainMb: 86.4,
          treeMb: 980.7,
          webviewMb: 902.3,
          procCount: 9,
          emitTotal: 0,
          emitTop: "",
        }
      : {
          t: Date.now(),
          mainMb: 72.1,
          treeMb: 414.8,
          webviewMb: 351.2,
          procCount: 8,
          emitTotal: 0,
          emitTop: "",
        },

  // Secure RNG / generic
  generate_seed_entropy: (args: any) => {
    const n: number = args?.byteCount ?? 32;
    const out: number[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = (i * 31 + 7) & 0xff;
    return out;
  },

  // XMR / ZPH sidecars. In wallet_populated/degraded the sidecar reports
  // "running" and the RPC dispatch returns a funded wallet, so the privacy
  // panels can render their ACTIVE branch. Otherwise "not running" (the
  // dev-bypass derives no XMR/ZPH seed) and the panels show "not loaded".
  xmr_rpc_is_running: () => walletFunded(),
  zph_rpc_is_running: () => walletFunded(),
  xmr_check_wallet_rpc: () => walletFunded(),
  zph_check_wallet_rpc: () => walletFunded(),
  xmr_check_defender_exclusion: () => true,
  zph_check_defender_exclusion: () => true,
  xmr_start_rpc: () => null,
  zph_start_rpc: () => null,
  xmr_stop_rpc: () => null,
  zph_stop_rpc: () => null,
  xmr_probe_node: () => ({ ok: true, height: 3_000_000, target_height: 3_000_000 }),
  zph_probe_node: () => ({ ok: true, height: 1_900_000, target_height: 1_900_000 }),
  xmr_rpc_call: (args: any) => xmrRpcDispatch(args, "xmr"),
  zph_rpc_call: (args: any) => xmrRpcDispatch(args, "zph"),

  // Zano sidecar. Same funded/not-loaded convention as XMR/ZPH above, but no
  // download/Defender mocks — Phase 1 deliberately never built
  // `zano_download_wallet_rpc` UNTIL Phase 5 (this pass), so this list
  // mirrors exactly the 8 commands actually registered in lib.rs, not a
  // superset guessed from the XMR/ZEPH template.
  zano_rpc_is_running: () => walletFunded(),
  zano_binary_status: () => true,
  zano_start_rpc: () => null,
  zano_stop_rpc: () => null,
  zano_ensure_wallet: () => true,
  zano_probe_node: () => ({ url: "http://37.27.100.59:10500", ok: true, latency_ms: 300, height: 3_834_338, error: null }),
  zano_rpc_call: (args: any) => zanoRpcDispatch(args),
  zano_download_wallet_rpc: () => null,

  // ── BasicSwap swap sidecar (swap_sidecar.rs) ──────────────────────────
  // Stateful — see the `sidecar*` block above for why `_start` resolves on a
  // delay and why `phase` is an object, not a string. The per-coin trio
  // (`_coin_status` / `_set_coin` / `_set_coin_mode`) is what makes
  // `DexCoinCard` render at all in a browser run; see `DexCoinMock`.
  /**
   * The bid write path (`src-tauri/src/swap_bid.rs`), LIVE since 2026-08-22.
   *
   * Doctrine change worth noting: the sandbox used to mirror a REFUSAL here,
   * because `bids/new` was deny-listed and the rule is "never more permissive
   * than production". Production now allows it through a dedicated command
   * that re-reads the offer and re-checks the rate — so mirroring a refusal
   * would now make the sandbox *less* capable than production and leave the
   * whole accept -> tracker path unverifiable.
   *
   * The refusals Rust makes are reproduced (unknown/expired/own offer, rate
   * drift beyond 0.01 %, size outside the offer's own bounds) so the sandbox
   * exercises the same gates rather than rubber-stamping anything sent.
   */
  /** PWNDA-PATCH-11's recovery door. Mirrors the engine's own contract: a
   *  REFUSAL is a normal 200 answer carrying `recovered: false` + a reason,
   *  not a throw — the UI has to render both, so both are reachable here.
   *  `swap_sidecar_stuck` drives the success branch. */
  // The bid janitor's on-demand sweep (2026-09-04). The sandbox has one
  // tracked swap per scenario and only `swap_sidecar_stuck` parks it in
  // Error, so the report is empty everywhere else — which is also what a
  // healthy node reports: no rows in Error means nothing to do.
  // The supervisor's own log tail (2026-09-04). Empty in the sandbox: the
  // decisions it records are made by the Rust supervisor, which does not run
  // here.
  swap_sidecar_supervisor_log: () => "",
  // The drift note's button. The sandbox never drifts (no bundle, no
  // stamp), so the honest mock is the "nothing to do" answer.
  // The fee surface (2026-09-05, collection on). Live-shaped: one paid
  // record from a BCH→XMR take, one skipped for a scriptless-only pair.
  sidecar_fees_status: () => ({
    mode: "live",
    open: 1,
    observed: 0,
    paid: 1,
    deferred: 0,
    indeterminate: 0,
    closed: 2,
    unreadable: 0,
    rateBps: 50,
    coins: [
      { ticker: "LTC", address: "ltc1q5rm7yppfc7yf7zh0ua9lm4cr6vgd5veppzalkk",
        flatAtomic: 22738, flat: "0.00022738", priceUsdAtDerivation: 43.98 },
      { ticker: "BCH", address: "bitcoincash:qrppd4xmtha3ys5cmpyus0decthtw69v8u4pntv8xc",
        flatAtomic: 546, flat: "0.00000546", priceUsdAtDerivation: 205.38 },
      { ticker: "BTC", address: "bc1q34ra2es97g8pdudkg7raqwd8ecen3rww0604l0",
        flatAtomic: 770, flat: "0.00000770", priceUsdAtDerivation: 80419 },
    ],
  }),
  sidecar_fees_history: () => [
    { bidId: "000000006a9c2c1319cae7e19a7c29f72a6ea7914291a15276cc3888",
      state: "paid", ticker: "BCH", amount: 0.00025243, notional: 0.05,
      txid: "b7c4d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0",
      at: "2026-09-05T15:45:00Z" },
    { bidId: "000000006a8b2e93ea546c74a88dac94a18298886d393054af3ee395b",
      state: "noFee", reason: "scriptlessOnly",
      detail: "XMR → LTC: the leg this wallet sent carries no script" },
  ],
  sidecar_fees_reserve: (args?: Record<string, unknown>) => {
    // 0.5% + the collection tx cost, same shape as the Rust schedule.
    const bal = Number(args?.balance ?? 0);
    if (!Number.isFinite(bal) || bal <= 0) return "0";
    return (bal * 0.005 + 0.00000243).toFixed(8);
  },
  swap_sidecar_update_engine: () =>
    "the swap engine is already the one this build expects",
  swap_sidecar_janitor_run: () => {
    const stuck = scenario() === "swap_sidecar_stuck";
    return {
      at: Math.floor(Date.now() / 1000),
      scanned: 1,
      errored: stuck ? 1 : 0,
      settled: [],
      requeued: stuck ? ["e2c84ff2b1c0f9d3a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7"] : [],
      left: [],
      capped: [],
    };
  },
  swap_sidecar_recover_bid: (args: any) => {
    const bidId = String(args?.bidId ?? "");
    if (!/^[0-9a-fA-F]+$/.test(bidId)) {
      throw new Error("that is not a valid bid id");
    }
    if (scenario() !== "swap_sidecar_stuck") {
      return {
        recovered: false,
        reason:
          "This swap is not in an error state, so there is nothing to restart.",
        state: "Scriptless coin locked",
      };
    }
    // camelCase, because this mock stands in for the RUST command, not for
    // the engine. `RecoverOutcome` is `rename_all = "camelCase"` on the way
    // out to the renderer and only ACCEPTS the engine's snake_case on the way
    // in. Returning snake_case here silently dropped `retryInSeconds` from
    // the success sentence — caught in a sandbox pass, 2026-08-25.
    return {
      recovered: true,
      stateBefore: "Error",
      state: "Script coin lock released",
      retryInSeconds: 5,
    };
  },

  swap_sidecar_place_bid: (args: any) => {
    const offerId = String(args?.offerId ?? "");
    const amount = Number(args?.amountFrom ?? 0);
    const rate = Number(args?.rate ?? 0);
    if (!/^[0-9a-fA-F]+$/.test(offerId)) {
      throw new Error(`"${offerId}" is not a valid offer id - expected hex`);
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("the bid amount must be greater than zero");
    }
    const offer = (sidecarOffers() as any[]).find((o) => o.offer_id === offerId);
    if (!offer) {
      throw new Error(
        `the swap node returned no offer for ${offerId} - it may have just expired or been withdrawn`,
      );
    }
    const offerRate = Number(offer.rate);
    if (Math.abs(rate - offerRate) / offerRate > 0.0001) {
      throw new Error(
        `the bid's rate (${rate}) no longer matches the offer's (${offerRate}) - the offer was ` +
          `re-priced or the request was altered. Nothing was sent; re-quote and review again.`,
      );
    }
    const maxReceive = Number(offer.amount_from);
    if (amount > maxReceive) {
      throw new Error(
        `that offer only has ${maxReceive} available and the bid asks for ${amount}`,
      );
    }
    const minReceive = Number(offer.min_bid_amount ?? 0);
    if (minReceive > 0 && amount < minReceive) {
      throw new Error(
        `that offer will not fill less than ${minReceive} and the bid asks for ${amount}`,
      );
    }
    return sidecarId(`bid-placed|${offerId}|${args?.amountFrom}`);
  },
  swap_sidecar_status: () => sidecarStatus(),
  swap_sidecar_opt_in: (args: any) => {
    const st = sidecar();
    st.optedIn = args?.accepted === true;
    st.optedInAt = new Date().toISOString();
    // Mirrors the Rust rule: revoking consent clears autostart, so
    // re-consenting later cannot silently start the node.
    if (!st.optedIn) st.autostart = false;
    return { optedIn: st.optedIn, at: st.optedInAt, autostart: st.autostart };
  },
  swap_sidecar_opt_in_status: () => {
    const st = sidecar();
    return { optedIn: st.optedIn, at: st.optedInAt, autostart: st.autostart };
  },
  swap_sidecar_set_autostart: (args: any) => {
    const st = sidecar();
    if (!st.optedIn) {
      throw new Error(
        "the BasicSwap sidecar has not been enabled — accept the setup screen first",
      );
    }
    st.autostart = args?.enabled === true;
    return { optedIn: st.optedIn, at: st.optedInAt, autostart: st.autostart };
  },
  swap_sidecar_start: (args: any) => sidecarStart(args),
  swap_sidecar_stop: () => sidecarStop(),
  // C3 / C7 per-coin state. The refusals below are the REAL ones from
  // `swap_sidecar_set_coin` / `decide_mode_change`, reproduced verbatim,
  // because a mock that only ever succeeds makes the error branches of the UI
  // unreachable in the sandbox — and the R20 message is itself the remedy the
  // user is supposed to read.
  // C7.1 auto-auth. The real command performs a login and opens a native
  // window, neither of which exists in a browser run — so this mocks the
  // REFUSALS, which are the branches the UI actually has to render. A mock
  // that only ever resolves would leave `openError` unreachable.
  swap_sidecar_apply_pending_coins: () => {
    const st = sidecar();
    if (!st.optedIn) throw new Error("the swap node has not been enabled");
    // The healthy no-op, which the auto-setup hook must NOT surface as an
    // error — mirrored verbatim so that branch is exercised in a browser run.
    throw new Error("every enabled coin is already set up");
  },
  swap_sidecar_push_account_keys: (args?: Record<string, unknown>) => {
    const st = sidecar();
    if (!st.optedIn) throw new Error("the swap node has not been enabled");
    if (st.phase !== "healthy") throw new Error("the swap node is not running");
    const keys = (args?.keys ?? []) as Array<{
      ticker: string;
      accountKey: string;
      expectedAddress: string;
    }>;
    // Mirrors the real command's verified-match path: a patched engine
    // re-derives the SAME address, so `shared` is true and the deposit
    // affordances disappear. LTC is deliberately returned as a MISMATCH so the
    // failure branch is reachable in a browser run — that branch is the one
    // that must never be silent, and a mock that only ever succeeds would let
    // it rot unseen.
    return keys.map((k) => {
      // A verified share flips the row's adoption, exactly as Rust records it
      // — the sandbox then renders the full loop: "will use your existing
      // wallet…" becomes "same wallet as your own" without a reload.
      if (k.ticker !== "LTC") {
        const row = dexCoins().find((c) => c.ticker === k.ticker);
        if (row) row.adoption = "accountkey";
      }
      if (k.ticker === "LTC") {
        return {
          ticker: k.ticker,
          initialized: true,
          shared: false,
          error:
            "LTC shared-wallet check FAILED: the swap node derived " +
            "ltc1qexampleenginederivedaddress but this wallet derives " +
            `${k.expectedAddress}. Shared wallets are not active for LTC.`,
        };
      }
      return { ticker: k.ticker, initialized: true, shared: true, error: null };
    });
  },
  swap_sidecar_set_wallet_key: (args?: Record<string, unknown>) => {
    const st = sidecar();
    const key = String(args?.key ?? "");
    if (!key.trim()) throw new Error("the swap wallet key cannot be empty");
    st.walletKeySet = true;
    return null;
  },
  swap_sidecar_unlock_wallets: () => {
    const st = sidecar();
    if (!st.optedIn) throw new Error("the swap node has not been enabled");
    if (st.phase !== "healthy") {
      throw new Error(
        "the swap node is not running — start it from Settings first",
      );
    }
    if (st.walletKeySet) return null;
    // No key pushed yet: mirror the real refusal so the error branch stays
    // reachable in a browser run.
    throw new Error(
      "no wallet key in this session — the vault must be unlocked, then try again",
    );
  },
  swap_sidecar_open_console: () => {
    const st = sidecar();
    if (!st.optedIn) throw new Error("the swap node has not been enabled");
    if (st.phase !== "healthy") {
      throw new Error(
        "the swap node is not running — start it from Settings first",
      );
    }
    console.log(
      "[tauri-mock] swap_sidecar_open_console: a real run opens a native " +
        "window here; the browser sandbox has none.",
    );
    return null;
  },
  swap_sidecar_coin_status: () => dexCoinRows(),
  swap_sidecar_chain_sync: () => {
    const st = sidecar();
    if (!st.optedIn || st.phase !== "healthy") return [];
    /**
     * Two fixtures, because the single mid-sync one could not fail the way
     * production did.
     *
     * Until 2026-08-28 this returned ONLY the 13.73% row, under the comment
     * "a mid-sync particl, so the sync bar renders in a browser run". That
     * made a SYNCED node unreachable — and did not even buy what it claimed:
     * `DexParticlCard`, the component holding that sync bar, is exported from
     * the barrel and unit-tested but mounted in no view, so no browser run has
     * ever rendered it (checked 2026-08-28). What the fixture actually cost:
     * the strip's `PART 100%` branch had never once rendered in the sandbox,
     * so the bug where a caught-up node sat at `PART 99%` forever stayed
     * invisible to every visual pass. It was also self-contradictory: this scenario is
     * documented as "node HEALTHY, offer book populated", and a Particl 1.9M
     * blocks behind cannot have a populated book. The fixture asserted a
     * state the rest of the scenario said was impossible.
     *
     * The synced row keeps a trailing-nines `verifiedPct` rather than a tidy
     * 100.0 ON PURPOSE: that is what a real caught-up daemon reports, and it
     * is precisely the value that floors to 99. A fixture rounded to 100
     * would make the buggy reading look correct.
     */
    const midSync = scenario() === "swap_sidecar_stuck";
    return midSync
      ? [
          { coin: "particl", ticker: "PART", blocks: 349745, headers: 2226731,
            verifiedPct: 13.73, error: null },
        ]
      : [
          { coin: "particl", ticker: "PART", blocks: 2226731, headers: 2226731,
            verifiedPct: 99.99982, error: null },
        ];
  },
  swap_sidecar_set_share_wallet: (args: any) => {
    const st = sidecar();
    if (!st.optedIn) {
      throw new Error(
        "the BasicSwap sidecar has not been enabled — accept the setup screen first",
      );
    }
    const c = dexFind(args?.coin);
    if (!c.canRunLean) {
      // The real refusal, verbatim, so the error branch is reachable in a
      // browser run rather than only in Rust's tests.
      throw new Error(
        `${c.coin} has no light mode, so there is no lean wallet to share — its ` +
          "existing funds are adopted by descriptor import instead",
      );
    }
    c.shareWalletDeclined = args?.share !== true;
    if (c.shareWalletDeclined && c.adoption === "accountkey") {
      // Withdrawing consent must clear the VERIFIED claim too, or the row goes
      // on saying "same wallet as your own" about a wallet the next start will
      // not build.
      c.adoption = "deposit";
    }
    return dexOptInRecord();
  },
  swap_sidecar_set_xmr_host_wallet: (args: any) => {
    const st = sidecar();
    if (!st.optedIn) {
      throw new Error(
        "the BasicSwap sidecar has not been enabled — accept the setup screen first",
      );
    }
    const c = dexFind(args?.coin);
    if (c.coin !== "monero") {
      // The real refusal, verbatim — the same "wrong door" message every
      // other coin should point back to swap_sidecar_set_share_wallet.
      throw new Error(
        "only Monero's wallet can be pointed at this app's own monero-wallet-rpc — every " +
          "other coin uses swap_sidecar_set_share_wallet instead",
      );
    }
    c.shareWalletDeclined = args?.share !== true;
    return dexOptInRecord();
  },
  swap_sidecar_xmr_shared_in_use: () => {
    // Read-only mock: the sandbox has no live bid feed, so this always
    // resolves false — consistent with production's own behaviour when
    // nothing is consented (the common case, always, in this sandbox).
    return false;
  },
  swap_sidecar_set_cn_host_wallet: (args: any) => {
    // The ZEPH/ZANO twin of swap_sidecar_set_xmr_host_wallet (2026-09-04),
    // with the real command's refusals verbatim so the sandbox exercises
    // the same doors: not opted in; a coin that is not a swap-node coin; and
    // any coin but zephyr/zano.
    const st = sidecar();
    if (!st.optedIn) {
      throw new Error(
        "the BasicSwap sidecar has not been enabled — accept the setup screen first",
      );
    }
    const c = dexFind(args?.coin);
    if (c.coin === "monero") {
      throw new Error(
        "Monero's wallet-rpc sharing is recorded by swap_sidecar_set_xmr_host_wallet — " +
          "this command is for zephyr and zano only",
      );
    }
    if (c.coin !== "zephyr" && c.coin !== "zano") {
      throw new Error(
        `${c.coin} has no host wallet process to share — only zephyr and zano run against ` +
          "this app's own wallet-rpc; a bitcoin-family coin shares its account key through " +
          "swap_sidecar_set_share_wallet instead",
      );
    }
    c.shareWalletDeclined = args?.share !== true;
    return dexOptInRecord();
  },
  swap_sidecar_cn_shared_in_use: (args: any) => {
    const c = dexFind(args?.coin);
    if (c.coin !== "zephyr" && c.coin !== "zano") {
      throw new Error(
        `${c.coin} does not share a host wallet process — this check is for zephyr and zano`,
      );
    }
    // No live bid feed in the sandbox — see the Monero twin above.
    return false;
  },
  swap_sidecar_set_coin: (args: any) => {
    const st = sidecar();
    if (!st.optedIn) {
      throw new Error(
        "the BasicSwap sidecar has not been enabled — accept the setup screen first",
      );
    }
    const c = dexFind(args?.coin);
    const wanted = args?.enabled === true;
    if (c.coin === "particl" && !wanted) {
      throw new Error(
        "particl carries the offer and bid transport (SMSG); the swap node cannot run without it",
      );
    }
    if (wanted && !c.binaryPresent) {
      throw new Error(
        `no daemon binary is seeded for ${c.coin}, so the swap node cannot run it — the coin ` +
          "would be written into the config and then fail to start",
      );
    }
    c.enabled = wanted;
    return dexOptInRecord();
  },
  swap_sidecar_set_coin_mode: (args: any) => {
    const st = sidecar();
    if (!st.optedIn) {
      throw new Error(
        "the BasicSwap sidecar has not been enabled — accept the setup screen first",
      );
    }
    const c = dexFind(args?.coin);
    const mode = args?.mode === "lean" ? "lean" : "full";
    if (c.coin === "particl" && mode === "lean") {
      throw new Error(
        "particl carries the offer and bid transport (SMSG), which needs a full local node — " +
          "it cannot run against a third-party server",
      );
    }
    if (mode === "lean" && !c.canRunLean) {
      throw new Error(
        `${c.coin} has no light-client option in this engine, so it always runs a local pruned ` +
          "daemon — only bitcoin and litecoin can run without a local chain",
      );
    }
    if (c.configuredMode != null) {
      if (c.configuredMode === mode) return dexOptInRecord();
      const label = (m: string) =>
        m === "lean" ? "light (no local chain)" : "a local pruned node";
      throw new Error(
        `${c.coin} was set up as ${label(c.configuredMode)} when it was first enabled, and ` +
          "the swap node cannot change an existing coin's mode — the choice is made before " +
          `a coin is enabled for the first time. (Re-creating ${c.coin} as ${label(mode)} ` +
          "from the app is not supported yet.)",
      );
    }
    c.mode = mode;
    return dexOptInRecord();
  },
  swap_sidecar_api_get: (args: any) => sidecarApi("GET", args?.path, undefined),
  swap_sidecar_api_post: (args: any) => sidecarApi("POST", args?.path, args?.body),

  // ── C4 / C6 sweep-back (swap_bridge.rs) ───────────────────────────────
  // Stateful and single-use, like the Rust `SweepState`. `_execute_sweep`
  // throws if handed an address-shaped argument — see `sweepExecute`.
  swap_bridge_prepare_sweep: (args: any) => sweepPrepare(args),
  swap_bridge_execute_sweep: (args: any) => sweepExecute(args),
  swap_bridge_next_deposit_addr: (args: any) => {
    const coin = sweepCoinKey(args?.ticker);
    if (!coin) {
      throw new Error(
        `${JSON.stringify(args?.ticker)} is not a coin the swap node can run`,
      );
    }
    if (coin !== "monero") return SWEEP_DESTINATIONS[coin] ?? "";
    // A fresh XMR SUBaddress (8-prefixed), not the primary — rotation is the
    // whole point of the call.
    const n = Math.floor(Math.random() * 1e6);
    return `8${String(n).padStart(6, "0")}BvKqLBHkPnjrocz1amjMKZeAd6dbtDAgKPFsjLtnbTeXUFdVFtn8FaLPMbe4dLTjEUggWLwFwFB3Hs6VWLd`;
  },
};

/**
 * Dispatch a single command to its mock implementation. Plugin-namespaced
 * commands (`plugin:store|...`) are handled by the dedicated branch.
 * Unknown commands resolve to `undefined` and the upstream console.info
 * surfaces the call so it's easy to extend coverage when a new view is
 * added.
 */
export function getMock<T = unknown>(cmd: string, args?: unknown): T {
  if (cmd.startsWith("plugin:store|")) {
    return pluginStore(cmd, args) as T;
  }
  const fn = MOCKS[cmd];
  if (!fn) return undefined as unknown as T;
  return fn(args) as T;
}
