/**
 * Account-wide balance resolution for the UTXO chains (2026-08-22).
 *
 * Sits between `utxo-account.ts` (the walk) and the dashboard sweep. Its job
 * is to answer "what does this wallet hold" **without** issuing a full
 * gap-limit walk on every refresh — that would be ~80 explorer requests per
 * coin against the same keyless hosts the 27-chain sweep already shares a
 * rate-limit bucket with.
 *
 * # The escalation rule
 *
 * A never-used account cannot have change hiding in it, so it costs ONE probe:
 *
 *   1. Probe the primary account's receive/0 — the address the app displays.
 *   2. If it has no history and no balance, the account is untouched. Done.
 *   3. If it has ANY history, something has spent or received here, so change
 *      may exist at an arbitrary index → run the full gap walk, once, and
 *      persist which addresses turned out to matter.
 *   4. Later refreshes re-probe the persisted addresses PLUS a lookahead
 *      window past the highest used index on each chain (2026-09-04 — see
 *      `CHEAP_LOOKAHEAD_*`). With a batch probe that is two requests for the
 *      whole account; without one it is the touched set plus a few. Any
 *      activity on an address the last deep scan did not know about
 *      escalates straight back to step 3.
 *
 * Step 3's trigger is history, not balance, and that is deliberate: the
 * operator's LTC receive/0 read `0` with two transactions behind it — funded,
 * then spent with the change going to internal/20. Keying on balance would
 * have skipped the walk on precisely the wallet that needed it.
 *
 * # What callers must respect
 *
 * `complete: false` means the scan could not see everything (a source failed
 * mid-walk). `totalSat` is then a LOWER BOUND, not a balance, and rendering it
 * as a balance would recreate the bug this module exists to remove — a
 * confident number about a wallet nobody actually finished looking at.
 */
import type { ChainType } from "./types";
import {
  scanUtxoAccount,
  probeAddresses,
  deriveUtxoAddresses,
  analyzeRecoveryRisk,
  satsToDecimal,
  DEFAULT_GAP_LIMIT,
  type UtxoAccountSpec,
  type UtxoAddressEntry,
  type UtxoChainIndex,
} from "./utxo-account";

const STORE_FILE = "utxo-accounts.json";

/** How long a deep scan stays authoritative before the next one is due. */
export const DEEP_SCAN_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * How far past the highest used index the CHEAP path looks, per chain.
 *
 * # The blind spot this closes (2026-09-04)
 *
 * The cheap path used to re-probe only the addresses a past deep scan found.
 * Anything that landed on a NEW index in the meantime — the swap engine's
 * change after a swap, a deposit to a rotated receive address, this wallet's
 * own change now that it goes to the internal chain — was invisible for up to
 * `DEEP_SCAN_TTL_MS` (six hours), during which the dashboard confidently
 * showed a total that was missing real money. That is the 2026-08-22 LTC
 * incident on a timer.
 *
 * Every Electrum-family wallet keeps `gap_limit` unused addresses under watch
 * beyond the last used one on BOTH chains (Electrum `synchronize_sequence`,
 * BlueWallet `_fetchBalance`'s `next_free + gap_limit` loop, Sparrow's
 * `getLookAheadIndex`). This is the polling equivalent. The window is wide
 * when the spec can probe a block in one request and narrow when every
 * address is a request of its own — a balance refresh runs every minute.
 */
export const CHEAP_LOOKAHEAD_BATCH = 20;
/**
 * Narrow on purpose. A per-address source pays one request per index every
 * minute, and DOGE/DASH share BlockCypher's ~100-requests-per-hour keyless
 * cap. Two is enough for the case this wallet can cause itself — its own
 * change goes to the LOWEST unused internal index, which is never past
 * `maxUsed + 1` — and for the engine's PATCH-9 allocator, which follows the
 * same rule. A stock MAX+1 allocator with a 20-wide pool can still land
 * beyond this window; the six-hourly deep walk is what catches that case.
 */
export const CHEAP_LOOKAHEAD_SERIAL = 2;

/**
 * With a batch probe the cheap path re-probes the WHOLE used range densely
 * (0..maxUsed+lookahead on each chain) rather than only the touched entries —
 * a payment to an old, emptied address is as real as one to a fresh index —
 * as long as that costs no more than this many addresses (= 2 requests).
 * Beyond it, fall back to touched entries + the lookahead window.
 */
export const CHEAP_DENSE_CAP = 100;

