/**
 * Aptos history rows (2026-09-30).
 *
 * Found in the sandbox's Activity pass on the public test seed: a week-old
 * Aptos transaction sat at the top of the list and its details read
 * "▲ SENT −0.00005445 APT · STATUS unconfirmed · CONFIRMATIONS 0". The node
 * had answered `success: false` — the transfer aborted, only its gas was
 * paid — and the adapter mapped that to `confirmations: 0`, which the whole
 * UI reads as "waiting for a block" (`ChainTx`). The list's sort puts unmined
 * rows first, so every failed Aptos transaction was pinned there.
 *
 * 2026-10-01 (operator request): receipts. The history read only the
 * fullnode's list of what the account SENT, so no receipt ever showed — and
 * that list keeps only what the fullnode still holds (about two weeks; the
 * public test seed has sent 16 transactions and the list returned 2). The
 * indexer now says which transactions touched the account, and each is read
 * by version, from the archive node once the fullnode has pruned it. The
 * indexer answers below keep the live layout read for the public test seed.
 *
 * Addresses and hashes are invented; the row shape is the Aptos REST API's.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APTOS_TRANSFER_FUNCTIONS,
  aptAdapter,
  aptosHistoryRow,
  aptosIndexerEntries,
  aptosTransferOf,
  clearAptosHistoryCache,
  normalizeAptosAddress,
} from "./apt-wallet";

const ME = normalizeAptosAddress("0x" + "a1".repeat(32));
const THEM = normalizeAptosAddress("0x" + "b2".repeat(32));
const API = "https://api.mainnet.aptoslabs.com/v1";
const ARCHIVE = "https://archive.mainnet.aptoslabs.com/v1";

const transfer = (over: Record<string, unknown>) => ({
  type: "user_transaction",
  hash: "0x" + "00".repeat(31) + "01",
  sender: ME,
  success: true,
  vm_status: "Executed successfully",
  version: "7330657800",
  timestamp: "1790150810000000",
  gas_used: "11",
  gas_unit_price: "100",
  payload: { function: "0x1::aptos_account::transfer", arguments: [THEM, "5445"] },
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearAptosHistoryCache();
});

/** The fullnode's sent list is `rows`; the indexer knows nothing more. */
function stubNode(rows: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === `${API}/graphql`) {
        return new Response(JSON.stringify({ data: { account_transactions: [] } }), { status: 200 });
      }
      expect(url).toContain(`/accounts/${ME}/transactions`);
      return new Response(JSON.stringify(rows), { status: 200 });
    }),
  );
}

describe("Aptos history", () => {
  it("an aborted transaction is `failed`, committed, and never an unconfirmed send", async () => {
    stubNode([
      transfer({
        hash: "0x" + "00".repeat(31) + "02",
        success: false,
        vm_status: "Move abort in 0x1::coin: EINSUFFICIENT_BALANCE(0x10006)",
      }),
    ]);
    const [row] = (await aptAdapter.getTransactionHistory!(ME)).items;
    expect(row.direction).toBe("failed");
    // Committed: no count, its version as the block (a count of 1 read
    // "1 / 6 pending" in the details).
    expect(row.confirmations).toBeUndefined();
    expect(row.height).toBe(7330657800);
    expect(row.meta).toMatchObject({
      intended: "out",
      failure: "Move abort in 0x1::coin: EINSUFFICIENT_BALANCE(0x10006)",
    });
    // Its gas was still paid, by this wallet.
    expect(row.fee).toBe("0.000011");
  });

  it("a successful send keeps its direction and fee; a receipt carries no fee of ours", async () => {
    stubNode([
      transfer({}),
      // `coin::transfer` is generic over the coin, so the API always names it
      // (2026-09-30: the history now skips coins that are not APT).
      transfer({
        hash: "0x" + "00".repeat(31) + "03",
        // Its own version, older: every transaction has one, and the
        // history merges and orders by it (2026-10-01).
        version: "7330657799",
        sender: THEM,
        payload: { function: "0x1::coin::transfer", type_arguments: ["0x1::aptos_coin::AptosCoin"], arguments: [ME, "100000000"] },
      }),
    ]);
    const [sent, received] = (await aptAdapter.getTransactionHistory!(ME)).items;
    expect(sent).toMatchObject({ direction: "out", amount: "0.00005445", fee: "0.000011", counterparty: THEM });
    expect(received).toMatchObject({ direction: "in", amount: "1", counterparty: THEM });
    expect(received.fee).toBeUndefined();
    for (const r of [sent, received]) expect(r.confirmations).toBeUndefined();
  });
});

