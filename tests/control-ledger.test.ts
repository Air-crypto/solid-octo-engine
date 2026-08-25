import { describe, expect, it } from "vitest";
import { ControlPlane } from "../src/core/control.js";
import type { ExecutionResult, OrderIntent } from "../src/domain/types.js";
import { policy, tempLedger } from "./helpers.js";

describe("control plane", () => {
  it("requires the token, caps leases, and kill-switches fail closed", () => {
    const ledger = tempLedger();
    const control = new ControlPlane(
      ledger,
      policy,
      "a-very-long-arm-token-value",
    );
    expect(() => control.arm("wrong", 1000, 10)).toThrow("invalid arm token");
    expect(
      control.arm("a-very-long-arm-token-value", policy.armLeaseMaxMs * 2, 10),
    ).toBe(10 + policy.armLeaseMaxMs);
    expect(control.canExecute(11).allowed).toBe(true);
    control.engageKillSwitch();
    expect(control.canExecute(12)).toEqual({
      allowed: false,
      reason: "kill switch engaged",
    });
    ledger.close();
  });
});

describe("ledger idempotency", () => {
  it("allows only one buy intent per mint", () => {
    const ledger = tempLedger();
    const base: OrderIntent = {
      createdAtMs: 1,
      expiresAtMs: 2,
      id: "one",
      maxLamports: "1",
      maxSlippageBps: 100,
      mint: "mint",
      policySnapshotHash: "p",
      riskSnapshotHash: "r",
      side: "buy",
      spendUsdCents: 800,
      wallet: "wallet",
    };
    expect(ledger.createIntent(base)).toBe(true);
    expect(ledger.createIntent({ ...base, id: "two" })).toBe(false);
    const pending: ExecutionResult = {
      intentId: base.id,
      mode: "manual",
      status: "awaiting_manual_signature",
    };
    ledger.saveExecution(pending);
    expect(ledger.pendingManualExecutions(1)).toHaveLength(1);
    expect(ledger.pendingManualExecutions(2)).toHaveLength(0);
    ledger.close();
  });
});
