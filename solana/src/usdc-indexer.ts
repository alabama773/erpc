/**
 * USDC deposit indexing core.
 *
 * A "deposit" is detected by diffing a transaction's pre/post SPL token
 * balances: for a given USDC token account, if the post balance is higher
 * than the pre balance, the owner received that difference. Raw integer
 * amounts (bigint) are used to avoid floating-point drift; formatting to a
 * human-readable value happens only at display time.
 */

/** Shape of an entry in meta.preTokenBalances / meta.postTokenBalances. */
export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: {
    amount: string; // raw integer as string
    decimals: number;
    uiAmount: number | null;
    uiAmountString?: string;
  };
}

/** Minimal shape of the `meta` object we rely on. */
export interface TxMeta {
  err: unknown;
  preTokenBalances?: TokenBalance[] | null;
  postTokenBalances?: TokenBalance[] | null;
}

export interface UsdcDelta {
  owner: string | null;
  accountIndex: number;
  preRaw: bigint;
  postRaw: bigint;
  deltaRaw: bigint; // post - pre; positive = received
  decimals: number;
}

/**
 * Compute per-token-account USDC balance deltas for a single transaction.
 * Only accounts whose mint equals `usdcMint` are considered. Failed
 * transactions (meta.err != null) are ignored (no balance change applied).
 */
export function extractUsdcDeltas(meta: TxMeta | null | undefined, usdcMint: string): UsdcDelta[] {
  if (!meta || meta.err) return [];

  const pre = new Map<number, TokenBalance>();
  const post = new Map<number, TokenBalance>();
  for (const b of meta.preTokenBalances ?? []) {
    if (b.mint === usdcMint) pre.set(b.accountIndex, b);
  }
  for (const b of meta.postTokenBalances ?? []) {
    if (b.mint === usdcMint) post.set(b.accountIndex, b);
  }

  const indices = new Set<number>([...pre.keys(), ...post.keys()]);
  const deltas: UsdcDelta[] = [];
  for (const idx of indices) {
    const p = pre.get(idx);
    const q = post.get(idx);
    const preRaw = p ? BigInt(p.uiTokenAmount.amount) : 0n;
    const postRaw = q ? BigInt(q.uiTokenAmount.amount) : 0n;
    const decimals = q?.uiTokenAmount.decimals ?? p?.uiTokenAmount.decimals ?? 6;
    const owner = q?.owner ?? p?.owner ?? null;
    deltas.push({ owner, accountIndex: idx, preRaw, postRaw, deltaRaw: postRaw - preRaw, decimals });
  }
  return deltas;
}

export interface DepositRecord {
  owner: string;
  amountRaw: bigint;
  decimals: number;
  signature?: string;
  slot?: number;
}

/** Keep only positive deltas (received funds) with a known owner. */
export function depositsFromDeltas(
  deltas: UsdcDelta[],
  ctx: { signature?: string; slot?: number } = {},
): DepositRecord[] {
  const out: DepositRecord[] = [];
  for (const d of deltas) {
    if (d.deltaRaw > 0n && d.owner) {
      out.push({
        owner: d.owner,
        amountRaw: d.deltaRaw,
        decimals: d.decimals,
        signature: ctx.signature,
        slot: ctx.slot,
      });
    }
  }
  return out;
}

export interface OwnerTotal {
  owner: string;
  totalRaw: bigint;
  decimals: number;
  depositCount: number;
}

/** Aggregate deposit records by owner. */
export function aggregateByOwner(records: DepositRecord[]): Map<string, OwnerTotal> {
  const totals = new Map<string, OwnerTotal>();
  for (const r of records) {
    const cur = totals.get(r.owner);
    if (cur) {
      cur.totalRaw += r.amountRaw;
      cur.depositCount++;
    } else {
      totals.set(r.owner, {
        owner: r.owner,
        totalRaw: r.amountRaw,
        decimals: r.decimals,
        depositCount: 1,
      });
    }
  }
  return totals;
}

export interface UsdcTransfer {
  from: string | null; // sender (USDC balance decreased); MULTIPLE(n) if ambiguous
  to: string; // receiver (USDC balance increased)
  amountRaw: bigint;
  decimals: number;
  signature?: string;
  slot?: number;
}

/**
 * Derive from -> to USDC transfers for a single transaction by pairing the
 * accounts that lost USDC (senders) with those that gained it (receivers).
 * - 1 sender  -> every receiver's `from` is that sender.
 * - N senders -> `from` = "MULTIPLE(N)" (a swap/router; exact pairing ambiguous).
 * - 0 senders -> `from` = null (mint/unwrap or sender not USDC-side of this tx).
 */
export function extractUsdcTransfers(
  deltas: UsdcDelta[],
  ctx: { signature?: string; slot?: number } = {},
): UsdcTransfer[] {
  const senders = deltas.filter((d) => d.deltaRaw < 0n && d.owner);
  const receivers = deltas.filter((d) => d.deltaRaw > 0n && d.owner);
  if (receivers.length === 0) return [];

  let from: string | null;
  if (senders.length === 1) from = senders[0]!.owner;
  else if (senders.length === 0) from = null;
  else from = `MULTIPLE(${senders.length})`;

  return receivers.map((r) => ({
    from,
    to: r.owner!,
    amountRaw: r.deltaRaw,
    decimals: r.decimals,
    signature: ctx.signature,
    slot: ctx.slot,
  }));
}

/** Format a raw integer token amount into a decimal string (no rounding). */
export function formatUsdc(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  const body = fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
  return neg ? `-${body}` : body;
}
