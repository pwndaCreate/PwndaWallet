import { useCallback, useEffect, useMemo, useState } from "react";
import { WalletsCard } from "./WalletsCard";
import type { WalletKind } from "../../vault-schema";
import type { ChainType } from "../../wallets/types";
import { isWindows, isLinux, isMac } from "../../platform/os";
import {
  checkForUpdate,
  installUpdate,
  isUpdaterSupported,
  type UpdateInfo,
} from "../../lib/updater";
import { ST } from "../../components/Primitives";
import { Btn, Card } from "../../components/PrimitivesV2";
import { invoke } from "../../lib/tauri";
import { DataLocationsCard } from "./DataLocationsCard";
import { SidecarUpdateCard } from "./SidecarUpdateCard";
import {
  SidecarSetupWizard,
  SidecarStatusCard,
  useSwapSidecarOptIn,
} from "../swap-sidecar";
import { DexCoinsSection } from "./DexCoinsSection";
import { SwapNodeExtras } from "./SwapNodeExtras";
import {
  DEFAULT_PROXY_URL,
  enrollWithProxy,
  getProxyStatus,
  getProxyUrlOverride,
  setProxyUrlOverride,
  testProxyConnection,
  type ConnectionTest,
  type ProxyStatus,
} from "../../api/proxy";
import { useSwapSettings } from "./useSwapSettings";
import {
  ROUTER_MODES,
  ROUTER_PREFERENCE_OPTIONS,
} from "../swap/router-modes";
import {
  AllRpcsFailedError,
  RPC_DEFAULTS,
  probeChain,
  rpcsFor,
  type ChainKey,
} from "../../wallets/chain-rpcs";
import { MemoryTraceCard } from "../mining/MemoryTraceCard";
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

