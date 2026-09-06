/**
 * **C3.5 — zero-move adoption.** The per-coin strategy for importing the user's
 * own account descriptors into the swap node's wallet, so the node can spend
 * funds that are already on-chain without moving them first.
 *
 * # The measured fact this file exists to carry
 *
 * Descriptor support is **not uniform across the five forks**, and the plan's
 * "zero-move" promise is therefore **per-coin, not global** (contract §4.3
 * item 6, which listed DASH and BCH as unknown). Probed against the real
 * binaries on regtest on {@link ADOPTION_MEASURED_ON}:
 *
 * | coin | `importdescriptors` | `listdescriptors` | import method | read-back |
 * |---|---|---|---|---|
 * | BTC  | yes | yes | `importdescriptors` | verify |
 * | LTC  | yes | **NO** | `importdescriptors` | **skip** |
 * | DOGE | yes | not probed | `importdescriptors` | tolerate |
 * | DASH | yes | not probed | `importdescriptors` | tolerate |
 * | BCH  | **NO** | n/a | `importmulti` (ranged) | tolerate |
 *
 * **LTC is the trap.** It accepts `importdescriptors` and then has no
 * `listdescriptors` to read the result back with. An implementation that
 * verifies by reading back — the obvious way to check an import worked — reads
 * LTC's missing RPC as a failed import and reports a successful import as
 * broken. {@link readBackAbsenceIsFailure} is the single place that rule lives;
 * see also {@link shouldAttemptReadBack}, because for LTC the call must not be
 * made at all rather than made and forgiven.
 *
 * `tolerate` is deliberately distinct from both: DOGE and DASH were **not
 * probed** for `listdescriptors`, so the honest policy is "try it, and treat a
 * method-not-found as no information" — not "assume present" (which would
 * invent a failure) and not "assume absent" (which would silently drop a check
 * that may well work). Promote either to `verify` only after probing it.
 *
 * # This module is advisory, not a gate
 *
 * {@link precheckImport} exists so the UI can explain a refusal *before*
 * spending a round trip and before asking for a password. Rust refuses
 * independently and is the authority. **Never read `ok: true` as permission** —
 * the security properties (§R10 encryption-required, §R12 first-sync) are
 * enforced in `swap_sidecar/descriptors.rs`, and a client-side copy of a check
 * is a UX affordance wearing a gate's clothes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  swapSidecarImportDescriptors,
  type BasicSwapWalletInfo,
  type CoinOptIn,
  type DescriptorImportReport,
  type DexAdoption,
  type EncryptedVault,
} from "../../api/basicswap";

export type { DescriptorImportReport, EncryptedVault };

/** The date the table below was probed against the real binaries on regtest. */
export const ADOPTION_MEASURED_ON = "2026-08-19";

export type DescriptorMethod = "importdescriptors" | "importmulti";

/**
 * What to do about reading the import back.
 *
 * - `verify` — `listdescriptors` is known present. Our branches missing after
 *   an import **is** a failure.
 * - `skip` — `listdescriptors` is known **absent** (LTC). Do not call it; its
 *   absence must never be read as an import failure.
 * - `tolerate` — not probed. Call it, but a method-not-found is no information.
 */
export type ReadBackPolicy = "verify" | "skip" | "tolerate";

export interface CoinAdoptionPlan {
  /** Engine coin name, lowercase. */
  coin: string;
  ticker: string;
  method: DescriptorMethod;
  readBack: ReadBackPolicy;
  /** BIP-43 purpose of the account key: `m/{purpose}'/{slip44}'/0'`. */
  purpose: 84 | 44;
  /** The descriptor function that purpose implies (contract §1.5 item 3). */
  descriptorFn: "wpkh" | "pkh";
  /** `measured` vs `inferred`, per field, so nobody has to guess later which
   *  half of this row came from a live probe. */
  provenance: {
    method: "measured" | "inferred";
    readBack: "measured" | "not-probed";
  };
  note: string;
}

/**
 * Frozen from the regtest probe. Extend only by probing, never by analogy:
 * "DASH is a Bitcoin fork so it must have X" is the reasoning that produced
 * the DOGE/DASH `not-probed` rows in the first place.
 */
