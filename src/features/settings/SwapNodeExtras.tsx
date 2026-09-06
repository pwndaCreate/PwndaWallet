/**
 * Swap-node surfaces that used to sit in the Swap tab, now under Settings.
 *
 * Moved 2026-09-05 at the operator's request: "I only want things pertaining
 * to any swaps [in the swap tab] — move any swap node stuff or sweep back
 * stuff to settings". Three blocks came here:
 *
 * * **Sweep back** — recover coins the node holds in ITS OWN wallet. Now
 *   restricted to coins that are not already the user's wallet
 *   (`sharedTickers`): a shared BTC/LTC/BCH account or a host XMR/ZEPH/ZANO
 *   wallet-rpc has nothing to sweep, and offering it was a fee-paying
 *   self-transfer dressed as recovery. On a fully-shared node this section
 *   renders nothing, which is correct.
 * * **ZEPH / ZANO remote-wallet disclosure + consent** — a fact about how the
 *   node runs those two coins, beside the DEX-coins card that enables them.
 *
 * (The swap-node BALANCES card was removed outright rather than moved: for a
 * shared coin it duplicated the wallet's own balance, and for the rest the
 * sweep list below says what the node holds.)
 *
 * ONE component, mounted by both Settings layouts — the Landscape-First rule.
 * `landscapeRouterParity.test.ts` pins that both mount it and that neither
 * Swap view still renders these blocks.
 */
import { useMemo } from "react";
import {
  useCoinStatuses,
  useSidecarBalances,
  useSwapSidecarOptIn,
} from "../swap-sidecar";
import { useAppState } from "../../state/AppStateContext";
import { SweepBackSection } from "../swap/SweepBackSection";

/** UPPERCASE tickers whose node wallet is the user's own wallet. */
export function sharedTickersFrom(
  statuses: ReadonlyArray<{
    ticker: string;
    adoption: string;
    hostWalletActive?: boolean;
    xmrHostWalletActive?: boolean;
  }>,
): Set<string> {
  const out = new Set<string>();
  for (const s of statuses) {
    if (
      s.adoption === "accountkey" ||
      s.hostWalletActive === true ||
      s.xmrHostWalletActive === true
    ) {
      out.add(s.ticker.toUpperCase());
    }
  }
  return out;
}

export function SwapNodeExtras() {
  const { optedIn } = useSwapSidecarOptIn();
  const { walletsByChain } = useAppState();
  const balances = useSidecarBalances({ enabled: optedIn === true });
  const coinStatuses = useCoinStatuses({ enabled: optedIn === true });
  const sharedTickers = useMemo(
    () => sharedTickersFrom(coinStatuses.statuses),
    [coinStatuses.statuses],
  );
  if (optedIn !== true) return null;
  return (
    <>
      <SweepBackSection
        optedIn={optedIn}
        rows={balances.rows}
        hasWallet={(chain) => !!walletsByChain[chain]}
        sharedTickers={sharedTickers}
      />
    </>
  );
}
