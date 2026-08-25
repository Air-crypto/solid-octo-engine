import type { Connection } from "@solana/web3.js";
import type {
  DeskMode,
  DeskSnapshot,
  ExecutionResult,
  MintState,
  OrderIntent,
  PolicyConfig,
  Position,
  PumpEvent,
  RiskReport,
} from "../domain/types.js";
import type { PriceOracle } from "../adapters/price-oracle.js";
import type { PumpEventSource } from "../adapters/pump-events.js";
import type { RiskProvider } from "../risk/types.js";
import type { Executor, ExecutionContext } from "../execution/types.js";
import type { Ledger } from "../storage/ledger.js";
import { CandidateStore } from "./candidate-store.js";
import type { ControlPlane } from "./control.js";
import { DeskEventBus } from "./event-bus.js";
import { evaluateExit } from "./exit-policy.js";
import { newId, stableHash } from "./hash.js";
import { HealthRegistry } from "./health.js";
import { usdCentsToLamports } from "./market-cap.js";
import { evaluateEntryPolicy } from "./policy.js";
import { tokenDeltaFromTransaction } from "../execution/token-balance.js";
import { validateConfirmedSignature } from "../execution/transaction-guard.js";

export class MintDeskEngine {
  readonly bus: DeskEventBus;
  readonly candidates: CandidateStore;
  readonly health = new HealthRegistry();
  private readonly processing = new Set<string>();
  private monitorTimer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(
    readonly mode: DeskMode,
    readonly policy: PolicyConfig,
    readonly ledger: Ledger,
    readonly control: ControlPlane,
    private readonly source: PumpEventSource,
    private readonly prices: PriceOracle,
    private readonly risk: RiskProvider,
    private readonly executor: Executor,
    private readonly connection: Connection,
  ) {
    this.bus = new DeskEventBus(ledger);
    this.candidates = new CandidateStore(ledger);
    this.health.set("eventStream", "down", "not started");
    this.health.set("priceOracle", "down", "not checked");
    this.health.set("risk", "down", "not checked");
    this.health.set(
      "execution",
      mode === "shadow" ? "disabled" : "down",
      mode === "shadow" ? "shadow mode" : "not checked",
    );
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.source.start((event) => this.handleEvent(event));
    this.monitorTimer = setInterval(
      () => void this.monitorOpenPositions(),
      15_000,
    );
    this.health.heartbeat("eventStream", "Pump Anchor subscriptions active");
    this.bus.emit("system", "engine.started", {
      mode: this.mode,
      policyVersion: this.policy.version,
    });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.source.stop();
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
    this.started = false;
    this.health.set("eventStream", "down", "stopped");
    this.bus.emit("system", "engine.stopped", {});
  }

  async handleEvent(event: PumpEvent): Promise<void> {
    let mark;
    try {
      mark = await this.prices.getMark(event.observedAtMs);
      this.health.heartbeat(
        "priceOracle",
        `${mark.sources.length} sources, spread ${mark.spreadPct.toFixed(3)}%`,
      );
    } catch (error) {
      this.health.set("priceOracle", "down", errorMessage(error));
      this.bus.emit(
        "scout",
        "candidate.skipped",
        { mint: event.mint, reason: "price oracle unavailable" },
        event.observedAtMs,
      );
      return;
    }

    const state = this.candidates.apply(event, mark);
    if (!state) return;
    this.bus.emit(
      "scout",
      event.kind === "create" ? "mint.created" : "mint.updated",
      summarizeMint(state, event.observedAtMs),
      event.observedAtMs,
    );
    await this.evaluateOpenPosition(state, event.observedAtMs);

    if (this.ledger.hasBuyIntent(state.mint) || this.processing.has(state.mint))
      return;
    const decision = evaluateEntryPolicy(
      state,
      mark,
      this.policy,
      event.observedAtMs,
    );
    if (!decision.eligible) {
      this.bus.emit(
        "scout",
        "candidate.filtered",
        { mint: state.mint, reasons: decision.reasons },
        event.observedAtMs,
      );
      return;
    }

    this.processing.add(state.mint);
    this.candidates.setPhase(state.mint, "risk_pending");
    this.bus.emit(
      "risk",
      "risk.started",
      { mint: state.mint, policySnapshotHash: decision.snapshotHash },
      event.observedAtMs,
    );
    try {
      const report = await withTimeout(
        this.risk.assess(state, this.policy, event.observedAtMs),
        this.policy.riskTimeoutMs,
        "risk assessment timed out",
      );
      this.ledger.saveRisk(report);
      this.health.heartbeat(
        "risk",
        `last check ${report.passed ? "passed" : "failed"}`,
      );
      this.bus.emit(
        "risk",
        report.passed ? "risk.passed" : "risk.killed",
        report,
        report.checkedAtMs,
      );
      if (!report.passed) {
        this.candidates.setPhase(state.mint, "killed");
        return;
      }
      this.candidates.setPhase(state.mint, "ready");
      await this.createAndExecuteBuy(
        state,
        report,
        decision.snapshotHash,
        mark.priceUsd,
        event.observedAtMs,
      );
    } catch (error) {
      this.health.set("risk", "degraded", errorMessage(error));
      this.candidates.setPhase(state.mint, "killed");
      this.bus.emit("risk", "risk.error_kill", {
        mint: state.mint,
        reason: errorMessage(error),
      });
    } finally {
      this.processing.delete(state.mint);
    }
  }

