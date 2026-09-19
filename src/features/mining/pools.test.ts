import { describe, it, expect } from "vitest";
import {
  getPoolById,
  getPoolsForCoin,
  getDefaultPoolId,
  buildCredentials,
  poolHostPort,
  HOUSE_DEFAULT_POOL,
  poolWorkerName,
  resolveDefaultPool,
  workerFlagFor,
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

  // 2026-09-18: the pool's own API (`pwnda.org/pool-api`, the one the
  // pwnda.org MY STATS page reads) is wired, so the account shows in the app.
  it("has a live-stats adapter (pwnda.org/pool-api)", () => {
    expect(getStatsAdapter("pwnda-zephyr")?.id).toBe("pwnda-zephyr");
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

  it("has a live-stats adapter (pwnda.org/zano-api)", () => {
    expect(getStatsAdapter("pwnda-zano")?.id).toBe("pwnda-zano");
  });
});

describe("HOUSE_DEFAULT_POOL — a policy override, not a fabricated payout", () => {
  it("names exactly ZEPH, ZANO and XEL, each pointing at a real registered pool", () => {
    // XEL joined 2026-09-16 (pwnda-xelis).
    expect(Object.keys(HOUSE_DEFAULT_POOL).sort()).toEqual(["xelis", "zano", "zephyr"]);
    for (const [coin, id] of Object.entries(HOUSE_DEFAULT_POOL)) {
      expect(getPoolById(id as string)?.coin).toBe(coin);
    }
  });

  it("carries the pool's real minimum, not a number chosen to win the sort", () => {
    // Was "—" for both until 2026-09-18. They are now the pool's own
    // `config.minPaymentThreshold / coinUnits`, read live that day, and
    // `pool_payout.rs` refreshes them at runtime. The house pool is first in
    // the dropdown because `availablePools` pins it, not because of these.
    expect(getPoolById("pwnda-zephyr")!.minPayout).toBe("0.01 ZEPH");
    expect(getPoolById("pwnda-zano")!.minPayout).toBe("0.2 ZANO");
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

/**
 * Xelis pools, verified live 2026-09-15 (stratum probe + real SRBMiner-MULTI
 * 3.6.2 sessions). Every endpoint here passed; the combos that failed that day
 * are named in the XELIS_POOLS header and must stay absent. `pwnda-xelis`
 * (2026-09-16) is the one exception to "probed from here": its evidence is the
 * pool crediting the operator's own session (see its entry in pools.ts).
 */
describe("Xelis pools", () => {
  // Throwaway, offline-created, never-funded mainnet address.
  const XEL_ADDR = "xel:teqlmzt7nmxnpte48zxd0a666qfs6hjncvtsh6xtt7gp7hjgss5squv8r2a";

  it("registers exactly the endpoints that passed the probe, TLS where it was TLS", () => {
    expect(
      getPoolsForCoin("xelis", "xelishashv3").map((p) => [p.id, p.endpoint, p.ssl])
    ).toEqual([
      ["kryptex-xelis", "stratum+tcp://xel.kryptex.network:7019", false],
      ["kryptex-xelis-ssl", "stratum+ssl://xel.kryptex.network:8019", true],
      ["k1pool-xelis-cpu", "stratum+tcp://eu.xel.k1pool.com:9350", false],
      ["k1pool-xelis-gpu", "stratum+tcp://eu.xel.k1pool.com:9351", false],
      ["k1pool-xelis-ssl", "stratum+ssl://eu.xel.k1pool.com:9352", true],
      ["herominers-xelis", "stratum+tcp://de.xelis.herominers.com:1225", false],
      ["pwnda-xelis", "stratum+ssl://xel.pwnda.org:17706", true],
    ]);
  });

  it("pins K1Pool's CPU and GPU ports to their lanes", () => {
    const cpu = getPoolsForCoin("xelis", "xelishashv3", "cpu").map((p) => p.id);
    const gpu = getPoolsForCoin("xelis", "xelishashv3", "gpu").map((p) => p.id);
    expect(cpu).toContain("k1pool-xelis-cpu");
    expect(cpu).not.toContain("k1pool-xelis-gpu");
    expect(cpu).not.toContain("k1pool-xelis-ssl");
    expect(gpu).toContain("k1pool-xelis-gpu");
    expect(gpu).toContain("k1pool-xelis-ssl");
    expect(gpu).not.toContain("k1pool-xelis-cpu");
    // Single-port pools serve both lanes.
    for (const id of ["kryptex-xelis", "kryptex-xelis-ssl", "herominers-xelis", "pwnda-xelis"]) {
      expect(cpu).toContain(id);
      expect(gpu).toContain(id);
    }
  });

  it("the lane filter changes nothing for single-lane coins", () => {
    expect(getPoolsForCoin("monero", "randomx", "cpu")).toEqual(
      getPoolsForCoin("monero", "randomx")
    );
    expect(getPoolsForCoin("ravencoin", "kawpow", "gpu")).toEqual(
      getPoolsForCoin("ravencoin", "kawpow")
    );
  });

  // Replaced 2026-09-16. This test was "has no house pool — pwnda runs no XEL
  // pool (operator decision D4)"; pwnda now runs one.
  it("defaults to the pwnda pool on BOTH lanes, over stale usage history", () => {
    // Kryptex is registry[0] and serves both lanes, so a registry-order
    // default could never produce pwnda-xelis. Only the house policy can.
    expect(getPoolsForCoin("xelis", "xelishashv3")[0]?.id).not.toBe("pwnda-xelis");
    for (const lane of ["cpu", "gpu"] as const) {
      expect(getDefaultPoolId("xelis", "xelishashv3", lane)).toBe("pwnda-xelis");
      expect(
        resolveDefaultPool({
          coin: "xelis",
          algorithm: "xelishashv3",
          hardware: lane,
          liveLanePool: null,
          remembered: null,
          mostUsed: lane === "cpu" ? "k1pool-xelis-cpu" : "k1pool-xelis-gpu",
        })
      ).toBe("pwnda-xelis");
    }
    // An in-session pick still wins.
    expect(
      resolveDefaultPool({
        coin: "xelis",
        algorithm: "xelishashv3",
        hardware: "cpu",
        liveLanePool: null,
        remembered: "k1pool-xelis-cpu",
        mostUsed: null,
      })
    ).toBe("k1pool-xelis-cpu");
  });

  it("pwnda-xelis: TLS, both lanes, min payout from pwnda.org", () => {
    const pool = getPoolById("pwnda-xelis")!;
    expect(pool.coin).toBe("xelis");
    expect(pool.algorithm).toBe("xelishashv3");
    expect(pool.ssl).toBe(true); // → SRBMiner `--tls true` on both lanes
    expect(pool.hardware).toBeUndefined(); // one port, both lanes
    expect(poolHostPort(pool.endpoint)).toBe("xel.pwnda.org:17706");
    expect(pool.minPayout).toBe("0.05 XEL");
  });

  it("pwnda-xelis logs in as `xel:address.worker` / `x`, as pwnda.org documents", () => {
    const pool = getPoolById("pwnda-xelis")!;
    expect(
      buildCredentials({ pool, address: XEL_ADDR, worker: " rig1 ", coinPrefix: "XEL" })
    ).toEqual({ user: `${XEL_ADDR}.rig1`, pass: "x" });
    // The `xel:` prefix stays: the pool requires it.
    expect(
      buildCredentials({ pool, address: XEL_ADDR, worker: "", coinPrefix: "XEL" }).user
    ).toBe(`${XEL_ADDR}.worker1`);
  });

  it("pwnda-xelis never sends an all-digit worker, which the pool reads as a fixed difficulty", () => {
    // pwnda.org/start: "append to the address - YOUR_XELIS_ADDRESS.2000000".
    // A rig named "1" would otherwise mine at difficulty 1.
    const pool = getPoolById("pwnda-xelis")!;
    for (const [worker, sent] of [
      ["1", "rig1"],
      [" 2000000 ", "rig2000000"],
      ["rig7", "rig7"],
      ["7rig", "7rig"],
      ["", "worker1"],
    ] as const) {
      expect(poolWorkerName(pool, worker)).toBe(sent);
      expect(
        buildCredentials({ pool, address: XEL_ADDR, worker, coinPrefix: "XEL" }).user
      ).toBe(`${XEL_ADDR}.${sent}`);
    }
    // Only a pool that declares the rule is affected.
    const hero = getPoolById("herominers-conflux")!;
    expect(hero.userFormat).toBe("address.worker");
    expect(poolWorkerName(hero, "42")).toBe("42");
  });

  it("pwnda-xelis sends the worker once, in the wallet: no separate --worker", () => {
    // The operator's working session sent ["xel:….OutsideRig","SRBMiner","x"]
    // (captured 2026-09-16): the worker only in the wallet, SRBMiner's default
    // in the worker field. Omitting --worker reproduces that shape.
    expect(workerFlagFor(getPoolById("pwnda-xelis")!, "rig1", true)).toBeNull();
    for (const pool of getPoolsForCoin("xelis", "xelishashv3")) {
      if (pool.id === "pwnda-xelis") continue;
      expect(workerFlagFor(pool, " rig1 ", true)).toBe("rig1");
      expect(workerFlagFor(pool, "", true)).toBe("worker1");
    }
    // A protocol with no worker field never gets the flag.
    expect(workerFlagFor(getPoolById("herominers-conflux")!, "rig1", false)).toBeNull();
    expect(workerFlagFor(getPoolById("k1pool-xelis-cpu")!, "rig1", false)).toBeNull();
  });

  it("the third-party pools log in with the bare address and password x; the worker is a separate flag", () => {
    for (const pool of getPoolsForCoin("xelis", "xelishashv3")) {
      if (pool.id === "pwnda-xelis") continue; // pinned above
      const { user, pass } = buildCredentials({
        pool,
        address: XEL_ADDR,
        worker: "rig1",
        coinPrefix: "XEL",
      });
      expect(user).toBe(XEL_ADDR);
      expect(pass).toBe("x");
    }
  });

  it("does not list Suprnova (account pool; wallet-login crediting unverified)", () => {
    expect(
      getPoolsForCoin("xelis", "xelishashv3").some((p) => p.endpoint.includes("suprnova"))
    ).toBe(false);
  });

  it("has live stats only where the API was verified (K1Pool, Pwnda)", () => {
    expect(getStatsAdapter("pwnda-xelis")).not.toBeNull();
    expect(getStatsAdapter("k1pool-xelis-cpu")).not.toBeNull();
    expect(getStatsAdapter("k1pool-xelis-gpu")).not.toBeNull();
    expect(getStatsAdapter("k1pool-xelis-ssl")).not.toBeNull();
    expect(getStatsAdapter("kryptex-xelis")).toBeNull();
    expect(getStatsAdapter("herominers-xelis")).toBeNull();
  });
});
