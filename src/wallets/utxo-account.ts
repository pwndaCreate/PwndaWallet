/**
 * Account-wide balance scanning for the UTXO chains (2026-08-22).
 *
 * # The illusion this exists to kill
 *
 * Every UTXO adapter in this repo derived exactly ONE address — index 0 of
 * the external chain (`m/84'/2'/0'/0/0` for LTC, and the equivalents for BTC,
 * DOGE, DASH, BCH) — and reported that address's balance as "the wallet".
 * That model is only true while nothing ever spends with proper BIP-32 change
 * behaviour.
 *
 * pwnda's own send path reuses the sender address for change
 * (`ltc-wallet.ts` — `psbt.addOutput({ address: senderAddress … })`), so the
 * single-address model survived every send the app itself made. The BasicSwap
 * engine, which shares the SAME keys via C8 account-key substitution, does it
 * properly: it derives change on the internal chain. The first time the engine
 * spent, 4.02888049 LTC landed at `m/84'/2'/0'/1/20` and the dashboard showed
 * `0` — a number that was arithmetically correct for the one address it knew
 * and completely wrong about the wallet.
 *
 * > pwnda's wallet model was "one address, reused". The engine's model is "a
 * > BIP-84 account with a change chain". They share keys, so the moment the
 * > engine spent, pwnda's model was simply wrong.
 *
 * # Why the gap limit is not 20
 *
 * The funds landed at internal index **20** with indices 0–19 never used,
 * because upstream BasicSwap's `getNewInternalAddress` allocates
 * `MAX(derivation_index) + 1` rather than the first unused index, and a
 * lookahead pool of 20 had already been derived. BIP-44's standard gap limit
 * is 20 — so a scanner that stops after 20 consecutive unused addresses stops
 * at index 19 and never sees the money. That is not a hypothetical: it is
 * exactly what a stock Electrum restore of this seed would do.
 *
 * `DEFAULT_GAP_LIMIT` is therefore deliberately wider than the standard. It
 * is a **safety margin over a known-bad allocator**, not a preference.
 *
 * # Honest-failure contract
 *
 * `probe` MUST throw on an unreachable/ratelimited/malformed source and must
 * never coerce a failure to `{balanceSat: 0}` — the same doctrine
 * `ChainAdapter.getBalance` carries, for the same reason: a zero is a claim.
 * A scan that could not complete reports `complete: false` so callers can say
 * "0 across 41 scanned" versus "could not scan", instead of printing a bare
 * `0` that means neither.
 */
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import type { ChainType } from "./types";

/** 0 = external/receive chain, 1 = internal/change chain (BIP-44 §"Change"). */
export type UtxoChainIndex = 0 | 1;

/**
 * Gap limit for the sequential walk. BIP-44 specifies 20; we use 40.
 *
 * Rationale, not taste: the swap engine has been observed allocating change at
 * internal index 20 with 0–19 untouched (see the module header). A limit of 20
 * would stop one address short of real funds. 40 clears that case with room for
 * the allocator to do it again before anyone notices.
 */
export const DEFAULT_GAP_LIMIT = 40;

/** Concurrent address probes per scan. Kept low: these hit the same keyless
 *  public explorers (BlockCypher/Blockchair/Esplora) that the whole-dashboard
 *  sweep already shares a rate-limit bucket with. */
export const SCAN_CONCURRENCY = 4;

/**
 * Addresses per `probeMany` request when a spec offers one and does not say
 * otherwise. 50 is well inside what haskoin answers in one call (100 measured
 * live, both deployments, 2026-09-04) and keeps the URL short.
 */
export const DEFAULT_BATCH_SIZE = 50;

export interface UtxoAddressProbe {
  balanceSat: number;
  /**
   * Whether the address has ANY on-chain history — funded now, or funded and
   * since emptied. This, not the balance, drives the gap walk: an address that
   * received and spent everything is `used` with `balanceSat: 0`, and treating
   * it as unused would truncate the scan right where activity is densest.
   */
  used: boolean;
}

/**
 * One derivable account on one chain. A coin can expose more than one (e.g.
 * LTC's default BIP-84 account plus the Exodus-style BIP-44 legacy account).
 */
