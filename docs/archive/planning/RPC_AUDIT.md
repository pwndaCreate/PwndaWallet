# Public RPC Endpoint Audit

Single source of truth for which public RPCs the wallet ships with by
default. This file gets re-run every ~6 months because providers paywall
public access more often than they used to. The code lives in
`src/wallets/chain-rpcs.ts`; that file's defaults must always match the
"verified passing" rows below.

## Audit run 2026-05-06

**Methodology** — every candidate hit with the chain's native "current
block" call from a CI-class network (commodity cloud egress in the
US-East region):

| Probe kind | Method |
|---|---|
| EVM | `POST {jsonrpc:"2.0",method:"eth_blockNumber",params:[],id:1}` — expect `"result":"0x…"` |
| Solana | `POST {jsonrpc:"2.0",method:"getSlot",params:[],id:1}` — expect `"result":<integer>` |
| NEAR | `POST {jsonrpc:"2.0",method:"status",params:[],id:1}` — expect `"chain_id":"mainnet"` |
| Esplora REST | `GET {base}/blocks/tip/height` — expect plain integer body |
| Blockchair-style | `GET {base}/stats` — expect `"blocks":<integer>` somewhere in body |

Per-URL pass requires:
- 2xx HTTP status
- response body contains the expected field
- response body has NO `error` field (rejects `-32046` "Cannot fulfill
  request", `-32000` "Unauthorized: API key required", `-32051` "tenant
  disabled", `-32029` "Too Many Requests", etc.)
- under 6 s round-trip

Latency in the table is from this single audit run; treat as ballpark.

---

### Ethereum mainnet — 4 keep, 2 reject

| URL | Result | Latency | Notes |
|---|---|---|---|
| `https://eth.llamarpc.com` | ✓ keep | 281 ms | Primary. Most reliable across networks. |
| `https://eth.drpc.org` | ✓ keep | 268 ms | Independent network path. |
| `https://eth.merkle.io` | ✓ keep | 539 ms | Independent infra (Merkle.io). |
| `https://eth.blockrazor.xyz` | ✓ keep | 549 ms | 4th independent provider. |
| `https://ethereum-rpc.publicnode.com` | ⚠ keep last | n/a | HTTP 000 from this audit network (sandbox egress block); user-confirmed working from typical residential / business networks. Listed last. |
| `https://rpc.ankr.com/eth` | ✗ reject | — | `-32000 Unauthorized: API key required` (paywalled in 2025). |
| `https://1rpc.io/eth` | ✗ reject | — | Timeout 6 s. |
| `https://endpoints.omniatech.io/v1/eth/mainnet/public` | ✗ reject | — | HTTP 521 (origin down). |
| `https://eth.public-rpc.com` | ✗ reject | — | Proxies to Ankr → same paywall. |
| `https://api.zan.top/v1/eth/mainnet/public` | ✗ reject | — | Requires `Origin` header. |
| `https://core.gashawk.io/rpc` | ✗ reject | — | Empty response. |
| `https://cloudflare-eth.com` | ✗ reject | — | `-32046 Cannot fulfill request` on most methods. **Do not add back.** |

### Avalanche C-chain — 4 keep, 4 reject

| URL | Result | Latency | Notes |
|---|---|---|---|
| `https://avalanche.drpc.org` | ✓ keep | 252 ms | Fastest. |
| `https://api.avax.network/ext/bc/C/rpc` | ✓ keep | 381 ms | Official. |
| `https://avalanche-c-chain-rpc.publicnode.com` | ✓ keep | 466 ms | |
| `https://1rpc.io/avax/c` | ✓ keep | 798 ms | |
| `https://rpc.ankr.com/avalanche` | ✗ reject | — | API-key paywall. |
| `https://avax-pokt.nodies.app` | ✗ reject | — | 404. |
| `https://avalanche.public-rpc.com` | ✗ reject | — | Proxies to Ankr. |
| `https://avax.meowrpc.com` | ✗ reject | — | 404. |

### Polygon — 4 keep, 4 reject

| URL | Result | Latency | Notes |
|---|---|---|---|
| `https://polygon.drpc.org` | ✓ keep | 267 ms | Fastest. |
| `https://polygon-bor-rpc.publicnode.com` | ✓ keep | 491 ms | |
| `https://1rpc.io/matic` | ✓ keep | 518 ms | |
| `https://polygon-pokt.nodies.app` | ✓ keep | 934 ms | 4th independent provider. |
| `https://polygon-rpc.com` | ✗ reject | — | `-32051 API key disabled, tenant disabled` — they explicitly closed the anonymous tenant in 2025. **Was the wallet's primary as of 2026-05-05; replaced this round.** |
| `https://polygon.llamarpc.com` | ✗ reject | — | DNS does not resolve. LlamaNodes never published Polygon under that subdomain. |
| `https://rpc.ankr.com/polygon` | ✗ reject | — | API-key paywall. |
| `https://polygon-mainnet.public.blastapi.io` | ✗ reject | — | "Blast API is no longer available." |
| `https://polygon.blockpi.network/v1/rpc/public` | ✗ reject | — | HTTP 521. |

### Flare — 3 keep, 4 reject

| URL | Result | Latency | Notes |
|---|---|---|---|
| `https://flare-api.flare.network/ext/C/rpc` | ✓ keep | 466 ms | Official. |
| `https://rpc.ankr.com/flare` | ✓ keep | 408 ms | One of the few still-free Ankr endpoints. |
| `https://flare.gateway.tenderly.co` | ✓ keep | 744 ms | |
| `https://flare.drpc.org` | ✗ reject | — | "Unknown network" (drpc dropped Flare). |
| `https://flare-rpc.publicnode.com` | ✗ reject | — | Empty response (no Flare endpoint). |
| `https://flarerpc.flare.network/ext/C/rpc` | ✗ reject | — | Empty response. |
| `https://flare.public-rpc.com` | ✗ reject | — | Empty response. |

### Arbitrum One — 4 keep, 3 reject

| URL | Result | Latency | Notes |
|---|---|---|---|
| `https://arbitrum.drpc.org` | ✓ keep | 355 ms | Fastest. |
| `https://arbitrum-one-rpc.publicnode.com` | ✓ keep | 379 ms | |
| `https://arb1.arbitrum.io/rpc` | ✓ keep | 446 ms | Official. |
| `https://1rpc.io/arb` | ✓ keep | 444 ms | |
| `https://rpc.ankr.com/arbitrum` | ✗ reject | — | API-key paywall. |
| `https://arbitrum.llamarpc.com` | ✗ reject | — | Empty response. |
| `https://arb1.croswap.com/rpc` | ✗ reject | — | Empty response. |

### Base — 4 keep, 3 reject

| URL | Result | Latency | Notes |
|---|---|---|---|
| `https://base.drpc.org` | ✓ keep | 280 ms | Fastest. |
| `https://base-rpc.publicnode.com` | ✓ keep | 372 ms | |
| `https://mainnet.base.org` | ✓ keep | 434 ms | Official. |
| `https://base.llamarpc.com` | ✓ keep | 459 ms | |
| `https://rpc.ankr.com/base` | ✗ reject | — | API-key paywall. |
| `https://base.api.onfinality.io/public` | ✗ reject | — | `-32029 Too Many Requests, apply for an API key`. |
| `https://1rpc.io/base` | ⚠ degraded | — | Worked but redundant; prefer the four above. |

### Optimism — 4 keep, 2 reject

| URL | Result | Latency | Notes |
|---|---|---|---|
| `https://optimism.drpc.org` | ✓ keep | 326 ms | Fastest. |
| `https://optimism-rpc.publicnode.com` | ✓ keep | 394 ms | |
| `https://1rpc.io/op` | ✓ keep | 409 ms | |
| `https://mainnet.optimism.io` | ✓ keep | 703 ms | Official. |
| `https://rpc.ankr.com/optimism` | ✗ reject | — | API-key paywall. |
| `https://optimism.llamarpc.com` | ✗ reject | — | Empty response. |
| `https://op-pokt.nodies.app` | ⚠ degraded | — | Worked; redundant with the four above. |

### BSC — 4 keep, 2 reject

| URL | Result | Latency | Notes |
|---|---|---|---|
| `https://bsc-dataseed2.binance.org` | ✓ keep | 245 ms | Fastest. |
| `https://bsc.drpc.org` | ✓ keep | 294 ms | |
| `https://bsc-dataseed1.binance.org` | ✓ keep | 334 ms | |
| `https://bsc-rpc.publicnode.com` | ✓ keep | 467 ms | |
| `https://rpc.ankr.com/bsc` | ✗ reject | — | API-key paywall. |
| `https://binance.llamarpc.com` | ✗ reject | — | Empty response. |
| `https://1rpc.io/bnb` | ⚠ degraded | — | Worked; redundant with the four above. |

### Solana — 1 verified, 2 listed-but-unverifiable, 7 reject

This is the worst public-RPC situation across all chains. Only one
endpoint reliably answers `getSlot` without an API key from CI-class
networks. The wallet ships the official one as primary plus two more as
fallbacks because they're reported working from typical user networks
even though our audit egress couldn't reach them.

| URL | Result | Latency | Notes |
|---|---|---|---|
| `https://api.mainnet-beta.solana.com` | ✓ keep | 1233 ms | Slow + heavily rate-limited but the one reliable free endpoint. |
| `https://solana-rpc.publicnode.com` | ⚠ keep | n/a | HTTP 000 from this audit network. User-reported working on typical residential networks. Listed as fallback. |
| `https://solana.drpc.org` | ⚠ keep | — | `code 35 method not available on freetier, please upgrade to paid tier` for `getSlot`, but answers other methods. Listed as last-resort. |
| `https://rpc.ankr.com/solana` | ✗ reject | — | `-32052 API key is not allowed`. |
| `https://solana.api.onfinality.io/public` | ✗ reject | — | `-32029 Too Many Requests`. |
| `https://1rpc.io/sol` | ✗ reject | — | "Unknown network". |
| `https://mainnet.helius-rpc.com` | ✗ reject | — | `-32401 missing api key`. |
| `https://solana-mainnet.rpc.extrnode.com` | ✗ reject | — | "Usage without a token is no longer available." |
| `https://solana-mainnet.public.blastapi.io` | ✗ reject | — | Empty response (Blast retired). |
| `https://api.metaplex.solana.com` | ✗ reject | — | Empty response. |

**Recommendation:** for serious Solana use, set `VITE_SOL_RPC_URL` to
Helius / Triton / QuickNode with a free-tier key. The defaults will
work for occasional swap activity but rate-limit fast.

### NEAR — 5 keep, 1 reject

| URL | Result | Latency | Notes |
|---|---|---|---|
| `https://near.drpc.org` | ✓ keep | 368 ms | Fastest. |
| `https://1rpc.io/near` | ✓ keep | 490 ms | |
| `https://rpc.fastnear.com` | ✓ keep | 633 ms | |
| `https://near.lava.build` | ✓ keep | 899 ms | |
| `https://rpc.mainnet.near.org` | ✓ keep | 2363 ms | Slow + rate-limited, but official. |
| `https://endpoints.omniatech.io/v1/near/mainnet/public` | ✗ reject | — | HTTP 521. |

### Bitcoin — 3 keep, 2 reject

| URL | Result | Latency | Notes |
|---|---|---|---|
| `https://blockstream.info/api` | ✓ keep | 312 ms | (was 6 s on first probe; transient — retry confirmed working) |
| `https://mempool.space/api` | ✓ keep | 1262 ms | |
| `https://mempool.emzy.de/api` | ✓ keep | 658 ms | mempool.space mirror. |
| `https://btc.bitaps.com/api/v1/blockchain` | ✗ reject | — | Cloudflare anti-bot challenge. |
| `https://bitcoinexplorer.org/api` | ✗ reject | — | HTTP 525. |

### Litecoin — 1 keep, 2 reject

| URL | Result | Latency | Notes |
|---|---|---|---|
| `https://litecoinspace.org/api` | ✓ keep | 666 ms | Only verified esplora-compatible LTC endpoint. |
| `https://electrs.ltc.bdk.dev` | ✗ reject | — | Empty response. |
| `https://litecoin.atomicwallet.io/api` | ⚠ skip | — | Works but uses blockbook API (different format), can't drop into the same code path. |

### Dogecoin — 1 keep, 2 reject

| URL | Result | Latency | Notes |
|---|---|---|---|
| `https://api.blockchair.com/dogecoin` | ✓ keep | — | Blockchair stats endpoint; the existing DOGE wallet adapter knows this format. |
| `https://api.blockcypher.com/v1/doge/main` | ✗ reject | — | "Limits reached" — IP-rate-limited fast. |
| `https://dogechain.info/api/v1` | ✗ reject | — | Cloudflare anti-bot challenge. |

### Bitcoin Cash — 2 keep, 2 reject

| URL | Result | Latency | Notes |
|---|---|---|---|
| `https://api.blockchair.com/bitcoin-cash` | ✓ keep | — | Same format as DOGE. |
| `https://api.haskoin.com/bch` | ✓ keep | — | Custom format, but the existing BCH wallet adapter uses it natively. |
| `https://rest.bitcoin.com/v2` | ✗ reject | — | DNS failure / HTTP 000. |
| `https://api.fullstack.cash/v5` | ✗ reject | — | Returns HTML (404-ish). |

---

## Lessons learned (file these for the next audit)

1. **2025 was the year free public Ethereum-family RPCs got paywalled.** Ankr `rpc.ankr.com/<chain>` formerly worked anonymously; in 2025 they added `-32000 Unauthorized` for ETH / AVAX / POL / ARB / BASE / OP / BSC. Strangely Flare still works. Audit to verify before each release.

2. **Cloudflare gateway (`cloudflare-eth.com`) is reachable but neutered.** `-32046 Cannot fulfill request` on a 200 OK. The danger is naive fallback chains treating this as live. The `chain-rpcs.ts` code rejects `-32046` explicitly + the URL is permanently banned from the defaults.

3. **Hostname-pattern guessing is unreliable.** `polygon.llamarpc.com` doesn't exist (LlamaNodes never published Polygon at that subdomain pattern); `polygon-bor-rpc.publicnode.com` does (publicnode uses that compound naming for sidechains).

4. **Blast API retired in 2025.** All `*.public.blastapi.io` endpoints return a "use Alchemy instead" error. Drop them all.

5. **Solana is the worst public-RPC situation among major chains.** Most providers require an API key. The official endpoint rate-limits aggressively. For production volume, the user MUST set `VITE_SOL_RPC_URL`.

6. **Probe with the chain's actual native call, not a generic ping.** Cloudflare-eth.com would have passed an HTTP HEAD probe. The `-32046` only shows up with a real `eth_blockNumber`. Audit script: `src/wallets/chain-rpcs.ts::probeChain` is the same code the runtime + the Settings test use.

7. **Per-network variance is real.** `ethereum-rpc.publicnode.com` returned HTTP 000 (TCP block) from the audit network but works fine from typical residential / business networks. Listed last in the fallback list so it's never the primary hop.

## How to re-audit

```bash
# From the repo root, run the inline verifier:
cat > /tmp/verify.sh <<'EOF'
# (copy from src-tauri/scripts/audit-rpc.sh — verbatim)
EOF
# Or use the runtime path: launch the wallet, open Settings → NETWORK,
# click "Test all chains". Each row turns green/red within a few seconds.
```

When a default fails the test from a healthy network, treat it as
expired and remove from `chain-rpcs.ts::RPC_DEFAULTS[chain].defaults`.
Update this file with the date + reason.
