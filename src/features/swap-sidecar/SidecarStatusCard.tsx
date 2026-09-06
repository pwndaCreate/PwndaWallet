import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../../lib/tauri";
import {
  swapSidecarSetWalletKey,
  swapSidecarStart,
  swapSidecarUnlockWallets,
  swapSidecarOpenConsole,
  swapSidecarConsoleTrace,
  swapSidecarSupervisorLog,
  swapSidecarJanitorRun,
  swapSidecarUpdateEngine,
  type EngineIdentity,
  type JanitorReport,
} from "../../api/basicswap";
import { Card, Btn, Dot } from "../../design/primitives";
import {
  SwapNodeOffState,
  SwapNodeRunningState,
  deriveSetupSteps,
  formatUptime,
  type NodeStatusCell,
  DexCoinTiles,
} from "./SwapNodeCardParts";
import { HollowSquare } from "../swap/components/swap-ui";
import { useChainSync } from "./useChainSync";
import { lastSharePass, subscribeSharePass } from "./sharePassLog";
import { useSidecarBalances } from "./useSidecarBalances";
import { useSwapSidecarOptIn } from "./swapSidecarOptIn";
import { useCoinStatuses } from "./dexCoins";
import {
  STRIP_DOT_TICKERS,
  STRIP_TICKERS,
  configuredTickersFrom,
  dexTilesFrom,
  partSyncReading,
} from "./nodeStrip";


/**
 * Settings card for the BasicSwap swap sidecar: what the node is doing right
 * now, the loopback ports it holds, start/stop, and the Tier-0 "advanced
 * console" escape hatch ([[basicswap-sidecar-ultracode-plan]] Phase 2 Tier 0).
 *
 * Self-contained on purpose — it owns its own status poll and its own opt-in
 * read, so the Settings view can drop it in with `<SidecarStatusCard />` and
 * nothing else.
 *
 * # The pre-opt-in branch does not invoke
 *
 * Fresh-install contract: **nothing downloads, spawns or invokes** before
 * opt-in. So this card reads `useSwapSidecarOptIn()` (a plaintext store key —
 * see `swapSidecarOptIn.ts`) and only starts polling `swap_sidecar_status`
 * once that is `true`. `optedIn === null` means the read is still in flight
 * and is treated as *not* enabled, same rule as the mining gate.
 *
 * # Copy constraints
 *
 * Per `CLIENT-SIDECAR-COMPLIANCE-AND-UX.md` § 3 the card states that offers
 * come from other users on an open network — pwnda is never the counterparty
 * — and never shows fill rates, demand, or any other taker-feed fiction
 * (there is no endpoint that could supply one: bids are point-to-point
 * encrypted).
 */

/** Rust `Phase` — internally tagged (`#[serde(tag = "phase")]`), so it arrives
 *  as an object, never a bare string. */
type SidecarPhase =
  | { phase: "stopped" }
  | { phase: "preparing" }
  | { phase: "starting" }
  | { phase: "healthy" }
  | { phase: "stopping" }
  | { phase: "failed"; reason: string };

/** Rust `SidecarStatus`. Carries no credential field, by construction. */
interface SidecarStatus {
  /** Which engine is on disk, and whether it is the one this build expects
   *  (`grove::identify`). Rendered by `EngineDriftNote` since 2026-09-04. */
  engine?: EngineIdentity;
  phase: SidecarPhase;
  running: boolean;
  optedIn: boolean;
  htmlPort: number;
  wsPort: number;
  portOffset: number;
  configured: boolean;
  runtimeInstalled: boolean;
  datadir: string;
  autostart: boolean;
  coins: string[];
  coinsUnavailable: string[];
}

const POLL_MS = 5000;


