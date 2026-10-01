/**
 * Both sides of every transaction in the details (2026-09-30).
 *
 * The operator's request: "in the info I can see which address each
 * transaction was sent and received from respectively". The details showed a
 * "from" or "to" only when the history row happened to name it: a Dash
 * receipt from BlockCypher, a Solana row, a Sui row — no sender at all, and
 * nothing saying why. Now each side lists every address it can, the wallet's
 * marked, fills a missing side from the chain (`getTransactionParties`, read
 * once when the details open), and says why a side is blank when it is.
 *
 * Addresses and hashes are invented.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChainTx, TxParties } from "../../wallets/types";
import { txDetailsModel } from "./TxDetails";
import { clearTxPartiesCache, readTxParties } from "../../lib/txParties";
import { getAdapter } from "../../wallets";
import type { TxPartiesState } from "../../lib/txParties";

const done = (parties: TxParties | null): TxPartiesState => ({ status: "done", parties });

describe("a side the row does not name", () => {
  // A Dash receipt as BlockCypher's txrefs give it: no addresses at all.
  const dashIn: ChainTx = {
    chain: "dash",
    hash: "d1".repeat(32),
    direction: "in",
    amount: "0.5",
    timestamp: 1_790_000_000,
    height: 2_300_000,
    meta: { netSat: 50_000_000 },
  };
  const OWN = "XownDashAddressInvented00000000000";
  const SENDER = "XsenderDashAddressInvented000000000";

  it("asks the chain, and says so while it reads", () => {
    const m = txDetailsModel(dashIn, { ownAddress: OWN, parties: { status: "loading" } });
    expect(m.needsParties).toBe(true);
    expect(m.from).toEqual([]);
    expect(m.fromNote).toBe("Reading the sender from Dash…");
  });

  it("fills both sides from what the chain said (inputs and every output)", () => {
    const m = txDetailsModel(dashIn, {
      ownAddress: OWN,
      parties: done({ from: [SENDER], to: [OWN, "XsendersChangeInvented0000000000000"], source: "api.blockcypher.com" }),
    });
    expect(m.from).toEqual([{ address: SENDER, you: false }]);
    expect(m.to).toEqual([
      { address: OWN, you: true },
      { address: "XsendersChangeInvented0000000000000", you: false },
    ]);
    expect(m.fromNote).toBeNull();
    expect(m.source).toBe("api.blockcypher.com");
  });

  it("a failed read and an unknown transaction each say what happened", () => {
    const failed = txDetailsModel(dashIn, { ownAddress: OWN, parties: { status: "error", message: "HTTP 503 from api.blockcypher.com" } });
    expect(failed.fromNote).toBe("Could not read the sender: HTTP 503 from api.blockcypher.com");
    const unknown = txDetailsModel(dashIn, { ownAddress: OWN, parties: done(null) });
    expect(unknown.fromNote).toBe("Dash does not show this transaction yet.");
  });

  it("with no reader for the chain, it says the explorer has it", () => {
    const m = txDetailsModel({ ...dashIn, chain: "not-a-chain" as ChainTx["chain"] }, { ownAddress: OWN });
    expect(m.fromNote).toBe("This chain's history does not name the sender. The explorer shows it.");
  });
});

describe("a Monero receipt: the protocol hides the sender", () => {
  const xmrIn: ChainTx = { chain: "monero", hash: "aa".repeat(32), direction: "in", amount: "1.2", timestamp: 1_790_000_000 };

  it("says the sender is hidden, and does not ask the chain for it", () => {
    const m = txDetailsModel(xmrIn, { ownAddress: "4OwnMoneroInvented" });
    expect(m.from).toEqual([]);
    expect(m.fromNote).toBe("Hidden: Monero does not reveal who sent a transaction.");
    expect(m.to).toEqual([{ address: "4OwnMoneroInvented", you: true }]);
    expect(m.needsParties).toBe(false);
  });
});

describe("an SPL row the list could not read", () => {
  // `pending` with a block: the SPL list does not say which way or how much.
  const spl: ChainTx = { chain: "usdc-sol", hash: "5pL1nVented", direction: "pending", amount: "", height: 300_000_000, timestamp: 1_790_000_000 };
  const ME = "MeSolanaInvented1111111111111111111111111111";
  const THEM = "ThemSolanaInvented111111111111111111111111111";

  it("asks the chain, then shows the direction, amount and both sides it read", () => {
    expect(txDetailsModel(spl, { ownAddress: ME }).needsParties).toBe(true);
    const m = txDetailsModel(spl, {
      ownAddress: ME,
      parties: done({ from: [ME], to: [THEM], direction: "out", amount: "12.5", fee: "0.000005" }),
    });
    expect(m.directionLabel).toBe("▲ sent");
    expect(m.amount).toBe("12.5");
    expect(m.from).toEqual([{ address: ME, you: true }]);
    expect(m.to).toEqual([{ address: THEM, you: false }]);
  });
});

describe("rows that already name both sides", () => {
  it("a self-transfer went from the wallet to the wallet", () => {
    const self: ChainTx = { chain: "xrp", hash: "AB".repeat(32), direction: "self", amount: "0", height: 5 };
    const m = txDetailsModel(self, { ownAddress: "rOwnInvented" });
    expect(m.from).toEqual([{ address: "rOwnInvented", you: true }]);
    expect(m.to).toEqual([{ address: "rOwnInvented", you: true }]);
  });

  it("an XRP receipt names its sender from the row, without asking", () => {
    const xrpIn: ChainTx = { chain: "xrp", hash: "CD".repeat(32), direction: "in", amount: "1", height: 7, counterparty: "rSenderInvented" };
    const m = txDetailsModel(xrpIn, { ownAddress: "rOwnInvented" });
    expect(m.from).toEqual([{ address: "rSenderInvented", you: false }]);
    expect(m.needsParties).toBe(false);
  });
});

describe("a Hedera row: the wallet's account id is its own side (2026-10-01)", () => {
  // The wallet's address is its PUBLIC KEY; the row and the chain name
  // account ids. Without `meta.ownAccountId` nothing on either side was "you".
  const PUBKEY = "0x" + "2e".repeat(32);
  const ME = "0.0.3229";
  const THEM = "0.0.3230";
  const row: ChainTx = {
    chain: "hedera",
    hash: `${THEM}-1789999999-000000001`,
    direction: "in",
    amount: "1.00000000",
    timestamp: 1_790_000_000,
    counterparty: THEM,
    meta: { name: "CRYPTOTRANSFER", result: "SUCCESS", ownAccountId: ME, from: [THEM], to: [ME] },
  };

  it("marks the account id the row names as the wallet's", () => {
    const m = txDetailsModel(row, { ownAddress: PUBKEY });
    expect(m.from).toEqual([{ address: THEM, you: false }]);
    expect(m.to).toEqual([{ address: ME, you: true }]);
    expect(m.needsParties).toBe(false);
  });

  it("and in what the chain said, when the details had to ask", () => {
    const failed: ChainTx = { ...row, direction: "failed", meta: { ownAccountId: ME } };
    const m = txDetailsModel(failed, { ownAddress: PUBKEY, parties: done({ from: [ME], to: [] }) });
    expect(m.from).toEqual([{ address: ME, you: true }]);
  });
});

describe("readTxParties: one read per transaction, answers kept for the session", () => {
  afterEach(() => {
    clearTxPartiesCache();
    vi.restoreAllMocks();
  });

  it("caches a found answer; a not-found or a failure is asked again", async () => {
    const adapter = getAdapter("xrp") as unknown as { getTransactionParties?: unknown };
    const read = vi.fn(async () => ({ from: ["rA"], to: ["rB"] }) as TxParties);
    const had = adapter.getTransactionParties;
    adapter.getTransactionParties = read;
    try {
      await readTxParties("xrp", "EF".repeat(32), "rB");
      await readTxParties("xrp", "ef".repeat(32), "rB"); // same hex hash, other case
      expect(read).toHaveBeenCalledTimes(1);

      // Another wallet asking about the same transaction gets its own read:
      // for some readers (SPL direction, token legs) the answer depends on it.
      await readTxParties("xrp", "EF".repeat(32), "rOtherWallet");
      expect(read).toHaveBeenCalledTimes(2);

      read.mockResolvedValueOnce(null as unknown as TxParties);
      await readTxParties("xrp", "01".repeat(32), "rB");
      await readTxParties("xrp", "01".repeat(32), "rB");
      expect(read).toHaveBeenCalledTimes(4);
    } finally {
      adapter.getTransactionParties = had;
    }
  });
});
