/**
 * TRC-20 token adapters — the Tron half of the stablecoin registry.
 *
 * USDT on Tron is one of the most-used stablecoin legs in existence and the
 * wallet had no TRC-20 reader at all: Tron was native-TRX only, so a user
 * holding USDT-TRC20 saw nothing.
 *
 * # Key material
 *
 * Delegates to `trxAdapter` — the TRC-20 holder IS the Tron account, so a
 * token leg must never derive its own key. Tron addresses are secp256k1 like
 * Ethereum's, re-encoded base58check; `trx-wallet.ts` owns that conversion and
 * this file reuses it rather than repeating it.
 *
 * # Reading a balance
 *
 * `triggerconstantcontract` with `balanceOf(address)` — the read-only variant,
 * so it costs no bandwidth/energy and needs no signature. The single ABI
 * argument is a 32-byte left-padded hex address WITHOUT the `41` Tron prefix,
 * which is the one detail that silently returns zero when you get it wrong:
 * Tron hex addresses are 21 bytes (`41` + 20), and the ABI wants the trailing
 * 20.
 *
 * # Sending
 *
 * `triggersmartcontract` with `transfer(address,uint256)` builds an unsigned
 * tx server-side; we sign its `txID` with the same secp256k1 path
 * `trxAdapter.sendTransaction` already uses for native TRX, then broadcast.
 * Keeping the signing identical to the native path is deliberate — one
 * signature convention (r ‖ s ‖ v-27) to be right about, not two.
 *
 * `fee_limit` is required and is a CAP, not a charge: unused energy is not
 * consumed. 100 TRX is the conventional ceiling for a TRC-20 transfer to an
 * address that has never held the token (which costs materially more energy
 * than one that has). Too low is the common cause of `OUT_OF_ENERGY`.
 */
import { ethers } from "ethers";
import type {
  ChainAdapter,
  ChainType,
  FeeEstimate,
  GasBudget,
  NetworkInfo,
  TxHistoryPage,
  TxParties,
  TxResult,
} from "./types";
import {
  trxAdapter,
  tronFetch,
  broadcastTronTransaction,
  ethAddressToTron,
  hexToTronAddress,
  isTronAddress,
  readTronBalanceSun,
  tronAddressToHex,
  tronNodeMessage,
  waitForTronExecution,
  TRON_HISTORY_SOURCES,
} from "./trx-wallet";
import { fetchTrc20History, fetchTrc20Parties } from "./tron-history";
import { verifyTronTransaction } from "./tron-tx-verify";
import { atomicToDecimalString, decimalStringToAtomic } from "./spl-token-wallet";

/**
 * Tron hex address (`41` + 20 bytes) → 32-byte ABI word. Throws on anything
 * that is not a TRON address: the ABI word drops the version byte, so a
 * Bitcoin `1…` address (also 21-byte base58check) used to encode into a
 * transfer to a TRON account nobody controls (2026-09-29).
 */
export function addressToAbiWord(tronAddress: string): string {
  const hex = tronAddressToHex(tronAddress);
  const noPrefix = hex.startsWith("41") ? hex.slice(2) : hex;
  return noPrefix.toLowerCase().padStart(64, "0");
}

function uint256Word(v: bigint): string {
  return v.toString(16).padStart(64, "0");
}

// ─── What a transfer costs in TRX (2026-09-29) ────────────────────────────
//
// A TRC-20 transfer burns TRX for ENERGY (the contract's execution) and
// BANDWIDTH (the transaction's bytes) unless the account has staked or free
// resources to cover them. It is paid in TRX, not in the token, so an account
// holding only USDT cannot send it — and before this date the wallet let it
// try: the transfer was built, broadcast, and ran out of energy on chain.

/** Energy for `transfer()` to an address that has never held the token: a
 *  fresh storage slot, the dear case. Measured 2026-09-29 by constant call
 *  from a live USDT holder: 130,285 to a new address, 64,285 to a holder
 *  (both including the contract's dynamic-energy penalty). Used only while
 *  there is no recipient to simulate. */
const NEW_HOLDER_ENERGY = 131_000n;
/** Bytes a signed TRC-20 transfer puts on the wire, for bandwidth (≈345). */
const TRC20_TX_BYTES = 350n;

