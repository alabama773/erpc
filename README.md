# Solana Gateway + USDC Indexer

A fault-tolerant Solana RPC gateway with live USDC transfer indexing. It fronts
five Solana RPC providers behind one address, automatically failing over on rate
limits or errors, and exposes ready-made endpoints that turn raw transactions
into clean USDC transfer records.

Every USDC transfer query returns **from, to, amount, unit, price (live USD),
value in USD, block, and signature**.

---

## Why a custom layer?

Standard EVM RPC proxies do not understand Solana — it is a completely different
architecture with different JSON-RPC semantics. So this project implements a
purpose-built Solana failover layer: multiple providers tried in priority order,
per-provider cooldown on failure, and a USDC indexer built on pre/post
token-balance diffing.

```
                         ┌──────────────────────────────┐
  Client ──▶ :4100 ──────┤  Solana gateway              │
  (one address)          │  3-provider failover         │
                         │  + USDC indexer              │
                         └───────────────┬──────────────┘
                                         │
                    helius ▶ publicnode ▶ solana-public
```

| Service | Port | Role |
|---|---|---|
| Solana gateway | 4100 | Solana JSON-RPC with multi-provider failover + USDC indexer |

---

## Prerequisites

- Docker + Docker Compose
- A Helius API key (for the Solana primary provider) — free public providers are
  used as fallbacks, so it also runs with no key at all

---

## Setup

### 1. Configure the providers

```bash
cd solana
cp .env.example .env
```

Edit `.env` and set your Helius URL (leave it empty to run only on free public
providers):

```
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
PUBLICNODE_RPC_URL=https://solana-rpc.publicnode.com
SOLANA_PUBLIC_RPC_URL=https://api.mainnet-beta.solana.com
```

> drpc and ankr free public endpoints stopped working (HTTP 400 / 403) as of
> 2026-08, so they are commented out in `.env`. Add them back with a working
> URL (and API key if required) to include them in the failover chain.

`.env` is git-ignored and never leaves your machine.

### 2. Start the service

```bash
cd solana && docker compose up -d   # Solana gateway :4100
```

Verify:

```bash
curl http://localhost:4100/health
# {"status":"ok","providers":["helius","publicnode","solana-public"]}
```

---

## Usage

### Any Solana JSON-RPC (with failover)

```bash
curl -X POST http://localhost:4100/ \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[]}'
```

Every response carries an `X-RPC-Provider` header showing which provider served
it.

### USDC transfers (from → to)

```bash
# USDC transfers touching a wallet (limit = signatures scanned, default 25, max 200)
curl "http://localhost:4100/address/G9L3ac8qYKNy1gTxdmhxTbDVyGHf5NAaSDYzvkgitVLJ?limit=30"

# All USDC transfers in a block (slot)
curl "http://localhost:4100/block/435464598"

# Only transfers touching one address in a block
curl "http://localhost:4100/block/435464598?address=6LY1JzAFVZsP2a2xKrtU6znQMQ5h4i7tocWdgrkZzkzF"
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

`direction` (in/out) is only present on `/address` lookups.

---

## Endpoints reference

### Solana gateway `:4100`

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness + provider list |
| GET | `/stats` | Per-provider counters (API keys redacted) |
| POST | `/` | Solana JSON-RPC with failover |
| GET | `/block/<slot>` | USDC transfers in a block |
| GET | `/block/<slot>?address=<addr>` | USDC transfers in a block touching one address |
| GET | `/address/<addr>?limit=N` | USDC transfers for a wallet |

---

## Failover

Providers are tried in priority order (helius → publicnode → solana-public; drpc
and ankr can be re-enabled in `.env`). On HTTP 429 or error, the provider is put
on cooldown and traffic fails over to the next. Every response carries an
`X-RPC-Provider` header showing which one served it.

A data-availability error (a block/slot missing on one provider, e.g. `-32001`
block cleaned up) also fails over to a provider with longer retention, and is
only surfaced if every provider lacks that block. Deterministic client errors
(bad params `-32602`, unknown method `-32601`) are returned immediately without
failing over.

### Rate-limit test

```bash
cd solana
npm run test:ratelimit -- --victim solana-public --burst 60 --rounds 4
```

Phase A hammers one provider directly to surface its real rate limit; Phase B
sends the same load through the failover client and shows a 100% success rate
because traffic moves to backups.

---

## CLI tools

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
- **Solana USDC has 6 decimals.** Handled automatically.
- **USDC price** is fetched live from CoinGecko (cached 60s) and falls back to
  $1.00 if the request fails, so a price lookup never breaks the gateway.
- **`/stats` redacts API keys** — only provider hosts are shown.
- Do not expose this gateway to the public internet without authentication.

---

## Project layout

```
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
postman/            Solana-Gateway Postman collection
```

USDC mint (Solana): `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (6 decimals)