export function SettingsView({
  onBack,
  onOpenWalletDetails,
  onOpenMinerSetup,
  onOpenP2P,
  xmrSeedLoaded,
  zphSeedLoaded,
  zanoSeedLoaded,
  onOpenMoneroNodes,
  onOpenZephyrNodes,
  onOpenZanoNodes,
  scanDateSlot,
  onAddWallet,
  onRenameWallet,
  onRemoveWallet,
  walletOpBusy = false,
}: {
  onBack: () => void;
  onOpenWalletDetails: () => void;
  onOpenMinerSetup: () => void;

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
  /** Scan-date editor built by App — the SAME element landscape renders, so
   *  the two layouts cannot drift. */
  scanDateSlot?: React.ReactNode;
  /** Wallet list operations. Same handlers landscape passes to the same
   *  `WalletsCard` — see the mount below for why portrait needs it. */
  onAddWallet?: (
    kind: WalletKind,
    input: string,
    name: string,
    chain?: ChainType
  ) => Promise<boolean>;
  onRenameWallet?: (id: string, name: string) => Promise<void>;
  onRemoveWallet?: (id: string) => Promise<void>;
  walletOpBusy?: boolean;
}) {
  // D7 — portrait inherits the landscape settings mount (see
  // SettingsLandscapeView for the reasoning). Same local-state wizard route:
  // `SidecarSetupWizard` is a page with its own header, so it replaces the
  // settings body rather than nesting inside a Card.
  const { enable: enableSwapSidecar } = useSwapSidecarOptIn();
  const [swapSetupOpen, setSwapSetupOpen] = useState(false);
  const deriveSwapMaterial = useDeriveSwapMaterial();
  const deriveAccountKeys = useDeriveAccountKeys();

  // Rendered as a fixed overlay rather than an early `return` of the wizard
  // alone. Caught in the Playwright pass: `ViewRouter.tsx:654` appends a
  // "LAYOUT" <Card> as a SIBLING of <SettingsView>, outside this component, so
  // swapping this component's own output still left that card painted beneath
  // a full-page wizard. An overlay is correct regardless of what the parent
  // appends, and ViewRouter is another workstream's file.
  //
  // zIndex 60 matches the swap modals (`features/swap/modal-parts.tsx:37`).
  // The BottomNav still paints over it (it sits in the shell's own stacking
  // context, not this one) — that is the same behaviour the mining setup
  // wizard has, so the user keeps a way out that isn't "Not now".
  if (swapSetupOpen) {
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          overflowY: "auto",
          background: "var(--bg)",
        }}
      >
        <SidecarSetupWizard
          onSetUp={enableSwapSidecar}
          onDismiss={() => setSwapSetupOpen(false)}
          deriveSwapMaterial={deriveSwapMaterial}
        />
      </div>
    );
  }

  return (
    <div className="settings-view" style={{ animation: "fade-in .2s ease" }}>
      <div className="mining-header">
        <button className="btn-icon" onClick={onBack} title="Back">
          ► Back
        </button>
        <h2><ST delay={0} speed={22}>SETTINGS</ST></h2>
      </div>
      <Card title="OPTIONS">
        <button className="btn-primary btn-block" onClick={onOpenWalletDetails}>
          <ST delay={120} speed={20}>► Wallet Details</ST>
        </button>
        <button className="btn-primary btn-block" onClick={onOpenMinerSetup}>
          <ST delay={175} speed={20}>► Miner Setup</ST>
        </button>
        {xmrSeedLoaded && (
          <button className="btn-primary btn-block" onClick={onOpenMoneroNodes}>
            <ST delay={230} speed={20}>► Monero Nodes</ST>
          </button>
        )}
        {zphSeedLoaded && (
          <button className="btn-primary btn-block" onClick={onOpenZephyrNodes}>
            <ST delay={305} speed={20}>► Zephyr Nodes</ST>
          </button>
        )}
        {zanoSeedLoaded && (
          <button className="btn-primary btn-block" onClick={onOpenZanoNodes}>
            <ST delay={380} speed={20}>► Zano Nodes</ST>
          </button>
        )}
      </Card>
      {/* Removing a wallet (including the primary XMR/ZPH pair) now lives
          only in Settings ▸ Wallets — removeWallet() there does the same
          session teardown these Forget buttons used to (see useVault.ts,
          2026-08-21). Two destructive buttons for one action was the
          clutter, not the safety.

          That change deleted portrait's Forget buttons and pointed here, but
          the card itself was only ever mounted in landscape — so from
          2026-08-21 until the origin/main merge on 2026-09-03, portrait had
          NO way to remove a wallet, and the copy above cheerfully directed
          users to a surface that did not exist in their layout. Found by
          layout-parity.test.ts's removal-verb assertion, which came in on the
          origin/main side and failed against swap-desk's newer settings tree.
          The same shared component both layouts now render. */}
      {onAddWallet && onRenameWallet && onRemoveWallet && (
        <WalletsCard
          onAdd={onAddWallet}
          onRename={onRenameWallet}
          onRemove={onRemoveWallet}
          busy={walletOpBusy}
        />
      )}

      {/* Scan-date editor. Same element the landscape settings render, so the
          two layouts cannot drift. */}
      {scanDateSlot}

      <SwapSettingsCard />
      {/* Swap node (BasicSwap sidecar) — D7's portrait mount, placed directly
          under the SWAP card so the node's state sits beside the swap
          preferences it governs. Renders a no-invoke explanation until the
          user opts in. */}
      <SidecarStatusCard
        onOpenSetup={() => setSwapSetupOpen(true)}
        deriveSwapMaterial={deriveSwapMaterial}
        deriveAccountKeys={deriveAccountKeys}
        onOpenP2P={onOpenP2P}
      />
      {/* C3 — per-coin DEX enablement. Portrait inherits the landscape block
          verbatim (same component, same position relative to the node status
          card); the section renders null before opt-in, so a non-swapping
          user's Settings page is byte-identical to what it was. */}
      <DexCoinsSection />
      <SwapNodeExtras />
      <DerivationWarningCard />
      <WalletProxyCard />
      <ChainRpcCard />
      <SettingsAboutCard />
      <DataLocationsCard />
      <SidecarUpdateCard />
      {/* MemoryTraceCard — V8 heap trace persisted across restart so
          the user can leave the app running for a long mining session
          and inspect the growth curve after. See useMemoryTrace.ts for
          what it does and doesn't measure. */}
      <MemoryTraceCard view="settings" />
    </div>
  );
}

// The "FILES ON DISK" data-locations card moved to ./DataLocationsCard.tsx so
// the landscape Settings can render the same list (DataLocationsList). It's
// imported at the top and rendered below as <DataLocationsCard />.

/**
 * T3.2 — About card. Renders the app version and the 7-tap-version
 * "developer mode" enable path (Android pattern). Production builds use
 * this to surface DevDiagnosticsCard for users who explicitly enable it
 * via 7 quick taps on the version line; the same flag persists in
 * localStorage across sessions.
 */