export interface UtxoAccountSpec {
  chain: ChainType;
  /** Extended account path, e.g. `m/84'/2'/0'` — WITHOUT the chain/index tail. */
  accountPath: string;
  /** Human label for the UI, e.g. "BIP-84 native SegWit". */
  label: string;
  /** Encode a derived child node as this account's address form. */
  deriveAddress(node: HDKey): string;
  /** Probe one address. MUST throw on failure — never coerce to zero. */
  probe(address: string): Promise<UtxoAddressProbe>;
  /**
   * Probe MANY addresses in one request (2026-09-04).
   *
   * The gap walk asks about ~90 addresses per refresh, and every per-address
   * public explorer rate-limits at a fraction of that — which is how a funded
   * BCH account read 0: the walk could not complete, so nothing was ever
   * persisted, so every refresh re-ran the same doomed walk. Electrum-family
   * wallets never hit this because the Electrum protocol batches scripthash
   * lookups; this is the REST equivalent (haskoin's `/address/balances`).
   *
   * Contract: return exactly one result per address, in request order, or
   * THROW. A throw makes `probeAddresses` fall back to `probe` for that block,
   * so a batch outage degrades to the per-address path rather than to an
   * incomplete scan. Never return a partial array — a missing row is "the
   * source did not answer", and the caller cannot tell that from "unused".
   */
  probeMany?(addresses: string[]): Promise<UtxoAddressProbe[]>;
  /** Max addresses per `probeMany` call. Default {@link DEFAULT_BATCH_SIZE}. */
  batchSize?: number;
}

export interface UtxoAddressEntry {
  /** Full BIP-32 path, e.g. `m/84'/2'/0'/1/20`. */
  path: string;
  address: string;
  chainIndex: UtxoChainIndex;
  index: number;
  balanceSat: number;
  used: boolean;
}

export interface UtxoAccountScan {
  chain: ChainType;
  accountPath: string;
  label: string;
  gapLimit: number;
  /** How many addresses were actually probed. */
  scanned: number;
  totalSat: number;
  /** Only addresses with history or a balance — never the empty tail. */
  entries: UtxoAddressEntry[];
  /**
   * True when both chains completed a full gap run. False when a probe threw
   * or a deadline hit — callers MUST NOT render `totalSat` as an authoritative
   * balance when this is false.
   */
  complete: boolean;
  /** Highest index with history per chain; -1 when the chain is untouched. */
  maxUsed: Record<"receive" | "change", number>;
}

/** `m/84'/2'/0'` + chain 1 + index 20 → `m/84'/2'/0'/1/20`. */
export function childPath(
  accountPath: string,
  chainIndex: UtxoChainIndex,
  index: number,
): string {
  return `${accountPath}/${chainIndex}/${index}`;
}

/**
 * Derive `count` addresses on one chain of one account, starting at `from`.
 * Pure and offline — no network. Exposed separately so the recovery/export
 * surface can list paths without probing anything.
 */
/**
 * The first UNUSED receive-chain address — a fresh address to hand out.
 *
 * ## What this is for
 *
 * Address reuse is a privacy leak: every deposit to one address is publicly
 * linked to every other. Exodus surfaces the mitigation as a "Multiple
 * Addresses" toggle ("generating a new, unused address after your displayed
 * address receives"); it is plain BIP-44 receive-chain rotation, and every
 * modern HD wallet does it.
 *
 * This wallet already had the HARDER half — `resolveUtxoAccountBalance` walks
 * the receive AND change chains to a 40-address gap limit, so funds sitting at
 * a rotated address are found. What was missing was the easy half: it always
 * DISPLAYED `m/…/0'/0/0` and so reused one address forever. Reported
 * 2026-09-04 by a user comparing against Exodus.
 *
 * ## Why a scan is required, and why absence is not index 0
 *
 * "Unused" is a fact about the chain, not about local state, so it can only
 * come from a scan. Returning index 0 when no scan has run would hand out the
 * most-reused address in the account while implying it is fresh — worse than
 * showing nothing, because it looks like the feature worked. So: `null` when
 * the answer is not known, and callers fall back to the primary address with
 * its own (honest) label.
 *
 * An INCOMPLETE scan is also refused. A source that failed mid-walk makes
 * "unused" indistinguishable from "unknown", and handing out an address that
 * is merely unprobed is exactly the reuse this exists to prevent.
 */
export function firstUnusedReceiveAddress(
  mnemonic: string,
  spec: UtxoAccountSpec,
  summary: { entries: UtxoAddressEntry[]; complete: boolean } | null | undefined,
  opts: { lookahead?: number } = {},
): { address: string; path: string; index: number } | null {
  if (!mnemonic || !summary || !summary.complete) return null;

  // Highest touched receive index. `used` OR a balance: an address holding
  // coins is obviously not free to reuse, even if a source forgot to flag it.
  let highestTouched = -1;
  for (const e of summary.entries) {
    if (e.chainIndex !== 0) continue;
    if (e.used || e.balanceSat > 0) {
      if (e.index > highestTouched) highestTouched = e.index;
    }
  }

  // One past the highest touched index — NOT the first gap. A gap inside the
  // used range is an address some other wallet may already have handed out
  // and be waiting on; reusing it would defeat the point. `MAX(index) + 1` is
  // also what the swap engine's own WalletManager does (see the 2026-08-22 LTC
  // change-index incident, where the two disagreeing is what stranded funds).
  const next = highestTouched + 1;

  const lookahead = opts.lookahead ?? 1;
  const derived = deriveUtxoAddresses(mnemonic, spec, 0, next, Math.max(1, lookahead));
  const hit = derived[0];
  return hit ? { address: hit.address, path: hit.path, index: hit.index } : null;
}