  async confirmManual(intentId: string, signature: string): Promise<Position> {
    if (this.mode !== "manual")
      throw new Error("manual confirmation is only available in manual mode");
    const intent = this.ledger.getIntent(intentId);
    const execution = this.ledger.getExecution(intentId);
    if (
      !intent ||
      !execution ||
      execution.status !== "awaiting_manual_signature"
    )
      throw new Error("manual intent is not awaiting confirmation");
    const confirmedTransaction = await validateConfirmedSignature({
      connection: this.connection,
      expectedMint: intent.mint,
      expectedWallet: intent.wallet,
      signature,
    });
    const state = this.candidates.get(intent.mint);
    if (!state) throw new Error("candidate state is missing");
    const actualTokenAmountBaseUnits = tokenDeltaFromTransaction({
      mint: intent.mint,
      side: intent.side,
      transaction: confirmedTransaction,
      wallet: intent.wallet,
    }).toString();
    const sellPosition =
      intent.side === "sell"
        ? this.ledger
            .listPositions(true)
            .find(
              (item) =>
                item.mint === intent.mint && item.wallet === intent.wallet,
            )
        : undefined;
    if (intent.side === "sell" && !sellPosition)
      throw new Error("manual sell has no matching open position");
    const confirmed: ExecutionResult = {
      ...execution,
      actualTokenAmountBaseUnits,
      confirmedAtMs: Date.now(),
      signature,
      status: "confirmed",
    };
    this.ledger.saveExecution(confirmed);
    this.ledger.updateIntentStatus(intent.id, "confirmed");
    if (intent.side === "buy")
      return this.openPosition(intent, confirmed, state);

    const position = sellPosition!;
    const remaining = BigInt(position.remainingTokenBaseUnits);
    const sold = BigInt(actualTokenAmountBaseUnits);
    position.remainingTokenBaseUnits = (
      sold >= remaining ? 0n : remaining - sold
    ).toString();
    position.status =
      BigInt(position.remainingTokenBaseUnits) === 0n ? "closed" : "open";
    this.ledger.upsertPosition(position);
    this.candidates.setPhase(
      state.mint,
      position.status === "closed" ? "closed" : "confirmed",
    );
    this.bus.emit(
      "finance",
      position.status === "closed" ? "position.closed" : "position.scaled",
      { position, reason: "manual_confirmation" },
    );
    return position;
  }

  snapshot(): DeskSnapshot {
    const control = this.control.snapshot();
    return {
      armedUntilMs: control.armedUntilMs,
      candidates: this.candidates.list(100),
      events: this.ledger.recentEvents(150),
      health: this.health.snapshot(),
      killSwitch: control.killSwitch,
      mode: this.mode,
      positions: this.ledger.listPositions(false),
    };
  }

  async engageKillSwitch(reason: string): Promise<void> {
    this.control.engageKillSwitch();
    this.bus.emit("head", "control.kill_switch", { engaged: true, reason });
    for (const position of this.ledger
      .listPositions(true)
      .filter((item) => item.status === "open")) {
      const state = this.candidates.get(position.mint);
      if (!state) {
        this.bus.emit("exit", "exit.state_missing", {
          mint: position.mint,
          positionId: position.id,
          reason,
        });
        continue;
      }
      await this.evaluateOpenPosition(state, Date.now());
    }
  }

