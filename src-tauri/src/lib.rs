// `auth_keypair` hosts the per-install ed25519 signing primitives used by the
// swap proxy. Full-wallet only: its previous always-compiled consumer — the
// leaderboard uplink — was removed 2026-07-06 (pure-wallet cutover; archived
// in the wiki), leaving swap (itself `full`-gated) as the sole user, so the
// module now compiles only in the full build.
#[cfg(feature = "full")]
mod auth_keypair;

// Mining subsystem — compiled into every build (full wallet AND Pwnda Lite).
mod device_info;
mod miners;
mod platform;

// Encrypted binary bundles (binary-bundling-plan). Always compiled — the miner
// bundle is used by the mining subsystem (present in Pwnda Lite too); the Grove
// bundle is gated at its call sites, not here.
mod bundle;
// Fee-free per-pool Stratum dialect table + handshake builders. Extracted
// from dev_fee (2026-07-06) so pool_ping's smoke test keeps the pool-quirk
// corpus after the dev-fee removal. See pure-wallet-transition-plan.
mod pool_dialects;
mod pool_payout;
mod pool_ping;
mod pool_stats;
mod proxy_pool;

// Native process-tree memory watchdog — dev diagnostics, always compiled
// (no-op in release builds and on non-Windows). Samples the app's whole
// process-tree RSS (main + WebView2 children) to a JSONL once a minute so
// the *native* memory curve is visible without any user interaction. See
// mem_watch.rs and webview2-memory-management.md.
mod mem_watch;

// WebView2 memory-pressure control — drops the renderer to "Low" memory
// while the window is unfocused (MS-recommended mitigation for the WebView2
// renderer leak; webview2-memory-management.md Round 10). Windows-only.
mod mem_pressure;

// WebView2 renderer memory circuit-breaker — RELEASE-capable watchdog that
// reloads the webview if its renderer RSS exceeds a threshold, bounding any
// residual/future renderer leak instead of letting it OOM the host. Mining
// is backend-driven so a reload never interrupts a session. Reads the tree
// via native ToolHelp+PSAPI (no powershell spawn — works under pressure).
// Windows-only. See mem_guard.rs + the 2026-06-02 RAM-crash post-mortem.
mod mem_guard;

// Process-wide Tauri-event emit meter — dev diagnostics, always compiled.
// Counts every app.emit by event name so a native-memory leak hunt can see
// WHICH event stream is flooding the WebView2 IPC layer (surfaced in
// mem_watch's emit_total / emit_top). See emit_meter.rs and the Round 4
// 2026-05-30 leak investigation in webview2-memory-management.md.
mod emit_meter;

// On-disk data-location surfacing for the Settings UI — returns the data
// folder / wallet-RPC daemon / chain-cache / miners paths and opens any of
// them in the OS file manager. Generic + always compiled. See data_paths.rs.
mod data_paths;

