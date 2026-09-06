/**
 * The CryptoNote-follower disclosure/consent card — ZEPH and ZANO's swap-side
 * host-wallet surface (Grove expansion plan, Phase C, unit C-T2:
 * `PwndaWalletVault/wiki/synthesis/grove-expansion-master-plan.md` § 3).
 *
 * Both coins are FOLLOWERS, never leaders: they have no local chain and no
 * light-client option at all — `ELECTRUM_CAPABLE` in `swap_sidecar.rs` lists
 * only bitcoin/litecoin/bitcoincash, and zephyr/zano are called out there by
 * name as deliberately absent. Every trade runs against a REMOTE daemon plus
 * this app's own wallet-rpc process (`zephyr-wallet-rpc` / `simplewallet`),
 * which is why the byline reads "remote node · no chain" rather than any of
 * `DexCoinCard`'s Light/Local-node language — there is no local-node choice
 * to offer for either coin.
 *
 * # This is genuinely ONE component, mounted in both layouts
 *
 * Per the contributor guide's "Landscape-First Development" hard rule (and the
 * `landscapeRouterParity.test.ts` precedent it names — a router *tab* is not
 * the same claim as the tab having real content): `SwapView.tsx` and
 * `SwapLandscapeView.tsx` both import THIS file directly, sibling-file style,
 * the same mechanism `SwapLandscapeView.tsx` already uses for
 * `BasicswapStrip`/`ActiveSidecarSwapsPanel` (imported from `./SwapView`
 * rather than reforked). There is no landscape-local copy of this card.
 *
 * It lives in `features/swap/`, not `features/swap-sidecar/`, on purpose:
 * both mount sites are in this same feature folder, so a same-folder file
 * needs no cross-feature export through `swap-sidecar/index.ts` at all
 * (BOUNDARIES.md's per-feature rule) — one fewer file this unit would
 * otherwise have needed to touch outside its assigned OWNS list.
 *
 * # Pure presentational (contract §2.2, same discipline as `DexXmrWalletCard`)
 *
 * Zero `invoke`, no polling. `onSetAck` is optional and the control is
 * hidden entirely when it is absent — `DexXmrWalletCard`'s own header
 * explains why: "an offered-then-unanswerable toggle is worse than an
 * absent one."
 *
 * **Was not wired to a live consent control from 2026-09-03 to 2026-09-04.**
 * As first shipped, the backend activation units for these two coins
 * (`maybe_activate_zph_host_wallet` / `maybe_activate_zano_host_wallet` —
 * units C-RZ/C-RX of the Grove expansion plan) existed, but
 * `swap_sidecar_coin_status` still routed EVERY non-Monero coin's
 * `canShareWallet`/`sharesWallet` — zephyr and zano included — through the
 * C8 lean-wallet predicate (`can_run_lean` / `shares_lean_wallet`), which is
 * unconditionally `false` for both (neither is `ELECTRUM_CAPABLE`), even
 * though the file already carried the correct predicates
 * (`shares_zph_host_wallet` / `shares_zano_host_wallet`, opt-OUT by design —
 * `*_host_wallet_declined_at.is_none()`), and no command wrote the ack
 * fields. So both mount sites rendered this card WITHOUT `onSetAck`.
 *
 * **Wired 2026-09-04.** `swap_sidecar.rs` gained `share_flags` (per-coin
 * predicate routing), `swap_sidecar_set_cn_host_wallet` (the writer) and
 * `hostWalletActive` on the status row; `useCnHostWalletConsent` reads and
 * writes through them; and `DexCnWalletSection` (bottom of this file) is
 * what both views mount now. The paragraph above is kept as the record of
 * why the card spent a day as disclosure-only.
 */
import type { CSSProperties } from "react";
import { Btn, Card } from "../../design/primitives";
import { useCnHostWalletConsent } from "../swap-sidecar";

const mono: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  lineHeight: 1.6,
};

export type CnFollowerCoin = "ZEPH" | "ZANO";

interface CnFollowerCopy {
  /** Named so the card says WHICH remote process, not just "your wallet" —
   *  two CryptoNote coins, two different processes, and a generic "your
   *  wallet" reads as one shared claim across both. */
  walletProcess: string;
  /** § 6.4 of the Grove expansion plan, in substance: "ZEPH's consent card
   *  must name: upstream inactive since 2025-06, Monero-base 638 commits
   *  behind, the supply-audit history, and that BasicSwap's maintainers
   *  declined the coin on those grounds. ZANO's must name: amounts hidden
   *  from third parties, every step a 10-confirmation wait, and that the
   *  scratch wallet runs a pwnda-built binary." */
  disclosure: string;
}

const CN_FOLLOWER_COPY: Readonly<Record<CnFollowerCoin, CnFollowerCopy>> = {
  ZEPH: {
    walletProcess: "your zephyr-wallet-rpc",
    disclosure:
      "Zephyr's upstream repository has had no commits since June 2025, and " +
      "its Monero base sits 638 commits behind. BasicSwap's own maintainers " +
      "declined to carry this coin on those grounds; pwnda hosts it anyway, " +
      "with that history disclosed here rather than left for you to find. " +
      "Review the chain's supply-audit history before trading a meaningful " +
      "amount.",
  },
  ZANO: {
    // 2026-09-04: corrected. The engine locks and receives ZANO through your
    // Main wallet (`publishBLockTx` / `getMainWalletAddress` in
    // interface/zano/zano.py, after `_confirmMainWalletIdentity`); the scratch
    // wallet only ever holds a swap's joint key while claiming. The old copy
    // said trades ran from the scratch wallet, which would have meant a
    // maker could never sell ZANO — and it was simply not how the engine works.
    walletProcess:
      "your Zano wallet — the engine confirms its identity before every spend; a scratch wallet holds only a swap's joint key while claiming",
    disclosure:
      "Zano's Zarcanum protocol hides trade amounts from third parties, and " +
      "every step of a Zano swap waits for 10 confirmations before the next " +
      "one proceeds — noticeably slower than a Bitcoin-family leg. The " +
      "scratch wallet the swap engine spends from runs a pwnda-built " +
      "binary, not an official Zano release; your MAIN Zano wallet is never " +
      "opened, re-keyed, or spent from by the engine.",
  },
};

