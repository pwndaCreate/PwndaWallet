/**
 * **C3 — per-coin DEX enablement**, plus the selection gate that keeps the
 * wallet from spending a UTXO the DEX has reserved.
 *
 * Two records again, for the same reason `swapSidecarOptIn.ts` keeps two:
 *
 * | record | authority for | readable before |
 * |---|---|---|
 * | `<app_data>/swap-sidecar/opt-in.json` (Rust) | what the node actually does | a running node |
 * | {@link DEX_COINS_STORE_KEY} in `wallet.dat` (here) | what the UI may mount | **anything** — no invoke, no vault unlock |
 *
 * The store key is a **byte-for-byte mirror of the opt-in pattern**: plaintext,
 * in the same `tauri-plugin-store` file the encrypted vault lives in, under a
 * different key. Plaintext is the point — it is a non-secret UX flag and it has
 * to be readable before the vault is unlocked. It is a *mirror*, never the
 * authority: {@link useCoinStatuses} is what tells you the truth, and
 * {@link dexCoinsDrift} exists because two records can disagree and silence
 * about that is how they stay disagreed.
 *
 * # Write order is load-bearing
 *
 * Backend first, mirror second. If the backend write fails the mirror stays as
 * it was, the UI gate stays where it was, and the user retries. The reverse
 * order produces a UI claiming a coin is enabled on a node that refused.
 *
 * # Disable is not the inverse of enable
 *
 * Rust implements "disable" as `chainclients.<coin>.manage_daemon = false`. The
 * chainclient block survives; the chain stops syncing; **no chaindata is
 * deleted**. Every string this module or its card produces has to say that,
 * because "disable" reads as "remove" and a user who believes they reclaimed
 * 600 GB will be unpleasantly surprised.
 *
 * Note also contract §4.3 item 4: that `manage_daemon: false` *is* a working
 * disable is not yet regtest-proven. Copy here stays descriptive ("the chain
 * stops syncing") rather than promising a clean stop.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { load } from "@tauri-apps/plugin-store";
import {
  swapSidecarCoinStatus,
  swapSidecarSelectionGate,
  swapSidecarSetCoin,
  swapSidecarSetCoinMode,
  swapSidecarSetCnHostWallet,
  swapSidecarSetShareWallet,
  swapSidecarSetXmrHostWallet,
  type CoinEnableStatus,
  type CoinMode,
  type DexAdoption,
  type SelectionGate,
} from "../../api/basicswap";

export type { DexAdoption, CoinEnableStatus, CoinMode, SelectionGate };

/** Plaintext, `wallet.dat`, alongside `pwnda.swapSidecarOptedInAt`. */
export const DEX_COINS_STORE_KEY = "pwnda.dexCoinsEnabled";

/** One coin's locally-mirrored choice. `at` is unix millis (this mirror's own
 *  clock); the RFC3339 `at` on the backend record is the authoritative one. */
export interface DexCoinState {
  enabled: boolean;
  at: number;
  adoption: DexAdoption;
}

const ADOPTIONS: readonly DexAdoption[] = ["descriptor", "consolidate", "deposit"];

// =========================================================================
// Pure helpers
// =========================================================================

/**
 * Parse whatever is sitting under the store key into a map we can trust.
 *
 * Every field defaults to the **safe** value, not the convenient one:
 * `enabled` defaults to `false` and `adoption` to `"deposit"` (Rust's
 * `#[default] Deposit`). Reading a malformed record as "enabled, descriptor
 * adoption" would let a corrupted store key claim a key import already
 * happened.
 *
 * Coin keys are lowercased and trimmed so `"BTC"` and `"btc"` cannot both
 * exist; the last one wins, which is arbitrary but at least not two answers.
 */
export function normalizeDexCoins(raw: unknown): Record<string, DexCoinState> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, DexCoinState> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const coin = key.trim().toLowerCase();
    if (coin === "") continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const v = value as Partial<DexCoinState>;
    out[coin] = {
      enabled: v.enabled === true,
      at: typeof v.at === "number" && Number.isFinite(v.at) ? v.at : 0,
      adoption:
        typeof v.adoption === "string" &&
        (ADOPTIONS as readonly string[]).includes(v.adoption)
          ? (v.adoption as DexAdoption)
          : "deposit",
    };
  }
  return out;
}

