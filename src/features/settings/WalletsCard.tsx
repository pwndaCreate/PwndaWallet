import { useMemo, useState } from "react";
import { validateMnemonic } from "@scure/bip39";
import { wordlist as bip39Wordlist } from "@scure/bip39/wordlists/english.js";
import { Panel, Mono, ST } from "../../components/Primitives";
import { Btn } from "../../components/PrimitivesV2";
import { useAppState } from "../../state/AppStateContext";
import { ALL_CHAINS, getAdapter, type ChainType } from "../../wallets";
import { type WalletEntry, type WalletKind } from "../../vault-schema";

/**
 * Settings ▸ Wallets — list + add/import/rename/remove/reveal the wallets in
 * the v3 vault. Add flow mirrors Phantom's "Add Account" list: Seed Phrase
 * (kind auto-detected from what's pasted), Private Key, or Watch Address —
 * the latter two on a chosen chain. Reads `walletEntries` from context; the
 * CRUD actions come from `useVault` via props.
 *
 * Watch entries are view-only (eye chip); a private-key entry is single-chain.
 */

const KIND_META: Record<WalletKind, { short: string; color: string }> = {
  bip39: { short: "BIP39", color: "var(--accent)" },
  xmr: { short: "XMR", color: "#ff6b1a" },
  zph: { short: "ZPH", color: "#a78bfa" },
  zano: { short: "ZANO", color: "#f0a020" },
  privateKey: { short: "KEY", color: "#f59e0b" },
  watch: { short: "👁 WATCH", color: "#60a5fa" },
};

type AddMode = "seed" | "privateKey" | "watch";

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--surface-2)",
  border: "1px solid var(--border)",
  color: "var(--text)",
  fontFamily: "var(--mono)",
  fontSize: 11,
  padding: "8px 10px",
  borderRadius: 2,
  outline: "none",
};

/** Networks offered for private-key import / watch (CryptoNote excluded). */
const SINGLE_CHAIN_OPTIONS: ChainType[] = ALL_CHAINS.filter(
  (c) => c !== "monero" && c !== "zephyr"
);

/** Detect the seed kind from what's pasted. 25 words = XMR-legacy OR Zephyr
 *  (same wordlist — undetectable), so the caller must ask. */
function detectSeedKind(input: string): {
  kind: "bip39" | "xmr" | "zph" | null;
  ambiguous: boolean;
} {
  const trimmed = input.trim();
  const n = trimmed.split(/\s+/).filter(Boolean).length;
  if (n === 0) return { kind: null, ambiguous: false };
  if ([12, 15, 18, 21, 24].includes(n) && validateMnemonic(trimmed, bip39Wordlist)) {
    return { kind: "bip39", ambiguous: false };
  }
  if (n === 16) return { kind: "xmr", ambiguous: false }; // polyseed
  if (n === 25) return { kind: "xmr", ambiguous: true }; // xmr-legacy or zph
  return { kind: null, ambiguous: false };
}

function KindChip({ kind }: { kind: WalletKind }) {
  const m = KIND_META[kind];
  return (
    <span
      style={{
        fontFamily: "var(--mono)",
        fontSize: 8,
        letterSpacing: 0.8,
        padding: "2px 5px",
        borderRadius: 2,
        color: m.color,
        border: `1px solid ${m.color}`,
        opacity: 0.9,
        flexShrink: 0,
        whiteSpace: "nowrap",
      }}
    >
      {m.short}
    </span>
  );
}

/** Chain label for a single-chain entry chip, e.g. "· SOL". */
function chainTicker(chain: ChainType | undefined): string {
  return chain ? getAdapter(chain).ticker : "";
}

