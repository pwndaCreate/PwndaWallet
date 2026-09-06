import { describe, it, expect } from "vitest";
import {
  getPoolById,
  getPoolsForCoin,
  getDefaultPoolId,
  buildCredentials,
  poolHostPort,
  HOUSE_DEFAULT_POOL,
  resolveDefaultPool,
} from "./pools";
import { getStatsAdapter } from "./pool-stats";

/**
 * Funds-adjacent regression lock for the in-house Pwnda Zephyr pool
 * (mine.pwnda.org:17706). A wrong endpoint, missing TLS flag, or wrong
 * username/password convention would silently point hashes at the wrong
 * place or the wrong account, so the exact connection contract is pinned.
 *
 *   xmrig -o mine.pwnda.org:17706 -u <ZEPH addr> -p <worker> -a rx/0 --tls
 *
 * PORT MIGRATION 2026-07-07: 20871 → 17706. The old port is closed on every
 * pwnda hostname (mine/stratum/pool/ravencoin — all time out); 17706 was
 * verified live (TLS 1.3, Let's Encrypt CN=pwnda.org, stratum `login` for
 * rx/0 → `status:"OK"` + a real job). The assertion below is what stops a
 * silent regression back to the dead port.
 */
const ZEPH_ADDR = "ZEPHYRtestaddr0000000000000000000000000000000000000000000000000000";

describe("Pwnda Zephyr pool (mine.pwnda.org:17706)", () => {
  it("is registered with the exact TLS RandomX connection config", () => {
    const pool = getPoolById("pwnda-zephyr");
    expect(pool).toBeDefined();
    expect(pool!.coin).toBe("zephyr");
    expect(pool!.algorithm).toBe("randomx"); // → xmrig `-a rx/0`
    expect(pool!.endpoint).toBe("stratum+ssl://mine.pwnda.org:17706");
    expect(pool!.ssl).toBe(true); // drives xmrig `--tls`
    expect(poolHostPort(pool!.endpoint)).toBe("mine.pwnda.org:17706");
  });

  it("does NOT point at the retired 20871 port", () => {
    const pool = getPoolById("pwnda-zephyr")!;
    expect(pool.endpoint).not.toContain("20871");
  });

  it("is an available Zephyr pool AND the house default (2026-08-29)", () => {
    const zeph = getPoolsForCoin("zephyr", "randomx");
    expect(zeph.some((p) => p.id === "pwnda-zephyr")).toBe(true);
    // CORRECTED 2026-08-29 — this test used to pin the OPPOSITE fact ("NOT the
    // default"), which was exactly the bug: Pwnda's "—" min payout (no
    // live-stats adapter, not a real number) sank it to the bottom of the
    // ascending-payout sort, so simple mode pre-filled HeroMiners on a user's
    // very first ZEPH session. `HOUSE_DEFAULT_POOL` is now a policy override
    // that sits ahead of the payout sort WITHOUT touching `minPayout` — the
    // sort itself stays honest for every pool that has a real number.
    expect(getDefaultPoolId("zephyr", "randomx")).toBe("pwnda-zephyr");
  });

  it("builds credentials as `-u <ZEPH address> -p <worker>` (no prefix, no .worker)", () => {
    const pool = getPoolById("pwnda-zephyr")!;
    const { user, pass } = buildCredentials({
      pool,
      address: ZEPH_ADDR,
      worker: "rig1",
      coinPrefix: "ZEPH",
    });
    expect(user).toBe(ZEPH_ADDR); // plain address — no `.rig1` suffix, no `ZEPH:` prefix
    expect(pass).toBe("rig1"); // worker name goes in the password field
  });

  it("has no live-stats adapter yet → PoolStatsPanel hides gracefully (no error)", () => {
    expect(getStatsAdapter("pwnda-zephyr")).toBeNull();
  });
});

/**
 * Funds-adjacent regression lock for the in-house Pwnda Zano pool
 * (zano.pwnda.org:17706), mirroring the Zephyr block above. Added 2026-08-29
 * alongside `HOUSE_DEFAULT_POOL`.
 *
 * Live-verified via a real TLS 1.3 handshake + stratum `login` for algo
 * `progpowz` on 2026-08-29 (same wildcard `*.pwnda.org` cert as the Zephyr
 * endpoint): the pool answered with a JSON-RPC error rejecting the placeholder
 * test address — i.e. it parsed and processed the login, which is the
 * connectivity+protocol proof; it is not evidence about any real address.
 */
const ZANO_ADDR = "ZxTestZanoAddr00000000000000000000000000000000000000000000000000";

describe("Pwnda Zano pool (zano.pwnda.org:17706)", () => {
  it("is registered with the exact TLS ProgPowZ connection config", () => {
    const pool = getPoolById("pwnda-zano");
    expect(pool).toBeDefined();
    expect(pool!.coin).toBe("zano");
    expect(pool!.algorithm).toBe("progpowz"); // → SRBMiner-MULTI's zano algo
    expect(pool!.endpoint).toBe("stratum+ssl://zano.pwnda.org:17706");
    expect(pool!.ssl).toBe(true); // drives the `--tls true` flag
    expect(poolHostPort(pool!.endpoint)).toBe("zano.pwnda.org:17706");
  });

  it("is an available Zano pool AND the house default", () => {
    const zano = getPoolsForCoin("zano", "progpowz");
    expect(zano.some((p) => p.id === "pwnda-zano")).toBe(true);
    expect(getDefaultPoolId("zano", "progpowz")).toBe("pwnda-zano");
  });

  it("builds credentials as `-u <ZANO address> -p <worker>` (no prefix, no .worker)", () => {
    const pool = getPoolById("pwnda-zano")!;
    const { user, pass } = buildCredentials({
      pool,
      address: ZANO_ADDR,
      worker: "rig1",
      coinPrefix: "ZANO",
    });
    expect(user).toBe(ZANO_ADDR);
    expect(pass).toBe("rig1");
  });

  it("has no live-stats adapter yet → PoolStatsPanel hides gracefully (no error)", () => {
    expect(getStatsAdapter("pwnda-zano")).toBeNull();
  });
});