/**
 * The UPPERCASE tickers the swap node is actually running right now — the
 * `liveEnabled` gate `basicswapPickerTickers` takes.
 *
 * `null` until the first status read lands (an EMPTY set would filter every
 * gated coin out of the picker during that first second). A coin counts only
 * when it is enabled, has a block, and that block is not parked
 * (`active !== false`) — a ZEPH/ZANO whose wallet process was closed at node
 * start is configured but parked, and offering it builds a pair that
 * dead-ends at the engine (2026-09-04).
 */
export function liveEnabledTickersFrom(
  statuses: readonly CoinEnableStatus[] | null | undefined,
): Set<string> | null {
  if (!statuses || statuses.length === 0) return null;
  return new Set(
    statuses
      .filter((s) => s.enabled && s.configured && s.active !== false)
      .map((s) => s.ticker.trim().toUpperCase()),
  );
}

/**
 * Coins the backend and the local mirror disagree about, lowercased and sorted.
 *
 * Only coins present in **both** are compared. A coin the mirror has no opinion
 * about is not drift (the mirror is allowed to be sparse — that is what a
 * fresh install looks like); see {@link dexCoinsOrphans} for the other
 * direction. `local === null` means the mirror has not been read yet and
 * yields `[]`, because "unknown" is not "disagreement".
 */
export function dexCoinsDrift(
  statuses: readonly CoinEnableStatus[] | null | undefined,
  local: Record<string, DexCoinState> | null | undefined,
): string[] {
  if (!statuses || !local) return [];
  const out: string[] = [];
  for (const s of statuses) {
    const coin = s.coin.trim().toLowerCase();
    const mine = local[coin];
    if (!mine) continue;
    if (mine.enabled !== s.enabled) out.push(coin);
  }
  return out.sort();
}

/**
 * Coins the mirror has an opinion about that the backend never reported.
 *
 * Usually a coin that lost its daemon binary between releases. Worth
 * surfacing quietly — a stale local `enabled: true` for a coin the node cannot
 * configure is exactly the state that makes an always-empty order book look
 * like "nobody is making offers".
 */
export function dexCoinsOrphans(
  statuses: readonly CoinEnableStatus[] | null | undefined,
  local: Record<string, DexCoinState> | null | undefined,
): string[] {
  if (!statuses || !local) return [];
  const known = new Set(statuses.map((s) => s.coin.trim().toLowerCase()));
  return Object.keys(local)
    .filter((c) => !known.has(c))
    .sort();
}

/**
 * **Fails closed.** `true` means "do not let the wallet spend this coin".
 *
 * `null`/`undefined` (not asked yet, or the ask failed) blocks. So does a
 * non-boolean `allowed` — the comparison is `!== true`, not `!`, so a mock or
 * a malformed body answering `allowed: "yes"` cannot unblock a send.
 *
 * Branch on this, never on {@link SelectionGate.reason}: the reason is display
 * copy and will be reworded, and a test that asserts on it passes for the
 * wrong reason (contract §R9).
 */
export function gateBlocks(gate: SelectionGate | null | undefined): boolean {
  return !gate || gate.allowed !== true;
}

/**
 * One sentence explaining the gate's current answer. Display only.
 *
 * Deliberately says *stale* out loud: an answer from disk because the daemon
 * was unreachable is a different thing from a fresh "yes, there are locks", and
 * flattening the two teaches the user to ignore the warning.
 */
export function gateSentence(gate: SelectionGate | null | undefined): string {
  if (!gate) return "Checking whether the swap node has this coin reserved…";
  if (gate.stale) {
    return (
      "The swap node could not be reached, so this is the last known reading" +
      ` (${gate.asOf}). Sending is held back — an unreachable node cannot show` +
      " that it has nothing reserved."
    );
  }
  if (gate.allowed) return "The swap node has nothing reserved for this coin.";
  const bits: string[] = [];
  if (gate.lockedUtxos > 0) {
    bits.push(`${gate.lockedUtxos} reserved output${gate.lockedUtxos === 1 ? "" : "s"}`);
  }
  if (gate.activeBids > 0) {
    bits.push(`${gate.activeBids} swap${gate.activeBids === 1 ? "" : "s"} in flight`);
  }
  return bits.length > 0
    ? `Held back: the swap node has ${bits.join(" and ")}.`
    : "Held back: the swap node has this coin reserved.";
}

// =========================================================================
// The plaintext mirror
// =========================================================================

let storeInstance: Awaited<ReturnType<typeof load>> | null = null;

