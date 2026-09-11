/**
 * Which asset pays the fee on each EVM chain, and what to call it.
 *
 * # Why this exists
 *
 * An ERC-20 send spends TWO assets: the token being transferred, and the
 * chain's native coin that pays for gas. The wallet showed only the first. A
 * user holding 500 USDC on Arbitrum and 0 ETH saw "Available: 500 USDC", a
 * network fee, and an enabled Send button — then a raw RPC string
 * (`insufficient funds for intrinsic transaction cost`) after pressing it,
 * because `evm-factory.ts`'s ERC-20 branch called `contract.transfer(...)`
 * with no balance check in front of it.
 *
 * L2s make this the NORMAL first state rather than an edge case: bridging
 * USDC to Arbitrum or Base moves the token and nothing else, so a freshly
 * bridged wallet holds real value and exactly zero gas. Twelve token adapters
 * across seven chains are in this position (`eth-wallet.ts`).
 *
 * # Why a table rather than a lookup on the native adapter
 *
 * The facts below already exist, once, on each chain's own native adapter
 * (`createEvmAdapter({ chain: "arbitrum", ticker: "ETH", displayName:
 * "Arbitrum", chainId: 42161 })`). Reading them at runtime would mean a token
 * adapter reaching into a sibling adapter's construction, and would depend on
 * module-init order inside `eth-wallet.ts`, where `usdt-avax` is created
 * before `polygon`.
 *
 * So this is a second copy, and the honest thing to do with a second copy is
 * to make it fail loudly when it disagrees: `evm-gas.test.ts` walks every
 * adapter in `eth-wallet.ts` and asserts (a) every native chain's ticker and
 * display name match the row here, and (b) every TOKEN adapter's chainId has
 * a row at all. A chain added without a row breaks that test rather than
 * silently shipping a token that cannot describe its own gas.
 */

/** The coin that pays gas on one EVM chain. */
export interface EvmGasToken {
  /** Ticker of the fee-paying coin, e.g. `"ETH"`, `"POL"`, `"BNB"`. */
  ticker: string;
  /** Human chain name for copy, e.g. `"Arbitrum"`. NOT the coin's name: the
   *  user needs to know WHICH ETH, and "you need ETH" is the sentence that
   *  sends somebody to buy ETH on mainnet and bridge it to the wrong place. */
  chainName: string;
}

/**
 * chainId → the coin that pays gas there.
 *
 * Keyed on `chainId` rather than on our `ChainType` string because chainId is
 * the externally verifiable identifier: it is what the RPC answers with, what
 * a block explorer agrees on, and what a reviewer can check against
 * chainlist.org without reading this repo. `usdc-arb` and `arbitrum` are two
 * of our names for one chain; `42161` is everyone's.
 */
export const EVM_GAS_TOKENS: Readonly<Record<number, EvmGasToken>> = {
  1: { ticker: "ETH", chainName: "Ethereum" },
  10: { ticker: "ETH", chainName: "Optimism" },
  14: { ticker: "FLR", chainName: "Flare" },
  56: { ticker: "BNB", chainName: "BNB Smart Chain" },
  137: { ticker: "POL", chainName: "Polygon" },
  143: { ticker: "MON", chainName: "Monad" },
  8453: { ticker: "ETH", chainName: "Base" },
  42161: { ticker: "ETH", chainName: "Arbitrum" },
  43114: { ticker: "AVAX", chainName: "Avalanche" },
};

/**
 * The gas coin for a chainId, or `null` when we have no row.
 *
 * `null` is deliberate and is not an error the caller should paper over: it
 * means this build cannot name the fee asset, so it must not claim the user
 * is short of something it cannot name. Callers skip the check rather than
 * guessing "ETH".
 */
export function gasTokenFor(chainId: number | undefined): EvmGasToken | null {
  if (typeof chainId !== "number") return null;
  return EVM_GAS_TOKENS[chainId] ?? null;
}

/**
 * Gas limit to assume when the node will not estimate one.
 *
 * Only reached when `estimateGas` throws — most often because the recipient
 * field is still empty, or because the node refuses to simulate a transfer
 * from an account that cannot pay for it (which is itself the condition we
 * are testing for). These are ORDER-OF-MAGNITUDE fallbacks for showing a
 * number, never the basis for blocking a send: `getGasBudget` only reports
 * `sufficient: false` on a fallback when the balance is zero, where any
 * positive fee settles it regardless of the limit.
 *
 * Arbitrum is the reason this is not one constant. Its `estimateGas` folds
 * the L1 calldata cost into the returned limit, so a plain ERC-20 transfer
 * reports hundreds of thousands of gas rather than the ~60k an L1-style
 * chain would. A single 65k fallback would under-state the requirement there
 * by an order of magnitude.
 */
export const FALLBACK_GAS_LIMITS: Readonly<Record<number, bigint>> = {
  42161: 800_000n, // Arbitrum: includes the L1 data component
};

/** ERC-20 `transfer` on an ordinary EVM chain. Typical range is 45k-65k. */
export const FALLBACK_ERC20_GAS = 65_000n;

/** A bare native-coin transfer. Fixed by the EVM spec. */
export const FALLBACK_NATIVE_GAS = 21_000n;

/** The gas limit to assume for `chainId` when the node will not estimate. */
export function fallbackGasLimit(
  chainId: number | undefined,
  isToken: boolean,
): bigint {
  if (typeof chainId === "number" && FALLBACK_GAS_LIMITS[chainId] != null) {
    return FALLBACK_GAS_LIMITS[chainId];
  }
  return isToken ? FALLBACK_ERC20_GAS : FALLBACK_NATIVE_GAS;
}

/**
 * Can `availableWei` cover `requiredWei`?
 *
 * Extracted from the adapter because it is the one genuinely subtle line in
 * this feature, and it is not obvious from reading the call site:
 *
 *  - a priced estimate is a straight comparison, made in wei so no decimal
 *    string is ever parsed back into a float to decide whether somebody can
 *    send their money;
 *  - **no estimate but a zero balance is still a definite `false`** — no
 *    positive fee is payable from nothing, whatever the gas limit would have
 *    turned out to be. This branch is not a nicety: a node asked to simulate
 *    a transfer from an account that cannot fund it is exactly the node most
 *    likely to refuse the simulation, so the case where `estimateGas` fails
 *    and the case worth warning about are strongly correlated;
 *  - anything else is `null`. Unknown must not read as "insufficient": the
 *    caller disables Send on `false`, and blocking a send on a guess would be
 *    its own bug.
 */
export function decideGasSufficiency(
  availableWei: bigint,
  requiredWei: bigint | null,
): boolean | null {
  if (requiredWei != null) return availableWei >= requiredWei;
  return availableWei === 0n ? false : null;
}

/**
 * What a send needs out of the NATIVE balance.
 *
 * The asymmetry the send modal exists to explain, in one line:
 *
 *  - an ERC-20 transfer draws its amount from the TOKEN balance, so only gas
 *    touches the native one;
 *  - a native transfer draws BOTH from the same pot, so the requirement is
 *    their sum.
 *
 * Pricing only the gas on a native send would clear a wallet holding exactly
 * the amount it is trying to send — it has enough for the transfer or enough
 * for the fee, never both, and the failure lands at broadcast instead of in
 * the form.
 */
export function totalNativeRequired(
  gasCostWei: bigint,
  amountWei: bigint,
  isToken: boolean,
): bigint {
  return isToken ? gasCostWei : gasCostWei + amountWei;
}
