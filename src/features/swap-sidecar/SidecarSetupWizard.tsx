import { useEffect, useRef, useState, type CSSProperties } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "../../lib/tauri";
import {
  swapSidecarStart,
  swapSidecarSetWalletKey,
  swapSidecarSetAutostart,
} from "../../api/basicswap";
import { ST, Card, Btn, ProgressBar } from "../../design/primitives";

/**
 * The single opt-in gate for the BasicSwap swap sidecar
 * ([[basicswap-sidecar-ultracode-plan]] Phase 1.2, modelled on
 * `src/features/mining/MiningSetupWizard.tsx`).
 *
 * Like the mining wizard this is a **single-screen consent card**, not a
 * multi-step flow: one deliberate decision, stated cost, then the install runs
 * inline with a progress meter. It is the *only* place in the app permitted to
 * turn the sidecar on, and until the user accepts here **nothing downloads,
 * prepares, spawns or invokes** (`swapSidecarOptIn.ts` is the frontend gate;
 * `swap_sidecar_start` refuses without the backend record).
 *
 * # Copy is compliance surface, not taste
 *
 * `CLIENT-SIDECAR-COMPLIANCE-AND-UX.md` § 3 makes several lines here
 * load-bearing. Do not "tighten" them without reading it:
 *
 * * **Never imply pwnda is the counterparty.** The copy says you swap with
 *   *another user on an open network*. Pwnda ships software and is not in the
 *   settlement path.
 * * **No taker-feed fictions.** There is no endpoint exposing other users'
 *   bids or swaps, so this screen never promises fill rates, demand, or
 *   liquidity depth.
 * * **Refunds are a normal outcome**, stated up front — they are timelock
 *   behaviour, not an error, and framing them as failures invites support
 *   pressure to intervene, which must never happen.
 * * **The fee never gates a swap.** Stated here so the user learns it before
 *   they commit, and so nobody later "optimises" a settlement gate into
 *   existence.
 */

/** Rust `SidecarProgress` (swap_sidecar.rs) — same `{stage, percent, message}`
 *  shape as `miners::DownloadProgress`, on purpose. */
interface SidecarProgress {
  stage: string;
  percent: number;
  message: string;
}

/** Rust `Phase`, an internally-tagged enum (`#[serde(tag = "phase")]`), so it
 *  arrives as an OBJECT — `{phase:"healthy"}` / `{phase:"failed",reason:…}` —
 *  never a bare string. */
type SidecarPhase =
  | { phase: "stopped" }
  | { phase: "preparing" }
  | { phase: "starting" }
  | { phase: "healthy" }
  | { phase: "stopping" }
  | { phase: "failed"; reason: string };

/** Rust `SidecarStatus`. Carries **no** credential field, by construction. */
interface SidecarStatus {
  phase: SidecarPhase;
  running: boolean;
  optedIn: boolean;
  htmlPort: number;
  wsPort: number;
  portOffset: number;
  configured: boolean;
  runtimeInstalled: boolean;
  datadir: string;
}

/** Rust `OptInRecord`. */
interface OptInRecord {
  optedIn: boolean;
  at: string | null;
}

/** Rust `swap_sidecar::PROGRESS_EVENT`. */
const PROGRESS_EVENT = "swap-sidecar-progress";

/**
 * Footprint quoted on the consent screen.
 *
 * These are the **plan's budget** figures, not a measurement:
 * `CLIENT-PLAN-SIDECAR-EXECUTION.md` § Phase 0 "Weight budget" records
 * ~9–11 GB total, of which particld is ~2.3 GB, LTC in electrum mode avoids a
 * multi-GB chain, and a remote XMR node avoids ~190 GB. That same section's
 * "record the measured install size from the spike" item is still open — when
 * the spike lands, **replace this with the measured number**. Rendered with
 * "about" precisely because it is a budget.
 */
export const SIDECAR_FOOTPRINT = "about 9–11 GB";

function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

/** Human label for a phase, used as the progress fallback when no
 *  `swap-sidecar-progress` event has arrived yet. */
