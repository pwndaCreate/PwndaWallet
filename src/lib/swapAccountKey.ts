/**
 * The **account node** the swap engine is given so its lean wallet is the
 * user's wallet — convergence C8.
 *
 * ## What this hands over, and why that shape
 *
 * A lean ("electrum") coin has no local daemon, so there is no daemon wallet to
 * import descriptors into and C3.5's zero-move adoption cannot apply. But the
 * engine in that mode *holds the wallet itself*: upstream's `WalletManager`
 * derives BIP84 keys, signs, and tracks UTXOs in the engine's own database,
 * with public ElectrumX servers supplying only chain data. Which wallet it is
 * comes down to one input — the key `WalletManager` is initialised from.
 *
 * So we hand it the **account node** the wallet already uses:
 *
 * | coin | account | matches |
 * |---|---|---|
 * | BTC | `m/84'/0'/0'` | `src/wallets/btc-wallet.ts` `m/84'/0'/0'/0/0` |
 * | LTC | `m/84'/2'/0'` | `src/wallets/ltc-wallet.ts` `m/84'/2'/0'/0/0` |
 *
 * The engine derives `…/0/i` and `…/1/i` beneath it, so its index-0 external
 * address **is** the wallet's receive address. One wallet, no deposit, no
 * sweep, no on-chain hop.
 *
 * ## Account level, never the master
 *
 * P3 as amended: the vault master never travels. What travels is one coin's
 * account branch, under explicit per-coin opt-in — the same exposure C3.5's
 * descriptor import already accepts, and nothing on any other chain is
 * reachable from it. This module cannot be asked for a master key; there is no
 * parameter for it.
 *
 * ## The wire format is upstream's own
 *
 * 74 bytes, exactly what `basicswap.util.extkey.ExtKeyPair.decode()` reads:
 *
 * ```
 *   depth(1) ‖ parentFingerprint(4) ‖ childNumber(4) ‖ chainCode(32) ‖ 0x00 ‖ privateKey(32)
 * ```
 *
 * Deliberately not xprv/base58: the engine has no base58 decode on this path,
 * and inventing a format we would then have to parse on the far side is how a
 * silent mismatch gets in. {@link ACCOUNT_NODE_BYTES} of upstream's own
 * serialisation, verified byte-for-byte against the engine's `encode_v()` in
 * `swapAccountKey.test.ts`.
 *
 * ## Custody
 *
 * Same discipline as `src/lib/swapWalletKey.ts`, and for the same reason —
 * JavaScript cannot zeroise a string. Derive immediately before the `invoke`,
 * never hoist, never put in React state or a store, never log, never render.
 * Nothing in this module logs or holds state.
 *
 * @see PwndaWalletVault/wiki/queries/2026-08-20-lean-zero-move-feasibility.md
 * @see upstream/patches/0003-account-key-electrum-wallet.patch
 */
import { HDKey } from "@scure/bip32";
import { mnemonicToSeed } from "@scure/bip39";
import * as bitcoin from "bitcoinjs-lib";
import { encodeCashAddr } from "../wallets/bch-wallet";

/** Serialised length of an account node. Upstream asserts this exact value. */
export const ACCOUNT_NODE_BYTES = 74;

/**
 * Coins whose lean wallet can be adopted, and the account each one lives at.
 *
 * Keyed by UPPERCASE ticker to match `CoinEnableStatus.ticker`. Only BTC and
 * LTC appear because only they can run lean at all (upstream parses `--btc-mode`
 * and `--ltc-mode` and nothing else) — and because upstream's `WalletManager`
 * declares `SUPPORTED_COINS = {BTC, LTC}`, so a third entry here would be
 * refused by the engine rather than silently mis-derived.
 *
 * **These paths must stay identical to the wallet adapters'.** They are not
 * independent constants that happen to agree: if `btc-wallet.ts` ever moves,
 * the engine keeps deriving the old account and the user's balance splits in
 * two with no error. `swapAccountKey.test.ts` reads the adapters' own source
 * and fails on divergence.
 */
export const ADOPTABLE_ACCOUNTS: Readonly<Record<string, string>> = {
  BTC: "m/84'/0'/0'",
  LTC: "m/84'/2'/0'",
  // BCH joined 2026-09-05. The engine's WalletManager has admitted BCH since
  // PATCH-18/19/24 (coin type 145, p2pkh, cashaddr), Rust's ELECTRUM_CAPABLE
  // lists it, the DEX row offered "Use my wallet" for it — and this table did
  // not know the coin, so no key was ever derived or pushed. The engine's log
  // said so on every start: "PWNDA-PATCH-3: BCH expects a host-wallet account
  // key; none pushed yet, not initialising from the engine seed" — and the
  // console read `NaN BCH` because there was no wallet to read a balance from.
  BCH: "m/44'/145'/0'",
};