// Wallet / swap / RPC modules — full wallet only. The `full` feature is on
// by default (see Cargo.toml); `cargo build --no-default-features` strips
// these from the lite build. See [[pwnda-mining-modularization]] M11.
#[cfg(feature = "full")]
mod descriptors;
#[cfg(feature = "full")]
mod desk;
// Grove runtime identity — what swap engine is actually on disk. Full-only: it
// describes the BasicSwap sidecar, which the lite build does not carry.
#[cfg(feature = "full")]
mod grove;
// The opt-in Particl chain snapshot — the difference between a ~4.5 hour first
// sync and about two minutes. Full-only for the same reason as `grove`.
#[cfg(feature = "full")]
mod snapshot;
#[cfg(feature = "full")]
mod http_proxy;
#[cfg(feature = "full")]
mod secure_random;
// The sidecar interface fee. Full-only: it watches the BasicSwap sidecar, which
// the lite build does not carry. Default OFF — see sidecar_fees::mode().
#[cfg(feature = "full")]
mod sidecar_fees;
#[cfg(feature = "full")]
mod sidecar_update;
#[cfg(feature = "full")]
mod sol_rpc;
#[cfg(feature = "full")]
mod swap;
// BasicSwap sidecar supervisor — prepare/config-gen/spawn/health/shutdown for
// an upstream BasicSwap node running natively on Windows. Full wallet only:
// Pwnda Lite never links a swap engine. See swap_sidecar.rs's module docs for
// the shutdown ladder (order is load-bearing) and the app-exit rule.
// C2 daemon-direct routing. Bitcoin-family sends are built by the SAME daemon
// wallet BasicSwap uses, so Core's own coin selection honours the engine's
// `lockunspent` reservations and the two-selector race is structurally
// impossible rather than merely unlikely. The renderer never names an RPC
// method — see swap_daemon::DAEMON_METHODS and the R7 test that keeps it shut.
#[cfg(feature = "full")]
mod swap_daemon;
// C4 / C6 — destination-pinned sweep-back and the privileged deposit-address
// rotation. The renderer can ask for a sweep but cannot say where the money
// goes: `swap_bridge_execute_sweep` has no address parameter at all, and the
// destination is derived backend-side from the vault seed (or read from our own
// monero-wallet-rpc). See swap_bridge's module docs.
#[cfg(feature = "full")]
mod swap_bridge;
// The BasicSwap bid write path. Its own module, and its own Tauri command,
// for the reason swap_bridge is: `bids/new` stays OUT of the generic API
// proxy's allow-list and IN `DENIED_ENDPOINTS`, so the only way a bid reaches
// the engine is through a door that re-reads the offer and re-checks the rate
// against it. See swap_bid's module docs.
#[cfg(feature = "full")]
mod swap_bid;
#[cfg(feature = "full")]
mod swap_sidecar;
#[cfg(feature = "full")]
mod wallet_rpc_common;
#[cfg(feature = "full")]
mod xmr_rpc;
#[cfg(feature = "full")]
mod zph_rpc;
#[cfg(feature = "full")]
mod zano_rpc;