export interface UtxoAccountSummary {
  chain: ChainType;
  /** Sum across every account scanned. */
  totalSat: number;
  /** Decimal string, adapter-compatible. */
  balance: string;
  /** Funded or previously-used addresses, for the recovery surface. */
  entries: UtxoAddressEntry[];
  /** How many addresses were probed to produce this. */
  scanned: number;
  /** False = a source failed; `totalSat` is a lower bound, not a balance. */
  complete: boolean;
  /** True when a full gap walk ran (vs. the cheap known-address refresh). */
  deep: boolean;
  /** Funds a stock gap-limit-20 seed restore would NOT find. */
  strandedSat: number;
  strandedEntries: UtxoAddressEntry[];
  /** Minimum gap limit a third-party wallet needs to see everything. */
  requiredGapLimit: number;
}

interface StoredAccountState {
  /** The displayed address, so a wallet switch invalidates the record. */
  fingerprint: string;
  entries: Array<{
    path: string;
    address: string;
    chainIndex: UtxoChainIndex;
    index: number;
  }>;
  deepScannedAt: number;
}

/**
 * Resolve the account balance for one UTXO chain.
 *
 * `force` runs the full walk regardless of the escalation rule and regardless
 * of TTL — that is what a user-triggered "Rescan" does. `allAccounts` widens
 * the walk to every spec the adapter lists (e.g. LTC's legacy BIP-44 account
 * as well as its BIP-84 default); it is off by default because it doubles the
 * request count and only matters when hunting for funds under another
 * derivation.
 */
export async function resolveUtxoAccountBalance(
  chain: ChainType,
  specs: ReadonlyArray<UtxoAccountSpec>,
  mnemonic: string,
  displayedAddress: string,
  opts?: { force?: boolean; allAccounts?: boolean; gapLimit?: number },
): Promise<UtxoAccountSummary> {
  const primary = specs[0];
  if (!primary) throw new Error(`${chain}: no UTXO account spec`);
  const gapLimit = opts?.gapLimit ?? DEFAULT_GAP_LIMIT;
  const useSpecs = opts?.allAccounts ? specs : [primary];

  const stored = await readAccountState(chain);
  const fresh =
    stored &&
    stored.fingerprint === displayedAddress &&
    Date.now() - stored.deepScannedAt < DEEP_SCAN_TTL_MS;

  // ── Cheap path: what a previous deep scan found, plus a lookahead ──────
  if (!opts?.force && fresh && stored) {
    const candidates = cheapCandidates(mnemonic, primary, stored.entries);
    const probed = await probeAddresses(primary, candidates);
    if (!probed.complete) {
      return summarize(chain, touchedOnly(probed.entries), false, candidates.length, false);
    }
    // NEW activity on an address the last deep scan did not know about means
    // the persisted picture is stale — something (the swap engine, another
    // wallet on this seed, our own change) has moved past it. Re-walk now
    // rather than trust a window that just proved itself too narrow; the deep
    // walk is what discovers everything beyond the window, and it re-persists.
    // This is Electrum's `synchronize` rule: an old address inside the
    // lookahead means generate (here: probe) more.
    const knownAddrs = new Set(stored.entries.map((e) => e.address));
    const surprise = probed.entries.some(
      (e) => !knownAddrs.has(e.address) && (e.used || e.balanceSat > 0),
    );
    if (!surprise) {
      return summarize(chain, touchedOnly(probed.entries), true, candidates.length, false);
    }
    // fall through to the deep walk
  }

  // ── Escalation gate: one probe decides whether a walk is needed ────────
  if (!opts?.force && !opts?.allAccounts) {
    const [recv0] = deriveUtxoAddresses(mnemonic, primary, 0, 0, 1);
    const probed = await probeAddresses(primary, [{ ...recv0, chainIndex: 0 }]);
    const only = probed.entries[0];
    if (probed.complete && only && !only.used && only.balanceSat === 0) {
      // Untouched account: no history anywhere means no change anywhere.
      await writeAccountState(chain, {
        fingerprint: displayedAddress,
        entries: [],
        deepScannedAt: Date.now(),
      });
      return summarize(chain, [], true, 1, false);
    }
  }

  // ── Deep path: full gap walk ───────────────────────────────────────────
  const scans = [];
  for (const spec of useSpecs) {
    scans.push(await scanUtxoAccount(mnemonic, spec, { gapLimit }));
  }
  const entries = scans.flatMap((s) => s.entries);
  const complete = scans.every((s) => s.complete);
  const scanned = scans.reduce((n, s) => n + s.scanned, 0);

  if (complete) {
    await writeAccountState(chain, {
      fingerprint: displayedAddress,
      entries: entries.map((e) => ({
        path: e.path,
        address: e.address,
        chainIndex: e.chainIndex,
        index: e.index,
      })),
      deepScannedAt: Date.now(),
    });
  }
  return summarize(chain, entries, complete, scanned, true);
}

/** Only addresses with history or a balance — the empty tail is not "where
 *  the money is", and it is what the recovery card lists. Pure. */
export function touchedOnly(entries: ReadonlyArray<UtxoAddressEntry>): UtxoAddressEntry[] {
  return entries.filter((e) => e.used || e.balanceSat > 0);
}