/**
 * The internal-chain index a NEW change output should go to: the LOWEST
 * index on chain 1 with no history and no balance.
 *
 * ## Why the change chain, and why lowest-unused rather than MAX+1
 *
 * Until 2026-09-04 every `send*FromAccount` returned change to the index-0
 * receive address — the address the wallet displays and, since receive
 * rotation shipped, the one it deliberately stops handing out. That is the
 * opposite of what every surveyed wallet does: Electrum, Electron Cash,
 * Sparrow, BlueWallet, Trezor Suite and Exodus ("Multiple Addresses") all put
 * change on BIP-44's internal chain, and so does the swap engine this wallet
 * shares keys with. Two spenders with two change policies on one account is
 * exactly how the 2026-08-22 LTC incident happened.
 *
 * Lowest-unused is the rule the engine itself now follows
 * (`PWNDA-PATCH-9`, `wallet_manager.py::getNewInternalAddress`): it keeps the
 * change chain DENSE, so the widest run of unused indices — the number a
 * restoring wallet's gap limit races against (see `assessGapHeadroom`) —
 * never grows from our own spends. MAX+1 would be fine too when the chain is
 * dense, and would re-open the gap whenever it is not. Receive addresses use
 * MAX+1 (`firstUnusedReceiveAddress`) for a different reason: a gap inside
 * the receive range may be an address another wallet handed out and is
 * waiting on. Nobody hands out change addresses, so that hazard does not
 * apply here.
 *
 * Pure. `entries` is the scan's touched set (used or funded); an index absent
 * from it is unused. Callers must only pass entries from a COMPLETE scan —
 * `gatherAccountSpend` refuses an incomplete one before this is reached.
 */
export function nextChangeIndex(entries: ReadonlyArray<UtxoAddressEntry>): number {
  const taken = new Set<number>();
  for (const e of entries) {
    if (e.chainIndex === 1 && (e.used || e.balanceSat > 0)) taken.add(e.index);
  }
  let i = 0;
  while (taken.has(i)) i++;
  return i;
}

/**
 * The address {@link nextChangeIndex} names, derived. `null` when the scan is
 * missing or incomplete, for the same reason `firstUnusedReceiveAddress`
 * refuses: an address that is merely unprobed is not known to be unused.
 */
export function firstUnusedChangeAddress(
  mnemonic: string,
  spec: UtxoAccountSpec,
  summary: { entries: UtxoAddressEntry[]; complete: boolean } | null | undefined,
): { address: string; path: string; index: number } | null {
  if (!mnemonic || !summary || !summary.complete) return null;
  const index = nextChangeIndex(summary.entries);
  const [hit] = deriveUtxoAddresses(mnemonic, spec, 1, index, 1);
  return hit ? { address: hit.address, path: hit.path, index: hit.index } : null;
}

export function deriveUtxoAddresses(
  mnemonic: string,
  spec: UtxoAccountSpec,
  chainIndex: UtxoChainIndex,
  from: number,
  count: number,
): Array<{ path: string; address: string; index: number }> {
  const seed = mnemonicToSeedSync(mnemonic.trim(), "");
  const root = HDKey.fromMasterSeed(seed);
  const account = root.derive(spec.accountPath);
  const chainNode = account.deriveChild(chainIndex);
  const out: Array<{ path: string; address: string; index: number }> = [];
  for (let i = from; i < from + count; i++) {
    const node = chainNode.deriveChild(i);
    out.push({
      path: childPath(spec.accountPath, chainIndex, i),
      address: spec.deriveAddress(node),
      index: i,
    });
  }
  return out;
}

/**
 * Probe a fixed list of addresses with bounded concurrency.
 *
 * Unlike the gap walk this never discovers anything new — it is the FAST path
 * the dashboard sweep uses once a deep scan has recorded which addresses
 * matter. A single probe throwing marks the whole batch incomplete rather than
 * silently dropping that address's balance from the total, because a partial
 * sum rendered as a total is the same lie this module exists to remove.
 */
