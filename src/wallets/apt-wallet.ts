/**
 * Aptos (APT) ChainAdapter.
 *
 * # Derivation — verified two ways, not assumed
 *
 * Path `m/44'/637'/0'/0'/0'` (SLIP-0010 ed25519, every segment hardened), address =
 * `sha3_256(publicKey || 0x00)`. The trailing `0x00` is Aptos's single-ed25519 scheme
 * byte; other schemes (multi-ed25519 `0x01`, single-key `0x02`) hash differently, so
 * it is load-bearing, not padding.
 *
 * Both facts were confirmed on 2026-09-02 by deriving the standard BIP39 test
 * mnemonic through `@aptos-labs/ts-sdk` AND independently through the libraries this
 * repo already uses (`ed25519-hd-key` + `@noble/hashes` sha3), and checking the two
 * agree byte-for-byte:
 *
 *   both -> 0xeb663b681209e7087d681c5d3eed12aaa8e1915e7c87794542c3f96e94b3d3bf
 *
 * That agreement is why derivation here does NOT use the SDK: it needs nothing the
 * repo lacks, and keeping it dependency-free means `deriveAllChains` — which runs on
 * every unlock — never pulls 6.35 MB into the main bundle. The SDK is `await import`ed
 * only inside `sendTransaction`.
 *
 * # An Aptos account does not exist until it is funded
 *
 * Like Hedera, an address is derivable offline but has no on-chain account until it
 * receives something. `getBalance` reports `0` for that case rather than erroring —
 * the address is valid and can receive; there is simply nothing there yet.
 */
import { derivePath } from "ed25519-hd-key";
import { mnemonicToSeedSync } from "@scure/bip39";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha3_256 } from "@noble/hashes/sha3.js";
import { decimalToAtomic, atomicToDecimal } from "./decimal-amount";
import type {
  ChainAdapter,
  WalletInfo,
  TxResult,
  NetworkInfo,
  ChainTx,
  TxHistoryPage,
  FeeEstimate,
} from "./types";

const APTOS_API = "https://api.mainnet.aptoslabs.com/v1";

/** APT has 8 decimal places; the atomic unit is the octa. */
export const APT_DECIMALS = 8;

/** Petra / Pontem / Martian all use this path for account 0. */
export const APT_DEFAULT_PATH = "m/44'/637'/0'/0'/0'";

/**
 * Balance comes from a VIEW FUNCTION, not from reading a resource.
 *
 * The obvious implementation — GET the `0x1::coin::CoinStore<...AptosCoin>`
 * resource — is wrong on today's mainnet and would have reported **0 for
 * essentially every real account**. APT migrated to the Fungible Asset standard:
 * the balance now lives in an object-owned `FungibleStore` at a derived address,
 * which does not appear under `/accounts/{addr}/resources` at all. Checked
 * 2026-09-02 against four active mainnet senders: every one of them had exactly
 * one resource (`0x1::account::Account`) and no CoinStore, while
 * `0x1::coin::balance` returned 15570.50, 9595.41, 12745.98 and 31.53 APT.
 *
 * `0x1::coin::balance` is FA-aware and reports the UNION of any residual legacy
 * CoinStore and the migrated store, so it is correct across the migration in
 * both directions. `0x1::primary_fungible_store::balance` returns only the FA
 * half and read slightly LOW on two of the four accounts.
 */
const APT_BALANCE_VIEW = "0x1::coin::balance";

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Aptos account address for an ed25519 public key.
 *
 * `sha3_256(pubkey || 0x00)` — the scheme byte identifies single-ed25519. Aptos
 * addresses are 32 bytes rendered as `0x` + 64 hex characters; a "short" form with
 * leading zeros trimmed also exists on explorers, which is why comparisons here
 * always use the padded form.
 */
export function aptosAddressFromPublicKey(publicKey: Uint8Array): string {
  const authKey = sha3_256(Uint8Array.from([...publicKey, 0x00]));
  return "0x" + bytesToHex(authKey);
}

