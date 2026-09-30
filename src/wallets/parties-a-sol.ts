/**
 * Solana and its SPL legs: who sent a transaction and who received it, from
 * its `getTransaction` (`jsonParsed`) answer (`ChainAdapter.getTransactionParties`,
 * 2026-09-30). The reading is here; `sol-wallet.ts` fetches.
 *
 * # Why this exists
 *
 * The operator asked to see, in a transaction's details, which address it was
 * sent from and which it was received at. Solana's history lists signatures,
 * which carry no addresses; SPL rows carry no direction and no amount either
 * (`spl-token-wallet.ts` would need one parsed transaction per row for them).
 *
 * # Native SOL
 *
 * The System program's parsed `transfer` / `transferWithSeed` instructions,
 * `info.source` → `info.destination` (inner ones too, when the transaction
 * succeeded: a program can move SOL by CPI). A transaction with none — a
 * program call — falls back to the lamport balances: accounts that lost
 * lamports sent, accounts that gained received, the fee payer's fee excepted.
 * A failed transaction moved nothing but its top-level instructions still
 * name whom it was for.
 *
 * # SPL
 *
 * `meta.preTokenBalances` / `postTokenBalances` for the leg's mint, read as
 * each token account's OWNER: the wallet, never the token account. The owner
 * printed there is the account's owner NOW, which need not be the wallet
 * whose associated account it is: the world-public test address's USDC and
 * USDT associated accounts were created and handed to vanity owners
 * (`usdc8Uk…`, `usdt8Smz…`) in one transaction by someone holding the public
 * seed (2RftcbzfNi…, read live 2026-09-30), so a payment to that "wallet"
 * reaches them. The parsed Token-program `transfer` / `transferChecked`
 * instructions pair senders with recipients, so a transaction that moves the
 * token several times lists only the transfers involving the wallet.
 *
 * SPL also fills the wallet's `direction` and `amount` (its net change in the
 * mint, in the leg's configured decimals) and, when the wallet paid it, the fee.
 */
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { base58 } from "@scure/base";
import type { TxDirection, TxParties } from "./types";
import { atomicToDecimal } from "./decimal-amount";

type Parties = { from: string[]; to: string[] };

interface Transfer {
  from?: string;
  to?: string;
  amount: bigint;
}

/** A transaction signature: base58 of 64 bytes. */
export function isSolanaSignature(s: string): boolean {
  try {
    return base58.decode(s).length === 64;
  } catch {
    return false;
  }
}

function uniqueAddrs(list: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const a of list) if (a && !out.includes(a)) out.push(a);
  return out;
}

/** An account key as base58, whether web3.js built a `PublicKey` or left a string. */
function keyText(k: unknown): string {
  const pk = (k as { pubkey?: unknown } | null)?.pubkey ?? k;
  if (typeof pk === "string") return pk;
  const b58 = (pk as { toBase58?: () => string } | null)?.toBase58;
  return typeof b58 === "function" ? b58.call(pk) : "";
}

function accountKeys(tx: ParsedTransactionWithMeta): string[] {
  return (tx.transaction?.message?.accountKeys ?? []).map(keyText);
}

interface ParsedIx {
  program?: string;
  parsed?: { type?: string; info?: Record<string, any> };
}

/** Top-level instructions, then inner ones — those only when the transaction succeeded. */
function instructions(tx: ParsedTransactionWithMeta): ParsedIx[] {
  const top = (tx.transaction?.message?.instructions ?? []) as ParsedIx[];
  if (tx.meta?.err) return top;
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions as ParsedIx[]);
  return [...top, ...inner];
}