function phaseLabel(p: SidecarPhase | undefined): string {
  switch (p?.phase) {
    case "preparing":
      return "Writing the node's configuration…";
    case "starting":
      return "Starting the swap node…";
    case "healthy":
      return "Swap node running.";
    case "stopping":
      return "Stopping the swap node…";
    case "failed":
      return p.reason;
    default:
      return "Swap node stopped.";
  }
}

export function SidecarSetupWizard({
  onSetUp,
  onDismiss,
  autoStart = true,
  deriveSwapMaterial,
}: {
  /** Persist the **frontend** opt-in flag (`enableSwapSidecarOptIn`) and let
   *  the app layer re-render. Called only after the backend has recorded
   *  consent. Async — the card stays in its busy state until it resolves. */
  onSetUp: () => void | Promise<void>;
  /** Leave this screen. Used by "Not now" (nothing was enabled) and by
   *  "Done" once the node is up. */
  onDismiss: () => void;
  /**
   * Produce the swap wallet's key material from the UNLOCKED vault.
   *
   * Supplied by the app layer, not derived here: BOUNDARIES.md bars this
   * feature from `src/crypto`, and the vault mnemonic is the app's to hold.
   * The callback returns a BIP-85 child phrase (the engine's particl master)
   * and the wallet-encryption key, both functions of the seed the user already
   * backed up — so there is no second phrase and no second password.
   *
   * **Without it a FIRST prepare cannot succeed.** Rust's
   * `check_first_prepare_gate` refuses a fresh-datadir prepare that carries no
   * mnemonic, rather than silently minting a Particl wallet nobody has a backup
   * of. Omit this only for a caller that knows the config already exists.
   */
  deriveSwapMaterial?: () => Promise<{ mnemonic: string; walletKey: string }>;
  /** Install + first-run immediately after consent. Off only for a caller
   *  that wants to record consent and start the node later from Settings. */
  autoStart?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<SidecarProgress | null>(null);
  const [status, setStatus] = useState<SidecarStatus | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Progress listener, mounted for the card's whole lifetime rather than only
  // while busy: the Rust side emits its first `download`/`prepare` stage
  // almost immediately after `swap_sidecar_start` is called, and a listener
  // registered inside the click handler can lose that first event to the
  // `listen()` round trip.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen<SidecarProgress>(PROGRESS_EVENT, (event) => {
      const p = event.payload;
      if (!p) return;
      setProgress(p);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // No Tauri event bus (browser-only sandbox). The phase poll below is
        // the fallback; this is not an error worth showing the user.
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Phase poll while the install runs. Advisory only — it never blocks and a
  // failure here is swallowed, because the authoritative outcome is the value
  // `swap_sidecar_start` resolves with.
  useEffect(() => {
    if (!busy) return;
    let stopped = false;
    const tick = async () => {
      try {
        const s = await invoke<SidecarStatus>("swap_sidecar_status");
        if (!stopped && s) setStatus(s);
      } catch {
        /* advisory */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 1500);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [busy]);

  const handleEnable = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setProgress(null);
    try {
      // 1. BACKEND consent first. It is the authority — `swap_sidecar_start`
      //    refuses without it — and doing it first means a failure here leaves
      //    the UI gate closed rather than opening a surface the backend will
      //    reject.
      await invoke<OptInRecord>("swap_sidecar_opt_in", { accepted: true });
      // 2. Frontend gate, so the app layer can mount the swap surface without
      //    having to invoke anything to find out.
      await onSetUp();
      // 3. Install + first run.
      if (autoStart) {
        // C1 + C5. Derive from the unlocked vault, hand the encryption key to
        // the backend FIRST (it must be in memory before prepare runs, since
        // prepare is what encrypts the wallets), then start with the phrase.
        //
        // Both are secrets: they are passed straight through and never stored
        // in component state, so a re-render cannot retain them.
        let particlMnemonic: string | undefined;
        if (deriveSwapMaterial) {
          const material = await deriveSwapMaterial();
          await swapSidecarSetWalletKey(material.walletKey);
          particlMnemonic = material.mnemonic;
        }
        const s = await swapSidecarStart(
          particlMnemonic ? { particlMnemonic } : {},
        );
        if (!alive.current) return;
        setStatus(s);
        const ph = s?.phase;
        if (ph && ph.phase === "failed") {
          setError(ph.reason);
        } else {
          setDone(true);
          // Persist "start with the wallet" the moment setup itself succeeds,
          // so a user who just agreed to run the swap node does not also have
          // to find Settings and tick a second box before it survives their
          // next launch. Best-effort: the node is already up and usable this
          // session either way, so a failure here is not worth surfacing.
          void swapSidecarSetAutostart(true).catch(() => {});
        }
      } else {
        setDone(true);
      }
    } catch (e) {
      if (alive.current) setError(errMsg(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const muted: CSSProperties = {
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    lineHeight: 1.6,
    color: "var(--text-muted)",
  };

  const pct = progress ? Math.max(0, Math.min(100, progress.percent)) : 0;

  return (
    <div className="miner-setup-view" style={{ animation: "fade-in .2s ease" }}>
      <div className="mining-header">
        <button className="btn-icon" onClick={onDismiss} title="Back" disabled={busy}>
          ► Back
        </button>
        <h2>
          <ST delay={0} speed={22}>SET UP SWAPS</ST>
        </h2>
      </div>

      <Card title="SWAP XMR & ZEPH WITH OTHER USERS">
        <div style={muted}>
          <p style={{ marginTop: 0 }}>
            This is <strong>optional and off by default</strong>. Nothing is
            downloaded, installed or started until you turn it on here. Enabling
            it installs a <strong>BasicSwap</strong> node on this PC —{" "}
            <strong>{SIDECAR_FOOTPRINT} downloaded and stored</strong> — which
            is the only route this wallet has for <strong>XMR</strong> and{" "}
            <strong>ZEPH</strong> swaps.
          </p>

          <ul style={{ margin: "10px 0 12px", paddingLeft: 18 }}>
            <li style={{ marginBottom: 6 }}>
              <strong>You swap with another user, on an open network.</strong>{" "}
              The node joins a public peer-to-peer network and shows you offers
              other people have posted. PwndaWallet is <em>not</em> the
              counterparty, never holds your coins, and is not part of
              settlement — every swap is signed by you, against funds only you
              control.
            </li>
            <li style={{ marginBottom: 6 }}>
              <strong>What gets installed.</strong> An embedded Python runtime,
              the BasicSwap node, and the Particl daemon it uses to relay
              offers. Bitcoin, Litecoin and Bitcoin Cash run in light
              (Electrum) mode and Monero uses a remote node, so none of them
              downloads its own blockchain.
            </li>
            <li style={{ marginBottom: 6 }}>
              {/* C8/C9 disclosure. This is the ONLY place wallet sharing is
                  explained, by design: the per-coin confirmation that used to
                  carry it was friction on top of a decision the user already
                  made by opting in (2026-08-20). Removing that gate without
                  moving the disclosure here would have left sharing
                  undisclosed anywhere, which is why the two changes shipped
                  together. Both consequences are stated — the Electrum
                  address visibility, and the mid-swap lock refusal — because
                  each surprises in a different place. */}
              <strong>The node uses your existing wallet.</strong> Bitcoin,
              Litecoin, Bitcoin Cash and Monero swap straight from the balances
              you already hold, so there is nothing to deposit and nothing to
              sweep back. Zephyr and Zano do the same through the wallet
              processes this app already runs for them — the node shares your
              Zephyr wallet-rpc, and spends Zano from a separate scratch
              wallet next to your main one — and each only runs while that
              wallet is open in this app.
              Two consequences worth knowing: the public Electrum servers a
              light coin uses can see that coin&apos;s addresses, and while a
              swap is in flight, locking the wallet or removing Monero is
              refused until it settles. You can turn sharing off per coin in{" "}
              <strong>Settings ▸ DEX coins</strong> and fund the node by
              deposit instead.
            </li>
            {/* Corrected 2026-08-21. This used to read "You can close the
                wallet while one is in flight — the node keeps running and
                resumes where it left off." The first half is false:
                `on_exit_requested` runs the shutdown ladder on
                `should_run_exit_ladder(running, pid)`, which asks only
                whether a process is alive and never whether a swap is in
                flight, so closing the app STOPS the node. The second half is
                true — `loadFromDB` rehydrates any bid between BID_RECEIVED
                and SWAP_COMPLETED — but only once the Particl wallet is
                unlocked again, and a swap that is not running is not
                watching its own refund deadline. Saying "keeps running"
                invited exactly the behaviour that turns a timelock into a
                loss. */}
            <li style={{ marginBottom: 6 }}>
              <strong>A swap takes roughly 30–90 minutes</strong> and is paced
              by on-chain timelocks, not by us.{" "}
              <strong>Leave the wallet open until it finishes.</strong> Closing
              it stops the swap node — the swap is saved and picks up when you
              reopen and unlock, but while it is stopped nothing is watching
              the refund deadline for you.
            </li>
            <li style={{ marginBottom: 6 }}>
              <strong>A refund is a normal outcome, not an error.</strong> If
              the other side walks away, the timelock returns your coins to you.
              Nothing is stuck, and nobody has to step in to release it.
            </li>
            <li style={{ marginBottom: 6 }}>
              <strong>It runs locally.</strong> The node listens on loopback
              only (127.0.0.1). Its API password is generated on this machine,
              kept by the wallet, and never shown or sent anywhere.
            </li>
            <li>
              <strong>Fee: a per-use licence fee</strong> for the wallet
              software, shown as its own line before you commit — never a
              commission or a share of your trade. <strong>A swap runs and
              settles identically whether or not that fee is ever paid</strong>;
              nothing about your trade is gated on it.
            </li>
          </ul>

          <p style={{ marginBottom: 0, color: "var(--text-dim)", fontSize: 11 }}>
            You can stop the node, or turn this off again, from Settings at any
            time.
          </p>
        </div>

        {(busy || progress) && !error && (
          <div style={{ marginTop: 16 }}>
            <ProgressBar percent={pct} />
            <div
              style={{
                marginTop: 8,
                display: "flex",
                justifyContent: "space-between",
                gap: 10,
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--text-dim)",
              }}
            >
              <span>
                {progress
                  ? `${progress.stage}${progress.message ? ` — ${progress.message}` : ""}`
                  : phaseLabel(status?.phase)}
              </span>
              {progress && <span className="tnum">{pct.toFixed(0)}%</span>}
            </div>
          </div>
        )}

        {error && (
          <div
            style={{
              marginTop: 16,
              padding: 10,
              border: "1px solid rgba(255,59,59,0.4)",
              background: "rgba(255,59,59,0.06)",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              lineHeight: 1.5,
              color: "var(--danger)",
              wordBreak: "break-word",
            }}
          >
            <div style={{ marginBottom: 4, letterSpacing: 1, textTransform: "uppercase" }}>
              Setup did not finish
            </div>
            {/* Verbatim — the backend's message names the actual step that
                failed (prepare, port selection, health timeout, log tail). */}
            {error}
          </div>
        )}

        {done && !error && (
          <div
            style={{
              marginTop: 16,
              fontFamily: "var(--font-mono)",
              fontSize: 11.5,
              color: "var(--accent)",
            }}
          >
            Swap node running on 127.0.0.1
            {status ? `:${status.htmlPort}` : ""}. XMR and ZEPH swaps are now
            available from the Swap tab.
          </div>
        )}

        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          {done && !error ? (
            <Btn variant="accent" full size="lg" onClick={onDismiss}>
              ► Done
            </Btn>
          ) : (
            <>
              <Btn variant="accent" full size="lg" onClick={handleEnable} disabled={busy}>
                {busy
                  ? "Setting up…"
                  : error
                    ? "► Try again"
                    : "► Enable swaps"}
              </Btn>
              <Btn variant="ghost" full size="md" onClick={onDismiss} disabled={busy}>
                Not now
              </Btn>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
