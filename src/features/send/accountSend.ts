/**
 * Should this send go through the adapter's ACCOUNT-WIDE path?
 *
 * Extracted from `useSend` so the decision can be tested without mounting a
 * hook. It is four booleans, but getting any one of them wrong is a
 * fund-visibility bug rather than a cosmetic one — see the doc on
 * `ChainAdapter.sendFromAccount` and the 2026-08-25 entry in the vault log.
 */
export type AccountSendInputs = {
  /** Does the adapter implement `sendFromAccount`? */
  hasAccountSend: boolean;
  /** Does the adapter's `supportsAccountSend` accept this wallet's address? */
  accountMatches: boolean;
  /** Do we hold the BIP-39 mnemonic? Sibling derivation needs it. */
  hasMnemonic: boolean;
  /** Set when sending a token, which the native account path cannot carry. */
  assetType?: string;
};

export function shouldUseAccountSend(i: AccountSendInputs): boolean {
  return (
    i.hasAccountSend && i.hasMnemonic && i.accountMatches && !i.assetType
  );
}
