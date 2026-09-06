import { useCallback, useMemo, useState } from "react";
import { Panel, Mono, ST } from "../../components/Primitives";
import { Btn } from "../../components/PrimitivesV2";
import { DataLocationsList } from "./DataLocationsCard";
import { WalletsCard } from "./WalletsCard";
import {
  SidecarSetupWizard,
  SidecarStatusCard,
  useSwapSidecarOptIn,
} from "../swap-sidecar";
import { DexCoinsSection } from "./DexCoinsSection";
import { SwapNodeExtras } from "./SwapNodeExtras";
import type { WalletKind } from "../../vault-schema";
import type { ChainType } from "../../wallets";
import { useAppState } from "../../state/AppStateContext";
import { deriveSwapWalletMaterial } from "../../lib/swapWalletKey";
import { useAccountKeyDeriver } from "../../state/useAccountKeyDeriver";


/**
 * The swap wallet's key material, derived from the unlocked vault.
 *
 * Lives in the Settings layer rather than inside `swap-sidecar` because
 * BOUNDARIES.md bars that feature from `src/crypto` and from the vault's
 * internals — the app layer owns the mnemonic and hands over only the derived
 * result.
 *
 * Any loaded chain's `mnemonic` is the same BIP-39 master, so the first
 * non-watch-only wallet is as good as any. A watch-only entry has no seed and
 * must be skipped, or the derivation would run on an empty string.
 */
/**
 * C8 — the account-key deriver for the card's MANUAL path.
 *
 * Same factory the automatic pass uses (see `makeAccountKeyDeriver`'s
 * header): the manual "Unlock swap wallets" button proved able to outrun the
 * automatic pass, so it must be able to finish the same job, from the same
 * construction. Null while the vault is locked or BTC/LTC are not loaded —
 * the card then simply skips the share step, exactly like the automatic
 * pass's own not-yet path.
 */
function useDeriveAccountKeys() {
  // Delegates to the app-wide hook. This function used to carry its own
  // BTC/LTC table — the third copy of it — so the manual "Unlock swap
  // wallets" button could not push a coin the automatic pass could not push
  // either. `undefined` (not null) is what the card's optional prop expects.
  return useAccountKeyDeriver() ?? undefined;
}

function useDeriveSwapMaterial() {
  const { walletsByChain } = useAppState();
  return useCallback(async () => {
    const vaultMnemonic = Object.values(walletsByChain).find(
      (w) => w && !w.watchOnly && w.mnemonic,
    )?.mnemonic;
    if (!vaultMnemonic) {
      throw new Error(
        "the vault must be unlocked to create the swap wallet — unlock, then run setup again",
      );
    }
    return deriveSwapWalletMaterial(vaultMnemonic);
  }, [walletsByChain]);
}

