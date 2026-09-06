/**
 * Every classic UTXO adapter must declare `utxoAccounts`.
 *
 * ## Why this exists
 *
 * `src/App.tsx` branches on `adapter.utxoAccounts`: declared → account-wide
 * balance via `resolveUtxoAccountBalance`; absent → `getBalance(wallet.address)`
 * on index 0 alone. The field is optional, so **omitting it is silent**. There
 * is no error, no warning, and no type complaint — the chain simply reports the
 * balance of one address as though it were the wallet's.
 *
 * That is a strictly worse failure than the sibling send gap. An
 * account-unaware SEND fails loudly and recoverably ("No spendable UTXOs
 * available for this address"). An account-unaware BALANCE shows a number that
 * is too low, with nothing to act on.
 *
 * On 2026-08-22 five UTXO chains were converted. **Ravencoin was missed** and
 * stayed single-address for three days, found only when someone asked whether
 * other chains had the same defect. Nothing in the codebase could have said so:
 * the check was "did we remember all of them", which is not a check.
 *
 * ## How membership is decided
 *
 * Not by a hand-maintained list — that is the thing that failed. The set is
 * derived from the source: an adapter that builds addresses with
 * `bitcoin.payments.p2*` (Bitcoin-script) or `cashaddr` (BCH) is a classic
 * BIP-32 UTXO chain with a receive/change chain convention, and therefore can
 * scatter across derivation indices.
 *
 * Ergo is deliberately NOT matched. It is UTXO-shaped (eUTXO boxes) but has
 * neither Bitcoin-script addresses nor the BIP-44 receive/change chain pair
 * that `UtxoAccountSpec` models, so `scanUtxoAccount` does not apply to it as
 * written. It carries its own single-address assumption; see the note at the
 * bottom of this file.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAdapter } from "./index";
import type { ChainType } from "./types";

const WALLET_DIR = resolve(__dirname);

/** Adapter source files that derive Bitcoin-script or CashAddr addresses. */
function classicUtxoWalletFiles(): string[] {
  return readdirSync(WALLET_DIR)
    .filter((f) => /-wallet\.ts$/.test(f) && !/\.test\.ts$/.test(f))
    .filter((f) => {
      const src = readFileSync(join(WALLET_DIR, f), "utf8");
      return src.includes("bitcoin.payments.p2") || src.includes("cashaddr");
    });
}

/** `btc-wallet.ts` -> the ChainType its adapter reports. */
function chainOf(file: string): ChainType | null {
  const src = readFileSync(join(WALLET_DIR, file), "utf8");
  const m = /^\s*chain:\s*"([a-z-]+)"/m.exec(src);
  return (m?.[1] as ChainType) ?? null;
}

describe("UTXO adapters all scan the account, not one address", () => {
  it("finds the classic UTXO adapters by source, not by memory", () => {
    // The control. If the detector matched nothing (or everything), the real
    // assertion below would pass or fail for reasons unrelated to coverage.
    const files = classicUtxoWalletFiles();
    expect(files.length, "detector matched no adapters — the marker changed")
      .toBeGreaterThanOrEqual(6);
    for (const expected of [
      "btc-wallet.ts",
      "ltc-wallet.ts",
      "doge-wallet.ts",
      "dash-wallet.ts",
      "bch-wallet.ts",
      "rvn-wallet.ts",
    ]) {
      expect(files, `${expected} must be detected as a UTXO adapter`).toContain(expected);
    }
    // Ergo must NOT be swept in: `UtxoAccountSpec` does not model eUTXO boxes.
    expect(files).not.toContain("erg-wallet.ts");
  });

  it("every one of them declares utxoAccounts", () => {
    // The Ravencoin regression, pinned. A chain that reaches this list without
    // an account spec silently reports one address's balance as the wallet's.
    const missing = classicUtxoWalletFiles()
      .map((f) => ({ file: f, chain: chainOf(f) }))
      .filter(({ chain }) => chain && !getAdapter(chain).utxoAccounts)
      .map(({ file }) => file);
    expect(
      missing,
      "these adapters derive UTXO addresses but have no `utxoAccounts`, so " +
        "src/App.tsx will read their balance from index 0 alone — add an " +
        "account spec (see `rvnUtxoAccounts` for the smallest example)",
    ).toEqual([]);
  });

  it("each account spec covers the address the wallet actually displays", () => {
    // An account spec that does not derive the displayed address is worse than
    // none: the scan reports a confident total for a DIFFERENT account. Every
    // spec's index-0 receive address must be reachable, which is what
    // `resolveUtxoAccountBalance` relies on when it reconciles against
    // `wallet.address`.
    for (const file of classicUtxoWalletFiles()) {
      const chain = chainOf(file);
      if (!chain) continue;
      const specs = getAdapter(chain).utxoAccounts!;
      expect(specs.length, `${chain} declares an empty account list`).toBeGreaterThan(0);
      for (const spec of specs) {
        expect(spec.chain, `${file}: spec.chain must match the adapter`).toBe(chain);
        expect(spec.accountPath, `${file}: account path must be 3 levels (m/p'/c'/a')`)
          .toMatch(/^m(\/\d+'){3}$/);
        expect(typeof spec.probe, `${file}: spec needs a probe`).toBe("function");
      }
    }
  });
});

/**
 * NOT COVERED, on purpose, and recorded so it is a decision rather than an
 * oversight: **Ergo** (`erg-wallet.ts`) derives a single address at
 * `m/44'/429'/0'/0/0` and its `getBalance` reads that address alone. Its send
 * returns change to `fromAddress` (address reuse) and it is not a BasicSwap
 * coin, so it cannot scatter itself — the same argument that makes DOGE/DASH/
 * BCH/RVN low-risk rather than no-risk. An Ergo seed imported from a wallet
 * that used fresh change addresses would under-report. Fixing it needs an
 * eUTXO-shaped account model, not `UtxoAccountSpec`, which is why it is a
 * separate piece of work and not a line in this test.
 */
