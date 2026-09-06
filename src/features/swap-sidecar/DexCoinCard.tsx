/**
 * Per-coin DEX enablement — a **pure presentational** card (contract §2.2).
 *
 * Props in, markup out: zero `invoke`, zero polling. The mount site owns
 * `useCoinStatuses` and passes `statuses` / `busyCoin` down, which is what lets
 * the same block render in the landscape Settings column and portrait Settings
 * from one status read.
 *
 * Copy constraints this card exists to hold:
 *
 *  - **"Disabled" is not "removed".** Rust implements disable as
 *    `manage_daemon: false`; the chainclient config survives and no chaindata
 *    is deleted. The row says so, every time, because the word "disable" reads
 *    as "reclaim the disk" otherwise.
 *  - **A missing binary is not a user choice.** A coin with `binaryPresent:
 *    false` can never be configured; showing it as an off toggle invites the
 *    user to click something that will never work. It renders as unavailable
 *    with the reason, and the toggle is gone rather than disabled-and-silent.
 *  - **Adoption is stated, not implied.** `descriptor` / `consolidate` /
 *    `deposit` are three genuinely different stories about the user's existing
 *    funds, and the zero-move promise is per-coin (see `descriptorAdoption.ts`).
 *  - **Light mode's cost is named, not just its saving.** "0 GB" is the easy
 *    half; the half a user needs before choosing is that a light coin has no
 *    daemon, so their existing funds on that chain are NOT adopted and sends
 *    are not routed through it. The row says both, and the light/local control
 *    only appears for the two coins that have the choice.
 */
import type { CSSProperties } from "react";
import { Card, Btn, Dot } from "../../design/primitives";
import type {
  CoinEnableStatus,
  CoinMode,
  DexAdoption,
} from "../../api/basicswap";
import type { SidecarBalanceRow } from "./useSidecarBalances";
import { syncStateOf, syncSentence } from "./useSidecarBalances";
import type { ChainSync } from "../../api/basicswap";

const mono: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  lineHeight: 1.6,
};

const ADOPTION_COPY: Record<DexAdoption, string> = {
  descriptor: "existing funds stay put — the node is given watch+spend keys",
  consolidate: "existing funds move once into the node's own wallet",
  deposit: "fund the node by sending to its deposit address",
  // C8. Says "same wallet" rather than "keys shared" deliberately: the user's
  // question is "where are my coins", and the answer is that there is only one
  // place. The key mechanism is the how, and it belongs in the opt-in copy
  // (`dexCoinsCopy.ts`), not on a status line.
  accountkey: "same wallet as your own — nothing to deposit, nothing to sweep",
  // C9-shaped, ZEPH/ZANO only (`api/basicswap.ts`'s own doc comment on
  // `DexAdoption` — added by unit C-R0 of the Grove expansion plan). Same
  // user-facing claim as `accountkey`: zero on-chain movement, one wallet.
  // The MECHANISM differs (a wallet-rpc process this app already runs,
  // rather than a key derived into the engine's own wallet), but that
  // distinction belongs in the opt-in copy same as accountkey's, not here.
  hostwallet: "same wallet as your own — nothing to deposit, nothing to sweep",
};

/**
 * The row's one-line answer to "where do this coin's funds come from".
 *
 * Consent-aware, because the honest answer changes the moment consent is
 * recorded and BEFORE the engine has been handed the keys. Without this, a
 * freshly consented coin printed "fund the node by sending to its deposit
 * address" directly above "it will use your own wallet from the next
 * swap-node start" — two lines of the same row disagreeing, which is the third
 * time this surface has produced that shape and the reason the check now lives
 * in one function instead of at each call site.
 *
 * The pending line deliberately does NOT promise the wallet is shared yet.
 * That claim waits for `adoption === "accountkey"` (or, for ZEPH/ZANO,
 * `"hostwallet"` — C9-shaped, same verified-not-requested distinction), which
 * the backend writes only after the engine's derived address (or, for
 * `hostwallet`, the wallet-rpc process itself) matched this wallet's.
 */
