/**
 * Chain-agnostic derivation tools.
 *
 * Two capabilities that previously had to be written per chain, which is why
 * they covered so little: paste-to-find reached 4 chains and the funded-path
 * auto-scan reached 5, out of 29. Anything here works for every chain whose
 * adapter implements `deriveAtPath` — including chains added later.
 *
 * The candidate set below encodes the real-world layouts that differ between
 * wallets. It matters because these are not hypothetical: on EVM, the same
 * seed yields five different addresses across MetaMask's first three accounts,
 * Ledger Live, and MEW legacy (verified against the abandon-abandon vector —
 * see the note in `evm-factory.ts`). A user whose funds sit on any of them
 * imports and sees an empty wallet.
 */

import { getAdapter, type ChainType, type WalletInfo } from "../../wallets";
import { DEFAULT_BATCH_SIZE, satsToDecimal } from "../../wallets/utxo-account";

export interface PathCandidate {
  path: string;
  /** What produces this layout, shown to the user. */
  label: string;
}

export interface FoundPath extends PathCandidate {
  address: string;
}

export interface FundedPath extends FoundPath {
  /** Native-unit balance as the adapter formatted it. */
  balance: string;
  /** Numeric form for ranking; NaN-safe. */
  amount: number;
}

/**
 * Substitute account/index into a chain's declared path.
 *
 * Rather than hardcoding layouts per chain, this rewrites the chain's OWN
 * standard path — so it stays correct for a chain whose coin type we've never
 * seen. `m/44'/60'/0'/0/0` with (account=1, index=2) becomes
 * `m/44'/60'/1'/0/2`; a 3-segment path like NEAR's `m/44'/397'/0'` varies only
 * its final hardened component.
 */
function pathVariant(basePath: string, account: number, index: number): string | null {
  const segs = basePath.split("/");
  if (segs[0] !== "m" || segs.length < 3) return null;
  // BIP-44 shape: m / purpose' / coin' / account' / change / index
  if (segs.length >= 6) {
    segs[3] = `${account}'`;
    segs[5] = String(index);
    return segs.join("/");
  }
  // 4-segment (MEW legacy shape): m / purpose' / coin' / account'
  if (segs.length === 4) {
    segs[3] = `${account}'`;
    return segs.join("/");
  }
  // 3-segment: nothing meaningful to vary beyond the account.
  return null;
}

/**
 * Candidate paths to try for a chain, most likely first.
 *
 * Derived from the chain's declared path so every chain gets a sensible sweep
 * without a per-chain table. `accounts` × `indices` bounds the search: the
 * default 3×5 keeps a full sweep at 15 lookups per chain, which is tolerable
 * inside the import spinner. The finder (offline, no network) can afford more.
 */
export function candidatePathsFor(
  chain: ChainType,
  opts: { accounts?: number; indices?: number } = {}
): PathCandidate[] {
  const d = getAdapter(chain).derivation;
  if (d.kind !== "bip39") return [];
  const { accounts = 3, indices = 5 } = opts;

  const out: PathCandidate[] = [];
  const seen = new Set<string>();
  const push = (path: string | null, label: string) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    out.push({ path, label });
  };

  // The chain's own standard first — whatever we already show is candidate #1.
  push(d.path, `${d.standard} (current default)`);

  for (let a = 0; a < accounts; a++) {
    for (let i = 0; i < indices; i++) {
      if (a === 0 && i === 0) continue; // already pushed as the default
      push(
        pathVariant(d.path, a, i),
        a === 0
          ? `Account 1, address ${i + 1}`
          : `Account ${a + 1}, address ${i + 1} (Ledger Live layout)`
      );
    }
  }

  // The CHANGE chain, and deeper receive indices.
  //
  // Until 2026-09-04 this searched `m/…/a'/0/i` only — receive chain, i <= 10 —
  // so it could not place an address from any wallet that ROTATES receive
  // addresses, which is every modern HD wallet. A user pasted their Exodus BCH
  // address and got "No derivation of this seed produces that address", which
  // reads as "wrong seed" and is alarming when the seed is in fact correct.
  // The uncovered scheme was plain BIP-44 rotation.
  //
  // The change chain (`/1/i`) matters for the same reason in reverse: a user
  // reconciling against an explorer often pastes a change address and concludes
  // the wallet has lost track of it.
  const deepIndices = Math.max(indices, 30);
  for (let a = 0; a < accounts; a++) {
    for (const changeLevel of [0, 1] as const) {
      for (let i = 0; i < deepIndices; i++) {
        if (changeLevel === 0 && a === 0 && i === 0) continue; // the default
        const varied = pathVariant(d.path, a, i);
        if (!varied) continue;
        const segs2 = varied.split("/");
        if (segs2.length < 6) continue;
        segs2[segs2.length - 2] = String(changeLevel);
        push(
          segs2.join("/"),
          changeLevel === 0
            ? `Account ${a + 1}, receive address ${i + 1}`
            : `Account ${a + 1}, CHANGE address ${i + 1}`,
        );
      }
    }
  }

  // MEW / MyCrypto legacy drops the change level entirely: m/44'/60'/0'/N.
  const segs = d.path.split("/");
  if (segs.length >= 6) {
    for (let i = 0; i < indices; i++) {
      push(
        `${segs.slice(0, 4).join("/")}/${i}`,
        `Legacy MEW / MyCrypto layout, address ${i + 1}`
      );
    }
  }

  return out;
}

