import type { FetchFn } from "@solana/web3.js";

export interface RpcTelemetrySnapshot {
  byMethod: Record<string, number>;
  failed: number;
  last429AtMs: number | null;
  maxRequestsPerSecond: number;
  queueDepth: number;
  rateLimited: number;
  total: number;
}

interface PendingRequest {
  execute: () => Promise<Response>;
  method: string;
  priority: number;
  reject: (error: unknown) => void;
  resolve: (response: Response) => void;
}

/**
 * A process-wide rolling-window limiter for every HTTP JSON-RPC request made by
 * web3.js. Helius' free tier allows 10 RPS; the default engine configuration
 * uses 8 RPS so a reconnect or operator health probe does not create a burst.
 */
export class RpcRateController {
  private readonly byMethod = new Map<string, number>();
  private readonly queue: PendingRequest[] = [];
  private readonly requestTimes: number[] = [];
  private drainTimer: NodeJS.Timeout | null = null;
  private failed = 0;
  private last429AtMs: number | null = null;
  private rateLimited = 0;
  private total = 0;

  constructor(
    readonly maxRequestsPerSecond: number,
    private readonly underlyingFetch: FetchFn = globalThis.fetch,
  ) {
    if (!Number.isInteger(maxRequestsPerSecond) || maxRequestsPerSecond < 1)
      throw new Error("RPC max requests per second must be a positive integer");
  }

  readonly fetch: FetchFn = async (input, init) => {
    const { method, priority } = rpcMetadata(init?.body);
    return await new Promise<Response>((resolve, reject) => {
      if (this.queue.length >= this.maxRequestsPerSecond * 10) {
        this.failed += 1;
        reject(new Error("RPC request queue overflow"));
        return;
      }
      this.queue.push({
        execute: async () => await this.underlyingFetch(input, init),
        method,
        priority,
        reject,
        resolve,
      });
      this.queue.sort((left, right) => left.priority - right.priority);
      this.drain();
    });
  };

  snapshot(): RpcTelemetrySnapshot {
    return {
      byMethod: Object.fromEntries(this.byMethod),
      failed: this.failed,
      last429AtMs: this.last429AtMs,
      maxRequestsPerSecond: this.maxRequestsPerSecond,
      queueDepth: this.queue.length,
      rateLimited: this.rateLimited,
      total: this.total,
    };
  }

  private drain(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    const now = Date.now();
    while (this.requestTimes.length && now - this.requestTimes[0]! >= 1_000)
      this.requestTimes.shift();

    while (
      this.queue.length > 0 &&
      this.requestTimes.length < this.maxRequestsPerSecond
    ) {
      const pending = this.queue.shift()!;
      this.requestTimes.push(Date.now());
      this.total += 1;
      this.byMethod.set(
        pending.method,
        (this.byMethod.get(pending.method) ?? 0) + 1,
      );
      void pending
        .execute()
        .then((response) => {
          if (response.status === 429) {
            this.rateLimited += 1;
            this.last429AtMs = Date.now();
          }
          pending.resolve(response);
        })
        .catch((error) => {
          this.failed += 1;
          pending.reject(error);
        });
    }

    if (this.queue.length > 0) {
      const waitMs = Math.max(1, 1_000 - (Date.now() - this.requestTimes[0]!));
      this.drainTimer = setTimeout(() => this.drain(), waitMs);
    }
  }
}

function rpcMetadata(body: BodyInit | null | undefined): {
  method: string;
  priority: number;
} {
  if (typeof body !== "string") return { method: "unknown", priority: 2 };
  try {
    const parsed = JSON.parse(body) as
      { method?: unknown; params?: unknown[] } | Array<{ method?: unknown }>;
    if (Array.isArray(parsed)) return { method: "batch", priority: 1 };
    const method =
      typeof parsed.method === "string" ? parsed.method : "unknown";
    const config = parsed.params?.[1];
    const parsedTransaction =
      method === "getTransaction" &&
      typeof config === "object" &&
      config !== null &&
      "encoding" in config &&
      config.encoding === "jsonParsed";
    if (
      parsedTransaction ||
      [
        "sendTransaction",
        "simulateTransaction",
        "getSignatureStatuses",
      ].includes(method)
    )
      return { method, priority: 0 };
    if (
      [
        "getMultipleAccounts",
        "getTokenAccountsByOwner",
        "getTokenLargestAccounts",
      ].includes(method)
    )
      return { method, priority: 1 };
    if (
      method === "getSignaturesForAddress" ||
      (method === "getTransaction" && !parsedTransaction)
    )
      return { method, priority: 3 };
    return { method, priority: 2 };
  } catch {
    return { method: "unknown", priority: 2 };
  }
}
