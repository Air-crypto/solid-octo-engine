import { describe, expect, it } from "vitest";
import {
  dailySpendCapUsdCents,
  evaluateEntryPolicy,
} from "../src/core/policy.js";
import { evaluateExit } from "../src/core/exit-policy.js";
import { loadConfig } from "../src/config.js";
import type { MintState, Position, PriceMark } from "../src/domain/types.js";
import { policy } from "./helpers.js";

const now = 1_000_000;
const mark: PriceMark = {
  observedAtMs: now,
  priceUsd: 150,
  sources: [
    { name: "a", priceUsd: 150 },
    { name: "b", priceUsd: 150.1 },
  ],
  spreadPct: 0.07,
};
const state: MintState = {
  bondingCurve: "curve",
  createdAtMs: now - 13_000,
  creationSignature: "sig",
  creationSlot: 1,
  creator: "creator",
  currentMarketCapUsd: 3_240,
  highWaterMarketCapUsd: 3_240,
  lastEventSignature: "trade",
  lastObservedAtMs: now,
  lastSlot: 2,
  mint: "mint",
  name: "VSEXY",
  phase: "seen",
  previousMarketCapUsd: 3_100,
  quoteMint: "sol",
  symbol: "VSEXY",
  tokenProgram: "token",
  tokenTotalSupplyBaseUnits: "1000000000000000",
  virtualSolReservesLamports: "23177200000",
  virtualTokenReservesBaseUnits: "1073000000000000",
};

describe("entry policy", () => {
  it("accepts a fresh real crossing", () => {
    expect(evaluateEntryPolicy(state, mark, policy, now).eligible).toBe(true);
  });

  it("rejects a prior spike even after a pullback", () => {
    expect(
      evaluateEntryPolicy(
        { ...state, highWaterMarketCapUsd: 5_000 },
        mark,
        policy,
        now,
      ).reasons,
    ).toContain("market cap touched the spike ceiling");
  });

  it("rejects stale oracle data", () => {
    expect(
      evaluateEntryPolicy(
        state,
        { ...mark, observedAtMs: now - 5_001 },
        policy,
        now,
      ).eligible,
    ).toBe(false);
  });
});

describe("exit policy", () => {
  const position: Position = {
    entryMarketCapUsd: 3_200,
    entrySolLamports: "100",
    entryTimeMs: now,
    highWaterMarketCapUsd: 4_500,
    id: "p",
    mint: "m",
    mode: "shadow",
    remainingTokenBaseUnits: "1000",
    status: "open",
    tokenAmountBaseUnits: "1000",
    wallet: "w",
  };

  it("exits the full position at twenty percent", () => {
    expect(evaluateExit(position, 3_840, policy, now + 10_000)).toMatchObject({
      fraction: 1,
      reason: "take_profit",
      triggered: true,
    });
  });

  it("cuts a position before take-profit when the initial loss limit is hit", () => {
    expect(
      evaluateExit(
        position,
        position.entryMarketCapUsd * (1 - policy.stopLossPct / 100),
        policy,
        now + 5_000,
      ),
    ).toMatchObject({
      fraction: 1,
      reason: "stop_loss",
      triggered: true,
    });
  });

  it("trails only after scaling", () => {
    const scaled = {
      ...position,
      remainingTokenBaseUnits: "500",
      highWaterMarketCapUsd: 5_000,
    };
    expect(evaluateExit(scaled, 3_900, policy, now + 20_000)).toMatchObject({
      fraction: 1,
      reason: "trailing_stop",
      triggered: true,
    });
  });

  it("enforces the time stop", () => {
    expect(
      evaluateExit(position, 3_000, policy, now + policy.timeStopMs),
    ).toMatchObject({ fraction: 1, reason: "time_stop", triggered: true });
  });
});

describe("configuration", () => {
  it("keeps the large paper budget separate from the live budget", () => {
    expect(dailySpendCapUsdCents("shadow", policy)).toBe(100_000_000);
    expect(dailySpendCapUsdCents("manual", policy)).toBe(5_000);
    expect(dailySpendCapUsdCents("live", policy)).toBe(5_000);
  });

  it("treats blank optional signer fields as unset and keeps live fail-closed", () => {
    const env = {
      DESK_ARM_TOKEN: "",
      DESK_MODE: "shadow",
      DESK_POLICY_PATH: "./config/policy.json",
      EXPECTED_SIGNER_PUBLIC_KEY: "",
      SOLANA_EXECUTION_KEYPAIR_PATH: "",
    };
    expect(loadConfig(env).armToken).toBeUndefined();
    expect(() => loadConfig({ ...env, DESK_MODE: "live" })).toThrow(
      "live mode requires",
    );
  });
});
