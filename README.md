# eRPC + Solana Multi-Chain Gateway

A fault-tolerant multi-chain RPC gateway with USDC transfer indexing across
**Ethereum, BSC, and Solana**. It combines eRPC (for EVM chains) with a custom
Solana failover layer, fronted by a single unified gateway.

Every USDC transfer query returns **from, to, amount, unit, price (live USD),
value in USD, block, and signature**.

---

## Why two engines?

eRPC is EVM-only at runtime — it does **not** support Solana (confirmed: the
config states `Only evm is supported at runtime`, and there is no `solana`
handler in the eRPC source). So the system uses two engines behind one address:

```
                         ┌────────────────────────────────┐
  Client ──▶ :8080 ──────┤  Unified Gateway (receptionist) │
  (one address)          │  routes by path                 │
                         └───────┬───────────────┬─────────┘
                                 │               │
                    /evm/<chain> │               │ /solana...
                                 ▼               ▼
                    ┌──────────────────┐  ┌──────────────────────┐
                    │ eRPC  :4000      │  │ Solana gateway :4100  │
                    │ ETH + BSC        │  │ 5-provider failover   │
                    │ built-in failover│  │ + USDC indexer        │
                    └──────────────────┘  └──────────────────────┘
```

| Service | Port | Role |
|---|---|---|
| Unified gateway | 8080 | One entry point; routes to eRPC or Solana (recommended) |
| eRPC | 4000 | EVM (Ethereum + BSC) fault-tolerant proxy |
| Solana gateway | 4100 | Solana JSON-RPC with 5-provider failover + USDC indexer |

---

## Prerequisites

- Docker + Docker Compose
- A Helius API key (for the Solana primary provider) — free public providers are
  used as fallbacks

---

## Setup

### 1. Configure the Solana providers

```bash
cd solana
cp .env.example .env
```

Edit `.env` and set your Helius URL (leave it empty to run only on free public
providers):

```
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
PUBLICNODE_RPC_URL=https://solana-rpc.publicnode.com
DRPC_RPC_URL=https://solana.drpc.org
ANKR_RPC_URL=https://rpc.ankr.com/solana
SOLANA_PUBLIC_RPC_URL=https://api.mainnet-beta.solana.com
```

`.env` is git-ignored and never leaves your machine.

### 2. Start all three services

```bash
cd gateway       && docker compose up -d   # eRPC (ETH/BSC) :4000
cd ../solana     && docker compose up -d   # Solana gateway :4100
cd ../gateway-proxy && docker compose up -d # Unified gateway :8080
```

Verify:

```bash
curl http://localhost:8080/health
# {"status":"ok","erpc":{...,"ok":true},"solana":{...,"ok":true}}
```

---

## Usage (via the unified gateway :8080)

### EVM (Ethereum / BSC)

```bash
# ETH latest block (1 = Ethereum, 56 = BSC)
curl -X POST http://localhost:8080/evm/1 \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

### ETH/BSC USDC transfers (from → to)

```bash
# All USDC transfers in a block
curl "http://localhost:8080/evm/1/usdc/block/25657589"

# USDC transfers touching an address (scan recent blocks; range default 500)
curl "http://localhost:8080/evm/1/usdc/address/0xADDRESS?range=300"
```

> EVM has no "all transactions for an address" call, so address lookups scan a
> block window via `eth_getLogs` (`range` = number of recent blocks).

### Solana

```bash
# Any Solana JSON-RPC with failover
curl -X POST http://localhost:8080/solana \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[]}'
```

### Solana USDC transfers (from → to)

```bash
# USDC transfers touching a wallet (limit = signatures scanned, default 25, max 200)
curl "http://localhost:8080/solana/address/G9L3ac8qYKNy1gTxdmhxTbDVyGHf5NAaSDYzvkgitVLJ?limit=30"

