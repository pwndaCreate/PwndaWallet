/**
 * Chain-sync progress read DIRECTLY from each managed daemon — the data source
 * that stays alive during IBD.
 *
 * # Why the balances poll is not enough
 *
 * The sync display originally rode `useSidecarBalances`, i.e. the engine's
 * `/json/wallets`. That endpoint aggregates wallet + blockchain info across
 * every coin under one server-side timeout, and under IBD load it returns
 * `error: Timeout` for ALL coins (measured live: 10.0s, every coin) — so the
 * sync UI blanked out precisely when the user most wanted to watch it, twice
 * in one day. A daemon's own `getblockchaininfo` is a local read that answers
 * in milliseconds mid-sync; `swap_sidecar_chain_sync` asks each managed daemon
 * directly.
 *
 * The two sources stay SEPARATE rather than merged: balances carry wallet
 * facts only the engine knows (deposit addresses, amounts, lock state), and
 * chain rows carry the chain facts the engine is too busy to relay. The cards
 * take both and let the chain row win for the sync line when present.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { swapSidecarChainSync, type ChainSync } from "../../api/basicswap";

/** Slightly faster than the balances poll: this is the number a user sits and
 *  watches, and the read costs one loopback RPC per local daemon. */
const CHAIN_SYNC_POLL_MS = 10_000;

export interface ChainSyncState {
  /** Rows keyed by UPPERCASE ticker. Empty until the first poll lands. */
  byTicker: Record<string, ChainSync>;
  refresh(): void;
}

export function useChainSync(opts: { enabled: boolean }): ChainSyncState {
  const { enabled } = opts;
  const [byTicker, setByTicker] = useState<Record<string, ChainSync>>({});
  const alive = useRef(true);
  /** True while a read is outstanding. */
  const inFlight = useRef(false);
  const seq = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    // Same one-at-a-time rule as `useSidecarBalances` — and this poll is the
    // faster of the two (10s), so it stacks sooner when the node is slow.
    if (inFlight.current) return;
    inFlight.current = true;
    const mine = ++seq.current;
    try {
      const rows = await swapSidecarChainSync();
      if (!alive.current || mine !== seq.current) return;
      const map: Record<string, ChainSync> = {};
      for (const r of rows) map[r.ticker.toUpperCase()] = r;
      setByTicker(map);
    } catch {
      // Silent by design: this hook is an ENHANCER over the balances rows.
      // Its failure must degrade to "the sync line shows the engine's slower
      // view", never to an error banner of its own.
      if (alive.current && mine === seq.current) setByTicker({});
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      seq.current++;
      setByTicker({});
      return;
    }
    let stopped = false;
    const tick = () => {
      if (!stopped) void load();
    };
    tick();
    const id = window.setInterval(tick, CHAIN_SYNC_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [enabled, load]);

  const refresh = useCallback(() => {
    if (enabled) void load();
  }, [enabled, load]);

  return { byTicker, refresh };
}