const PLANS: Readonly<Record<string, CoinAdoptionPlan>> = {
  btc: {
    coin: "btc",
    ticker: "BTC",
    method: "importdescriptors",
    readBack: "verify",
    purpose: 84,
    descriptorFn: "wpkh",
    provenance: { method: "measured", readBack: "measured" },
    note: "Core semantics throughout; the reference implementation for the other four.",
  },
  ltc: {
    coin: "ltc",
    ticker: "LTC",
    method: "importdescriptors",
    readBack: "skip",
    purpose: 84,
    descriptorFn: "wpkh",
    provenance: { method: "measured", readBack: "measured" },
    note:
      "Accepts importdescriptors but has NO listdescriptors. Skip the read-back " +
      "entirely — treating its absence as a failed import turns a working import " +
      "into a reported fault.",
  },
  doge: {
    coin: "doge",
    ticker: "DOGE",
    method: "importdescriptors",
    readBack: "tolerate",
    purpose: 44,
    descriptorFn: "pkh",
    provenance: { method: "measured", readBack: "not-probed" },
    note: "importdescriptors probed present; listdescriptors was not probed.",
  },
  dash: {
    coin: "dash",
    ticker: "DASH",
    method: "importdescriptors",
    readBack: "tolerate",
    purpose: 44,
    descriptorFn: "pkh",
    provenance: { method: "measured", readBack: "not-probed" },
    note: "importdescriptors probed present; listdescriptors was not probed.",
  },
  bch: {
    coin: "bch",
    ticker: "BCH",
    method: "importmulti",
    readBack: "tolerate",
    purpose: 44,
    descriptorFn: "pkh",
    provenance: { method: "measured", readBack: "not-probed" },
    note:
      "No importdescriptors at all — ranged importmulti is the only route. " +
      "The zero-move promise still holds here, by a different RPC.",
  },
};

/**
 * Default upper index of the imported range, inclusive: descriptors are
 * imported for `0..DEFAULT_RANGE_END` on both branches.
 *
 * **A choice, not a measurement.** 1000 is ~50x the standard BIP-44 gap limit
 * of 20, which covers any realistic external-address history while still being
 * cheap for the daemon to derive. Raise it for a wallet with a very long
 * address history; every increase costs key derivation and rescan time.
 */
export const DEFAULT_RANGE_END = 999;

/**
 * Refusal ceiling for `rangeEnd`. Also a choice: a range in the millions makes
 * the daemon derive millions of keys and looks exactly like a hang.
 */
export const MAX_RANGE_END = 50_000;

// =========================================================================
// Pure helpers
// =========================================================================

/**
 * The plan for a coin, or `null` when there is no measured plan.
 *
 * `null` is a refusal, not a prompt to fall back to BTC's plan. Running BTC's
 * `wpkh` / purpose-84 plan against a coin that needs `pkh` / purpose-44 imports
 * descriptors for addresses the user does not own, and the failure presents as
 * a zero balance rather than an error.
 */
export function adoptionPlanFor(coin: string | null | undefined): CoinAdoptionPlan | null {
  if (typeof coin !== "string") return null;
  return PLANS[coin.trim().toLowerCase()] ?? null;
}

/** Every coin with a measured plan, sorted. */
export function coinsWithAdoptionPlan(): string[] {
  return Object.keys(PLANS).sort();
}

/**
 * The adoption mode a coin should default to.
 *
 * `"descriptor"` for every coin with a plan — including BCH, whose ranged
 * `importmulti` reaches the same zero-move outcome by a different RPC — and
 * `"deposit"` for everything else, because deposit is the only mode that is
 * always available.
 */
export function defaultAdoptionFor(coin: string | null | undefined): DexAdoption {
  return adoptionPlanFor(coin) ? "descriptor" : "deposit";
}

/**
 * Should the importer call `listdescriptors` at all?
 *
 * `false` for LTC. Not "call it and ignore the error" — **do not call it**, so
 * a fork that answers a missing method with something other than a clean
 * method-not-found cannot produce a failure at all.
 */
export function shouldAttemptReadBack(plan: CoinAdoptionPlan | null): boolean {
  return plan != null && plan.readBack !== "skip";
}

/**
 * If the read-back does not find our branches, is that an import failure?
 *
 * Only under `verify`. This is the single rule that keeps LTC's missing
 * `listdescriptors` from being reported as a broken import, and it is separate
 * from {@link shouldAttemptReadBack} so that `tolerate` (probe it, believe
 * nothing) is expressible.
 */
export function readBackAbsenceIsFailure(plan: CoinAdoptionPlan | null): boolean {
  return plan != null && plan.readBack === "verify";
}

/** The two branch labels an import of this plan should report. */
export function expectedBranchLabels(plan: CoinAdoptionPlan | null): string[] {
  if (!plan) return [];
  return [`bip${plan.purpose}-external`, `bip${plan.purpose}-internal`];
}

