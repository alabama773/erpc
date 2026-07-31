/**
 * Show every USDC transfer (from -> to) inside a single block (by slot).
 *
 *   npm run block:transfers -- 435464598
 *   npm run block:transfers -- 435464598 <address>   # only rows touching this address
 *
 * "from" = account whose USDC balance decreased (sender)
 * "to"   = account whose USDC balance increased (receiver)
 * from = MULTIPLE(n) means several senders in one tx (swap/router, pairing ambiguous)
 * from = (none) means no USDC-side sender in this tx (mint / unwrap)
 */
import { loadProviders, USDC_MINT } from "./config.js";
import { FailoverRpcClient } from "./failover-client.js";
import {
  extractUsdcDeltas,
  extractUsdcTransfers,
  formatUsdc,
  type TxMeta,
  type UsdcTransfer,
} from "./usdc-indexer.js";

interface BlockTx {
  meta: TxMeta | null;
  transaction: { signatures?: string[] } | null;
}
interface GetBlockResult {
  transactions?: BlockTx[];
}

async function main(): Promise<void> {
  const slotArg = process.argv[2];
  const addrFilter = process.argv[3];
  if (!slotArg || !/^\d+$/.test(slotArg)) {
    console.error("Usage: npm run block:transfers -- <slot> [address]");
    process.exit(1);
  }
  const slot = Number(slotArg);

  const providers = loadProviders();
  const client = new FailoverRpcClient(providers, {
    onEvent: (e) => {
      if (e.type === "failover") console.error(`  [failover] ${e.from} -> ${e.to} (${e.method})`);
      if (e.type === "rate_limited") console.error(`  [rate-limit] ${e.provider} cooling ${e.cooldownMs}ms`);
    },
  });

  console.error(`Providers: ${providers.map((p) => p.name).join(", ")}`);
  console.error(`Fetching block at slot ${slot} ...`);

  const { result: block, provider } = await client.call<GetBlockResult | null>("getBlock", [
    slot,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, transactionDetails: "full", rewards: false },
  ]);

  if (!block) {
    console.error(`Block at slot ${slot} not found / skipped (served by ${provider}).`);
    process.exit(2);
  }
  const txs = block.transactions ?? [];
  console.error(`Served by ${provider}. Transactions in block: ${txs.length}`);

  const transfers: UsdcTransfer[] = [];
  for (const tx of txs) {
    const sig = tx.transaction?.signatures?.[0];
    const deltas = extractUsdcDeltas(tx.meta, USDC_MINT);
    transfers.push(...extractUsdcTransfers(deltas, { signature: sig, slot }));
  }

  const rows = addrFilter
    ? transfers.filter((t) => t.from === addrFilter || t.to === addrFilter)
    : transfers;

  console.log(`\n=== USDC transfers in block ${slot} (mint ${USDC_MINT}) ===`);
  console.log(`Total USDC transfers: ${transfers.length}${addrFilter ? ` | matching ${addrFilter}: ${rows.length}` : ""}\n`);

  for (const t of rows) {
    const from = t.from ?? "(none)";
    console.log(`${formatUsdc(t.amountRaw, t.decimals).padStart(16)} USDC   FROM ${from}`);
    console.log(`${" ".repeat(21)}  TO   ${t.to}`);
    console.log(`${" ".repeat(21)}  tx   ${t.signature}\n`);
  }

  console.error(`Provider stats:`);
  for (const s of client.getStats()) {
    console.error(`  ${s.name}: req=${s.requests} ok=${s.successes} 429=${s.rateLimited} err=${s.otherErrors}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
