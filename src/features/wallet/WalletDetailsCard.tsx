import { ST } from "../../components/Primitives";
import { Card } from "../../components/PrimitivesV2";
import type { WalletInfo } from "../../wallets";
import { BtcLegacyPanel } from "./BtcLegacyPanel";
import { AdaLegacyPanel } from "./AdaLegacyPanel";
import { SolanaDerivationPanel } from "./SolanaDerivationPanel";
import { LitecoinDerivationPanel } from "./LitecoinDerivationPanel";
import { CoinDerivationPanel, DerivationProfileSwitch } from "./CoinDerivationPanel";
import type { ProfilePathCoin } from "../onboarding/derivation-detector";
import type { ProfileId } from "../onboarding/derivation-profiles";
import { UtxoAccountCard } from "./UtxoAccountCard";
import { useUtxoAccountSummaries } from "../../lib/utxoAccountRegistry";
import type { UtxoAccountSummary } from "../../wallets/utxo-account-balance";
import { STANDARD_GAP_LIMIT } from "../../wallets/utxo-account";
import { getAdapter } from "../../wallets";

/** Heading + paste-input hint for each secp256k1 profile coin's panel. */
const COIN_PANEL_META: Record<ProfilePathCoin, { label: string; addressKind: string }> = {
  xrp: { label: "XRP", addressKind: "XRP address (r…)" },
  tron: { label: "TRON", addressKind: "TRON address (T…)" },
  ravencoin: { label: "Ravencoin", addressKind: "RVN address (R…)" },
  dash: { label: "Dash", addressKind: "DASH address (X…)" },
};

/**
 * Sensitive-keys panel: mnemonic, private key, and (when present) the
 * Monero / Zephyr 25-word seeds. Each row is independently
 * show/hide-gated so the user only ever uncovers what they need.
 *
 * Lifted out of `App.tsx`'s `view === "wallet-details"` branch so the
 * landscape Settings tab can mount the same card without duplicating
 * markup. State (the four show-flags + setters) stays in App.tsx — this
 * is purely presentational.
 */
