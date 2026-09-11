import type { EvmGasToken } from "./evm-gas";

export type ChainType =
  | "ethereum"
  | "avalanche"
  // Stablecoin legs. Each (symbol, network) pair is its own chain so send /
  // receive / history / swap ride the machinery that already exists; the
  // ASSETS RAIL groups them back into one row per symbol. `usdt-avax` was the
  // only one until 2026-09-02 — see `wallets/stablecoins.ts` for the registry
  // and for why every contract address in it was verified on-chain first.
  | "usdt-avax"
  | "usdt-eth"
  | "usdt-op"
  | "usdt-bsc"
  | "usdc-eth"
  | "usdc-arb"
  | "usdc-base"
  | "usdc-op"
  | "usdc-pol"
  | "usdc-avax"
  | "usdc-bsc"
  // USD₮0 — Tether's LayerZero OFT. Arbitrum's and Polygon's USDT both
  // migrated to it, so these are the same money the old USDT rows held.
  | "usdt0-arb"
  | "usdt0-pol"
  // Non-EVM stablecoin legs (2026-09-02). SPL mints and the TRC-20 contract
  // were verified on chain the same way the ERC-20 rows were — see
  // `wallets/stablecoins.ts`. USDT-on-Tron is one of the most-held stablecoin
  // legs anywhere and the wallet had no TRC-20 reader at all before this.
  | "usdc-sol"
  | "usdt-sol"
  | "usdt-tron"
  | "polygon"
  | "flare"
  | "bitcoin"
  | "solana"
  | "xrp"
  | "tron"
  | "cardano"
  | "monero"
  | "dogecoin"
  | "ravencoin"
  | "conflux"
  | "hedera"
  | "algorand"
  | "zephyr"
  | "litecoin"
  | "bitcoin-cash"
  // Phase 4 (2026-05-08): EVM L2s + BSC ride the EVM key but get their
  // own balance pipelines.
  | "arbitrum"
  | "base"
  | "optimism"
  | "bsc"
  // Phase 3: Monad (EVM-compatible, chainId 143).
  | "monad"
  // Phase 5: Dash (UTXO).
  | "dash"
  // Phase 6: Stellar (XDR + ed25519).
  | "stellar"
  // Phase 7: Sui (BCS + ed25519 + intent envelope).
  | "sui"
  // 2026-05-14: Ergo (eUTXO, Autolykos v2 GPU mining + Fleet SDK wallet).
  | "ergo"
  // 2026-05-26: NEAR Protocol (SLIP-10 ed25519 at m/44'/397'/0', implicit
  // account = hex(public_key)). TS adapter mirrors the Rust derive::
  // near_implicit_account math byte-for-byte; the Rust path stays for
  // session-gated source-tx signing via swap_sign_near_tx.
  | "near"
  // 2026-08-27: Zano — independent CryptoNote-lineage seed (NOT a Monero
  // fork; see zano-integration-plan.md). Sidecar-backed like monero/zephyr,
  // own wordlist/codec, own address prefix ("Zx..."). No vault persistence
  // yet — see the plan's Phase 5 status for the pending confirmation on the
  // WalletKind/VaultPayload schema change.
  | "zano"
  // 2026-09-02: Aptos — BIP44 ed25519 at m/44'/637'/0'/0'/0', address =
  // sha3_256(pubkey || 0x00). Derivation verified against two independent
  // implementations; see apt-wallet.ts's header.
  | "aptos";

export interface WalletInfo {
  chain: ChainType;
  address: string;
  mnemonic: string;
  privateKey: string;
  /**
   * True for a watch-only (view-only) wallet: the address is known but no
   * signing key is held. Send/Swap must be hidden and `addressFor` (mining
   * payouts) must never resolve to it. Undefined/false for owned wallets.
   */
  watchOnly?: boolean;
}

export interface TxResult {
  hash: string;
}

export interface NetworkInfo {
  label: string;
  value: string;
  unit: string;
}

/**
 * Direction of a transfer relative to the wallet that owns the address.
 *  - "in"      = received funds.
 *  - "out"     = sent funds.
 *  - "self"    = sent to own address (rare; consolidations).
 *  - "failed"  = broadcast but failed to confirm.
 *  - "pending" = locally accepted, not yet on-chain.
 */
export type TxDirection = "in" | "out" | "self" | "failed" | "pending";

/**
 * Unified, chain-agnostic transaction shape consumed by ActivityView.
 * Adapters convert their native shape into this. Anything the table doesn't
 * use (subaddress index, asset type, contract address, etc.) goes into
 * `meta` and is preserved for the detail drawer.
 */
