import type { ProviderConfig } from "./config.js";

/** A single JSON-RPC call spec. */
export interface RpcCall {
  method: string;
  params?: unknown[];
}

export interface RpcResult<T> {
  result: T;
  /** Which provider ultimately served the response. */
  provider: string;
  /** How many providers were tried before this one succeeded (1 = first try). */
  attempts: number;
}

/** Per-provider runtime health/usage stats, for observability + the rate-limit test. */
export interface ProviderStats {
  name: string;
  url: string;
  requests: number; // total forward attempts sent to this provider
  successes: number;
  rateLimited: number; // count of 429 / rate-limit responses
  otherErrors: number;
  /** Epoch ms until which this provider is on cooldown (skipped). 0 = available. */
  cooldownUntil: number;
}

export interface FailoverOptions {
  /** Max total attempts across all providers for a single logical call. */
  maxAttemptsPerCall?: number;
  /** Base backoff in ms applied between retries (exponential). */
  baseBackoffMs?: number;
  /** How long to cooldown a provider after it rate-limits us, in ms. */
  cooldownMs?: number;
  /** How long to cooldown a provider after a non-rate-limit error (timeout, 4xx, 5xx). */
  errorCooldownMs?: number;
  /** Per-request HTTP timeout in ms. */
  requestTimeoutMs?: number;
  /** Optional logger; defaults to console.error for failover events. */
  onEvent?: (event: FailoverEvent) => void;
}

export type FailoverEvent =
  | { type: "rate_limited"; provider: string; method: string; cooldownMs: number }
  | { type: "error"; provider: string; method: string; message: string; status?: number }
  | { type: "failover"; from: string; to: string; method: string }
  | { type: "retry"; provider: string; method: string; delayMs: number; attempt: number }
  | { type: "success"; provider: string; method: string; attempts: number };

const HTTP_RATE_LIMIT = 429;
// JSON-RPC error codes some Solana providers use for throttling.
const RPC_RATE_LIMIT_CODES = new Set([429, -32005, -32029]);

class RpcHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly rateLimited: boolean,
  ) {
    super(message);
    this.name = "RpcHttpError";
  }
}

/**
 * Fault-tolerant Solana JSON-RPC client.
 *
 * Providers are tried in priority order. On a rate-limit (HTTP 429 or a
 * throttling JSON-RPC error) the provider is put on cooldown and the call
 * fails over to the next available provider. Transient errors are retried
 * with exponential backoff. All activity is recorded in per-provider stats
 * so the rate-limit test can prove failover actually happened.
 */
export class FailoverRpcClient {
  private readonly stats = new Map<string, ProviderStats>();
  private readonly opts: Required<Omit<FailoverOptions, "onEvent">> & Pick<FailoverOptions, "onEvent">;
  private idCounter = 0;

  constructor(
    private readonly providers: ProviderConfig[],
    options: FailoverOptions = {},
  ) {
    if (providers.length === 0) throw new Error("FailoverRpcClient needs at least one provider");
    this.opts = {
      maxAttemptsPerCall: options.maxAttemptsPerCall ?? Math.max(providers.length * 2, 4),
      baseBackoffMs: options.baseBackoffMs ?? 250,
      cooldownMs: options.cooldownMs ?? 15_000,
      errorCooldownMs: options.errorCooldownMs ?? 8_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 12_000,
      onEvent: options.onEvent,
    };
    for (const p of providers) {
      this.stats.set(p.name, {
        name: p.name,
        url: p.url,
        requests: 0,
        successes: 0,
        rateLimited: 0,
        otherErrors: 0,
        cooldownUntil: 0,
      });
    }
  }

  getStats(): ProviderStats[] {
    return [...this.stats.values()].map((s) => ({ ...s }));
  }

  resetStats(): void {
    for (const s of this.stats.values()) {
      s.requests = 0;
      s.successes = 0;
      s.rateLimited = 0;
      s.otherErrors = 0;
      s.cooldownUntil = 0;
    }
  }

  private emit(event: FailoverEvent): void {
    this.opts.onEvent?.(event);
  }

