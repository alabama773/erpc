/**
 * Solana failover HTTP gateway.
 *
 *   npm run serve                 # listens on :4100
 *   PORT=4100 npm run serve
 *
 * Exposes the failover client over plain JSON-RPC HTTP so tools like Postman
 * or curl can hit ONE URL and get automatic multi-provider failover -
 * symmetric with how eRPC works for EVM. Every response carries diagnostic
 * headers so you can SEE which provider served the request:
 *
 *   X-RPC-Provider : provider that served this call (e.g. "helius")
 *   X-RPC-Attempts : how many providers were tried before success
 *
 * URL:
 *   POST /            standard Solana JSON-RPC (single object or batch array)
 *   GET  /health      gateway liveness + provider list
 *   GET  /stats       per-provider request/success/429 counters
 *
 * This is intentionally dependency-free (Node's built-in http module).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadProviders, USDC_MINT } from "./config.js";
import { FailoverRpcClient } from "./failover-client.js";
import {
  extractUsdcDeltas,
  extractUsdcTransfers,
  formatUsdc,
  type TxMeta,
  type UsdcTransfer,
} from "./usdc-indexer.js";

const PORT = Number(process.env.PORT ?? 4100);

const providers = loadProviders();
const client = new FailoverRpcClient(providers, {
  onEvent: (e) => {
    if (e.type === "failover") console.error(`[failover] ${e.from} -> ${e.to} (${e.method})`);
    if (e.type === "rate_limited") console.error(`[rate-limit] ${e.provider} cooling ${e.cooldownMs}ms`);
  },
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(payload);
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown[];
}

async function handleSingle(
  reqObj: JsonRpcRequest,
): Promise<{ response: unknown; provider: string; attempts: number }> {
  const id = reqObj.id ?? null;
  if (!reqObj.method || typeof reqObj.method !== "string") {
    return {
      response: { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request: missing method" } },
      provider: "-",
      attempts: 0,
    };
  }
  try {
    const { result, provider, attempts } = await client.call<unknown>(reqObj.method, reqObj.params ?? []);
    return { response: { jsonrpc: "2.0", id, result }, provider, attempts };
  } catch (err) {
    return {
      response: {
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      },
      provider: "-",
      attempts: 0,
    };
  }
}

interface BlockTx {
  meta: TxMeta | null;
  transaction: { signatures?: string[] } | null;
}
interface GetBlockResult {
  transactions?: BlockTx[];
}

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
}

/** Run an async mapper with a bounded number of workers in flight. */
async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return out;
}

// ---- USDC price (USD) with a short in-memory cache ----
let priceCache = { value: 1.0, at: 0 };
const PRICE_TTL_MS = 60_000; // refresh at most once a minute

/**
 * Current USDC price in USD. USDC is a stablecoin (~$1.00). We fetch the live
 * price from CoinGecko's free endpoint (cached 60s) and fall back to 1.0 if the
 * request fails, so the gateway never breaks over a price lookup.
 */
async function getUsdcPrice(): Promise<number> {
  const now = Date.now();
  if (now - priceCache.at < PRICE_TTL_MS) return priceCache.value;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=usd",
      { signal: controller.signal },
    );
    clearTimeout(timer);
    const j = (await res.json()) as { "usd-coin"?: { usd?: number } };
    const p = j["usd-coin"]?.usd;
    if (typeof p === "number" && p > 0) priceCache = { value: p, at: now };
  } catch {
    // keep last known / fallback value
  }
  return priceCache.value;
}

/** Multiply a decimal amount string by price, return a 2-dp USD string. */
function toUsd(amount: string, price: number): string {
  const n = Number(amount);
  if (!isFinite(n)) return "0.00";
  return (n * price).toFixed(2);
}

/**
 * Given a wallet address, find its USDC token accounts, scan the most recent
 * `limit` signatures, and return every USDC transfer (from -> to) that touches
 * the wallet. No block/slot needed - just the address.
 */
async function getAddressUsdcTransfers(
  owner: string,
  limit: number,
): Promise<{ transfers: unknown[]; scanned: number; provider: string }> {
  const price = await getUsdcPrice();
  const { result: accounts, provider } = await client.call<TokenAccountsByOwner>("getTokenAccountsByOwner", [
    owner,
    { mint: USDC_MINT },
    { encoding: "jsonParsed" },
  ]);
  const tokenAccounts = (accounts.value ?? []).map((v) => v.pubkey);

  // Collect recent signatures across the wallet's USDC token accounts.
  const sigs: SignatureInfo[] = [];
  for (const acct of tokenAccounts) {
    const { result } = await client.call<SignatureInfo[]>("getSignaturesForAddress", [
      acct,
      { limit },
    ]);
    for (const s of result ?? []) if (!s.err) sigs.push(s);
  }

  // Fetch each transaction (bounded concurrency) and extract USDC transfers.
  const perTx = await mapPool(sigs, 5, async (s) => {
    const { result: tx } = await client.call<TxResponse | null>("getTransaction", [
      s.signature,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
    ]);
    if (!tx) return [] as UsdcTransfer[];
    const deltas = extractUsdcDeltas(tx.meta, USDC_MINT);
    return extractUsdcTransfers(deltas, { signature: s.signature, slot: tx.slot });
  });

  const transfers = perTx
    .flat()
    .filter((t) => t.from === owner || t.to === owner)
    .map((t) => ({
      direction: t.to === owner ? "in" : "out",
      from: t.from,
      to: t.to,
      amount: formatUsdc(t.amountRaw, t.decimals),
      amountRaw: t.amountRaw.toString(),
      unit: "USDC",
      price: price,
      valueUsd: toUsd(formatUsdc(t.amountRaw, t.decimals), price),
      block: t.slot, // on Solana the slot IS the block number
      slot: t.slot,
      signature: t.signature,
    }));

  return { transfers, scanned: sigs.length, provider };
}