export async function probeAddresses(
  spec: UtxoAccountSpec,
  addresses: ReadonlyArray<{ path: string; address: string; chainIndex: UtxoChainIndex; index: number }>,
  concurrency: number = SCAN_CONCURRENCY,
): Promise<{ entries: UtxoAddressEntry[]; complete: boolean }> {
  const entries: UtxoAddressEntry[] = [];
  let complete = true;

  // Batch path first, when the spec offers one. Each block is ONE request;
  // a block whose batch call throws falls back to the per-address probe for
  // exactly that block, so a batch-source outage costs requests, not
  // completeness.
  const perAddress = async (
    block: ReadonlyArray<(typeof addresses)[number]>,
  ): Promise<void> => {
    let next = 0;
    const width = Math.max(1, Math.min(concurrency, block.length));
    const worker = async () => {
      while (next < block.length) {
        const a = block[next++];
        try {
          const r = await spec.probe(a.address);
          entries.push({
            path: a.path,
            address: a.address,
            chainIndex: a.chainIndex,
            index: a.index,
            balanceSat: r.balanceSat,
            used: r.used,
          });
        } catch {
          complete = false;
        }
      }
    };
    await Promise.all(Array.from({ length: width }, worker));
  };

  if (spec.probeMany) {
    const size = Math.max(1, spec.batchSize ?? DEFAULT_BATCH_SIZE);
    for (let i = 0; i < addresses.length; i += size) {
      const block = addresses.slice(i, i + size);
      let results: UtxoAddressProbe[] | null = null;
      try {
        const r = await spec.probeMany(block.map((b) => b.address));
        // The contract is one result per address, in order. Anything else is
        // a source that did not answer for the whole block.
        results = Array.isArray(r) && r.length === block.length ? r : null;
      } catch {
        results = null;
      }
      if (results) {
        block.forEach((a, k) => {
          entries.push({
            path: a.path,
            address: a.address,
            chainIndex: a.chainIndex,
            index: a.index,
            balanceSat: results![k].balanceSat,
            used: results![k].used,
          });
        });
      } else {
        await perAddress(block);
      }
    }
  } else {
    await perAddress(addresses);
  }

  entries.sort((x, y) => x.chainIndex - y.chainIndex || x.index - y.index);
  return { entries, complete };
}

/**
 * Walk one chain of an account until `gapLimit` consecutive unused addresses.
 *
 * Probes in blocks of `concurrency` so the common case (a fresh chain) costs
 * ~gapLimit/concurrency round trips instead of gapLimit. Stops as soon as the
 * trailing unused run reaches the limit, counted across block boundaries —
 * counting per-block would let a used address at the start of a block reset a
 * run that had already earned a stop.
 */
async function walkChain(
  mnemonic: string,
  spec: UtxoAccountSpec,
  chainIndex: UtxoChainIndex,
  gapLimit: number,
  concurrency: number,
): Promise<{ entries: UtxoAddressEntry[]; scanned: number; complete: boolean }> {
  const entries: UtxoAddressEntry[] = [];
  let scanned = 0;
  let trailingUnused = 0;
  let cursor = 0;
  let complete = true;
  // Derive in blocks wider than the in-flight cap so a 40-address gap costs a
  // handful of rounds rather than gapLimit/concurrency of them; `probeAddresses`
  // still holds the concurrency line inside each block.
  //
  // With a batch probe a block is ONE request, so size it to the gap limit:
  // an untouched chain is then settled in a single call, and an active one
  // in a handful. (Measured 2026-09-04: the BCH walk went from 98 requests to
  // 2 for the same account.)
  const blockSize = spec.probeMany
    ? Math.max(10, Math.min(spec.batchSize ?? DEFAULT_BATCH_SIZE, gapLimit))
    : Math.max(concurrency, 10);

  while (trailingUnused < gapLimit) {
    const block = deriveUtxoAddresses(mnemonic, spec, chainIndex, cursor, blockSize);
    const probed = await probeAddresses(
      spec,
      block.map((b) => ({ ...b, chainIndex })),
      concurrency,
    );
    scanned += block.length;
    if (!probed.complete) {
      // A source failed mid-walk. Continuing would let a run of "unknown"
      // masquerade as a run of "unused" and stop the scan early — the precise
      // failure this module refuses to make. Bail and say so.
      complete = false;
      entries.push(...probed.entries.filter((e) => e.used || e.balanceSat > 0));
      break;
    }
    for (const e of probed.entries) {
      if (e.used || e.balanceSat > 0) {
        entries.push(e);
        trailingUnused = 0;
      } else {
        trailingUnused++;
      }
    }
    cursor += block.length;
    // Runaway guard: a source that reports every address as used would loop
    // forever. No real account reaches this.
    //
    // 2026-08-28: made LOUD. It fired silently for months in the Claude
    // sandbox (the mock answered every address as funded), and the only
    // symptom anyone saw was a console flood + starved renderer ~1000
    // addresses per chain downstream — in `useTxHistory`, three layers away
    // from the cause. A guard that trips without saying so converts a
    // diagnosable fault into a mystery. An explorer that false-positives
    // `used` would do exactly this in production, so this is not a
    // sandbox-only concern. See PwndaWalletVault/log.md 2026-08-28.
    if (cursor > gapLimit * 25) {
      console.error(
        `[utxo-account] runaway gap walk on ${spec.chain} chain ${chainIndex} ` +
          `(${spec.label}): ${cursor} addresses probed without ${gapLimit} ` +
          `consecutive unused ones, so the walk was cut short. The scan is ` +
          `marked INCOMPLETE. This means an address source is reporting ` +
          `addresses as used that are not — check the source before trusting ` +
          `any balance for this chain.`,
      );
      complete = false;
      break;
    }
  }
  return { entries, scanned, complete };
}

