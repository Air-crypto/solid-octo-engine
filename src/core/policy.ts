import type {
  DeskMode,
  MintState,
  PolicyConfig,
  PolicyDecision,
  PriceMark,
} from "../domain/types.js";
import { stableHash } from "./hash.js";

export function dailySpendCapUsdCents(
  mode: DeskMode,
  policy: PolicyConfig,
): number {
  return mode === "shadow"
    ? policy.maxDailyShadowSpendUsdCents
    : policy.maxDailySpendUsdCents;
}

export function evaluateEntryPolicy(
  state: MintState,
  mark: PriceMark,
  policy: PolicyConfig,
  nowMs: number,
): PolicyDecision {
  const reasons: string[] = [];
  const ageMs = nowMs - state.createdAtMs;
  const priceAgeMs = nowMs - mark.observedAtMs;
  const crossedEntry =
    state.previousMarketCapUsd < policy.entryMarketCapUsd &&
    state.currentMarketCapUsd >= policy.entryMarketCapUsd;

  if (ageMs < 0 || ageMs > policy.maxAgeMs)
    reasons.push(`age ${ageMs}ms exceeds ${policy.maxAgeMs}ms`);
  if (!crossedEntry)
    reasons.push("market cap did not cross the entry threshold on this event");
  if (state.highWaterMarketCapUsd >= policy.spikeCeilingMarketCapUsd)
    reasons.push("market cap touched the spike ceiling");
  if (priceAgeMs < 0 || priceAgeMs > policy.maxPriceAgeMs)
    reasons.push("SOL/USD mark is stale");
  if (mark.sources.length < 2)
    reasons.push("fewer than two SOL/USD sources are healthy");
  if (mark.spreadPct > policy.maxOracleSpreadPct)
    reasons.push("SOL/USD source spread is too wide");

  const snapshot = {
    ageMs,
    mark,
    marketCap: {
      current: state.currentMarketCapUsd,
      highWater: state.highWaterMarketCapUsd,
      previous: state.previousMarketCapUsd,
    },
    mint: state.mint,
    policyVersion: policy.version,
    slot: state.lastSlot,
  };
  return {
    eligible: reasons.length === 0,
    reasons,
    snapshotHash: stableHash(snapshot),
  };
}