export function SettingsLandscapeView({
  onLock,
  layout,
  setLayout,
  onOpenP2P,
  xmrSeedLoaded,
  zphSeedLoaded,
  zanoSeedLoaded,
  onOpenMoneroNodes,
  onOpenZephyrNodes,
  onOpenZanoNodes,
  onOpenMinerSetup,
  onOpenWalletDetails,
  onAddWallet,
  onRenameWallet,
  onRemoveWallet,
  walletOpBusy,
  scanDateSlot,
}: {
  onLock: () => void;
  layout: "portrait" | "landscape";
  setLayout: (l: "portrait" | "landscape") => void;

  /**
   * Navigate to Swap ▸ P2P — frame 1h's primary action on the swap-node card.
   * Optional so a surface that cannot route simply renders the button
   * disabled rather than dead.
   */
  onOpenP2P?: () => void;
  xmrSeedLoaded: string | null;
  zphSeedLoaded: string | null;
  zanoSeedLoaded: string | null;
  onOpenMoneroNodes: () => void;
  onOpenZephyrNodes: () => void;
  onOpenZanoNodes: () => void;
  onOpenMinerSetup: () => void;
  onOpenWalletDetails: () => void;
  onAddWallet: (
    kind: WalletKind,
    input: string,
    name: string,
    chain?: ChainType
  ) => Promise<boolean>;
  onRenameWallet: (id: string, name: string) => Promise<void>;
  onRemoveWallet: (id: string) => Promise<void>;
  walletOpBusy: boolean;
  /** Scan-date editor, built by App (see `scanDateSlot`). One node instead of
   *  five props, and identical in both layouts because there's one instance. */
  scanDateSlot?: React.ReactNode;
}) {
  const [derivExpanded, setDerivExpanded] = useState(false);
  const [filesExpanded, setFilesExpanded] = useState(false);

  // ── D7: the swap-node host ────────────────────────────────────────────
  // `SidecarStatusCard` and `SidecarSetupWizard` were exported from
  // `features/swap-sidecar/index.ts` but mounted NOWHERE — grep for their
  // names returned only the barrel and their own definitions. So the opt-in
  // gate the whole sidecar subsystem hangs off had no reachable entry point:
  // a user could never turn swaps on, and every phase that assumes a Settings
  // host (C0.2 node pinning, C1's first-prepare mnemonic, C3's per-coin
  // enablement) was dead code. Settings is the host, landscape first.
  //
  // The wizard is a PAGE (its own `mining-header` + Back button), not a card,
  // so it replaces the whole settings surface rather than nesting in a
  // column. It is kept as local state instead of a new `view` id because the
  // landscape router (`LandscapeRoot`) routes sub-views by `view`, and adding
  // one there would put the mount outside this file — the same reason
  // portrait Settings does it locally too.
  const { enable: enableSwapSidecar } = useSwapSidecarOptIn();
  const [swapSetupOpen, setSwapSetupOpen] = useState(false);
  const deriveSwapMaterial = useDeriveSwapMaterial();
  const deriveAccountKeys = useDeriveAccountKeys();

  if (swapSetupOpen) {
    return (
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 10 }}>
        <SidecarSetupWizard
          onSetUp={enableSwapSidecar}
          onDismiss={() => setSwapSetupOpen(false)}
          deriveSwapMaterial={deriveSwapMaterial}
        />
      </div>
    );
  }

  // 2026-06-14 REDESIGN — the old layout was a page-level 2-col grid with
  // HARD-CODED `gridRow:1..5` on every panel. That left big cross-column
  // gaps (mismatched panel heights), rendered two near-empty Monero/Zephyr
  // boxes when no privacy wallet is loaded, was fragile (the explicit rows
  // broke when Danger Zone was absent), and overflowed the locked landscape
  // window once Derivation expanded. Replaced with two INDEPENDENT flex
  // columns (a masonry that can't leave cross-column gaps and reflows when
  // optional panels appear/disappear — no row math), the Monero/Zephyr
  // panels folded into one "Privacy Wallets" panel (absent chains show a
  // compact chip, not a half-empty box), Security+About+Layout merged into
  // one "Wallet" panel, and the missing `<ST>` scramble signature restored
  // on every section header.
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "hidden",
        display: "flex",
        gap: 10,
        padding: 10,
        maxWidth: 1180,
        width: "100%",
        margin: "0 auto",
        boxSizing: "border-box",
        animation: "fade-in .2s ease",
      }}
    >
      {/* ── LEFT COLUMN: Wallet (security + about + layout) ─────────── */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflow: "auto",
        }}
      >
        {/* Inner flowing column: the OUTER div scrolls; this inner sizes to its
            content so the Panels keep their natural height. As a height-
            constrained flex column the Panels (flex-shrink:1) got COMPRESSED on
            overflow and their content spilled/overlapped the next panel — the
            reported Settings "text flowing off panels" bug. Now it scrolls. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Panel label={<PanelTitle delay={40}>Wallet</PanelTitle>} pad={14}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <Btn variant="ghost" full onClick={onLock}>
                Lock Wallet
              </Btn>
              <Btn variant="ghost" full onClick={onOpenWalletDetails}>
                View Seed / Private Keys
              </Btn>
            </div>

            <div
              style={{
                borderTop: "1px solid var(--border-soft)",
                paddingTop: 10,
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              <InfoRow label="Version" value="v2.0.1" />
              <InfoRow label="Platform" value="Windows (Tauri)" />
              <InfoRow
                label="Mode"
                value={layout === "landscape" ? "Landscape" : "Portrait"}
              />
            </div>

            <div style={{ borderTop: "1px solid var(--border-soft)", paddingTop: 10 }}>
              <Mono
                size={8}
                color="var(--text-dim)"
                upper
                spacing={0.8}
                style={{ display: "block", marginBottom: 8 }}
              >
                Layout Mode
              </Mono>
              <div
                style={{
                  display: "flex",
                  border: "1px solid var(--border)",
                  borderRadius: 2,
                  overflow: "hidden",
                }}
              >
                {(["portrait", "landscape"] as const).map((l) => {
                  const active = layout === l;
                  return (
                    <button
                      key={l}
                      onClick={() => setLayout(l)}
                      title={`Switch to ${l} layout`}
                      style={{
                        flex: 1,
                        fontFamily: "var(--mono)",
                        fontSize: 9,
                        letterSpacing: 0.8,
                        padding: "8px 0",
                        textTransform: "uppercase",
                        // Active = accent fill; inactive = legible var(--text)
                        // so it reads as a clickable button, not a dead label.
                        background: active ? "var(--accent)" : "transparent",
                        border: "none",
                        color: active ? "#07120c" : "var(--text)",
                        fontWeight: active ? 600 : 400,
                        cursor: "pointer",
                        transition: "all .12s",
                      }}
                    >
                      {l}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </Panel>

        <WalletsCard
          onAdd={onAddWallet}
          onRename={onRenameWallet}
          onRemove={onRemoveWallet}
          busy={walletOpBusy}
          titleDelay={70}
        />

        {/* Swap node (BasicSwap sidecar) — D7's mount. Lives in the LEFT
            column because it is a top-level capability, not an accessory:
            burying it under the right column's five panels would repeat the
            "exported but unreachable" failure in a softer form. The card
            brings its own <Card> frame, which is the same border/surface/
            label-strip as <Panel>, so the column rhythm is unchanged.

            Pre-opt-in it renders a no-invoke explanation plus this button;
            it does not poll, download or spawn anything until the wizard
            below has been completed. */}
        <SidecarStatusCard
          onOpenSetup={() => setSwapSetupOpen(true)}
          deriveSwapMaterial={deriveSwapMaterial}
          deriveAccountKeys={deriveAccountKeys}
          onOpenP2P={onOpenP2P}
        />

        {/* C3 — per-coin DEX enablement. `DexCoinCard` was another
            "exported from the barrel, mounted nowhere" component; this is its
            host, directly under the node's own status card because the two
            answer consecutive questions ("is the node running" → "which chains
            does it carry").

            Renders NOTHING at all before opt-in (P1: a user who does not swap
            sees no change), which is also what keeps `swap_sidecar_coin_status`
            uninvoked on a fresh install. */}
        <DexCoinsSection />
      <SwapNodeExtras />
        </div>
      </div>

      {/* ── RIGHT COLUMN: mining sw + privacy wallets + danger + deriv ── */}
      <div
        style={{
          flex: 1.15,
          minWidth: 0,
          minHeight: 0,
          overflow: "auto",
        }}
      >
        {/* Inner flowing column — scrolls instead of compressing the Panels;
            see the left column note above. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {/* Mining Software */}
        <Panel label={<PanelTitle delay={95}>Mining Software</PanelTitle>} pad={14}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[
              { name: "XMRig", algo: "RandomX (CPU)", desc: "Monero CPU mining" },
              { name: "SRBMiner-MULTI", algo: "KawPow (GPU)", desc: "Ravencoin GPU mining" },
              { name: "lolMiner", algo: "Octopus (GPU)", desc: "Conflux GPU mining" },
            ].map((sw) => (
              <div
                key={sw.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 8px",
                  border: "1px solid rgba(255,255,255,0.08)",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Mono size={10} color="var(--text)">
                    {sw.name}
                  </Mono>
                  <Mono
                    size={8}
                    color="var(--text-dim)"
                    style={{ display: "block", marginTop: 2 }}
                  >
                    {sw.algo} · {sw.desc}
                  </Mono>
                </div>
                <div
                  style={{ width: 6, height: 6, background: "var(--text-dim)", flexShrink: 0 }}
                />
              </div>
            ))}
            <Btn variant="ghost" full onClick={onOpenMinerSetup}>
              Setup / Reinstall Miners
            </Btn>
          </div>
        </Panel>

        {/* Privacy Wallets — Monero + Zephyr + Zano folded into one panel;
            an absent chain renders a compact "not imported" chip rather than
            a whole half-empty box (the old layout's headline waste). Zano
            row only appears once a seed is loaded, matching the portrait
            SettingsView button's `zanoSeedLoaded &&` gate — PrivacyNodeRow
            already handles the "not loaded" case for the other two chains,
            but Zano has no unmanaged-state affordance yet (no import entry
            point from this panel), so hiding the row entirely avoids a
            dead-end "Manage" link. */}
        <Panel label={<PanelTitle delay={150}>Privacy Wallets</PanelTitle>} pad={14}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <PrivacyNodeRow
              chain="Monero"
              loaded={!!xmrSeedLoaded}
              onManage={onOpenMoneroNodes}
            />
            <PrivacyNodeRow
              chain="Zephyr"
              loaded={!!zphSeedLoaded}
              onManage={onOpenZephyrNodes}
            />
            {zanoSeedLoaded && (
              <PrivacyNodeRow
                chain="Zano"
                loaded={!!zanoSeedLoaded}
                onManage={onOpenZanoNodes}
              />
            )}
          </div>
        </Panel>

        {/* Files on Disk — where the XMR/ZPH wallet + scanned-chain cache and
            miner binaries live on disk; click any path to open it in the file
            manager. Shared with portrait Settings via DataLocationsList. */}
        <Panel label={<PanelTitle delay={180}>Files on Disk</PanelTitle>} pad={14}>
          {/* Collapsed by default (2026-08-22): six full-width path buttons
              for folders a user opens once a year. One click to show. */}
          <button
            type="button"
            onClick={() => setFilesExpanded((v) => !v)}
            style={{
              alignSelf: "flex-start",
              background: "none",
              border: "none",
              color: "var(--accent)",
              cursor: "pointer",
              padding: 0,
              fontFamily: "var(--mono)",
              fontSize: 10,
            }}
          >
            {filesExpanded ? "▾ Hide folders" : "▸ Show folders"}
          </button>
          {filesExpanded && (
            <div style={{ marginTop: 10 }}>
              <DataLocationsList />
            </div>
          )}
        </Panel>

        {/* Danger Zone was removed 2026-08-21: Settings ▸ Wallets (above)
            already removes any wallet by id, including the primary XMR/ZPH
            entry — removeWallet() now does the same session teardown this
            panel's buttons used to (see useVault.ts). Two paths to the same
            destructive action is the clutter, not the safety. */}

        {/* Scan-date editor. Sits where Danger Zone used to, which is still the
            right place for the reason origin/main put it there: "my balance is
            0" should lead to a rescan, not to removing the wallet. Same element
            portrait renders, so the two layouts cannot drift. */}
        {scanDateSlot}

        {/* Derivation & wallet-compatibility — collapsed by default. The
            only panel allowed to grow; with the per-column overflow only
            this right column scrolls, never the whole page. */}
        <Panel
          label={<PanelTitle delay={260}>Derivation &amp; Wallet Compatibility</PanelTitle>}
          pad={14}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Mono size={10} color="var(--text-muted)" style={{ lineHeight: 1.55 }}>
              Imported a seed and don't see your funds?{" "}
              <span style={{ color: "var(--accent)" }}>
                Open the chain's tab → "Or find a specific address"
              </span>
              .
            </Mono>
            <button
              type="button"
              onClick={() => setDerivExpanded((v) => !v)}
              style={{
                alignSelf: "flex-start",
                background: "none",
                border: "none",
                color: "var(--accent)",
                cursor: "pointer",
                padding: 0,
                fontFamily: "var(--mono)",
                fontSize: 10,
              }}
            >
              {derivExpanded ? "▾ Hide background" : "▸ Learn more about derivation paths"}
            </button>
            {derivExpanded && (
              <>
                <Mono size={10} color="var(--text-muted)" style={{ lineHeight: 1.55 }}>
                  A 12-word seed phrase is just entropy. The actual addresses
                  come from running it through a "derivation path" algorithm —{" "}
                  different wallets pick different paths, so the same seed can
                  produce different addresses across wallets; neither is
                  wrong, they're just different conventions.
                </Mono>
                <Mono size={10} color="var(--text-muted)" style={{ lineHeight: 1.55 }}>
                  <span style={{ color: "#ffae42" }}>
                    Closed-source wallets sometimes use proprietary
                    derivations that no other wallet matches.
                  </span>{" "}
                  If one shuts down or stops updating, the published-standard
                  wallets you'd migrate to may show empty balances even
                  though your funds are still on-chain — the addresses they
                  derive simply don't match what the closed wallet produced.
                  Pwnda's probe brute-forces ~120+ candidates (including
                  documented Exodus and Atomic paths) to find the match.
                </Mono>
                <Mono size={10} color="var(--text-dim)" style={{ lineHeight: 1.55 }}>
                  General practice: generate a new seed in an open-source
                  wallet first, or test that it restores correctly across at
                  least two wallets before funding it.
                </Mono>
              </>
            )}
          </div>
        </Panel>
        </div>
      </div>
    </div>
  );
}

