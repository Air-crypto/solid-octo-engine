import type { MintState, PolicyConfig, RiskReport } from "../domain/types.js";

export interface RiskProvider {
  assess(
    state: MintState,
    policy: PolicyConfig,
    nowMs?: number,
  ): Promise<RiskReport>;
}
