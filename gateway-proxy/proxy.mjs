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
  console.error(`  GET  /solana/block/<slot>    -> USDC transfers in a block`);
  console.error(`  GET  /solana/address/<addr>  -> USDC transfers for a wallet`);
  console.error(`  GET  /health                 -> both backends`);
});