/** Did the report cover both branches? A one-branch import leaves change
 *  unspendable, which presents as "the balance is wrong", not as an error. */
export function coveredBothBranches(
  plan: CoinAdoptionPlan | null,
  report: DescriptorImportReport | null,
): boolean {
  if (!plan || !report || !Array.isArray(report.imported)) return false;
  const got = new Set(report.imported.map((s) => String(s).toLowerCase()));
  return expectedBranchLabels(plan).every((l) => got.has(l));
}

/** Tokens that must never appear anywhere in a report (contract §R16). */
const KEY_MATERIAL = [/xprv/i, /tprv/i, /yprv/i, /zprv/i, /vprv/i, /\bdesc\b/i, /\bwpkh\(/i, /\bpkh\(/i];

/**
 * Render guard: does this report contain something that looks like key
 * material or a raw descriptor?
 *
 * `DescriptorImportReport.imported` carries **branch labels only** by contract.
 * This is defence in depth against a future Rust change that starts putting
 * descriptor strings in there — a descriptor built from an account xprv *is* a
 * spending key, and this struct is serialized straight to the webview. A `true`
 * here means refuse to render and report a bug, not "redact and carry on".
 */
export function reportContainsKeyMaterial(
  report: DescriptorImportReport | null | undefined,
): boolean {
  if (!report) return false;
  const hay = [
    report.coin,
    report.walletName,
    report.method,
    ...(Array.isArray(report.imported) ? report.imported : []),
    ...(Array.isArray(report.warnings) ? report.warnings : []),
  ].join("\n");
  return KEY_MATERIAL.some((re) => re.test(hay));
}

/** Why an import cannot proceed. Stable identifiers — branch on these, not on
 *  `reason`, which is user-facing copy. */
export type ImportBlockCode =
  | "no-plan"
  | "not-encrypted"
  | "locked"
  | "first-sync-started";

export interface ImportPrecheck {
  ok: boolean;
  code: ImportBlockCode | null;
  /** User-facing sentence. `null` iff `ok`. */
  reason: string | null;
}

/**
 * UX pre-flight for a descriptor import. **Advisory — Rust is the authority.**
 *
 * Refusal order is fixed and tested: no-plan, then encryption, then lock state,
 * then first-sync. When several apply the user is shown the most fundamental
 * one, because fixing a later condition while an earlier one still holds is
 * wasted work — a user who wipes and resyncs a chain only to be told wallet
 * encryption was never configured has been sent down the wrong path by the
 * error message.
 *
 * @param wallet the coin's entry from `/json/wallets`. `null` means "not read
 *        yet", which blocks: we cannot show encryption is on.
 * @param optIn the coin's {@link CoinOptIn}, for `firstSyncStarted`. `null`
 *        means no record, which is the *fresh* case and does not block.
 */
export function precheckImport(a: {
  coin: string;
  wallet: BasicSwapWalletInfo | null;
  optIn: CoinOptIn | null;
}): ImportPrecheck {
  const plan = adoptionPlanFor(a.coin);
  if (!plan) {
    return {
      ok: false,
      code: "no-plan",
      reason:
        `No measured descriptor-import plan for "${a.coin}". Fund this coin by ` +
        "sending to the swap node's deposit address instead.",
    };
  }
  if (!a.wallet || a.wallet.encrypted !== true) {
    return {
      ok: false,
      code: "not-encrypted",
      reason:
        "Wallet encryption must be switched on before any key can be imported. " +
        "After the import this wallet file can spend your existing funds, and " +
        "the encryption password is the only thing protecting it.",
    };
  }
  if (a.wallet.locked === true) {
    return {
      ok: false,
      code: "locked",
      reason:
        "The swap node's wallet is locked. Start the node with wallet " +
        "encryption configured so it unlocks itself, then try again.",
    };
  }
  if (a.optIn?.firstSyncStarted === true) {
    return {
      ok: false,
      code: "first-sync-started",
      reason:
        "This chain has already started syncing, so an import now would find " +
        "nothing: a pruned node cannot rescan history it has discarded. Either " +
        "wipe and resync this coin's chaindata, or switch this coin to the " +
        "consolidation fallback and move the funds once.",
    };
  }
  return { ok: true, code: null, reason: null };
}

export interface ImportOptions {
  /** Inclusive upper index of the imported range. */
  rangeEnd: number;
  /** Descriptor `timestamp`. Omitted means Rust sends `0` (rescan from
   *  genesis) — never `"now"`, which would skip exactly the history the import
   *  exists to find. */
  birthdayUnix?: number;
}

/**
 * Non-secret import options, validated. Deliberately takes **no** password and
 * **no** vault blob: keeping the secret out of every pure/testable surface is
 * what stops it turning up in a snapshot or a log line.
 *
 * @throws RangeError naming the offending value.
 */
export function importOptionsFor(
  coin: string,
  opts: { rangeEnd?: number; birthdayUnix?: number; nowMs?: number } = {},
): ImportOptions {
  const plan = adoptionPlanFor(coin);
  if (!plan) throw new RangeError(`no descriptor-import plan for "${coin}"`);

  const rangeEnd = opts.rangeEnd ?? DEFAULT_RANGE_END;
  if (!Number.isInteger(rangeEnd) || rangeEnd < 0 || rangeEnd > MAX_RANGE_END) {
    throw new RangeError(
      `rangeEnd must be a whole number between 0 and ${MAX_RANGE_END}, got ${rangeEnd}`,
    );
  }

  const out: ImportOptions = { rangeEnd };
  if (opts.birthdayUnix != null) {
    const b = opts.birthdayUnix;
    const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
    if (!Number.isInteger(b) || b < 0) {
      throw new RangeError(`birthdayUnix must be a non-negative whole number, got ${b}`);
    }
    // A future birthday makes the daemon skip every block that could contain
    // the user's funds. The import then "succeeds" and finds nothing — the
    // silent-zero-balance failure §R12 is about, arriving by a second route.
    if (b > nowSec) {
      throw new RangeError(
        `birthdayUnix ${b} is in the future; the rescan would skip every block ` +
          "that could hold your funds",
      );
    }
    out.birthdayUnix = b;
  }
  return out;
}

// =========================================================================
// Hook
// =========================================================================

export interface DescriptorImportState {
  /** Coin currently importing, or `null`. */
  importing: string | null;
  report: DescriptorImportReport | null;
  error: string | null;
  run(a: {
    coin: string;
    encrypted: EncryptedVault;
    password: string;
    rangeEnd?: number;
    birthdayUnix?: number;
  }): Promise<DescriptorImportReport>;
  reset(): void;
}

/**
 * Drive one descriptor import.
 *
 * **The password is a parameter and nothing else.** It is never placed in
 * component state, never stored, never echoed into `error`, and never logged.
 * The caller derives it, passes it, and drops it.
 *
 * Local refusals cost no IPC: no plan, and invalid options. Everything that
 * matters for safety — encryption present, wallet unlocked, first sync not yet
 * started — is checked in Rust; {@link precheckImport} is the UI's mirror of
 * those and should be consulted before offering the button, not instead of the
 * backend check.
 */
export function useDescriptorImport(opts: { enabled: boolean }): DescriptorImportState {
  const { enabled } = opts;
  const [importing, setImporting] = useState<string | null>(null);
  const [report, setReport] = useState<DescriptorImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(
    async (a: {
      coin: string;
      encrypted: EncryptedVault;
      password: string;
      rangeEnd?: number;
      birthdayUnix?: number;
    }): Promise<DescriptorImportReport> => {
      if (!enabled) throw new Error("the swap sidecar is not enabled");
      // Throws for an unknown coin or an out-of-range option — before the
      // password goes anywhere.
      const options = importOptionsFor(a.coin, {
        rangeEnd: a.rangeEnd,
        birthdayUnix: a.birthdayUnix,
      });
      setImporting(a.coin);
      setError(null);
      try {
        const rv = await swapSidecarImportDescriptors({
          coin: a.coin,
          encrypted: a.encrypted,
          password: a.password,
          rangeEnd: options.rangeEnd,
          birthdayUnix: options.birthdayUnix,
        });
        if (reportContainsKeyMaterial(rv)) {
          // Do not render it, do not log it. The report is supposed to carry
          // branch labels only.
          throw new Error(
            "the import report carried something that looks like key material; " +
              "refusing to display it — report this as a bug",
          );
        }
        if (alive.current) setReport(rv);
        return rv;
      } catch (e) {
        const msg =
          typeof e === "string"
            ? e
            : e && typeof e === "object" && "message" in e
              ? String((e as { message: unknown }).message)
              : String(e);
        if (alive.current) setError(msg);
        throw e;
      } finally {
        if (alive.current) setImporting(null);
      }
    },
    [enabled],
  );

  const reset = useCallback(() => {
    setReport(null);
    setError(null);
  }, []);

  return { importing, report, error, run, reset };
}