function atomic(v: unknown): bigint | null {
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** The transfers that involve `own`, or all of them when none does. */
function pickTransfers(transfers: Transfer[], own: string): Transfer[] {
  const mine = transfers.filter((t) => t.from === own || t.to === own);
  return mine.length ? mine : transfers;
}

function partiesOf(transfers: Transfer[]): Parties {
  return { from: uniqueAddrs(transfers.map((t) => t.from)), to: uniqueAddrs(transfers.map((t) => t.to)) };
}

/** Native SOL: see the header. Exported for tests. */
export function solNativeParties(tx: ParsedTransactionWithMeta, own: string): Parties {
  const transfers: Transfer[] = [];
  for (const ix of instructions(tx)) {
    const type = ix.parsed?.type;
    if (ix.program !== "system" || (type !== "transfer" && type !== "transferWithSeed")) continue;
    const info = ix.parsed?.info ?? {};
    transfers.push({ from: str(info.source), to: str(info.destination), amount: atomic(info.lamports) ?? 0n });
  }
  if (transfers.length) return partiesOf(pickTransfers(transfers, own));

  // No System transfer: read what moved from the lamport balances.
  const meta = tx.meta;
  const keys = accountKeys(tx);
  const pre = meta?.preBalances ?? [];
  const post = meta?.postBalances ?? [];
  const fee = typeof meta?.fee === "number" ? meta.fee : 0;
  const from: string[] = [];
  const to: string[] = [];
  keys.forEach((k, i) => {
    if (typeof pre[i] !== "number" || typeof post[i] !== "number") return;
    const delta = post[i] - pre[i] + (i === 0 ? fee : 0);
    if (delta < 0) from.push(k);
    else if (delta > 0) to.push(k);
  });
  return { from: uniqueAddrs(from), to: uniqueAddrs(to) };
}

/** What `splParties` returns: the parties, and the wallet's side of it. */
export type SplParties = Omit<TxParties, "source" | "senderHidden">;

/** SPL: see the header. `decimals` is the leg's configured (on-chain verified) count. Exported for tests. */
export function splParties(
  tx: ParsedTransactionWithMeta,
  mint: string,
  decimals: number,
  own: string,
): SplParties {
  const meta = tx.meta;
  const ok = !meta?.err;
  const keys = accountKeys(tx);

  // Every token account in the transaction: its mint; and for this mint, its
  // owner and its balance before and after.
  const mintAt = new Map<number, string>();
  const accts = new Map<number, { owner?: string; pre: bigint; post: bigint }>();
  const note = (b: any, side: "pre" | "post") => {
    if (!b || !Number.isInteger(b.accountIndex)) return;
    if (typeof b.mint === "string") mintAt.set(b.accountIndex, b.mint);
    if (b.mint !== mint) return;
    const amount = atomic(b.uiTokenAmount?.amount);
    if (amount === null) return;
    const e = accts.get(b.accountIndex) ?? { pre: 0n, post: 0n };
    e[side] = amount;
    // The owner after the transaction, when it changed hands inside it.
    if (str(b.owner) && (side === "post" || !e.owner)) e.owner = b.owner;
    accts.set(b.accountIndex, e);
  };
  for (const b of meta?.preTokenBalances ?? []) note(b, "pre");
  for (const b of meta?.postTokenBalances ?? []) note(b, "post");

  const indexOf = (account: unknown) => (typeof account === "string" ? keys.indexOf(account) : -1);
  const ownerOf = (account: unknown) => accts.get(indexOf(account))?.owner;

  // This mint's transfers, paired, from the Token program's parsed instructions.
  const transfers: Transfer[] = [];
  for (const ix of instructions(tx)) {
    const type = ix.parsed?.type;
    if ((ix.program !== "spl-token" && ix.program !== "spl-token-2022") || (type !== "transfer" && type !== "transferChecked")) {
      continue;
    }
    const info = ix.parsed?.info ?? {};
    // `transferChecked` names the mint; plain `transfer` only its accounts.
    const m = str(info.mint) ?? mintAt.get(indexOf(info.source)) ?? mintAt.get(indexOf(info.destination));
    if (m !== mint) continue;
    const amount = atomic(info.tokenAmount?.amount ?? info.amount);
    if (amount === null) continue;
    transfers.push({
      from: ownerOf(info.source) ?? str(info.authority) ?? str(info.multisigAuthority),
      to: ownerOf(info.destination),
      amount,
    });
  }
  const mine = transfers.filter((t) => t.from === own || t.to === own);

  // Owners whose balance fell, then rose, in account order.
  const byIndex = [...accts.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e);
  const fell = uniqueAddrs(byIndex.filter((e) => e.post < e.pre).map((e) => e.owner));
  const rose = uniqueAddrs(byIndex.filter((e) => e.post > e.pre).map((e) => e.owner));

  const parties: Parties = mine.length
    ? partiesOf(mine)
    : ok && (fell.length || rose.length)
      ? { from: fell, to: rose }
      : partiesOf(transfers);

  // The wallet's side: its net change in this mint.
  let net = 0n;
  for (const e of byIndex) if (e.owner === own) net += e.post - e.pre;
  const sum = (list: Transfer[]) => list.reduce((t, x) => t + x.amount, 0n);
  let direction: TxDirection | undefined;
  let amount: bigint | undefined;
  if (!ok) {
    // Nothing moved. The amount is what it was for, as a failed EVM row shows.
    direction = "failed";
    amount = mine.length ? sum(mine) : undefined;
  } else if (net > 0n) {
    direction = "in";
    amount = net;
  } else if (net < 0n) {
    direction = "out";
    amount = -net;
  } else if (mine.length) {
    // Between the wallet's own accounts, or out and back again.
    direction = "self";
    amount = sum(mine.filter((t) => t.from === own && t.to === own));
  }
  // Otherwise the wallet took no part in it (a payment to an associated
  // account it no longer owns, say): no side to report.

  return {
    ...parties,
    ...(direction ? { direction } : {}),
    ...(amount !== undefined ? { amount: atomicToDecimal(amount, decimals) } : {}),
    // The fee payer signs first, so it is the first account key.
    ...(keys[0] === own && typeof meta?.fee === "number" ? { fee: atomicToDecimal(BigInt(meta.fee), 9) } : {}),
  };
}
