// scripts/lib/sidecar-payloads.mjs
//
// The wallet binaries every PwndaWallet build bundles, in one table.
//
// Producer: scripts/fetch-sidecars.mjs. Gate: scripts/check-sidecar-payloads.mjs.
// Consumer: src-tauri/src/wallet_rpc_common.rs (`sidecar_naming`,
// `extract_bundled_sidecar`). `sidecarPayloads.test.mjs` fails if this table
// and `sidecar_naming` disagree, because a disagreement means the extracted
// file is looked for under a name nothing wrote.
//
// All four ship the same way: the upstream binary, gzip -9, with its SHA256 and
// size in `sidecars.json`. They are not encrypted. Only the miners and swap
// engine bundles are (bundle-binaries.mjs), because miner binaries trip
// antivirus unpackers and wallet binaries do not.

export const SIDECAR_PAYLOADS = [
  { id: "monero", gz: "monero-wallet-rpc", binary: "monero-wallet-rpc" },
  { id: "zephyr", gz: "zephyr-wallet-rpc", binary: "zephyr-wallet-rpc" },
  // Bundle name and binary name differ for these two.
  { id: "zano", gz: "zano-simplewallet", binary: "simplewallet" },
  // XELIS: the wallet only. The upstream archive also holds `xelis_daemon`
  // (a full node) and `xelis_miner`, and neither is ever shipped: PwndaWallet
  // runs XELIS as a light client against remote nodes.
  { id: "xelis", gz: "xelis-wallet", binary: "xelis_wallet" },
];

/** Binary file name on a target platform ("win32" | "linux"). */
export function binaryFileName(payload, target) {
  return `${payload.binary}${target === "win32" ? ".exe" : ""}`;
}
