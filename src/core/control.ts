import { timingSafeEqual } from "node:crypto";
import type { PolicyConfig } from "../domain/types.js";
import type { Ledger } from "../storage/ledger.js";

export class ControlPlane {
  private armedUntilMs: number | null;
  private killSwitch: boolean;

  constructor(
    private readonly ledger: Ledger,
    private readonly policy: PolicyConfig,
    private readonly armToken?: string,
  ) {
    this.armedUntilMs = ledger.getControl<number | null>("armedUntilMs", null);
    this.killSwitch = ledger.getControl<boolean>("killSwitch", false);
  }

  arm(token: string, requestedLeaseMs: number, nowMs = Date.now()): number {
    if (!this.armToken || !safeEqual(token, this.armToken))
      throw new Error("invalid arm token");
    const leaseMs = Math.min(
      Math.max(1, requestedLeaseMs),
      this.policy.armLeaseMaxMs,
    );
    this.armedUntilMs = nowMs + leaseMs;
    this.ledger.setControl("armedUntilMs", this.armedUntilMs);
    return this.armedUntilMs;
  }

  disarm(): void {
    this.armedUntilMs = null;
    this.ledger.setControl("armedUntilMs", null);
  }

  engageKillSwitch(): void {
    this.killSwitch = true;
    this.disarm();
    this.ledger.setControl("killSwitch", true);
  }

  releaseKillSwitch(token: string): void {
    if (!this.armToken || !safeEqual(token, this.armToken))
      throw new Error("invalid arm token");
    this.killSwitch = false;
    this.ledger.setControl("killSwitch", false);
  }

  canExecute(nowMs = Date.now()): { allowed: boolean; reason: string } {
    if (this.killSwitch)
      return { allowed: false, reason: "kill switch engaged" };
    if (!this.armedUntilMs || nowMs >= this.armedUntilMs)
      return { allowed: false, reason: "arm lease missing or expired" };
    return { allowed: true, reason: "armed" };
  }

  snapshot(nowMs = Date.now()): {
    armedUntilMs: number | null;
    killSwitch: boolean;
  } {
    if (this.armedUntilMs && nowMs >= this.armedUntilMs) this.disarm();
    return { armedUntilMs: this.armedUntilMs, killSwitch: this.killSwitch };
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
