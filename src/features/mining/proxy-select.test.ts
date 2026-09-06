import { describe, it, expect } from "vitest";
import {
  pickUsableProxy,
  usableProxies,
  torProxy,
  TOR_SOCKS5_HOSTPORT,
  MAX_USABLE_LATENCY_MS,
  type ProxyHealth,
} from "./proxy-select";

function p(hostPort: string, latencyMs: number, ok = true): ProxyHealth {
  return { hostPort, latencyMs, ok, validatedAt: 0, stage: ok ? "ok" : "connect" };
}

const fast = p("1.1.1.1:1", 300);
const mid = p("2.2.2.2:2", 2500);
const dead = p("3.3.3.3:3", 11179); // the 11.2s proxy that stalled mining 2026-06-30
const notOk = p("4.4.4.4:4", 200, false); // ok:false (failed validation)

describe("proxy selection — usable-latency gate (2026-06-30 dead-proxy fix)", () => {
  it("picks the fastest USABLE proxy (backend already sorts working-first)", () => {
    expect(pickUsableProxy([fast, mid, dead], new Set(), null)?.hostPort).toBe("1.1.1.1:1");
  });

  it("never selects a proxy slower than the cap → null prompts a refresh", () => {
    expect(dead.latencyMs).toBeGreaterThan(MAX_USABLE_LATENCY_MS);
    // The 11.2s proxy is the only 'working' one → no usable proxy → null.
    expect(pickUsableProxy([dead], new Set(), null)).toBeNull();
  });

  it("skips failed (session) proxies and ok:false entries", () => {
    expect(pickUsableProxy([fast, mid], new Set(["1.1.1.1:1"]), null)?.hostPort).toBe("2.2.2.2:2");
    expect(pickUsableProxy([notOk, mid], new Set(), null)?.hostPort).toBe("2.2.2.2:2");
  });

  it("honors a pinned proxy when usable; falls through when it's too slow", () => {
    expect(pickUsableProxy([fast, mid], new Set(), "2.2.2.2:2")?.hostPort).toBe("2.2.2.2:2");
    // pinned-but-dead → fall through to the fastest usable, don't stall on it
    expect(pickUsableProxy([fast, dead], new Set(), "3.3.3.3:3")?.hostPort).toBe("1.1.1.1:1");
  });

  it("usableProxies excludes ok:false and over-cap entries", () => {
    expect(usableProxies([fast, mid, dead, notOk]).map((x) => x.hostPort)).toEqual([
      "1.1.1.1:1",
      "2.2.2.2:2",
    ]);
  });
});

describe("Tor transport (proxy-select)", () => {
  it("torProxy is the local Tor SOCKS5, always ok + below the latency gate", () => {
    const t = torProxy();
    expect(t.hostPort).toBe(TOR_SOCKS5_HOSTPORT);
    expect(t.hostPort).toBe("127.0.0.1:9050");
    expect(t.ok).toBe(true);
    expect(t.latencyMs).toBeLessThanOrEqual(MAX_USABLE_LATENCY_MS);
    // So it survives `usableProxies` (would be selected without validation).
    expect(usableProxies([torProxy()])).toHaveLength(1);
  });
});
