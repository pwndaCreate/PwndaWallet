/**
 * Esplora → ChainTx, pinned on the 2026-09-17 ZEPH→LTC swap payout
 * (0683dbe0…, the lock-A spend that paid this wallet) as litecoinspace
 * returns it.
 */
import { describe, expect, it } from "vitest";
import { esploraTxToChainTx } from "./esplora-history";

const PAYOUT = {
  txid: "0683dbe03a9d3255761b780ccde31573f984744c76fdd1869f9e1de317f39e20",
  fee: 162,
  status: { confirmed: true, block_height: 3179459, block_time: 1789649503 },
  vin: [{ prevout: { scriptpubkey_address: "ltc1qp49844ssk9evse0hfder9qmp20lp55u9a8azlnddknes2w239pzqej76se", value: 9999979 } }],
  vout: [{ scriptpubkey_address: "ltc1qrx8z2xatcuzjpl4gts5666juhq83qd9zq6mkyf", value: 9999817 }],
};

describe("esploraTxToChainTx", () => {
  it("a swap payout reads as incoming, with a signed net", () => {
    const row = esploraTxToChainTx(PAYOUT, "ltc1qrx8z2xatcuzjpl4gts5666juhq83qd9zq6mkyf", "litecoin");
    expect(row).toMatchObject({
      hash: PAYOUT.txid,
      direction: "in",
      amount: "0.09999817",
      height: 3179459,
      timestamp: 1789649503,
      fee: undefined,
    });
    expect(row.meta?.netSat).toBe(9999817);
  });

  it("a spend reads as outgoing with the external output as counterparty", () => {
    const tx = {
      txid: "8b75e0fc",
      fee: 250,
      status: { confirmed: true },
      vin: [{ prevout: { scriptpubkey_address: "me", value: 232246115 } }],
      vout: [
        { scriptpubkey_address: "fee", value: 49999 },
        { scriptpubkey_address: "change", value: 232195866 },
      ],
    };
    const row = esploraTxToChainTx(tx, "me", "litecoin");
    expect(row).toMatchObject({ direction: "out", amount: "2.32246115", fee: "0.00000250", counterparty: "fee" });
    expect(row.meta?.netSat).toBe(-232246115);
  });

  it("an unconfirmed tx is pending", () => {
    const row = esploraTxToChainTx({ ...PAYOUT, status: { confirmed: false } }, "ltc1qrx8z2xatcuzjpl4gts5666juhq83qd9zq6mkyf", "litecoin");
    expect(row.direction).toBe("pending");
    expect(row.confirmations).toBe(0);
  });
});
