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

function envUrl(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * Build the ordered provider list from env. Primary first (Helius if present),
 * then free public fallbacks. Only providers with a configured URL are included.
 */
export function loadProviders(): ProviderConfig[] {
  const candidates: Array<{ key: string; name: string; priority: number }> = [
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

  if (providers.length === 0) {
    throw new Error(
      "No Solana RPC providers configured. Copy .env.example to .env and set at least one *_RPC_URL.",
    );
  }
  providers.sort((a, b) => a.priority - b.priority);
  return providers;
}

export const USDC_MINT =
  envUrl("USDC_MINT") ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export function loadWalletAddresses(): string[] {
  const raw = process.env.WALLET_ADDRESSES ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