export function deriveAptFromMnemonic(
  mnemonic: string,
  path: string = APT_DEFAULT_PATH,
): { privateKey: Uint8Array; publicKey: Uint8Array; address: string } {
  const seed = mnemonicToSeedSync(mnemonic.trim());
  const { key } = derivePath(path, Buffer.from(seed).toString("hex"));
  const privateKey = new Uint8Array(key);
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey, address: aptosAddressFromPublicKey(publicKey) };
}

/** Normalise a user-supplied address to the padded 0x + 64-hex form. */
export function normalizeAptosAddress(address: string): string {
  const raw = address.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{1,64}$/.test(raw)) {
    throw new Error(`Invalid Aptos address: ${address}`);
  }
  return "0x" + raw.padStart(64, "0");
}

export const aptAdapter: ChainAdapter = {
  chain: "aptos",
  displayName: "Aptos",
  ticker: "APT",
  color: "#4ad4c4",
  addressPlaceholder: "0x...",
  derivation: {
    kind: "bip39",
    path: APT_DEFAULT_PATH,
    standard: "SLIP-0010 ed25519, every segment hardened — Petra/Martian form",
    hasAlternatives: false,
  },

  deriveFromMnemonic(mnemonic: string, choice?: string): WalletInfo {
    const { privateKey, address } = deriveAptFromMnemonic(
      mnemonic,
      choice && choice.startsWith("m/") ? choice : APT_DEFAULT_PATH,
    );
    return {
      chain: "aptos",
      address,
      mnemonic: mnemonic.trim(),
      privateKey: bytesToHex(privateKey),
    };
  },

  importFromMnemonic(mnemonic: string): WalletInfo {
    return this.deriveFromMnemonic(mnemonic);
  },

  importFromPrivateKey(privateKey: string): WalletInfo {
    const key = Uint8Array.from(
      Buffer.from(privateKey.trim().replace(/^0x/, ""), "hex"),
    );
    if (key.length !== 32) {
      throw new Error("An Aptos private key is 32 bytes (64 hex characters).");
    }
    const publicKey = ed25519.getPublicKey(key);
    return {
      chain: "aptos",
      address: aptosAddressFromPublicKey(publicKey),
      mnemonic: "",
      privateKey: bytesToHex(key),
    };
  },

  async getBalance(address: string): Promise<string> {
    const r = await fetch(`${APTOS_API}/view`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        function: APT_BALANCE_VIEW,
        type_arguments: ["0x1::aptos_coin::AptosCoin"],
        arguments: [normalizeAptosAddress(address)],
      }),
    });
    // An account that has never been funded does not exist on-chain, and the
    // view aborts rather than returning zero. That is a genuine 0 — the address
    // is still valid to receive on. Any OTHER failure throws, so a node outage
    // is never rendered as an empty wallet.
    if (r.status === 400 || r.status === 404) return "0";
    if (!r.ok) throw new Error(`Aptos node HTTP ${r.status}`);
    const out = await r.json();
    return atomicToDecimal(BigInt(out?.[0] ?? 0), APT_DECIMALS);
  },

  async sendTransaction(
    privateKey: string,
    to: string,
    amount: string,
  ): Promise<TxResult> {
    // Lazy — keeps 6.35 MB out of the bundle for every user who never sends APT.
    const { Account, Aptos, AptosConfig, Ed25519PrivateKey, Network } = await import(
      "@aptos-labs/ts-sdk"
    );
    const octas = decimalToAtomic(amount, APT_DECIMALS, "APT amount");
    if (octas <= 0n) throw new Error("Amount must be greater than zero.");

    const aptos = new Aptos(new AptosConfig({ network: Network.MAINNET }));
    const signer = Account.fromPrivateKey({
      privateKey: new Ed25519PrivateKey("0x" + privateKey.replace(/^0x/, "")),
    });

    const transaction = await aptos.transaction.build.simple({
      sender: signer.accountAddress,
      data: {
        function: "0x1::aptos_account::transfer",
        functionArguments: [normalizeAptosAddress(to), octas],
      },
    });

    // `0x1::aptos_account::transfer` (not `0x1::coin::transfer`) because it
    // CREATES the destination account if it does not exist yet. `coin::transfer`
    // aborts on an unfunded destination, which is the common case for a first
    // send to a fresh wallet.
    const committed = await aptos.signAndSubmitTransaction({
      signer,
      transaction,
    });
    const result = await aptos.waitForTransaction({
      transactionHash: committed.hash,
    });
    if (result.success === false) {
      throw new Error(`Aptos transaction failed: ${result.vm_status ?? "unknown reason"}`);
    }
    return { hash: committed.hash };
  },

  async getNetworkInfo(): Promise<NetworkInfo> {
    try {
      const r = await fetch(APTOS_API);
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      return {
        label: "Ledger version",
        value: String(d.ledger_version ?? "—"),
        unit: "",
      };
    } catch {
      return { label: "Ledger version", value: "—", unit: "" };
    }
  },

  async getTransactionHistory(
    address: string,
    opts?: { limit?: number },
  ): Promise<TxHistoryPage> {
    const limit = opts?.limit ?? 25;
    const addr = normalizeAptosAddress(address);
    const r = await fetch(`${APTOS_API}/accounts/${addr}/transactions?limit=${limit}`);
    if (r.status === 404) return { items: [] };
    if (!r.ok) throw new Error(`Aptos node HTTP ${r.status}`);
    const rows: any[] = await r.json();

    const items: ChainTx[] = [];
    for (const t of Array.isArray(rows) ? rows : []) {
      if (t.type !== "user_transaction") continue;
      // Covers the legacy coin path AND the post-migration fungible-asset one:
      // `aptos_account::transfer`, `aptos_account::transfer_coins`,
      // `coin::transfer`, `primary_fungible_store::transfer`.
      const fn = String(t?.payload?.function ?? "");
      if (!/::(aptos_account|coin|primary_fungible_store)::transfer/.test(fn)) continue;
      const [dest, value] = t?.payload?.arguments ?? [];
      const outgoing =
        normalizeAptosAddress(String(t.sender ?? "0x0")) === addr;
      items.push({
        chain: "aptos",
        hash: String(t.hash ?? ""),
        direction: outgoing ? "out" : "in",
        amount: atomicToDecimal(BigInt(value ?? 0), APT_DECIMALS),
        fee: atomicToDecimal(
          BigInt(t.gas_used ?? 0) * BigInt(t.gas_unit_price ?? 0),
          APT_DECIMALS,
        ),
        // Aptos timestamps are MICROseconds since epoch, not milliseconds.
        timestamp: t.timestamp ? Math.floor(Number(t.timestamp) / 1_000_000) : undefined,
        height: t.version ? Number(t.version) : undefined,
        // The chain is instantly final: a transaction that appears here is
        // committed. Reported as 1 so the UI never labels it "unconfirmed".
        confirmations: t.success === false ? 0 : 1,
        counterparty: outgoing ? String(dest ?? "") : String(t.sender ?? ""),
      });
    }
    return { items };
  },

  async getFeeEstimate(): Promise<FeeEstimate> {
    try {
      const r = await fetch(`${APTOS_API}/estimate_gas_price`);
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      const price = BigInt(d.gas_estimate ?? 100);
      // A simple transfer costs on the order of 1000 gas units.
      return {
        normal: {
          value: atomicToDecimal(price * 1000n, APT_DECIMALS),
          eta: "≈ 1 s",
        },
        unit: "APT",
        fetchedAt: Date.now(),
      };
    } catch {
      return {
        normal: { value: "—", label: "Normal" } as any,
        unit: "APT",
        fetchedAt: Date.now(),
      };
    }
  },
};