function adoptionLine(s: CoinEnableStatus, effective: CoinMode): string {
  if (s.adoption === "accountkey" || s.adoption === "hostwallet") {
    return ADOPTION_COPY[s.adoption];
  }
  // Sharing is on but the engine has not confirmed it yet — the ordinary
  // state between opting in and the node's next start. Saying "deposit to
  // this address" here would be the contradiction this function exists to
  // prevent; claiming the wallet IS shared would be a lie.
  if (s.sharesWallet) {
    // Monero used to need a special-cased, more pessimistic line here: C9's
    // orchestration (the engine using this wallet's own monero-wallet-rpc)
    // was recorded as the user's choice before it was actually WIRED, so
    // "once the swap node next starts" would have promised what the next
    // start could not keep. The operator read that exact line beside a
    // different XMR address and a zero balance and reasonably asked which
    // of the two was lying (2026-08-21). Fixed the same day, in two parts:
    // the orchestration itself landed (`maybe_activate_xmr_host_wallet`),
    // and — found on the operator's own first restart afterward — two
    // compounding config bugs that kept it from actually working even once
    // wired (see PwndaWalletVault/log.md, "C9's first live restart"). The
    // promise below is genuine for XMR now, same as every other coin.
    return "will use your existing wallet once the swap node next starts";
  }
  return ADOPTION_COPY[s.adoption];
}

/**
 * The two halves of what a mode means, in the user's terms.
 *
 * `cost` is deliberately not omitted for `lean`. A control that shows only
 * "no chain stored locally" beside a Light button is an advertisement, and the
 * thing it does not mention — that light coins cannot adopt existing funds — is
 * exactly what the whole convergence design is for.
 */
const MODE_COPY: Record<CoinMode, { label: string; cost: string }> = {
  lean: {
    label: "Light",
    // C8 corrected this line. It used to read "funds already on this chain are
    // not adopted", which was true of the descriptor mechanism and became
    // FALSE the moment a lean coin could share the wallet's own account key.
    // Left alone it would have talked users out of the cheapest correct
    // configuration — see `leanCostCopy` for the shared-wallet wording.
    cost: "no chain to download — sends are not routed through it",
  },
  full: {
    label: "Local node",
    cost: "downloads a pruned chain — your existing coins here become tradeable where they sit",
  },
};

/**
 * What Light costs *this* coin, which now depends on whether it can share the
 * wallet's own keys.
 *
 * Light used to mean "cheap, but your existing coins are not adopted". For BTC
 * and LTC that second clause stopped being true with C8: the engine's lean
 * wallet can be initialised from the wallet's own account, making them one
 * wallet. Keeping the old sentence would be the same defect the DEX-coins cost
 * note already had once — copy that contradicts what the row beside it does.
 *
 * @param shared the coin is actually sharing the wallet (`adoption` is
 *   `accountkey`), not merely capable of it. Capability is not a state to
 *   advertise as fact.
 */
function leanCostCopy(shared: boolean, consented = false): string {
  if (shared) {
    return "no chain to download — and it uses your own wallet, so there is nothing to deposit";
  }
  if (consented) {
    // The in-between state, which is ordinary rather than exceptional: consent
    // is recorded and the engine has not been handed the keys yet (it gets
    // them when the node next starts with the vault unlocked). Saying nothing
    // here would make the toggle look like it did nothing.
    return "no chain to download — it will use your own wallet from the next swap-node start";
  }
  return MODE_COPY.lean.cost;
};

/**
 * Disk budget for one coin.
 *
 * Says "about", because the backend's figures are order-of-magnitude budgets
 * and its own doc comment requires a UI to round them and hedge. A bare
 * "250 GB" reads as a measurement of something already on disk, which is the
 * opposite of what it is.
 *
 * `0` is meaningful rather than missing: it is what a remote Monero node or
 * LTC's electrum mode costs — no local daemon, no chain — so it gets its own
 * wording instead of "size unknown".
 */