describe("Aptos history: receipts, and sends older than the fullnode keeps (2026-10-01)", () => {
  const FA_APT = "0x000000000000000000000000000000000000000000000000000000000000000a";
  const OTHER_FA = "0x" + "e2".repeat(32);
  const COIN_APT = "0x1::aptos_coin::AptosCoin";
  const gas = (amount: number, success = true) => ({
    type: "0x1::aptos_coin::GasFeeEvent",
    amount,
    asset_type: COIN_APT,
    is_gas_fee: true,
    is_transaction_success: success,
    entry_function_id_str: "0x1::aptos_account::transfer",
  });
  const act = (type: string, amount: number, asset_type = FA_APT, fn = "0x1::aptos_account::transfer") => ({
    type,
    amount,
    asset_type,
    is_gas_fee: false,
    is_transaction_success: true,
    entry_function_id_str: fn,
  });
  /** The live account_transactions layout (test seed, 2026-10-01), invented versions. */
  const indexed = (rows: Array<[number, unknown[]]>) => ({
    data: { account_transactions: rows.map(([v, acts]) => ({ transaction_version: v, fungible_asset_activities: acts })) },
  });
  const tx = (version: string, hashByte: string, sender: string, payload: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    transfer({ version, hash: "0x" + hashByte.repeat(32), sender, timestamp: `${Number(version)}000000`, payload, ...over });

  /** Routes: the sent list, the indexer, by_version on the fullnode and the archive. */
  function stubAptos(opts: {
    sent: unknown[] | number;
    indexer: unknown | number;
    fullnode?: Record<string, unknown>;
    archive?: Record<string, unknown>;
    oldestKept?: string;
  }) {
    const seen: string[] = [];
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        const url = String(u);
        seen.push(url);
        if (url === `${API}/graphql`) {
          return typeof opts.indexer === "number" ? reply(opts.indexer, { message: "down" }) : reply(200, opts.indexer);
        }
        if (url.startsWith(`${API}/accounts/${ME}/transactions`)) {
          return typeof opts.sent === "number" ? reply(opts.sent, { message: "down" }) : reply(200, opts.sent);
        }
        const byVersion = /\/transactions\/by_version\/(\d+)$/.exec(url);
        if (byVersion && url.startsWith(API)) {
          const t = opts.fullnode?.[byVersion[1]];
          if (t) return reply(200, t);
          return reply(410, {
            error_code: "version_pruned",
            message: `Ledger version(${byVersion[1]}) has been pruned`,
            oldest_ledger_version: opts.oldestKept ?? "7285432434",
            archival_endpoint: ARCHIVE,
          });
        }
        if (byVersion && url.startsWith(ARCHIVE)) {
          const t = opts.archive?.[byVersion[1]];
          return t ? reply(200, t) : reply(404, { message: "not found" });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    return seen;
  }

  it("a receipt now appears: the indexer lists it, and it is read by version", async () => {
    // Was: only the sent list was read, so the history had the send and
    // never the receipt that funded it.
    const send = tx("7318426323", "51", ME, { function: "0x1::aptos_account::transfer", arguments: [THEM, "7988200"] }, { gas_used: "63" });
    const receipt = tx("7318425670", "52", THEM, { function: "0x1::aptos_account::transfer", arguments: [ME, "8000000"] });
    const calls = stubAptos({
      sent: [send],
      indexer: indexed([
        [7318426323, [gas(6300), act("0x1::fungible_asset::Withdraw", 7988200)]],
        [7318425670, [act("0x1::fungible_asset::Deposit", 8000000)]],
      ]),
      fullnode: { "7318425670": receipt },
    });
    const items = (await aptAdapter.getTransactionHistory!(ME)).items;
    expect(items.map((i) => [i.direction, i.amount, i.counterparty])).toEqual([
      ["out", "0.079882", THEM],
      ["in", "0.08", THEM],
    ]);
    expect(items[1]).toMatchObject({ hash: "0x" + "52".repeat(32), height: 7318425670 });
    expect(items[1].fee).toBeUndefined();
    // The send came whole with the sent list; only the receipt was read by version.
    expect(calls.filter((u) => u.includes("/by_version/"))).toEqual([`${API}/transactions/by_version/7318425670`]);
  });

  it("a send the fullnode pruned from its sent list comes back, read from the archive the 410 names", async () => {
    const old = tx("7255245050", "53", ME, { function: "0x1::aptos_account::transfer", arguments: [THEM, "4988200"] });
    const older = tx("7255244540", "54", THEM, { function: "0x1::aptos_account::transfer", arguments: [ME, "5000000"] });
    const calls = stubAptos({
      sent: [],
      indexer: indexed([
        [7255245050, [gas(6300), act("0x1::fungible_asset::Withdraw", 4988200)]],
        [7255244540, [act("0x1::fungible_asset::Deposit", 5000000)]],
      ]),
      archive: { "7255245050": old, "7255244540": older },
    });
    const items = (await aptAdapter.getTransactionHistory!(ME)).items;
    expect(items.map((i) => [i.hash.slice(0, 4), i.direction, i.amount])).toEqual([
      ["0x53", "out", "0.049882"],
      ["0x54", "in", "0.05"],
    ]);
    const lookups = calls.filter((u) => u.includes("/by_version/"));
    // Refused by the fullnode (410, both in flight at once), read from the archive.
    expect(lookups.filter((u) => u.startsWith(ARCHIVE))).toHaveLength(2);

    // The 410 said what the fullnode keeps: an older version found on the
    // next read goes to the archive directly.
    const oldest = tx("6000000000", "58", THEM, { function: "0x1::aptos_account::transfer", arguments: [ME, "1"] });
    const next = stubAptos({
      sent: [],
      indexer: indexed([
        [7255245050, [gas(6300), act("0x1::fungible_asset::Withdraw", 4988200)]],
        [7255244540, [act("0x1::fungible_asset::Deposit", 5000000)]],
        [6000000000, [act("0x1::fungible_asset::Deposit", 1)]],
      ]),
      archive: { "6000000000": oldest },
    });
    expect((await aptAdapter.getTransactionHistory!(ME)).items).toHaveLength(3);
    expect(next.filter((u) => u.includes("/by_version/"))).toEqual([`${ARCHIVE}/transactions/by_version/6000000000`]);
  });

  it("each version is read once per session: the next poll reads only what is new", async () => {
    const receipt = tx("7318425670", "52", THEM, { function: "0x1::aptos_account::transfer", arguments: [ME, "8000000"] });
    const calls = stubAptos({
      sent: [],
      indexer: indexed([[7318425670, [act("0x1::fungible_asset::Deposit", 8000000)]]]),
      fullnode: { "7318425670": receipt },
    });
    await aptAdapter.getTransactionHistory!(ME);
    await aptAdapter.getTransactionHistory!(ME);
    expect(calls.filter((u) => u.includes("/by_version/"))).toHaveLength(1);
  });

  it("only transactions that moved this account's APT are read; a failed transfer it sent is one of them", async () => {
    const failedSend = tx(
      "7330657800",
      "55",
      ME,
      { function: "0x1::aptos_account::transfer", arguments: [THEM, "5445"] },
      { success: false, vm_status: "Move abort in 0x1::coin: EINSUFFICIENT_BALANCE(0x10006)", gas_used: "55" },
    );
    const calls = stubAptos({
      sent: [],
      indexer: indexed([
        // A failed send: only its gas moved.
        [7330657800, [gas(5500, false)]],
        // Another fungible asset, and a call that only paid gas: not APT rows.
        [7233122145, [gas(13400), act("0x1::fungible_asset::Withdraw", 1366611130, OTHER_FA, "0x1::aptos_account::transfer_fungible_assets")]],
        [4289147074, [{ ...gas(45500), entry_function_id_str: "0x5867::engage_management::register_action" }]],
      ]),
      fullnode: { "7330657800": failedSend },
    });
    const items = (await aptAdapter.getTransactionHistory!(ME)).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ direction: "failed", amount: "0.00005445", fee: "0.000055", meta: { intended: "out" } });
    expect(calls.filter((u) => u.includes("/by_version/"))).toEqual([`${API}/transactions/by_version/7330657800`]);
  });

  it("without the indexer the sent list is the answer; with neither, it throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = tx("7318426323", "51", ME, { function: "0x1::aptos_account::transfer", arguments: [THEM, "7988200"] });
    stubAptos({ sent: [send], indexer: 503 });
    const items = (await aptAdapter.getTransactionHistory!(ME)).items;
    expect(items.map((i) => i.direction)).toEqual(["out"]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/indexer could not be read/));
    stubAptos({ sent: 503, indexer: 503 });
    await expect(aptAdapter.getTransactionHistory!(ME)).rejects.toThrow(/Aptos history could not be read: Aptos node HTTP 503; the indexer: .*HTTP 503/);
  });

  it("a payout by another module (a swap, a bridge) is a receipt of what the indexer saw deposited", async () => {
    const swap = tx("7400000000", "56", THEM, { function: "0x" + "c7".repeat(32) + "::router::swap_exact_input", arguments: ["1"] });
    stubAptos({
      sent: [],
      indexer: indexed([[7400000000, [act("0x1::fungible_asset::Deposit", 250000000, FA_APT, "0xc7c7::router::swap_exact_input")]]]),
      fullnode: { "7400000000": swap },
    });
    const [row] = (await aptAdapter.getTransactionHistory!(ME)).items;
    expect(row).toMatchObject({ direction: "in", amount: "2.5", counterparty: THEM });
  });

  it("a transfer back to the sender itself is `self`, not a send", () => {
    // The public test seed has one (`transfer_coins`, 110 octas, 2026-02-09).
    const row = aptosHistoryRow(
      tx("4289126037", "57", ME, {
        function: "0x1::aptos_account::transfer_coins",
        type_arguments: ["0x1::aptos_coin::AptosCoin"],
        arguments: [ME, "110"],
      }),
      ME,
    );
    expect(row).toMatchObject({ direction: "self", amount: "0.0000011", counterparty: ME });
  });

  it("indexer entries: APT deposits counted, gas left out, the coin-era event and other assets told apart", () => {
    const entries = aptosIndexerEntries(
      indexed([
        [7318425670, [act("0x1::fungible_asset::Deposit", 8000000)]],
        [102146869, [act("0x1::coin::DepositEvent", 100000, COIN_APT)]],
        [7233016858, [act("0x1::fungible_asset::Deposit", 1366611130, OTHER_FA)]],
        [4289093626, [gas(129200)]],
      ]).data,
    );
    expect(entries).toEqual([
      { version: "7318425670", deposited: 8000000n, wanted: true },
      { version: "102146869", deposited: 100000n, wanted: true },
      { version: "7233016858", deposited: 0n, wanted: false },
      { version: "4289093626", deposited: 0n, wanted: false },
    ]);
    expect(() => aptosIndexerEntries([])).toThrow(/no account_transactions/);
  });

  it("the details' by-hash read asks the archive when the fullnode says 404 (it does for a pruned transaction)", async () => {
    const hash = "0x" + "60".repeat(32);
    const old = tx("7255244540", "60", THEM, { function: "0x1::aptos_account::transfer", arguments: [ME, "5000000"] });
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        seen.push(String(u));
        return String(u).startsWith(ARCHIVE)
          ? new Response(JSON.stringify(old), { status: 200 })
          : new Response(
              JSON.stringify({ message: `Transaction not found by Transaction hash(${hash})`, error_code: "transaction_not_found", vm_error_code: null }),
              { status: 404 },
            );
      }),
    );
    // Was: null, which the details showed as "Aptos does not show this
    // transaction yet" for anything older than about two weeks.
    expect(await aptAdapter.getTransactionParties!(hash, ME)).toEqual({
      from: [THEM],
      to: [ME],
      source: "archive.mainnet.aptoslabs.com",
    });
    expect(seen).toEqual([`${API}/transactions/by_hash/${hash}`, `${ARCHIVE}/transactions/by_hash/${hash}`]);
  });

  it("every function named for the indexer filter is one the payload reader reads", () => {
    for (const name of APTOS_TRANSFER_FUNCTIONS) {
      const batch = name.includes("batch");
      const fa = name.includes("fungible");
      const args = fa
        ? batch
          ? [{ inner: "0xa" }, [THEM], ["1"]]
          : [{ inner: "0xa" }, THEM, "1"]
        : batch
          ? [[THEM], ["1"]]
          : [THEM, "1"];
      const parsed = aptosTransferOf({ function: `0x1::${name}`, type_arguments: [COIN_APT], arguments: args });
      expect(parsed, name).not.toBeNull();
    }
  });
});
