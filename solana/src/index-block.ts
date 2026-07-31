/**
 * Index all USDC deposits within a single block (by slot) and print per-owner
 * totals. Used to verify against a known block, e.g.:
 *
 *   npm run index:block -- 435464598
 *   npm run index:block -- 435464598 5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD
 *
 * An optional second argument filters output to a specific owner address.
 */
import { loadProviders, USDC_MINT } from "./config.js";
import { FailoverRpcClient } from "./failover-client.js";
import {
  aggregateByOwner,
  depositsFromDeltas,
  extractUsdcDeltas,
  formatUsdc,
  type DepositRecord,
  type TxMeta,
} from "./usdc-indexer.js";

interface BlockTx {
  meta: TxMeta | null;
  transaction: { signatures?: string[] } | null;
}
interface GetBlockResult {
  blockHeight?: number;
  blockTime?: number | null;
  transactions?: BlockTx[];
}

async function main(): Promise<void> {
  const slotArg = process.argv[2];
  const ownerFilter = process.argv[3];
  if (!slotArg || !/^\d+$/.test(slotArg)) {
    console.error("Usage: npm run index:block -- <slot> [ownerAddress]");
    process.exit(1);
  }
  const slot = Number(slotArg);

  const providers = loadProviders();
  const client = new FailoverRpcClient(providers, {
    onEvent: (e) => {
      if (e.type === "failover") console.error(`  [failover] ${e.from} -> ${e.to} (${e.method})`);
      if (e.type === "rate_limited") console.error(`  [rate-limit] ${e.provider} cooling down ${e.cooldownMs}ms`);
    },
  });

  console.error(`Providers (in priority order): ${providers.map((p) => p.name).join(", ")}`);
  console.error(`Fetching block at slot ${slot} ...`);

  const { result: block, provider, attempts } = await client.call<GetBlockResult | null>("getBlock", [
    slot,
    {
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 0,
      transactionDetails: "full",
      rewards: false,
    },
  ]);

  if (!block) {
    console.error(`Block at slot ${slot} not found / skipped (served by ${provider}).`);
    process.exit(2);
  }
  const txs = block.transactions ?? [];
  console.error(`Served by ${provider} (attempts=${attempts}). Transactions in block: ${txs.length}`);

  const allDeposits: DepositRecord[] = [];
  for (const tx of txs) {
    const sig = tx.transaction?.signatures?.[0];
    const deltas = extractUsdcDeltas(tx.meta, USDC_MINT);
    const deposits = depositsFromDeltas(deltas, { signature: sig, slot });
    allDeposits.push(...deposits);
  }

  const totals = aggregateByOwner(allDeposits);

  console.log(`\n=== USDC deposits in block ${slot} (mint ${USDC_MINT}) ===`);
  console.log(`Distinct recipients: ${totals.size} | total deposit events: ${allDeposits.length}\n`);

  const rows = [...totals.values()]
    .filter((t) => !ownerFilter || t.owner === ownerFilter)
    .sort((a, b) => (b.totalRaw > a.totalRaw ? 1 : b.totalRaw < a.totalRaw ? -1 : 0));

  if (ownerFilter && rows.length === 0) {
    console.log(`No USDC deposits found for ${ownerFilter} in block ${slot}.`);
  }
  for (const t of rows) {
    console.log(`${t.owner}  +${formatUsdc(t.totalRaw, t.decimals)} USDC  (${t.depositCount} deposit${t.depositCount > 1 ? "s" : ""})`);
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