function diskLabel(gb: number): string {
  if (!Number.isFinite(gb) || gb < 0) return "size unknown";
  if (gb === 0) return "no chain stored locally";
  const size =
    gb < 1 ? `${Math.round(gb * 1000)} MB` : `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
  return `about ${size}`;
}

/**
 * Chain-sync progress bar.
 *
 * Rendered only for a coin that is genuinely mid-sync. A bar at 100% is noise,
 * and a bar for a light-mode coin would invent a chain it does not have.
 *
 * The percentage is `verificationprogress`, which answers "of the blocks I
 * have, how many have I checked" — so it is shown NEXT TO the height rather
 * than alone: a chain that has downloaded nothing reports 100% verified, and
 * a bar on its own would read as finished.
 */
function SyncBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div
      style={{
        height: 3,
        background: "var(--border-soft)",
        borderRadius: 2,
        overflow: "hidden",
        marginTop: 3,
      }}
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        style={{
          width: `${clamped}%`,
          height: "100%",
          background: "var(--accent)",
        }}
      />
    </div>
  );
}

function CoinRow({
  s,
  sync,
  chain,
  busy,
  onToggle,
  onSetMode,
  onSetShareWallet,
}: {
  s: CoinEnableStatus;
  sync: SidecarBalanceRow | null;
  chain: ChainSync | null;
  busy: boolean;
  onToggle(coin: string, enabled: boolean): void;
  onSetMode(coin: string, mode: CoinMode): void;
  /** C8. Optional: a surface that has not wired consent yet renders no
   *  control rather than a dead one. */
  onSetShareWallet?(coin: string, share: boolean): void;
}) {
  const unavailable = !s.binaryPresent;
  // What the node is actually doing. `configuredMode` is absent until the coin
  // has a chainclient block, and only then is `mode` the whole story.
  const effective: CoinMode = s.configuredMode ?? s.mode;
  // A requested change the engine has not picked up. Rust refuses to record
  // this (the mode is baked in at creation), so it can only appear on a record
  // written before that refusal existed — but it must not render as if it took.
  const pending = s.configuredMode != null && s.configuredMode !== s.mode;
  // Once the coin exists in the config the mode is fixed; offering a control
  // that the backend will refuse is worse than showing why it is fixed.
  const modeLocked = s.configured;
  // Enabled, seeded, and STILL absent from the swap node's config. The row
  // said "not configured yet" — true, and with no next step, which is how a
  // user ends up staring at a BasicSwap order book missing the coins they
  // turned on. Adding a coin runs `--addcoin`, which must read the master key
  // out of the encrypted Particl wallet, so it only succeeds on a start that
  // carries the wallet key — never on autostart, which precedes any unlock.
  const pendingAdd = s.enabled && !s.configured && s.binaryPresent;
  // Configured, enabled, and deliberately not running this session — only a
  // host-wallet coin (zephyr/zano) can be in this state; see `active`'s doc.
  const parked = s.enabled && s.configured && s.active === false;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 12,
        padding: "8px 0",
        borderBottom: "1px solid var(--border-soft)",
        opacity: unavailable ? 0.55 : 1,
      }}
    >
      <div style={{ ...mono, minWidth: 0 }}>
        <div
          style={{
            color: "var(--text)",
            letterSpacing: 1,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Dot color={unavailable ? "gray" : s.enabled ? "green" : "amber"} />
          {s.ticker}
          {s.descriptorsImported && (
            <span
              title="This coin's account descriptors are imported — the node can spend funds already on-chain."
              style={{
                fontSize: 9.5,
                letterSpacing: 1,
                textTransform: "uppercase",
                color: "var(--accent)",
              }}
            >
              keys imported
            </span>
          )}
        </div>
        <div style={{ fontSize: 10.5, color: "var(--text-dim)" }}>
          {unavailable ? unavailableReason(s.coin) : adoptionLine(s, effective)}
        </div>
        <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
          {diskLabel(s.estDiskGb)}
          {s.estDiskGb > 0 ? " of pruned chain data once synced" : ""}
          {s.configured ? " · configured" : " · not configured yet"}
          {!s.enabled && s.configured
            ? " · disabled: the config is kept, the chain stops syncing"
            : ""}
        </div>

        {/* Live chain progress. PART gates EVERY swap — the order book is
            empty until it finishes — so the number belongs where the coins
            are. The DIRECT daemon read (`chain`) is preferred: it stays live
            during IBD when the balance endpoint times out. The balance-row
            path is the fallback for anything `chain` does not cover. */}
        {chain && chain.headers > 0 && chain.blocks < chain.headers ? (
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 3 }}>
            syncing — {chain.blocks.toLocaleString()} of{" "}
            {chain.headers.toLocaleString()} blocks (
            {chain.verifiedPct.toFixed(2)}% verified)
            <SyncBar pct={(chain.blocks / chain.headers) * 100} />
            {chain.error ? (
              <div style={{ fontSize: 9.5, color: "var(--text-muted)", marginTop: 1 }}>
                daemon busy for a moment — progress continues
              </div>
            ) : null}
          </div>
        ) : chain && chain.headers > 0 ? (
          <div style={{ fontSize: 10, color: "var(--accent)", marginTop: 3 }}>
            synced — {chain.blocks.toLocaleString()} blocks
          </div>
        ) : (
          sync &&
          (() => {
            const st = syncStateOf(sync);
            if (st.kind === "no-chain" || st.kind === "unknown") return null;
            return (
              <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 3 }}>
                {syncSentence(st)}
                {st.kind === "syncing" && st.target ? (
                  <SyncBar pct={(st.blocks / st.target) * 100} />
                ) : null}
              </div>
            );
          })()
        )}

        {pendingAdd && (
          <div style={{ fontSize: 10, color: "var(--warn, var(--text-dim))", marginTop: 3 }}>
            waiting to be added to the swap node — this happens by itself the
            next time the node starts with your wallet unlocked
          </div>
        )}
        {parked && (
          <div style={{ fontSize: 10, color: "var(--warn, var(--text-dim))", marginTop: 3 }}>
            {/* 2026-09-04: a host-wallet coin the node could not reach at start
                is parked for the session rather than allowed to stall the
                node for ten minutes. The remedy is the user's, so say it. */}
            {"parked this session — "}
            {s.parkedReason ??
              `the swap node could not reach your ${
                s.coin === "zano" ? "Zano" : "Zephyr"
              } wallet when it started`}
            {". The swap node restarts itself to add it once that wallet is open in this app (at most twice per session); or restart it by hand."}
          </div>
        )}

        {!unavailable && s.canRunLean && (
          <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 3 }}>
            {effective === "lean"
              ? leanCostCopy(s.adoption === "accountkey", s.sharesWallet)
              : MODE_COPY[effective].cost}
            {/* No workaround is offered because none exists: disable keeps
                the chainclient block, and re-enable never re-creates it. The
                first version of this line promised off/restart/on — false. */}
            {modeLocked
              ? " · set when the coin was first enabled; changing it later isn't supported yet"
              : ""}
            {pending
              ? ` · ${MODE_COPY[s.mode].label} requested but not applied`
              : ""}
          </div>
        )}
      </div>

      {/* Wraps rather than shrinks. Three controls (Light / Local node /
          Disable) beside the text column squeeze it to ~4 words per line at
          440 px — visible in screenshots/dex-coins-lean-mode-portrait.png
          before this. Wrapping costs a row of height on the narrow surface and
          nothing at all on the wide one. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          flexWrap: "wrap",
          gap: 6,
        }}
      >
        {/* Only the coins that HAVE a choice get a control. BCH/DOGE/DASH have
            no light-client support upstream, and particl carries SMSG. */}
        {!unavailable && s.canRunLean && !modeLocked && (
          <div style={{ display: "flex", gap: 2 }}>
            {(["lean", "full"] as const).map((m) => (
              <Btn
                key={m}
                variant={effective === m ? "accent" : "ghost"}
                size="sm"
                disabled={busy}
                onClick={() => onSetMode(s.coin, m)}
                title={MODE_COPY[m].cost}
              >
                {MODE_COPY[m].label}
              </Btn>
            ))}
          </div>
        )}

        {/* Wallet sharing is ON by default for any capable coin once the DEX
            is opted into (2026-08-20) — opting in IS the decision, and the
            disclosure lives in the setup wizard. So this is an OPT-OUT, not a
            gate: it exists for the user who wants this one coin funded by
            deposit instead, and most users should never need to touch it.

            `canShareWallet` covers all three mechanisms — a lean electrum
            coin (account keys), monero (its wallet-rpc) and, since
            2026-09-04, zephyr/zano (their host wallet process). One control,
            one question; the caller routes to the right command. */}
        {!unavailable && s.canShareWallet && onSetShareWallet && (
          <Btn
            variant={s.sharesWallet ? "accent" : "ghost"}
            size="sm"
            disabled={busy}
            onClick={() => onSetShareWallet(s.coin, !s.sharesWallet)}
            title={
              s.sharesWallet
                ? "Stop using your own wallet for this coin — fund the swap node by depositing to it instead."
                : "Go back to using your own wallet for this coin, so there is nothing to deposit."
            }
          >
            {s.sharesWallet ? "Using my wallet" : "Use my wallet"}
          </Btn>
        )}

        {!unavailable && (
          <Btn
            variant={s.enabled ? "ghost" : "accent"}
            size="sm"
            disabled={busy}
            onClick={() => onToggle(s.coin, !s.enabled)}
          >
            {busy ? "…" : s.enabled ? "Disable" : "Enable"}
          </Btn>
        )}
      </div>
    </div>
  );
}

/**
 * @param statuses from `useCoinStatuses` — the authoritative per-coin view
 * @param onToggle called with the coin's lowercase engine name and the WANTED
 *        state, not the current one
 * @param onSetMode called with the coin's lowercase engine name and the WANTED
 *        mode. Only ever fires for a row where `canRunLean` is true and the
 *        coin is not yet configured.
 * @param syncRows balance rows keyed by UPPERCASE ticker, from
 *        `useSidecarBalances`. Optional: the card renders without them, just
 *        without progress.
 * @param busyCoin the coin mid-toggle, so only that row goes inert
 */
/**
 * Why a coin cannot be enabled, in terms the reader can act on.
 *
 * "no daemon binary is seeded for this coin — it cannot be enabled" is TRUE and
 * tells you nothing: it reads as "something failed to download", so the
 * reasonable next move is to look for a retry that does not exist. For Zano the
 * real reason is that the swap engine needs a wallet supporting
 * `generate_from_keys`, which stock Zano does not have, so the binary has to be
 * BUILT from a patched source tree — no fetch will ever produce it.
 *
 * Reported 2026-09-04: "These should be working and enabled. We should have the
 * binaries local and bundled." Two of the three coins in that state (dogecoin,
 * dash) genuinely were an oversight and are now bundled; Zano is the one that
 * is really blocked, and saying so is the difference between a user waiting for
 * a fix and a user knowing what the fix is.
 */
function unavailableReason(coin: string): string {
  if (coin === "zano") {
    return (
      "needs a patched Zano wallet (generate_from_keys), which stock Zano " +
      "cannot do — it has to be built from source, so no download will supply it"
    );
  }
  return "no daemon binary is seeded for this coin — it cannot be enabled";
}

export function DexCoinCard({
  statuses,
  onToggle,
  onSetMode,
  onSetShareWallet,
  syncRows = {},
  chainByTicker = {},
  busyCoin = null,
}: {
  statuses: CoinEnableStatus[];
  onToggle(coin: string, enabled: boolean): void;
  onSetMode(coin: string, mode: CoinMode): void;
  /** C8 — record consent for a lean coin to use the wallet's own keys. */
  onSetShareWallet?(coin: string, share: boolean): void;
  syncRows?: Record<string, SidecarBalanceRow>;
  chainByTicker?: Record<string, ChainSync>;
  busyCoin?: string | null;
}) {
  const rows = [...statuses].sort((a, b) => a.ticker.localeCompare(b.ticker));

  return (
    <Card title="DEX COINS">
      <div
        style={{
          ...mono,
          fontSize: 10.5,
          color: "var(--text-dim)",
          marginBottom: 8,
        }}
      >
        {/* The trailing clause used to read "at the cost of not adopting funds
            you already hold there". C8 made that false for Light BTC/LTC, and
            a heading is the worst place to keep a stale universal rule: it is
            read first and it contradicted the row directly beneath it. Whether
            a coin shares the wallet is a PER-ROW fact and is stated there.

            Bitcoin Cash joined the Light-capable set 2026-09-03 (Grove
            expansion plan — `ELECTRUM_CAPABLE` in `swap_sidecar.rs` gained a
            `bitcoincash` entry). Found stale while wiring `DexCnWalletCard`
            (unit C-T2) for a DIFFERENT reason (ZEPH/ZANO), not because this
            line was in scope — but this is the exact copy-contradicts-the-
            row-beneath-it defect the comment above already names once, and
            leaving BCH's own row correctly offering Light directly under a
            heading that named only two of the three coins would have been
            the same defect recurring, not a new one. */}
        Which chains the swap node syncs. Each enabled coin costs disk and
        bandwidth; disabling keeps the configuration and stops the sync.
        Bitcoin, Litecoin and Bitcoin Cash can also run{" "}
        <strong>Light</strong> — no chain at all.
      </div>

      {rows.length === 0 ? (
        <div style={{ ...mono, color: "var(--text-muted)" }}>
          {/* Covers "node not started" and "nothing seeded" alike — the read
              cannot tell them apart and guessing would be a claim. */}
          No coins reported. The swap node may not have been prepared yet.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {rows.map((s) => (
            <CoinRow
              key={s.coin}
              s={s}
              busy={busyCoin != null && busyCoin.toLowerCase() === s.coin.toLowerCase()}
              sync={syncRows[s.ticker.toUpperCase()] ?? null}
              chain={chainByTicker[s.ticker.toUpperCase()] ?? null}
              onToggle={onToggle}
              onSetMode={onSetMode}
              onSetShareWallet={onSetShareWallet}
            />
          ))}
        </div>
      )}
    </Card>
  );
}