/**
 * Full gap-limit scan of both chains of one account.
 *
 * This is the DEEP path — expensive (tens of probes) and meant to run on
 * demand, on first load, and after a swap, not on every dashboard refresh.
 * `UtxoAccountScan.entries` is what gets persisted so the cheap path can
 * re-probe only the addresses that ever mattered.
 */
export async function scanUtxoAccount(
  mnemonic: string,
  spec: UtxoAccountSpec,
  opts?: { gapLimit?: number; concurrency?: number },
): Promise<UtxoAccountScan> {
  const gapLimit = opts?.gapLimit ?? DEFAULT_GAP_LIMIT;
  const concurrency = opts?.concurrency ?? SCAN_CONCURRENCY;

  const receive = await walkChain(mnemonic, spec, 0, gapLimit, concurrency);
  const change = await walkChain(mnemonic, spec, 1, gapLimit, concurrency);

  const entries = [...receive.entries, ...change.entries].sort(
    (a, b) => a.chainIndex - b.chainIndex || a.index - b.index,
  );
  return {
    chain: spec.chain,
    accountPath: spec.accountPath,
    label: spec.label,
    gapLimit,
    scanned: receive.scanned + change.scanned,
    totalSat: entries.reduce((s, e) => s + e.balanceSat, 0),
    entries,
    complete: receive.complete && change.complete,
    maxUsed: {
      receive: maxUsedIndex(receive.entries),
      change: maxUsedIndex(change.entries),
    },
  };
}

function maxUsedIndex(entries: ReadonlyArray<UtxoAddressEntry>): number {
  let m = -1;
  for (const e of entries) if (e.used && e.index > m) m = e.index;
  return m;
}

// ── Recovery-safety analysis ─────────────────────────────────────────────

/**
 * The standard gap limit a third-party wallet will use when restoring this
 * seed. BIP-44 fixes it at 20; Electrum and most hardware-wallet suites follow
 * it (several use a SMALLER limit for the change chain, which only makes the
 * hazard worse, so 20 is the optimistic bound).
 */
export const STANDARD_GAP_LIMIT = 20;

export interface RecoveryRisk {
  /** Funds a stock gap-limit-20 restore would NOT find. */
  strandedSat: number;
  /** The entries holding that money, for display. */
  strandedEntries: UtxoAddressEntry[];
  /** Minimum gap limit that WOULD find everything. */
  requiredGapLimit: number;
}

/**
 * Which funds a standard restore would miss.
 *
 * Walks each chain the way a stock wallet does — stop after
 * `STANDARD_GAP_LIMIT` consecutive unused addresses — and reports every funded
 * entry that falls beyond the stopping point. This is the number that turns
 * "your coins are gone" into "raise the gap limit", so it is computed from the
 * same entries the balance is, not estimated.
 */
/** How close this account already sits to the standard restore boundary. */
export interface GapHeadroom {
  /**
   * `ok` — comfortably inside. `approaching` — one more skipped allocation
   * could strand funds. `stranded` — already past it, money is unreachable by
   * a stock restore TODAY.
   */
  state: "ok" | "approaching" | "stranded";
  /**
   * The longest run of consecutive UNUSED indices between two used ones, on
   * the worst chain. This is the number a restoring scanner actually races
   * against — it walks forward and gives up after `standardGapLimit`
   * consecutive misses, so the widest existing run is how much of that budget
   * is already spent.
   */
  widestGap: number;
  /** `standardGapLimit - widestGap`. How many more misses fit before a
   *  restore stops short of funds that are further along. */
  headroom: number;
  /** Which chain holds `widestGap` — 0 receive, 1 change. */
  chainIndex: UtxoChainIndex | null;
}

/**
 * Proactive counterpart to {@link analyzeRecoveryRisk}.
 *
 * `analyzeRecoveryRisk` answers "is money unreachable right now" — it fires
 * only once funds are ALREADY stranded, which is exactly when the user can no
 * longer avoid the problem. BIP-44's own text asks for the other half:
 * *"Wallet software should warn when the user is trying to exceed the gap
 * limit."* A 2026-08-25 survey of Electrum, Sparrow, BlueWallet, Trezor Suite,
 * Ledger Live and Wasabi found none of them do (Lopp's cross-wallet gap-limit
 * survey reaches the same conclusion), so there is no prior art to copy and
 * this is deliberately conservative.
 *
 * The measurable thing is the WIDEST existing run of unused indices between
 * used ones. A restoring scanner walks a chain and gives up after
 * `standardGapLimit` consecutive unused addresses, so that run is how much of
 * the scanner's patience this account has already consumed. A wide run plus
 * one more skipped allocation is how 4.02888049 LTC ended up at internal index
 * 20 on 2026-08-22.
 *
 * Computed from used/funded entries only — the same input
 * `analyzeRecoveryRisk` takes — because that is what a scan actually persists.
 * It therefore MEASURES history rather than predicting the allocator: it
 * cannot know where the next change output will land, and does not pretend to.
 */
