import { readFileSync } from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { ReplayPumpEventSource } from "../src/adapters/pump-events.js";
import { StaticPriceOracle } from "../src/adapters/price-oracle.js";
import { ControlPlane } from "../src/core/control.js";
import { MintDeskEngine } from "../src/core/engine.js";
import { stableHash } from "../src/core/hash.js";
import type { PumpEvent, RiskReport } from "../src/domain/types.js";
import { ShadowExecutor } from "../src/execution/executors.js";
import type { RiskProvider } from "../src/risk/types.js";
import { RpcRateController } from "../src/rpc/rate-controller.js";
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
          evidence: { onChain: {}, rugcheck: {} },
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
      new RpcRateController(100),
    );
    await engine.start();
    const snapshot = engine.snapshot();
    expect(snapshot.positions).toHaveLength(1);
    expect(snapshot.positions[0]?.mint).toBe(fixture.events[0]?.mint);
    expect(snapshot.positions[0]?.entryValueUsd).toBe(10);
    expect(snapshot.portfolio.summaries.shadow.openPositions).toBe(1);
    expect(snapshot.portfolio.positions[0]?.legacy).toBe(false);
    expect(
      snapshot.events.filter((event) => event.type === "intent.created"),
    ).toHaveLength(1);
    await engine.engageKillSwitch("test");
    const killed = engine.snapshot();
    expect(killed.killSwitch).toBe(true);
    expect(killed.positions[0]?.status).toBe("closed");
    expect(killed.positions[0]?.exitFills).toHaveLength(1);
    expect(killed.portfolio.summaries.shadow.realizedPnlUsd).not.toBeNaN();
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
          evidence: { onChain: {}, rugcheck: {} },
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
      new RpcRateController(100),
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

describe("terminal exact-mint risk", () => {
  it("does not re-run Risk when a killed mint crosses again", async () => {
    const fixture = JSON.parse(
      readFileSync("fixtures/vsexy-replay.json", "utf8"),
    ) as { events: PumpEvent[]; solUsd: number };
    const create = fixture.events[0]!;
    const crossing = fixture.events[1]!;
    if (create.kind !== "create" || crossing.kind !== "trade")
      throw new Error("unexpected fixture");
    const dip = {
      ...crossing,
      observedAtMs: crossing.observedAtMs + 100,
      signature: "vsexy-dip-signature",
      slot: crossing.slot + 1,
      virtualSolReservesLamports: create.virtualSolReservesLamports,
    };
    const recross = {
      ...crossing,
      observedAtMs: crossing.observedAtMs + 200,
      signature: "vsexy-recross-signature",
      slot: crossing.slot + 2,
    };
    const assess = vi.fn(
      async (state, _policy, nowMs = Date.now()): Promise<RiskReport> => ({
        checkedAtMs: nowMs,
        checks: [{ detail: "fixture", name: "all", status: "fail" }],
        evidence: { onChain: {}, rugcheck: {} },
        mint: state.mint,
        passed: false,
        rawHash: stableHash(state.mint),
        sourceLatencyMs: {},
        tokenProgram: state.tokenProgram,
      }),
    );
    const ledger = tempLedger();
    const engine = new MintDeskEngine(
      "shadow",
      policy,
      ledger,
      new ControlPlane(ledger, policy),
      new ReplayPumpEventSource([create, crossing, dip, recross]),
      new StaticPriceOracle({
        priceUsd: fixture.solUsd,
        sources: [
          { name: "a", priceUsd: fixture.solUsd },
          { name: "b", priceUsd: fixture.solUsd },
        ],
        spreadPct: 0,
      }),
      { assess },
      new ShadowExecutor("ReplayWallet11111111111111111111111111111111"),
      new Connection("http://127.0.0.1:8899"),
      new RpcRateController(100),
    );
    await engine.start();
    expect(assess).toHaveBeenCalledTimes(1);
    expect(engine.snapshot().candidates[0]?.phase).toBe("killed");
    await engine.stop();
    ledger.close();
  });
});

describe("live readiness", () => {
  it("runs risk while disarmed, kills that candidate, then permits a later arm", async () => {
    const fixture = JSON.parse(
      readFileSync("fixtures/vsexy-replay.json", "utf8"),
    ) as { events: PumpEvent[]; solUsd: number };
    const ledger = tempLedger();
    const armToken = "this-is-a-long-test-arm-token";
    const control = new ControlPlane(ledger, policy, armToken);
    const wallet = Keypair.generate().publicKey.toBase58();
    const risk: RiskProvider = {
      async assess(state): Promise<RiskReport> {
        return {
          checkedAtMs: Date.now(),
          checks: [{ detail: "fixture", name: "all", status: "pass" }],
          evidence: { onChain: {}, rugcheck: {} },
          mint: state.mint,
          passed: true,
          rawHash: stableHash(state.mint),
          sourceLatencyMs: {},
          tokenProgram: state.tokenProgram,
        };
      },
    };
    const connection = {
      getBalance: vi.fn(async () => 100_000_000),
      getSlot: vi.fn(async () => 123),
    } as unknown as Connection;
    const engine = new MintDeskEngine(
      "live",
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
      new ShadowExecutor(wallet),
      connection,
      new RpcRateController(100),
    );
    await engine.start();
    const snapshot = engine.snapshot();
    expect(snapshot.positions).toHaveLength(0);
    expect(snapshot.candidates[0]?.phase).toBe("killed");
    expect(snapshot.portfolio.summaries.live.walletSol).toBe(0.1);
    expect(snapshot.portfolio.summaries.live.netWorthUsd).toBe(15);
    expect(snapshot.readiness).toEqual({ canArm: true, reasons: [] });
    expect(engine.arm(armToken, 60_000)).toBeGreaterThan(Date.now());
    await engine.stop();
    ledger.close();
  });
});