  private async createAndExecuteBuy(
    state: MintState,
    report: RiskReport,
    policySnapshotHash: string,
    solUsd: number,
    nowMs: number,
  ): Promise<void> {
    const openPositions = this.ledger.listPositions(true);
    if (openPositions.length >= this.policy.maxOpenPositions)
      throw new Error("maximum open positions reached");
    const dayStart = new Date(nowMs);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dailySpend = this.ledger.dailySpendUsdCents(dayStart.getTime());
    if (
      dailySpend + this.policy.defaultSpendUsdCents >
      this.policy.maxDailySpendUsdCents
    )
      throw new Error("daily spend cap reached");

    const intent: OrderIntent = {
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.policy.intentTtlMs,
      id: newId("buy"),
      maxLamports: usdCentsToLamports(
        this.policy.defaultSpendUsdCents,
        solUsd,
      ).toString(),
      maxSlippageBps: this.policy.maxSlippageBps,
      mint: state.mint,
      policySnapshotHash,
      riskSnapshotHash: report.rawHash,
      side: "buy",
      spendUsdCents: this.policy.defaultSpendUsdCents,
      wallet: this.executor.wallet,
    };
    if (!this.ledger.createIntent(intent))
      throw new Error("duplicate buy intent rejected");
    this.candidates.setPhase(state.mint, "intent_created");
    this.bus.emit("sniper", "intent.created", redactIntent(intent));

    try {
      const result = await this.executor.execute(intent, {
        mintState: state,
        riskReport: report,
      });
      this.ledger.saveExecution(result);
      this.ledger.updateIntentStatus(intent.id, result.status);
      this.bus.emit(
        "sniper",
        `execution.${result.status}`,
        withoutTransaction(result),
      );
      if (result.status === "paper_filled" || result.status === "confirmed") {
        this.health.heartbeat("execution", result.status);
        this.openPosition(intent, result, state);
      } else if (result.status === "awaiting_manual_signature") {
        this.health.set("execution", "degraded", "awaiting Phantom signature");
      }
    } catch (error) {
      this.ledger.updateIntentStatus(intent.id, "rejected");
      this.candidates.setPhase(state.mint, "killed");
      this.health.set("execution", "down", errorMessage(error));
      this.bus.emit("sniper", "execution.rejected", {
        intentId: intent.id,
        mint: intent.mint,
        reason: errorMessage(error),
      });
    }
  }

  private openPosition(
    intent: OrderIntent,
    result: ExecutionResult,
    state: MintState,
  ): Position {
    const tokenAmount =
      result.actualTokenAmountBaseUnits ?? result.expectedTokenAmountBaseUnits;
    if (!tokenAmount || BigInt(tokenAmount) <= 0n)
      throw new Error("execution did not return a token amount");
    const position: Position = {
      entryMarketCapUsd: state.currentMarketCapUsd,
      entrySolLamports: intent.maxLamports,
      entryTimeMs: result.confirmedAtMs ?? Date.now(),
      highWaterMarketCapUsd: state.currentMarketCapUsd,
      id: newId("pos"),
      mint: state.mint,
      mode: this.mode,
      remainingTokenBaseUnits: tokenAmount,
      status: "open",
      tokenAmountBaseUnits: tokenAmount,
      wallet: intent.wallet,
    };
    this.ledger.upsertPosition(position);
    this.candidates.setPhase(state.mint, "confirmed");
    this.bus.emit("finance", "position.opened", position);
    return position;
  }

