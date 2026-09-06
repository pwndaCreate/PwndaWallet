/**
 * src/features/swap-sidecar/MarketPreview.tsx
 *
 * "There is a market here" — the P2P DEX's shop window, rendered before the
 * user has opted into running a node.
 *
 * # What it is for
 *
 * The P2P surfaces used to greet a non-opted-in user with one sentence:
 * *"The swap node is not enabled on this wallet. Turn it on in Settings."* That
 * asks someone to enable a background service, download a runtime and sync a
 * chain **on faith**, to find out whether the market behind it is worth
 * anything. This block answers that question first: how many live offers, on
 * which pairs, how many makers, how fresh.
 *
 * # The honesty constraints, which are not decoration
 *
 * Everything here comes from a third-party snapshot that is ~5 minutes old and
 * **cannot see revocations** (see `marketsSnapshot.ts`). So:
 *
 *   - the source is named on screen, every time, never a bare number;
 *   - the framing word is PREVIEW, and the footnote says offers may already be
 *     taken;
 *   - no offer here is clickable and none is presented as takeable — this
 *     block has no actions at all beyond retrying the read;
 *   - a failed read renders "preview unavailable", NOT an empty market. Those
 *     two states are identical in the data and must never be identical on
 *     screen: telling a user "no offers exist" when we simply could not ask is
 *     the most expensive mistake this surface could make, because it argues
 *     against opting in on evidence we do not have.
 *
 * # One block, both layouts, both tabs
 *
 * Mounted by `BasicswapStrip` (which `SwapView` and `SwapLandscapeView` both
 * render) and by `EarnConvertBody` (landscape EARN and portrait CONVERT). Four
 * surfaces, one implementation, per the landscape-first rule — `compact`
 * narrows it for the portrait column rather than forking the file, matching
 * `SwapBalancesCard`'s existing pattern.
 */
import { Chip, ChipRow, Eyebrow } from "../swap/components/swap-ui";
import { MARKETS_SNAPSHOT_HOST, shortAge } from "./marketsSnapshot";
import { useMarketsSnapshot } from "./useMarketsSnapshot";

const mono = { fontFamily: "var(--font-mono)" } as const;

/** How many pairs get their own chip before the rest collapse into "+N more". */
const PAIRS_SHOWN_FULL = 4;
const PAIRS_SHOWN_COMPACT = 3;

function Shell({
  children,
  tone = "idle",
}: {
  children: React.ReactNode;
  tone?: "idle" | "live";
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderLeft:
          tone === "live" ? "2px solid var(--accent-mid)" : "1px solid var(--border)",
        background: "var(--surface)",
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        ...mono,
      }}
    >
      {children}
    </div>
  );
}

function SourceLine({ ageSec }: { ageSec: number | null }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 8,
      }}
    >
      <Eyebrow>network preview</Eyebrow>
      <span style={{ fontSize: 8, color: "var(--text-dim)", letterSpacing: 0.5 }}>
        {MARKETS_SNAPSHOT_HOST}
        {ageSec != null ? ` · ${shortAge(ageSec)} old` : ""}
      </span>
    </div>
  );
}

export function MarketPreview({
  /** Gate the fetch. Pass "this surface is on screen" — see the hook's doc. */
  enabled,
  compact = false,
  /**
   * Whether the user has already opted in.
   *
   * Only changes the closing line: a non-opted-in user is told what turning
   * the node on would get them, an opted-in user is told this is the public
   * view and their own node is the authority. The market data itself is the
   * same either way — it is a fact about the network, not about them.
   */
  optedIn,
}: {
  enabled: boolean;
  compact?: boolean;
  optedIn: boolean;
}) {
  const { snapshot, loading, error, refresh } = useMarketsSnapshot({ enabled });

  if (!enabled) return null;

  if (loading && !snapshot) {
    return (
      <Shell>
        <SourceLine ageSec={null} />
        <div style={{ fontSize: 10, color: "var(--text-dim)", letterSpacing: 1 }}>
          reading the public order book…
        </div>
      </Shell>
    );
  }

  if (error || !snapshot) {
    return (
      <Shell>
        <SourceLine ageSec={null} />
        <div style={{ fontSize: 10, color: "var(--text-muted)", lineHeight: 1.5 }}>
          Preview unavailable — the public market snapshot could not be read.
          {/* Deliberately says nothing about whether offers exist. */}
          <span style={{ color: "var(--text-dim)" }}>
            {" "}This says nothing about the network itself; it means we could
            not ask.
          </span>
        </div>
        <button
          type="button"
          onClick={refresh}
          style={{
            ...mono,
            alignSelf: "flex-start",
            fontSize: 9,
            letterSpacing: 1,
            textTransform: "uppercase",
            color: "var(--text-dim)",
            background: "none",
            border: "1px solid var(--border)",
            padding: "3px 8px",
            cursor: "pointer",
          }}
        >
          retry
        </button>
      </Shell>
    );
  }

  const live = snapshot.liveOffers.length;
  const shown = compact ? PAIRS_SHOWN_COMPACT : PAIRS_SHOWN_FULL;
  const pairs = snapshot.pairs.slice(0, shown);
  const more = snapshot.pairs.length - pairs.length;

  // A network with nothing on it is a real answer, and a different one from
  // "we could not look". Say so plainly rather than rendering an empty row.
  if (live === 0) {
    return (
      <Shell>
        <SourceLine ageSec={snapshot.ageSec} />
        <div style={{ fontSize: 10, color: "var(--text-muted)", lineHeight: 1.5 }}>
          No live offers on the public book right now.
        </div>
      </Shell>
    );
  }

  return (
    <Shell tone="live">
      <SourceLine ageSec={snapshot.ageSec} />

      <div
        style={{
          fontSize: compact ? 11 : 12,
          color: "var(--text)",
          letterSpacing: 0.5,
        }}
      >
        <span style={{ color: "var(--accent)" }}>{live}</span> live offer
        {live === 1 ? "" : "s"}
        <span style={{ color: "var(--text-dim)" }}> · </span>
        <span style={{ color: "var(--accent)" }}>{snapshot.pairs.length}</span>{" "}
        pair{snapshot.pairs.length === 1 ? "" : "s"}
        <span style={{ color: "var(--text-dim)" }}> · </span>
        <span style={{ color: "var(--accent)" }}>{snapshot.makerCount}</span>{" "}
        maker{snapshot.makerCount === 1 ? "" : "s"}
      </div>

      <ChipRow>
        {pairs.map((p) => (
          <Chip
            key={p.pairKey}
            tone="muted"
            title={`${p.offerCount} live offer${p.offerCount === 1 ? "" : "s"} from ${p.makerCount} maker${p.makerCount === 1 ? "" : "s"}; newest ${shortAge(p.freshestAgeSec)} ago`}
          >
            {p.pairKey}{" "}
            <span style={{ color: "var(--accent)" }}>{p.offerCount}</span>
          </Chip>
        ))}
        {more > 0 && <Chip tone="muted">+{more} more</Chip>}
      </ChipRow>

      <div
        style={{
          fontSize: 8.5,
          color: "var(--text-dim)",
          lineHeight: 1.5,
        }}
      >
        {/* One line, but the warning stays: the snapshot cannot see
            revocations, and `marketPreviewSurfaces.test.ts` pins the words
            "may already be taken" as a compliance constraint, not copy. */}
        {optedIn
          ? "Public snapshot · offers may already be taken · your node's own book is the authority."
          : "Public snapshot · offers may already be taken · enable the swap node to take one."}
      </div>
    </Shell>
  );
}