export function WalletsCard({
  onAdd,
  onRename,
  onRemove,
  busy,
  titleDelay = 0,
}: {
  onAdd: (
    kind: WalletKind,
    input: string,
    name: string,
    chain?: ChainType
  ) => Promise<boolean>;
  onRename: (id: string, name: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  busy: boolean;
  titleDelay?: number;
}) {
  const { walletEntries, activeWalletId } = useAppState();

  const [adding, setAdding] = useState(false);
  const [addMode, setAddMode] = useState<AddMode>("seed");
  const [addValue, setAddValue] = useState(""); // seed / key / address
  const [addName, setAddName] = useState("");
  const [addChain, setAddChain] = useState<ChainType>("ethereum");
  const [zphChoice, setZphChoice] = useState(false); // 25-word: treat as ZPH?

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [revealId, setRevealId] = useState<string | null>(null);

  const detected = useMemo(
    () => (addMode === "seed" ? detectSeedKind(addValue) : { kind: null, ambiguous: false }),
    [addMode, addValue]
  );

  const ordered = useMemo(() => {
    const primaryGroup = walletEntries.find((w) => w.kind === "bip39")?.groupId;
    return [...walletEntries].sort((a, b) => {
      const ap = a.groupId === primaryGroup ? 0 : 1;
      const bp = b.groupId === primaryGroup ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return a.createdAt - b.createdAt;
    });
  }, [walletEntries]);

  const primaryBip39Id = useMemo(
    () => walletEntries.find((w) => w.kind === "bip39")?.id,
    [walletEntries]
  );

  const resetAdd = () => {
    setAddValue("");
    setAddName("");
    setZphChoice(false);
    setAdding(false);
  };

  const handleAdd = async () => {
    let ok = false;
    if (addMode === "seed") {
      const k = detected.ambiguous ? (zphChoice ? "zph" : "xmr") : detected.kind;
      if (!k) return;
      ok = await onAdd(k, addValue, addName);
    } else if (addMode === "privateKey") {
      ok = await onAdd("privateKey", addValue, addName, addChain);
    } else {
      ok = await onAdd("watch", addValue, addName, addChain);
    }
    if (ok) resetAdd();
  };

  const addDisabled =
    busy ||
    !addValue.trim() ||
    (addMode === "seed" && !detected.kind);

  const startEdit = (e: WalletEntry) => {
    setEditingId(e.id);
    setEditName(e.name);
    setConfirmRemoveId(null);
    setRevealId(null);
  };
  const saveEdit = async () => {
    if (editingId) await onRename(editingId, editName);
    setEditingId(null);
  };

  return (
    <Panel label={<ST delay={titleDelay} speed={22}>Wallets</ST>} pad={14}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Mono size={9} color="var(--text-dim)" style={{ display: "block" }}>
          {walletEntries.length} wallet{walletEntries.length === 1 ? "" : "s"} · one
          master password unlocks all
        </Mono>

        {/* ── Wallet list ─────────────────────────────────────────── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {ordered.map((e) => {
            const isActive = activeWalletId === e.id;
            const isPrimary = e.id === primaryBip39Id;
            const editing = editingId === e.id;
            const confirming = confirmRemoveId === e.id;
            const revealed = revealId === e.id;
            const secret = e.kind === "watch" ? (e.address ?? "") : e.seed;
            const secretLabel = e.kind === "watch" ? "address" : e.kind === "privateKey" ? "private key" : "seed";
            return (
              <div
                key={e.id}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  padding: "8px 10px",
                  border: "1px solid var(--border-soft)",
                  background: isActive ? "rgba(0,255,102,0.05)" : "var(--surface-2)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <KindChip kind={e.kind} />
                  {editing ? (
                    <input
                      autoFocus
                      value={editName}
                      onChange={(ev) => setEditName(ev.target.value)}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter") void saveEdit();
                        if (ev.key === "Escape") setEditingId(null);
                      }}
                      style={{ ...inputStyle, flex: 1, padding: "4px 8px" }}
                    />
                  ) : (
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Mono size={11} color="var(--text)" style={{ display: "block" }}>
                        {e.name}
                        {e.chain && (
                          <span style={{ color: "var(--text-dim)" }}> · {chainTicker(e.chain)}</span>
                        )}
                      </Mono>
                      {isPrimary && (
                        <Mono size={8} color="var(--text-dim)" upper spacing={0.6}>
                          primary · active
                        </Mono>
                      )}
                    </div>
                  )}

                  {editing ? (
                    <>
                      <Btn variant="ghost" size="sm" onClick={() => void saveEdit()}>Save</Btn>
                      <Btn variant="ghost" size="sm" onClick={() => setEditingId(null)}>Cancel</Btn>
                    </>
                  ) : confirming ? (
                    <>
                      <Mono size={9} color="var(--danger)">remove?</Mono>
                      <Btn variant="danger" size="sm" onClick={async () => { await onRemove(e.id); setConfirmRemoveId(null); }}>Yes</Btn>
                      <Btn variant="ghost" size="sm" onClick={() => setConfirmRemoveId(null)}>No</Btn>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => { setRevealId(revealed ? null : e.id); setConfirmRemoveId(null); }}
                        title={revealed ? "Hide" : `Reveal ${secretLabel}`}
                        style={iconBtn}
                      >
                        {revealed ? "hide" : "reveal"}
                      </button>
                      <button onClick={() => startEdit(e)} title="Rename" style={iconBtn}>rename</button>
                      {!isPrimary && (
                        <button
                          onClick={() => { setConfirmRemoveId(e.id); setEditingId(null); setRevealId(null); }}
                          title="Remove this wallet"
                          style={{ ...iconBtn, color: "var(--danger)" }}
                        >
                          remove
                        </button>
                      )}
                    </>
                  )}
                </div>

                {revealed && (
                  <div
                    style={{
                      border: `1px solid ${e.kind === "watch" ? "var(--border)" : "var(--warn)"}`,
                      background: "var(--bg-2)",
                      borderRadius: 2,
                      padding: "8px 10px",
                    }}
                  >
                    {e.kind !== "watch" && (
                      <Mono size={8} color="var(--warn)" upper spacing={0.6} style={{ display: "block", marginBottom: 6 }}>
                        ⚠ keep this {secretLabel} secret — anyone with it controls the funds
                      </Mono>
                    )}
                    <Mono size={10} color="var(--text)" style={{ display: "block", wordBreak: "break-all", userSelect: "all" }}>
                      {secret || "—"}
                    </Mono>
                  </div>
                )}
              </div>
            );
          })}
          {ordered.length === 0 && (
            <Mono size={10} color="var(--text-dim)">No wallets loaded.</Mono>
          )}
        </div>

        {/* ── Add / import ────────────────────────────────────────── */}
        {!adding ? (
          <Btn variant="ghost" full onClick={() => setAdding(true)}>
            + Add / Import Wallet
          </Btn>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              borderTop: "1px solid var(--border-soft)",
              paddingTop: 10,
            }}
          >
            {/* Add-type selector (Phantom's Add Account list) */}
            <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 2, overflow: "hidden" }}>
              {([
                ["seed", "Seed Phrase"],
                ["privateKey", "Private Key"],
                ["watch", "Watch Address"],
              ] as const).map(([m, label]) => {
                const active = addMode === m;
                return (
                  <button
                    key={m}
                    onClick={() => { setAddMode(m); setAddValue(""); }}
                    style={{
                      flex: 1,
                      fontFamily: "var(--mono)",
                      fontSize: 9,
                      letterSpacing: 0.4,
                      padding: "8px 2px",
                      background: active ? "var(--accent)" : "transparent",
                      border: "none",
                      color: active ? "#07120c" : "var(--text)",
                      fontWeight: active ? 600 : 400,
                      cursor: "pointer",
                      transition: "all .12s",
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            {/* Chain picker for single-chain kinds */}
            {(addMode === "privateKey" || addMode === "watch") && (
              <select
                value={addChain}
                onChange={(e) => setAddChain(e.target.value as ChainType)}
                style={{ ...inputStyle, cursor: "pointer" }}
              >
                {SINGLE_CHAIN_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {getAdapter(c).displayName} ({getAdapter(c).ticker})
                  </option>
                ))}
              </select>
            )}

            {/* Value field */}
            {addMode === "seed" ? (
              <textarea
                value={addValue}
                onChange={(e) => setAddValue(e.target.value)}
                placeholder="Recovery phrase (12/24 BIP39 · 16-word Monero · 25-word Monero/Zephyr)…"
                rows={2}
                spellCheck={false}
                style={{ ...inputStyle, resize: "vertical", minHeight: 44 }}
              />
            ) : (
              <input
                value={addValue}
                onChange={(e) => setAddValue(e.target.value)}
                placeholder={addMode === "privateKey" ? "Private key…" : "Public address to watch…"}
                spellCheck={false}
                style={inputStyle}
              />
            )}

            {/* Detected-kind feedback + 25-word disambiguation */}
            {addMode === "seed" && addValue.trim() && (
              detected.kind === null ? (
                <Mono size={9} color="var(--danger)">
                  Unrecognized — expected 12/24 BIP39, 16-word Monero, or 25-word Monero/Zephyr.
                </Mono>
              ) : detected.ambiguous ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Mono size={9} color="var(--text-dim)">25 words — which chain?</Mono>
                  <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 2, overflow: "hidden" }}>
                    {([["xmr", "Monero"], ["zph", "Zephyr"]] as const).map(([k, lbl]) => {
                      const on = k === "zph" ? zphChoice : !zphChoice;
                      return (
                        <button key={k} onClick={() => setZphChoice(k === "zph")}
                          style={{ fontFamily: "var(--mono)", fontSize: 9, padding: "4px 10px",
                            background: on ? "var(--accent)" : "transparent", border: "none",
                            color: on ? "#07120c" : "var(--text)", cursor: "pointer" }}>
                          {lbl}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <Mono size={9} color="var(--accent)">
                  Detected: {detected.kind === "bip39" ? "BIP39 recovery phrase" : "Monero polyseed"}
                </Mono>
              )
            )}

            <input
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              placeholder={`Name (optional) — e.g. "Trading"`}
              style={inputStyle}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <Btn variant="primary" onClick={() => void handleAdd()} disabled={addDisabled}>
                {busy ? "Working…" : addMode === "watch" ? "Watch address" : addMode === "privateKey" ? "Import key" : "Add wallet"}
              </Btn>
              <Btn variant="ghost" onClick={resetAdd} disabled={busy}>Cancel</Btn>
            </div>
            <Mono size={8} color="var(--text-dim)">
              {addMode === "watch"
                ? "View-only — you can see balances and receive, but can't send or sign."
                : "Encrypted into your vault with the same master password."}
            </Mono>
          </div>
        )}
      </div>
    </Panel>
  );
}

const iconBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--text-dim)",
  fontFamily: "var(--mono)",
  fontSize: 9,
  letterSpacing: 0.6,
  cursor: "pointer",
  padding: "2px 4px",
  flexShrink: 0,
};
