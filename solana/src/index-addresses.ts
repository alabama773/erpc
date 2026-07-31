/**
 * Index USDC deposits received by a set of wallet addresses.
 *
 *   npm run index:addresses
 *   npm run index:addresses -- <addr1> <addr2> ... [--limit N]
 *
 * Addresses come from CLI args, or fall back to WALLET_ADDRESSES in .env.
 * `--limit N` caps how many recent signatures per token account are scanned
 * (default 200) to keep RPC volume bounded.
 *
 * Approach: for each wallet, discover its USDC token accounts via
 * getTokenAccountsByOwner (mint-filtered), page through getSignaturesForAddress
 * on each token account, then getTransaction to diff pre/post token balances.
 * All RPC goes through the failover client.
 */
import { loadProviders, loadWalletAddresses, USDC_MINT } from "./config.js";
import { FailoverRpcClient } from "./failover-client.js";
import {
  aggregateByOwner,
  depositsFromDeltas,
  extractUsdcDeltas,
  formatUsdc,
  type DepositRecord,
  type TxMeta,
} from "./usdc-indexer.js";

interface TokenAccountsByOwner {
  value: Array<{ pubkey: string }>;
}
interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown;
}
interface TxResponse {
  slot: number;
  meta: TxMeta | null;
  transaction: { signatures?: string[] } | null;
}

function parseArgs(): { addresses: string[]; limit: number; concurrency: number } {
  const args = process.argv.slice(2);
  let limit = 200;
  let concurrency = 8;
  const addresses: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit") {
      limit = Number(args[++i]);
    } else if (args[i] === "--concurrency") {
      concurrency = Math.max(1, Number(args[++i]));
    } else {
      addresses.push(args[i]);
    }
  }
  return { addresses: addresses.length > 0 ? addresses : loadWalletAddresses(), limit, concurrency };
}

/** Run an async mapper over items with a bounded number of workers in flight. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let done = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await mapper(items[i]!, i);
      done++;
      onProgress?.(done, items.length);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function getUsdcTokenAccounts(client: FailoverRpcClient, owner: string): Promise<string[]> {
  const { result } = await client.call<TokenAccountsByOwner>("getTokenAccountsByOwner", [
    owner,
    { mint: USDC_MINT },
    { encoding: "jsonParsed" },
  ]);
  return (result.value ?? []).map((v) => v.pubkey);
}

async function getSignatures(
  client: FailoverRpcClient,
  account: string,
  limit: number,
): Promise<SignatureInfo[]> {
  const collected: SignatureInfo[] = [];
  let before: string | undefined;
  while (collected.length < limit) {
    const pageSize = Math.min(1000, limit - collected.length);
    const { result } = await client.call<SignatureInfo[]>("getSignaturesForAddress", [
      account,
      before ? { limit: pageSize, before } : { limit: pageSize },
    ]);
    if (!result || result.length === 0) break;
    collected.push(...result);
    before = result[result.length - 1]!.signature;
    if (result.length < pageSize) break;
  }
  return collected;
}

async function main(): Promise<void> {
  const { addresses, limit, concurrency } = parseArgs();
  if (addresses.length === 0) {
    console.error("No addresses. Pass them as args or set WALLET_ADDRESSES in .env.");
    process.exit(1);
  }

  const providers = loadProviders();
  const client = new FailoverRpcClient(providers, {
    onEvent: (e) => {
      if (e.type === "failover") console.error(`  [failover] ${e.from} -> ${e.to} (${e.method})`);
      if (e.type === "rate_limited") console.error(`  [rate-limit] ${e.provider} cooling down ${e.cooldownMs}ms`);
    },
  });

  console.error(`Providers (priority order): ${providers.map((p) => p.name).join(", ")}`);
  console.error(`Indexing USDC deposits for ${addresses.length} address(es), limit=${limit}/account\n`);

  const allDeposits: DepositRecord[] = [];
  const targetSet = new Set(addresses);

  for (const owner of addresses) {
    const accounts = await getUsdcTokenAccounts(client, owner);
    console.error(`${owner}: ${accounts.length} USDC token account(s)`);
    for (const acct of accounts) {
      const sigs = (await getSignatures(client, acct, limit)).filter((s) => !s.err);
      console.error(`  ${acct}: scanning ${sigs.length} signature(s) with concurrency=${concurrency}`);

      let lastLogged = 0;
      const perTx = await mapWithConcurrency(
        sigs,
        concurrency,
        async (s) => {
          const { result: tx } = await client.call<TxResponse | null>("getTransaction", [
            s.signature,
            { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
          ]);
          if (!tx) return [] as DepositRecord[];
          const deltas = extractUsdcDeltas(tx.meta, USDC_MINT);
          // Only count deposits credited to one of our target owners.
          return depositsFromDeltas(deltas, { signature: s.signature, slot: tx.slot }).filter((d) =>
            targetSet.has(d.owner),
          );
        },
        (dn, total) => {
          // Log progress every ~250 transactions to avoid spam.
          if (dn - lastLogged >= 250 || dn === total) {
            lastLogged = dn;
            console.error(`    progress: ${dn}/${total}`);
          }
        },
      );
      for (const deposits of perTx) allDeposits.push(...deposits);
    }
  }

  const totals = aggregateByOwner(allDeposits);
  console.log(`\n=== USDC deposit totals (mint ${USDC_MINT}) ===\n`);
  for (const owner of addresses) {
    const t = totals.get(owner);
    if (t) {
      console.log(`${owner}  +${formatUsdc(t.totalRaw, t.decimals)} USDC  (${t.depositCount} deposits)`);
    } else {
      console.log(`${owner}  +0 USDC  (0 deposits)`);
    }
  }

  console.error(`\nProvider stats:`);
  for (const s of client.getStats()) {
    console.error(`  ${s.name}: req=${s.requests} ok=${s.successes} 429=${s.rateLimited} err=${s.otherErrors}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
