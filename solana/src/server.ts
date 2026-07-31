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
import { loadProviders } from "./config.js";
import { FailoverRpcClient } from "./failover-client.js";

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

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { status: "ok", providers: providers.map((p) => p.name) });
      return;
    }
    if (req.method === "GET" && req.url === "/stats") {
      sendJson(res, 200, { providers: client.getStats() });
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
  console.error(`  POST /         -> Solana JSON-RPC with failover (see X-RPC-Provider header)`);
  console.error(`  GET  /health   -> liveness + provider list`);
  console.error(`  GET  /stats    -> per-provider counters`);
});
