import { describe, expect, it } from "vitest";
import { buildPortfolio } from "../src/core/portfolio.js";
import type { MintState, Position } from "../src/domain/types.js";

const state: MintState = {
  bondingCurve: "curve",
  createdAtMs: 1,
  creationSignature: "create",
  creationSlot: 1,
  creator: "creator",
  currentMarketCapUsd: 4_800,
  highWaterMarketCapUsd: 5_000,
  lastEventSignature: "trade",
  lastObservedAtMs: 3_000,
  lastSlot: 2,
  mint: "mint-open",
  name: "Open",
  phase: "confirmed",
  previousMarketCapUsd: 4_000,
  quoteMint: "quote",
  symbol: "OPEN",
  tokenProgram: "token",
  tokenTotalSupplyBaseUnits: "1000000",
  virtualSolReservesLamports: "100",
  virtualTokenReservesBaseUnits: "100",
};

describe("portfolio accounting", () => {
  it("separates realized and unrealized P&L and marks wallet net worth", () => {
    const positions: Position[] = [
      {
        entryMarketCapUsd: 3_200,
        entrySolLamports: "50000000",
        entryTimeMs: 2_000,
        entryValueUsd: 10,
        exitFills: [
          {
            atMs: 2_500,
            costBasisUsd: 5,
            feeUsd: 0.01,
            marketCapUsd: 4_480,
            proceedsUsd: 7,
            realizedPnlUsd: 2,
            reason: "take_profit",
            slippageBps: 20,
            tokenAmountBaseUnits: "500",
          },
        ],
        feesUsd: 0.02,
        highWaterMarketCapUsd: 5_000,
        id: "open",
        lastMarketCapUsd: 4_800,
        mint: state.mint,
        mode: "live",
        realizedPnlUsd: 2,
        realizedProceedsUsd: 7,
        remainingTokenBaseUnits: "500",
        status: "open",
        tokenAmountBaseUnits: "1000",
        wallet: "wallet",
      },
      {
        entryMarketCapUsd: 3_200,
        entrySolLamports: "1",
        entryTimeMs: 1_000,
        highWaterMarketCapUsd: 3_200,
        id: "legacy",
        mint: "legacy",
        mode: "live",
        remainingTokenBaseUnits: "0",
        status: "closed",
        tokenAmountBaseUnits: "10",
        wallet: "wallet",
      },
    ];
    const result = buildPortfolio({
      activeMode: "live",
      nowMs: 4_000,
      positions,
      sessionStartedAtMs: 0,
      solMark: {
        observedAtMs: 4_000,
        priceUsd: 200,
        sources: [],
        spreadPct: 0,
      },
      stateForMint: (mint) => (mint === state.mint ? state : undefined),
      wallet: "wallet",
      walletBalanceLamports: 100_000_000n,
    });

    const open = result.positions.find((position) => position.id === "open")!;
    expect(open.currentValueUsd).toBeCloseTo(7.5);
    expect(open.unrealizedPnlUsd).toBeCloseTo(2.5);
    expect(open.realizedPnlUsd).toBe(2);
    expect(result.summaries.live.totalPnlUsd).toBeCloseTo(4.5);
    expect(result.summaries.live.netWorthUsd).toBeCloseTo(27.5);
    expect(result.summaries.live.legacyPositions).toBe(1);
  });

  it("does not invent P&L or cost basis for legacy records", () => {
    const result = buildPortfolio({
      activeMode: "shadow",
      nowMs: 1,
      positions: [
        {
          entryMarketCapUsd: 3_200,
          entrySolLamports: "1",
          entryTimeMs: 1,
          highWaterMarketCapUsd: 3_200,
          id: "legacy",
          mint: "legacy",
          mode: "shadow",
          remainingTokenBaseUnits: "10",
          status: "open",
          tokenAmountBaseUnits: "10",
          wallet: "wallet",
        },
      ],
      sessionStartedAtMs: 0,
      solMark: null,
      stateForMint: () => undefined,
      wallet: "wallet",
      walletBalanceLamports: null,
    });
    expect(result.positions[0]).toMatchObject({
      currentValueUsd: null,
      entryValueUsd: null,
      legacy: true,
      realizedPnlUsd: null,
      unrealizedPnlUsd: null,
    });
    expect(result.summaries.shadow.netWorthUsd).toBeNull();
  });
});