/** Whether the generic tools can work on this chain at all. */
export function supportsPathSearch(chain: ChainType): boolean {
  const a = getAdapter(chain);
  return typeof a.deriveAtPath === "function" && a.derivation.kind === "bip39";
}

/**
 * Offline: find which derivation produces `targetAddress`.
 *
 * Pure key derivation, no network — so it can afford a wider sweep than the
 * balance scan, and it works with no connectivity at all. Case-insensitive
 * because EVM addresses are checksummed and users paste them either way.
 */
export function findPathForAddress(
  chain: ChainType,
  mnemonic: string,
  targetAddress: string,
  opts: { accounts?: number; indices?: number } = { accounts: 6, indices: 11 }
): FoundPath | null {
  const adapter = getAdapter(chain);
  if (!adapter.deriveAtPath) return null;
  const target = targetAddress.trim().toLowerCase();
  if (!target) return null;

  for (const c of candidatePathsFor(chain, opts)) {
    let w: WalletInfo;
    try {
      w = adapter.deriveAtPath(mnemonic, c.path);
    } catch {
      continue; // path shape this chain can't derive — skip, don't abort
    }
    if (w.address.toLowerCase() === target) {
      return { ...c, address: w.address };
    }
  }
  return null;
}

/**
 * Online: probe candidate derivations and return the funded ones, richest
 * first.
 *
 * Returns `null` when EVERY probe failed — the same distinction the chain
 * detectors draw. "We looked and found nothing" and "we couldn't look" must
 * not collapse into the same answer, because the second one silently sends a
 * user to an empty derivation and tells them it's correct.
 */
export async function findFundedPaths(
  chain: ChainType,
  mnemonic: string,
  opts: { accounts?: number; indices?: number } = {}
): Promise<FundedPath[] | null> {
  const adapter = getAdapter(chain);
  if (!adapter.deriveAtPath) return [];

  const candidates = candidatePathsFor(chain, opts);
  let anySucceeded = false;

  const derived: Array<{ c: PathCandidate; address: string }> = [];
  for (const c of candidates) {
    try {
      const w: WalletInfo = adapter.deriveAtPath(mnemonic, c.path);
      derived.push({ c, address: w.address });
    } catch {
      /* path shape this chain can't derive — skip */
    }
  }

  // Balances by address. Filled by the batch path where the chain offers one,
  // then by per-address `getBalance` for whatever is left.
  const balances = new Map<string, string>();

  // Batch path (2026-09-04). The widened sweep is 185 candidates for a UTXO
  // chain, and firing 185 concurrent `getBalance` calls at a per-address
  // explorer is a rate-limit storm — bitcore answered ~10 of them. A chain
  // whose account spec can probe a block of addresses in ONE request
  // (haskoin: BTC, BCH) resolves the whole sweep in a handful of calls. A
  // block whose batch call fails falls through to the per-address path, so
  // this can only remove requests, never answers.
  const batch = adapter.utxoAccounts?.find((s) => typeof s.probeMany === "function");
  let remaining = derived;
  if (batch?.probeMany) {
    const size = Math.max(1, batch.batchSize ?? DEFAULT_BATCH_SIZE);
    const unresolved: typeof derived = [];
    for (let i = 0; i < derived.length; i += size) {
      const block = derived.slice(i, i + size);
      try {
        const r = await batch.probeMany(block.map((d) => d.address));
        if (!Array.isArray(r) || r.length !== block.length) throw new Error("short batch");
        block.forEach((d, k) => balances.set(d.address, satsToDecimal(r[k].balanceSat)));
        anySucceeded = true;
      } catch {
        unresolved.push(...block);
      }
    }
    remaining = unresolved;
  }

  await Promise.all(
    remaining.map(async (d) => {
      try {
        balances.set(d.address, await adapter.getBalance(d.address));
        anySucceeded = true;
      } catch {
        /* probe failed — counted by `anySucceeded` staying false */
      }
    })
  );

  if (!anySucceeded) return null;
  const results: FundedPath[] = [];
  for (const d of derived) {
    const balance = balances.get(d.address);
    if (balance === undefined) continue;
    const amount = parseFloat(balance);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    results.push({ ...d.c, address: d.address, balance, amount });
  }
  return results.sort((a, b) => b.amount - a.amount);
}