# All USDC transfers in a block (slot)
curl "http://localhost:8080/solana/block/435464598"
```

### USDC transfer response shape

```json
{
  "direction": "in",
  "from": "DPqsobys...",
  "to": "G9L3ac8q...",
  "amount": "20",
  "unit": "USDC",
  "price": 0.999622,
  "valueUsd": "19.99",
  "block": 436123377,
  "signature": "..."
}
```

---

## Endpoints reference

### Unified gateway `:8080`

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Status of both backends |
| GET | `/` | List all routes |
| POST | `/evm/<chainId>` | Forward any EVM JSON-RPC (1=ETH, 56=BSC) |
| GET | `/evm/<chainId>/usdc/block/<n>` | USDC transfers in an EVM block |
| GET | `/evm/<chainId>/usdc/address/<addr>?range=N` | USDC transfers for an EVM address |
| POST | `/solana` | Solana JSON-RPC with failover |
| GET | `/solana/block/<slot>` | USDC transfers in a Solana block |
| GET | `/solana/address/<addr>?limit=N` | USDC transfers for a Solana wallet |
| GET | `/solana/health` `/solana/stats` | Solana provider status/counters |

### Solana backend `:4100` (direct)

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness + provider list |
| GET | `/stats` | Per-provider counters (API keys redacted) |
| POST | `/` | Solana JSON-RPC with failover |
| GET | `/block/<slot>` | USDC transfers in a block |
| GET | `/address/<addr>?limit=N` | USDC transfers for a wallet |

### eRPC backend `:4000` (direct)

URL pattern: `POST /main/evm/<chainId>` — standard EVM JSON-RPC.

---

## Failover

Both engines automatically route around failed/rate-limited providers.

- **Solana**: 5 providers tried in priority order (helius → publicnode → drpc →
  ankr → solana-public). On HTTP 429 or error, the provider is put on cooldown
  and traffic fails over to the next. Every response carries an
  `X-RPC-Provider` header showing which one served it.
- **eRPC**: native retry, hedge, and circuit-breaker across EVM upstreams.

### Rate-limit test

```bash
cd solana
npm run test:ratelimit -- --victim solana-public --burst 60 --rounds 4
```

Phase A hammers one provider directly to surface its real rate limit; Phase B
sends the same load through the failover client and shows a 100% success rate
because traffic moves to backups.

---

## CLI tools (Solana)

```bash
cd solana
npm install

npm run index:addresses -- <wallet> --limit 200   # total USDC received by a wallet
npm run index:block -- 435464598                   # USDC deposits in a block
npm run block:transfers -- 435464598               # from/to transfers in a block
npm run test:ratelimit                             # rate-limit + failover test
npm run serve                                      # run the Solana gateway locally
```

---

## Notes

- **Solana `slot` is the block number.** `getBlock` takes a slot; explorer
  "Block N" numbers are usually slots. (Slot 435464598 maps to block height
  413523570.)
- **USDC decimals differ per chain**: Ethereum USDC = 6, BSC USDC = 18. Handled
  automatically.
- **USDC price** is fetched live from CoinGecko (cached 60s) and falls back to
  $1.00 if the request fails, so a price lookup never breaks the gateway.
- **`/stats` redacts API keys** — only provider hosts are shown.
- Do not expose these gateways to the public internet without authentication.

---

## Project layout

```
gateway/            eRPC config (erpc.yaml) + docker-compose  — ETH/BSC
gateway-proxy/      Unified gateway (proxy.mjs) + docker       — :8080
solana/
  src/
    server.ts           Solana HTTP gateway + USDC endpoints
    failover-client.ts  multi-provider failover client
    usdc-indexer.ts     pre/post token-balance diffing
    index-addresses.ts  CLI: USDC totals per wallet
    index-block.ts      CLI: USDC deposits per block
    block-transfers.ts  CLI: from/to transfers per block
    ratelimit-test.ts   CLI: rate-limit + failover proof
  .env.example
postman/            Complete-Gateway Postman collection
```

USDC mints/contracts:
- Solana: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (6 decimals)
- Ethereum: `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` (6 decimals)
- BSC: `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` (18 decimals)