/**
 * The address set the cheap path re-probes. Pure (derivation only), exported
 * so the window can be asserted on without a network.
 *
 * Per chain: the touched entries a past deep scan recorded, PLUS every index
 * from `maxUsed + 1` through `maxUsed + lookahead` — where the next change
 * output or rotated-receive deposit can land. With a batch probe the whole
 * range `0..maxUsed + lookahead` is probed densely (an emptied address can be
 * paid again) while it fits {@link CHEAP_DENSE_CAP}. Receive/0 is always
 * included: it is the address the user was shown before rotation existed and
 * may still be handing out.
 */
export function cheapCandidates(
  mnemonic: string,
  spec: UtxoAccountSpec,
  known: ReadonlyArray<{ path: string; address: string; chainIndex: UtxoChainIndex; index: number }>,
): Array<{ path: string; address: string; chainIndex: UtxoChainIndex; index: number }> {
  // An account with NO history costs one probe, as it always did. Nothing can
  // be hiding past receive/0 on an account that has never received: change
  // needs a spend, a spend needs a receipt, and a rotated receive address is
  // only ever handed out once index 0 is used — all of which would show up as
  // history on receive/0 and escalate through the gate below. Widening the
  // window here would multiply every empty DOGE/DASH account's refresh cost
  // by ~5 against BlockCypher's hourly cap, for nothing.
  if (known.length === 0) {
    const [recv0] = deriveUtxoAddresses(mnemonic, spec, 0, 0, 1);
    return [{ ...recv0, chainIndex: 0 }];
  }
  const batch = typeof spec.probeMany === "function";
  const lookahead = batch ? CHEAP_LOOKAHEAD_BATCH : CHEAP_LOOKAHEAD_SERIAL;
  const out: Array<{ path: string; address: string; chainIndex: UtxoChainIndex; index: number }> = [];
  const seen = new Set<string>();
  const push = (e: { path: string; address: string; chainIndex: UtxoChainIndex; index: number }) => {
    if (seen.has(e.address)) return;
    seen.add(e.address);
    out.push(e);
  };

  for (const chainIndex of [0, 1] as UtxoChainIndex[]) {
    const onChain = known.filter((k) => k.chainIndex === chainIndex);
    const maxUsed = onChain.reduce((m, k) => Math.max(m, k.index), -1);
    const top = maxUsed + lookahead; // inclusive
    if (batch && top + 1 <= CHEAP_DENSE_CAP) {
      for (const d of deriveUtxoAddresses(mnemonic, spec, chainIndex, 0, top + 1)) {
        push({ ...d, chainIndex });
      }
      continue;
    }
    if (chainIndex === 0) {
      const [recv0] = deriveUtxoAddresses(mnemonic, spec, 0, 0, 1);
      push({ ...recv0, chainIndex: 0 });
    }
    for (const k of onChain) push(k);
    for (const d of deriveUtxoAddresses(mnemonic, spec, chainIndex, maxUsed + 1, lookahead)) {
      push({ ...d, chainIndex });
    }
  }
  return out;
}

function summarize(
  chain: ChainType,
  entries: UtxoAddressEntry[],
  complete: boolean,
  scanned: number,
  deep: boolean,
): UtxoAccountSummary {
  const totalSat = entries.reduce((s, e) => s + e.balanceSat, 0);
  const risk = analyzeRecoveryRisk({ entries });
  return {
    chain,
    totalSat,
    balance: satsToDecimal(totalSat),
    entries,
    scanned,
    complete,
    deep,
    strandedSat: risk.strandedSat,
    strandedEntries: risk.strandedEntries,
    requiredGapLimit: risk.requiredGapLimit,
  };
}

// ── Persistence (best-effort; never throws) ──────────────────────────────

type StoreLike = {
  get<T>(key: string): Promise<T | null | undefined>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
};

let _store: Promise<StoreLike | null> | null = null;
function getStore(): Promise<StoreLike | null> {
  if (!_store) {
    _store = import("@tauri-apps/plugin-store")
      .then((m) => m.Store.load(STORE_FILE) as unknown as Promise<StoreLike>)
      .catch(() => null);
  }
  return _store;
}

async function readAccountState(chain: ChainType): Promise<StoredAccountState | null> {
  try {
    const store = await getStore();
    if (!store) return null;
    const v = await store.get<StoredAccountState>(chain);
    if (!v || typeof v.fingerprint !== "string" || !Array.isArray(v.entries)) {
      return null;
    }
    return v;
  } catch {
    return null;
  }
}

async function writeAccountState(
  chain: ChainType,
  state: StoredAccountState,
): Promise<void> {
  try {
    const store = await getStore();
    if (!store) return;
    await store.set(chain, state);
    await store.save();
  } catch {
    /* cache write failure is non-fatal */
  }
}
