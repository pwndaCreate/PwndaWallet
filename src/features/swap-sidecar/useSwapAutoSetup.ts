/**
 * Hand the swap node its wallet key as soon as the vault is unlocked, and
 * finish whatever that unblocks — automatically.
 *
 * # The problem this removes
 *
 * Autostart runs before any vault unlock, so it is always keyless. A keyless
 * node comes up with its wallets LOCKED and with any enabled-but-unconfigured
 * coin deferred. Both are fixable the instant the key exists — and until now
 * the user had to know that, find Settings, and click two buttons in the right
 * order ("Unlock swap wallets" before "Open advanced BasicSwap console").
 *
 * The key arriving is the event that unblocks both, so this pushes it and lets
 * the backend do the rest:
 *
 *  - `swap_sidecar_set_wallet_key` unlocks a running node itself;
 *  - `swap_sidecar_apply_pending_coins` adds enabled-but-unconfigured coins,
 *    restarting the node because `--addcoin` needs the coin daemons stopped —
 *    and refusing outright while any swap is in flight;
 *  - `swap_sidecar_push_account_keys` makes each lean coin's wallet the
 *    user's own (C8). Without it, PWNDA-PATCH-3's fail-closed guard leaves
 *    those coins with NO wallet at all.
 *
 * # Why it POLLS until the node is up (2026-08-21)
 *
 * The first version ran once per dependency change and un-latched when the
 * node was not running yet — but nothing ever re-fired it. The deps (vault
 * mnemonic, wallet addresses) settle within seconds of unlock, while the node
 * takes a minute-plus to reach Healthy, so on the operator's machine the pass
 * ran early, gave up politely, and never came back. The wallets got unlocked
 * anyway — by the manual Settings button, which pushes only the ENCRYPTION
 * key — so everything LOOKED alive while the account keys were never sent and
 * BTC/LTC sat wallet-less behind the fail-closed guard ("Expected Seed:
 * False", zero balance, a Reseed that fails). A dependency-triggered effect
 * cannot see "the node came up"; only a clock can. Hence
 * {@link AUTO_SETUP_RETRY_MS}: one LOCAL status read per tick (no network, no
 * engine traffic), stopping the moment the pass settles or the hook unmounts.
 *
 * # Why the restart half still runs once, not on the timer
 *
 * Pushing keys is idempotent but restarting the node is not. `done` latches
 * once the whole pass SETTLES — key pushed, coins applied or refused, sharing
 * answered by the backend. Only an unsettled pass (node not up yet, addresses
 * not loaded yet) re-arms the timer. A refusal is a decision, not a not-yet.
 *
 * # Why the key push is now followed by an explicit, checked unlock (2026-08-23)
 *
 * `swap_sidecar_set_wallet_key`'s own internal unlock is best-effort — it
 * eprintln!s a failure server-side and returns `Ok` regardless, so the AWAIT
 * on it always looked successful even on the run where the real
 * `unlock_wallets()` call underneath lost a race. Nothing downstream noticed:
 * `shareWallets()` still settled (its own "nothing to share" exit does not
 * depend on the node being unlocked), `done` latched, and the node sat
 * genuinely locked — `/json/wallets` answering "Wallet locked: Particl wallet
 * must be unlocked" — for the rest of the session, silently, with the only
 * recovery being the operator noticing and opening the console by hand (a
 * DIFFERENT code path that happens to call the real, error-propagating
 * `swap_sidecar_unlock_wallets`). This hook now calls that same command
 * itself right after the key push and checks its result; a failure there
 * re-arms the retry timer instead of latching, because "not unlocked yet" is
 * a not-yet, the same category as "node not running yet" above — not a final
 * answer from the backend.
 *
 * # Why unlock is called a SECOND time, after shareWallets() (2026-08-23)
 *
 * Distinct bug from the one directly above, same symptom family: a real
 * mainnet report of the confirm modal's "swap node wallet not ready" gate
 * (`assessWalletSeedReadiness`) staying red indefinitely — well past any
 * warm-up window — and clearing only when the operator opened the BasicSwap
 * console by hand. Traced to the engine's own source
 * (`upstream/basicswap/basicswap/basicswap.py`): `checkWalletSeed()` is the
 * ONLY function that ever sets `expected_seed`, and for a C8 lean coin it
 * short-circuits on `WalletManager.isInitialized(coin)` — but pushing the
 * account key (`js_pwnda_setaccountkey`, what `shareWallets()` below does)
 * calls `initializeFromAccountKey()` directly and never re-invokes
 * `checkWalletSeed()`. The ONLY automatic caller of `checkWalletSeed()` is
 * inside `unlockWallets()`, run on every `POST /json/unlock`. The FIRST
 * unlock call above (the one from the previous section) always fires BEFORE
 * `shareWallets()` has pushed the key — so by the time it ran,
 * `checkWalletSeed` found the wallet not yet initialized, cached
 * `expected_seed: false`, and NOTHING afterward ever re-triggered it. It
 * stuck false indefinitely, independent of how long the key had actually
 * been live.
 *
 * This is the full explanation for why opening the console appeared to fix
 * it: both console-open paths (`SwapView.tsx`'s `openBasicswapConsole`,
 * `SidecarStatusCard.tsx`'s equivalent) call `swapSidecarUnlockWallets()`
 * before opening the window — that unlock call, not the console window
 * itself, is what flips `expected_seed`. Calling unlock again here, right
 * after the key push settles, closes the gap without any user action.
 * Re-unlocking an already-unlocked node is a documented engine no-op, so —
 * same reasoning as the first unlock call — this runs unconditionally
 * whenever `shareWallets()` itself settled, not only when something looks
 * wrong. See `PwndaWalletVault/log.md`, 2026-08-23, for the full trace.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  swapSidecarApplyPendingCoins,
  swapSidecarCoinStatus,
  swapSidecarPushAccountKeys,
  swapSidecarSetWalletKey,
  swapSidecarStart,
  swapSidecarStatus,
  swapSidecarStop,
  swapSidecarUnlockWallets,
  UNPARK_EVENT,
  type UnparkRequest,
} from "../../api/basicswap";
import type { DerivedAccountKeys } from "../../lib/swapAccountKey";
import { recordSharePass } from "./sharePassLog";

/** How often an unsettled pass re-checks for the node. One local IPC read per
 *  tick; cleared on settle and on unmount. */