export interface ChainTx {
  chain: ChainType;
  hash: string;
  direction: TxDirection;
  /** Decimal string in chain's display units (e.g. "0.00153" BTC). Always positive. */
  amount: string;
  /** Decimal string in chain units. Present when known; usually outgoing only. */
  fee?: string;
  /** POSIX seconds. Absent for mempool-only entries. */
  timestamp?: number;
  /** 0 = unconfirmed/in-mempool. */
  confirmations?: number;
  height?: number;
  /** Other party in the transfer; first non-self output for multi-out txs. */
  counterparty?: string;
  /** Chain-specific extras (subaddress index, asset, contract, memo). */
  meta?: Record<string, unknown>;
}

/** Cursor token for paging through history. Opaque to callers. */
export interface TxHistoryPage {
  items: ChainTx[];
  cursor?: string;
}

export interface FeeTier {
  /** Decimal string in `unit`. */
  value: string;
  /** Approximate confirmation target for context (e.g. "≈ 1 block", "≈ 20 min"). */
  eta?: string;
}

/**
 * Multi-tier fee estimate. Chains with deterministic fees (Cardano, Hedera,
 * Algorand) only set `normal`. Chains with real fee markets set all three.
 */
export interface FeeEstimate {
  slow?: FeeTier;
  normal: FeeTier;
  fast?: FeeTier;
  /** Display unit, e.g. "sat/vB", "Gwei", "lamports/sig", "XRP". */
  unit: string;
  /** ms epoch when fetched. */
  fetchedAt: number;
  /** Free-form raw payload from the source — never required by callers. */
  raw?: unknown;
}

/**
 * Whether an address can pay the fee for a send, in the coin that fee is
 * charged in.
 *
 * Every amount here is a decimal string in the FEE COIN's units, never the
 * sent token's. The comparison itself is made in wei by the adapter, so the
 * UI never re-derives it from these strings and cannot disagree with it.
 */
export interface GasBudget {
  /** The fee coin, and which chain's. See `evm-gas.ts`. */
  ticker: string;
  chainName: string;
  /** Native-coin balance at this address. Decimal string. */
  available: string;
  /**
   * Does {@link required} include the amount being sent, or only the fee?
   *
   * `true` on a NATIVE send: amount and fee come out of the same balance, so
   * the requirement is their sum. `false` on an ERC-20 send, where the amount
   * is drawn from the token balance and only gas touches this one.
   *
   * The UI cannot word the warning correctly without it — "you need 0.5 ETH
   * to send ETH" and "you need 0.00003 ETH to send USDC" are different
   * sentences about different quantities.
   */
  includesAmount: boolean;
  /**
   * Estimated native-coin cost of the send, or `null` when the node would not
   * estimate one — an empty recipient field, or a node declining to simulate
   * a transfer the account cannot fund (which is the very case being tested).
   */
  required: string | null;
  /**
   * `true` / `false` when known; `null` when genuinely undecidable.
   *
   * `false` is reported on a zero balance EVEN WHEN `required` is `null`,
   * because no positive fee is payable from nothing and that needs no
   * estimate — which matters, since a zero-gas account is exactly where
   * `estimateGas` tends to refuse. Any other unestimable case stays `null`:
   * the UI warns on `false` and must not block on a guess.
   */
  sufficient: boolean | null;
}

/**
 * How a chain's keys come out of the wallet's seed.
 *
 * REQUIRED on every adapter — deliberately not optional. Adding a chain
 * without declaring this is a compile error, which is the point: derivation
 * is the difference between "your funds are here" and "your funds are at an
 * address this wallet will never show you", and it should not be possible to
 * ship a chain having never written that down.
 *
 * Introduced 2026-08-13. Before this the paths lived only inside each
 * adapter's implementation and in `derivation-paths.test.ts`, so the UI had
 * nothing to render — which is why derivation panels had to be hand-wired per
 * chain and most chains ended up with no derivation surface at all.
 */
export type DerivationInfo =
  | {
      kind: "bip39";
      /** HD path in use, e.g. "m/84'/0'/0'/0/0". */
      path: string;
      /** Which wallets this matches — the reason this path was chosen. */
      standard: string;
      /**
       * Whether other derivations for this chain exist in the wild.
       *
       * False means every major wallet agrees — all EVM chains use
       * m/44'/60'/0'/0/0, for instance. Those render read-only rather than
       * inviting a change that could only move the user's funds out of view.
       * True means a mismatch is plausible and a switcher is worth offering.
       */
      hasAlternatives: boolean;
    }
  | {
      kind: "independent-seed";
      /** Why this chain has no BIP-39 path (Monero/Zephyr own-seed chains). */
      note: string;
    };

export interface ChainAdapter {
  chain: ChainType;
  displayName: string;
  ticker: string;
  color: string;
  addressPlaceholder: string;

  /** How this chain derives from the wallet seed. See `DerivationInfo`. */
  derivation: DerivationInfo;