/** Tickers this module can derive an account node for. */
export function isAdoptableCoin(ticker: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    ADOPTABLE_ACCOUNTS,
    ticker.trim().toUpperCase(),
  );
}

// ─────────────────────────────────────────────────────────────────────
// Derivation-aware resolution (2026-08-21)
//
// The first cut of this module hardcoded the STANDARD accounts above and
// pushed them for every wallet. On the operator's own machine both coins
// refused: their wallet was imported through the derivation PICKER — LTC on
// BIP-44 legacy (`m/44'/2'/0'/0/0` → `L…`) and BTC on the pre-2026-05-06
// PwndaWallet path (`m/44'/0'/0'/0/0` encoded as bech32, so it LOOKS
// standard). The engine dutifully derived the standard account, produced an
// address the user does not own, and the round-trip check refused — which is
// the check doing its job, but the push was wrong to begin with.
//
// So the deriver now works backwards from the one thing that is definitely
// true: THE ADDRESS THE WALLET SHOWS THE USER. Each candidate below is
// (account path, address encoding); the wallet's address is matched against
// the candidates' own derived index-0 address, and the matching ACCOUNT is
// what gets pushed. No match, or a match whose encoding the engine cannot
// serve, is a SKIP with a reason — never a guess.
//
// The candidate tables mirror `derivation-detector.ts`'s (the picker), which
// cannot be imported here (BOUNDARIES: settings may not reach into
// onboarding, and this module must stay importable from anywhere).
// `swapAccountKey.test.ts` pins the overlap against the adapters' own
// outputs so the two tables cannot drift silently.
// ─────────────────────────────────────────────────────────────────────

/** How a candidate's addresses are encoded. The engine's `WalletManager`
 *  produces NATIVE SEGWIT ONLY (`segwit_addr.encode`, wallet_manager.py) —
 *  so only `p2wpkh` candidates are shareable; the rest are honest skips. */
type AddressEncoding = "p2wpkh" | "p2sh-p2wpkh" | "p2pkh";

interface DerivationCandidate {
  /** Account-level path — what actually gets pushed. */
  accountPath: string;
  /** Where the wallet's displayed address sits under it. Always `/0/0`. */
  encoding: AddressEncoding;
  /** For the skip message. */
  label: string;
}

/** Litecoin mainnet params — the three constants address encoding needs.
 *  Duplicated from `ltc-wallet.ts` because this module cannot import the
 *  adapter (cycle risk: adapters import `src/lib`); the test pins this
 *  module's derived default address against the published LTC BIP-84 vector,
 *  so a drift here fails loudly. */
const LTC_NETWORK: bitcoin.networks.Network = {
  messagePrefix: "\x19Litecoin Signed Message:\n",
  bech32: "ltc",
  bip32: { public: 0x019da462, private: 0x019d9cfe },
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0,
};

const CANDIDATES: Readonly<Record<string, readonly DerivationCandidate[]>> = {
  BTC: [
    { accountPath: "m/84'/0'/0'", encoding: "p2wpkh", label: "BIP-84 native SegWit" },
    // Pre-2026-05-06 PwndaWallet: BIP-44 PATH with bech32 ENCODING. Looks like
    // a standard bc1q… address and is not — the exact trap the operator hit.
    { accountPath: "m/44'/0'/0'", encoding: "p2wpkh", label: "PwndaWallet pre-2026-05-06" },
    { accountPath: "m/49'/0'/0'", encoding: "p2sh-p2wpkh", label: "BIP-49 wrapped SegWit" },
    { accountPath: "m/44'/0'/0'", encoding: "p2pkh", label: "BIP-44 legacy" },
  ],
  LTC: [
    { accountPath: "m/84'/2'/0'", encoding: "p2wpkh", label: "BIP-84 native SegWit" },
    { accountPath: "m/44'/2'/0'", encoding: "p2pkh", label: "BIP-44 legacy (Exodus)" },
  ],
  BCH: [
    {
      accountPath: "m/44'/145'/0'",
      encoding: "p2pkh",
      label: "BIP-44 coin type 145 (Electron Cash, Exodus)",
    },
  ],
};