use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // ── Mining-side state slots (always registered) ─────────────────
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(move |app| {
            // Self-update (desktop only — the plugin has no mobile impl).
            // Endpoint + minisign public key both come from tauri.conf.json
            // `plugins.updater`; the frontend drives the check
            // (src/lib/updater.ts). Nothing polls on its own.
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            // Native-memory watchdog (dev-only, Windows-only). Records the
            // process-tree RSS once a minute to `mem-native-*.jsonl` so the
            // native-leak curve is captured in the background. No-op in
            // release / non-Windows. See mem_watch.rs.
            mem_watch::start(app.handle().clone());

            // WebView2 memory-pressure: drop the renderer to Low memory while
            // the window is unfocused, restore Normal on focus (MS-recommended
            // mitigation for the renderer memory leak; #3678 + WebView2 perf
            // docs "Use memory management APIs"). Windows-only no-op elsewhere.
            mem_pressure::attach(app.handle());

            // WebView2 renderer memory circuit-breaker (RELEASE-capable):
            // if the renderer's RSS runs away (residual/future leak), reload
            // the webview to reclaim it before it OOMs the host. Mining is
            // backend-owned so the reload doesn't interrupt a session.
            // Disable with PWNDA_MEM_GUARD=0, tune with PWNDA_MEM_GUARD_MB.
            // Windows-only no-op elsewhere. See mem_guard.rs.
            mem_guard::attach(app.handle());

            // Background wallet-rpc sidecar updater. Two tiers: an offline
            // reconcile against the payload this installer shipped (which is
            // what stops an app-data copy outliving a wallet upgrade), and a
            // once-a-day upstream check for Monero. Detached, never blocks,
            // never swaps a running sidecar. See sidecar_update.rs.
            #[cfg(feature = "full")]
            sidecar_update::start(app.handle().clone());

            // Rung-3 ARM GATE: install the real (vendored) engine iff the env
            // says to, gated (explicit PWNDA_DESK_ARM + debug build + testnet
            // preset + complete config) and fail-closed-loud otherwise. Runs
            // BEFORE rehydrate below and SYNCHRONOUSLY, so a rehydrated swap sees
            // the real engine. Absent the arm env this is a no-op (stays on Mock).
            #[cfg(feature = "full")]
            desk::arm::arm_at_setup(&app.handle());

            // Resume in-flight desk swaps: reload the encrypted swap store and
            // respawn a refund watcher on each non-terminal swap's ABSOLUTE T1.
            // Detached and failure-tolerant - a swap-desk problem must never
            // block launch. Also seeds SwapState's data dir, which removes a
            // cold-launch ordering race on the TS side.
            #[cfg(feature = "full")]
            desk::rehydrate::start(app.handle().clone());

            // BasicSwap sidecar autostart. No-op unless the user ticked
            // "start with the wallet" (persisted in opt-in.json) or a dev run
            // set PWNDA_SWAP_SIDECAR_AUTOSTART. Never starts without opt-in,
            // and detaches immediately — a start can run for minutes.
            // See swap_sidecar.rs § "App-launch hook".
            #[cfg(feature = "full")]
            swap_sidecar::on_app_ready(app.handle());

            // The sidecar interface fee watcher. Self-driving by design: it
            // detects settlement and acts as a CONSEQUENCE, never on a frontend
            // call — a Rust settle_fee() invoked from TS is defeated by patching
            // the TS call site. Default OFF; PWNDA_SIDECAR_FEES=dark|live.
            #[cfg(feature = "full")]
            sidecar_fees::spawn(app.handle());

            // The bid janitor (2026-09-04): settles or re-queues swaps the
            // engine parked in BID_ERROR, after every healthy start and every
            // ten minutes. Self-driving for the same reason the fee watcher is.
            #[cfg(feature = "full")]
            swap_bid::spawn_bid_janitor(app.handle());

            Ok(())
        })
        .manage(miners::MinerProcess(Mutex::new(None)))
        .manage(miners::MinerPid(Mutex::new(None)))
        .manage(miners::MinerHandle(Mutex::new(None)))
        .manage(miners::MinerStarting(std::sync::atomic::AtomicBool::new(false)))
        .manage(miners::GpuMinerStarting(std::sync::atomic::AtomicBool::new(false)))
        .manage(miners::GpuMinerProcess(Mutex::new(None)))
        .manage(miners::MinerLogPaths::default())
        .manage(miners::MinerWindowVisible(Mutex::new(false)))
        .manage(miners::MsrEnvCache(Mutex::new(None)))
        .manage(proxy_pool::ProxyStateLock(Mutex::new(
            proxy_pool::ProxyState::default(),
        )));

    // ── Wallet / swap / RPC state slots (full wallet only) ──────────
    #[cfg(feature = "full")]
    let builder = builder
        .manage(xmr_rpc::XmrRpcChild(Mutex::new(xmr_rpc::XmrRpcInner {
            child: None,
            creds: None,
            leases: std::collections::HashSet::new(),
            starting: false,
        })))
        .manage(zph_rpc::ZphRpcChild(Mutex::new(zph_rpc::ZphRpcInner {
            child: None,
            creds: None,
        })))
        .manage(zano_rpc::ZanoRpcChild::default())
        .manage(swap::state::SwapState::new())
        // BasicSwap sidecar supervisor state. Same runtime-resolution caveat
        // as DeskWatchers below: `State<'_, SwapSidecarState>` resolves at
        // invoke time, so a missing `.manage()` here fails every
        // swap_sidecar_* command at RUNTIME, not at compile time.
        .manage(swap_sidecar::SwapSidecarState::new())
        // C4 — the ONE outstanding sweep ticket. Same invoke-time resolution
        // caveat as the states above: a missing manage here fails
        // swap_bridge_prepare_sweep / _execute_sweep at RUNTIME.
        .manage(swap_bridge::SweepState::new())
        // Stop-flag registry for the refund watchers. MUST stay in lockstep
        // with desk_status's `State<'_, DeskWatchers>` parameter: that resolves
        // at invoke time, so a missing manage here fails every poll at RUNTIME
        // rather than at compile time.
        .manage(desk::rehydrate::DeskWatchers::default());

    // ── Tauri command surface ───────────────────────────────────────
    // `#[cfg(feature = "full")]` attributes on individual commands let
    // `generate_handler!` strip them at compile time in the lite build.
    builder
        .invoke_handler(tauri::generate_handler![
            miners::check_miners_exist,
            miners::check_defender_exclusions,
            miners::add_defender_exclusions,
            miners::download_miners,
            miners::get_miners_dir_path,
            miners::get_cpu_thread_count,
            miners::start_xmrig,
            miners::scan_msr_environment,
            miners::get_msr_environment,
            miners::msr_hard_reset,
            miners::stop_xmrig,
            mem_watch::mem_watch_status,
            mem_watch::mem_frontend_log,
            data_paths::get_data_locations,
            data_paths::updater_can_self_install,
            data_paths::open_data_location,
            miners::set_miner_window_visible,
            miners::get_miner_window_visible,
            miners::is_mining,
            miners::get_xmrig_hashrate,
            miners::get_gpu_miner_hashrate,
            miners::get_xmrig_snapshot,
            miners::probe_tor_socks,
            miners::get_gpu_miner_snapshot,
            miners::run_xmrig_benchmark,
            miners::run_gpu_miner_benchmark,
            device_info::get_cpu_info,
            device_info::get_gpu_info,
            miners::start_gpu_miner,
            miners::stop_gpu_miner,
            miners::is_gpu_mining,
            miners::delete_miners,
            pool_stats::fetch_pool_stats,
            pool_payout::fetch_pool_min_payout,
            pool_ping::ping_pool,
            pool_ping::ping_pools,
            pool_ping::ping_pools_via_proxy,
            proxy_pool::proxy_refresh,
            proxy_pool::proxy_get_state,
            proxy_pool::proxy_pool_record_session_alive,
            proxy_pool::proxy_pool_record_failure,
            proxy_pool::proxy_pool_get_rotation_pool,
            // ── Wallet / swap / RPC commands (full wallet only) ──────────
            #[cfg(feature = "full")]
            xmr_rpc::xmr_start_rpc,
            #[cfg(feature = "full")]
            xmr_rpc::xmr_stop_rpc,
            #[cfg(feature = "full")]
            xmr_rpc::xmr_rpc_call,
            #[cfg(feature = "full")]
            xmr_rpc::xmr_rpc_is_running,
            #[cfg(feature = "full")]
            xmr_rpc::xmr_wallet_dir,
            #[cfg(feature = "full")]
            xmr_rpc::xmr_delete_wallet_files,
            #[cfg(feature = "full")]
            xmr_rpc::xmr_check_wallet_rpc,
            #[cfg(feature = "full")]
            xmr_rpc::xmr_download_wallet_rpc,
            #[cfg(feature = "full")]
            xmr_rpc::xmr_check_defender_exclusion,
            #[cfg(feature = "full")]
            xmr_rpc::xmr_add_defender_exclusion,
            #[cfg(feature = "full")]
            xmr_rpc::xmr_probe_node,
            #[cfg(feature = "full")]
            zph_rpc::zph_start_rpc,
            #[cfg(feature = "full")]
            zph_rpc::zph_stop_rpc,
            #[cfg(feature = "full")]
            zph_rpc::zph_rpc_call,
            #[cfg(feature = "full")]
            zph_rpc::zph_rpc_is_running,
            #[cfg(feature = "full")]
            zph_rpc::zph_wallet_dir,
            #[cfg(feature = "full")]
            zph_rpc::zph_delete_wallet_files,
            #[cfg(feature = "full")]
            zph_rpc::zph_check_wallet_rpc,
            #[cfg(feature = "full")]
            zph_rpc::zph_probe_node,
            #[cfg(feature = "full")]
            zph_rpc::zph_download_wallet_rpc,
            #[cfg(feature = "full")]
            zph_rpc::zph_check_defender_exclusion,
            #[cfg(feature = "full")]
            zph_rpc::zph_add_defender_exclusion,
            #[cfg(feature = "full")]
            zano_rpc::zano_start_rpc,
            #[cfg(feature = "full")]
            zano_rpc::zano_stop_rpc,
            #[cfg(feature = "full")]
            zano_rpc::zano_rpc_call,
            #[cfg(feature = "full")]
            zano_rpc::zano_rpc_is_running,
            #[cfg(feature = "full")]
            zano_rpc::zano_probe_node,
            #[cfg(feature = "full")]
            zano_rpc::zano_binary_status,
            #[cfg(feature = "full")]
            zano_rpc::zano_ensure_wallet,
            #[cfg(feature = "full")]
            zano_rpc::zano_download_wallet_rpc,
            #[cfg(feature = "full")]
            sidecar_update::sidecar_update_status,
            #[cfg(feature = "full")]
            sidecar_update::sidecar_update_set_enabled,
            #[cfg(feature = "full")]
            sidecar_update::sidecar_update_check_now,
            // Swap desk (pwnda-desk). Intent + observation only — the value-moving
            // handshake stays inside the Rust core, gated on our own chain view.
            // See desk/commands.rs for why the handshake is NOT exposed here.
            #[cfg(feature = "full")]
            desk::commands::desk_pairs,
            #[cfg(feature = "full")]
            desk::commands::desk_quote,
            #[cfg(feature = "full")]
            desk::commands::desk_size_check,
            #[cfg(feature = "full")]
            desk::commands::desk_accept,
            #[cfg(feature = "full")]
            desk::commands::desk_status,
            #[cfg(feature = "full")]
            desk::commands::desk_abort,
            #[cfg(feature = "full")]
            desk::commands::desk_list_active,
            #[cfg(feature = "full")]
            desk::commands::desk_arm_status,
            #[cfg(feature = "full")]
            desk::commands::desk_proceed,
            #[cfg(feature = "full")]
            sol_rpc::sol_rpc_call,
            #[cfg(feature = "full")]
            http_proxy::http_proxy_call,
            #[cfg(feature = "full")]
            secure_random::generate_seed_entropy,
            #[cfg(feature = "full")]
            swap::commands::swap_set_proxy_url,
            #[cfg(feature = "full")]
            swap::commands::swap_proxy_get_status,
            #[cfg(feature = "full")]
            swap::commands::swap_proxy_get_pubkey,
            #[cfg(feature = "full")]
            swap::commands::swap_proxy_enroll,
            #[cfg(feature = "full")]
            swap::commands::swap_proxy_test_connection,
            #[cfg(feature = "full")]
            swap::commands::swap_proxy_health_check,
            #[cfg(feature = "full")]
            swap::commands::swap_unlock,
            #[cfg(feature = "full")]
            swap::commands::swap_lock,
            #[cfg(feature = "full")]
            swap::commands::swap_get_addresses,
            #[cfg(feature = "full")]
            swap::commands::swap_get_utxo_address,
            #[cfg(feature = "full")]
            swap::commands::swap_get_solana_address,
            #[cfg(feature = "full")]
            swap::commands::swap_get_near_address,
            #[cfg(feature = "full")]
            swap::commands::swap_get_quote,
            #[cfg(feature = "full")]
            swap::commands::swap_build_tx,
            #[cfg(feature = "full")]
            swap::commands::swap_track,
            #[cfg(feature = "full")]
            swap::commands::intents_quote,
            #[cfg(feature = "full")]
            swap::commands::intents_deposit_submit,
            #[cfg(feature = "full")]
            swap::commands::intents_status,
            #[cfg(feature = "full")]
            swap::commands::swap_sign_evm,
            #[cfg(feature = "full")]
            swap::commands::swap_sign_psbt,
            #[cfg(feature = "full")]
            swap::commands::swap_sign_near_intent,
            #[cfg(feature = "full")]
            swap::commands::swap_sign_near_tx,
            #[cfg(feature = "full")]
            swap::commands::swap_sign_solana,
            // Phase 6 + 7 (2026-05-08): Stellar + Sui signing.
            #[cfg(feature = "full")]
            swap::commands::swap_sign_stellar_tx,
            #[cfg(feature = "full")]
            swap::commands::swap_get_stellar_address,
            #[cfg(feature = "full")]
            swap::commands::swap_sign_sui_tx,
            #[cfg(feature = "full")]
            swap::commands::swap_get_sui_address,
            #[cfg(feature = "full")]
            swap::commands::swap_broadcast,
            #[cfg(feature = "full")]
            swap::commands::swap_evm_broadcast_verified,
            #[cfg(feature = "full")]
            swap::safety_log::swap_log_safety_incident,
            // BasicSwap sidecar. The API proxy injects auth server-side and
            // refuses the sensitive endpoint set (getcoinseed / setpassword /
            // unlock / lock) — see swap_sidecar::DENIED_ENDPOINTS for why
            // those can never be reachable from the webview.
            #[cfg(feature = "full")]
            swap_sidecar::swap_sidecar_status,
            // The Particl chain snapshot. Gated individually — `#[cfg]` binds to
            // the next item only, and two unguarded lines here is precisely what
            // BOUNDARIES.md's backend rule forbids. Caught by
            // `cargo check --no-default-features`, which is why that gate exists.
            #[cfg(feature = "full")]
            snapshot::swap_snapshot_offer,
            #[cfg(feature = "full")]
            snapshot::swap_snapshot_restore,
            #[cfg(feature = "full")]
            swap_sidecar::swap_sidecar_opt_in,
            #[cfg(feature = "full")]
            swap_sidecar::swap_sidecar_opt_in_status,
            #[cfg(feature = "full")]
            swap_sidecar::swap_sidecar_install_bundled,
            #[cfg(feature = "full")]
            swap_sidecar::swap_sidecar_update_engine,
            #[cfg(feature = "full")]
            swap_sidecar::swap_sidecar_set_autostart,
            // C7.1 auto-auth: pwnda logs in and opens the console already
            // authenticated, so the credential stays (it is the only defence
            // against OTHER local accounts) but the user never handles it.
            #[cfg(feature = "full")]
            swap_sidecar::swap_sidecar_open_console,
            #[cfg(feature = "full")]
            swap_sidecar::swap_sidecar_console_trace,
            #[cfg(feature = "full")]
            swap_sidecar::swap_sidecar_start,
            #[cfg(feature = "full")]
            swap_sidecar::swap_sidecar_stop,
            #[cfg(feature = "full")]
            swap_sidecar::swap_sidecar_api_get,
            #[cfg(feature = "full")]
            swap_sidecar::swap_sidecar_api_post,
            // C5 wallet encryption. ONE command, and it carries no key OUT:
            // it only hands the session key in. The engine's own `unlock` /
            // `setpassword` endpoints stay on DENIED_ENDPOINTS and remain
            // unreachable from the webview.
            //
            // F4: the wallet-password *rotation* command was removed from this
            // list. It took the new password verbatim from the renderer, which
            // is the effect of the denied `setpassword` endpoint by another
            // name, and after C3.5 that password is all that protects the
            // user's account xprv inside the node's wallet.dat. There is no
            // backend-side derivation that fixes it (the only correct source of
            // the key is the vault phrase, which Rust deliberately never sees),
            // so the capability is now a crate-private helper with no IPC door.
            // See swap_sidecar::rotate_wallet_password's docs for the full
            // argument, and the test that keeps this list honest.
            #[cfg(feature = "full")]
            swap_sidecar::swap_sidecar_set_wallet_key,
            // C5.1 on-demand unlock: autostart is always keyless, so an
            // autostarted node sits locked until a keyed start — or this.
            #[cfg(feature = "full")]
            swap_sidecar::swap_sidecar_unlock_wallets,
            // C8: hand the engine the wallet's own account keys so a LEAN
            // BTC/LTC wallet is the user's wallet rather than a second one to
            // deposit into. The keys travel renderer -> Rust -> engine and are
            // held nowhere; `pwndasetaccountkey` is on DENIED_ENDPOINTS so the
            // console proxy cannot reach the same door. Each push is verified
            // by comparing the engine's derived address against the wallet's,
            // and a coin is recorded as adopted only when they agree.
            #[cfg(feature = "full")]
            swap_sidecar::swap_sidecar_push_account_keys,
            // C8 consent. Enabling a coin says "sync this chain"; sharing its
            // keys is a separate question with a separate cost, so it gets a
            // separate, explicit decision. It also arms the fail-closed guard
            // BEFORE the first push, which is what keeps the engine from
            // building its own wallet on the one run where nothing else would
            // have stopped it.
            #[cfg(feature = "full")]
            swap_sidecar::swap_sidecar_set_share_wallet,
            // C9 consent — deliberately a SEPARATE toggle from the one above.
            // Monero's sharing mechanism (repoint the engine at this app's own
            // wallet-rpc) is not C8's (hand the engine an account key), and
            // monero ships enabled by default, so this field must default to
            // "never consented" or every existing install's XMR wallet would
            // be silently repointed the moment the config writer is wired to
            // the start path.
            #[cfg(feature = "full")]
            swap_sidecar::swap_sidecar_set_xmr_host_wallet,
            // C9 — the Lock Wallet / Forget Monero safety gate. Refuses (with
            // an explanation) only when consent + a running node + an
            // in-flight XMR bid all hold; fails closed on an unmeasurable bid
            // count. Read-only — this command never tears anything down
            // itself, it only tells the caller whether it is safe to.
            #[cfg(feature = "full")]
            swap_sidecar::swap_sidecar_xmr_shared_in_use,
            // C-RZ / C-RX consent (2026-09-04) — the ZEPH/ZANO twin of the
            // Monero toggle above, and a separate command for the same
            // reason: pointing the engine at this app's zephyr-wallet-rpc, or
            // starting Zano's engine-owned scratch wallet beside the app's
            // own Main, is not C8's account-key push and not C9's Monero
            // repoint. Refuses every coin but zephyr/zano by name. Until this
            // registration the activation path and the consent card both
            // existed and nothing connected them.
            #[cfg(feature = "full")]
            swap_sidecar::swap_sidecar_set_cn_host_wallet,
            // The ZEPH/ZANO twin of the Lock / Forget safety gate above. Same
            // fail-closed decision, read-only.
            #[cfg(feature = "full")]
            swap_sidecar::swap_sidecar_cn_shared_in_use,
            // Adds enabled-but-unconfigured coins. Restarts the node to do it
            // (an --addcoin needs the coin daemons stopped) and refuses while
            // any swap is in flight.
            #[cfg(feature = "full")]
            swap_sidecar::swap_sidecar_apply_pending_coins,
            // C3 per-coin DEX enablement + the selection gate. `set_coin`
            // persists intent only — the `manage_daemon` write happens through
            // apply_local_config_policy on the next start, because mutating
            // basicswap.json under a running engine changes a file it read at
            // startup and will not re-read. `selection_gate` FAILS CLOSED: an
            // unreachable node cannot prove it has nothing reserved, so a
            // persisted zero is never an allow (R9).
            #[cfg(feature = "full")]
            swap_sidecar::swap_sidecar_set_coin,
            // C7 lean/full. Same "intent only" rule, and a stricter one on top:
            // it refuses any change to a coin already in basicswap.json, since
            // the mode IS `connection_type` and run.py reads that file once.
            #[cfg(feature = "full")]
            swap_sidecar::swap_sidecar_set_coin_mode,
            #[cfg(feature = "full")]
            swap_sidecar::swap_sidecar_coin_status,
            // Chain-sync progress read DIRECTLY from each managed daemon, so it
            // stays responsive during IBD when /json/wallets times out.
            #[cfg(feature = "full")]
            swap_sidecar::swap_sidecar_chain_sync,
            #[cfg(feature = "full")]
            swap_sidecar::swap_sidecar_selection_gate,
            // C2 daemon-direct routing. Off unless PWNDA_SWAP_ROUTING=1, and a
            // broadcast on anything that is not regtest additionally needs
            // PWNDA_SWAP_ROUTING_MAINNET=1 — so a real spend cannot happen by
            // accident. Neither command takes an RPC method name: `daemon_rpc`
            // is `&'static str` + allow-list, which makes a renderer-chosen
            // method a compile error and an unlisted literal a refusal before
            // any socket opens.
            #[cfg(feature = "full")]
            swap_daemon::swap_daemon_send,
            #[cfg(feature = "full")]
            swap_daemon::swap_daemon_capabilities,
            // Reads each coin's account xpub back into <sidecar_base>/watch/ so
            // a balance can render with the node down. PUBLIC keys only:
            // `listdescriptors` is called with `[]`, never `[true]`, and every
            // key that comes back is checked against an allow-list of public
            // version prefixes before anything is written (R8).
            #[cfg(feature = "full")]
            swap_daemon::swap_daemon_capture_xpubs,
            // C3.5 zero-move adoption. Imports the USER's account descriptors
            // (m/84'/0'/0' and friends, inactive, both branches) into the swap
            // node's own coin wallet so pre-existing UTXOs become spendable
            // without an on-chain move. It refuses unless that wallet is
            // encrypted AND unlocked (R10 — after this the node's wallet.dat
            // can spend the user's existing funds) and unless the coin has not
            // yet begun syncing (R12 — a pruned node cannot rescan discarded
            // history, so a late import reports success and finds nothing).
            // Its allow-list is separate from daemon-direct routing's and
            // asserted disjoint: routing can never import a key, adoption can
            // never sign or broadcast one.
            #[cfg(feature = "full")]
            descriptors::swap_sidecar_import_descriptors,
            // C4 / C6 destination-pinned sweep-back. `wallets/<coin>/withdraw`
            // is on DENIED_ENDPOINTS (W-2) so a compromised renderer cannot
            // move coin, and these commands do not give that back: NO command
            // here takes a destination address. `execute_sweep` accepts a
            // single-use 120s token plus a confirm phrase and nothing else --
            // the destination was computed backend-side at prepare time from
            // the wallet's own derivation (or from our own monero-wallet-rpc),
            // and a coin we do not handle is a refusal rather than a guess.
            // check_endpoint is NOT widened: the engine call goes through
            // swap_bridge::api_post_privileged, a Rust-only door that asserts
            // the path shape itself, and webview_route_still_denied re-proves
            // every phase that check_endpoint ALONE still refuses
            // wallets/XMR/withdraw and wallets/XMR/nextdepositaddr.
            #[cfg(feature = "full")]
            swap_bridge::swap_bridge_prepare_sweep,
            #[cfg(feature = "full")]
            swap_bridge::swap_bridge_execute_sweep,
            #[cfg(feature = "full")]
            swap_bridge::swap_bridge_next_deposit_addr,
            // C8 — send FROM a coin's shared wallet, through the engine.
            // Gated on Adoption::AccountKey (verified, not merely consented),
            // checked before any socket opens. Unlike the sweep above, the
            // destination and amount ARE renderer-supplied — this is an
            // ordinary send, not a pinned drain — so the safety property is
            // "only a confirmed-shared coin reaches this door" rather than
            // "no address parameter exists".
            #[cfg(feature = "full")]
            swap_bridge::swap_bridge_shared_coin_withdraw,
            #[cfg(feature = "full")]
            swap_bid::swap_sidecar_place_bid,
            // Sidecar interface fee — READ-ONLY, all three. There is deliberately
            // no settle/collect command: the watcher owns the money path so that
            // removing the fee needs a Rust rebuild, not a patch to the frontend.
            #[cfg(feature = "full")]
            sidecar_fees::sidecar_fees_status,
            #[cfg(feature = "full")]
            sidecar_fees::sidecar_fees_history,
            #[cfg(feature = "full")]
            sidecar_fees::sidecar_fees_quote,
            #[cfg(feature = "full")]
            sidecar_fees::sidecar_fees_reserve,
            #[cfg(feature = "full")]
            swap_bid::swap_sidecar_recover_bid,
            #[cfg(feature = "full")]
            swap_bid::swap_sidecar_janitor_run,
            #[cfg(feature = "full")]
            swap_sidecar::swap_sidecar_supervisor_log,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Clean shutdown hook: when the user closes the window or
            // exits the app, synchronously stop both miners. Without
            // this, force-quit (clicking X, Alt+F4, etc.) leaves the
            // **elevated** xmrig process running in the background —
            // the wallet has no way to kill it on the next launch
            // because the retained `MinerHandle` ElevatedHandle dies
            // with the wallet. Observed in `dev-fee-20260513T073*`
            // logs which all lack `session_ended` events.
            //
            // `block_on` is safe here because the run-handler is sync
            // and `stop_xmrig` / `stop_gpu_miner` are fast (~100 ms
            // each — handle-based TerminateProcess + a few state slot
            // takes). The brief block is much better than leaving an
            // orphan elevated process running indefinitely.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // BasicSwap sidecar: fire-and-forget. This does NOT extend the
                // block_on below — a 120s shutdown ladder cannot live on the
                // exit path. `on_exit_requested` spawns a detached, ≤2s-budgeted
                // ladder and returns immediately; anything it doesn't finish is
                // reconciled on the next launch (orphan-now/reconcile-next,
                // the same pattern xmr/zph wallet-rpc already use). See
                // swap_sidecar.rs § "App exit".
                #[cfg(feature = "full")]
                swap_sidecar::on_exit_requested(app_handle);

                let app_handle = app_handle.clone();
                tauri::async_runtime::block_on(async move {
                    let _ = miners::stop_xmrig(
                        app_handle.clone(),
                        Some("stopped: app exiting".to_string()),
                    )
                    .await;
                    let _ = miners::stop_gpu_miner(app_handle).await;
                });
            }
        });
}
