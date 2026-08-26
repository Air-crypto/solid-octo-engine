import { readFileSync } from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { ReplayPumpEventSource } from "../src/adapters/pump-events.js";
import { StaticPriceOracle } from "../src/adapters/price-oracle.js";
import { ControlPlane } from "../src/core/control.js";
import { MintDeskEngine } from "../src/core/engine.js";
import { stableHash } from "../src/core/hash.js";
import type {
  DeskMode,
  ExecutionResult,
  MintState,
  OrderIntent,
  PolicyConfig,
  PumpEvent,
  RiskReport,
} from "../src/domain/types.js";
import {
  ExecutionError,
  describePumpSimulationError,
  type ExecutionContext,
  type Executor,
} from "../src/execution/types.js";
import type { RiskProvider } from "../src/risk/types.js";
import { RpcRateController } from "../src/rpc/rate-controller.js";
import { policy, tempLedger } from "./helpers.js";

const wallet = "ReplayWallet11111111111111111111111111111111";

class IncidentExecutor implements Executor {
  readonly calls: OrderIntent[] = [];

  constructor(
    readonly wallet: string,
    private readonly mode: DeskMode,
    private readonly onSell: (
      intent: OrderIntent,
      call: number,
    ) => void | Promise<void> = () => undefined,
    private readonly buyConfirmedAtMs?: number,
  ) {}

  async execute(
    intent: OrderIntent,
    context: ExecutionContext,
  ): Promise<ExecutionResult> {
    this.calls.push(intent);
    if (intent.side === "sell") {
      const sellCall = this.calls.filter((item) => item.side === "sell").length;
      await this.onSell(intent, sellCall);
      return {
        actualTokenAmountBaseUnits: intent.tokenAmountBaseUnits,
        confirmedAtMs: context.mintState.lastObservedAtMs,
        intentId: intent.id,
        mode: this.mode,
        observedSolUsd: context.solUsd,
        status: this.mode === "shadow" ? "paper_filled" : "confirmed",
      };
    }
    return {
      confirmedAtMs:
        this.buyConfirmedAtMs ?? context.mintState.lastObservedAtMs,
      expectedTokenAmountBaseUnits: "1000000",
      intentId: intent.id,
      mode: this.mode,
      observedSolUsd: context.solUsd,
      status: this.mode === "shadow" ? "paper_filled" : "confirmed",
    };
  }
}

function fixture(): {
  create: PumpEvent;
  crossing: PumpEvent;
  solUsd: number;
} {
  const parsed = JSON.parse(
    readFileSync("fixtures/vsexy-replay.json", "utf8"),
  ) as { events: PumpEvent[]; solUsd: number };
  return {
    create: parsed.events[0]!,
    crossing: parsed.events[1]!,
    solUsd: parsed.solUsd,
  };
}

function report(
  state: MintState,
  passed = true,
  checks: RiskReport["checks"] = [
    { detail: "fixture", name: "all", status: "pass" },
  ],
): RiskReport {
  return {
    checkedAtMs: Date.now(),
    checks,
    evidence: { onChain: {}, rugcheck: {} },
    mint: state.mint,
    passed,
    rawHash: stableHash({ checks, mint: state.mint, passed }),
    sourceLatencyMs: {},
    tokenProgram: state.tokenProgram,
  };
}

function oracle(solUsd: number): StaticPriceOracle {
  return new StaticPriceOracle({
    priceUsd: solUsd,
    sources: [
      { name: "a", priceUsd: solUsd },
      { name: "b", priceUsd: solUsd },
    ],
    spreadPct: 0,
  });
}

function connection(): Connection {
  return {
    getBalance: vi.fn(async () => 100_000_000),
    getSlot: vi.fn(async () => 123),
  } as unknown as Connection;
}