export function assessGapHeadroom(
  scan: Pick<UtxoAccountScan, "entries">,
  opts?: { standardGapLimit?: number; warnWithin?: number },
): GapHeadroom {
  const limit = opts?.standardGapLimit ?? STANDARD_GAP_LIMIT;
  // 5 of 20: far enough out that a user can act (sweep, or note the required
  // limit in their backup) before anything is actually unreachable.
  const warnWithin = opts?.warnWithin ?? 5;

  let widestGap = 0;
  let worstChain: UtxoChainIndex | null = null;

  for (const chainIndex of [0, 1] as UtxoChainIndex[]) {
    const used = scan.entries
      .filter((e) => e.chainIndex === chainIndex && (e.used || e.balanceSat > 0))
      .map((e) => e.index)
      .sort((a, b) => a - b);
    if (used.length === 0) continue;
    // The run before the first used index counts too: a scanner starts at 0.
    let gap = used[0];
    if (gap > widestGap) {
      widestGap = gap;
      worstChain = chainIndex;
    }
    for (let i = 1; i < used.length; i++) {
      gap = used[i] - used[i - 1] - 1;
      if (gap > widestGap) {
        widestGap = gap;
        worstChain = chainIndex;
      }
    }
  }

  const headroom = limit - widestGap;
  // `stranded` is deliberately delegated, not re-derived: one definition of
  // "unreachable" in this file, and it is analyzeRecoveryRisk's.
  const alreadyStranded = analyzeRecoveryRisk(scan, limit).strandedSat > 0;
  const state: GapHeadroom["state"] = alreadyStranded
    ? "stranded"
    : headroom <= warnWithin
      ? "approaching"
      : "ok";

  return { state, widestGap, headroom, chainIndex: worstChain };
}

export function analyzeRecoveryRisk(
  scan: Pick<UtxoAccountScan, "entries">,
  standardGapLimit: number = STANDARD_GAP_LIMIT,
): RecoveryRisk {
  const stranded: UtxoAddressEntry[] = [];
  let requiredGapLimit = standardGapLimit;

  for (const chainIndex of [0, 1] as UtxoChainIndex[]) {
    const onChain = scan.entries
      .filter((e) => e.chainIndex === chainIndex)
      .sort((a, b) => a.index - b.index);
    // Where a stock scanner gives up: the first index at which it has seen
    // `standardGapLimit` unused addresses in a row.
    let stopAt = standardGapLimit; // nothing used → stops after 0..limit-1
    let lastUsed = -1;
    for (const e of onChain) {
      if (!e.used && e.balanceSat <= 0) continue;
      if (e.index > lastUsed + standardGapLimit) break; // unreachable — gap too wide
      lastUsed = e.index;
      stopAt = lastUsed + 1 + standardGapLimit;
    }
    for (const e of onChain) {
      if (e.balanceSat > 0 && e.index >= stopAt) {
        stranded.push(e);
        // A scanner sitting at `lastUsed` probes through `lastUsed + G`, so the
        // smallest limit that reaches index i is exactly `i - lastUsed`.
        requiredGapLimit = Math.max(requiredGapLimit, e.index - lastUsed);
      }
    }
  }

  return {
    strandedSat: stranded.reduce((s, e) => s + e.balanceSat, 0),
    strandedEntries: stranded,
    requiredGapLimit,
  };
}

/** Sats → a decimal string with `decimals` places, matching adapter output. */
export function satsToDecimal(sat: number, decimals: number = 8): string {
  return (sat / 10 ** decimals).toFixed(decimals);
}

// =========================================================================
// Account-wide spending
//
// Moved here from `ltc-wallet.ts` on 2026-08-25 when BTC/DOGE/DASH/BCH
// adopted it. Four copies of a coin-selection routine is exactly the
// duplication BOUNDARIES.md warns about, and coin selection is the code that
// decides how much money moves — the last thing that should exist in four
// slightly-diverging versions.
//
// The split is deliberate: everything up to "which outputs, for what fee" is
// shared and pure; everything after it (PSBT vs hand-rolled serializer,
// witnessUtxo vs nonWitnessUtxo, SIGHASH_FORKID) stays in the adapter,
// because those genuinely differ per chain and pretending otherwise would
// produce a worse abstraction than the duplication.
// =========================================================================

/** One spendable output, tagged with the account path that can sign it. */
export type AccountSpendCandidate = {
  path: string;
  address: string;
  txid: string;
  vout: number;
  valueSat: number;
};

export type AccountSpendPlan = {
  inputs: AccountSpendCandidate[];
  feeSat: number;
  changeSat: number;
  /** True when `inputs` cover amount + fee. False means do not build a tx. */
  covered: boolean;
  /** How much more is needed, when `covered` is false. */
  shortfallSat: number;
};

