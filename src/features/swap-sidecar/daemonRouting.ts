/**
 * **C2 — daemon-direct routing, feature side.** A read-only view of what each
 * coin's daemon can do, so a send path can decide whether to route around the
 * engine or fall back to it.
 *
 * There is no send hook here on purpose. `swapDaemonSend` moves coins; wrapping
 * it in a hook with retained state invites a re-render or a stale closure to
 * fire it twice. Callers invoke the binding directly at the moment the user
 * commits, and hold the result themselves.
 *
 * The capability list is **probed live** and must stay that way: whether DOGE,
 * DASH and BCH accept `fee_rate` is exactly what contract §4.3 item 5 lists as
 * unanswerable without a node, and a hard-coded table here would answer it by
 * assertion. If the probe reports nothing for a coin, that is "unknown", not
 * "unsupported" — {@link capabilityFor} returns `null` and every predicate
 * below treats `null` as "cannot route", which is the safe direction.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  canRouteDaemonDirect,
  capabilityFor,
  isRoutingDisabled,
  preferredFeeMode,
  swapDaemonCapabilities,
  type DaemonCapability,
} from "../../api/basicswapDaemon";

export type { DaemonCapability };
export { capabilityFor, canRouteDaemonDirect, preferredFeeMode };

/**
 * Split the probe into coins worth routing daemon-direct and coins that must
 * fall back to the engine's send.
 *
 * `unpriced` is the interesting half: a daemon that accepts neither `fee_rate`
 * nor `conf_target` cannot be told how fast to confirm, which removes the only
 * reason to bypass the engine at all. Surfacing that list is what turns "the
 * routing feature does nothing on DOGE" from a mystery into a stated
 * limitation.
 */
export function routingSummary(caps: readonly DaemonCapability[] | null | undefined): {
  routable: string[];
  unpriced: string[];
} {
  if (!caps) return { routable: [], unpriced: [] };
  const routable: string[] = [];
  const unpriced: string[] = [];
  for (const c of caps) {
    (canRouteDaemonDirect(c) ? routable : unpriced).push(c.coin.toLowerCase());
  }
  return { routable: routable.sort(), unpriced: unpriced.sort() };
}

export interface DaemonCapabilitiesState {
  caps: DaemonCapability[];
  loading: boolean;
  error: string | null;
  /** The `PWNDA_SWAP_ROUTING` flag is off. Not a fault — the default state. */
  disabled: boolean;
  refresh(): void;
}

function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

/**
 * Probe capabilities once per mount. `enabled` must be
 * `useSwapSidecarOptIn() === true`.
 *
 * The routing-disabled refusal is separated from `error` because it is the
 * **default** state of a shipped build, not a failure: `PWNDA_SWAP_ROUTING` is
 * off unless someone turned it on. Rendering it as an error would put a red
 * line on every ordinary install.
 */
export function useDaemonCapabilities(opts: {
  enabled: boolean;
}): DaemonCapabilitiesState {
  const { enabled } = opts;
  const [caps, setCaps] = useState<DaemonCapability[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  const alive = useRef(true);
  const seq = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const rows = await swapDaemonCapabilities();
      if (!alive.current || mine !== seq.current) return;
      setCaps(Array.isArray(rows) ? rows : []);
      setDisabled(false);
      setError(null);
    } catch (e) {
      if (!alive.current || mine !== seq.current) return;
      const msg = errMsg(e);
      setCaps([]);
      setDisabled(isRoutingDisabled(msg));
      setError(isRoutingDisabled(msg) ? null : msg);
    } finally {
      if (alive.current && mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      seq.current++;
      setCaps([]);
      setError(null);
      setDisabled(false);
      setLoading(false);
      return;
    }
    void load();
  }, [enabled, load]);

  const refresh = useCallback(() => {
    if (!enabled) return;
    void load();
  }, [enabled, load]);

  return { caps, loading, error, disabled, refresh };
}
