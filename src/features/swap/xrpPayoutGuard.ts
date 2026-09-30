/**
 * Why a NEAR swap paying out XRP must not be signed, or null (2026-09-29).
 *
 * The XRP Ledger has no account until a payment of at least the base reserve
 * (1 XRP today) creates it, and it refuses anything smaller to an address that
 * does not exist yet (`tecNO_DST_INSUF_XRP`). A first-time XRP user swapping
 * into XRP is exactly that address.
 *
 * NEAR's own bridge floor for XRP payouts sat at about 1.05 XRP of output on
 * the day this was written (a dry quote below it answered "try at least …"),
 * so the case is narrow: a quote near that floor whose slippage allowance
 * lets the GUARANTEED amount (`minReceived`) fall under the reserve. What the
 * bridge does with a refused payout is not documented, so the guard refuses
 * to sign rather than find out with the user's funds.
 *
 * `activation` null means the ledger could not be asked: unknown is not
 * "not activated", and nothing is blocked on it.
 */
export function xrpPayoutBlockReason(args: {
  activation: { activated: boolean; reserveBaseXrp: number } | null;
  minReceived: string;
  destination: string;
}): string | null {
  const { activation } = args;
  if (!activation || activation.activated) return null;
  const guaranteed = Number(args.minReceived);
  if (!Number.isFinite(guaranteed) || guaranteed >= activation.reserveBaseXrp) return null;
  const who =
    args.destination.length > 14
      ? `${args.destination.slice(0, 6)}…${args.destination.slice(-4)}`
      : args.destination;
  return (
    `Your XRP account (${who}) is not activated yet. The XRP Ledger only creates an ` +
    `account with a first payment of at least ${activation.reserveBaseXrp} XRP, and this ` +
    `swap guarantees only ${args.minReceived} XRP — below that, the payout would be ` +
    `refused. Increase the amount (or lower the slippage) until at least ` +
    `${activation.reserveBaseXrp} XRP is guaranteed.`
  );
}
