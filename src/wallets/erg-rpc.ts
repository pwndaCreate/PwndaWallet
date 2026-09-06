/**
 * Ergo Explorer REST failover wrapper.
 *
 * Two REST mirrors are tried in sequence. Both expose the standard Ergo
 * Explorer API v1 schema (verified via live `/info` probe 2026-05-14 —
 * `api.sigmaspace.io` returns the same `lastBlockId` / `height` / `params`
 * shape as `api.ergoplatform.com`).
 *
 *   Tier 1: api.ergoplatform.com — official, hosted by ErgoFoundation.
 *   Tier 2: api.sigmaspace.io      — drop-in compatible community mirror.
 *
 * `ErgoRpcError` carries the per-base attempt log only when *all* bases
 * fail. Modeled on `xmr-nodes-feather.ts` — same fail-loud-once pattern.
 *
 * No external network code lives in this file beyond `fetch`; the adapter
 * imports this wrapper instead of hitting the explorer URLs directly so
 * the fallback chain is centralized.
 *
 * See [[Ergo]] (§ RPC failover) and [[ergo-integration-plan]].
 */

const EXPLORER_BASES: readonly string[] = [
  "https://api.ergoplatform.com/api/v1",
  "https://api.sigmaspace.io/api/v1",
] as const;

const FETCH_TIMEOUT_MS = 8_000;
const PER_BASE_BACKOFF_MS = 200;

export type ErgoRpcAttempt = {
  base: string;
  status: number | "timeout" | "network";
};

export class ErgoRpcError extends Error {
  constructor(
    message: string,
    public readonly attempts: ReadonlyArray<ErgoRpcAttempt>,
  ) {
    super(message);
    this.name = "ErgoRpcError";
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ res?: Response; aborted: boolean; error?: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { res, aborted: false };
  } catch (e) {
    return { aborted: controller.signal.aborted, error: e };
  } finally {
    clearTimeout(timer);
  }
}

async function tryEachBase<T>(
  pathOrUrlBuilder: (base: string) => string,
  init: RequestInit,
  errorHint: string,
): Promise<T> {
  const attempts: ErgoRpcAttempt[] = [];
  for (const base of EXPLORER_BASES) {
    const url = pathOrUrlBuilder(base);
    const { res, aborted, error } = await fetchWithTimeout(
      url,
      init,
      FETCH_TIMEOUT_MS,
    );
    if (res) {
      if (res.ok) {
        return (await res.json()) as T;
      }
      attempts.push({ base, status: res.status });
    } else if (aborted) {
      attempts.push({ base, status: "timeout" });
    } else {
      attempts.push({ base, status: "network" });
      void error;
    }
    if (PER_BASE_BACKOFF_MS > 0) {
      await new Promise((r) => setTimeout(r, PER_BASE_BACKOFF_MS));
    }
  }
  throw new ErgoRpcError(
    `${errorHint}: all Ergo explorer mirrors failed`,
    attempts,
  );
}

/**
 * GET `<base>/<path>` against each mirror in turn. Returns the parsed JSON
 * body of the first 2xx response. Throws `ErgoRpcError` only when every
 * mirror has failed.
 *
 * `path` should start with a leading slash (e.g. `/info`,
 * `/addresses/9f.../balance/confirmed`).
 */
export async function ergoGet<T>(path: string): Promise<T> {
  if (!path.startsWith("/")) {
    throw new Error(`ergoGet path must start with "/": ${path}`);
  }
  return tryEachBase<T>(
    (base) => `${base}${path}`,
    { method: "GET", headers: { accept: "application/json" } },
    `GET ${path}`,
  );
}

/**
 * POST a signed Ergo transaction to `/mempool/transactions/submit` against
 * the first healthy mirror. The body should be the Fleet-built signed-tx
 * JSON (Ergo Explorer v1 expects the same shape as the node wallet RPC).
 *
 * Returns the explorer's success payload, which is `{ id: "<tx-hash>" }`
 * for the official API. Throws `ErgoRpcError` if every mirror rejects.
 */
export async function ergoSubmitTx(signedTx: unknown): Promise<{ id: string }> {
  return tryEachBase<{ id: string }>(
    (base) => `${base}/mempool/transactions/submit`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(signedTx),
    },
    "POST /mempool/transactions/submit",
  );
}

/**
 * Probe each mirror's `/info` endpoint and return the list of healthy
 * bases. Diagnostic helper — not used by the adapter on the hot path,
 * but handy for the eventual Settings → Ergo health panel.
 */
export async function probeMirrors(): Promise<
  Array<{ base: string; ok: boolean; height?: number }>
> {
  const out: Array<{ base: string; ok: boolean; height?: number }> = [];
  for (const base of EXPLORER_BASES) {
    try {
      const { res } = await fetchWithTimeout(
        `${base}/info`,
        { method: "GET", headers: { accept: "application/json" } },
        FETCH_TIMEOUT_MS,
      );
      if (res?.ok) {
        const j = (await res.json()) as { height?: number };
        out.push({ base, ok: true, height: j.height });
      } else {
        out.push({ base, ok: false });
      }
    } catch {
      out.push({ base, ok: false });
    }
  }
  return out;
}

export const _EXPLORER_BASES_FOR_TESTS = EXPLORER_BASES;