  /** Order providers: available (not on cooldown) first by priority, then cooling-down ones. */
  private orderedProviders(now: number): ProviderConfig[] {
    return [...this.providers].sort((a, b) => {
      const sa = this.stats.get(a.name)!;
      const sb = this.stats.get(b.name)!;
      const aCool = sa.cooldownUntil > now ? 1 : 0;
      const bCool = sb.cooldownUntil > now ? 1 : 0;
      if (aCool !== bCool) return aCool - bCool;
      return a.priority - b.priority;
    });
  }

  private async postOnce<T>(provider: ProviderConfig, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.requestTimeoutMs);
    try {
      const res = await fetch(provider.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (res.status === HTTP_RATE_LIMIT) {
        throw new RpcHttpError(`HTTP 429 from ${provider.name}`, res.status, true);
      }
      if (!res.ok) {
        throw new RpcHttpError(`HTTP ${res.status} from ${provider.name}`, res.status, false);
      }

      const json = (await res.json()) as {
        result?: T;
        error?: { code?: number; message?: string };
      };

      if (json.error) {
        const code = json.error.code;
        const rateLimited = code !== undefined && RPC_RATE_LIMIT_CODES.has(code);
        throw new RpcHttpError(
          `RPC error ${code ?? "?"}: ${json.error.message ?? "unknown"} from ${provider.name}`,
          undefined,
          rateLimited,
        );
      }
      return json.result as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Execute a single JSON-RPC call with failover across providers. */
  async call<T>(method: string, params: unknown[] = []): Promise<RpcResult<T>> {
    const id = ++this.idCounter;
    const body = { jsonrpc: "2.0", id, method, params };

    let attempts = 0;
    let lastProvider = "";
    let lastError: unknown;

    while (attempts < this.opts.maxAttemptsPerCall) {
      const now = Date.now();
      const ordered = this.orderedProviders(now);
      // Prefer a provider not on cooldown; if all are cooling down, use the soonest-free one.
      const provider =
        ordered.find((p) => this.stats.get(p.name)!.cooldownUntil <= now) ?? ordered[0];
      const stat = this.stats.get(provider.name)!;

      if (lastProvider && lastProvider !== provider.name) {
        this.emit({ type: "failover", from: lastProvider, to: provider.name, method });
      }

      attempts++;
      stat.requests++;
      try {
        const result = await this.postOnce<T>(provider, body);
        stat.successes++;
        this.emit({ type: "success", provider: provider.name, method, attempts });
        return { result, provider: provider.name, attempts };
      } catch (err) {
        lastError = err;
        lastProvider = provider.name;
        const isRpcErr = err instanceof RpcHttpError;
        const rateLimited = isRpcErr && err.rateLimited;
        const status = isRpcErr ? err.status : undefined;

        if (rateLimited) {
          stat.rateLimited++;
          stat.cooldownUntil = Date.now() + this.opts.cooldownMs;
          this.emit({
            type: "rate_limited",
            provider: provider.name,
            method,
            cooldownMs: this.opts.cooldownMs,
          });
        } else {
          stat.otherErrors++;
          // Non-rate-limit errors (timeout, 4xx, 5xx, method unsupported) also
          // cordon the provider briefly so traffic moves on to the next one
          // instead of repeatedly picking the same broken/slow endpoint.
          stat.cooldownUntil = Date.now() + this.opts.errorCooldownMs;
          this.emit({
            type: "error",
            provider: provider.name,
            method,
            message: err instanceof Error ? err.message : String(err),
            status,
          });
        }

        // Backoff before the next attempt (skip delay if other providers are free).
        const anyFree = this.orderedProviders(Date.now()).some(
          (p) => this.stats.get(p.name)!.cooldownUntil <= Date.now(),
        );
        if (!anyFree && attempts < this.opts.maxAttemptsPerCall) {
          const delay = this.opts.baseBackoffMs * 2 ** Math.min(attempts - 1, 5);
          this.emit({ type: "retry", provider: provider.name, method, delayMs: delay, attempt: attempts });
          await this.sleep(delay);
        }
      }
    }

    throw new Error(
      `All providers exhausted for ${method} after ${attempts} attempts. Last error: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }
}