function networkFor(ticker: string): bitcoin.networks.Network {
  return ticker === "LTC" ? LTC_NETWORK : bitcoin.networks.bitcoin;
}

function addressAt(
  node: HDKey,
  encoding: AddressEncoding,
  network: bitcoin.networks.Network,
  ticker = "",
): string {
  const pubkey = Buffer.from(node.publicKey!);
  if (ticker === "BCH") {
    // BCH has no SegWit; its one form is P2PKH, spelled as cashaddr.
    const hash = bitcoin.crypto.hash160(pubkey);
    return encodeCashAddr(new Uint8Array(hash), "p2pkh");
  }
  if (encoding === "p2wpkh") {
    return bitcoin.payments.p2wpkh({ pubkey, network }).address!;
  }
  if (encoding === "p2sh-p2wpkh") {
    return bitcoin.payments.p2sh({
      redeem: bitcoin.payments.p2wpkh({ pubkey, network }),
      network,
    }).address!;
  }
  return bitcoin.payments.p2pkh({ pubkey, network }).address!;
}

/** A candidate resolved against the wallet's own displayed address. */
/** Cashaddr compares case-insensitively and with or without its prefix. */
function normalizeAddress(ticker: string, address: string): string {
  const a = address.trim();
  if (ticker !== "BCH") return a;
  return a.toLowerCase().replace(/^bitcoincash:/, "");
}

export interface ResolvedDerivation {
  candidate: DerivationCandidate;
  /**
   * Whether the engine can serve this wallet. Only native SegWit is
   * shareable — reverted 2026-08-21, the same day a build earlier that day
   * briefly made legacy P2PKH shareable too, via PWNDA-PATCH-3/4/6 giving
   * the engine an address type. The engine patches still exist and still
   * work — the reversal is a frontend policy choice, not a capability
   * regression. Two reasons: (1) a swap-safety audit (PWNDA-PATCH-7) found
   * that even a WORKING legacy wallet still cannot fund a chain-A swap
   * lock — BasicSwap pre-signs the leader's refund against the lock tx's
   * own pre-broadcast txid, which only a segwit-funded lock tx keeps
   * stable, so legacy support closed the receive/hold/send gap but not the
   * swap gap it was built for. (2) The one-time sweep this reversal now
   * requires costs a fraction of a cent (LTC fees are cheap regardless of
   * input type) against an ongoing patch-maintenance cost of carrying
   * legacy-signing support through upstream's least-settled subsystem. See
   * PwndaWalletVault/wiki/queries/2026-08-21-multi-derivation-support.md
   * for the full evaluation. BIP-49 wrapped SegWit stays excluded for the
   * original reason: no P2SH redeem spend path exists in this engine.
   */
  shareable: boolean;
}

/**
 * Which known derivation produced `address` for this mnemonic — or null.
 *
 * Matching the WALLET'S OWN ADDRESS is the point: it is the value the user
 * sees, the value the funds sit on, and the value the backend's round-trip
 * verifies against, so resolving from it cannot disagree with any of them.
 */
export async function resolveDerivation(
  vaultMnemonic: string,
  ticker: string,
  address: string,
): Promise<ResolvedDerivation | null> {
  const key = ticker.trim().toUpperCase();
  const candidates = CANDIDATES[key];
  if (!candidates) return null;
  const normalized = vaultMnemonic.trim().replace(/\s+/g, " ");
  if (!normalized || !address.trim()) return null;

  const master = HDKey.fromMasterSeed(await mnemonicToSeed(normalized));
  const network = networkFor(key);
  const want = normalizeAddress(key, address);
  for (const candidate of candidates) {
    const first = master.derive(`${candidate.accountPath}/0/0`);
    if (normalizeAddress(key, addressAt(first, candidate.encoding, network, key)) === want) {
      // Native SegWit is what the engine's electrum wallet spends from for the
      // BTC/LTC family; BCH has no SegWit at all and its p2pkh IS the shareable
      // form (PATCH-19: "p2pkh is the only address_type BCH's host wallet will
      // ever push").
      const shareable = candidate.encoding === "p2wpkh" || key === "BCH";
      return { candidate, shareable };
    }
  }
  return null;
}