export function WalletDetailsCard(props: {
  wallet: WalletInfo;
  sharedMnemonic: string | null;
  showMnemonic: boolean;
  setShowMnemonic: (v: boolean) => void;
  showPrivateKey: boolean;
  setShowPrivateKey: (v: boolean) => void;
  xmrSeedLoaded: string | null;
  showXmrSeed: boolean;
  setShowXmrSeed: (v: boolean) => void;
  zphSeedLoaded: string | null;
  showZphSeed: boolean;
  setShowZphSeed: (v: boolean) => void;
  /** Zano seed + its Secured-Seed passphrase. Both are needed to restore a
   *  Zano wallet, which is why they are revealed together — see the note
   *  in the render below. */
  zanoSeedLoaded?: string | null;
  zanoSeedPassphrase?: string | null;
  showZanoSeed?: boolean;
  setShowZanoSeed?: (v: boolean) => void;
  /** Live `derivationChoice.solana` from the vault. Used by the SOL
   *  panel to highlight the active path; null when no vault is loaded. */
  currentSolanaDerivationChoice?: string;
  /** Save+re-derive callback when the user picks an alternative SOL path. */
  onChangeSolanaDerivation?: (newChoice: string) => Promise<void>;
  /** Live `derivationChoice.litecoin` from the vault — drives the LTC panel
   *  (Exodus legacy L… vs default ltc1q…); null when no vault is loaded. */
  currentLitecoinDerivationChoice?: string;
  /** Save+re-derive callback when the user picks an alternative LTC path. */
  onChangeLitecoinDerivation?: (newChoice: string) => Promise<void>;
  /** Save+re-derive callback for the secp256k1 profile coins (XRP/TRX/RVN/DASH).
   *  The choice value is a raw HD path; drives `CoinDerivationPanel`. */
  onChangeCoinDerivation?: (coin: ProfilePathCoin, path: string) => Promise<void>;
  /** Apply a whole derivation profile (Standard/Exodus/Atomic) across every
   *  coin at once; drives `DerivationProfileSwitch`. */
  onApplyProfile?: (profile: ProfileId) => Promise<void>;
  onCopy: (text: string) => void;
  onBack: () => void;
}) {
  const {
    wallet, sharedMnemonic,
    showMnemonic, setShowMnemonic,
    showPrivateKey, setShowPrivateKey,
    xmrSeedLoaded, showXmrSeed, setShowXmrSeed,
    zphSeedLoaded, showZphSeed, setShowZphSeed,
    zanoSeedLoaded, zanoSeedPassphrase, showZanoSeed, setShowZanoSeed,
    currentSolanaDerivationChoice,
    onChangeSolanaDerivation,
    currentLitecoinDerivationChoice,
    onChangeLitecoinDerivation,
    onChangeCoinDerivation,
    onApplyProfile,
    onCopy, onBack,
  } = props;

  return (
    <div className="wallet-details-view" style={{ animation: "fade-in .2s ease" }}>
      <div className="mining-header">
        <button className="btn-icon" onClick={onBack} title="Back">
          ► Back
        </button>
        <h2><ST delay={0} speed={22}>WALLET DETAILS</ST></h2>
      </div>
      <Card>
        {sharedMnemonic && (
          <div className="secret-row">
            <div className="secret-header">
              <span className="label"><ST delay={60} speed={20}>Mnemonic (all chains)</ST></span>
              <button className="btn-icon" onClick={() => setShowMnemonic(!showMnemonic)}>
                {showMnemonic ? "Hide" : "Show"}
              </button>
            </div>
            {showMnemonic && (
              <div className="secret-value" style={{ flexDirection: "column", alignItems: "stretch" }}>
                {/* UXS-20260516-111: render words as a numbered grid
                    so word-break can never split a word across lines
                    (the bug rendered "abandon" as "abando / n", a
                    recovery hazard). Matches BackupView's `seed-grid`
                    presentation byte-for-byte. */}
                <MnemonicGrid phrase={sharedMnemonic} />
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
                  <button className="btn-icon" onClick={() => onCopy(sharedMnemonic)}>
                    Copy
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        <div className="secret-row">
          <div className="secret-header">
            <span className="label"><ST delay={120} speed={22}>Private Key</ST></span>
            <button className="btn-icon" onClick={() => setShowPrivateKey(!showPrivateKey)}>
              {showPrivateKey ? "Hide" : "Show"}
            </button>
          </div>
          {showPrivateKey && (
            <div className="secret-value">
              <code>{wallet.privateKey}</code>
              <button className="btn-icon" onClick={() => onCopy(wallet.privateKey)}>
                Copy
              </button>
            </div>
          )}
        </div>
        {xmrSeedLoaded && (
          <div className="secret-row">
            <div className="secret-header">
              <span className="label"><ST delay={175} speed={20}>Monero Seed (25 words)</ST></span>
              <button className="btn-icon" onClick={() => setShowXmrSeed(!showXmrSeed)}>
                {showXmrSeed ? "Hide" : "Show"}
              </button>
            </div>
            {showXmrSeed && (
              <div className="secret-value" style={{ flexDirection: "column", alignItems: "stretch" }}>
                <MnemonicGrid phrase={xmrSeedLoaded} />
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
                  <button className="btn-icon" onClick={() => onCopy(xmrSeedLoaded)}>
                    Copy
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {zphSeedLoaded && (
          <div className="secret-row">
            <div className="secret-header">
              <span className="label"><ST delay={200} speed={20}>Zephyr Seed (25 words)</ST></span>
              <button className="btn-icon" onClick={() => setShowZphSeed(!showZphSeed)}>
                {showZphSeed ? "Hide" : "Show"}
              </button>
            </div>
            {showZphSeed && (
              <div className="secret-value" style={{ flexDirection: "column", alignItems: "stretch" }}>
                <MnemonicGrid phrase={zphSeedLoaded} />
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
                  <button className="btn-icon" onClick={() => onCopy(zphSeedLoaded)}>
                    Copy
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {zanoSeedLoaded && setShowZanoSeed && (
          <div className="secret-row">
            <div className="secret-header">
              <span className="label"><ST delay={215} speed={20}>Zano Seed (26 words)</ST></span>
              <button className="btn-icon" onClick={() => setShowZanoSeed(!showZanoSeed)}>
                {showZanoSeed ? "Hide" : "Show"}
              </button>
            </div>
            {showZanoSeed && (
              <div className="secret-value" style={{ flexDirection: "column", alignItems: "stretch" }}>
                <MnemonicGrid phrase={zanoSeedLoaded} />

                {/* The passphrase is revealed WITH the words, on purpose.
                    Zano mixes a Secured-Seed passphrase into the seed itself:
                    the same 26 words with a different passphrase restore a
                    different, empty wallet. A backup of the words alone is
                    therefore not a backup at all for a protected seed, and
                    this screen is the only place the user can read back what
                    they entered at import. See zano-keys.ts's
                    `verifyZanoSeedIntegrity` for the mechanism. */}
                {zanoSeedPassphrase ? (
                  <div style={{ marginTop: 10 }}>
                    <div className="label" style={{ marginBottom: 4 }}>
                      Secured Seed passphrase — required with these words
                    </div>
                    <div className="secret-value">
                      <code>{zanoSeedPassphrase}</code>
                      <button className="btn-icon" onClick={() => onCopy(zanoSeedPassphrase)}>
                        Copy
                      </button>
                    </div>
                    <p className="hint" style={{ marginTop: 6, lineHeight: 1.5 }}>
                      Back this up with the words. Restoring them without it
                      opens a different, empty wallet.
                    </p>
                  </div>
                ) : (
                  <p className="hint" style={{ marginTop: 8 }}>
                    No Secured Seed passphrase — these 26 words are the whole backup.
                  </p>
                )}

                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
                  <button className="btn-icon" onClick={() => onCopy(zanoSeedLoaded)}>
                    Copy
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        <p className="warning">
          <ST delay={280} speed={18}>
            Never share your private key, mnemonic, or any chain seed.
          </ST>
        </p>
        {/* The restore instruction, next to the thing it is an instruction
            FOR (2026-08-25). `UtxoAccountCard` already computes and shows
            `requiredGapLimit`, but it renders further down a scrollable
            panel — and the moment this number is needed is the moment the
            user is looking at their seed phrase, possibly on another device,
            possibly with this app unavailable. A number that is only correct
            somewhere the user is not looking is not a working warning. */}
        <RestoreGapLimitNote onCopy={onCopy} />
      </Card>
      {wallet.chain === "bitcoin" && sharedMnemonic && (
        <BtcLegacyPanel
          mnemonic={sharedMnemonic}
          standardAddress={wallet.address}
          onCopy={onCopy}
        />
      )}
      {wallet.chain === "cardano" && sharedMnemonic && (
        <AdaLegacyPanel mnemonic={sharedMnemonic} onCopy={onCopy} />
      )}
      {wallet.chain === "solana" &&
        sharedMnemonic &&
        currentSolanaDerivationChoice &&
        onChangeSolanaDerivation && (
          <SolanaDerivationPanel
            mnemonic={sharedMnemonic}
            currentChoice={currentSolanaDerivationChoice}
            onChooseDerivation={onChangeSolanaDerivation}
            onCopy={onCopy}
          />
        )}
      {wallet.chain === "litecoin" &&
        sharedMnemonic &&
        currentLitecoinDerivationChoice &&
        onChangeLitecoinDerivation && (
          <LitecoinDerivationPanel
            mnemonic={sharedMnemonic}
            currentChoice={currentLitecoinDerivationChoice}
            onChooseDerivation={onChangeLitecoinDerivation}
            onCopy={onCopy}
          />
        )}
      {/* Account-wide address list + restore-safety warning. This is the
          surface that matters most in a real recovery: it names every path
          holding funds and the gap limit a third-party wallet needs to reach
          them — facts nobody can look up once this app is unavailable. */}
      {getAdapter(wallet.chain).utxoAccounts && sharedMnemonic && (
        <UtxoAccountCard
          chain={wallet.chain}
          mnemonic={sharedMnemonic}
          address={wallet.address}
          onCopy={onCopy}
        />
      )}
      {(wallet.chain === "xrp" ||
        wallet.chain === "tron" ||
        wallet.chain === "ravencoin" ||
        wallet.chain === "dash") &&
        sharedMnemonic &&
        onChangeCoinDerivation && (
          <CoinDerivationPanel
            coin={wallet.chain}
            coinLabel={COIN_PANEL_META[wallet.chain].label}
            addressKind={COIN_PANEL_META[wallet.chain].addressKind}
            mnemonic={sharedMnemonic}
            currentAddress={wallet.address}
            onChoose={onChangeCoinDerivation}
            onCopy={onCopy}
          />
        )}
      {/* Global profile switch — one control re-derives every coin. Shown on
          every wallet's detail page (it isn't coin-specific). */}
      {sharedMnemonic && onApplyProfile && (
        <DerivationProfileSwitch onApply={onApplyProfile} />
      )}
    </div>
  );
}

/**
 * Numbered word grid for mnemonic / 25-word seed display. Forces each
 * word into its own inline-block cell so word-break can never split a
 * word across lines (the bug from UXS-20260516-111 where `abandon`
 * rendered as `abando / n` across two visual lines, a hand-recovery
 * hazard). Mirrors the `.seed-grid` / `.seed-word` markup used by
 * `BackupView` so the visual treatment is consistent end-to-end.
 */
function MnemonicGrid({ phrase }: { phrase: string }) {
  const words = phrase.split(/\s+/).filter(Boolean);
  return (
    <div className="seed-grid">
      {words.map((word, i) => (
        <span key={i} className="seed-word">
          <span className="seed-num">{i + 1}.</span> {word}
        </span>
      ))}
    </div>
  );
}

/**
 * "When you restore this seed elsewhere, set the gap limit to N."
 *
 * Reads every scanned UTXO chain from the account registry and reports the
 * WORST `requiredGapLimit` across them, because a restore is configured once
 * and has to satisfy every chain at once. Renders nothing when 20 (the
 * BIP-44 standard) is already enough — which is the normal case, and saying
 * so unprompted would train the user to ignore it.
 */
function RestoreGapLimitNote({ onCopy }: { onCopy: (t: string) => void }) {
  const summaries = useUtxoAccountSummaries();
  const scanned = Object.values(summaries).filter(Boolean) as UtxoAccountSummary[];
  const required = scanned.reduce(
    (m, s) => Math.max(m, s.requiredGapLimit ?? STANDARD_GAP_LIMIT),
    STANDARD_GAP_LIMIT,
  );
  if (required <= STANDARD_GAP_LIMIT) return null;

  const chains = scanned
    .filter((s) => (s.requiredGapLimit ?? 0) > STANDARD_GAP_LIMIT)
    .map((s) => s.chain.toUpperCase());
  const line =
    `When restoring this seed, set the address gap limit to ${required} or higher ` +
    `(default is ${STANDARD_GAP_LIMIT}). Affects: ${chains.join(", ")}.`;

  return (
    <div
      style={{
        marginTop: 10,
        padding: "8px 10px",
        border: "1px solid var(--warn, #ffb020)",
        background: "rgba(255,176,32,0.08)",
        fontSize: 10,
        lineHeight: 1.5,
      }}
    >
      <div style={{ color: "var(--warn, #ffb020)", marginBottom: 4 }}>
        ⚠ Write this down WITH your recovery phrase
      </div>
      <div style={{ color: "var(--text-dim)" }}>
        Set the address gap limit to{" "}
        <strong style={{ color: "var(--text)" }}>{required} or higher</strong>{" "}
        when restoring this seed into Electrum, a hardware wallet, or anything
        else. The default is {STANDARD_GAP_LIMIT}, and at that setting some of
        your {chains.join(" / ")} would not be found — the coins are safe and
        the seed is correct, the scanner just stops looking too early.
      </div>
      <div style={{ marginTop: 8 }}>
        <button className="btn-icon" onClick={() => onCopy(line)}>
          Copy this note
        </button>
      </div>
    </div>
  );
}