describe("HOUSE_DEFAULT_POOL — a policy override, not a fabricated payout", () => {
  it("names exactly ZEPH and ZANO, each pointing at a real registered pool", () => {
    expect(Object.keys(HOUSE_DEFAULT_POOL).sort()).toEqual(["zano", "zephyr"]);
    for (const [coin, id] of Object.entries(HOUSE_DEFAULT_POOL)) {
      expect(getPoolById(id as string)?.coin).toBe(coin);
    }
  });

  it("does not touch minPayout — the ascending-payout sort stays honest", () => {
    // Pwnda's own entries are still "—" (unknown/no live-stats adapter); the
    // override wins via getDefaultPoolId, not by editing this field. If this
    // ever changes to a real number that would be a separate, verifiable claim.
    expect(getPoolById("pwnda-zephyr")!.minPayout).toBe("—");
    expect(getPoolById("pwnda-zano")!.minPayout).toBe("—");
  });

  it("does not change the default for coins with no house pool (XMR/RVN/CFX/ERG)", () => {
    // Pinned against the pre-existing (unchanged) registry-order default for
    // each coin, not against a hand-picked pool name — the point of this test
    // is that these four are untouched, whatever their default already was.
    for (const [coin, algo] of [
      ["monero", "randomx"],
      ["ravencoin", "kawpow"],
      ["conflux", "octopus"],
      ["ergo", "autolykos"],
    ] as const) {
      const expected = getPoolsForCoin(coin, algo)[0]?.id;
      expect(getDefaultPoolId(coin, algo)).toBe(expected);
      expect(getDefaultPoolId(coin, algo)).not.toContain("pwnda");
    }
  });
});

describe("resolveDefaultPool — house default must survive real usage history", () => {
  /**
   * The exact bug reported 2026-08-29 after the FIRST house-default fix
   * shipped: "I still see hero miners as default for pool for zano." The
   * wallet had genuine prior ZANO mining history, so `mostUsedPoolFor`
   * returned `herominers-zano` — which the first version placed AHEAD of
   * `houseDefault`, so the policy could never be seen by anyone who had
   * already mined the coin. Every real installed wallet, not the fresh ones
   * the fix was tested against.
   */
  it("wins over accumulated usage history from BEFORE the policy existed", () => {
    const next = resolveDefaultPool({
      coin: "zano",
      algorithm: "progpowz",
      liveLanePool: null,
      remembered: null,
      mostUsed: "herominers-zano", // real prior history, non-house pool
    });
    expect(next).toBe("pwnda-zano");
  });

  it("same fact for Zephyr", () => {
    const next = resolveDefaultPool({
      coin: "zephyr",
      algorithm: "randomx",
      liveLanePool: null,
      remembered: null,
      mostUsed: "hashvault-zephyr",
    });
    expect(next).toBe("pwnda-zephyr");
  });

  it("a LIVE running session always wins — never lie about what is mining", () => {
    const next = resolveDefaultPool({
      coin: "zano",
      algorithm: "progpowz",
      liveLanePool: "woolypooly-zano",
      remembered: null,
      mostUsed: "herominers-zano",
    });
    expect(next).toBe("woolypooly-zano");
  });

  it("an explicit pick made THIS SESSION wins over the house default too", () => {
    const next = resolveDefaultPool({
      coin: "zano",
      algorithm: "progpowz",
      liveLanePool: null,
      remembered: "woolypooly-zano",
      mostUsed: "herominers-zano",
    });
    expect(next).toBe("woolypooly-zano");
  });

  it("coins with NO house policy still use accumulated usage as the best signal", () => {
    // Confirms the house-default insertion didn't quietly break the
    // mostUsed tier for every other coin — mostUsed must still outrank the
    // bare registry-order fallback when there is no house entry to prefer.
    // (`resolveDefaultPool` itself does not validate ids against
    // `availablePools` — that is the caller's job, via `inList` in
    // `useMiner.ts` — so this uses a real, registered XMR pool.)
    const next = resolveDefaultPool({
      coin: "monero",
      algorithm: "randomx",
      liveLanePool: null,
      remembered: null,
      mostUsed: "herominers-monero",
    });
    expect(next).toBe("herominers-monero");
    // And it's a genuinely different answer from the bare registry default —
    // proof mostUsed is actually being consulted here, not silently skipped.
    const registryDefault = getPoolsForCoin("monero", "randomx")[0]?.id;
    expect(next).not.toBe(registryDefault);
  });

  it("falls all the way to registry order with no signals at all", () => {
    const next = resolveDefaultPool({
      coin: "ravencoin",
      algorithm: "kawpow",
      liveLanePool: null,
      remembered: null,
      mostUsed: null,
    });
    expect(next).toBe(getPoolsForCoin("ravencoin", "kawpow")[0]?.id);
  });
});