export const AUTO_SETUP_RETRY_MS = 15_000;

export interface SwapAutoSetupState {
  /** Coins added by the automatic pass, if any. */
  added: string[];
  /** Why the automatic pass could not finish. Null when it had nothing to do. */
  error: string | null;
  /** A node restart is in progress, so the UI can say why it went away. */
  applying: boolean;
  /** C8 — tickers now sharing the wallet's own account (verified: the engine
   *  derived the same address this wallet does). */
  shared: string[];
  /**
   * C8 — per-coin reasons sharing did not take effect, verbatim.
   *
   * Surfaced rather than swallowed because the two things that land here are
   * both actionable and both silent otherwise: a runtime without the
   * account-key patches, and an address mismatch (which means the engine stood
   * up a wallet nobody intended).
   */
  sharedErrors: string[];
  /**
   * What the supervisor is doing to the node right now, in the user's words —
   * today only "adding <COIN>, it restarts once". Null when nothing is
   * happening.
   *
   * Exists because the restart itself was invisible: the supervisor asks for
   * one when a parked host-wallet coin's wallet finally comes up, the hook
   * performs stop → key → start, and the only trace was a `console.warn`. The
   * operator saw the node go to STOPPING while they were using it and asked
   * why it had stopped unprompted (2026-09-05).
   */
  unparkNotice: string | null;
  /**
   * Re-run the whole pass now, latch or no latch.
   *
   * Exists for the MANUAL path: the Settings "Unlock swap wallets" button
   * proved able to outrun the automatic pass on the operator's machine — it
   * pushes the encryption key itself, so the wallets unlock and everything
   * looks done while the account keys were never sent. Wiring that button to
   * call this after its unlock makes the manual road end at the same place as
   * the automatic one.
   */
  retry(): void;
}

function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

/** What one share pass concluded. */
export interface SharePassResult {
  /** The question is answered for now — pushed (accepted or refused), or
   *  genuinely nothing to share. `false` = could not run yet; try later. */
  settled: boolean;
  /** Tickers the engine VERIFIED as sharing (derived the same address). */
  shared: string[];
  /** Per-coin refusals, verbatim. */
  errors: string[];
}

/**
 * C8 — give every enabled lean coin the wallet's own account key. Plain
 * function, no hooks, so the AUTOMATIC pass (this hook) and the MANUAL one
 * (the Settings card's Unlock button) run the SAME code — the two roads
 * diverging is exactly how the operator's coins ended up wallet-less: the
 * button unlocked the wallets and pushed nothing, while the automatic pass
 * had already given up waiting for the node.
 */