/**
 * Per-chain transaction sizing, in vBytes.
 *
 * These are NOT interchangeable and the difference is large: a legacy P2PKH
 * input is 148 vB against native SegWit's 68, so a three-input DOGE send
 * budgeted with SegWit constants underpays by ~240 vB and sits unconfirmed.
 * Passing the wrong one is silent — the numbers are all plausible — which is
 * why sizing is a required argument rather than a default.
 */
export type TxSizing = {
  /** Version + locktime + varint counts. */
  overheadVB: number;
  /** One input, including its signature. */
  inputVB: number;
  /** One output. */
  outputVB: number;
};

/** BIP-84 native SegWit (BTC, LTC). Witness discount applies. */
export const P2WPKH_SIZING: TxSizing = { overheadVB: 11, inputVB: 68, outputVB: 31 };

/** Legacy P2PKH (DOGE, DASH, BCH, RVN). No witness discount — 148 vB per input. */
export const P2PKH_SIZING: TxSizing = { overheadVB: 10, inputVB: 148, outputVB: 34 };

/**
 * Choose inputs for an account-wide spend. Pure — no network, no keys.
 *
 * Split out from the adapters for the same reason `planLtcConsolidation` is
 * split out of `consolidateLtcAccount`: the part that decides how much money
 * moves is the part worth testing, and it cannot be tested through a function
 * that signs and broadcasts.
 *
 * **Largest-value-first.** Fewest inputs for the amount, which is both the
 * cheapest fee and the smallest linkage footprint. It is the default in
 * Electrum ("Priority") and close to Bitcoin Core's branch-and-bound fallback.
 *
 * **The fee depends on the answer.** Each input adds `sizing.inputVB`, so a fee
 * computed before selection is already wrong once selection ends — the loop
 * re-checks coverage against a fee recomputed for the current input count.
 *
 * **Dust change is dropped into the fee** rather than created as an output.
 * A change output below the chain's dust threshold costs more to spend later
 * than it holds and bloats the UTXO set; Bitcoin Core, Electrum and every
 * wallet surveyed do the same. `dustSat` is required and varies by an order of
 * magnitude between chains (DOGE 1_000_000, BCH/BTC/LTC 546).
 */
export function planAccountSpend(args: {
  candidates: AccountSpendCandidate[];
  sendSat: number;
  feePerVB: number;
  sizing: TxSizing;
  dustSat: number;
}): AccountSpendPlan {
  const { candidates, sendSat, feePerVB, sizing, dustSat } = args;

  const feeFor = (inputs: number, outputs: number) =>
    Math.ceil(
      feePerVB *
        (sizing.overheadVB + inputs * sizing.inputVB + outputs * sizing.outputVB),
    );

  const pool = [...candidates].sort((a, b) => b.valueSat - a.valueSat);
  const inputs: AccountSpendCandidate[] = [];
  let total = 0;

  for (const c of pool) {
    inputs.push(c);
    total += c.valueSat;

    const feeWithChange = feeFor(inputs.length, 2);
    if (total >= sendSat + feeWithChange) {
      const change = total - sendSat - feeWithChange;
      return change > dustSat
        ? { inputs, feeSat: feeWithChange, changeSat: change, covered: true, shortfallSat: 0 }
        : // Change would be dust: drop the output, let the remainder pay fee.
          { inputs, feeSat: total - sendSat, changeSat: 0, covered: true, shortfallSat: 0 };
    }

    // Might still fit with no change output — one output cheaper.
    const feeNoChange = feeFor(inputs.length, 1);
    if (total >= sendSat + feeNoChange) {
      return { inputs, feeSat: total - sendSat, changeSat: 0, covered: true, shortfallSat: 0 };
    }
  }

  const feeNoChange = feeFor(Math.max(inputs.length, 1), 1);
  return {
    inputs,
    feeSat: feeNoChange,
    changeSat: 0,
    covered: false,
    shortfallSat: sendSat + feeNoChange - total,
  };
}

/** A funded address of the account, with the key node that signs for it. */
export type AccountSpendSource = {
  path: string;
  address: string;
  chainIndex: UtxoChainIndex;
  index: number;
  node: HDKey;
};

/**
 * Scan the account, derive a key per funded address, fetch UTXOs, and plan.
 *
 * The shared half of every `sendFromAccount`. It ends where chains start to
 * differ: the caller gets a plan plus the signing node for each input's
 * address, and builds/signs/broadcasts in whatever shape its chain needs.
 *
 * **Fetching is lazy.** Addresses are visited largest-balance-first and the
 * fetch stops as soon as the plan covers the send. A wallet with many funded
 * indices would otherwise make one explorer call per index on every send,
 * which is the rate-limiting that makes balances flicker.
 *
 * **Refuses on an incomplete scan.** A partial view can miss the very outputs
 * needed and produce a bogus "insufficient funds" over a funded wallet — the
 * same failure account-wide spending exists to remove, with a new cause.
 *
 * **Refuses to sign on a derivation mismatch.** If the key derived for a
 * recorded path does not reproduce the recorded address, something is wrong
 * about which wallet this is; abort rather than sign blind.
 */