async function getStore() {
  if (!storeInstance) {
    storeInstance = await load("wallet.dat", { defaults: {} });
  }
  return storeInstance;
}

/** Read the mirror. Always a map — a missing/garbage key reads as `{}`. */
export async function readDexCoins(): Promise<Record<string, DexCoinState>> {
  const store = await getStore();
  return normalizeDexCoins(await store.get<unknown>(DEX_COINS_STORE_KEY));
}

/** Write one coin into the mirror. Call this **after** the backend accepted. */
export async function writeDexCoin(
  coin: string,
  enabled: boolean,
  adoption: DexAdoption,
): Promise<Record<string, DexCoinState>> {
  const store = await getStore();
  const current = normalizeDexCoins(await store.get<unknown>(DEX_COINS_STORE_KEY));
  const next: Record<string, DexCoinState> = {
    ...current,
    [coin.trim().toLowerCase()]: { enabled, at: Date.now(), adoption },
  };
  await store.set(DEX_COINS_STORE_KEY, next);
  await store.save();
  return next;
}

// =========================================================================
// Hooks
// =========================================================================

/**
 * The pre-invoke mirror. `coins === null` means **not read yet**, and callers
 * must treat that as "not enabled" — same discipline as `useSwapSidecarOptIn`,
 * for the same reason: nothing may invoke a `swap_sidecar_*` command on the
 * strength of a value that has not been read.
 */
export function useDexCoins(): {
  coins: Record<string, DexCoinState> | null;
  setCoin(coin: string, enabled: boolean, adoption: DexAdoption): Promise<void>;
} {
  const [coins, setCoins] = useState<Record<string, DexCoinState> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readDexCoins().then((c) => {
      if (!cancelled) setCoins(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setCoin = useCallback(
    async (coin: string, enabled: boolean, adoption: DexAdoption) => {
      const next = await writeDexCoin(coin, enabled, adoption);
      setCoins(next);
    },
    [],
  );

  return { coins, setCoin };
}

export interface CoinStatusesState {
  statuses: CoinEnableStatus[];
  loading: boolean;
  error: string | null;
  /** Coin currently being toggled, so the card can disable just that row. */
  busyCoin: string | null;
  refresh(): void;
  /** Backend first, mirror second. Rejects with the backend's own message. */
  setCoin(coin: string, enabled: boolean): Promise<void>;
  /**
   * Choose light vs. local node for one coin.
   *
   * **Not mirrored into the store, unlike {@link setCoin}.** The mirror exists
   * so the mining-side surfaces can read enablement without a backend round
   * trip; nothing outside this hook reads the mode, and a second copy of a
   * value with a real "what the config says" authority is a second thing that
   * can be stale. `swapSidecarCoinStatus()` is the authority — this refreshes
   * from it and keeps no local copy.
   *
   * Rejects with the backend's own message, which is written to be shown.
   */
  setCoinMode(coin: string, mode: CoinMode): Promise<void>;
  /**
   * C8 — record or withdraw consent for a lean coin to use the wallet's own
   * account keys. Rejects on a backend refusal; the caller surfaces it.
   */
  /**
   * Turn wallet sharing on/off for one coin. Routes to C8's account-key
   * command or C9's wallet-rpc command by coin; the caller does not need to
   * know which mechanism applies.
   */
  setShareWallet(coin: string, share: boolean): Promise<void>;
}

function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

/**
 * The authoritative per-coin view. `enabled` **must** be
 * `useSwapSidecarOptIn() === true`.
 *
 * Does not poll: coin enablement changes only when the user changes it, and a
 * status read fans out across every configured chainclient. Refresh happens on
 * mount, after a toggle, and whenever the caller asks.
 */
export function useCoinStatuses(opts: { enabled: boolean }): CoinStatusesState {
  const { enabled } = opts;
  const [statuses, setStatuses] = useState<CoinEnableStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyCoin, setBusyCoin] = useState<string | null>(null);
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
      const rows = await swapSidecarCoinStatus();
      if (!alive.current || mine !== seq.current) return;
      setStatuses(Array.isArray(rows) ? rows : []);
      setError(null);
    } catch (e) {
      if (!alive.current || mine !== seq.current) return;
      setStatuses([]);
      setError(errMsg(e));
    } finally {
      if (alive.current && mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      seq.current++;
      setStatuses([]);
      setError(null);
      setLoading(false);
      return;
    }
    void load();
  }, [enabled, load]);

  const setCoin = useCallback(
    async (coin: string, wanted: boolean) => {
      if (!enabled) throw new Error("the swap sidecar is not enabled");
      setBusyCoin(coin);
      try {
        // Backend first. A rejection here leaves the mirror untouched.
        await swapSidecarSetCoin(coin, wanted);
        const row = statuses.find(
          (s) => s.coin.toLowerCase() === coin.trim().toLowerCase(),
        );
        await writeDexCoin(coin, wanted, row?.adoption ?? "deposit");
        await load();
      } finally {
        if (alive.current) setBusyCoin(null);
      }
    },
    [enabled, load, statuses],
  );

  const setCoinMode = useCallback(
    async (coin: string, mode: CoinMode) => {
      if (!enabled) throw new Error("the swap sidecar is not enabled");
      setBusyCoin(coin);
      try {
        await swapSidecarSetCoinMode(coin, mode);
        await load();
      } finally {
        if (alive.current) setBusyCoin(null);
      }
    },
    [enabled, load],
  );

  const setShareWallet = useCallback(
    async (coin: string, share: boolean) => {
      if (!enabled) throw new Error("the swap sidecar is not enabled");
      setBusyCoin(coin);
      try {
        // One control, THREE mechanisms. Monero shares its wallet-rpc process
        // (C9); zephyr/zano share a host wallet process too, through their own
        // command (C-RZ / C-RX, wired 2026-09-04 — before that this branch
        // sent them to the C8 setter, which Rust refuses for a coin that
        // cannot run lean, so the control the row now offers would have
        // surfaced a refusal); every other capable coin shares account keys
        // (C8). The backend refuses the wrong command per coin, so routing
        // here is what keeps the single UI control honest.
        const key = coin.trim().toLowerCase();
        const isXmr = key === "monero" || key === "xmr";
        const cn = key === "zephyr" || key === "zeph" ? "zephyr" : key === "zano" ? "zano" : null;
        if (isXmr) {
          await swapSidecarSetXmrHostWallet(coin, share);
        } else if (cn) {
          await swapSidecarSetCnHostWallet(cn, share);
        } else {
          await swapSidecarSetShareWallet(coin, share);
        }
        // Reload rather than patching the mirror: withdrawing consent also
        // clears a verified `accountkey` adoption backend-side, and a local
        // patch would leave the row still claiming a shared wallet.
        await load();
      } finally {
        if (alive.current) setBusyCoin(null);
      }
    },
    [enabled, load],
  );

  const refresh = useCallback(() => {
    if (!enabled) return;
    void load();
  }, [enabled, load]);

  return {
    statuses,
    loading,
    error,
    busyCoin,
    refresh,
    setCoin,
    setCoinMode,
    setShareWallet,
  };
}