const max0 = (v: bigint) => (v > 0n ? v : 0n);

/** Sun as TRX, rounded UP to 0.01 — a requirement must not read smaller than it is. */
function trxText(sun: bigint, roundUp = false): string {
  const step = 10_000n;
  const v = roundUp && sun % step !== 0n ? sun - (sun % step) + step : sun;
  return ethers.formatUnits(v, 6);
}

interface TronPrices {
  energySun: bigint;
  bandwidthSun: bigint;
}
let pricesCache: { v: TronPrices; at: number } | null = null;

/** Energy and bandwidth prices. Changed by governance vote, so cached 10 min. */
async function tronPrices(): Promise<TronPrices> {
  if (pricesCache && Date.now() - pricesCache.at < 10 * 60_000) return pricesCache.v;
  const resp = await tronFetch(`/wallet/getchainparameters`);
  const params: Array<{ key: string; value?: number }> =
    (await resp.json())?.chainParameter ?? [];
  const value = (k: string) => params.find((p) => p.key === k)?.value;
  const energy = value("getEnergyFee");
  const bandwidth = value("getTransactionFee");
  if (!energy || !bandwidth) throw new Error("TRON chain parameters unavailable");
  const v = { energySun: BigInt(energy), bandwidthSun: BigInt(bandwidth) };
  pricesCache = { v, at: Date.now() };
  return v;
}

interface TronAccountState {
  balanceSun: bigint;
  energyFree: bigint;
  bandwidthFree: bigint;
}
const accountCache = new Map<string, { v: TronAccountState; at: number }>();

/**
 * TRX balance plus unspent energy and bandwidth. Cached 15 s per address:
 * the Send modal asks on every keystroke, and TronGrid suspends a keyless
 * client for 5 s past 3 requests a second.
 *
 * The balance comes from `readTronBalanceSun`, whose TronStack fallback asks
 * `/wallet/getaccount`. Until 2026-09-29 this read `/v1/accounts` from both
 * hosts, TronStack answers that path 404, and a TronGrid 429 turned the check
 * below into "unknown" — which the send then went ahead on.
 */
async function tronAccountState(address: string, fresh: boolean): Promise<TronAccountState> {
  const hit = accountCache.get(address);
  if (!fresh && hit && Date.now() - hit.at < 15_000) return hit.v;
  const [balanceSun, resResp] = await Promise.all([
    readTronBalanceSun(address),
    tronFetch(`/wallet/getaccountresource`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, visible: true }),
    }),
  ]);
  const res = await resResp.json();
  if (!res || typeof res !== "object" || res.Error) throw new Error("TRON account lookup failed");
  const n = (x: unknown) => BigInt(typeof x === "number" ? Math.trunc(x) : 0);
  const v: TronAccountState = {
    balanceSun,
    energyFree: max0(n(res.EnergyLimit) - n(res.EnergyUsed)),
    bandwidthFree:
      max0(n(res.freeNetLimit) - n(res.freeNetUsed)) + max0(n(res.NetLimit) - n(res.NetUsed)),
  };
  accountCache.set(address, { v, at: Date.now() });
  return v;
}

const energyCache = new Map<string, { v: bigint | null; at: number }>();

/**
 * Energy this exact transfer would use, by constant call — nothing signed or
 * broadcast. `null` when the call would revert (an amount above the token
 * balance, say): a reverted simulation's energy is not the transfer's.
 * Cached a minute per (token, sender, recipient); the amount barely moves it.
 */
