import { atomicToZano, type ZanoAssetBalance } from "../../wallets/zano-rpc";
import { Card } from "../../components/PrimitivesV2";

/**
 * Confidential-assets display card for Zano. Deliberately DISPLAY-ONLY —
 * matching the plan's stated v1 scope ("display + send + receive for native
 * ZANO... no confidential-asset SEND UI yet"). Contrast `ZephyrAssetsCard`,
 * which is click-to-swap for a FIXED four-asset ecosystem: Zano's whitelist
 * is open-ended (whatever the wallet has whitelisted — observed live:
 * ETHX/DAIX/BNBX/BTCX bridge-wrapped tokens, each with its OWN decimal
 * count), so there is no fixed "the four assets" swap UI to build yet, and
 * no verified conversion RPC to wire a click handler to even if there were.
 *
 * Decimals are read per-row from `assetInfo.decimalPoint`, never assumed —
 * see `zano-rpc.ts`'s header for why that matters here specifically (Zano's
 * assets are NOT all 12 decimals the way Zephyr's four always are).
 */
export function ZanoAssetsCard({
  assetBalances,
}: {
  assetBalances: ZanoAssetBalance[] | null;
}) {
  if (!assetBalances || assetBalances.length === 0) return null;

  return (
    <Card title="ZANO ASSETS" style={{ marginBottom: 14 }}>
      {assetBalances.map((b) => (
        <div
          key={b.assetInfo.assetId}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "8px 0",
            borderBottom: "1px solid #222",
          }}
        >
          <div>
            <div style={{ fontWeight: 600 }}>{b.assetInfo.ticker}</div>
            <div className="gas-info">{b.assetInfo.fullName}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div>{atomicToZano(b.total, b.assetInfo.decimalPoint)}</div>
            {b.total !== b.unlocked && (
              <div className="gas-info">
                {atomicToZano(b.unlocked, b.assetInfo.decimalPoint)} unlocked
              </div>
            )}
          </div>
        </div>
      ))}
    </Card>
  );
}