/** Serialise the account node at an EXPLICIT account path. */
export async function deriveAccountNodeAtPath(
  vaultMnemonic: string,
  accountPath: string,
): Promise<string> {
  const normalized = vaultMnemonic.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error("swapAccountKey: empty vault mnemonic");
  const seed = await mnemonicToSeed(normalized);
  return encodeAccountNode(HDKey.fromMasterSeed(seed).derive(accountPath));
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Serialise an HD node into upstream's 74-byte `ExtKeyPair` encoding.
 *
 * Exported for the test, which pins the output against bytes produced by the
 * engine's own `encode_v()`. A cross-implementation vector is the only check
 * that can catch an endianness or field-order slip here — both would produce a
 * well-formed blob that decodes to a *different, valid* wallet.
 *
 * @throws if the node carries no private key. A watch-only node would encode
 *   into the same length with a public key in the tail, and the engine would
 *   reject it — but far better to refuse before the secret-shaped value with no
 *   secret in it ever leaves this process.
 */
export function encodeAccountNode(node: HDKey): string {
  if (!node.privateKey) {
    throw new Error("swapAccountKey: refusing to encode a watch-only node");
  }
  if (node.chainCode == null || node.chainCode.length !== 32) {
    throw new Error("swapAccountKey: node has no usable chain code");
  }

  const out = new Uint8Array(ACCOUNT_NODE_BYTES);
  out[0] = node.depth & 0xff;

  // Big-endian, matching BIP32 serialisation and upstream's
  // `int.to_bytes(4, "big")`. Little-endian here would decode cleanly into a
  // node with a wrong fingerprint/index — harmless to derivation but a lie in
  // any xpub the engine later exports, so it is worth getting right.
  const view = new DataView(out.buffer);
  view.setUint32(1, node.parentFingerprint >>> 0, false);
  view.setUint32(5, node.index >>> 0, false);

  out.set(node.chainCode, 9);
  out[41] = 0x00; // private-key marker; upstream branches on this byte
  out.set(node.privateKey, 42);
  return hex(out);
}

/**
 * Derive one coin's account node from the vault mnemonic.
 *
 * @param vaultMnemonic the vault master phrase
 * @param ticker `"BTC"` or `"LTC"`
 * @returns the 74-byte account node, hex encoded
 *
 * Pure: no I/O, no logging, no module state. The return value is spending
 * authority for that coin's whole branch — see § Custody.
 */
export async function deriveSwapAccountKey(
  vaultMnemonic: string,
  ticker: string,
): Promise<string> {
  const key = ticker.trim().toUpperCase();
  const path = ADOPTABLE_ACCOUNTS[key];
  if (!path) {
    // Never fall back to a default account: a wrong path yields a valid wallet
    // the user does not own, and the symptom is funds landing out of sight.
    throw new Error(`swapAccountKey: ${ticker} has no adoptable account`);
  }
  const normalized = vaultMnemonic.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error("swapAccountKey: empty vault mnemonic");

  const seed = await mnemonicToSeed(normalized);
  const node = HDKey.fromMasterSeed(seed).derive(path);
  return encodeAccountNode(node);
}

/** One coin's account node, ready to push. */
export interface SwapAccountKey {
  /** UPPERCASE ticker. */
  ticker: string;
  /** 74-byte account node, hex. Spending authority for this coin's branch. */
  accountKey: string;
}

/** One coin's push payload — structurally identical to the API layer's
 *  `AccountKeyPush`, declared here so this pure module needs no import from
 *  `src/api` (BOUNDARIES.md: `src/lib` must stay importable from anywhere). */
export interface AccountKeyPushShape {
  ticker: string;
  accountKey: string;
  expectedAddress: string;
  addressType: "p2wpkh" | "p2pkh";
}

/** One chain's inputs to the deriver — from THAT chain's own wallet entry.
 *  Per-chain on purpose: a multi-wallet vault can carry different mnemonics
 *  per chain, and the first version's "any chain's mnemonic" lookup was a
 *  wrong-wallet hazard waiting to fire. */
export interface AccountKeyChainInput {
  mnemonic: string | null;
  address: string | null;
}

/** A coin the deriver decided NOT to push, and why — rendered to the user. */
export interface AccountKeySkip {
  ticker: string;
  reason: string;
}

export interface DerivedAccountKeys {
  pushes: AccountKeyPushShape[];
  skipped: AccountKeySkip[];
}

/**
 * Build the `deriveAccountKeys` callback the auto-setup pass and the manual
 * Settings path both need — ONE construction, not three.
 *
 * # Derivation-aware since 2026-08-21
 *
 * The first version pushed the STANDARD BIP-84 account for every wallet. On
 * the operator's machine both coins refused: their wallet was imported
 * through the derivation picker — LTC on BIP-44 legacy (`L…`) and BTC on the
 * pre-2026-05-06 PwndaWallet path (`m/44'` encoded as bech32, so it LOOKS
 * standard). Now each ticker's account is RESOLVED from the address the
 * wallet actually shows ({@link resolveDerivation}); what gets pushed is the
 * account that provably produced that address. Three outcomes per coin:
 *
 *  - resolved + native-SegWit → pushed (the engine can serve it);
 *  - resolved + legacy encoding → SKIPPED with a plain-language reason (the
 *    engine's wallet speaks native SegWit only — pushing those keys would
 *    watch the wrong script type and show a zero balance over real funds);
 *  - unresolved → SKIPPED as unrecognized, never guessed.
 *
 * Missing mnemonic/address is not a skip — it is "not loaded yet", omitted
 * entirely so the caller's retry logic keeps waiting.
 */
export function makeAccountKeyDeriver(
  inputs: Readonly<Record<string, AccountKeyChainInput>>,
): () => Promise<DerivedAccountKeys> {
  return async () => {
    const pushes: AccountKeyPushShape[] = [];
    const skipped: AccountKeySkip[] = [];
    for (const [rawTicker, input] of Object.entries(inputs)) {
      const ticker = rawTicker.trim().toUpperCase();
      if (!isAdoptableCoin(ticker)) continue;
      if (!input.mnemonic || !input.address) continue; // not loaded yet
      const resolved = await resolveDerivation(
        input.mnemonic,
        ticker,
        input.address,
      );
      if (!resolved) {
        skipped.push({
          ticker,
          reason:
            `${ticker}: this wallet's derivation is not one the swap node ` +
            "can share — not pushing keys. Funding it by deposit still works.",
        });
        continue;
      }
      if (!resolved.shareable) {
        // Legacy P2PKH has an actual fix today (the sweep) — name it. Every
        // other unshareable encoding (BIP-49 wrapped SegWit) has none yet,
        // so it keeps the older, honest "fund by deposit" fallback.
        const reason =
          resolved.candidate.encoding === "p2pkh"
            ? `${ticker}: this wallet uses the ${resolved.candidate.label} ` +
              `derivation (${input.address.slice(0, 6)}…) — the swap ` +
              "node's shared wallet only spends from native SegWit " +
              "addresses. Wallet → Litecoin → \"Move balance…\" migrates " +
              "this balance to a ltc1… address for a small one-time fee, " +
              "after which it shares automatically. Your existing balance " +
              "stays fully usable in the meantime; it just won't fund the " +
              "swap node until migrated."
            : `${ticker}: this wallet uses the ${resolved.candidate.label} ` +
              `derivation (${input.address.slice(0, 6)}…), which the swap ` +
              "node's shared wallet cannot spend from yet — your existing " +
              "balance stays in your wallet, and the node can be funded by " +
              "deposit instead.";
        skipped.push({ ticker, reason });
        continue;
      }
      pushes.push({
        ticker,
        accountKey: await deriveAccountNodeAtPath(
          input.mnemonic,
          resolved.candidate.accountPath,
        ),
        expectedAddress: input.address,
        addressType:
          resolved.candidate.encoding === "p2pkh" ? "p2pkh" : "p2wpkh",
      });
    }
    return { pushes, skipped };
  };
}

/**
 * Derive account nodes for several coins from one normalisation of the phrase.
 *
 * Derived together for the same reason `deriveSwapWalletMaterial` bundles its
 * two secrets: two calls could normalise the phrase differently and produce
 * accounts that disagree, and the failure would be per-coin and silent.
 *
 * Unknown or non-adoptable tickers are skipped rather than throwing — the
 * caller passes whatever coins are enabled, and a DOGE in that list is a
 * coin that runs full-mode C3.5, not an error.
 */
export async function deriveSwapAccountKeys(
  vaultMnemonic: string,
  tickers: readonly string[],
): Promise<SwapAccountKey[]> {
  const normalized = vaultMnemonic.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error("swapAccountKey: empty vault mnemonic");

  const wanted = Array.from(
    new Set(tickers.map((t) => t.trim().toUpperCase()).filter(isAdoptableCoin)),
  );
  if (wanted.length === 0) return [];

  const seed = await mnemonicToSeed(normalized);
  const master = HDKey.fromMasterSeed(seed);
  return wanted.map((ticker) => ({
    ticker,
    accountKey: encodeAccountNode(master.derive(ADOPTABLE_ACCOUNTS[ticker])),
  }));
}
