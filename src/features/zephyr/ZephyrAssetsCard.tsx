import {
  ZPH_ASSETS,
  ZPH_ASSET_NAME,
  ZPH_ASSET_COLOR,
  ZPH_UI_TICKER,
  atomicToZph,
  type ZphAssetBalance,
  type ZphAssetType,
} from "../../wallets/zph-rpc";
import { zphAssetPrice, type ZphLiveStats } from "../../wallets/zph-scanner-api";
import { Card } from "../../components/PrimitivesV2";
import { CoinIcon } from "../../components/CoinIcon";

// ZPH_ASSET_COLOR now comes from `wallets/zph-rpc` (single definition).

/** Zephyr atomic units are 1e12 per whole coin (same as Monero piconero). */
const ZPH_ATOMIC = 1e12;

const fmtUsd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * "Zephyr Ecosystem" card — shown on the Zephyr dashboard listing all
 * four protocol assets (ZPH, ZSD, ZRS, ZYS) with click-to-swap rows.
 *
 * Even when the user has only ZPH (the common case), the card still
 * surfaces the full ecosystem so they can see what's available to mint
 * into. Clicking ZPH starts a "ZPH → ZSD" mint by default; clicking any
 * non-ZPH asset starts a redeem-back-to-ZPH flow.
 *
 * Hidden only until the first `getAllBalances` snapshot lands (so we
 * don't briefly flash a "0/0/0/0" card before the real numbers load).
 *
 * Phase 5.2 of [[zephyr-ecosystem-swap-plan]]. USD-equivalent pricing per
 * asset (2026-06-29) reads the live oracle prices from `liveStats`
 * (`zph-scanner-api` livestats: `zeph_price`/`zsd_price`/`zrs_price`/
 * `zys_price`) via the shared `zphAssetPrice` helper — matching the
 * landscape wallet view. Each row shows `≈ $value` (balance × oracle
 * price) and the card foots a total; both are omitted until the stats
 * land, so nothing ever shows a bogus $0. (Phase 4 will add a
 * ZYS-specific APY/share-price line.)
 */
export function ZephyrAssetsCard({
  assetBalances,
  liveStats,
  onOpenSwap,
}: {
  assetBalances: ZphAssetBalance[] | null;
  /** Live Zephyr oracle prices (from `useZphReserveInfo`); null until loaded. */
  liveStats: ZphLiveStats | null;
  onOpenSwap: (sourceAsset: ZphAssetType) => void;
}) {
  if (!assetBalances) return null;

  // All four ecosystem assets in canonical order. Always rendered so the
  // user can see what they could mint into, not just what they currently
  // hold.
  const rows: Array<{ asset: ZphAssetType; entry?: ZphAssetBalance }> =
    ZPH_ASSETS.map((asset) => ({
      asset,
      entry: assetBalances.find((b) => b.asset_type === asset),
    }));

  // Card-wide total of every priced, non-zero holding (ecosystem value).
  let totalUsd = 0;
  let anyPriced = false;
  for (const { asset, entry } of rows) {
    const price = zphAssetPrice(liveStats, asset);
    const bal = entry?.balance ?? 0;
    if (price != null && bal > 0) {
      totalUsd += (bal / ZPH_ATOMIC) * price;
      anyPriced = true;
    }
  }

  return (
    <Card title="ZEPHYR ECOSYSTEM">
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontFamily: "var(--mono)",
          fontSize: 11,
        }}
      >
        <tbody>
          {rows.map(({ asset, entry }) => {
            const total = entry?.balance ?? 0;
            const unlocked = entry?.unlocked_balance ?? 0;
            const locked = total - unlocked;
            const isZero = total === 0;
            const price = zphAssetPrice(liveStats, asset);
            const usd = price != null ? (total / ZPH_ATOMIC) * price : null;
            return (
              <tr
                key={asset}
                onClick={() => onOpenSwap(asset)}
                style={{
                  cursor: "pointer",
                  borderBottom: "1px solid rgba(255,255,255,0.06)",
                  opacity: isZero ? 0.55 : 1,
                }}
                title={`Open swap with ${ZPH_UI_TICKER[asset]} pre-selected`}
              >
                <td style={{ padding: "8px 6px", verticalAlign: "top" }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <CoinIcon
                      sym={asset}
                      size={20}
                      accent={ZPH_ASSET_COLOR[asset]}
                      glow={!isZero}
                    />
                    <div>
                      <div style={{ fontWeight: 600 }}>
                        {ZPH_UI_TICKER[asset]}
                      </div>
                      <div
                        style={{
                          fontSize: 9,
                          color: "var(--text-dim)",
                          marginTop: 2,
                        }}
                      >
                        {ZPH_ASSET_NAME[asset]}
                      </div>
                    </div>
                  </div>
                </td>
                <td
                  style={{
                    padding: "8px 6px",
                    textAlign: "right",
                    verticalAlign: "top",
                  }}
                >
                  <div>{atomicToZph(total)}</div>
                  {usd != null && !isZero && (
                    <div
                      style={{
                        fontSize: 9,
                        color: "var(--accent)",
                        marginTop: 2,
                      }}
                    >
                      ≈ {fmtUsd(usd)}
                    </div>
                  )}
                  {locked > 0 && (
                    <div
                      style={{
                        fontSize: 9,
                        color: "var(--text-dim)",
                        marginTop: 2,
                      }}
                    >
                      {atomicToZph(locked)} locked
                    </div>
                  )}
                </td>
                <td
                  style={{
                    padding: "8px 0 8px 8px",
                    width: 24,
                    textAlign: "right",
                    color: "var(--text-dim)",
                  }}
                >
                  ›
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {anyPriced && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginTop: 8,
            paddingTop: 8,
            borderTop: "1px solid rgba(255,255,255,0.1)",
            fontFamily: "var(--mono)",
            fontSize: 11,
          }}
        >
          <span style={{ color: "var(--text-dim)" }}>Ecosystem value</span>
          <span style={{ fontWeight: 700, color: "var(--accent)" }}>
            ≈ {fmtUsd(totalUsd)}
          </span>
        </div>
      )}
      <p className="gas-info" style={{ marginTop: 8, marginBottom: 0 }}>
        Click any asset to open the swap panel pre-filled with that asset
        as the source. USD values use the Zephyr protocol oracle (ZSD = $1
        peg, ZYS = accrued yield value).
      </p>
    </Card>
  );
}
