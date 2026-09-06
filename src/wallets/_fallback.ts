/**
 * Shared multi-endpoint fallback helper.
 *
 * Replaces the hand-rolled "try each URL until one works" loops scattered
 * across `evm-factory.ts`, `btc-wallet.ts`, `tron-wallet.ts`, etc. with a
 * single policy:
 *
 *   - Try URLs in declared priority order.
 *   - Per-call timeout via AbortController.
 *   - Treat HTTP statuses in `retryStatuses` (default: 408, 429, 5xx) as
 *     retryable; everything else either succeeds or terminates the loop.
 *   - On exhaustion, throw an Error whose message lists every URL tried
 *     plus the last classifier so callers can surface real diagnostics.
 *
 * The return type is generic — the helper doesn't care whether `fn`
 * returns a parsed object, a raw Response, an RPC result, etc.
 */

export interface WithFallbackOpts {
  /** Per-attempt timeout in ms. Default 15000. */
  timeoutMs?: number;
  /**
   * HTTP status codes that should rotate to the next endpoint instead of
   * surfacing as the final result. Default: 408, 425, 429, 500, 502, 503, 504.
   * Pass `[]` to treat every non-throw as success.
   */
  retryStatuses?: number[];
}

export class AllSourcesFailedError extends Error {
  readonly sources: string[];
  readonly lastError: unknown;
  constructor(sources: string[], lastError: unknown) {
    const tail = lastError instanceof Error ? lastError.message : String(lastError);
    super(
      `All ${sources.length} source(s) failed: ${sources.join(", ")} — last error: ${tail}`
    );
    this.name = "AllSourcesFailedError";
    this.sources = sources;
    this.lastError = lastError;
  }
}

const DEFAULT_RETRY_STATUSES = [408, 425, 429, 500, 502, 503, 504];

/**
 * Try `fn(url)` against each url in order, returning the first success.
 *
 * The signal returned to `fn` is pre-armed with a per-attempt timeout. If
 * `fn` throws, we rotate to the next URL. To trigger a rotation on an HTTP
 * status (e.g. 429), throw from `fn` — see `fetchJsonWithFallback` for
 * the standard pattern.
 *
 * `retryStatuses` is intentionally unused inside this generic helper —
 * status classification is impossible without parsing the result. It's
 * kept on the opts type as guidance for callers writing their own `fn`.
 */
export async function withFallback<T>(
  urls: string[],
  fn: (url: string, signal: AbortSignal) => Promise<T>,
  opts: WithFallbackOpts = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15000;

  if (urls.length === 0) {
    throw new Error("withFallback called with empty url list");
  }

  let lastError: unknown = null;
  for (const url of urls) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
    try {
      return await fn(url, ctrl.signal);
    } catch (e) {
      lastError = e;
      continue;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new AllSourcesFailedError(urls, lastError);
}

/**
 * Convenience for adapters that just want JSON. Builds a URL per base, runs
 * fetch with the per-attempt signal, and parses JSON on success. Throws
 * with the source URL on a non-retryable HTTP status; rotates the URL list
 * on retryable statuses or fetch errors.
 */
export async function fetchJsonWithFallback<T = any>(
  buildUrl: (base: string) => string,
  baseUrls: string[],
  init?: RequestInit & WithFallbackOpts
): Promise<T> {
  const { timeoutMs, retryStatuses = DEFAULT_RETRY_STATUSES, ...fetchInit } = init ?? {};
  return withFallback(
    baseUrls,
    async (base, signal) => {
      const url = buildUrl(base);
      const resp = await fetch(url, { ...fetchInit, signal });
      if (resp.ok) return (await resp.json()) as T;
      if (retryStatuses.includes(resp.status)) {
        throw new Error(`HTTP ${resp.status} from ${url}`);
      }
      // Non-retryable HTTP error: parse body for context, then surface as a
      // terminal error so we don't burn the rest of the URL list.
      const body = await resp.text().catch(() => "");
      const err = new Error(`HTTP ${resp.status} from ${url}: ${body.slice(0, 200)}`);
      (err as any).terminal = true;
      throw err;
    },
    { timeoutMs }
  );
}