  /**
   * Derive this chain's wallet at an ARBITRARY HD path.
   *
   * Implementing this is what makes a chain work with the generic tools:
   * the paste-an-address finder, and the balance sweep that auto-selects a
   * funded derivation at import. Without it, a chain can only ever offer the
   * one path it hardcodes — which is why paste-to-find covered 4 chains and
   * the auto-scan covered 5, out of 29.
   *
   * Optional because it genuinely can't be done for every chain: Monero and
   * Zephyr derive from their own seed, not a BIP-39 path, so there is no
   * path to vary. Any chain that CAN should implement it — the generic UI
   * lights up for free, including chains added later.
   */
  deriveAtPath?(mnemonic: string, path: string): WalletInfo;

  /**
   * True for chains (e.g. Monero) that use an independent seed
   * instead of being derived from the shared BIP39 phrase.
   * When true, deriveFromMnemonic() throws and deriveFromOwnSeed()
   * / generateOwnSeed() must be used instead.
   */
  usesIndependentSeed?: boolean;

  /** Generate a fresh independent seed for this chain (e.g. 25-word Monero seed). */
  generateOwnSeed?(): Promise<string>;

  /** Derive a WalletInfo from this chain's own seed format. */
  deriveFromOwnSeed?(seed: string): Promise<WalletInfo>;

  // Note: there is no per-adapter `createWallet()`. New BIP39 mnemonics are
  // generated once at the application level (`App.tsx::handleCreate`) using
  // OS-backed entropy from `secureRandomBytes()`, then fanned out to every
  // adapter via `deriveFromMnemonic()`. Independent-seed chains (Monero,
  // Zephyr) generate their own seed via `generateOwnSeed()`. Per-adapter
  // mnemonic generation would only invite divergence between chains.

  importFromMnemonic(mnemonic: string): WalletInfo;
  importFromPrivateKey(privateKey: string): WalletInfo;
  deriveFromMnemonic(mnemonic: string): WalletInfo;
  /**
   * Current spendable balance for `address`, as a decimal string.
   *
   * **MUST throw on failure — never coerce a failure to `"0"`.** A zero is a
   * claim ("this address holds nothing"); an unreachable endpoint, a 429, a
   * 5xx or a malformed body is not evidence for that claim. The dashboard
   * keeps the last-known value and logs the chain when this throws; a
   * silent `"0"` is indistinguishable from an empty wallet and was exactly
   * how seven adapters misreported outages until 2026-08-22. An UNFUNDED
   * address (HTTP 404 from an account-model explorer, an empty row, a
   * `totalBalance: "0"`) IS a legitimate zero — return it.
   *
   * Adapters with redundant sources MUST rotate on failure (see
   * `getTransactionHistory`), and a source answering "I do not know this
   * address" must be treated as a failure to rotate past, not as zero.
   */
  getBalance(address: string): Promise<string>;
  /**
   * Derivable accounts for a UTXO chain, for account-WIDE balance and for the
   * recovery surface. Present only on BTC/LTC/DOGE/DASH/BCH.
   *
   * `getBalance` above answers for ONE address. That is not the same question
   * as "what does this wallet hold": a UTXO wallet spends whole outputs and
   * returns change to a fresh address on the internal chain, so the moment
   * anything spends with proper BIP-32 behaviour the single-address answer is
   * wrong — which is exactly how 4.02888049 LTC became invisible on
   * 2026-08-22 (see `utxo-account.ts`). Adapters that expose this let the
   * dashboard scan both chains with a gap limit and sum the account.
   *
   * More than one entry is legitimate: LTC lists its default BIP-84 account
   * AND the Exodus-style BIP-44 legacy account, because a user's funds can be
   * under either.
   */
  utxoAccounts?: import("./utxo-account").UtxoAccountSpec[];
  /**
   * Send `amount` to `to`. `assetType` is an optional per-chain selector for
   * chains that hold more than one asset at the same address — currently only
   * Zephyr (ZPH/ZSD/ZRS/ZYS); every other adapter ignores it and sends its one
   * native asset. For Zephyr, `assetType` is the RPC asset (`"ZSD"` etc.) and a
   * same-asset transfer is a plain send (no protocol conversion).
   */
  sendTransaction(
    privateKey: string,
    to: string,
    amount: string,
    assetType?: string
  ): Promise<TxResult>;