export interface SelectionGateState {
  gate: SelectionGate | null;
  /** What a send path should actually branch on. Fails closed. */
  blocked: boolean;
  loading: boolean;
  error: string | null;
  refresh(): void;
}

/**
 * Ask the gate for one coin.
 *
 * `blocked` starts **true** and stays true until a gate answers `allowed`. A
 * send button wired to this is disabled while the answer is unknown, which is
 * the correct direction to be wrong in: the cost of a spurious block is a
 * retry; the cost of a spurious allow is a double-spent swap input.
 *
 * A transport failure sets `error` and leaves `blocked` true — note that Rust
 * usually answers `{allowed: false, stale: true}` rather than erroring, so this
 * path is the failure *of the ask itself*, not of the node.
 */
export function useSelectionGate(opts: {
  enabled: boolean;
  coin: string | null;
}): SelectionGateState {
  const { enabled, coin } = opts;
  const [gate, setGate] = useState<SelectionGate | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const seq = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!enabled || !coin) return;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const g = await swapSidecarSelectionGate(coin);
      if (!alive.current || mine !== seq.current) return;
      setGate(g);
      setError(null);
    } catch (e) {
      if (!alive.current || mine !== seq.current) return;
      setGate(null);
      setError(errMsg(e));
    } finally {
      if (alive.current && mine === seq.current) setLoading(false);
    }
  }, [enabled, coin]);

  useEffect(() => {
    seq.current++;
    setGate(null);
    if (!enabled || !coin) {
      setError(null);
      setLoading(false);
      return;
    }
    void load();
  }, [enabled, coin, load]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  return { gate, blocked: gateBlocks(gate), loading, error, refresh };
}
