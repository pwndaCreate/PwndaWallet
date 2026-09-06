/**
 * ERC-20 `transfer(address,uint256)` calldata encoder.
 *
 * Selector `0xa9059cbb` is the first 4 bytes of `keccak256("transfer(address,uint256)")`.
 * Layout (68 bytes total):
 *
 *   +--------+--------+--------+--------+--------+--------+--------+--------+
 *   | sel    |          recipient (32 bytes, left-padded)                  |
 *   +--------+--------+--------+--------+--------+--------+--------+--------+
 *   |          amount (32 bytes, big-endian uint256, left-padded)           |
 *   +--------+--------+--------+--------+--------+--------+--------+--------+
 *
 * Used by the source-tx EVM branch in `swap-execute.ts` when the source
 * asset is an ERC-20 token (USDC, USDT, DAI, etc.). The Rust `swap_sign_evm`
 * accepts arbitrary calldata via the `data` field — no Rust changes needed
 * for ERC-20 source signing, just this calldata builder + a balance gate.
 *
 * Test vectors anchored against verified mainnet USDC transfers in
 * `erc20-calldata.test.ts`.
 */

const TRANSFER_SELECTOR = "0xa9059cbb";
const BALANCE_OF_SELECTOR = "0x70a08231";

/** ERC-20 `transfer(address,uint256)` calldata for `transferAmount` to `recipient`. */
export function buildErc20TransferCalldata(
  recipient: string,
  amountAtomic: bigint,
): string {
  const cleanRecipient = recipient.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(cleanRecipient)) {
    throw new Error(`Invalid ERC-20 transfer recipient: ${recipient}`);
  }
  if (amountAtomic < 0n) {
    throw new Error("Negative ERC-20 transfer amount");
  }
  const amountHex = amountAtomic.toString(16);
  if (amountHex.length > 64) {
    throw new Error(`ERC-20 transfer amount overflows uint256: ${amountAtomic}`);
  }
  return (
    TRANSFER_SELECTOR +
    cleanRecipient.padStart(64, "0") +
    amountHex.padStart(64, "0")
  );
}

/** ERC-20 `balanceOf(address)` calldata, used by `eth_call`. */
export function buildErc20BalanceOfCalldata(holder: string): string {
  const clean = holder.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(clean)) {
    throw new Error(`Invalid balanceOf address: ${holder}`);
  }
  return BALANCE_OF_SELECTOR + clean.padStart(64, "0");
}

/** Inverse: parse a transferred amount out of an ERC-20 transfer calldata.
 *  Returns null if the calldata isn't `transfer(address,uint256)`. Used by
 *  the safety-invariant layer to verify a signed ERC-20 source tx still
 *  encodes the same recipient + amount we built. */
export function parseErc20TransferCalldata(
  calldataHex: string,
): { recipient: string; amount: bigint } | null {
  const c = calldataHex.toLowerCase();
  const body = c.startsWith("0x") ? c.slice(2) : c;
  if (body.length !== 136) return null; // 4-byte selector + 32 + 32 = 68 bytes hex
  if (!body.startsWith("a9059cbb")) return null;
  const recipientHex = body.slice(8, 8 + 64);
  const amountHex = body.slice(8 + 64);
  // The leading 24 bytes of the recipient slot must be zero (left-pad).
  if (!/^0{24}/.test(recipientHex)) return null;
  return {
    recipient: "0x" + recipientHex.slice(24),
    amount: BigInt("0x" + amountHex),
  };
}
