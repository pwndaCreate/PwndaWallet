import { useState } from "react";
import { Card } from "../../components/PrimitivesV2";
import { ST } from "../../components/Primitives";
import { ZephyrAssetSelect } from "./ZephyrAssetSelect";
import { routeFor, routeHint } from "./zephyrRoutes";
import {
  ZPH_ASSETS,
  ZPH_ASSET_NAME,
  ZPH_UI_TICKER,
  atomicToZph,
  type ZphAssetBalance,
  type ZphAssetType,
} from "../../wallets/zph-rpc";
import { CoinIcon } from "../../components/CoinIcon";
import {
  AmountCard,
  FlipButton,
  QuotePanel,
  PixelCta,
  Chip,
  ChipRow,
} from "../swap/components/swap-ui";

/**
 * Dedicated Zephyr-ecosystem swap surface.
 *
 * Why it's separate from the cross-chain form: Zephyr's mechanism is
 * fundamentally different. NEAR Intents routes via 1Click + OMFT bridges (the
 * asset moves across chains); Zephyr uses an **in-protocol** asset conversion
 * (`transfer` with `source_asset` ≠ `destination_asset`) that mint/redeems
 * inside the Zephyr chain itself. The two are mutually exclusive — a Zephyr
 * ecosystem asset can only ever become another Zephyr ecosystem asset — and
 * mixing them in one dropdown produced two real lockouts on 2026-05-07 (a
 * source change that stranded the destination, and vice versa).
 *
 * # Redesigned 2026-08-28 (canvas frame 2a)
 *
 * The card used to lead with two paragraphs explaining mint/redeem and a
 * per-asset list with a Swap button on every row. It now speaks the same
 * language as the rest of the swap surface: chips instead of prose, a
 * four-asset balance strip, the SAME framed send/receive cards + overlapping
 * flip control the cross-chain form uses, and a quote panel whose rate row is
 * tagged `ORACLE` rather than `LIVE` — because a Zephyr rate comes from the
 * protocol's own oracle, not from a counterparty's quote, and calling it
 * "live" would borrow a meaning it does not have.
 *
 * The selectors are limited to the four protocol assets by construction: this
 * component never sees any other ticker. That is the same "invalid pairs are
 * unpickable" principle the P2P surface got, arrived at from the other end.
 *
 * The CTA still opens `<ZephyrSwapModal>`, which owns the actual quote and
 * relay flow. This surface is the pair + amount picker; nothing here moves
 * funds.
 */
