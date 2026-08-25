import type { PriceMark } from "../domain/types.js";

type Source = { name: string; fetch: () => Promise<number> };

export interface PriceOracle {
  getMark(nowMs?: number): Promise<PriceMark>;
}

export class MedianSolPriceOracle implements PriceOracle {
  private cached: PriceMark | null = null;
  private inFlight: Promise<PriceMark> | null = null;

  constructor(
    private readonly cacheMs = 1_000,
    private readonly timeoutMs = 1_500,
    private readonly sources: Source[] = defaultSources(),
  ) {}

  async getMark(nowMs = Date.now()): Promise<PriceMark> {
    if (this.cached && nowMs - this.cached.observedAtMs <= this.cacheMs)
      return this.cached;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.refresh(nowMs).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async refresh(nowMs: number): Promise<PriceMark> {
    const settled = await Promise.allSettled(
      this.sources.map(async (source) => ({
        name: source.name,
        priceUsd: await withTimeout(source.fetch(), this.timeoutMs),
      })),
    );
    const healthy = settled
      .filter(
        (
          result,
        ): result is PromiseFulfilledResult<{
          name: string;
          priceUsd: number;
        }> => result.status === "fulfilled",
      )
      .map((result) => result.value)
      .filter(
        (source) => Number.isFinite(source.priceUsd) && source.priceUsd > 0,
      )
      .sort((a, b) => a.priceUsd - b.priceUsd);
    if (healthy.length === 0) throw new Error("all SOL/USD sources failed");
    const midpoint = Math.floor(healthy.length / 2);
    const median =
      healthy.length % 2 === 0
        ? (healthy[midpoint - 1]!.priceUsd + healthy[midpoint]!.priceUsd) / 2
        : healthy[midpoint]!.priceUsd;
    const spreadPct =
      healthy.length > 1
        ? ((healthy.at(-1)!.priceUsd - healthy[0]!.priceUsd) / median) * 100
        : 0;
    this.cached = {
      observedAtMs: nowMs,
      priceUsd: median,
      sources: healthy,
      spreadPct,
    };
    return this.cached;
  }
}

export class StaticPriceOracle implements PriceOracle {
  constructor(
    private readonly mark: Omit<PriceMark, "observedAtMs"> & {
      observedAtMs?: number;
    },
  ) {}

  async getMark(nowMs = Date.now()): Promise<PriceMark> {
    return { ...this.mark, observedAtMs: this.mark.observedAtMs ?? nowMs };
  }
}

function defaultSources(): Source[] {
  return [
    {
      name: "coinbase",
      fetch: async () => {
        const response = await fetch(
          "https://api.coinbase.com/v2/prices/SOL-USD/spot",
        );
        if (!response.ok) throw new Error(`coinbase ${response.status}`);
        const body = (await response.json()) as { data?: { amount?: string } };
        return Number(body.data?.amount);
      },
    },
    {
      name: "kraken",
      fetch: async () => {
        const response = await fetch(
          "https://api.kraken.com/0/public/Ticker?pair=SOLUSD",
        );
        if (!response.ok) throw new Error(`kraken ${response.status}`);
        const body = (await response.json()) as {
          result?: Record<string, { c?: string[] }>;
        };
        const ticker = body.result ? Object.values(body.result)[0] : undefined;
        return Number(ticker?.c?.[0]);
      },
    },
    {
      name: "binance-us",
      fetch: async () => {
        const response = await fetch(
          "https://api.binance.us/api/v3/ticker/price?symbol=SOLUSD",
        );
        if (!response.ok) throw new Error(`binance-us ${response.status}`);
        const body = (await response.json()) as { price?: string };
        return Number(body.price);
      },
    },
  ];
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error("timeout")),
          { once: true },
        ),
      ),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
