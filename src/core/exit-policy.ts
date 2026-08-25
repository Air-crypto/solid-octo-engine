import type { ExitDecision, PolicyConfig, Position } from "../domain/types.js";

export function evaluateExit(
  position: Position,
  currentMarketCapUsd: number,
  policy: PolicyConfig,
  nowMs: number,
): ExitDecision {
  if (nowMs - position.entryTimeMs >= policy.timeStopMs) {
    return { fraction: 1, reason: "time_stop", triggered: true };
  }

  const returnPct =
    ((currentMarketCapUsd - position.entryMarketCapUsd) /
      position.entryMarketCapUsd) *
    100;
  if (returnPct <= -policy.stopLossPct) {
    return { fraction: 1, reason: "stop_loss", triggered: true };
  }
  const alreadyScaled =
    BigInt(position.remainingTokenBaseUnits) <
    BigInt(position.tokenAmountBaseUnits);
  if (!alreadyScaled && returnPct >= policy.takeProfitPct) {
    return {
      fraction: policy.takeProfitSellFraction,
      reason: "take_profit",
      triggered: true,
    };
  }

  if (alreadyScaled && position.highWaterMarketCapUsd > 0) {
    const drawdownPct =
      ((position.highWaterMarketCapUsd - currentMarketCapUsd) /
        position.highWaterMarketCapUsd) *
      100;
    if (drawdownPct >= policy.trailingStopPct) {
      return { fraction: 1, reason: "trailing_stop", triggered: true };
    }
  }

  return { fraction: 0, reason: "time_stop", triggered: false };
}