export function ZephyrEcosystemSwapCard(props: {
  zphAssetBalances?: ZphAssetBalance[] | null;
  /** Wired by the parent — opens the existing `<ZephyrSwapModal>` with an
   *  optional pre-filled source asset. */
  onOpenZephyrSwapModal: (initialSource?: ZphAssetType) => void;
  /** When the user has no Zephyr wallet derived yet, the CTA is gated. */
  hasZephyrWallet: boolean;
  /** Render without the surrounding `<Card>` chrome (the Zephyr TAB already
   *  provides a header; the standalone card does not). */
  embedded?: boolean;
}) {
  const {
    zphAssetBalances,
    onOpenZephyrSwapModal,
    hasZephyrWallet,
    embedded = false,
  } = props;

  const [fromAsset, setFromAsset] = useState<ZphAssetType>(ZPH_ASSETS[0]);
  const [toAsset, setToAsset] = useState<ZphAssetType>(
    ZPH_ASSETS[1] ?? ZPH_ASSETS[0],
  );
  const [amount, setAmount] = useState("");

  const balanceFor = (asset: ZphAssetType): string => {
    if (!zphAssetBalances) return "—";
    const entry = zphAssetBalances.find((b) => b.asset_type === asset);
    if (!entry) return "0.000000";
    return atomicToZph(entry.unlocked_balance ?? entry.balance ?? 0);
  };

  const numericBalance = (asset: ZphAssetType): number | null => {
    const raw = balanceFor(asset);
    if (raw === "—") return null;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  };

  /** Step to the next protocol asset, skipping the other side. */
  const cycle = (current: ZphAssetType, avoid: ZphAssetType): ZphAssetType => {
    const i = ZPH_ASSETS.indexOf(current);
    for (let step = 1; step <= ZPH_ASSETS.length; step++) {
      const next = ZPH_ASSETS[(i + step) % ZPH_ASSETS.length];
      if (next !== avoid) return next;
    }
    return current;
  };

  const flip = () => {
    setFromAsset(toAsset);
    setToAsset(fromAsset);
  };

  /**
   * The protocol route between the two chosen assets.
   *
   * Zephyr conversion is not all-to-all — see `zephyrRoutes.ts`. Computing it
   * here means the panel can state the leg count instead of the picker
   * silently offering a three-transaction pair as though it were one.
   */
  const zephRoute = routeFor(fromAsset, toAsset);
  const zephHint = routeHint(zephRoute);

  const fromBal = numericBalance(fromAsset);
  const amountNum = parseFloat(amount) || 0;
  const ctaDisabled = !hasZephyrWallet;

  const body = (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        fontFamily: "var(--font-mono)",
      }}
    >
      {/* Chips replace the two explanatory paragraphs. Each is a fact about
          the mechanism the old prose spent a sentence on. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        <Chip>1 on-chain tx</Chip>
        <Chip>no bridge</Chip>
        <Chip>mint / redeem</Chip>
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontSize: 8,
            color: "var(--text-dim)",
            letterSpacing: 0.5,
          }}
        >
          external coins route via ZEPH
        </span>
      </div>

      {/* Four-asset balance strip — READ-ONLY.

          It used to double as the source picker, which is how the caret on the
          amount card came to be a lie: clicking `▾` cycled the asset and lit a
          tile up here, so the strip looked like a segmented control and the
          caret looked like a dropdown, and neither was. The selectors are now
          real dropdowns on the cards themselves; this strip reports balances
          and nothing else. */}
      <div style={{ display: "flex", gap: 6 }}>
        {ZPH_ASSETS.map((asset) => {
          const ticker = ZPH_UI_TICKER[asset];
          const on = asset === fromAsset;
          return (
            <div
              key={asset}
              title={`${ZPH_ASSET_NAME[asset]} balance`}
              style={{
                flex: 1,
                minWidth: 0,
                border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
                background: on ? "var(--accent-soft)" : "var(--surface)",
                padding: "8px 10px",
                textAlign: "left",
                fontFamily: "var(--font-mono)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 9,
                  letterSpacing: 1,
                  textTransform: "uppercase",
                  color: on ? "var(--accent)" : "var(--text-muted)",
                }}
              >
                <CoinIcon sym={ticker} size={12} glow={false} />
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {ticker}
                </span>
              </div>
              <div
                className="tnum"
                style={{
                  fontSize: 11,
                  color: on ? "var(--accent)" : "var(--text)",
                  marginTop: 4,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {balanceFor(asset)}
              </div>
            </div>
          );
        })}
      </div>

      {/* The same send/receive anatomy the cross-chain form uses. */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        <AmountCard
          label="you send"
          amount={amount}
          onAmountChange={setAmount}
          ticker={ZPH_UI_TICKER[fromAsset]}
          balanceLabel={fromBal != null ? `bal ${balanceFor(fromAsset)}` : "bal —"}
          onMax={fromBal != null ? () => setAmount(String(fromBal)) : undefined}
          pickerSlot={
            <ZephyrAssetSelect
              side="from"
              value={fromAsset}
              counterpart={toAsset}
              balanceFor={balanceFor}
              onChange={(a) => {
                setFromAsset(a);
                // Never leave both sides equal — that is not a conversion.
                if (a === toAsset) setToAsset(cycle(a, a));
              }}
            />
          }
          networkLabel="zephyr protocol"
        />

        <FlipButton onClick={flip} />

        <AmountCard
          label="you receive"
          amount={amountNum > 0 ? "—" : ""}
          readOnly
          amountColor="var(--accent)"
          ticker={ZPH_UI_TICKER[toAsset]}
          pickerSlot={
            <ZephyrAssetSelect
              side="to"
              value={toAsset}
              counterpart={fromAsset}
              balanceFor={balanceFor}
              onChange={(a) => {
                setToAsset(a);
                if (a === fromAsset) setFromAsset(cycle(a, a));
              }}
            />
          }
          networkLabel="zephyr protocol"
          overlapTop
          placeholder="0.00"
        />
      </div>

      {/* The rate is the protocol's oracle, and says so. The receive amount
          and fee come from the modal's own quote — this surface deliberately
          does not invent either, so the rows read "—" until the modal prices
          it rather than showing a number nothing computed. */}
      <QuotePanel
        rows={[
          {
            label: "rate",
            value: `1 ${ZPH_UI_TICKER[fromAsset]} → ${ZPH_UI_TICKER[toAsset]}`,
            accent: true,
            marker: "ORACLE",
          },
          { label: "fee", value: "quoted at confirm" },
          {
            label: "route",
            value:
              zephRoute == null
                ? "—"
                : zephRoute.legs.length === 1
                  ? `direct · ${zephRoute.legs[0].kind}`
                  : `${zephRoute.legs.length} tx · via ${zephRoute.via
                      .map((v) => ZPH_UI_TICKER[v])
                      .join(" → ")}`,
          },
          { label: "time", value: "next block · ~2 min" },
        ]}
      />

      {/* A multi-leg conversion costs the user several signed transactions.
          Saying so where they choose is the difference between a route and a
          surprise — the old copy covered only some pairs, so ZSD→ZRS (two
          transactions) simply looked direct. */}
      {zephHint && (
        <div
          style={{
            border: "1px solid rgba(255,170,0,0.35)",
            background: "var(--surface)",
            padding: "8px 10px",
            fontSize: 9,
            lineHeight: 1.5,
            color: "var(--warn)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {zephHint}
        </div>
      )}

      <PixelCta
        label={hasZephyrWallet ? "► SWAP" : "ZEPHYR WALLET NEEDED"}
        disabled={ctaDisabled}
        onClick={() => onOpenZephyrSwapModal(fromAsset)}
        title={
          hasZephyrWallet
            ? undefined
            : "Import or sync a Zephyr wallet to swap ecosystem assets"
        }
      />

      <ChipRow>
        <Chip>on-chain</Chip>
        <Chip tone="accent">no kyc</Chip>
        <Chip>non-custodial</Chip>
      </ChipRow>
    </div>
  );

  if (embedded) return body;

  return (
    <Card title={<ST speed={20}>ZEPHYR ECOSYSTEM SWAP</ST>}>{body}</Card>
  );
}
