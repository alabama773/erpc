import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(__dirname, "..");

export interface ProviderConfig {
  name: string;
  url: string;
  /** Lower weight = higher priority. Providers are tried in ascending priority. */
  priority: number;
}

/** Which Solana cluster this instance talks to. */
export type Cluster = "mainnet" | "devnet";

/**
 * Selected cluster. Defaults to mainnet. Set SOLANA_CLUSTER=devnet to run the
 * same gateway/indexer against devnet (e.g. to inspect a Phantom devnet tx).
 * Anything other than "devnet" (case-insensitive) means mainnet.
 */
export const CLUSTER: Cluster =
  (process.env.SOLANA_CLUSTER ?? "mainnet").trim().toLowerCase() === "devnet"
    ? "devnet"
    : "mainnet";

function envUrl(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * Build the ordered provider list for the selected cluster from env. Primary
 * first (Helius if present), then free public fallbacks. Only providers with a
 * configured URL are included.
 *
 * mainnet env keys: HELIUS_RPC_URL, PUBLICNODE_RPC_URL, SOLANA_PUBLIC_RPC_URL,
 *                   DRPC_RPC_URL, ANKR_RPC_URL
 * devnet  env keys: HELIUS_DEVNET_RPC_URL, SOLANA_DEVNET_RPC_URL
 *                   (devnet always falls back to the official public devnet
 *                    endpoint so it works with zero config).
 */
export function loadProviders(): ProviderConfig[] {
  const candidates: Array<{ key: string; name: string; priority: number }> =
    CLUSTER === "devnet"
      ? [
          { key: "HELIUS_DEVNET_RPC_URL", name: "helius-devnet", priority: 1 },
          { key: "SOLANA_DEVNET_RPC_URL", name: "solana-devnet", priority: 2 },
        ]
      : [
          { key: "HELIUS_RPC_URL", name: "helius", priority: 1 },
          { key: "PUBLICNODE_RPC_URL", name: "publicnode", priority: 2 },
          { key: "DRPC_RPC_URL", name: "drpc", priority: 3 },
          { key: "ANKR_RPC_URL", name: "ankr", priority: 4 },
          { key: "SOLANA_PUBLIC_RPC_URL", name: "solana-public", priority: 5 },
        ];

  const providers: ProviderConfig[] = [];
  for (const c of candidates) {
    const url = envUrl(c.key);
    if (url) providers.push({ name: c.name, url, priority: c.priority });
  }

  // Devnet always has a zero-config public fallback so it just works.
  if (CLUSTER === "devnet" && !providers.some((p) => p.name === "solana-devnet")) {
    providers.push({
      name: "solana-devnet",
      url: "https://api.devnet.solana.com",
      priority: 99,
    });
  }

  if (providers.length === 0) {
    throw new Error(
      CLUSTER === "devnet"
        ? "No Solana devnet providers configured. Set HELIUS_DEVNET_RPC_URL or SOLANA_DEVNET_RPC_URL in .env (or rely on the public devnet fallback)."
        : "No Solana RPC providers configured. Copy .env.example to .env and set at least one *_RPC_URL.",
    );
  }
  providers.sort((a, b) => a.priority - b.priority);
  return providers;
}

// Native Circle USDC mint per cluster (6 decimals on both).
//   mainnet: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
//   devnet:  4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
const DEFAULT_USDC_MINT: Record<Cluster, string> = {
  mainnet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};

/**
 * SPL mint the indexer tracks. Defaults to the cluster's native USDC mint, but
 * can be overridden with USDC_MINT to index a different token (useful when a
 * devnet tx moved some other test token instead of the canonical devnet USDC).
 */
export const USDC_MINT = envUrl("USDC_MINT") ?? DEFAULT_USDC_MINT[CLUSTER];

export function loadWalletAddresses(): string[] {
  const raw = process.env.WALLET_ADDRESSES ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
