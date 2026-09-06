import { useState } from "react";
import { ST } from "../../components/Primitives";
import { Card, Btn } from "../../components/PrimitivesV2";
import { supportsDefenderExclusion, needsLinuxPerfSetup } from "../../platform/os";

/**
 * The single opt-in gate for the full wallet's mining subsystem
 * (pure-wallet cutover, 2026-07-06). Rendered by the Mine tab / mine
 * landscape rail whenever mining is **not** opted-in (see `miningOptIn.ts`);
 * once the user completes it, the same tab renders the live `MiningView`.
 *
 * This collapses the old scattered, involuntary setup gates (miner-status
 * probe, Defender check, MSR scan, device profile) into ONE deliberate
 * decision. "Set up mining" persists the opt-in flag and hands off to the
 * existing `MinerSetupView` (step 2–4: on-demand binary download, Windows
 * Defender exclusion, device-profile detection). "Not now" leaves the wallet
 * dormant — nothing mining-related runs, downloads, elevates, or touches
 * Defender until the user comes back and opts in.
 *
 * PwndaLite never mounts this — Lite is mining-only and always-on.
 */
export function MiningSetupWizard({
  onSetUp,
  onDismiss,
}: {
  /** Persist the opt-in flag and proceed into the setup flow. Async — the
   *  wizard shows a "Setting up…" state while it resolves. */
  onSetUp: () => void | Promise<void>;
  /** Dismiss without opting in — returns to the wallet, mining dormant. */
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const isWin = supportsDefenderExclusion();
  const isLinux = needsLinuxPerfSetup();

  const handleSetUp = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onSetUp();
    } finally {
      // Parent navigates away on success; only reset if we're still mounted.
      setBusy(false);
    }
  };

  return (
    <div className="miner-setup-view" style={{ animation: "fade-in .2s ease" }}>
      <div className="mining-header">
        <button className="btn-icon" onClick={onDismiss} title="Back">
          ► Back
        </button>
        <h2>
          <ST delay={0} speed={22}>SET UP MINING</ST>
        </h2>
      </div>

      <Card title="MINE WITH PWNDAWALLET">
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.6,
            color: "var(--text-muted)",
          }}
        >
          <p style={{ marginTop: 0 }}>
            Mining is <strong>optional and off by default</strong>. Turn it on
            to put your CPU or GPU to work mining supported coins
            (<strong>XMR · ZEPH · RVN · CFX · ERG</strong>) straight to your own
            wallet address. Here's what setting it up does:
          </p>

          <ul style={{ margin: "10px 0 12px", paddingLeft: 18 }}>
            <li style={{ marginBottom: 6 }}>
              <strong>Uses your hardware.</strong> The miner runs your CPU/GPU
              at high load while a session is active — expect more heat, fan
              noise, and power draw. Stopping mining releases it instantly.
            </li>
            <li style={{ marginBottom: 6 }}>
              <strong>Downloads mining software on demand.</strong> Nothing
              ships pre-installed. PwndaWallet fetches the miner it needs
              (XMRig / lolMiner / SRBMiner) from the official upstream release
              into your app-data folder — only when you set up here.
            </li>
            {isWin && (
              <li style={{ marginBottom: 6 }}>
                <strong>Needs administrator rights + a Defender exclusion.</strong>{" "}
                Windows Defender flags miner executables by default, so the
                setup screen will <em>offer</em> to add an exclusion for the
                miners folder — your call, and only for the mining folder. The
                installer never touches your antivirus. Starting a session
                prompts a one-time <em>per-session</em> UAC elevation (the miner
                needs it for full RandomX hashrate).
              </li>
            )}
            {isLinux && (
              <li style={{ marginBottom: 6 }}>
                <strong>Optional performance setup.</strong> For full RandomX
                hashrate you can enable the MSR module + huge pages (a couple of{" "}
                <code>sudo</code> commands shown on the setup screen). Mining
                still works unprivileged without them, at a small hashrate cost.
              </li>
            )}
            <li>
              <strong>No fees, no phone-home.</strong> 100% of what you mine
              goes to your wallet — there is no developer fee and no leaderboard
              uplink. The only mining traffic is to the pool you choose (plus an
              optional SOCKS5 privacy proxy).
            </li>
          </ul>

          <p style={{ marginBottom: 0, color: "var(--text-dim)", fontSize: 11 }}>
            You can turn mining back off anytime from the miner setup screen —
            it returns the wallet to its pure, dormant state.
          </p>
        </div>

        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          <Btn variant="accent" full size="lg" onClick={handleSetUp} disabled={busy}>
            {busy ? "Setting up…" : "► Set up mining"}
          </Btn>
          <Btn variant="ghost" full size="md" onClick={onDismiss} disabled={busy}>
            Not now
          </Btn>
        </div>
      </Card>
    </div>
  );
}