async function simulateTransferEnergy(
  contract: string,
  owner: string,
  to: string,
  atomic: bigint,
): Promise<bigint | null> {
  const key = `${contract}|${owner}|${to}`;
  const hit = energyCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const resp = await tronFetch(`/wallet/triggerconstantcontract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      owner_address: owner,
      contract_address: contract,
      function_selector: "transfer(address,uint256)",
      parameter: addressToAbiWord(to) + uint256Word(atomic > 0n ? atomic : 1n),
      visible: true,
    }),
  });
  const data = await resp.json();
  const reverted =
    !!data?.Error ||
    data?.result?.result !== true ||
    data?.transaction?.ret?.[0]?.ret === "FAILED";
  const v = reverted || !data?.energy_used ? null : BigInt(data.energy_used);
  energyCache.set(key, { v, at: Date.now() });
  return v;
}

/**
 * Can `address` pay, in TRX, for a TRC-20 transfer? `requiredSun` is what the
 * transfer would burn after spending the account's free/staked energy and
 * bandwidth; `null` when the prices or the account could not be read.
 * `accountRead` says whether the account itself was.
 */
async function trc20Budget(
  contract: string,
  decimals: number,
  address: string,
  opts: { to?: string; amount?: string } | undefined,
  fresh: boolean,
): Promise<{ budget: GasBudget; requiredSun: bigint | null; accountRead: boolean }> {
  const base = { ticker: "TRX", chainName: "TRON", includesAmount: false };
  let state: TronAccountState;
  try {
    state = await tronAccountState(address, fresh);
  } catch (e) {
    // Unknown is not zero: say nothing rather than "you have no TRX".
    console.warn("[trc20] account read failed:", e);
    return {
      budget: { ...base, available: "0", required: null, sufficient: null },
      requiredSun: null,
      accountRead: false,
    };
  }
  let requiredSun: bigint | null = null;
  try {
    const prices = await tronPrices();
    let energy = NEW_HOLDER_ENERGY;
    const to = opts?.to?.trim();
    if (to && isTronAddress(to)) {
      let atomic = 1n;
      try {
        if (opts?.amount?.trim()) atomic = decimalStringToAtomic(opts.amount.trim(), decimals);
      } catch {
        /* unparsable amount: size the simulation at one unit */
      }
      const simulated = await simulateTransferEnergy(contract, address, to, atomic);
      if (simulated !== null) energy = simulated;
    }
    const energyBurn = max0(energy - state.energyFree) * prices.energySun;
    const bandwidthBurn =
      state.bandwidthFree >= TRC20_TX_BYTES ? 0n : TRC20_TX_BYTES * prices.bandwidthSun;
    requiredSun = energyBurn + bandwidthBurn;
  } catch (e) {
    console.warn("[trc20] energy estimate failed:", e);
  }
  const sufficient =
    requiredSun !== null
      ? state.balanceSun >= requiredSun
      : state.balanceSun === 0n
        ? false
        : null;
  return {
    budget: {
      ...base,
      available: trxText(state.balanceSun),
      required: requiredSun !== null ? trxText(requiredSun, true) : null,
      sufficient,
    },
    requiredSun,
    accountRead: true,
  };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Energy ceiling for a TRC-20 transfer, in SUN. A cap, not a charge. */
const FEE_LIMIT_SUN = 100_000_000;

export interface Trc20AdapterConfig {
  chain: ChainType;
  displayName: string;
  ticker: string;
  color: string;
  /** TRC-20 contract, base58 (T…). Verified on chain via `symbol()`/`decimals()`. */
  contract: string;
  decimals: number;
}

export function createTrc20Adapter(cfg: Trc20AdapterConfig): ChainAdapter {
  return {
    chain: cfg.chain,
    displayName: cfg.displayName,
    ticker: cfg.ticker,
    color: cfg.color,
    addressPlaceholder: "T...",
    // A TRC-20 leg is held by the TRX account itself, so the derivation that
    // matters is Tron's: Pwnda's default reuses the EVM key (coin type 60).
    // Corrected 2026-09-29 — this called 60 a "TronLink quirk"; TronLink uses
    // TRX's own 195. When a derivation choice moves TRON off the default, the
    // vault moves this leg with it (`tokenLegsHeldBy`).
    derivation: {
      kind: "bip39",
      path: "m/44'/60'/0'/0/0",
      standard: "the EVM key (ETH coin type 60), which Pwnda reuses for TRON. TronLink and Ledger use TRX's own coin type 195, so their seeds show a different TRON address here",
      hasAlternatives: true,
    },

    // Fees are paid in TRX (energy + bandwidth), never in the token.
    gasToken: { ticker: "TRX", chainName: "TRON" },

    async getGasBudget(address: string, opts?: { to?: string; amount?: string }) {
      return (await trc20Budget(cfg.contract, cfg.decimals, address, opts, false)).budget;
    },

    importFromMnemonic: (m: string) => ({
      ...trxAdapter.importFromMnemonic(m),
      chain: cfg.chain,
    }),
    deriveFromMnemonic: (m: string) => ({
      ...trxAdapter.deriveFromMnemonic(m),
      chain: cfg.chain,
    }),
    importFromPrivateKey: (k: string) => ({
      ...trxAdapter.importFromPrivateKey(k),
      chain: cfg.chain,
    }),

    async getBalance(address: string): Promise<string> {
      const resp = await tronFetch(`/wallet/triggerconstantcontract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner_address: address,
          contract_address: cfg.contract,
          function_selector: "balanceOf(address)",
          parameter: addressToAbiWord(address),
          visible: true,
        }),
      });
      if (!resp.ok) throw new Error(`${cfg.ticker} balance lookup failed`);
      const data = await resp.json();
      const word: string | undefined = data?.constant_result?.[0];
      if (!word) {
        // An empty `constant_result` with a `result.message` is the contract
        // reverting, not an empty balance — surface it instead of showing 0.
        const msg = data?.result?.message;
        throw new Error(
          msg
            ? `${cfg.ticker}: ${Buffer.from(msg, "hex").toString("utf8")}`
            : `${cfg.ticker}: empty balanceOf response`,
        );
      }
      return atomicToDecimalString(BigInt("0x" + word), cfg.decimals);
    },

    async sendTransaction(
      privateKey: string,
      to: string,
      amount: string,
    ): Promise<TxResult> {
      const wallet = new ethers.Wallet(privateKey.trim());
      const from = ethAddressToTron(wallet.address);
      const recipient = to.trim();
      // Before anything else: the ABI word below drops the address's version
      // byte, so a non-TRON address would encode into a transfer to a TRON
      // account nobody controls.
      if (!isTronAddress(recipient)) {
        throw new Error(
          `"${recipient}" is not a TRON address. ${cfg.ticker} on TRON can only be sent to a TRON address (T…).`,
        );
      }
      const atomic = decimalStringToAtomic(amount, cfg.decimals);
      if (atomic <= 0n) throw new Error("Amount must be greater than zero.");

      // Refuse before building when this account definitely cannot pay the
      // TRX the transfer burns. Fresh read: this is the decision, not a hint.
      const { budget, requiredSun, accountRead } = await trc20Budget(
        cfg.contract,
        cfg.decimals,
        from,
        { to: recipient, amount },
        true,
      );
      if (budget.sufficient === false) {
        throw new Error(
          budget.required
            ? `Sending ${cfg.ticker} on TRON burns about ${budget.required} TRX for energy and bandwidth, ` +
                `and this address has ${budget.available} TRX. Add TRX first — a transfer that runs out ` +
                `of energy still burns what it used.`
            : `This address has no TRX to pay for the transfer's energy. Add TRX first.`,
        );
      }
      // An unanswered check is not a passed one (2026-09-29 send-safety
      // audit). The Send modal may say "unknown"; the send itself must not go
      // ahead on it, or a transfer this account cannot pay for is built,
      // broadcast, and runs out of energy — burning the TRX it used.
      if (!accountRead || requiredSun === null) {
        throw new Error(
          `Could not check that this address can pay the TRX a ${cfg.ticker} transfer burns for ` +
            `energy — the TRON API did not answer. Nothing was sent; try again in a moment.`,
        );
      }
      if (requiredSun > BigInt(FEE_LIMIT_SUN)) {
        throw new Error(
          `This transfer would burn about ${trxText(requiredSun, true)} TRX, above the ` +
            `${trxText(BigInt(FEE_LIMIT_SUN))} TRX fee limit — it would run out of energy. Try again later.`,
        );
      }

      const parameter = addressToAbiWord(recipient) + uint256Word(atomic);
      const createResp = await tronFetch(`/wallet/triggersmartcontract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner_address: from,
          contract_address: cfg.contract,
          function_selector: "transfer(address,uint256)",
          parameter,
          fee_limit: FEE_LIMIT_SUN,
          call_value: 0,
          visible: true,
        }),
      });
      if (!createResp.ok) throw new Error(`Failed to build ${cfg.ticker} transfer`);
      const built = await createResp.json();
      if (built?.result?.result !== true || !built?.transaction) {
        const msg = tronNodeMessage(built?.result?.message) || tronNodeMessage(built?.Error);
        throw new Error(
          msg ? `${cfg.ticker} transfer rejected: ${msg}` : `${cfg.ticker} transfer could not be built`,
        );
      }

      const txData = built.transaction;
      // Sign only the transfer we asked for (see `tron-tx-verify.ts`).
      verifyTronTransaction(txData, {
        kind: "trc20",
        ownerHex: tronAddressToHex(from),
        contractHex: tronAddressToHex(cfg.contract),
        data: "a9059cbb" + parameter,
        maxFeeLimitSun: BigInt(FEE_LIMIT_SUN),
      });
      const signingKey = new ethers.SigningKey(privateKey.trim());
      const signature = signingKey.sign(hexToBytes(txData.txID));
      txData.signature = [
        signature.r.slice(2) +
          signature.s.slice(2) +
          (signature.v === 27 ? "00" : "01"),
      ];

      // DUP_TRANSACTION_ERROR for this id is acceptance, and an answer that
      // never came is looked up by id (`broadcastTronTransaction`).
      const outcome = await broadcastTronTransaction(txData, cfg.ticker);
      accountCache.delete(from);
      // Already seen executed (the uncertain-broadcast path looked it up).
      if (outcome === "confirmed") return { hash: txData.txID };
      // Accepted into a pool is not executed. Wait for the block and throw if
      // the transfer failed in it (OUT_OF_ENERGY, REVERT). Nothing known yet
      // after the wait is not a failure: "submitted, not confirmed".
      const executed = await waitForTronExecution(txData.txID);
      return executed === "pending"
        ? { hash: txData.txID, pending: true }
        : { hash: txData.txID };
    },

    async getNetworkInfo(): Promise<NetworkInfo> {
      return trxAdapter.getNetworkInfo();
    },

    /**
     * TronGrid, then TronScan (`tron-history.ts`). The fallback used to be
     * TronStack's `/v1/*` through `tronFetch`, which is always 404 (operator
     * report 2026-09-30). Failures still throw: until 2026-09-29 a failure
     * became an empty list, indistinguishable from "no transfers".
     */
    async getTransactionHistory(
      address: string,
      opts?: { limit?: number; cursor?: string },
    ): Promise<TxHistoryPage> {
      return fetchTrc20History(
        { chain: cfg.chain, ticker: cfg.ticker, contract: cfg.contract, decimals: cfg.decimals },
        address,
        opts,
        TRON_HISTORY_SOURCES,
      );
    },

    /**
     * The token transfer's sender and recipient, by txid — not the
     * transaction's `to`, which is the token contract. TronGrid's
     * `gettransactioninfobyid` logs, then TronScan (`tron-history.ts`).
     */
    async getTransactionParties(hash: string, ownAddress: string): Promise<TxParties | null> {
      return fetchTrc20Parties(
        {
          chain: cfg.chain,
          ticker: cfg.ticker,
          contract: cfg.contract,
          decimals: cfg.decimals,
          contractHex: tronAddressToHex(cfg.contract),
        },
        hash,
        ownAddress,
        TRON_HISTORY_SOURCES,
        hexToTronAddress,
      );
    },

    async getFeeEstimate(): Promise<FeeEstimate> {
      // Energy, not a fixed fee. Reported as the CAP so the number on screen
      // is the worst case rather than a guess that will be wrong either way.
      return {
        normal: { value: "≤ 100", eta: "≈ 3 s" },
        unit: "TRX (energy cap)",
        fetchedAt: Date.now(),
      };
    },
  } as ChainAdapter;
}

// ── Shipped TRC-20 leg. Verified on chain: symbol() = "USDT", decimals() = 6.
export const usdtTronAdapter = createTrc20Adapter({
  chain: "usdt-tron",
  displayName: "USDT (Tron)",
  ticker: "USDT",
  color: "#26a17b",
  contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  decimals: 6,
});