function SettingsAboutCard() {
  const [tapCount, setTapCount] = useState(0);
  const [devEnabled, setDevEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem("pwnda-dev-diagnostics") === "true";
    } catch {
      return false;
    }
  });
  const onTap = () => {
    if (devEnabled) return; // already on — taps are no-ops.
    const next = tapCount + 1;
    if (next >= 7) {
      try {
        localStorage.setItem("pwnda-dev-diagnostics", "true");
      } catch {
        /* localStorage unavailable */
      }
      setDevEnabled(true);
      setTapCount(0);
    } else {
      setTapCount(next);
    }
  };
  const disableDev = () => {
    try {
      localStorage.setItem("pwnda-dev-diagnostics", "false");
    } catch {
      /* ignore */
    }
    setDevEnabled(false);
    setTapCount(0);
  };
  const version = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? "v2.0.1";
  return (
    <Card title="ABOUT">
      <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 11 }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: "var(--text-dim)" }}>Version</span>
          <span
            className="tnum"
            style={{ cursor: "pointer", userSelect: "none" }}
            onClick={onTap}
            title={
              devEnabled
                ? "Dev diagnostics enabled"
                : tapCount > 0
                  ? `${7 - tapCount} taps to enable dev diagnostics…`
                  : "Tap the version 7 times to enable dev diagnostics"
            }
          >
            {version}
            {!devEnabled && tapCount > 2 && tapCount < 7 && (
              <span style={{ color: "var(--text-dim)", marginLeft: 6, fontSize: 9 }}>
                ({7 - tapCount} more…)
              </span>
            )}
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: "var(--text-dim)" }}>Platform</span>
          <span>{platformLabel()} (Tauri)</span>
        </div>
        <UpdateRow />
        {devEnabled && (
          <div
            style={{
              marginTop: 8,
              padding: "6px 8px",
              border: "1px solid var(--border)",
              background: "rgba(0,255,102,0.04)",
              fontSize: 10,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <span style={{ color: "var(--accent)" }}>
              Dev diagnostics enabled
            </span>
            <button
              type="button"
              className="btn-link"
              onClick={disableDev}
              style={{ fontSize: 10 }}
            >
              disable
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}


/* ─── Closed-source-wallet derivation warning ──────────────── */

/**
 * Originally an 8-line yellow alert that dominated the top of Settings
 * (UXS-20260516-109). The content is educational, not alerting — first-
 * time users were closing Settings out of overwhelm. Reframed as a
 * single informational line + collapsible "Learn more ▸" so the panel
 * leads with high-frequency actions (Wallet Details, Miner Setup,
 * Lock) instead of derivation jargon.
 */
function DerivationWarningCard() {
  const [expanded, setExpanded] = useState(false);
  return (
    <Card title="DERIVATION & WALLET COMPATIBILITY" style={{ marginTop: 14 }}>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          lineHeight: 1.55,
          color: "var(--text-muted)",
        }}
      >
        <p style={{ marginTop: 0, marginBottom: expanded ? 12 : 6 }}>
          Importing a seed from a closed-source wallet (Exodus, Atomic,
          etc.) and don't see your funds? It's likely a derivation-path
          mismatch — open the chain's dashboard tab and use{" "}
          <strong>"Or find a specific address"</strong> on the alternative-
          derivations panel.
        </p>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          style={{
            background: "transparent",
            border: "1px solid var(--border-soft)",
            color: "var(--text-dim)",
            cursor: "pointer",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            padding: "3px 10px",
            letterSpacing: 0.8,
          }}
        >
          {expanded ? "▾ Hide background" : "▸ Learn more about derivation paths"}
        </button>
        {expanded && (
          <div style={{ marginTop: 12 }}>
            <p>
              A 12-word seed phrase is just entropy. The actual addresses
              come from running that entropy through a "derivation path"
              algorithm. <strong style={{ color: "var(--accent)" }}>
              Different wallets pick different paths</strong>, so the same
              seed can produce different addresses in different wallets —
              neither is wrong, they're just different conventions.
            </p>
            <p>
              <strong style={{ color: "#ffae42" }}>Closed-source wallets
              (Exodus, Atomic, etc.) sometimes use proprietary derivations
              that no other wallet matches.</strong> If a closed-source wallet
              shuts down or stops updating, the published-standard wallets
              you'd normally migrate to may show empty balances even though
              your funds are still on-chain — the addresses they derive
              simply don't match what the closed wallet produced.
            </p>
            <p>
              PwndaWallet defaults to the modern open-source standard for
              every chain (BIP-84 for BTC, Phantom path for SOL,
              CIP-1852 for ADA, etc.). Pwnda's brute-force probe covers
              ~120+ derivation candidates (including documented Exodus and
              Atomic paths) to find the matching algorithm.
            </p>
            <p style={{ marginBottom: 0, color: "var(--text-dim)" }}>
              As a general practice: when you create a new wallet, generate
              the seed in an open-source wallet first, OR test that the
              seed restores correctly across at least two wallets before
              funding it. Recovery later is much harder if you discover the
              wallet you used had a non-standard scheme.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}

/* ─── Chain RPC test panel ──────────────────────────────────── */

interface RpcRowState {
  testing: boolean;
  ok: boolean | null;
  value?: string; // block height / slot / "ok" depending on probe kind
  latencyMs?: number;
  urlUsed?: string;
  error?: string;
}

const CHAIN_KEY_ORDER: ChainKey[] = [
  "ETH",
  "AVAX",
  "POL",
  "FLR",
  "ARB",
  "BASE",
  "OP",
  "BSC",
  "SOL",
  "NEAR",
  "BTC",
  "LTC",
  "DOGE",
  "BCH",
];

function ChainRpcCard() {
  const [byChain, setByChain] = useState<Record<string, RpcRowState>>({});
  const [testingAll, setTestingAll] = useState(false);

  const setRow = useCallback((chain: ChainKey, patch: Partial<RpcRowState>) => {
    setByChain((prev) => ({
      ...prev,
      [chain]: { ...(prev[chain] ?? { testing: false, ok: null }), ...patch },
    }));
  }, []);

  const testOne = useCallback(
    async (chain: ChainKey) => {
      const urls = rpcsFor(chain);
      setRow(chain, {
        testing: true,
        ok: null,
        error: undefined,
        value: undefined,
        latencyMs: undefined,
        urlUsed: undefined,
      });
      try {
        const r = await probeChain(chain, urls);
        setRow(chain, {
          testing: false,
          ok: true,
          value: r.value,
          latencyMs: r.latencyMs,
          urlUsed: r.urlUsed,
        });
      } catch (e) {
        const allFailed = e instanceof AllRpcsFailedError;
        const cfg = RPC_DEFAULTS[chain];
        const msg = allFailed
          ? `All ${urls.length} RPCs failed. Set ${cfg.envVar} in .env.local to a working endpoint and rebuild.`
          : String((e as Error)?.message ?? e);
        setRow(chain, { testing: false, ok: false, error: msg });
      }
    },
    [setRow],
  );

  const testAll = useCallback(async () => {
    setTestingAll(true);
    try {
      // Run sequentially to avoid hammering all chains in parallel — gentler
      // on the user's network and easier to read the dot-by-dot progress.
      for (const c of CHAIN_KEY_ORDER) {
        await testOne(c);
      }
    } finally {
      setTestingAll(false);
    }
  }, [testOne]);

  return (
    <Card title="NETWORK" style={{ marginTop: 14 }}>
      <div
        style={{
          fontSize: 9,
          color: "var(--text-dim)",
          letterSpacing: 0.5,
          marginBottom: 10,
          fontFamily: "var(--font-mono)",
          lineHeight: 1.5,
        }}
      >
        Active RPC endpoints per chain. Defaults are audited against working
        public providers (see <code>RPC_AUDIT.md</code>). Override any chain by
        setting <code>VITE_&lt;CHAIN&gt;_RPC_URL</code> (or <code>_API_URL</code>{" "}
        for UTXO chains) in <code>.env.local</code>.
      </div>
      <div style={{ marginBottom: 10 }}>
        <Btn
          variant="ghost"
          full
          caret={false}
          onClick={() => void testAll()}
          disabled={testingAll}
        >
          {testingAll ? "Testing all chains…" : "Test all chains"}
        </Btn>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {CHAIN_KEY_ORDER.map((chain) => {
          const urls = rpcsFor(chain);
          const row = byChain[chain] ?? { testing: false, ok: null };
          return (
            <RpcRow
              key={chain}
              chain={chain}
              urls={urls}
              row={row}
              onTest={() => void testOne(chain)}
            />
          );
        })}
      </div>
    </Card>
  );
}

function RpcRow({
  chain,
  urls,
  row,
  onTest,
}: {
  chain: ChainKey;
  urls: string[];
  row: RpcRowState;
  onTest: () => void;
}) {
  const cfg = RPC_DEFAULTS[chain];
  const ticker = chain;
  const label = cfg.label;
  const [showAll, setShowAll] = useState(false);
  const head = urls[0];
  const dotColor =
    row.ok === true
      ? "var(--accent)"
      : row.ok === false
        ? "var(--danger)"
        : "var(--text-dim)";
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        padding: "8px 10px",
        fontFamily: "var(--font-mono)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: dotColor,
            display: "inline-block",
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: 11,
            color: "var(--text)",
            letterSpacing: 0.5,
            textTransform: "uppercase",
            width: 60,
          }}
        >
          {ticker}
        </span>
        <code
          style={{
            flex: 1,
            fontSize: 10,
            color: "var(--text-dim)",
            wordBreak: "break-all",
          }}
        >
          {head}
        </code>
        <button
          className="qbtn"
          onClick={() => setShowAll((s) => !s)}
          style={{
            fontSize: 9,
            padding: "3px 8px",
            color: "var(--text-dim)",
          }}
          aria-label={`Show ${urls.length - 1} fallbacks`}
        >
          +{Math.max(0, urls.length - 1)}
        </button>
        <button
          className="qbtn"
          onClick={onTest}
          disabled={row.testing}
          style={{
            fontSize: 9,
            padding: "3px 8px",
            color: row.testing ? "var(--text-dim)" : "var(--text)",
          }}
        >
          {row.testing ? "testing…" : "test"}
        </button>
      </div>
      {showAll && urls.length > 1 && (
        <div
          style={{
            marginTop: 6,
            paddingTop: 6,
            borderTop: "1px solid var(--border-soft)",
            display: "flex",
            flexDirection: "column",
            gap: 3,
          }}
        >
          {urls.slice(1).map((u, i) => (
            <code
              key={i}
              style={{
                fontSize: 9,
                color: "var(--text-dim)",
                wordBreak: "break-all",
                paddingLeft: 22,
              }}
            >
              {i + 1}. {u}
            </code>
          ))}
        </div>
      )}
      {row.ok === true && (
        <div
          style={{
            marginTop: 6,
            fontSize: 10,
            color: "var(--accent)",
            paddingLeft: 22,
            wordBreak: "break-all",
          }}
        >
          ✓ {cfg.probe === "esplora" || cfg.probe === "blockchair"
            ? `height ${row.value}`
            : cfg.probe === "near"
              ? "mainnet ok"
              : `block ${row.value}`}{" "}
          · {row.latencyMs} ms · {row.urlUsed}
        </div>
      )}
      {row.ok === false && (
        <div
          style={{
            marginTop: 6,
            padding: "6px 8px",
            background: "rgba(255,59,59,0.08)",
            border: "1px solid rgba(255,59,59,0.4)",
            color: "var(--danger)",
            fontSize: 10,
            lineHeight: 1.4,
          }}
        >
          {row.error ?? "Unknown failure."}
        </div>
      )}
      <span
        aria-hidden
        style={{
          display: "none",
        }}
      >
        {label}
      </span>
    </div>
  );
}

/* ─── Swap settings (slippage tolerance) ────────────────────────── */

function SwapSettingsCard() {
  const {
    slippagePercent,
    setSlippagePercent,
    preferredRouter,
    setPreferredRouter,
  } = useSwapSettings();
  const [draft, setDraft] = useState(String(slippagePercent));

  // Keep draft in sync if the persisted value changes (e.g. after first load).
  useEffect(() => {
    setDraft(String(slippagePercent));
  }, [slippagePercent]);

  const commit = () => {
    const n = parseFloat(draft);
    if (Number.isFinite(n)) {
      void setSlippagePercent(n);
    } else {
      setDraft(String(slippagePercent));
    }
  };

  return (
    <Card title="SWAP" style={{ marginTop: 14 }}>
      {/* Slippage tolerance */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "8px 0",
          fontFamily: "var(--font-mono)",
        }}
      >
        <div>
          <div
            style={{
              fontSize: 11,
              color: "var(--text)",
              letterSpacing: 0.4,
            }}
          >
            Slippage tolerance
          </div>
          <div
            style={{
              fontSize: 9,
              color: "var(--text-dim)",
              marginTop: 2,
              letterSpacing: 0.5,
            }}
          >
            Maximum allowed price drift before a swap is rejected. Default 2%.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            className="field"
            type="number"
            step="0.1"
            min="0"
            max="50"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
            }}
            style={{
              width: 70,
              fontSize: 11,
              padding: "6px 8px",
              textAlign: "right",
              fontFamily: "var(--font-mono)",
            }}
          />
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>%</span>
        </div>
      </div>

      {/* Default router preference (mirrors the segmented control on the form). */}
      <div
        style={{
          padding: "10px 0 4px",
          borderTop: "1px solid var(--border-soft)",
          marginTop: 6,
          fontFamily: "var(--font-mono)",
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: "var(--text)",
            letterSpacing: 0.4,
          }}
        >
          Default router
        </div>
        <div
          style={{
            fontSize: 9,
            color: "var(--text-dim)",
            marginTop: 2,
            letterSpacing: 0.5,
            marginBottom: 8,
          }}
        >
          Which routing system the swap form queries by default. SwapKit upstream is
          mocked during the testing phase; default to NEAR Intents until SwapKit
          goes live.
        </div>
        <div
          role="tablist"
          style={{
            display: "flex",
            gap: 4,
            border: "1px solid var(--border)",
            padding: 3,
            background: "var(--surface)",
          }}
        >
          {ROUTER_PREFERENCE_OPTIONS.map((opt) => {
            const active = opt.value === preferredRouter;
            return (
              <button
                key={opt.value}
                role="tab"
                aria-selected={active}
                onClick={() => void setPreferredRouter(opt.value)}
                title={opt.hint}
                style={{
                  flex: 1,
                  padding: "6px 8px",
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  letterSpacing: 1,
                  textTransform: "uppercase",
                  border: "none",
                  background: active ? "var(--accent-soft)" : "transparent",
                  color: active ? "var(--accent)" : "var(--text-muted)",
                  cursor: "pointer",
                  borderLeft: active
                    ? "2px solid var(--accent)"
                    : "2px solid transparent",
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Build-time live/mock flags — read-only diagnostic so the user can
          verify the build's mode at a glance without rebuilding. */}
      <div
        style={{
          padding: "10px 0 0",
          borderTop: "1px solid var(--border-soft)",
          marginTop: 12,
          fontFamily: "var(--font-mono)",
        }}
      >
        <div
          style={{
            fontSize: 9,
            color: "var(--text-dim)",
            letterSpacing: 1,
            textTransform: "uppercase",
            marginBottom: 6,
          }}
        >
          Build-time flags
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <FlagRow
            name="VITE_SWAPKIT_LIVE"
            isLive={ROUTER_MODES.swapkit.isLive}
          />
          <FlagRow
            name="VITE_INTENTS_LIVE"
            isLive={ROUTER_MODES.intents.isLive}
          />
        </div>
      </div>
    </Card>
  );
}

function FlagRow({ name, isLive }: { name: string; isLive: boolean }) {
  const color = isLive ? "var(--accent)" : "var(--warn)";
  const label = isLive ? "live" : "mock";
  const dot = isLive ? "🟢" : "🟡";
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        fontSize: 10,
      }}
    >
      <code style={{ color: "var(--text)" }}>{name}</code>
      <span style={{ color, letterSpacing: 0.4 }}>
        {label} {dot}
      </span>
    </div>
  );
}

/* ─── Swap relay panel ───────────────────────────────────────────
 * Diagnostics for the wallet **swap relay** — the HTTP client to the
 * no-funds swap-coordination server (`wallet.pwnda.org`, quotes/intents,
 * ed25519 X-Client-Sig enrollment). This is one of the wallet's outbound
 * endpoints; in the "proxy" taxonomy it is (C) the swap relay — distinct
 * from the mining SOCKS5 privacy proxy (B, `ProxyModePanel`) and the
 * RPC/CORS relay (D, `http_proxy.rs`). See [[proxy-taxonomy]]. The card is
 * still `WalletProxyCard` / the Tauri commands are still `swap_proxy_*`
 * (contract names unchanged — this is a label-only relabel). */

function WalletProxyCard() {
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [test, setTest] = useState<ConnectionTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [pubkeyCopied, setPubkeyCopied] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  const [savedOverride, setSavedOverride] = useState<string | null>(null);
  const [savingUrl, setSavingUrl] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await getProxyStatus();
      setStatus(s);
    } catch (e) {
      console.warn("[swap-relay] status failed", e);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void getProxyUrlOverride().then((o) => {
      setSavedOverride(o);
      setUrlDraft(o ?? "");
    });
  }, [refresh]);

  /** Apply a new override (null = back to the default) + refresh status. */
  const applyServerUrl = async (next: string | null) => {
    setSavingUrl(true);
    setUrlError(null);
    setToast(null);
    try {
      await setProxyUrlOverride(next);
      const o = await getProxyUrlOverride();
      setSavedOverride(o);
      setUrlDraft(o ?? "");
      setTest(null); // stale: it ran against the previous server
      const s = await getProxyStatus();
      setStatus(s);
      setToast(
        s.enrolled
          ? "Server updated."
          : "Server updated - not enrolled at this server yet. Use Re-enroll."
      );
    } catch (e) {
      setUrlError((e as Error).message);
    } finally {
      setSavingUrl(false);
    }
  };

  const onSaveUrl = () => {
    const next = urlDraft.trim();
    void applyServerUrl(next.length > 0 ? next : null);
  };

  const onResetUrl = () => {
    void applyServerUrl(null);
  };

  const onTest = async () => {
    setTesting(true);
    setToast(null);
    try {
      const result = await testProxyConnection();
      setTest(result);
    } catch (e) {
      setToast(`Test failed: ${(e as Error).message}`);
    } finally {
      setTesting(false);
    }
  };

  const onReenroll = async () => {
    setEnrolling(true);
    setToast(null);
    try {
      const r = await enrollWithProxy();
      if (r.enrolled) {
        setToast(r.already ? "Already enrolled." : "Enrolled successfully.");
      } else {
        setToast(`Enroll failed: ${r.status} ${r.body}`);
      }
      await refresh();
    } catch (e) {
      setToast(`Enroll failed: ${(e as Error).message}`);
    } finally {
      setEnrolling(false);
    }
  };

  const onCopyPubkey = () => {
    if (!status?.pubkey) return;
    void navigator.clipboard.writeText(status.pubkey).then(() => {
      setPubkeyCopied(true);
      setTimeout(() => setPubkeyCopied(false), 1500);
    });
  };

  return (
    <Card title="SWAP RELAY" style={{ marginTop: 14 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, fontFamily: "var(--font-mono)" }}>
        <p style={{ margin: "0 0 2px", fontSize: 11, lineHeight: 1.5, color: "var(--text-dim)" }}>
          Connection to the no-funds swap-coordination server (quotes &amp;
          intents for the Swap tab). Not related to the mining privacy proxy.
        </p>
        <Row label="URL" value={status?.url ?? "—"} mono />
        <div>
          <div
            style={{
              fontSize: 9,
              color: "var(--text-dim)",
              letterSpacing: 1,
              textTransform: "uppercase",
              marginBottom: 4,
            }}
          >
            Server
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              value={urlDraft}
              onChange={(e) => {
                setUrlDraft(e.target.value);
                setUrlError(null);
              }}
              placeholder={`default: ${DEFAULT_PROXY_URL}`}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              style={{
                flex: 1,
                minWidth: 0,
                padding: "6px 8px",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                fontSize: 10,
                color: "var(--text)",
                fontFamily: "var(--font-mono)",
              }}
            />
            <button
              className="qbtn"
              disabled={savingUrl}
              onClick={onSaveUrl}
              style={{ fontSize: 9, padding: "6px 8px" }}
            >
              {savingUrl ? "saving" : "save"}
            </button>
            <button
              className="qbtn"
              disabled={savingUrl || (savedOverride === null && urlDraft.trim() === "")}
              onClick={onResetUrl}
              style={{ fontSize: 9, padding: "6px 8px" }}
            >
              default
            </button>
          </div>
          {urlError && (
            <div style={{ fontSize: 9, color: "var(--danger)", marginTop: 4 }}>
              {urlError}
            </div>
          )}
          {savedOverride && (
            <p
              style={{
                margin: "6px 0 0",
                fontSize: 9,
                lineHeight: 1.5,
                color: "var(--warn)",
              }}
            >
              Custom server active. A custom server sees your swap quotes and
              destination addresses. It can never access your keys or funds.
              Only use a server you trust.
            </p>
          )}
        </div>
        <Row
          label="Enrollment"
          value={
            status?.enrolled
              ? `Enrolled${status?.enrolledAt ? ` · ${new Date(status.enrolledAt).toLocaleString()}` : ""}`
              : "Not enrolled"
          }
          color={status?.enrolled ? "var(--accent)" : "var(--warn)"}
        />
        <div>
          <div
            style={{
              fontSize: 9,
              color: "var(--text-dim)",
              letterSpacing: 1,
              textTransform: "uppercase",
              marginBottom: 4,
            }}
          >
            Public key
          </div>
          <div
            style={{
              display: "flex",
              gap: 6,
              alignItems: "center",
            }}
          >
            <code
              style={{
                flex: 1,
                padding: "6px 8px",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                fontSize: 10,
                color: "var(--text)",
                wordBreak: "break-all",
                fontFamily: "var(--font-mono)",
              }}
            >
              {status?.pubkey ?? "(not loaded)"}
            </code>
            <button
              className="qbtn"
              disabled={!status?.pubkey}
              onClick={onCopyPubkey}
              style={{
                fontSize: 9,
                padding: "6px 8px",
                color: pubkeyCopied ? "var(--accent)" : "var(--text)",
              }}
            >
              {pubkeyCopied ? "copied" : "copy"}
            </button>
          </div>
        </div>
        {status && status.clockOffsetSecs !== 0 && (
          <Row
            label="Clock offset"
            value={`${status.clockOffsetSecs > 0 ? "+" : ""}${status.clockOffsetSecs}s`}
            color="var(--warn)"
          />
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <Btn variant="ghost" full onClick={onTest} disabled={testing}>
            {testing ? "Testing…" : "Test Connection"}
          </Btn>
          <Btn variant="ghost" full onClick={onReenroll} disabled={enrolling}>
            {enrolling ? "Enrolling…" : "Re-enroll"}
          </Btn>
        </div>

        {test && (
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              padding: 10,
              display: "flex",
              flexDirection: "column",
              gap: 6,
              fontSize: 10,
              marginTop: 4,
            }}
          >
            <ConnRow name="GET /healthz" row={test.healthz} expected={200} />
            <ConnRow name="GET /api/intents/tokens" row={test.tokens} expected={200} />
          </div>
        )}

        {toast && (
          <div
            style={{
              fontSize: 10,
              color: "var(--text-dim)",
              padding: "6px 8px",
              background: "var(--surface)",
              border: "1px solid var(--border)",
            }}
          >
            {toast}
          </div>
        )}
      </div>
    </Card>
  );
}

