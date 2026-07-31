/**
 * Rate-limit + failover test.
 *
 *   npm run test:ratelimit
 *   npm run test:ratelimit -- --victim solana-public --burst 60 --rounds 4
 *
 * Two phases:
 *   Phase A - Hammer ONE provider directly (no failover) with concurrent
 *             getHealth/getSlot calls to surface its real rate limit. Counts
 *             HTTP 429 / throttling errors so you can see the actual ceiling.
 *   Phase B - Send the same aggressive load through the FailoverRpcClient and
 *             show that requests keep succeeding because traffic fails over to
 *             backup providers when the primary is throttled.
 *
 * The "victim" defaults to the official public endpoint (solana-public), which
 * rate-limits aggressively and needs no API key - ideal for demonstrating the
 * mechanism without burning a paid quota.
 */
import { loadProviders, type ProviderConfig } from "./config.js";
import { FailoverRpcClient, type FailoverEvent } from "./failover-client.js";

interface Args {
  victim: string;
  burst: number;
  rounds: number;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  let victim = "solana-public";
  let burst = 50;
  let rounds = 3;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--victim") victim = a[++i]!;
    else if (a[i] === "--burst") burst = Number(a[++i]);
    else if (a[i] === "--rounds") rounds = Number(a[++i]);
  }
  return { victim, burst, rounds };
}

const RATE_LIMIT_CODES = new Set([429, -32005, -32029]);

/** One raw JSON-RPC POST. Returns 'ok' | 'rate_limited' | 'error'. */
async function rawCall(url: string, method: string): Promise<"ok" | "rate_limited" | "error"> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
    });
    if (res.status === 429) return "rate_limited";
    if (!res.ok) return "error";
    const json = (await res.json()) as { error?: { code?: number } };
    if (json.error) {
      return json.error.code !== undefined && RATE_LIMIT_CODES.has(json.error.code)
        ? "rate_limited"
        : "error";
    }
    return "ok";
  } catch {
    return "error";
  }
}

async function phaseA(victim: ProviderConfig, burst: number, rounds: number): Promise<void> {
  console.log(`\n================ PHASE A: hammer "${victim.name}" directly ================`);
  console.log(`Sending ${burst} concurrent requests x ${rounds} round(s), no failover.\n`);

  let ok = 0;
  let rl = 0;
  let err = 0;
  for (let r = 1; r <= rounds; r++) {
    const results = await Promise.all(
      Array.from({ length: burst }, () => rawCall(victim.url, "getHealth")),
    );
    const rOk = results.filter((x) => x === "ok").length;
    const rRl = results.filter((x) => x === "rate_limited").length;
    const rErr = results.filter((x) => x === "error").length;
    ok += rOk;
    rl += rRl;
    err += rErr;
    console.log(`  round ${r}: ok=${rOk} rate_limited=${rRl} error=${rErr}`);
  }
  const total = ok + rl + err;
  console.log(`\n  TOTAL: ok=${ok} rate_limited=${rl} error=${err} (of ${total})`);
  if (rl > 0) {
    console.log(`  => "${victim.name}" enforced a rate limit: ${((rl / total) * 100).toFixed(1)}% of requests were throttled.`);
  } else {
    console.log(`  => No 429s observed. Try a higher --burst, or this provider's limit is above the test load.`);
  }
}

async function phaseB(providers: ProviderConfig[], victim: ProviderConfig, burst: number, rounds: number): Promise<void> {
  console.log(`\n================ PHASE B: same load through failover client ================`);
  // Put the victim FIRST (priority 0) so the client hits it first, then fails
  // over to the others when it gets throttled.
  const reordered: ProviderConfig[] = [
    { ...victim, priority: 0 },
    ...providers.filter((p) => p.name !== victim.name),
  ];
  console.log(`Provider order: ${reordered.map((p) => p.name).join(" -> ")}`);
  console.log(`Sending ${burst} concurrent requests x ${rounds} round(s), WITH failover.\n`);

  const events: FailoverEvent[] = [];
  const client = new FailoverRpcClient(reordered, {
    cooldownMs: 5_000,
    baseBackoffMs: 100,
    onEvent: (e) => events.push(e),
  });

  let logicalOk = 0;
  let logicalFail = 0;
  for (let r = 1; r <= rounds; r++) {
    const results = await Promise.allSettled(
      Array.from({ length: burst }, () => client.call<string>("getHealth")),
    );
    const rOk = results.filter((x) => x.status === "fulfilled").length;
    const rFail = results.length - rOk;
    logicalOk += rOk;
    logicalFail += rFail;
    console.log(`  round ${r}: succeeded=${rOk} failed=${rFail}`);
  }

  const failovers = events.filter((e) => e.type === "failover").length;
  const rateLimited = events.filter((e) => e.type === "rate_limited").length;

  console.log(`\n  Logical calls: succeeded=${logicalOk} failed=${logicalFail}`);
  console.log(`  Failover events: ${failovers} | rate-limit events: ${rateLimited}`);
  console.log(`\n  Per-provider stats:`);
  for (const s of client.getStats()) {
    console.log(
      `    ${s.name.padEnd(14)} req=${String(s.requests).padStart(4)} ok=${String(s.successes).padStart(4)} 429=${String(s.rateLimited).padStart(3)} err=${String(s.otherErrors).padStart(3)}`,
    );
  }

  console.log(`\n  Verdict:`);
  const successRate = (logicalOk / (logicalOk + logicalFail)) * 100;
  console.log(`    - End-to-end success rate WITH failover: ${successRate.toFixed(1)}%`);
  if (failovers > 0 || rateLimited > 0) {
    console.log(`    - Failover engaged: traffic was routed away from throttled provider(s) to backups.`);
  } else {
    console.log(`    - No throttling triggered at this load; raise --burst to force it.`);
  }
  if (successRate > 90 && (failovers > 0 || rateLimited > 0)) {
    console.log(`    - PASS: the fallback mechanism absorbed rate limiting and kept requests succeeding.`);
  }
}

async function main(): Promise<void> {
  const { victim: victimName, burst, rounds } = parseArgs();
  const providers = loadProviders();

  if (providers.length < 2) {
    console.error(
      `Failover needs >=2 providers, but only ${providers.length} configured. Add more *_RPC_URL in .env.`,
    );
    process.exit(1);
  }

  const victim = providers.find((p) => p.name === victimName) ?? providers[providers.length - 1]!;
  console.log(`Configured providers: ${providers.map((p) => p.name).join(", ")}`);
  console.log(`Victim provider (target of the load): ${victim.name} (${victim.url})`);

  await phaseA(victim, burst, rounds);
  await phaseB(providers, victim, burst, rounds);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