/**
 * The engine on disk is not the one this app expects.
 *
 * `status.engine` has carried `drift` since the stamp was introduced, and
 * nothing rendered it. The operator ran a p21 engine under an app built for
 * p26 for a whole evening: BCH read `NaN` in the console (PATCH-23 missing),
 * ZANO never registered (PATCH-25/26/27 missing), and every screenshot looked
 * like a fresh bug. This is the line that would have said so.
 *
 * ## Rewritten 2026-09-05, because the note itself was the problem
 *
 * The operator's reaction to it was: *"What is the p26 and p27 stuff? Can you
 * simply update it to the latest and stop downgrading or slowly upgrading, I
 * dont want this error thrown again."* Three fair complaints in one sentence:
 *
 * 1. `p26`/`p27` is internal vocabulary. It is a COUNT of this project's own
 *    patches on top of BasicSwap 0.18.5 — not a version, and nothing is ever
 *    downgraded. Saying so is the note's job.
 * 2. It described a manual PowerShell step. On a real install that script does
 *    not exist and is not needed: the engine ships inside the app.
 * 3. It should not recur at all. `reconcile_bundled_engine` (Rust) now
 *    reinstalls the bundled engine on the next start whenever the installed
 *    one disagrees, the same tier-1 reconcile `sidecar_update.rs` does for the
 *    wallet-rpc binaries. So on a user's machine this note is transient — it
 *    describes the state until the next start, with the button to do it now.
 *
 * On a dev checkout there is no bundle to install from, and the button says so
 * rather than pretending. The `p…` ids stay visible in small print because
 * they are what a bug report needs.
 */
function EngineDriftNote({
  engine,
  running,
  onUpdate,
  busy,
  result,
}: {
  engine?: EngineIdentity;
  /** The engine cannot be replaced under a live node — the button says why. */
  running: boolean;
  onUpdate: () => void;
  busy: boolean;
  result: string | null;
}) {
  if (!engine || engine.state !== "drift") return null;
  return (
    <div
      data-engine-drift
      style={{
        marginTop: 8,
        padding: "8px 10px",
        fontSize: 10,
        lineHeight: 1.6,
        fontFamily: "var(--mono)",
        color: "var(--warn, #ffaa00)",
        border: "1px solid rgba(255,170,0,0.4)",
        background: "rgba(255,170,0,0.06)",
      }}
    >
      The swap engine on disk is older than the one this wallet ships. It will
      be replaced automatically the next time the node starts — fixes waiting
      in the newer engine do not apply until then.
      {/* The data hook lives on the wrapper, not the Btn: `Btn` takes an
          explicit prop list and drops unknown props, so `data-*` on it never
          reaches the DOM. Found while verifying this note in the sandbox. */}
      <div
        data-engine-update
        style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center" }}
      >
        <Btn
          onClick={onUpdate}
          disabled={busy || running}
          title={
            running
              ? "Stop the swap node first — replacing the engine under a running node would drop a process that may be watching a swap's timelocks"
              : "Install the engine this build ships"
          }
        >
          {busy ? "Updating…" : "Update engine now"}
        </Btn>
        {running && (
          <span style={{ opacity: 0.85 }}>stop the node first, or just restart it</span>
        )}
      </div>
      {result && (
        <div data-engine-update-result style={{ marginTop: 6, opacity: 0.9 }}>
          {result}
        </div>
      )}
      <div style={{ marginTop: 6, opacity: 0.65 }}>
        on disk <b>{engine.stamped}</b>, this build expects <b>{engine.expected}</b> —
        the number counts PwndaWallet's own patches on BasicSwap, not a version.
      </div>
    </div>
  );
}

function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

function phaseText(p: SidecarPhase | undefined): string {
  switch (p?.phase) {
    case "healthy":
      return "Running";
    case "preparing":
      return "Configuring";
    case "starting":
      return "Starting";
    case "stopping":
      return "Stopping";
    case "failed":
      return "Failed";
    default:
      return "Stopped";
  }
}

function phaseDot(p: SidecarPhase | undefined): "green" | "amber" | "red" | "gray" {
  switch (p?.phase) {
    case "healthy":
      return "green";
    case "preparing":
    case "starting":
    case "stopping":
      return "amber";
    case "failed":
      return "red";
    default:
      return "gray";
  }
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: 12,
        fontFamily: "var(--font-mono)",
        fontSize: 11.5,
        padding: "3px 0",
      }}
    >
      <span
        style={{
          color: "var(--text-dim)",
          letterSpacing: 1,
          textTransform: "uppercase",
          flexShrink: 0,
        }}
      >
        {k}
      </span>
      <span
        className="tnum"
        style={{ color: "var(--text)", textAlign: "right", wordBreak: "break-all" }}
      >
        {v}
      </span>
    </div>
  );
}