function dipFrom(crossing: PumpEvent): PumpEvent {
  if (crossing.kind !== "trade") throw new Error("fixture trade is missing");
  return {
    ...crossing,
    observedAtMs: crossing.observedAtMs + 100,
    signature: "vsexy-stop-loss-signature",
    slot: crossing.slot + 1,
    virtualSolReservesLamports: "18000000000",
  };
}

async function monitor(engine: MintDeskEngine): Promise<void> {
  await (
    engine as unknown as { monitorOpenPositions(): Promise<void> }
  ).monitorOpenPositions();
}

describe("incident regressions", () => {
  it("blocks shadow entries at KILL before Risk or intent creation", async () => {
    const { create, crossing, solUsd } = fixture();
    const assess = vi.fn(async (state: MintState) => report(state));
    const executor = new IncidentExecutor(wallet, "shadow");
    const ledger = tempLedger();
    const control = new ControlPlane(ledger, policy);
    control.engageKillSwitch();
    const engine = new MintDeskEngine(
      "shadow",
      policy,
      ledger,
      control,
      new ReplayPumpEventSource([create, crossing]),
      oracle(solUsd),
      { assess },
      executor,
      connection(),
      new RpcRateController(100),
    );

    await engine.start();
    const snapshot = engine.snapshot();
    expect(assess).not.toHaveBeenCalled();
    expect(executor.calls).toHaveLength(0);
    expect(snapshot.positions).toHaveLength(0);
    expect(snapshot.candidates[0]?.phase).toBe("killed");
    expect(
      snapshot.events.some(
        (event) => event.type === "candidate.kill_switch_blocked",
      ),
    ).toBe(true);
    await engine.stop();
    ledger.close();
  });

  it("rechecks KILL after Risk before creating a shadow intent", async () => {
    const { create, crossing, solUsd } = fixture();
    let releaseRisk!: () => void;
    let markRiskStarted!: () => void;
    const riskStarted = new Promise<void>((resolve) => {
      markRiskStarted = resolve;
    });
    const riskReleased = new Promise<void>((resolve) => {
      releaseRisk = resolve;
    });
    const executor = new IncidentExecutor(wallet, "shadow");
    const ledger = tempLedger();
    const control = new ControlPlane(ledger, policy);
    const engine = new MintDeskEngine(
      "shadow",
      policy,
      ledger,
      control,
      new ReplayPumpEventSource([]),
      oracle(solUsd),
      {
        async assess(state) {
          markRiskStarted();
          await riskReleased;
          return report(state);
        },
      },
      executor,
      connection(),
      new RpcRateController(100),
    );

    await engine.start();
    await engine.handleEvent(create);
    const crossingRun = engine.handleEvent(crossing);
    await riskStarted;
    control.engageKillSwitch();
    releaseRisk();
    await crossingRun;
    const snapshot = engine.snapshot();
    expect(executor.calls).toHaveLength(0);
    expect(snapshot.positions).toHaveLength(0);
    expect(snapshot.candidates[0]?.phase).toBe("killed");
    expect(
      snapshot.events.some(
        (event) => event.type === "candidate.kill_switch_blocked",
      ),
    ).toBe(true);
    await engine.stop();
    ledger.close();
  });

  it("stops a loss and retries only fresh pre-broadcast sell intents", async () => {
    const { create, crossing, solUsd } = fixture();
    const executor = new IncidentExecutor(wallet, "shadow", (_intent, call) => {
      if (call < 3)
        throw new ExecutionError(
          "Pump 6003 TooLittleSolReceived",
          "simulation",
          true,
          false,
        );
    });
    const risk: RiskProvider = { assess: async (state) => report(state) };
    const ledger = tempLedger();
    const engine = new MintDeskEngine(
      "shadow",
      policy,
      ledger,
      new ControlPlane(ledger, policy),
      new ReplayPumpEventSource([create, crossing, dipFrom(crossing)]),
      oracle(solUsd),
      risk,
      executor,
      connection(),
      new RpcRateController(100),
    );

    await engine.start();
    const snapshot = engine.snapshot();
    const sells = executor.calls.filter((item) => item.side === "sell");
    expect(sells).toHaveLength(3);
    expect(new Set(sells.map((item) => item.id)).size).toBe(3);
    expect(new Set(sells.map((item) => item.maxSlippageBps))).toEqual(
      new Set([policy.maxSlippageBps]),
    );
    expect(snapshot.positions[0]?.status).toBe("closed");
    expect(snapshot.positions[0]?.exitFills?.[0]?.reason).toBe("stop_loss");
    expect(
      snapshot.events.filter((event) => event.type === "exit.attempt_failed"),
    ).toHaveLength(2);
    expect(snapshot.killSwitch).toBe(false);
    await engine.stop();
    ledger.close();
  });

  it("does not retry an exit after broadcast may have happened", async () => {
    const { create, crossing, solUsd } = fixture();
    const executor = new IncidentExecutor(wallet, "shadow", () => {
      throw new ExecutionError(
        "broadcast result is ambiguous",
        "broadcast",
        false,
        true,
      );
    });
    const ledger = tempLedger();
    const engine = new MintDeskEngine(
      "shadow",
      policy,
      ledger,
      new ControlPlane(ledger, policy),
      new ReplayPumpEventSource([create, crossing, dipFrom(crossing)]),
      oracle(solUsd),
      { assess: async (state) => report(state) },
      executor,
      connection(),
      new RpcRateController(100),
    );

    await engine.start();
    const snapshot = engine.snapshot();
    expect(executor.calls.filter((item) => item.side === "sell")).toHaveLength(
      1,
    );
    expect(snapshot.positions[0]?.status).toBe("closing");
    expect(snapshot.killSwitch).toBe(true);
    expect(
      snapshot.events.some(
        (event) => event.type === "exit.operator_action_required",
      ),
    ).toBe(true);
    await engine.stop();
    ledger.close();
  });

  it("keeps a pre-broadcast stop active without another trade event", async () => {
    const { create, crossing, solUsd } = fixture();
    const executor = new IncidentExecutor(wallet, "shadow", (_intent, call) => {
      if (call <= 3)
        throw new ExecutionError(
          "builder was stale before broadcast",
          "simulation",
          true,
          false,
        );
    });
    const testPolicy: PolicyConfig = {
      ...policy,
      exitRetryCooldownMs: 1,
    };
    const ledger = tempLedger();
    const engine = new MintDeskEngine(
      "shadow",
      testPolicy,
      ledger,
      new ControlPlane(ledger, testPolicy),
      new ReplayPumpEventSource([create, crossing, dipFrom(crossing)]),
      oracle(solUsd),
      { assess: async (state) => report(state) },
      executor,
      connection(),
      new RpcRateController(100),
    );

    await engine.start();
    expect(engine.snapshot().positions[0]?.status).toBe("open");
    await new Promise((resolve) => setTimeout(resolve, 2));
    await monitor(engine);
    expect(executor.calls.filter((item) => item.side === "sell")).toHaveLength(
      4,
    );
    expect(engine.snapshot().positions[0]?.status).toBe("closed");
    await engine.stop();
    ledger.close();
  });

  it("rechecks one transient hold-risk failure before killing", async () => {
    const { create, crossing, solUsd } = fixture();
    let calls = 0;
    const risk: RiskProvider = {
      async assess(state) {
        calls += 1;
        if (calls === 1) return report(state);
        throw new Error("Rugcheck timed out");
      },
    };
    const testPolicy: PolicyConfig = {
      ...policy,
      holdRiskRetryDelayMs: 1,
    };
    const executor = new IncidentExecutor(
      wallet,
      "shadow",
      () => undefined,
      Date.now() - 16_000,
    );
    const ledger = tempLedger();
    const engine = new MintDeskEngine(
      "shadow",
      testPolicy,
      ledger,
      new ControlPlane(ledger, testPolicy),
      new ReplayPumpEventSource([create, crossing]),
      oracle(solUsd),
      risk,
      executor,
      connection(),
      new RpcRateController(100),
    );

    await engine.start();
    await monitor(engine);
    expect(engine.snapshot().killSwitch).toBe(false);
    expect(engine.snapshot().positions[0]?.status).toBe("open");
    await new Promise((resolve) => setTimeout(resolve, 2));
    await monitor(engine);
    const snapshot = engine.snapshot();
    expect(snapshot.killSwitch).toBe(true);
    expect(snapshot.positions[0]?.status).toBe("closed");
    expect(
      snapshot.events.filter(
        (event) => event.type === "monitor.risk_uncertain",
      ),
    ).toHaveLength(2);
    await engine.stop();
    ledger.close();
  });

  it("kills immediately on a confirmed hard hold-risk failure", async () => {
    const { create, crossing, solUsd } = fixture();
    let calls = 0;
    const risk: RiskProvider = {
      async assess(state) {
        calls += 1;
        return calls === 1
          ? report(state)
          : report(state, false, [
              {
                detail: "Rugcheck reports one insider",
                name: "insiders_zero",
                status: "fail",
              },
            ]);
      },
    };
    const executor = new IncidentExecutor(
      wallet,
      "shadow",
      () => undefined,
      Date.now() - 16_000,
    );
    const ledger = tempLedger();
    const engine = new MintDeskEngine(
      "shadow",
      policy,
      ledger,
      new ControlPlane(ledger, policy),
      new ReplayPumpEventSource([create, crossing]),
      oracle(solUsd),
      risk,
      executor,
      connection(),
      new RpcRateController(100),
    );

    await engine.start();
    await monitor(engine);
    const snapshot = engine.snapshot();
    expect(snapshot.killSwitch).toBe(true);
    expect(snapshot.positions[0]?.status).toBe("closed");
    expect(
      snapshot.events.some((event) => event.type === "monitor.risk_hard_fail"),
    ).toBe(true);
    await engine.stop();
    ledger.close();
  });

  it("treats a live buy slippage reject as candidate-local", async () => {
    const { create, crossing, solUsd } = fixture();
    const armToken = "incident-test-arm-token-long-enough";
    const liveWallet = Keypair.generate().publicKey.toBase58();
    const executor: Executor = {
      wallet: liveWallet,
      async execute() {
        throw new ExecutionError(
          "Pump 6002 TooMuchSolRequired",
          "simulation",
          true,
          false,
        );
      },
    };
    const ledger = tempLedger();
    const control = new ControlPlane(ledger, policy, armToken);
    const engine = new MintDeskEngine(
      "live",
      policy,
      ledger,
      control,
      new ReplayPumpEventSource([]),
      oracle(solUsd),
      { assess: async (state) => report(state) },
      executor,
      connection(),
      new RpcRateController(100),
    );

    await engine.start();
    control.arm(armToken, 60_000);
    await engine.handleEvent(create);
    await engine.handleEvent(crossing);
    const snapshot = engine.snapshot();
    expect(snapshot.killSwitch).toBe(false);
    expect(snapshot.armedUntilMs).toBeNull();
    expect(snapshot.positions).toHaveLength(0);
    expect(snapshot.health.execution?.status).toBe("ok");
    expect(
      snapshot.events.some(
        (event) =>
          event.type === "execution.rejected" &&
          (event.data as { stage?: string }).stage === "simulation",
      ),
    ).toBe(true);
    await engine.stop();
    ledger.close();
  });

  it("labels the two Pump slippage errors from simulation results", () => {
    expect(
      describePumpSimulationError(
        { InstructionError: [2, { Custom: 6002 }] },
        "buy",
      ),
    ).toContain("TooMuchSolRequired");
    expect(
      describePumpSimulationError(
        { InstructionError: [2, { Custom: 6003 }] },
        "sell",
      ),
    ).toContain("TooLittleSolReceived");
  });
});