function Row({
  label,
  value,
  mono,
  color,
}: {
  label: string;
  value: string;
  mono?: boolean;
  color?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 8,
      }}
    >
      <span
        style={{
          fontSize: 9,
          color: "var(--text-dim)",
          letterSpacing: 1,
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      <span
        className={mono ? "tnum" : undefined}
        style={{
          fontSize: 11,
          color: color ?? "var(--text)",
          textAlign: "right",
          wordBreak: "break-all",
          maxWidth: "60%",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function ConnRow({
  name,
  row,
  expected,
}: {
  name: string;
  row: { status: number; body: string; error: string | null };
  expected: number;
}) {
  const ok = row.error === null && row.status === expected;
  const yellow = row.error === null && row.status !== 0 && row.status !== expected;
  const color = ok ? "var(--accent)" : yellow ? "var(--warn)" : "var(--danger)";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span style={{ fontSize: 10, color: "var(--text)" }}>{name}</span>
        <span style={{ fontSize: 10, color }}>
          {row.error ? "network err" : row.status}
        </span>
      </div>
      <div
        style={{
          fontSize: 9,
          color: "var(--text-dim)",
          opacity: 0.85,
          wordBreak: "break-all",
        }}
      >
        {row.error ?? (row.body || "(empty)")}
      </div>
    </div>
  );
}

/** Human-readable OS name for the ABOUT card. Was hardcoded to "Windows"
 *  until 2026-08-12, which read as a bug on the Linux builds. */
function platformLabel(): string {
  if (isWindows()) return "Windows";
  if (isLinux()) return "Linux";
  if (isMac()) return "macOS";
  return "Unknown";
}

/**
 * Update check row inside the ABOUT card.
 *
 * Deliberately manual rather than a poll-on-launch: this is a wallet, and a
 * background process that can replace the running binary is a meaningful piece
 * of attack surface. The user asks, we check, we show what we found. Nothing
 * downloads without a second explicit click, and nothing restarts on its own —
 * the app may be mid-sync, mid-swap, or holding an unlocked vault.
 *
 * On `.deb` / `.rpm` installs we report the new version but don't offer to
 * install it: those files are owned by apt/dnf, and writing over them behind
 * the package manager's back corrupts its database. See `isUpdaterSupported`.
 */
function UpdateRow() {
  const [state, setState] = useState<
    "idle" | "checking" | "current" | "found" | "installing" | "done" | "error"
  >("idle");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState("");
  const [canSelfInstall, setCanSelfInstall] = useState(false);

  const doCheck = useCallback(async () => {
    setState("checking");
    setErr("");
    const found = await checkForUpdate();
    if (!found) {
      setState("current");
      return;
    }
    setCanSelfInstall(await isUpdaterSupported());
    setInfo(found);
    setState("found");
  }, []);

  const doInstall = useCallback(async () => {
    setState("installing");
    try {
      await installUpdate((f) => setProgress(f));
      setState("done");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ color: "var(--text-dim)" }}>Updates</span>
        {state === "idle" && (
          <button type="button" className="btn-link" style={{ fontSize: 10 }} onClick={doCheck}>
            check now
          </button>
        )}
        {state === "checking" && <span style={{ fontSize: 10 }}>checking…</span>}
        {state === "current" && (
          <span style={{ fontSize: 10, color: "var(--text-dim)" }}>up to date</span>
        )}
        {state === "found" && (
          <span style={{ fontSize: 10, color: "var(--accent)" }}>v{info?.version} available</span>
        )}
        {state === "installing" && (
          <span className="tnum" style={{ fontSize: 10 }}>
            {progress < 0 ? "downloading…" : `${Math.round(progress * 100)}%`}
          </span>
        )}
        {state === "done" && (
          <span style={{ fontSize: 10, color: "var(--accent)" }}>restart to apply</span>
        )}
        {state === "error" && <span style={{ fontSize: 10, color: "var(--danger)" }}>failed</span>}
      </div>

      {state === "found" && (
        <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
          {canSelfInstall ? (
            <button type="button" className="btn-link" style={{ fontSize: 10 }} onClick={doInstall}>
              download &amp; install v{info?.version}
            </button>
          ) : (
            <>Installed from a system package — update with your package manager.</>
          )}
        </div>
      )}
      {state === "error" && err && (
        <div style={{ fontSize: 10, color: "var(--danger)" }}>{err}</div>
      )}
    </div>
  );
}