export async function gatherAccountSpend(args: {
  mnemonic: string;
  spec: UtxoAccountSpec;
  sendSat: number;
  feePerVB: number;
  sizing: TxSizing;
  dustSat: number;
  gapLimit?: number;
  /** Chain-specific UTXO fetch for one address. MUST throw on failure. */
  fetchUtxos: (
    address: string,
  ) => Promise<Array<{ txid: string; vout: number; valueSat: number }>>;
}): Promise<{
  plan: AccountSpendPlan;
  sources: Map<string, AccountSpendSource>;
  /**
   * Where this send's change belongs: the lowest unused internal-chain index
   * (see `nextChangeIndex`), derived from the same complete scan the inputs
   * came from. Adapters put their change output here rather than at the
   * displayed receive address — the BIP-44 behaviour every surveyed wallet
   * and the swap engine share.
   */
  change: { path: string; address: string; index: number };
  scan: UtxoAccountScan;
}> {
  const scan = await scanUtxoAccount(args.mnemonic, args.spec, {
    gapLimit: args.gapLimit ?? DEFAULT_GAP_LIMIT,
  });
  if (!scan.complete) {
    throw new Error(
      "Could not see the whole account — a block explorer did not answer. " +
        "Sending on a partial view could report a false shortfall, so nothing " +
        "was sent. Try again in a moment.",
    );
  }

  const seed = mnemonicToSeedSync(args.mnemonic.trim(), "");
  const account = HDKey.fromMasterSeed(seed).derive(args.spec.accountPath);

  const changeIndex = nextChangeIndex(scan.entries);
  const [change] = deriveUtxoAddresses(args.mnemonic, args.spec, 1, changeIndex, 1);
  if (!change) throw new Error("Could not derive a change address; nothing was sent.");

  const funded = scan.entries
    .filter((e) => e.balanceSat > 0)
    .sort((a, b) => b.balanceSat - a.balanceSat);

  const sources = new Map<string, AccountSpendSource>();
  const candidates: AccountSpendCandidate[] = [];
  const plan0 = () =>
    planAccountSpend({
      candidates,
      sendSat: args.sendSat,
      feePerVB: args.feePerVB,
      sizing: args.sizing,
      dustSat: args.dustSat,
    });
  let plan = plan0();

  for (const src of funded) {
    const node = account.deriveChild(src.chainIndex).deriveChild(src.index);
    if (!node.privateKey) {
      throw new Error(`No signing key for ${src.path}; nothing was sent.`);
    }
    if (args.spec.deriveAddress(node) !== src.address) {
      throw new Error(
        `Derivation mismatch at ${src.path}: expected ${src.address}. ` +
          "Nothing was sent.",
      );
    }
    sources.set(src.address, {
      path: src.path,
      address: src.address,
      chainIndex: src.chainIndex,
      index: src.index,
      node,
    });

    for (const u of await args.fetchUtxos(src.address)) {
      // Selection arithmetic runs in `number`. DOGE's 1e8 base units over a
      // 140-billion-coin supply can exceed 2^53, where `+` silently stops
      // being exact — and an inexact total is a wrong fee or a wrong change
      // output. Refuse rather than compute something plausible.
      if (!Number.isSafeInteger(u.valueSat)) {
        throw new Error(
          `Output ${u.txid}:${u.vout} is too large to select safely ` +
            "(exceeds 2^53 base units). Nothing was sent.",
        );
      }
      candidates.push({
        path: src.path,
        address: src.address,
        txid: u.txid,
        vout: u.vout,
        valueSat: u.valueSat,
      });
    }
    plan = plan0();
    if (plan.covered) break;
  }

  return { plan, sources, change, scan };
}

/**
 * The standard "insufficient funds" message, phrased against the ACCOUNT.
 *
 * Shared so every chain says the same true thing. A per-address shortfall
 * reported over a funded account is the original bug wearing a different hat,
 * so the numbers here are deliberately account totals.
 */
export function accountShortfallMessage(
  plan: AccountSpendPlan,
  candidatesTotalSat: number,
  candidateCount: number,
  ticker: string,
  decimals = 8,
): string {
  const fmt = (n: number) => (n / 10 ** decimals).toFixed(decimals);
  return (
    `Insufficient funds. The account holds ${fmt(candidatesTotalSat)} ${ticker} ` +
    `across ${candidateCount} spendable output(s); this send needs ` +
    `${fmt(plan.shortfallSat + candidatesTotalSat)} ${ticker} including ~` +
    `${fmt(plan.feeSat)} fee — short by ${fmt(plan.shortfallSat)} ${ticker}.`
  );
}
