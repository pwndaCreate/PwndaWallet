/**
 * The four bundled wallet programs as Settings ▸ Wallet binaries shows them.
 * Pure helpers plus the per-chain command names; the card is
 * `SidecarUpdateCard.tsx`. Added 2026-09-16.
 */
import { invoke } from "../../lib/tauri";

export type WalletBinaryId = "monero" | "zephyr" | "zano" | "xelis";

export interface WalletBinaryStatus {
  id: WalletBinaryId;
  /** Version marker beside the unpacked copy; null when none. */
  installed: string | null;
  /** A real binary is unpacked, marker or not. */
  present: boolean;
  /** Version this build ships; null when nothing usable was staged. */
  bundled: string | null;
}

/**
 * Per-wallet wiring. `check` is the chain's own status command, which unpacks
 * the bundled copy when there is one (`resolve_rpc_binary`); `download` is its
 * pinned, hash-verified download. Both already back each chain's sync card.
 */
export const WALLET_BINARIES: Record<
  WalletBinaryId,
  { label: string; note: string; check: string; download: string }
> = {
  monero: {
    label: "Monero · monero-wallet-rpc",
    note: "checked against upstream daily",
    check: "xmr_check_wallet_rpc",
    download: "xmr_download_wallet_rpc",
  },
  zephyr: {
    label: "Zephyr · zephyr-wallet-rpc",
    note: "pinned to the wallet release",
    check: "zph_check_wallet_rpc",
    download: "zph_download_wallet_rpc",
  },
  zano: {
    label: "Zano · simplewallet",
    note: "pinned to the wallet release",
    check: "zano_binary_status",
    download: "zano_download_wallet_rpc",
  },
  xelis: {
    label: "Xelis · xelis_wallet (light client)",
    note: "pinned to the wallet release",
    check: "xelis_binary_status",
    download: "xelis_download_wallet_rpc",
  },
};

/** What a row says about one wallet binary. Pure, so it is tested directly. */
export function describeWalletBinary(w: WalletBinaryStatus): string {
  const shipped = w.bundled ? ` · shipped: ${w.bundled}` : "";
  if (w.present && w.installed) {
    return w.bundled && w.bundled !== w.installed
      ? `in use: ${w.installed}${shipped}`
      : `in use: ${w.installed}`;
  }
  if (w.present) return `installed (version not recorded)${shipped}`;
  if (w.bundled) return `shipped: ${w.bundled} · unpacked when you first open this wallet`;
  return "not in this build · downloaded when you first open this wallet";
}

/**
 * Unpack the bundled copy, or download it when this build has none. The
 * status command unpacks as a side effect, so it runs first and the network
 * is only used when it reports nothing.
 */
export async function installWalletBinary(id: WalletBinaryId): Promise<void> {
  const w = WALLET_BINARIES[id];
  if (await invoke<boolean>(w.check)) return;
  await invoke<void>(w.download);
  if (!(await invoke<boolean>(w.check))) {
    throw new Error(
      `${w.label} was downloaded but is still missing. Antivirus software may have removed it.`
    );
  }
}
