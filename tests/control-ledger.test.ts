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

  it("bounds high-volume operational events without pruning financial records", () => {
    const ledger = tempLedger(10_000, 3);
    for (let index = 0; index < 5; index += 1)
      ledger.appendEvent({
        atMs: index,
        data: { index },
        id: `event-${index}`,
        role: "scout",
        type: "mint.created",
      });
    ledger.pruneOperationalData(5);
    expect(ledger.recentEvents(10).map((event) => event.id)).toEqual([
      "event-2",
      "event-3",
      "event-4",
    ]);
    ledger.close();
  });

  it("keeps daily spend isolated by execution mode and wallet", () => {
    const ledger = tempLedger();
    for (const [id, mode, wallet, spend] of [
      ["shadow", "shadow", "same-wallet", 800],
      ["live", "live", "same-wallet", 1_000],
      ["other-wallet", "live", "other-wallet", 1_200],
    ] as const) {
      const intent: OrderIntent = {
        createdAtMs: 100,
        expiresAtMs: 200,
        id,
        maxLamports: "1",
        maxSlippageBps: 100,
        mint: `mint-${id}`,
        policySnapshotHash: "p",
        riskSnapshotHash: "r",
        side: "buy",
        spendUsdCents: spend,
        wallet,
      };
      ledger.createIntent(intent);
      ledger.updateIntentStatus(
        id,
        mode === "shadow" ? "paper_filled" : "confirmed",
      );
      ledger.saveExecution({
        intentId: id,
        mode,
        status: mode === "shadow" ? "paper_filled" : "confirmed",
      });
    }
    expect(ledger.dailySpendUsdCents(0, "live", "same-wallet")).toBe(1_000);
    expect(ledger.dailySpendUsdCents(0, "shadow", "same-wallet")).toBe(800);
    ledger.close();
  });
});