  private async evaluateOpenPosition(
    state: MintState,
    nowMs: number,
  ): Promise<void> {
    const position = this.ledger
      .listPositions(true)
      .find((item) => item.mint === state.mint && item.status === "open");
    if (!position) return;
    position.highWaterMarketCapUsd = Math.max(
      position.highWaterMarketCapUsd,
      state.currentMarketCapUsd,
    );
    const decision = this.control.snapshot(nowMs).killSwitch
      ? { fraction: 1, reason: "kill_switch" as const, triggered: true }
      : evaluateExit(position, state.currentMarketCapUsd, this.policy, nowMs);
    this.ledger.upsertPosition(position);
    if (!decision.triggered) return;

    const amount =
      decision.fraction >= 1
        ? BigInt(position.remainingTokenBaseUnits)
        : (BigInt(position.remainingTokenBaseUnits) *
            BigInt(Math.round(decision.fraction * 10_000))) /
          10_000n;
    if (amount <= 0n) return;
    position.status = "closing";
    this.ledger.upsertPosition(position);
    const exitRisk = syntheticExitRisk(state);
    const intent: OrderIntent = {
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.policy.intentTtlMs,
      id: newId("sell"),
      maxLamports: "0",
      maxSlippageBps: this.policy.maxSlippageBps,
      mint: state.mint,
      policySnapshotHash: stableHash({ decision, positionId: position.id }),
      riskSnapshotHash: exitRisk.rawHash,
      side: "sell",
      tokenAmountBaseUnits: amount.toString(),
      wallet: position.wallet,
    };
    this.ledger.createIntent(intent);
    this.bus.emit("exit", "exit.triggered", {
      decision,
      intent: redactIntent(intent),
      positionId: position.id,
    });
    try {
      const result = await this.executor.execute(intent, {
        mintState: state,
        riskReport: exitRisk,
      });
      this.ledger.saveExecution(result);
      this.ledger.updateIntentStatus(intent.id, result.status);
      if (result.status === "paper_filled" || result.status === "confirmed") {
        const filled = result.actualTokenAmountBaseUnits
          ? BigInt(result.actualTokenAmountBaseUnits)
          : amount;
        const remaining = BigInt(position.remainingTokenBaseUnits);
        position.remainingTokenBaseUnits = (
          filled >= remaining ? 0n : remaining - filled
        ).toString();
        position.status =
          BigInt(position.remainingTokenBaseUnits) === 0n ? "closed" : "open";
        this.ledger.upsertPosition(position);
        this.candidates.setPhase(
          state.mint,
          position.status === "closed" ? "closed" : "confirmed",
        );
        this.bus.emit(
          "finance",
          position.status === "closed" ? "position.closed" : "position.scaled",
          { decision, position },
        );
      } else if (
        result.status !== "awaiting_manual_signature" &&
        result.status !== "submitted"
      ) {
        position.status = "open";
        this.ledger.upsertPosition(position);
      }
    } catch (error) {
      position.status = "open";
      this.ledger.upsertPosition(position);
      this.bus.emit("exit", "exit.failed", {
        mint: state.mint,
        positionId: position.id,
        reason: errorMessage(error),
      });
    }
  }

  private async monitorOpenPositions(): Promise<void> {
    for (const position of this.ledger
      .listPositions(true)
      .filter((item) => item.status === "open")) {
      const state = this.candidates.get(position.mint);
      if (!state) {
        await this.engageKillSwitch("position_state_missing");
        this.bus.emit("rug", "monitor.state_missing", {
          mint: position.mint,
          positionId: position.id,
        });
        continue;
      }
      try {
        const report = await withTimeout(
          this.risk.assess(state, this.policy),
          this.policy.riskTimeoutMs,
          "position risk recheck timed out",
        );
        this.ledger.saveRisk(report);
        this.bus.emit(
          "rug",
          report.passed ? "monitor.risk_ok" : "monitor.risk_failed",
          report,
        );
        if (!report.passed) {
          await this.engageKillSwitch("position_risk_failed");
        }
      } catch (error) {
        this.bus.emit("rug", "monitor.risk_error", {
          mint: position.mint,
          reason: errorMessage(error),
        });
        await this.engageKillSwitch("position_risk_error");
      }
    }
  }
}

function syntheticExitRisk(state: MintState): RiskReport {
  const rawHash = stableHash({ mint: state.mint, purpose: "position_exit" });
  return {
    checkedAtMs: Date.now(),
    checks: [
      {
        detail: "exits are permitted without a fresh entry-risk pass",
        name: "position_exit",
        status: "pass",
      },
    ],
    mint: state.mint,
    passed: true,
    rawHash,
    sourceLatencyMs: {},
    tokenProgram: state.tokenProgram,
  };
}

function summarizeMint(state: MintState, nowMs: number): object {
  return {
    ageMs: nowMs - state.createdAtMs,
    currentMarketCapUsd: state.currentMarketCapUsd,
    highWaterMarketCapUsd: state.highWaterMarketCapUsd,
    mint: state.mint,
    name: state.name,
    phase: state.phase,
    previousMarketCapUsd: state.previousMarketCapUsd,
    slot: state.lastSlot,
    symbol: state.symbol,
  };
}

function redactIntent(intent: OrderIntent): object {
  return {
    ...intent,
    wallet: `${intent.wallet.slice(0, 6)}…${intent.wallet.slice(-4)}`,
  };
}

function withoutTransaction(result: ExecutionResult): object {
  const { transactionBase64: _removed, ...safe } = result;
  return safe;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