/** Section-header eyebrow with the scramble decode-on-mount signature
 *  (BEHAVIORS.md), staggered by `delay` — matches the rest of the landscape
 *  suite (MineLandscapeView / WalletLandscapeView). */
function PanelTitle({ children, delay = 0 }: { children: string; delay?: number }) {
  return (
    <ST delay={delay} speed={22}>
      {children}
    </ST>
  );
}

/** One compact row per privacy chain inside the folded "Privacy Wallets"
 *  panel. A loaded chain shows a Manage button; an absent chain shows a
 *  muted "not imported" chip instead of an entire half-empty panel. */
function PrivacyNodeRow({
  chain,
  loaded,
  onManage,
}: {
  chain: string;
  loaded: boolean;
  onManage: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        border: "1px solid var(--border-soft)",
        background: "var(--surface-2)",
      }}
    >
      <Mono size={10} color="var(--text)" style={{ width: 64 }}>
        {chain}
      </Mono>
      <div style={{ flex: 1 }} />
      {loaded ? (
        <button
          type="button"
          onClick={onManage}
          style={{
            fontFamily: "var(--mono)",
            fontSize: 9,
            letterSpacing: 0.6,
            padding: "5px 10px",
            textTransform: "uppercase",
            background: "transparent",
            border: "1px solid var(--border)",
            color: "var(--text)",
            cursor: "pointer",
          }}
        >
          Manage Nodes
        </button>
      ) : (
        <Mono size={9} color="var(--text-dim)" upper spacing={0.6}>
          not imported
        </Mono>
      )}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <Mono size={9} color="var(--text-dim)" upper spacing={0.8}>
        {label}
      </Mono>
      <Mono size={9} color="var(--text)">
        {value}
      </Mono>
    </div>
  );
}