export async function runSharePass(
  deriveAccountKeys: (() => Promise<DerivedAccountKeys>) | null,
): Promise<SharePassResult> {
  if (!deriveAccountKeys) {
    console.warn("[useSwapAutoSetup] no account-key deriver yet; will retry");
    return { settled: false, shared: [], errors: [] };
  }
  const statuses = await swapSidecarCoinStatus();
  // `sharesWallet` is the effective answer (default ON once opted in, OFF only
  // on an explicit decline). The lean/capable guard stays on top of it because
  // this pushes ACCOUNT KEYS — a C8 mechanism. Monero also reports
  // sharesWallet, but shares a wallet-rpc process instead and has no account
  // key to push; without this guard it would be handed to a derivation that
  // has no path for it.
  const shareSet = new Set(
    statuses
      .filter(
        (s) =>
          s.enabled &&
          s.configured &&
          s.canRunLean &&
          s.mode === "lean" &&
          s.sharesWallet,
      )
      .map((s) => s.ticker),
  );
  // Genuinely nothing to share (no capable coin, or all declined) — settled.
  if (shareSet.size === 0) return { settled: true, shared: [], errors: [] };

  // The deriver resolves each chain's ACTUAL derivation from its own wallet
  // entry and reports coins it deliberately will not push (legacy address
  // types the engine cannot serve). Scoped here to the coins that are
  // actually set to share — a declined coin's skip reason is noise.
  const derived = await deriveAccountKeys();
  const pushes = derived.pushes.filter((k) => shareSet.has(k.ticker));
  const skipped = derived.skipped.filter((k) => shareSet.has(k.ticker));

  if (pushes.length === 0 && skipped.length === 0) {
    // Wanted to share but the wallet's own entries are not loaded yet, so
    // there is nothing to resolve against. Retry later.
    console.warn(
      `[useSwapAutoSetup] ${[...shareSet].join(",")} share the wallet but ` +
        "no wallet entry is loaded yet — not pushing; will retry",
    );
    return { settled: false, shared: [], errors: [] };
  }

  const outcomes =
    pushes.length > 0 ? await swapSidecarPushAccountKeys(pushes) : [];
  const shared = outcomes.filter((o) => o.shared).map((o) => o.ticker);
  const errors = [
    ...outcomes
      .filter((o) => o.error)
      .map((o) => `${o.ticker}: ${o.error as string}`),
    ...skipped.map((k) => k.reason),
  ];
  if (errors.length > 0) {
    // Loud on purpose: a refused push leaves the engine unable to build that
    // coin's wallet at all, which presents as an empty balance, not an error.
    console.error("[useSwapAutoSetup] account-key sharing not active:", errors);
  }
  // Settled either way — the backend answered (or the deriver decided). A
  // refusal is a decision, not a not-yet; retrying every tick would spam.
  // Recorded so the Settings card can render it. The `console.error` above is
  // for a developer with devtools open; this is for the person looking at a
  // coin whose balance will not appear. (2026-09-05: BCH's refusal existed,
  // was logged, and was seen by nobody for two days.)
  recordSharePass({ shared, errors });
  return { settled: true, shared, errors };
}

/**
 * @param optedIn   `useSwapSidecarOptIn()` — P1: nothing is invoked until true.
 * @param deriveSwapMaterial derives the wallet key from the UNLOCKED vault.
 *        Pass `null` while the vault is locked; the hook then does nothing.
 */
