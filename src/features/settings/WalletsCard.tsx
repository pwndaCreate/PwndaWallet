import { useMemo, useState } from "react";
import { Panel, Mono, ST } from "../../components/Primitives";
import { Btn } from "../../components/PrimitivesV2";
import { useAppState } from "../../state/AppStateContext";
import { ALL_CHAINS, getAdapter, type ChainType } from "../../wallets";
import { detectSeedKind } from "../../wallets/seed-kind";
import { type AddWalletOpts, type WalletEntry, type WalletKind } from "../../vault-schema";

/**
 * Settings ▸ Wallets — list + add/import/rename/remove/reveal the wallets in
 * the v3 vault. Add flow mirrors Phantom's "Add Account" list: Seed Phrase
 * (kind auto-detected from what's pasted), Private Key, or Watch Address —
 * the latter two on a chosen chain. Reads `walletEntries` from context; the
 * CRUD actions come from `useVault` via props.
 *
 * 2026-09-13: the seed path learned Zano (detection, Secured-Seed passphrase)
 * and gained "create new" for the three independent-seed coins — Monero,
 * Zephyr and Zano — so an additional wallet of those kinds can be generated
 * here, not only imported. Before, a Zano seed pasted here read
 * "Unrecognized" and there was no way to create any of the three.
 *
 * 2026-09-15: Xelis joined the seed path and "create new". A 25-word Xelis
 * seed uses Monero's English wordlist and checksum, so when the pasted words
 * are also valid for Xelis the coin choice offers Monero · Zephyr · Xelis and
 * nothing is pre-selected: restored as the wrong coin, the words open a
 * different, empty wallet (`seed-kind.ts`).
 *
 * Watch entries are view-only (eye chip); a private-key entry is single-chain.
 */

const KIND_META: Record<WalletKind, { short: string; color: string }> = {
  bip39: { short: "BIP39", color: "var(--accent)" },
  xmr: { short: "XMR", color: "#ff6b1a" },
  zph: { short: "ZPH", color: "#a78bfa" },
  zano: { short: "ZANO", color: "#f0a020" },
  xelis: { short: "XEL", color: "#02FFCF" },
  privateKey: { short: "KEY", color: "#f59e0b" },
  watch: { short: "👁 WATCH", color: "#60a5fa" },
};

type AddMode = "seed" | "privateKey" | "watch";

/** The coins a 25-word phrase can be for. */
type CnChoice = "xmr" | "zph" | "xelis";

/** Independent-seed coins that can be GENERATED here, with their chain. */
const CREATABLE: ReadonlyArray<{
  kind: "xmr" | "zph" | "zano" | "xelis";
  chain: ChainType;
  label: string;
}> = [
  { kind: "xmr", chain: "monero", label: "Monero" },
  { kind: "zph", chain: "zephyr", label: "Zephyr" },
  { kind: "zano", chain: "zano", label: "Zano" },
  { kind: "xelis", chain: "xelis", label: "Xelis" },
];

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

