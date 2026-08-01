/**
 * Unified gateway ("receptionist") - one address that routes to both backends.
 *
 *   node proxy.mjs           # listens on :8080
 *   PORT=8080 node proxy.mjs
 *
 * One entry point, automatic routing:
 *   POST /evm/<chainId>        -> eRPC        (rewritten to /main/evm/<chainId>)
 *   POST /solana               -> Solana gw   (rewritten to /)
 *   GET  /solana/health        -> Solana gw   /health
 *   GET  /solana/stats         -> Solana gw   /stats
 *   GET  /solana/block/<slot>  -> Solana gw   /block/<slot>
 *   GET  /solana/address/<a>   -> Solana gw   /address/<a>
 *   GET  /health               -> this proxy: status of both backends
 *   GET  /                     -> route list
 *
 * Targets are configurable via env (so it works both in Docker and as a plain
 * process). In Docker we point at host.docker.internal to reach the published
 * ports of the eRPC and Solana containers.
 */
import { createServer, request as httpRequest } from "node:http";

const PORT = Number(process.env.PORT ?? 8080);
const ERPC_TARGET = process.env.ERPC_TARGET ?? "http://localhost:4000";
const SOLANA_TARGET = process.env.SOLANA_TARGET ?? "http://localhost:4100";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body);
}

/** Forward a request to `${targetBase}${targetPath}` and pipe the response back. */
function forward(targetBase, targetPath, method, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetPath, targetBase);
    const opts = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: { ...headers, host: u.host },
    };
    const upstream = httpRequest(opts, (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => resolve({ status: r.statusCode ?? 502, headers: r.headers, body: Buffer.concat(chunks) }));
    });
    upstream.on("error", reject);
    if (body && body.length) upstream.write(body);
    upstream.end();
  });
}

// ---- EVM USDC transfer decoding (ETH + BSC) ----
// ERC-20 Transfer(address,address,uint256) event signature.
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// Per-chain USDC contract + decimals. NOTE: BSC USDC is 18 decimals, ETH is 6.
const USDC = {
  "1": { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, name: "Ethereum USDC" },
  "56": { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, name: "BSC USDC" },
};

/** Send a JSON-RPC call to eRPC for a given chain and return the result (throws on error). */
async function erpcRpc(chainId, method, params) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  const r = await forward(ERPC_TARGET, `/main/evm/${chainId}`, "POST", { "content-type": "application/json" }, body);
  const j = JSON.parse(r.body.toString("utf8"));
  if (j.error) throw new Error(`eRPC ${method} failed: ${j.error.message ?? "unknown"}`);
  return j.result;
}

function padAddress(addr) {
  return "0x000000000000000000000000" + addr.toLowerCase().replace(/^0x/, "");
}
function addrFromTopic(topic) {
  return "0x" + topic.slice(topic.length - 40);
}
function formatUnits(raw, decimals) {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  const bodyStr = fracStr.length ? `${whole}.${fracStr}` : `${whole}`;
  return neg ? `-${bodyStr}` : bodyStr;
}
function decodeTransferLog(log, decimals) {
  const from = addrFromTopic(log.topics[1]);
  const to = addrFromTopic(log.topics[2]);
  const raw = BigInt(log.data && log.data !== "0x" ? log.data : "0x0");
  return {
    from,
    to,
    amount: formatUnits(raw, decimals),
    amountRaw: raw.toString(),
    block: log.blockNumber ? Number(BigInt(log.blockNumber)) : null,
    tx: log.transactionHash,
  };
}

/** All USDC transfers (from->to) in a single EVM block. */
async function evmBlockUsdcTransfers(chainId, blockNumber) {
  const cfg = USDC[chainId];
  if (!cfg) throw new Error(`No USDC config for chain ${chainId} (only 1=ETH, 56=BSC)`);
  const blockHex = "0x" + BigInt(blockNumber).toString(16);
  const logs = await erpcRpc(chainId, "eth_getLogs", [
    { fromBlock: blockHex, toBlock: blockHex, address: cfg.address, topics: [TRANSFER_TOPIC] },
  ]);
  return { chain: chainId, token: cfg.name, transfers: (logs ?? []).map((l) => decodeTransferLog(l, cfg.decimals)) };
}

/**
 * USDC transfers touching an address within a recent block range.
 * EVM has no "all txns for address" call, so we scan a block window via
 * eth_getLogs (default last 500 blocks; override with ?range=).
 */
