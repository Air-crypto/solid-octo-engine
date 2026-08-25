import { describe, expect, it } from "vitest";
import { classifyHoldRisk } from "../src/core/hold-risk.js";
import type { RiskReport } from "../src/domain/types.js";

function report(name: string, status: "pass" | "fail" | "unknown"): RiskReport {
  return {
    checkedAtMs: 1,
    checks: [{ detail: "fixture", name, status }],
    evidence: { onChain: {}, rugcheck: {} },
    mint: "mint",
    passed: status === "pass",
    rawHash: "hash",
    sourceLatencyMs: {},
    tokenProgram: "token",
  };
}

describe("hold risk classification", () => {
  it("liquidates immediately only for confirmed token danger", () => {
    expect(classifyHoldRisk(report("insiders_zero", "fail")).kind).toBe(
      "hard_fail",
    );
    expect(
      classifyHoldRisk(report("official_bonding_curve", "fail")).kind,
    ).toBe("hard_fail");
  });

  it("treats provider and unknown failures as infrastructure uncertainty", () => {
    expect(classifyHoldRisk(report("rugcheck_available", "unknown")).kind).toBe(
      "uncertain",
    );
    expect(
      classifyHoldRisk(report("future_unclassified_check", "fail")).kind,
    ).toBe("uncertain");
  });
});
