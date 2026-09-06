import { Card } from "../../components/PrimitivesV2";
import { ST } from "../../components/Primitives";
import { getAdapter, type ChainType } from "../../wallets";
import { supportsPathSearch } from "../onboarding/generic-path-finder";
import { GenericDerivationFinder } from "./GenericDerivationFinder";

/**
 * Derivation surface for EVERY chain.
 *
 * Reads `ChainAdapter.derivation`, which is a required field — so a chain
 * added tomorrow gets this card automatically, with no wiring. That's the
 * point: the rich per-chain panels (Cardano / Solana / Algorand / Litecoin,
 * and the paste-to-find one for XRP/TRX/RVN/DASH) each had to be built and
 * hand-mounted, which is why most chains had no derivation surface at all and
 * a user whose funds sat on a different path had nowhere to look.
 *
 * Three states, driven by the declaration rather than by a per-chain branch:
 *
 *   independent-seed  Monero / Zephyr. No BIP-39 path exists; show why.
 *   hasAlternatives   A mismatch is plausible. Show the path and point at the
 *                     chain's switcher if one is mounted below.
 *   otherwise         Every major wallet agrees (all EVM chains). Show the
 *                     path read-only. Deliberately NOT a switcher: offering
 *                     to change a path that has one correct value can only
 *                     move the user's funds out of view.
 */
export function DerivationInfoCard(props: {
  chain: ChainType;
  /** True when a richer switcher for this chain is rendered below this card. */
  hasDedicatedPanel?: boolean;
  /** Shared BIP-39 phrase — enables the generic scan/find tools. */
  mnemonic?: string | null;
  onCopy?: (text: string) => void;
}) {
  const { chain, hasDedicatedPanel = false, mnemonic, onCopy } = props;
  const adapter = getAdapter(chain);
  const d = adapter.derivation;

  return (
    <Card style={{ marginTop: 10 }}>
      <div className="secret-row">
        <div className="secret-header">
          <span className="label" style={{ color: "var(--accent)" }}>
            <ST delay={0} speed={20}>Derivation</ST>
          </span>
        </div>

        {d.kind === "independent-seed" ? (
          <div style={{ fontSize: 10, color: "var(--text-dim)", lineHeight: 1.6 }}>
            {d.note}
          </div>
        ) : (
          <>
            <div
              className="tnum"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--text)",
                wordBreak: "break-all",
                marginBottom: 6,
              }}
            >
              {d.path}
            </div>
            <div style={{ fontSize: 10, color: "var(--text-dim)", lineHeight: 1.6 }}>
              Matches {d.standard}.
              {d.hasAlternatives ? (
                hasDedicatedPanel ? (
                  <> Other wallets derive {adapter.ticker} differently — if your
                  balance is missing, use the derivation options below to find
                  the address your other wallet shows.</>
                ) : null
              ) : (
                <> Every major wallet uses this path for {adapter.ticker}, so
                there's nothing to switch — an address derived anywhere else
                wouldn't match what those wallets show for this seed.</>
              )}
            </div>
          </>
        )}

        {/* Scan + paste-to-find, for ANY chain whose adapter implements
            deriveAtPath. Chains with a bespoke panel below get that instead,
            so the two don't stack. */}
        {!hasDedicatedPanel && mnemonic && supportsPathSearch(chain) && (
          <GenericDerivationFinder
            chain={chain}
            mnemonic={mnemonic}
            onCopy={onCopy ?? (() => {})}
          />
        )}
      </div>
    </Card>
  );
}