/**
 * @param coin which CryptoNote follower this instance describes — one card
 *        per coin; the mount site renders one of each.
 * @param ack current consent, when the mount has a real read for it.
 *        `undefined` renders the disclosure only, with no state claim — see
 *        the module header for why nothing reads a live value yet.
 * @param onSetAck omit to hide the consent control entirely (its own state
 *        line goes with it, since a state claim with no control beside it
 *        to act on is exactly the "unanswerable toggle" problem stated for
 *        the button, one level up).
 * @param busy disables the control mid-request
 * @param error the SET path's own error, verbatim
 * @param active sharing is ACTIVE in the config the running node booted
 *        from (`CoinEnableStatus.hostWalletActive`). Distinct from `ack`:
 *        consent takes effect at the next node start, and saying "using my
 *        wallet" about a node that has not restarted since would be a claim
 *        about the future. Only rendered beside a live control.
 */
export function DexCnWalletCard({
  coin,
  ack,
  busy = false,
  error = null,
  onSetAck,
  active = false,
}: {
  coin: CnFollowerCoin;
  ack?: boolean;
  busy?: boolean;
  error?: string | null;
  onSetAck?: (share: boolean) => void;
  active?: boolean;
}) {
  const copy = CN_FOLLOWER_COPY[coin];

  return (
    <Card title={`SWAP — ${coin} (REMOTE)`}>
      <div
        style={{
          ...mono,
          fontSize: 9.5,
          letterSpacing: 1,
          textTransform: "uppercase",
          color: "var(--text-muted)",
          marginBottom: 6,
        }}
      >
        remote node · no chain
      </div>

      <div style={{ ...mono, fontSize: 10.5, color: "var(--text-dim)", marginBottom: 8 }}>
        {coin} carries no local daemon here and no light-client option — every
        trade runs against a remote {coin} node and {copy.walletProcess}.
      </div>

      <div
        style={{
          ...mono,
          fontSize: 10.5,
          color: "var(--text-dim)",
          borderLeft: "2px solid var(--border-soft)",
          paddingLeft: 8,
        }}
      >
        {copy.disclosure}
      </div>

      {onSetAck && (
        <div
          style={{
            ...mono,
            fontSize: 10.5,
            marginTop: 10,
            paddingTop: 8,
            borderTop: "1px solid var(--border-soft)",
          }}
        >
          <div style={{ color: "var(--text-dim)", marginBottom: 6 }}>
            {ack === false
              ? `${coin} is funded by deposit instead of ${copy.walletProcess}.`
              : active
                ? `Trades from ${copy.walletProcess} — nothing to deposit, nothing to sweep back.`
                : `Will trade from ${copy.walletProcess} once the swap node next starts — nothing to deposit, nothing to sweep back.`}
          </div>
          <Btn
            variant={ack === false ? "ghost" : "accent"}
            size="sm"
            disabled={busy}
            onClick={() => onSetAck(ack === false)}
          >
            {busy ? "…" : ack === false ? "Use my wallet" : "Using my wallet"}
          </Btn>
        </div>
      )}

      {error && (
        <div
          style={{
            ...mono,
            fontSize: 11,
            color: "var(--danger)",
            wordBreak: "break-word",
            marginTop: 8,
          }}
        >
          {error}
        </div>
      )}
    </Card>
  );
}

/**
 * Hook-owning mount for {@link DexCnWalletCard} — the piece that was missing
 * until 2026-09-04.
 *
 * The card's header (above) records, dated 2026-09-03, why it was mounted
 * WITHOUT a consent control: the backend's activation units existed but
 * `swap_sidecar_coin_status` routed ZEPH/ZANO through the lean predicate and
 * no command wrote their ack fields. Both halves landed today
 * (`share_flags` / `swap_sidecar_set_cn_host_wallet` in `swap_sidecar.rs`),
 * so this section reads the live consent through `useCnHostWalletConsent`
 * and hands the card a real `onSetAck` — the same shape
 * `DexXmrWalletSection` gives `DexXmrWalletCard` for Monero.
 *
 * ONE component, imported by BOTH `SwapView.tsx` and `SwapLandscapeView.tsx`
 * (the `landscapeRouterParity.test.ts` assertions were moved from the bare
 * card to this section for exactly that reason): a consent control wired in
 * one layout and not the other is the drift the landscape-first rule exists
 * to stop, and it is invisible — both layouts would still show the card.
 *
 * The control is only offered for a coin the node is ENABLED for
 * (`enabled` from the status row). Consent for a disabled coin is a decision
 * about nothing, and the Rust default already reads "will share" the moment
 * the coin is enabled — the DEX-coins card is where enabling happens.
 */
export function DexCnWalletSection({
  coin,
  optedIn,
}: {
  coin: CnFollowerCoin;
  /** `useSwapSidecarOptIn().optedIn === true` at the mount. */
  optedIn: boolean;
}) {
  const consent = useCnHostWalletConsent(coin === "ZEPH" ? "zephyr" : "zano", optedIn);
  return (
    <DexCnWalletCard
      coin={coin}
      ack={consent.enabled ? consent.ack : undefined}
      busy={consent.busy}
      error={consent.error}
      onSetAck={consent.enabled ? (share) => void consent.setAck(share) : undefined}
      active={consent.active}
    />
  );
}