async function evmAddressUsdcTransfers(chainId, addr, range) {
  const cfg = USDC[chainId];
  if (!cfg) throw new Error(`No USDC config for chain ${chainId} (only 1=ETH, 56=BSC)`);
  const latest = BigInt(await erpcRpc(chainId, "eth_blockNumber", []));
  const span = BigInt(range);
  const fromB = "0x" + (latest > span ? latest - span : 0n).toString(16);
  const toB = "0x" + latest.toString(16);
  const padded = padAddress(addr);
  const [outLogs, inLogs] = await Promise.all([
    erpcRpc(chainId, "eth_getLogs", [{ fromBlock: fromB, toBlock: toB, address: cfg.address, topics: [TRANSFER_TOPIC, padded] }]),
    erpcRpc(chainId, "eth_getLogs", [{ fromBlock: fromB, toBlock: toB, address: cfg.address, topics: [TRANSFER_TOPIC, null, padded] }]),
  ]);
  const seen = new Set();
  const transfers = [];
  for (const l of [...(outLogs ?? []), ...(inLogs ?? [])]) {
    const key = `${l.transactionHash}:${l.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = decodeTransferLog(l, cfg.decimals);
    t.direction = t.to.toLowerCase() === addr.toLowerCase() ? "in" : "out";
    transfers.push(t);
  }
  return {
    chain: chainId,
    token: cfg.name,
    scannedFromBlock: Number(BigInt(fromB)),
    scannedToBlock: Number(BigInt(toB)),
    matched: transfers.length,
    transfers,
  };
}

async function backendHealth(target, path) {
  try {
    const r = await forward(target, path, "GET", {}, null);
    return { target, ok: r.status >= 200 && r.status < 300, status: r.status };
  } catch (e) {
    return { target, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // Root: list routes.
    if (req.method === "GET" && path === "/") {
      sendJson(res, 200, {
        service: "unified-gateway",
        routes: {
          "POST /evm/<chainId>": "-> eRPC (EVM: 1=ETH, 56=BSC)",
          "POST /solana": "-> Solana JSON-RPC with failover",
          "GET /solana/health": "-> Solana provider list",
          "GET /solana/stats": "-> Solana per-provider counters",
          "GET /solana/block/<slot>": "-> USDC transfers (from->to) in a block",
          "GET /solana/address/<addr>": "-> USDC transfers for a wallet",
          "GET /health": "-> status of both backends",
        },
      });
      return;
    }

    // Aggregate health of both backends.
    if (req.method === "GET" && path === "/health") {
      const [erpc, solana] = await Promise.all([
        backendHealth(ERPC_TARGET, "/main/evm/1"),
        backendHealth(SOLANA_TARGET, "/health"),
      ]);
      sendJson(res, 200, { status: "ok", erpc, solana });
      return;
    }

    const body = await readBody(req);

    // /evm/<chain>/usdc/block/<n>          USDC transfers (from->to) in an EVM block
    // /evm/<chain>/usdc/address/<addr>     USDC transfers touching an address
    //   (?range=N = how many recent blocks to scan, default 500)
    {
      const m = path.match(/^\/evm\/(\d+)\/usdc\/(block|address)\/(.+)$/);
      if (m) {
        const [, chainId, kind, value] = m;
        try {
          if (kind === "block") {
            if (!/^\d+$/.test(value)) { sendJson(res, 400, { error: "block must be a number" }); return; }
            const out = await evmBlockUsdcTransfers(chainId, value);
            sendJson(res, 200, { ...out, block: Number(value), totalTransfers: out.transfers.length }, { "x-routed-to": "erpc+decode" });
          } else {
            const range = Number(url.searchParams.get("range") ?? 500);
            const out = await evmAddressUsdcTransfers(chainId, value, range);
            sendJson(res, 200, { address: value, ...out }, { "x-routed-to": "erpc+decode" });
          }
        } catch (err) {
          sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
    }

    // /evm/<chainId>[/...]  -> eRPC /main/evm/<chainId>[/...]
    if (path === "/evm" || path.startsWith("/evm/")) {
      const rest = path.slice("/evm".length); // "" or "/1" etc.
      const target = `/main/evm${rest}${url.search}`;
      const r = await forward(ERPC_TARGET, target, req.method ?? "POST", { "content-type": req.headers["content-type"] ?? "application/json" }, body);
      res.writeHead(r.status, { "content-type": r.headers["content-type"] ?? "application/json", "x-routed-to": "erpc" });
      res.end(r.body);
      return;
    }

    // /solana[/...] -> Solana gateway /[...]
    if (path === "/solana" || path.startsWith("/solana/")) {
      const rest = path.slice("/solana".length) || "/"; // "/" or "/health" etc.
      const target = `${rest}${url.search}`;
      const r = await forward(SOLANA_TARGET, target, req.method ?? "GET", { "content-type": req.headers["content-type"] ?? "application/json" }, body);
      const passHeaders = { "content-type": r.headers["content-type"] ?? "application/json", "x-routed-to": "solana" };
      if (r.headers["x-rpc-provider"]) passHeaders["x-rpc-provider"] = r.headers["x-rpc-provider"];
      res.writeHead(r.status, passHeaders);
      res.end(r.body);
      return;
    }

    sendJson(res, 404, { error: `Unknown route ${path}. See GET / for available routes.` });
  } catch (err) {
    sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, () => {
  console.error(`Unified gateway listening on http://localhost:${PORT}`);
  console.error(`  eRPC target:   ${ERPC_TARGET}`);
  console.error(`  Solana target: ${SOLANA_TARGET}`);
  console.error(`  POST /evm/<chainId>          -> eRPC (ETH/BSC)`);
  console.error(`  POST /solana                 -> Solana JSON-RPC (failover)`);
  console.error(`  GET  /solana/block/<slot>    -> Solana USDC transfers in a block`);
  console.error(`  GET  /solana/address/<addr>  -> Solana USDC transfers for a wallet`);
  console.error(`  GET  /evm/<chain>/usdc/block/<n>     -> ETH/BSC USDC transfers in a block`);
  console.error(`  GET  /evm/<chain>/usdc/address/<addr> -> ETH/BSC USDC transfers for an address`);
  console.error(`  GET  /health                 -> both backends`);
});