export function useSwapAutoSetup(
  optedIn: boolean | null,
  deriveSwapMaterial: (() => Promise<{ mnemonic: string; walletKey: string }>) | null,
  deriveAccountKeys: (() => Promise<DerivedAccountKeys>) | null = null,
): SwapAutoSetupState {
  const [added, setAdded] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [shared, setShared] = useState<string[]>([]);
  const [sharedErrors, setSharedErrors] = useState<string[]>([]);
  /** What the supervisor is doing to the node right now, in the user's words.
   *  Null when nothing is happening. Rendered by the swap surfaces. */
  const [unparkNotice, setUnparkNotice] = useState<string | null>(null);
  const done = useRef(false);
  const alive = useRef(true);
  const inFlight = useRef(false);
  const timer = useRef<number | null>(null);
  /** The CURRENT effect's attempt runner, so `retry()` can re-enter the pass
   *  after it settled without waiting for a dependency change that may never
   *  come — which is the exact failure this file exists to prevent. */
  const runRef = useRef<(() => void) | null>(null);

  // ── the unpark doorbell (2026-09-04) ──────────────────────────────────
  //
  // REGISTERED ONCE. This effect existed TWICE, verbatim, until 2026-09-05 —
  // two listeners on the same event, each with its own `busy` latch, so a
  // single unpark request ran TWO concurrent stop → key → start sequences
  // against one node. That is the "why did the swap node initiate stopping
  // unprompted" report, doubled.
  // The supervisor asks for a restart when a parked host-wallet coin's
  // wallet is up and no swap is in flight (`swap_bid.rs::unpark_tick`). It
  // cannot restart on its own: the wallet key is cleared at every stop (C5
  // hygiene), and only this unlocked app can supply it again — the same
  // stop → key → start sequence the Settings card's buttons perform. The
  // supervisor caps attempts per coin per session, so a wallet that keeps
  // failing cannot turn this into a restart loop. `listen` rejects without
  // a Tauri runtime (browser sandbox): no doorbell, not an error.
  useEffect(() => {
    if (!optedIn || !deriveSwapMaterial) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    let busy = false;
    listen<UnparkRequest>(UNPARK_EVENT, (event) => {
      const req = event.payload;
      if (!req || busy) return;
      busy = true;
      void (async () => {
        try {
          console.warn(
            `[useSwapAutoSetup] unpark: restarting the swap node to add ${req.coin} (attempt ${req.attempt} of ${req.max})`,
          );
          // Say it on screen, not only to a console nobody has open. The
          // operator watched the node go to STOPPING mid-session and asked
          // "why did the swap node initiate stopping unprompted" — it was
          // this, doing exactly what it was built to do, silently.
          setUnparkNotice(
            `Adding ${req.coin.toUpperCase()} to the swap node — it restarts once, about a minute.`,
          );
          await swapSidecarStop();
          const material = await deriveSwapMaterial();
          await swapSidecarSetWalletKey(material.walletKey);
          await swapSidecarStart();
          setUnparkNotice(null);
        } catch (e) {
          console.error("[useSwapAutoSetup] unpark restart failed:", e);
          setUnparkNotice(
            `Could not add ${req.coin.toUpperCase()} to the swap node. It will stay off until the next start.`,
          );
        } finally {
          busy = false;
        }
      })();
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* no event bus (browser sandbox) */
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [optedIn, deriveSwapMaterial]);



  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current != null) window.clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    if (optedIn !== true || !deriveSwapMaterial) {
      runRef.current = null;
      return;
    }

    /** Runs LAST, and that order is load-bearing: `applyPendingCoins`
     *  restarts the node, and the engine holds account keys in memory only —
     *  a key pushed before the restart would be gone afterwards, leaving the
     *  wallets unbuilt behind the fail-closed patch. */
    async function shareWallets(): Promise<boolean> {
      const result = await runSharePass(deriveAccountKeys);
      if (!alive.current) return false;
      if (result.settled) {
        setShared(result.shared);
        setSharedErrors(result.errors);
      }
      return result.settled;
    }

    /** One attempt. Re-arms the timer instead of giving up when the pass is
     *  not yet possible — the whole reason this is a function on a clock. */
    async function attempt(): Promise<void> {
      if (done.current || inFlight.current || !alive.current) return;
      inFlight.current = true;
      let settled = false;
      try {
        const status = await swapSidecarStatus();
        if (!status.running) {
          // Not an error and not the end: autostart may still be bringing
          // the node up, or the user may press Start later. The timer in the
          // finally block re-checks; this used to be a bare return that
          // nothing ever re-fired.
          return;
        }

        // Pushing the key unlocks a running node inside the backend — the
        // whole reason the "Unlock swap wallets" click is no longer needed.
        const material = await deriveSwapMaterial!();
        await swapSidecarSetWalletKey(material.walletKey);

        // Verify the unlock actually landed rather than trusting that push in
        // isolation. Incident, 2026-08-23 (operator's mainnet node): the
        // unlock INSIDE swap_sidecar_set_wallet_key is best-effort — Rust-side
        // it only eprintln!s a failure, it never fails the command — so this
        // await always resolved even on the run where the underlying
        // unlock_wallets() call lost a race and the node stayed genuinely
        // locked. Nothing told this hook to try again: `settled` still came
        // back true a few lines down (sharing has its own "nothing to do"
        // exit), `done` latched, and `/json/wallets` kept answering "Wallet
        // locked: Particl wallet must be unlocked" for the rest of the
        // session — the operator had to notice and click the console's
        // separate, more assertive unlock by hand to recover.
        //
        // `swap_sidecar_unlock_wallets` is the fix: it returns the SAME
        // unlock_wallets() call but does not swallow its result, so a real
        // failure here is finally visible. Deliberately NOT folded into the
        // outer catch below — an unlock that hasn't landed yet is a "not yet",
        // the same status as "the node isn't running yet", not a final
        // backend answer — so it must re-arm the retry timer instead of
        // latching `done`. Calling this on an already-unlocked node is a
        // documented no-op (`swap_sidecar_unlock_wallets`'s own doc: "unlock
        // timeouts, so unlocking an unlocked node succeeds"), so this runs
        // unconditionally rather than only when something looks wrong.
        if (!alive.current) return;
        try {
          await swapSidecarUnlockWallets();
        } catch (e) {
          console.warn(
            `[useSwapAutoSetup] unlock did not land yet, will retry: ${errMsg(e)}`,
          );
          return;
        }

        // Then close the coin gap. This RESTARTS the node, so it is attempted
        // only when there is something to add; the backend refuses when a swap
        // is in flight and says so.
        if (!alive.current) return;
        setApplying(true);
        try {
          const coins = await swapSidecarApplyPendingCoins();
          if (alive.current) setAdded(coins);
        } catch (e) {
          // "every enabled coin is already set up" is the common, healthy
          // case and must not surface as a failure — the key push above still
          // happened, which is the half that matters most.
          //
          // Scoped to THIS call deliberately. It used to be caught by the
          // outer handler, which meant the healthiest possible state — nothing
          // left to add — skipped wallet sharing entirely, i.e. the feature
          // would have worked only on installs that still had a coin pending.
          const msg = errMsg(e);
          if (alive.current && !/already set up/i.test(msg)) setError(msg);
        }
        if (alive.current) setApplying(false);

        if (alive.current) {
          settled = await shareWallets();
        }

        // Re-check wallet-seed readiness now that any C8 account key has
        // landed (2026-08-23). `checkWalletSeed()` — the engine's own source
        // for `expected_seed` in /json/wallets — is NOT re-run by the account-
        // key push itself (`js_pwnda_setaccountkey` calls
        // `initializeFromAccountKey` directly); the only place it runs
        // automatically is inside `unlockWallets()`, on every POST
        // /json/unlock. The FIRST unlock call above always runs BEFORE
        // `shareWallets()` pushes the key, so by the time it fired,
        // `checkWalletSeed` found the wallet not yet initialized and cached
        // `expected_seed: false` — and nothing else ever re-triggers it, so
        // it stuck false indefinitely regardless of how long the user waited.
        // This is the entire reason opening the BasicSwap console appeared to
        // "unstick" it: both console-open paths call `swapSidecarUnlockWallets`
        // before opening the window (see `openBasicswapConsole` in
        // `SwapView.tsx`), and THAT unlock call — not the console window
        // itself — is what flipped it. Calling unlock again here, once the key
        // push has settled, closes the gap automatically; per the engine's own
        // source, re-unlocking an already-unlocked node is a documented no-op,
        // so this is safe to run unconditionally rather than only when
        // something looks wrong (same reasoning as the first unlock call).
        if (alive.current && settled) {
          try {
            await swapSidecarUnlockWallets();
          } catch (e) {
            console.warn(
              `[useSwapAutoSetup] post-share unlock did not land yet, will retry: ${errMsg(e)}`,
            );
            settled = false;
          }
        }
      } catch (e) {
        if (alive.current) setError(errMsg(e));
        // An exception is a real answer — the backend spoke. Latch rather
        // than hammer the same failure every tick; `retry()` and the Settings
        // buttons remain the recovery path.
        settled = true;
      } finally {
        if (alive.current) setApplying(false);
        inFlight.current = false;
        if (settled) {
          done.current = true;
        } else if (alive.current) {
          if (timer.current != null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => {
            void attempt();
          }, AUTO_SETUP_RETRY_MS);
        }
      }
    }

    runRef.current = () => void attempt();
    void attempt();

    return () => {
      runRef.current = null;
      if (timer.current != null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [optedIn, deriveSwapMaterial, deriveAccountKeys]);

  const retry = useCallback(() => {
    done.current = false;
    runRef.current?.();
  }, []);

  return { added, error, applying, shared, sharedErrors, unparkNotice, retry };
}
