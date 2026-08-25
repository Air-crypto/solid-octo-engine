import type { RiskReport } from "../domain/types.js";

const HARD_FAILURE_CHECKS = new Set([
  "mint_account",
  "token_program",
  "event_token_program_matches",
  "mint_authority_revoked",
  "freeze_authority_revoked",
  "official_bonding_curve",
  "pregraduation_liquidity",
  "top_non_curve_holder_pct",
  "creator_holder_pct",
  "insiders_zero",
]);

export type HoldRiskClassification =
  | { kind: "pass"; reasons: string[] }
  | { kind: "hard_fail"; reasons: string[] }
  | { kind: "uncertain"; reasons: string[] };

export function classifyHoldRisk(report: RiskReport): HoldRiskClassification {
  if (report.passed) return { kind: "pass", reasons: [] };
  const nonPassing = report.checks.filter((check) => check.status !== "pass");
  const reasons = nonPassing.map(
    (check) => check.name + ": " + check.status + " (" + check.detail + ")",
  );
  if (
    nonPassing.some(
      (check) => check.status === "fail" && HARD_FAILURE_CHECKS.has(check.name),
    )
  )
    return { kind: "hard_fail", reasons };
  return {
    kind: "uncertain",
    reasons:
      reasons.length > 0
        ? reasons
        : ["risk report failed without a classified hard failure"],
  };
}