  /**
   * Send from the WHOLE ACCOUNT rather than one derived address.
   *
   * `sendTransaction` takes a single private key, so it can only ever spend
   * the one address that key derives. That is correct for account-model
   * chains (ETH, SOL) and wrong for UTXO chains, where spending an output
   * moves the remainder to a fresh change address: after a few sends the
   * money is at indices the index-0 key cannot reach, and the send fails with
   * "no spendable UTXOs" while the wallet displays a correct, non-zero
   * balance. Observed live on 2026-08-25 (4.05726856 LTC unreachable from a
   * Send button, because index 0/0 held nothing).
   *
   * Adapters that implement this gather UTXOs across every funded address in
   * the account and sign each input with ITS OWN derived key — the same thing
   * Electrum, Sparrow, BlueWallet and BasicSwap's own `WalletManager` do
   * (`_fundTxElectrum` -> `getFundedAddresses`). `useSend` prefers it whenever
   * the adapter offers it and a mnemonic is available, falling back to
   * `sendTransaction` otherwise — but ONLY when `supportsAccountSend` says
   * this particular wallet is on the account the adapter scans.
   *
   * Takes the MNEMONIC, not a key: deriving siblings is the entire point, and
   * one child key cannot produce them.
   */
  /**
   * Is `address` on the account `sendFromAccount` actually scans?
   *
   * Not a formality. A chain can expose more than one account from the same
   * seed — LTC has BIP-84 native SegWit AND a BIP-44 legacy account for
   * Exodus/Atomic imports — and an account-wide send that scans the wrong
   * one would report "insufficient funds" over a wallet that is plainly
   * funded. That is the SAME class of failure account-wide sending exists to
   * fix, so it must not be introduced while fixing it.
   *
   * Returning false is not an error: `useSend` falls back to
   * `sendTransaction`, which is correct for accounts that were never split.
   */
  supportsAccountSend?(mnemonic: string, address: string): boolean;

  sendFromAccount?(
    mnemonic: string,
    to: string,
    amount: string,
    /** The wallet's displayed address, so the adapter can re-check the account. */
    fromAddress?: string
  ): Promise<TxResult>;
  getNetworkInfo(): Promise<NetworkInfo>;

  /**
   * Recent transaction history for `address`, paginated. `opts.limit`
   * defaults to 25; `opts.cursor` is an opaque token returned from a
   * previous call (different sources have different cursor schemes — the
   * adapter encodes its source choice into the token).
   *
   * Adapters MUST rotate through redundant endpoints and only throw when
   * every source has failed. Empty `items` is a successful answer.
   */
  getTransactionHistory(
    address: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<TxHistoryPage>;

  /**
   * Current network fee estimate, structured. Adapters that only have one
   * tier just populate `normal`. Throws only when every redundant source
   * is unreachable; never returns a stale or guessed value.
   */
  getFeeEstimate(): Promise<FeeEstimate>;

  /**
   * The coin that pays this adapter's fees, when it is NOT the coin being
   * sent.
   *
   * Present only on ERC-20 adapters (`usdc-arb`, `usdt-op`, …), because they
   * are the only ones where holding the full send amount still leaves you
   * unable to send. On a native adapter the fee comes out of the same balance
   * the amount does, the modal already shows it, and there is no second asset
   * to warn about — so this stays `undefined` and callers skip the check.
   *
   * Absent on every non-EVM adapter too. `undefined` means "no separate fee
   * asset to reason about", never "unknown".
   */
  gasToken?: EvmGasToken;

  /**
   * Can this address actually pay the fee for the send it is about to make?
   *
   * Only implemented alongside {@link gasToken}. Added 2026-09-09 after the
   * ERC-20 branch of `evm-factory.ts::sendTransaction` was found calling
   * `contract.transfer(...)` with no balance check in front of it: a wallet
   * holding USDC on Arbitrum and zero ETH showed an enabled Send button and
   * reported the shortfall only as a raw RPC string, after the press.
   *
   * `opts.to` / `opts.amount` are the send being contemplated. They are
   * optional because the most valuable moment to answer is when the modal
   * opens and neither has been typed yet — see {@link GasBudget.sufficient}
   * for what is still decidable then.
   */
  getGasBudget?(
    address: string,
    opts?: { to?: string; amount?: string },
  ): Promise<GasBudget>;

  /**
   * True when the NETWORK computes the fee at broadcast time, so the estimate
   * this adapter returns is informational only.
   *
   * Monero is the clear case: `transfer` takes a `priority` (0-3) and
   * monero-wallet-rpc derives the fee itself — the wallet never submits a fee
   * and could not override one.
   *
   * # Why this exists
   *
   * Reported 2026-08-29: sending XMR was impossible, with `RPC error -32601:
   * Method not found  Send is disabled until a fee is available.` Two faults
   * stacked — the fee call was wrong (see `xmr-wallet.ts::getFeeEstimate`),
   * AND `SendModal` disabled Send because the fee was missing, even though
   * for Monero the fee is not the wallet's to supply. A DISPLAY value was
   * gating a SEND.
   *
   * Adapters that DO submit a fee (the UTXO family builds a tx with an
   * explicit sat/vB) must leave this false: there a missing fee genuinely
   * blocks a correct transaction and gating is right.
   */
  networkComputesFee?: boolean;
}