/** Fetch a block by slot and return all USDC transfers (from -> to) in it. */
async function getBlockUsdcTransfers(
  slot: number,
  addrFilter?: string,
): Promise<{ transfers: unknown[]; total: number; matched: number; provider: string }> {
  const price = await getUsdcPrice();
  const { result: block, provider } = await client.call<GetBlockResult | null>("getBlock", [
    slot,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, transactionDetails: "full", rewards: false },
  ]);
  if (!block) return { transfers: [], total: 0, matched: 0, provider };

  const all: UsdcTransfer[] = [];
  for (const tx of block.transactions ?? []) {
    const sig = tx.transaction?.signatures?.[0];
    const deltas = extractUsdcDeltas(tx.meta, USDC_MINT);
    all.push(...extractUsdcTransfers(deltas, { signature: sig, slot }));
  }
  const rows = addrFilter ? all.filter((t) => t.from === addrFilter || t.to === addrFilter) : all;
  const transfers = rows.map((t) => ({
    from: t.from,
    to: t.to,
    amount: formatUsdc(t.amountRaw, t.decimals),
    amountRaw: t.amountRaw.toString(),
    unit: "USDC",
    price: price,
    valueUsd: toUsd(formatUsdc(t.amountRaw, t.decimals), price),
    block: t.slot ?? slot, // on Solana the slot IS the block number
    signature: t.signature,
  }));
  return { transfers, total: all.length, matched: rows.length, provider };
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { status: "ok", providers: providers.map((p) => p.name) });
      return;
    }
    if (req.method === "GET" && req.url === "/stats") {
      // Redact the URL so API keys are never exposed via /stats. Keep only
      // the host (no query string / no ?api-key=...).
      const safe = client.getStats().map((s) => {
        let host = s.url;
        try {
          host = new URL(s.url).host;
        } catch {
          host = "";
        }
        const { url, ...rest } = s;
        return { ...rest, host };
      });
      sendJson(res, 200, { providers: safe });
      return;
    }
    // GET /address/<addr>          recent USDC transfers touching this wallet
    // GET /address/<addr>?limit=50 how many recent signatures to scan (default 25)
    if (req.method === "GET" && req.url?.startsWith("/address/")) {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const addr = url.pathname.split("/")[2] ?? "";
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 25), 1), 200);
      if (addr.length < 32) {
        sendJson(res, 400, { error: "Usage: GET /address/<walletAddress>?limit=<1-200>" });
        return;
      }
      try {
        const out = await getAddressUsdcTransfers(addr, limit);
        sendJson(
          res,
          200,
          {
            address: addr,
            mint: USDC_MINT,
            scannedSignatures: out.scanned,
            matched: out.transfers.length,
            transfers: out.transfers,
          },
          { "x-rpc-provider": out.provider },
        );
      } catch (err) {
        sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    // GET /block/<slot>            all USDC transfers (from -> to) in the block
    // GET /block/<slot>?address=X  only transfers touching address X
    if (req.method === "GET" && req.url?.startsWith("/block/")) {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const slotStr = url.pathname.split("/")[2] ?? "";
      const addr = url.searchParams.get("address") ?? undefined;
      if (!/^\d+$/.test(slotStr)) {
        sendJson(res, 400, { error: "Usage: GET /block/<slot>?address=<optional>" });
        return;
      }
      try {
        const out = await getBlockUsdcTransfers(Number(slotStr), addr);
        sendJson(
          res,
          200,
          {
            slot: Number(slotStr),
            mint: USDC_MINT,
            totalTransfers: out.total,
            matched: out.matched,
            filter: addr ?? null,
            transfers: out.transfers,
          },
          { "x-rpc-provider": out.provider },
        );
      } catch (err) {
        sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Use POST with a JSON-RPC body, or GET /health, GET /stats" });
      return;
    }

    const raw = await readBody(req);
    let parsed: JsonRpcRequest | JsonRpcRequest[];
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }

    // Batch request (JSON-RPC array).
    if (Array.isArray(parsed)) {
      const outcomes = await Promise.all(parsed.map(handleSingle));
      const providersUsed = [...new Set(outcomes.map((o) => o.provider))].join(",");
      sendJson(
        res,
        200,
        outcomes.map((o) => o.response),
        { "x-rpc-provider": providersUsed, "x-rpc-batch": String(outcomes.length) },
      );
      return;
    }

    // Single request.
    const { response, provider, attempts } = await handleSingle(parsed);
    sendJson(res, 200, response, {
      "x-rpc-provider": provider,
      "x-rpc-attempts": String(attempts),
    });
  } catch (err) {
    sendJson(res, 500, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: err instanceof Error ? err.message : "Internal error" },
    });
  }
});

server.listen(PORT, () => {
  console.error(`Solana failover gateway listening on http://localhost:${PORT}`);
  console.error(`Providers (priority order): ${providers.map((p) => p.name).join(", ")}`);
  console.error(`  POST /             -> Solana JSON-RPC with failover (see X-RPC-Provider header)`);
  console.error(`  GET  /health       -> liveness + provider list`);
  console.error(`  GET  /stats        -> per-provider counters`);
  console.error(`  GET  /block/<slot> -> all USDC transfers (from -> to) in a block`);
  console.error(`  GET  /address/<a>  -> recent USDC transfers touching a wallet`);
});
