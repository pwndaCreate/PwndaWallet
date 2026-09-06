import { describe, expect, it } from "vitest";
import {
  DERIVATION_PROFILES,
  PROFILE_IDS,
  schemeFor,
  divergentCoins,
  isTrustedWithoutProbe,
  fingerprintProfile,
  type ProfileCoin,
} from "./derivation-profiles";

/**
 * Phase 0 lock for the derivation-profile registry. This is the single
 * source of truth for "what path does wallet X use for coin Y", with a
 * confidence level that gates auto-application (funds-safety).
 */
describe("derivation profiles — registry", () => {
  it("exposes standard / exodus / atomic", () => {
    expect(PROFILE_IDS).toEqual(["standard", "exodus", "atomic"]);
  });

  it("every non-standard override exists in standard (clean fallback)", () => {
    for (const pid of ["exodus", "atomic"] as const) {
      for (const coin of Object.keys(DERIVATION_PROFILES[pid].schemes) as ProfileCoin[]) {
        expect(schemeFor("standard", coin)).toBeDefined();
      }
    }
  });

  it("Exodus diverges on ADA / SOL / LTC / XRP / RVN / TRX (NOT XLM)", () => {
    const d = new Set(divergentCoins("exodus"));
    for (const c of ["cardano", "solana", "litecoin", "xrp", "ravencoin", "tron"] as ProfileCoin[]) {
      expect(d.has(c)).toBe(true);
    }
    // XLM does NOT diverge: Phase 4 research (SEP-0005 + SLIP-0010) confirmed
    // Exodus uses the standard m/44'/148'/0' — a non-hardened ed25519 tail is
    // structurally invalid, so there is no Exodus Stellar override.
    expect(d.has("stellar")).toBe(false);
    // Universally-matching coins inherit Standard (not divergent).
    expect(d.has("dogecoin")).toBe(false);
    expect(d.has("ethereum")).toBe(false);
    expect(d.has("bitcoin-cash")).toBe(false);
  });

  it("standard has no divergence from itself", () => {
    expect(divergentCoins("standard")).toEqual([]);
  });

  it("only standard/verified schemes are trusted without an on-chain probe", () => {
    expect(isTrustedWithoutProbe(schemeFor("standard", "dogecoin"))).toBe(true);
    expect(isTrustedWithoutProbe(schemeFor("exodus", "cardano"))).toBe(true); // verified vector
    expect(isTrustedWithoutProbe(schemeFor("exodus", "xrp"))).toBe(false); // published, unverified
    expect(isTrustedWithoutProbe(schemeFor("exodus", "solana"))).toBe(false); // inferred
    expect(isTrustedWithoutProbe(schemeFor("atomic", "litecoin"))).toBe(false); // published (vendor-confirmed reused coin-type, no seed→address vector yet)
  });

  it("schemeFor falls back to Standard for non-overridden coins", () => {
    expect(schemeFor("exodus", "dogecoin")).toEqual(schemeFor("standard", "dogecoin"));
    expect(schemeFor("atomic", "hedera")).toEqual(schemeFor("standard", "hedera"));
  });

  it("every scheme sets exactly one of choiceId / path", () => {
    for (const pid of PROFILE_IDS) {
      for (const coin of Object.keys(DERIVATION_PROFILES[pid].schemes) as ProfileCoin[]) {
        const s = DERIVATION_PROFILES[pid].schemes[coin]!;
        expect(Boolean(s.choiceId) !== Boolean(s.path)).toBe(true); // XOR
      }
    }
  });

  it("the five flexible coins use choiceId; the rest use raw paths", () => {
    for (const coin of ["bitcoin", "solana", "cardano", "algorand", "litecoin"] as ProfileCoin[]) {
      expect(schemeFor("standard", coin).choiceId).toBeTruthy();
    }
    for (const coin of ["xrp", "tron", "dash", "ravencoin", "stellar"] as ProfileCoin[]) {
      expect(schemeFor("standard", coin).path).toBeTruthy();
    }
  });
});

describe("fingerprintProfile — detection → source wallet", () => {
  it("a verified Exodus-Cardano signal fingerprints Exodus, strongly", () => {
    const fp = fingerprintProfile({ cardano: "exodus-cardano", solana: "phantom" });
    expect(fp.profile).toBe("exodus");
    expect(fp.strong).toBe(true);
    expect(fp.corroborating).toContain("cardano");
  });

  it("Exodus LTC + SOL signals corroborate Exodus (not strong without a verified coin)", () => {
    const fp = fingerprintProfile({ litecoin: "bip44-legacy", solana: "exodus" });
    expect(fp.profile).toBe("exodus");
    expect(fp.corroborating.sort()).toEqual(["litecoin", "solana"]);
    expect(fp.strong).toBe(false);
  });

  it("Atomic BTC-legacy + SOL-cli fingerprints Atomic", () => {
    const fp = fingerprintProfile({ bitcoin: "bip44", solana: "cli" });
    expect(fp.profile).toBe("atomic");
    expect(fp.corroborating.sort()).toEqual(["bitcoin", "solana"]);
  });

  it("all-standard signals fingerprint Standard", () => {
    const fp = fingerprintProfile({ bitcoin: "bip84", solana: "phantom", cardano: "cip1852" });
    expect(fp.profile).toBe("standard");
    expect(fp.corroborating).toEqual([]);
  });

  it("ALGO=exodus does NOT fingerprint Exodus (Standard ALGO already IS exodus)", () => {
    const fp = fingerprintProfile({ algorand: "exodus" });
    expect(fp.profile).toBe("standard");
  });

  it("a strong (verified) signal outranks more numerous weak ones", () => {
    // ADA verified (Exodus) vs BTC+SOL published (Atomic): Exodus wins.
    const fp = fingerprintProfile({
      cardano: "exodus-cardano",
      bitcoin: "bip44",
      solana: "cli",
    });
    expect(fp.profile).toBe("exodus");
    expect(fp.strong).toBe(true);
  });
});
