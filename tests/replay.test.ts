import { readFileSync } from "node:fs";
import { Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { ReplayPumpEventSource } from "../src/adapters/pump-events.js";
import { StaticPriceOracle } from "../src/adapters/price-oracle.js";
import { ControlPlane } from "../src/core/control.js";
import { MintDeskEngine } from "../src/core/engine.js";
import { stableHash } from "../src/core/hash.js";
import type { PumpEvent, RiskReport } from "../src/domain/types.js";
import { ShadowExecutor } from "../src/execution/executors.js";
import type { RiskProvider } from "../src/risk/types.js";
import { policy, tempLedger } from "./helpers.js";

describe("VSEXY replay", () => {
  it("produces one exact-mint paper position", async () => {
    const fixture = JSON.parse(
      readFileSync("fixtures/vsexy-replay.json", "utf8"),
    ) as { events: PumpEvent[]; solUsd: number };
    const ledger = tempLedger();
    const control = new ControlPlane(ledger, policy);
    const risk: RiskProvider = {
      async assess(state, _policy, nowMs = Date.now()): Promise<RiskReport> {
        return {
          checkedAtMs: nowMs,
          checks: [{ detail: "fixture", name: "all", status: "pass" }],
          mint: state.mint,
          passed: true,
          rawHash: stableHash(state.mint),
          sourceLatencyMs: {},
          tokenProgram: state.tokenProgram,
        };
      },
    };
    const engine = new MintDeskEngine(
      "shadow",
      policy,
      ledger,
      control,
      new ReplayPumpEventSource([...fixture.events, fixture.events[1]!]),
      new StaticPriceOracle({
        priceUsd: fixture.solUsd,
        sources: [
          { name: "a", priceUsd: fixture.solUsd },
          { name: "b", priceUsd: fixture.solUsd },
        ],
        spreadPct: 0,
      }),
      risk,
      new ShadowExecutor(
        "ReplayWallet11111111111111111111111111111111",
        undefined,
        () => 1_000_500,
      ),
      new Connection("http://127.0.0.1:8899"),
    );
    await engine.start();
    const snapshot = engine.snapshot();
    expect(snapshot.positions).toHaveLength(1);
    expect(snapshot.positions[0]?.mint).toBe(fixture.events[0]?.mint);
    expect(
      snapshot.events.filter((event) => event.type === "intent.created"),
    ).toHaveLength(1);
    await engine.engageKillSwitch("test");
    const killed = engine.snapshot();
    expect(killed.killSwitch).toBe(true);
    expect(killed.positions[0]?.status).toBe("closed");
    expect(killed.events.some((event) => event.type === "exit.triggered")).toBe(
      true,
    );
    await engine.stop();
    ledger.close();
  });
});

describe("QUEEZING remints", () => {
  it("keeps same-name coins as separate exact mints", async () => {
    const fixture = JSON.parse(
      readFileSync("fixtures/queezing-remints.json", "utf8"),
    ) as { events: PumpEvent[]; solUsd: number };
    const ledger = tempLedger();
    const control = new ControlPlane(ledger, policy);
    const risk: RiskProvider = {
      async assess(state, _policy, nowMs = Date.now()): Promise<RiskReport> {
        return {
          checkedAtMs: nowMs,
          checks: [{ detail: "fixture", name: "all", status: "fail" }],
          mint: state.mint,
          passed: false,
          rawHash: stableHash(state.mint),
          sourceLatencyMs: {},
          tokenProgram: state.tokenProgram,
        };
      },
    };
    const engine = new MintDeskEngine(
      "shadow",
      policy,
      ledger,
      control,
      new ReplayPumpEventSource(fixture.events),
      new StaticPriceOracle({
        priceUsd: fixture.solUsd,
        sources: [
          { name: "a", priceUsd: fixture.solUsd },
          { name: "b", priceUsd: fixture.solUsd },
        ],
        spreadPct: 0,
      }),
      risk,
      new ShadowExecutor("ReplayWallet11111111111111111111111111111111"),
      new Connection("http://127.0.0.1:8899"),
    );
    await engine.start();
    expect(
      new Set(engine.snapshot().candidates.map((candidate) => candidate.mint))
        .size,
    ).toBe(2);
    await engine.stop();
    ledger.close();
  });
});