export function SidecarStatusCard({
  onOpenSetup,
  onOpenP2P,
  deriveSwapMaterial,
  deriveAccountKeys,
}: {
  /** Route the user to `SidecarSetupWizard`. When omitted the pre-opt-in
   *  branch renders its explanation with no call to action. */
  onOpenSetup?: () => void;
  /** Navigate to Swap ▸ P2P. Frame 1h's primary action on this card. */
  onOpenP2P?: () => void;
  /**
   * Derive the swap wallet-encryption key from the UNLOCKED vault — same prop
   * the setup wizard takes. When present, Start pushes the key first, which is
   * what lets `reconcile_coin_set` actually ADD an enabled-but-unconfigured
   * coin: `--addcoin` must read the master key out of the encrypted Particl
   * wallet, and a keyless start (autostart always is one) defers instead.
   * Without this prop the button still starts the node — existing coins run
   * fine locked — it just cannot widen the coin set.
   */
  deriveSwapMaterial?: () => Promise<{ mnemonic: string; walletKey: string }>;
  /**
   * C8 — derive the account keys that make each lean coin's wallet the
   * user's own. When present, the Unlock button finishes the WHOLE job:
   * encryption key, unlock, then the account-key push. It was the missing
   * second half that let a manual unlock strand BTC/LTC wallet-less behind
   * the fail-closed engine patch (2026-08-21) — the button unlocked the
   * wallets, everything looked done, and the keys were never sent.
   */
  deriveAccountKeys?: () => Promise<
    import("../../lib/swapAccountKey").DerivedAccountKeys
  >;
} = {}) {
  const { optedIn } = useSwapSidecarOptIn();
  const [status, setStatus] = useState<SidecarStatus | null>(null);
  /** Chain progress + node-held balances for the running strip (frame 1h).
   *  Both are gated on opt-in inside their own hooks, so a wallet that has
   *  never enabled the node issues no polls from this card. */
  const chainSync = useChainSync({ enabled: optedIn === true });
  const sidecarBalances = useSidecarBalances({ enabled: optedIn === true });
  // The authority on per-coin enablement, and deliberately the SAME hook the
  // DEX COINS section below uses — see `dexCoinTiles` for why sharing it is
  // the whole point rather than an optimisation.
  const coinStatuses = useCoinStatuses({ enabled: optedIn === true });

  const configuredTickers = configuredTickersFrom(status?.coins);
  const [busy, setBusy] = useState<"" | "start" | "stop" | "autostart" | "unlock">("");
  /**
   * C8 — what the share pass concluded, rendered rather than logged.
   *
   * Read from `sharePassLog` because the pass runs in `useSwapAutoSetup`,
   * mounted by `App.tsx`, and finishes long before this card mounts. Until
   * 2026-09-05 the card held its OWN `shareInfo` state instead — filled by a
   * manual Unlock button that was deleted on 2026-08-22. The state stayed,
   * permanently null, and so did the test asserting the JSX mentions it:
   * a check that could not fail for the reason it was run. BCH's real
   * refusal ("the swap node's current balance for this coin could not be
   * read") went to `console.error` and nowhere else for two days.
   */
  const [shareReport, setShareReport] = useState(lastSharePass);
  useEffect(() => subscribeSharePass(setShareReport), []);
  /** The drift note's "Update engine now" — installs the engine this build
   *  ships. The automatic path runs on the next start; this is for doing it
   *  without waiting. See `reconcile_bundled_engine` (Rust). */
  const [engineBusy, setEngineBusy] = useState(false);
  const [engineResult, setEngineResult] = useState<string | null>(null);
  const updateEngine = useCallback(async () => {
    setEngineBusy(true);
    setEngineResult(null);
    try {
      setEngineResult(await swapSidecarUpdateEngine());
      await refresh();
    } catch (e) {
      setEngineResult(errMsg(e));
    } finally {
      if (alive.current) setEngineBusy(false);
    }
  }, []);
  const [error, setError] = useState("");
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<SidecarStatus>("swap_sidecar_status");
      if (alive.current && s) setStatus(s);
    } catch (e) {
      if (alive.current) setError(errMsg(e));
    }
  }, []);

  // Gate the poll on opt-in. `optedIn === null` (read in flight) counts as NOT
  // enabled — the fresh-install contract is that nothing invokes first.
  useEffect(() => {
    if (optedIn !== true) return;
    let stopped = false;
    const tick = () => {
      if (!stopped) void refresh();
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [optedIn, refresh]);

  const start = async () => {
    if (busy) return;
    setBusy("start");
    setError("");
    try {
      // Typed binding, not a raw invoke: `SwapSidecarStartArgs` is what
      // stops a caller from inventing an argument name Tauri will silently
      // drop. No args here on purpose — an ordinary start from Settings
      // carries no XMR node override, so Rust applies the pinned node
      // (precedence: explicit args > store pin > none). This card cannot
      // read that pin itself; `swap-sidecar` may not import
      // `src/wallets/xmr-wallet` (BOUNDARIES.md).
      const haveKey = deriveSwapMaterial != null;
      if (deriveSwapMaterial) {
        // Key first, exactly like the wizard: it must be in backend memory
        // before reconcile runs. The mnemonic half of the material is NOT
        // passed — this is an existing install (R1: the phrase rides argv on
        // the FIRST prepare only) — and it is not retained here either.
        const material = await deriveSwapMaterial();
        await swapSidecarSetWalletKey(material.walletKey);
      }
      const s = await swapSidecarStart();
      // The node may already have been running (autostart) — in which case the
      // start above was a no-op status read and the wallets are still LOCKED,
      // which is what renders the web UI's "Unlock BasicSwap" page. Unlock in
      // place. Harmless after a fresh keyed start too: upstream's unlock
      // re-arms the per-coin timeouts on an already-unlocked node.
      if (haveKey && s.running) {
        try {
          await swapSidecarUnlockWallets();
        } catch (e) {
          // Loud: a locked node LOOKS started, so a swallowed unlock failure
          // is indistinguishable from success until a swap fails hours later.
          setError(errMsg(e));
        }
      }
      if (!alive.current) return;
      setStatus(s);
      const ph = s?.phase;
      if (ph && ph.phase === "failed") setError(ph.reason);
    } catch (e) {
      if (alive.current) setError(errMsg(e));
    } finally {
      if (alive.current) setBusy("");
    }
  };

  const stop = async () => {
    if (busy) return;
    setBusy("stop");
    setError("");
    try {
      const s = await invoke<SidecarStatus>("swap_sidecar_stop");
      if (!alive.current) return;
      setStatus(s);
    } catch (e) {
      if (alive.current) setError(errMsg(e));
    } finally {
      if (alive.current) setBusy("");
    }
  };

  /**
   * Persist "start with the wallet".
   *
   * Records a preference only — it deliberately does NOT start or stop the
   * node now. Someone ticking a box about future launches has not asked for
   * five processes to spawn under them this second.
   */
  const setAutostart = async (enabled: boolean) => {
    if (busy) return;
    setBusy("autostart");
    setError("");
    try {
      await invoke("swap_sidecar_set_autostart", { enabled });
      await refresh();
    } catch (e) {
      if (alive.current) setError(errMsg(e));
    } finally {
      if (alive.current) setBusy("");
    }
  };

  const [traceCopied, setTraceCopied] = useState(false);
  /** The on-demand janitor's last report, rendered under the Advanced buttons
   *  (2026-09-05): the automatic sweep left the 2026-08-23 Error bid in place
   *  through two rebuilds with nothing to show why, so the same sweep can now
   *  be run by hand and its answer read on screen. */
  const [janitor, setJanitor] = useState<JanitorReport | { error: string } | null>(null);
  const [janitorBusy, setJanitorBusy] = useState(false);
  const runJanitor = async () => {
    setJanitorBusy(true);
    setJanitor(null);
    try {
      setJanitor(await swapSidecarJanitorRun());
    } catch (e) {
      setJanitor({ error: errMsg(e) });
    } finally {
      setJanitorBusy(false);
    }
  };

  /**
   * Open the node's own web console.
   *
   * # Two buttons, one behaviour
   *
   * This predates C7.1 and used to copy the password to the clipboard and open
   * the user's browser, where they pasted it at the login prompt. The Particl
   * card then grew a button that authenticates automatically — so the app had
   * two console buttons with near-identical labels and different behaviour, and
   * a user who clicked this one was still asked for a password the other one
   * had made unnecessary. That is how a stale credential got pasted at all.
   *
   * So: try the auto-auth path first, and keep the old one as a REAL fallback
   * rather than a parallel feature.
   *
   * The fallback still matters. `swap_sidecar_open_console` opens a pwnda-owned
   * window; a user who specifically wants the console in their own browser (an
   * extension, a second monitor, devtools they trust) is served by the copy +
   * external open, and so is anyone whose webview cookie install fails.
   */
  /**
   * Clear BOTH locks, then hand back the port.
   *
   * There are two, and they are unrelated: the session login (satisfied by
   * the API password) and the wallet-encryption lock behind it, which takes a
   * vault-derived key no user can type. Skipping the second is what put a
   * dead-end "Unlock BasicSwap" page in front of the user twice, so every
   * console path runs this first.
   *
   * Deliberately non-fatal. A failure here still leaves a usable console —
   * the session login works and the user simply meets the wallet prompt — so
   * it reports and continues rather than refusing to open anything.
   */
  const prepareConsole = async (): Promise<void> => {
    if (!deriveSwapMaterial) return;
    try {
      const material = await deriveSwapMaterial();
      await swapSidecarSetWalletKey(material.walletKey);
      await swapSidecarUnlockWallets();
    } catch (e) {
      setError(
        `${errMsg(e)} — the console may still ask for a wallet password.`,
      );
    }
  };

  /**
   * Open the console in a PWNDA-owned window (the default since 2026-08-21).
   *
   * Same engine, same node, same loopback port the supervisor drives — this
   * changes only which window renders upstream's UI, never which backend it
   * talks to.
   *
   * Why this beats the browser, which it replaces as the default: Rust performs
   * the session login itself and installs only the resulting cookie, so **the
   * API password never leaves the backend** — it is not typed, not pasted, and
   * never placed on the clipboard. The window is also pinned to the engine's
   * own loopback origin (`console_navigation_allowed`) and gets no Tauri IPC,
   * so it cannot navigate away or call a `swap_sidecar_*` command.
   *
   * History worth keeping: this path was built, shipped, and then pulled on
   * 2026-08-20 because the window opened BLANK — WebView2 registers
   * `initialization_script` asynchronously and it lost the race against the
   * first navigation. That was fixed by ALSO running the script from
   * `on_page_load(Finished)`, which cannot race anything — and the real
   * white-window cause, a WebView2 environment-options mismatch, was found
   * and fixed 2026-08-22 (see `main_window_additional_browser_args`). The
   * browser fallback was removed the same day: it put the API password on
   * the clipboard, which this path never does, and the window now works.
   */
  const openConsole = async () => {
    if (!status?.htmlPort) return;
    await prepareConsole();
    try {
      await swapSidecarOpenConsole();
    } catch (e) {
      // The window failed to open at all. Say so and name the fallback rather
      // than leaving a button that appears to do nothing.
      setError(
        `${errMsg(e)} — use "Copy console diagnostic log" and report it.`,
      );
    }
  };

  /**
   * Put the console-open trace on the clipboard.
   *
   * Exists because the blank-console bug survived two diagnoses, and both
   * times the blocker was the same: nothing the operator could hand back
   * recorded what the window actually did. The webview's own console.log goes
   * to devtools they do not have open. This reads what Rust wrote instead —
   * every navigation decision, every page-load event, the login result, and
   * the window build outcome.
   */
  const copyConsoleTrace = async () => {
    try {
      const [trace, supervisor] = await Promise.all([
        swapSidecarConsoleTrace(),
        // 2026-09-04: the supervisor's own decisions (host-wallet activation,
        // the warm-up wait, the janitor, unpark restarts) travel with the
        // console trace, so "parked this session" comes with its reason.
        swapSidecarSupervisorLog().catch(() => ""),
      ]);
      const text = supervisor
        ? `${trace}\n\n=== swap-sidecar.log (supervisor) ===\n${supervisor}`
        : trace;
      await navigator.clipboard?.writeText(text);
      if (alive.current) {
        setTraceCopied(true);
        window.setTimeout(() => {
          if (alive.current) setTraceCopied(false);
        }, 6000);
      }
    } catch (e) {
      setError(errMsg(e));
    }
  };

  // ── Not enabled (canvas frame 1h, OFF state) ──────────────────────────
  //
  // The paragraph that used to live here ("…is not installed until you turn
  // it on. Nothing has been downloaded or started.") is now the rail plus two
  // chips: the rail shows what enabling will DO, and `NOTHING RUNS UNTIL YOU
  // CLICK` carries the claim the sentence made. Same promise, one glance.
  if (optedIn !== true) {
    return (
      <Card
        title="SWAP NODE (XMR / ZEPH / ZANO)"
        right={
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontFamily: "var(--font-mono)",
              fontSize: 9,
              letterSpacing: 1,
              textTransform: "uppercase",
              color: "var(--text-dim)",
            }}
          >
            <HollowSquare size={6} />
            off
          </span>
        }
      >
        <SwapNodeOffState
          steps={deriveSetupSteps({
            runtimeInstalled: status?.runtimeInstalled === true,
            configured: status?.configured === true,
            running: status?.running === true,
          })}
          onEnable={onOpenSetup}
          busy={!!busy}
        />
      </Card>
    );
  }

  const ph = status?.phase;
  const running = status?.running === true;
  const transitioning =
    ph?.phase === "preparing" || ph?.phase === "starting" || ph?.phase === "stopping";

  /**
   * The status strip's cells (frame 1h).
   *
   * PART carries every offer and bid on the network, so its sync percentage
   * is the one number that decides whether the order book is complete — it
   * leads. XMR/ZEPH are dot-only: what matters is whether their wallets are
   * up, not a percentage. The offers count is deliberately ABSENT rather
   * than zero: this card does not read the book, and rendering `0 OFFERS`
   * from a value nobody fetched would be inventing a measurement.
   */
  const runningCells: NodeStatusCell[] = (() => {
    const part = chainSync.byTicker.PART;
    const { pct, synced } = partSyncReading(part);
    const cells: NodeStatusCell[] = [
      {
        label: "part",
        value: pct == null ? "—" : `${pct}%`,
        tone: pct == null ? "idle" : synced ? "ok" : "warn",
        title: synced
          ? `Particl is caught up at ${part!.blocks.toLocaleString()} blocks; the order book is complete.`
          : "Particl carries every offer and bid; the order book is incomplete until this reaches 100%.",
      },
    ];
    /**
     * XMR/ZEPH: configured AND the wallet answering.
     *
     * 2026-08-28: this used to be
     * `status.coins.some((c) => c.toUpperCase().startsWith(t.slice(0, 3)))`,
     * which asks whether the string "MONERO" starts with "XMR". It does not,
     * and it never will — `status.coins` holds engine NAMES from
     * `basicswap.json`'s chainclients ("bitcoin", "monero", "particl"), while
     * this compared them against TICKERS. Both dots were hardcoded to idle by
     * construction. `tickerForCoin` is the repo's existing translator and is
     * what should have been used from the start.
     *
     * The tone now distinguishes three states rather than two, because
     * "configured" and "usable" are different claims and the dot was
     * previously making the stronger one on the weaker evidence: a coin whose
     * balance row came back with an error, or locked, is configured but cannot
     * sign, and that is amber rather than green.
     */
    // ZANO joined the strip 2026-09-04: it is the third host-wallet coin the
    // node can run, and a strip that showed XMR/ZEPH dots but no ZANO dot
    // read as "ZANO is not a node coin" on the one card that summarises the
    // node. Same three-state tone as the other two. The list lives in
    // `nodeStrip.ts` so the DEX tiles below exclude exactly what is dotted
    // here — adding ZANO to this loop without adding it there put a hollow
    // dot and a filled tile on the same card for the same coin (2026-09-04).
    for (const t of STRIP_DOT_TICKERS) {
      if (!configuredTickers.has(t)) {
        cells.push({ label: t.toLowerCase(), tone: "idle" });
        continue;
      }
      const row = sidecarBalances.rows?.[t] ?? null;
      const healthy = row != null && !row.error && !row.locked;
      cells.push({
        label: t.toLowerCase(),
        tone: healthy ? "ok" : "warn",
        title: healthy
          ? `${t} is configured and its wallet is answering.`
          : row?.error
            ? `${t} is configured, but its wallet reported: ${row.error}`
            : row?.locked
              ? `${t} is configured, but its wallet is locked — the node cannot sign for it.`
              : `${t} is configured, but its wallet has not reported yet.`,
      });
    }
    return cells;
  })();

  /**
   * The DEX-coin tiles, read-only — see `DexCoinTiles`.
   *
   * Derived from `useCoinStatuses`, which `swapSidecarCoinStatus`'s own doc
   * calls "the authority", and which is the SAME array the DEX COINS section
   * directly below renders its "n of m enabled" line from. That sharing is the
   * point: 2026-08-28 this card read a hardcoded five-ticker list against
   * `status.coins` and rendered `DEX COINS · 0 OF 5 ON` directly above a
   * section reading `DEX COINS · 4 OF 7 ENABLED`. Two counters, two
   * denominators, one of them wrong — and a user cannot tell which. One
   * source, or the card should not carry a count at all.
   *
   * PART/XMR/ZEPH are excluded because the strip above already reports them;
   * showing a coin in both places invites the same disagreement in miniature.
   */
  const dexCoinTiles = dexTilesFrom(coinStatuses.statuses, STRIP_TICKERS);

  /**
   * What the node itself holds, and the footer that follows from it.
   *
   * Under Grove the engine swaps from the WALLET'S accounts, so this is
   * normally empty and the footer says so. It is non-empty only when the user
   * turned sharing off for a coin and funded the node by deposit, or when an
   * earlier configuration left a balance behind — and in that case the
   * sweep-back flow on the Swap tab is where it is recovered. This card
   * reports; it does not offer a second funds-moving control.
   */
  const nodeBalanceLabel = (() => {
    const rows = (sidecarBalances.rows ?? {}) as Record<
      string,
      { balance?: string | null } | undefined
    >;
    const parts = Object.entries(rows)
      .filter(([, r]) => r?.balance && parseFloat(String(r.balance)) > 0)
      .slice(0, 3)
      .map(([t, r]) => `${r!.balance} ${t}`);
    return parts.length > 0 ? parts.join(" · ") : "—";
  })();

  // ── Enabled ────────────────────────────────────────────────────────────
  return (
    <Card
      title="SWAP NODE (XMR / ZEPH / ZANO)"
      right={
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            letterSpacing: 1,
            textTransform: "uppercase",
            color: "var(--text-muted)",
          }}
        >
          <Dot color={phaseDot(ph)} />
          {phaseText(ph)}
        </span>
      }
    >
      {/* ── RUNNING strip (canvas frame 1h) ──────────────────────────
          Rendered only while the node is actually up. The operational
          controls below stay for the opted-in-but-stopped case, so this
          never duplicates a Start/Stop the user can already see. */}
      <EngineDriftNote
            engine={status?.engine}
            running={running}
            onUpdate={updateEngine}
            busy={engineBusy}
            result={engineResult}
          />
      {running && (
        <SwapNodeRunningState
          statusCells={runningCells}
          coins={dexCoinTiles}
          balanceLabel={nodeBalanceLabel}
          onOpenP2P={onOpenP2P}
          onStop={() => void stop()}
          busy={busy !== ""}
          footer={
            nodeBalanceLabel === "—"
              ? "swaps run from your own wallet · the node holds nothing to sweep"
              : "the node is holding these · recover them from Swap ▸ sweep back"
          }
        />
      )}

      {/* Simplified 2026-08-22: ports, runtime, config and data folder are
          facts the backend manages and the user cannot act on — they were
          the bulk of this card's text. The phase is in the header dot, the
          data folder is in Files on Disk. Coins stays: it is the one row
          that answers a user question ("what can I trade here"). */}
      {/* Stopped shows the SAME tiles as running (2026-09-04).

          It used to render `status.coins.join(", ")` — a comma list built from
          the node's CONFIGURED coins. Two consequences, both reported by a
          user: the coin tiles "disappear when I stop the swap node", and the
          coins they wanted to turn on were not in the list at all, because a
          coin that has never been configured is absent from `status.coins` by
          definition. So the one state where you would sit down to change the
          coin set was the one state that showed neither the full set nor a way
          to reach the editor.

          `dexCoinTiles` comes from `useCoinStatuses` — the authority, and the
          same source the DEX COINS section uses — so it lists every candidate
          coin with its real on/off state whether the node is up or not. One
          representation of one fact, in both states. */}
      {!running && dexCoinTiles.length > 0 && (
        <>
          <EngineDriftNote
            engine={status?.engine}
            running={running}
            onUpdate={updateEngine}
            busy={engineBusy}
            result={engineResult}
          />
          <DexCoinTiles coins={dexCoinTiles} />
        </>
      )}
      {!running && dexCoinTiles.length === 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {/* Only before the first coin-status read returns. Absent beats a
              zero-count, the same rule DexCoinTiles itself follows. */}
          <Row
            k="Coins"
            v={status && status.coins.length > 0 ? status.coins.join(", ") : "—"}
          />
        </div>
      )}

      <label
        style={{
          marginTop: 12,
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontFamily: "var(--font-mono)",
          fontSize: 11.5,
          color: "var(--text-muted)",
          cursor: busy ? "default" : "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={status?.autostart === true}
          disabled={busy !== ""}
          onChange={(e) => void setAutostart(e.target.checked)}
        />
        Start the swap node when the wallet starts
      </label>

      {ph?.phase === "failed" && (
        <div
          style={{
            marginTop: 10,
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            lineHeight: 1.5,
            color: "var(--danger)",
            wordBreak: "break-word",
          }}
        >
          {/* Verbatim backend reason — it names the step that failed and, for a
              health timeout, carries the tail of basicswap.log. */}
          {ph.reason}
        </div>
      )}

      {error && ph?.phase !== "failed" && (
        <div
          style={{
            marginTop: 10,
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            lineHeight: 1.5,
            color: "var(--danger)",
            wordBreak: "break-word",
          }}
        >
          {error}
        </div>
      )}

      <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {/* ONE control for the node's run state (2026-08-22). The verb is the
            state, not a choice: Stop while running, Start otherwise, held
            during a transition. The former manual unlock button is gone —
            unlocking is backend-managed: `start` unlocks right after
            the key push, and `prepareConsole` unlocks before the console
            opens, so there is no state left in which a user must press it. */}
        {/* Only when the node is NOT up. While it is running, the frame-1h
            strip above owns STOP; rendering both put two Stop controls on one
            card (caught in review 2026-08-28). */}
        {!running && (
          <Btn
            variant="accent"
            size="sm"
            onClick={start}
            disabled={busy !== "" || transitioning}
          >
            {busy === "start" ||
            ph?.phase === "starting" ||
            ph?.phase === "preparing"
              ? "Starting…"
              : "► Start node"}
          </Btn>
        )}
      </div>
      {/* C8 — what the share pass concluded, rendered rather than logged. A
          refusal here means the engine is REFUSING to build that coin's
          wallet at all (fail-closed patch), which otherwise presents only as
          an inexplicable zero balance in the DEX console. */}
      {shareReport && shareReport.shared.length > 0 && (
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--accent)",
            marginTop: 4,
          }}
        >
          using your wallet for {shareReport.shared.join(", ")}
        </div>
      )}
      {shareReport &&
        shareReport.errors.map((e) => (
          <div
            key={e}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--danger)",
              wordBreak: "break-word",
              marginTop: 4,
            }}
          >
            {e}
          </div>
        ))}

      <div
        style={{
          marginTop: 14,
          paddingTop: 12,
          borderTop: "1px solid var(--border-soft)",
          fontFamily: "var(--font-mono)",
          fontSize: 10.5,
          lineHeight: 1.6,
          color: "var(--text-dim)",
        }}
      >
        <div
          style={{
            letterSpacing: 1,
            textTransform: "uppercase",
            color: "var(--text-muted)",
            marginBottom: 6,
          }}
        >
          Advanced
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn
            variant="ghost"
            size="sm"
            onClick={() => void openConsole()}
            // Healthy only: opened during the start's 86-second prepare, the
            // console logged in against a port nothing was listening on yet
            // and errored (2026-09-05). Rust refuses too; this is the
            // affordance matching the refusal.
            disabled={status?.phase?.phase !== "healthy"}
            title={
              status?.phase?.phase === "healthy"
                ? "Open upstream's own interface, signed in"
                : "The console opens once the swap node is running (green dot)"
            }
          >
            Open BasicSwap console
          </Btn>
          {/* Diagnostics. Shown unconditionally rather than behind a "did it
              fail?" check — the window can fail by rendering NOTHING, which
              no state flag here can observe. */}
          <Btn
            variant="ghost"
            size="sm"
            onClick={() => void runJanitor()}
            disabled={janitorBusy || !running}
            title="Ask the swap node to settle or restart any swap it parked in Error — the same sweep it runs itself every ten minutes"
          >
            {janitorBusy ? "Cleaning up…" : "Clean up stalled swaps"}
          </Btn>
          <Btn variant="ghost" size="sm" onClick={() => void copyConsoleTrace()}>
            {traceCopied ? "Trace copied" : "Copy console diagnostic log"}
          </Btn>
          {janitor && (
            <div
              data-janitor-report
              style={{ fontSize: 10, lineHeight: 1.5, fontFamily: "var(--mono)", color: "var(--text-dim)", marginTop: 4 }}
            >
              {"error" in janitor
                ? `Clean-up failed: ${janitor.error}`
                : janitor.errored === 0
                  ? `Looked at ${janitor.scanned} swap(s) on this node — none is in Error.`
                  : [
                      `Looked at ${janitor.scanned} swap(s), ${janitor.errored} in Error.`,
                      janitor.settled.length ? `Settled ${janitor.settled.length} (claim already confirmed on chain).` : "",
                      janitor.requeued.length ? `Restarted ${janitor.requeued.length}.` : "",
                      ...janitor.left.map((l) => `${l.bidId.slice(0, 10)}…: ${l.reason}`),
                    ]
                      .filter(Boolean)
                      .join(" ")}
            </div>
          )}
        </div>
        <p style={{ margin: "8px 0 0" }}>
          Upstream's own interface, signed in for you. Not covered by this
          wallet's checks — it can move funds.
        </p>
      </div>
    </Card>
  );
}
