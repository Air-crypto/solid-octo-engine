import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PolicyConfig } from "../src/domain/types.js";
import { Ledger } from "../src/storage/ledger.js";

export const policy: PolicyConfig = {
  armLeaseMaxMs: 900_000,
  defaultSpendUsdCents: 1_000,
  entryMarketCapUsd: 3_200,
  exitIntentTtlMs: 10_000,
  exitMaxAttempts: 3,
  exitRetryCooldownMs: 2_000,
  exitRetryDelayMs: 1,
  holdRiskFailureKillThreshold: 2,
  holdRiskRetryDelayMs: 2_000,
  holdRiskTimeoutMs: 1_500,
  intentTtlMs: 2_500,
  maxAgeMs: 30_000,
  maxCreatorHolderPct: 5,
  maxDailySpendUsdCents: 5_000,
  maxOpenPositions: 1,
  maxOracleSpreadPct: 1,
  maxPriceAgeMs: 5_000,
  maxSlippageBps: 500,
  maxSpendUsdCents: 1_200,
  maxTopHolderPct: 20,
  minSpendUsdCents: 800,
  requireFreezeAuthorityRevoked: true,
  requireInsidersZero: true,
  requireMintAuthorityRevoked: true,
  requireOfficialBondingCurve: true,
  requireRugcheck: true,
  riskFailureKillThreshold: 3,
  riskReadinessRetries: 2,
  riskReadinessRetryDelayMs: 75,
  riskTimeoutMs: 900,
  spikeCeilingMarketCapUsd: 4_000,
  stopLossPct: 15,
  takeProfitPct: 40,
  takeProfitSellFraction: 0.5,
  timeStopMs: 720_000,
  trailingStopPct: 20,
  version: 2,
};

export function tempLedger(retentionMs?: number, maxEvents?: number): Ledger {
  return new Ledger(
    join(mkdtempSync(join(tmpdir(), "solid-octo-test-")), "test.db"),
    retentionMs,
    maxEvents,
  );
}
