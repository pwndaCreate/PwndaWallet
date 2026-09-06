import { useState } from "react";
import type { ChainType } from "../../src/wallets";
import { getCoinMeta } from "../../src/wallets/coin-metadata";
import { Card, Btn } from "../../src/components/PrimitivesV2";
import { CoinIcon } from "../../src/components/CoinIcon";

/**
 * Per-chain paste-an-address input. The user's stored value is treated as
 * the source of truth; the local `draft` state only buffers keystrokes
 * between saves. Save commits on click, Enter, or blur.
 *
 * Validation: weak by design (see [[pwnda-lite-plan]] open question). We
 * trust the pool's stratum-login response to reject malformed addresses
 * — calling each adapter's `validateAddress` would re-couple lite to the
 * wallet adapters, which `BOUNDARIES.md` explicitly disallows. If a real
 * mis-paste regression shows up in the wild, add per-chain regexes to
 * `src/wallets/coin-metadata.ts`.
 */
export function LiteAddressInputCard({
  chain,
  storedAddress,
  onSave,
  onClear,
}: {
  chain: ChainType;
  storedAddress: string | null;
  onSave: (address: string) => void;
  onClear: () => void;
}) {
  const meta = getCoinMeta(chain);
  const [draft, setDraft] = useState<string>(storedAddress ?? "");
  const trimmedDraft = draft.trim();
  const dirty = trimmedDraft !== (storedAddress ?? "");
  const stored = storedAddress && storedAddress.length > 0;

  const commit = () => {
    if (!dirty) return;
    if (trimmedDraft) onSave(trimmedDraft);
    else onClear();
  };

  return (
    <Card
      title={`${meta.ticker} ADDRESS — ${meta.displayName}`}
      style={{ marginBottom: 10 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <CoinIcon sym={meta.ticker} size={20} accent={meta.color} />
        <input
          type="text"
          value={draft}
          spellCheck={false}
          autoCorrect="off"
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
              (e.target as HTMLInputElement).blur();
            }
          }}
          onBlur={commit}
          placeholder={meta.addressPlaceholder}
          style={{
            flex: 1,
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            padding: "8px 10px",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            color: "var(--text)",
            outline: "none",
            borderRadius: 0,
          }}
        />
        <Btn
          onClick={commit}
          variant="primary"
          disabled={!dirty}
        >
          {dirty ? "Save" : stored ? "Saved" : "Set"}
        </Btn>
        {stored && (
          <Btn
            onClick={() => {
              setDraft("");
              onClear();
            }}
            variant="ghost"
          >
            Clear
          </Btn>
        )}
      </div>
      {stored && !dirty && (
        <div
          style={{
            marginTop: 8,
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--text-dim)",
            letterSpacing: 0.5,
          }}
        >
          mining to {storedAddress!.slice(0, 14)}…{storedAddress!.slice(-8)}
        </div>
      )}
    </Card>
  );
}
