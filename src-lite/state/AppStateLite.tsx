import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ChainType } from "../../src/wallets";

/**
 * The chains PwndaLite supports as paste-in mining destinations. Matches
 * the chains with registered dev-fee wallets in
 * `src/features/mining/pools.ts::DEV_FEE_WALLETS` — anything mining-capable
 * in the full wallet is mineable from Lite.
 *
 * 2026-05-14: ergo added by [[ergo-integration-plan]] PR-5. The ERG entry
 * will be inert until PR-3 lands the dev-fee wallet + pool definitions.
 */
export const LITE_SUPPORTED_CHAINS: ChainType[] = [
  "monero",
  "zephyr",
  "ravencoin",
  "conflux",
  "ergo",
];

export type LiteView = "mining" | "settings";

interface AppStateLite {
  view: LiteView;
  setView: (v: LiteView) => void;
  /** Per-chain user-supplied payout address. Persisted to localStorage. */
  userAddressByChain: Partial<Record<ChainType, string>>;
  setAddressFor: (chain: ChainType, address: string) => void;
  /** The mining coin the user last selected. Stored here only so LiteApp
   *  can seed `useMiner`'s internal state on mount; after that, the
   *  miner hook is the source of truth. LiteApp also write-throughs new
   *  values from `miner.miningCoin` into here whenever it changes — that's
   *  what `persistMiningCoin` does. Do NOT pass `miningCoin` to children
   *  for display; read `miner.miningCoin` instead. The two-way sync
   *  attempt that lived here previously caused an infinite render loop
   *  ("page glitching and won't stop" — fixed 2026-05-13).
   */
  persistedMiningCoin: ChainType;
  persistMiningCoin: (c: ChainType) => void;
  /** Resolve a payout address for the given chain — the contract `useMiner`
   *  consumes (mirrors the full wallet's wiring in `App.tsx`). Lite reads
   *  from `userAddressByChain`; the full wallet reads from the decrypted
   *  vault. Same shape, different storage. */
  addressFor: (coin: ChainType) => string | null;
}

const Ctx = createContext<AppStateLite | null>(null);

const LS_ADDRESSES = "pwnda-lite.userAddressByChain";
const LS_MINING_COIN = "pwnda-lite.miningCoin";

function readStoredAddresses(): Partial<Record<ChainType, string>> {
  try {
    const raw = localStorage.getItem(LS_ADDRESSES);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* corrupt JSON — fall through */
  }
  return {};
}

function readStoredMiningCoin(): ChainType {
  try {
    const raw = localStorage.getItem(LS_MINING_COIN);
    if (raw && LITE_SUPPORTED_CHAINS.includes(raw as ChainType)) {
      return raw as ChainType;
    }
  } catch {
    /* ignore */
  }
  return "monero";
}

export function AppStateLiteProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<LiteView>("mining");
  const [userAddressByChain, setUserAddressByChainState] = useState<
    Partial<Record<ChainType, string>>
  >(() => readStoredAddresses());
  // `persistedMiningCoin` is read ONCE on mount (via lazy initial state)
  // and updated via `persistMiningCoin` — there is no bi-directional sync
  // back into useMiner. The miner hook seeds itself from this on mount;
  // after that, the miner hook owns the canonical value and LiteApp
  // write-throughs the miner's value here for persistence.
  const [persistedMiningCoin, setPersistedMiningCoin] = useState<ChainType>(
    () => readStoredMiningCoin()
  );

  useEffect(() => {
    try {
      localStorage.setItem(LS_ADDRESSES, JSON.stringify(userAddressByChain));
    } catch {
      /* localStorage full / disabled — non-fatal */
    }
  }, [userAddressByChain]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_MINING_COIN, persistedMiningCoin);
    } catch {
      /* ignore */
    }
  }, [persistedMiningCoin]);

  const setAddressFor = useCallback((chain: ChainType, address: string) => {
    setUserAddressByChainState((prev) => {
      const trimmed = address.trim();
      if (trimmed === (prev[chain] ?? "")) return prev;
      const next = { ...prev };
      if (trimmed) next[chain] = trimmed;
      else delete next[chain];
      return next;
    });
  }, []);

  const persistMiningCoin = useCallback((c: ChainType) => {
    setPersistedMiningCoin((prev) => (prev === c ? prev : c));
  }, []);

  const addressFor = useCallback(
    (coin: ChainType): string | null => userAddressByChain[coin] ?? null,
    [userAddressByChain]
  );

  const value = useMemo<AppStateLite>(
    () => ({
      view,
      setView,
      userAddressByChain,
      setAddressFor,
      persistedMiningCoin,
      persistMiningCoin,
      addressFor,
    }),
    [
      view,
      userAddressByChain,
      setAddressFor,
      persistedMiningCoin,
      persistMiningCoin,
      addressFor,
    ]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppStateLite(): AppStateLite {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAppStateLite called outside AppStateLiteProvider");
  return v;
}