/** Networks offered for private-key import / watch (independent-seed coins excluded). */
const SINGLE_CHAIN_OPTIONS: ChainType[] = ALL_CHAINS.filter(
  (c) => c !== "monero" && c !== "zephyr" && c !== "zano" && c !== "xelis"
);

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
    chain?: ChainType,
    opts?: AddWalletOpts
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
  /** The coin picked for a 25-word phrase. null = not picked (see `coinChoice`). */
  const [cnChoice, setCnChoice] = useState<CnChoice | null>(null);
  const [zanoPassphrase, setZanoPassphrase] = useState("");
  /** "YYYY-MM-DD" a 25-word Monero/Zephyr import was created around ("" = scan all). */
  const [restoreDate, setRestoreDate] = useState("");
  /** Set when the textarea holds a seed generated HERE (not pasted), so the
   *  back-it-up warning shows for exactly that seed. */
  const [generatedFor, setGeneratedFor] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [revealId, setRevealId] = useState<string | null>(null);

  const detected = useMemo(
    () => (addMode === "seed" ? detectSeedKind(addValue) : { kind: null, ambiguous: false }),
    [addMode, addValue]
  );

  // Monero stays the default for a Monero-or-Zephyr phrase, as before. When
  // the words are ALSO a valid Xelis seed there is no default: the user picks.
  const coinChoice: CnChoice | null = cnChoice ?? (detected.xelisPossible ? null : "xmr");
  const coinOptions: ReadonlyArray<readonly [CnChoice, string]> = detected.xelisPossible
    ? [["xmr", "Monero"], ["zph", "Zephyr"], ["xelis", "Xelis"]]
    : [["xmr", "Monero"], ["zph", "Zephyr"]];

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
    setCnChoice(null);
    setZanoPassphrase("");
    setRestoreDate("");
    setGeneratedFor(null);
    setGenError("");
    setAdding(false);
  };

  const handleGenerate = async (c: (typeof CREATABLE)[number]) => {
    setGenerating(true);
    setGenError("");
    try {
      const fresh = await getAdapter(c.chain).generateOwnSeed?.();
      if (!fresh) throw new Error(`${c.label} seed generation is not available`);
      setAddValue(fresh);
      // A generated 25-word seed is exactly the coin it was generated for.
      setCnChoice(c.kind === "zano" ? null : c.kind);
      setZanoPassphrase("");
      setGeneratedFor(c.label);
      if (!addName.trim()) setAddName(`${c.label} wallet`);
    } catch (e: any) {
      setGenError(`Could not generate a ${c.label} seed: ${e?.message || String(e)}`);
    } finally {
      setGenerating(false);
    }
  };

  const handleAdd = async () => {
    let ok = false;
    if (addMode === "seed") {
      const k = detected.ambiguous ? coinChoice : detected.kind;
      if (!k) return;
      ok =
        k === "zano"
          ? await onAdd("zano", addValue, addName, undefined, {
              zanoSeedPassphrase: zanoPassphrase,
              newlyCreated: !!generatedFor,
            })
          : k === "xelis"
            ? await onAdd("xelis", addValue, addName, undefined, {
                newlyCreated: !!generatedFor,
              })
            : await onAdd(k, addValue, addName, undefined, {
                restoreDate: restoreDate || undefined,
                newlyCreated: !!generatedFor,
              });
    } else if (addMode === "privateKey") {
      ok = await onAdd("privateKey", addValue, addName, addChain);
    } else {
      ok = await onAdd("watch", addValue, addName, addChain);
    }
    if (ok) resetAdd();
  };

  const zanoNeedsPassphrase = detected.kind === "zano" && detected.zanoPasswordProtected === true;
  const addDisabled =
    busy ||
    generating ||
    !addValue.trim() ||
    (addMode === "seed" && !detected.kind) ||
    (addMode === "seed" && detected.ambiguous && coinChoice === null) ||
    (detected.kind === "zano" && detected.zanoAuditable === true) ||
    (zanoNeedsPassphrase && !zanoPassphrase);

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
                    {e.kind === "zano" && e.zanoSeedPassphrase && (
                      <Mono size={9} color="var(--warn)" style={{ display: "block", marginTop: 6 }}>
                        Secured Seed passphrase: <span style={{ userSelect: "all" }}>{e.zanoSeedPassphrase}</span>
                      </Mono>
                    )}
                    {e.kind === "xelis" && (
                      <Mono size={9} color="var(--warn)" style={{ display: "block", marginTop: 6, lineHeight: 1.5 }}>
                        Label this backup as a Xelis seed. The same 25 words are also a valid Monero
                        or Zephyr seed, and restored as either they open a different, empty wallet.
                      </Mono>
                    )}
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
                    onClick={() => { setAddMode(m); setAddValue(""); setGeneratedFor(null); setCnChoice(null); }}
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
                onChange={(e) => { setAddValue(e.target.value); setGeneratedFor(null); setCnChoice(null); }}
                placeholder="Recovery phrase — BIP39 · Monero (16/25) · Zephyr (25) · Xelis (25) · Zano (26)…"
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

            {/* Create new — Monero / Zephyr / Zano / Xelis, which each use their
                own seed rather than the BIP39 one. Offered while the box is
                empty; the generated seed lands in the box for review. */}
            {addMode === "seed" && !addValue.trim() && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }} data-create-seed>
                <Mono size={9} color="var(--text-dim)">or create new:</Mono>
                {CREATABLE.map((c) => (
                  <Btn
                    key={c.kind}
                    variant="ghost"
                    size="sm"
                    disabled={busy || generating}
                    onClick={() => void handleGenerate(c)}
                  >
                    {c.label}
                  </Btn>
                ))}
              </div>
            )}
            {genError && <Mono size={9} color="var(--danger)">{genError}</Mono>}
            {addMode === "seed" && generatedFor && addValue.trim() && (
              <Mono size={9} color="var(--warn)" style={{ display: "block", lineHeight: 1.5 }}>
                New {generatedFor} seed — write these words down before adding it. They are the
                only way to recover this wallet.
              </Mono>
            )}

            {/* Detected-kind feedback + 25-word coin choice + Zano passphrase */}
            {addMode === "seed" && addValue.trim() && (
              detected.kind === null ? (
                <Mono size={9} color="var(--danger)">
                  Unrecognized — expected 12/24 BIP39, 16-word Monero, 25-word Monero/Zephyr/Xelis, or a Zano seed.
                </Mono>
              ) : detected.ambiguous ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }} data-seed-coin-choice>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <Mono size={9} color="var(--text-dim)">25 words — which coin?</Mono>
                    <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 2, overflow: "hidden" }}>
                      {coinOptions.map(([k, lbl]) => {
                        const on = coinChoice === k;
                        return (
                          <button key={k} onClick={() => setCnChoice(k)} aria-pressed={on}
                            style={{ fontFamily: "var(--mono)", fontSize: 9, padding: "4px 10px",
                              background: on ? "var(--accent)" : "transparent", border: "none",
                              color: on ? "#07120c" : "var(--text)", cursor: "pointer" }}>
                            {lbl}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  {detected.xelisPossible && (
                    <Mono size={8} color="var(--warn)" style={{ display: "block", lineHeight: 1.5 }}>
                      These words are a valid Monero, Zephyr and Xelis seed alike, so the app cannot
                      tell which coin they belong to. Restored as the wrong coin they open a different,
                      empty wallet. Pick the coin the seed came from.
                    </Mono>
                  )}
                </div>
              ) : detected.kind === "zano" ? (
                detected.zanoAuditable ? (
                  <Mono size={9} color="var(--danger)">
                    Auditable Zano seed — auditable wallets aren't supported yet.
                  </Mono>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <Mono size={9} color="var(--accent)">Detected: Zano seed</Mono>
                    {zanoNeedsPassphrase && (
                      <>
                        <input
                          type="password"
                          value={zanoPassphrase}
                          onChange={(e) => setZanoPassphrase(e.target.value)}
                          placeholder="Secured Seed passphrase (required for this seed)"
                          style={inputStyle}
                        />
                        <Mono size={8} color="var(--warn)" style={{ display: "block", lineHeight: 1.5 }}>
                          A wrong passphrase opens a different, empty wallet rather than failing —
                          the checksum catches most mistakes, not all.
                        </Mono>
                      </>
                    )}
                  </div>
                )
              ) : detected.kind === "xelis" ? (
                <Mono size={9} color="var(--accent)">Detected: Xelis seed</Mono>
              ) : (
                <Mono size={9} color="var(--accent)">
                  Detected: {detected.kind === "bip39" ? "BIP39 recovery phrase" : "Monero polyseed"}
                </Mono>
              )
            )}

            {/* Restore date — 25-word Monero/Zephyr imports only. A polyseed
                carries its own birthday, a Zano seed its own date, a Xelis
                wallet takes no restore height, and a seed generated here
                starts at the chain tip. */}
            {addMode === "seed" && detected.ambiguous && !generatedFor && coinChoice !== "xelis" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }} data-restore-date>
                <Mono size={9} color="var(--text-dim)">Created around (optional)</Mono>
                <input
                  type="date"
                  value={restoreDate}
                  max={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => setRestoreDate(e.target.value)}
                  style={inputStyle}
                />
                <Mono size={8} color="var(--text-dim)" style={{ display: "block", lineHeight: 1.5 }}>
                  Scanning starts a month before this date. Blank scans the whole chain — slow, but it
                  can't miss funds.
                </Mono>
              </div>
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
