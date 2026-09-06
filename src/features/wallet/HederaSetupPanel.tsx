import { useCallback, useEffect, useState } from "react";
import { lookupHederaAccountId } from "../../wallets/hbar-wallet";

/**
 * "You don't have a Hedera account yet" — explained, with the thing you
 * actually need in order to get one.
 *
 * # Why this exists
 *
 * Reported after importing a seed: *"it said I didn't have an hbar set up"*.
 * The wallet was telling the truth — `hbarAdapter.getBalance` returns
 * `"No account (create on network)"` — but it said it as a bare balance
 * string in an assets list, which reads as a malfunction. It is not one:
 *
 * **On Hedera an account must be created ON-NETWORK before it can hold or
 * receive anything.** A key pair alone is not an account. Unlike Bitcoin or
 * Ethereum, where an address exists the moment you derive it, Hedera charges
 * a creation fee that some already-funded account has to pay, and only then
 * does `0.0.x` exist. Every Hedera wallet has this step; most just explain it.
 *
 * # Why not "auto-enroll"
 *
 * There is no self-service path: creating the account costs HBAR, and the
 * wallet has no funded account to pay from. Anything claiming to auto-enroll
 * is really "someone else pays" — a faucet, an exchange withdrawal, or a
 * friend. So the honest version of "make it easy" is: say plainly what is
 * needed, hand over the one value required to do it, and detect the moment
 * it lands.
 *
 * The detection half is already free: `getBalance` resolves the account by
 * PUBLIC KEY on every refresh, so once the account exists the normal balance
 * path picks it up with no further setup. This panel polls the same lookup
 * while it is open so the transition is visible rather than something the
 * user has to go hunting for.
 */
export function HederaSetupPanel({
  publicKeyHex,
  onCopy,
  compact = false,
}: {
  /** The derived Ed25519 public key — the adapter's "address" for Hedera. */
  publicKeyHex: string;
  onCopy?: (text: string) => void;
  compact?: boolean;
}) {
  const [checking, setChecking] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      setAccountId(await lookupHederaAccountId(publicKeyHex));
    } catch (e) {
      // A mirror-node failure is NOT "no account" — saying so would tell the
      // user to go create an account they may already have.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }, [publicKeyHex]);

  // Poll while the panel is open. 20s is slow enough to be invisible against
  // the mirror node's 100 req/s allowance and fast enough that a user who
  // just funded the account sees it appear without touching anything.
  useEffect(() => {
    void check();
    const t = setInterval(() => void check(), 20_000);
    return () => clearInterval(t);
  }, [check]);

  const copy = (v: string) => {
    navigator.clipboard?.writeText(v);
    onCopy?.(v);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const mono = "var(--font-mono, var(--mono))";
  const fs = compact ? 9 : 10;

  if (accountId) {
    return (
      <div style={{ ...box, borderColor: "rgba(0,212,170,0.4)", background: "rgba(0,212,170,0.06)" }}>
        <div style={{ ...title, color: "#00d4aa", fontSize: compact ? 10 : 11 }}>
          HEDERA ACCOUNT IS LIVE
        </div>
        <div style={{ fontFamily: mono, fontSize: fs, color: "var(--text-dim)", lineHeight: 1.5 }}>
          Your account <code style={{ color: "var(--text)" }}>{accountId}</code> exists on
          mainnet and is controlled by this seed. Balances and history load
          normally from here — nothing else to set up.
        </div>
      </div>
    );
  }

  return (
    <div style={box}>
      <div style={{ ...title, fontSize: compact ? 10 : 11 }}>
        HEDERA ACCOUNT NOT CREATED YET
      </div>

      <div style={{ fontFamily: mono, fontSize: fs, color: "var(--text-dim)", lineHeight: 1.55 }}>
        This is normal, and it is not a problem with your seed. On Hedera a key
        pair is not yet an account: <strong style={{ color: "var(--text)" }}>an
        account has to be created on-network</strong>, and the creation fee has to
        be paid by an account that already exists. Until then there is no
        <code> 0.0.x</code> to receive into.
      </div>

      <div style={{ marginTop: 10 }}>
        <div style={{ fontFamily: mono, fontSize: fs - 1, color: "var(--text-dim)", letterSpacing: 0.4, marginBottom: 4 }}>
          YOUR PUBLIC KEY — this is what an account-creation service asks for
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <code
            style={{
              flex: 1,
              minWidth: 0,
              fontFamily: mono,
              fontSize: fs - 1,
              color: "var(--text)",
              background: "rgba(255,255,255,0.04)",
              border: "1px solid var(--border)",
              padding: "5px 7px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={publicKeyHex}
          >
            {publicKeyHex}
          </code>
          <button type="button" onClick={() => copy(publicKeyHex)} style={btn}>
            {copied ? "copied" : "copy"}
          </button>
        </div>
      </div>

      <div style={{ fontFamily: mono, fontSize: fs - 1, color: "var(--text-dim)", lineHeight: 1.55, marginTop: 10 }}>
        Two routes that actually work:
        <div style={{ marginTop: 4 }}>
          1. <strong style={{ color: "var(--text)" }}>Withdraw HBAR from an
          exchange that creates accounts</strong> — some support sending to a
          public key / alias and create the account for you as part of the
          transfer.
        </div>
        <div style={{ marginTop: 3 }}>
          2. <strong style={{ color: "var(--text)" }}>Have an existing Hedera
          account create it</strong> — anyone with HBAR can create an account
          for the key above; it costs them a fraction of a cent.
        </div>
        <div style={{ marginTop: 6, opacity: 0.85 }}>
          Do <strong>not</strong> send HBAR to the key above as if it were an
          address from a wallet that only accepts <code>0.0.x</code> — that
          transfer has nowhere to land.
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
        <button type="button" onClick={() => void check()} disabled={checking} style={btn}>
          {checking ? "checking…" : "Check again"}
        </button>
        <span style={{ fontFamily: mono, fontSize: fs - 2, color: "var(--text-dim)" }}>
          {error
            ? `Could not reach the mirror node: ${error}`
            : "Re-checks automatically every 20s while this panel is open."}
        </span>
      </div>
    </div>
  );
}

const box: React.CSSProperties = {
  border: "1px solid rgba(240,160,32,0.35)",
  background: "rgba(240,160,32,0.06)",
  borderRadius: 3,
  padding: "12px 14px",
  marginTop: 10,
};
const title: React.CSSProperties = {
  fontFamily: "var(--font-mono, var(--mono))",
  letterSpacing: 0.6,
  color: "#f0a020",
  marginBottom: 6,
};
const btn: React.CSSProperties = {
  fontFamily: "var(--font-mono, var(--mono))",
  fontSize: 9,
  background: "transparent",
  border: "1px solid var(--border)",
  color: "var(--text)",
  padding: "4px 10px",
  cursor: "pointer",
  flexShrink: 0,
};
