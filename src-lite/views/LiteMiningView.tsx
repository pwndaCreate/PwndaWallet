import type { ChainType } from "../../src/wallets";
import { MiningView } from "../../src/features/mining/MiningView";
import type { useMiner } from "../../src/features/mining/useMiner";

type MinerApi = ReturnType<typeof useMiner>;

/**
 * Thin lite-side wrapper around the shared `MiningView` from
 * `src/features/mining/`. The view is the same component the full wallet
 * renders; only the values flowing through the props differ. See
 * [[pwnda-mining-modularization]] M4 — the `addressFor` callback is the
 * inheritance seam that makes the same view code serve both products.
 */
export function LiteMiningView({
  miner,
  addressFor,
  pricesByTicker,
  onBack,
}: {
  miner: MinerApi;
  addressFor: (coin: ChainType) => string | null;
  pricesByTicker?: Record<string, number>;
  onBack: () => void;
}) {
  return (
    <MiningView
      miner={miner}
      addressFor={addressFor}
      pricesByTicker={pricesByTicker}
      onBack={onBack}
    />
  );
}
