import { PublicKey, type Connection } from "@solana/web3.js";
import type {
  DeskMode,
  DeskSnapshot,
  ExecutionResult,
  MintState,
  OrderIntent,
  PolicyConfig,
  Position,
  PriceMark,
  PumpEvent,
  RiskReport,
} from "../domain/types.js";
import type { RpcRateController } from "../rpc/rate-controller.js";
import type { PriceOracle } from "../adapters/price-oracle.js";
import type { PumpEventSource } from "../adapters/pump-events.js";
import type { RiskProvider } from "../risk/types.js";
import type { Executor } from "../execution/types.js";
import type { Ledger } from "../storage/ledger.js";
import { CandidateStore } from "./candidate-store.js";
import type { ControlPlane } from "./control.js";
import { DeskEventBus } from "./event-bus.js";
import { evaluateExit } from "./exit-policy.js";
import { newId, stableHash } from "./hash.js";
import { HealthRegistry } from "./health.js";
import { usdCentsToLamports } from "./market-cap.js";
import { evaluateEntryPolicy } from "./policy.js";
import {
  feeLamportsFromTransaction,
  nativeSolDeltaFromTransaction,
  tokenDeltaFromTransaction,
} from "../execution/token-balance.js";
import { validateConfirmedSignature } from "../execution/transaction-guard.js";
import { buildPortfolio } from "./portfolio.js";

export class MintDeskEngine {
  readonly bus: DeskEventBus;
  readonly candidates: CandidateStore;
  readonly health = new HealthRegistry();
  private readonly processing = new Set<string>();
  private readonly eventChains = new Map<string, Promise<void>>();
  private consecutiveRiskFailures = 0;
  private lastPassingRiskAtMs: number | null = null;
  private lastPortfolioMarkAtMs = 0;
  private latestSolMark: PriceMark | null = null;
  private rpcHealthTimer: NodeJS.Timeout | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private riskBusy = false;
  private readonly sessionStartedAtMs = Date.now();
  private started = false;
  private walletBalanceLamports: bigint | null = null;

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
    private readonly rpc: RpcRateController,
  ) {
    this.bus = new DeskEventBus(ledger);
    this.candidates = new CandidateStore(ledger);
    this.health.set("eventStream", "down", "not started");
    this.health.set("priceOracle", "down", "not checked");
    this.health.set("risk", "down", "not checked");
    this.health.set("rpc", "down", "not checked");
    this.health.set(
      "execution",
      mode === "shadow" ? "disabled" : "down",
      mode === "shadow" ? "shadow mode" : "not checked",
    );
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (this.mode !== "shadow") this.control.disarm();
    await this.preflightInfrastructure();
    await this.source.start((event) => this.handleEvent(event));
    this.monitorTimer = setInterval(
      () =>
        void this.monitorOpenPositions().catch((error) =>
          this.handleBackgroundFailure("position_monitor", error),
        ),
      15_000,
    );
    this.rpcHealthTimer = setInterval(
      () => void this.refreshRpcHealth(),
      60_000,
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
    await Promise.allSettled([...this.eventChains.values()]);
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    if (this.rpcHealthTimer) clearInterval(this.rpcHealthTimer);
    this.monitorTimer = null;
    this.rpcHealthTimer = null;
    this.started = false;
    this.health.set("eventStream", "down", "stopped");
    this.bus.emit("system", "engine.stopped", {});
  }

  async handleEvent(event: PumpEvent): Promise<void> {
    const previous = this.eventChains.get(event.mint) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => await this.processEvent(event));
    this.eventChains.set(event.mint, current);
    try {
      await current;
    } finally {
      if (this.eventChains.get(event.mint) === current)
        this.eventChains.delete(event.mint);
    }
  }

  private async processEvent(event: PumpEvent): Promise<void> {
    let mark;
    try {
      mark = await this.prices.getMark(event.observedAtMs);
      this.latestSolMark = mark;
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
    if (!state) {
      this.maybeRecordPortfolioMark(event.observedAtMs);
      return;
    }
    if (event.kind === "create")
      this.bus.emit(
        "scout",
        "mint.created",
        summarizeMint(state, event.observedAtMs),
        event.observedAtMs,
      );
    await this.evaluateOpenPosition(state, event.observedAtMs);
    this.maybeRecordPortfolioMark(event.observedAtMs);

    if (
      state.phase !== "seen" ||
      this.ledger.hasBuyIntent(state.mint) ||
      this.processing.has(state.mint)
    )
      return;
    const decision = evaluateEntryPolicy(
      state,
      mark,
      this.policy,
      event.observedAtMs,
    );
    if (!decision.eligible) {
      const ageMs = event.observedAtMs - state.createdAtMs;
      if (
        ageMs > this.policy.maxAgeMs ||
        state.highWaterMarketCapUsd >= this.policy.spikeCeilingMarketCapUsd
      ) {
        this.candidates.setPhase(state.mint, "killed");
        this.bus.emit(
          "scout",
          "candidate.policy_kill",
          { mint: state.mint, reasons: decision.reasons },
          event.observedAtMs,
        );
      }
      return;
    }

    if (this.riskBusy) {
      this.candidates.setPhase(state.mint, "killed");
      this.bus.emit(
        "risk",
        "risk.busy_kill",
        { mint: state.mint, reason: "another exact mint owns the risk gate" },
        event.observedAtMs,
      );
      return;
    }

    this.riskBusy = true;
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
        this.risk.assess(state, this.policy, Date.now()),
        this.policy.riskTimeoutMs,
        "risk assessment timed out",
      );
      this.ledger.saveRisk(report);
      this.consecutiveRiskFailures = 0;
      if (report.passed) this.lastPassingRiskAtMs = report.checkedAtMs;
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
      if (this.mode === "live") {
        const control = this.control.canExecute();
        if (!control.allowed) {
          this.candidates.setPhase(state.mint, "killed");
          this.bus.emit(
            "head",
            "candidate.passed_unarmed_kill",
            { mint: state.mint, reason: control.reason },
            event.observedAtMs,
          );
          return;
        }
      }
      this.candidates.setPhase(state.mint, "ready");
      await this.createAndExecuteBuy(
        state,
        report,
        decision.snapshotHash,
        mark.priceUsd,
        Date.now(),
      );
    } catch (error) {
      this.consecutiveRiskFailures += 1;
      this.health.set("risk", "degraded", errorMessage(error));
      this.candidates.setPhase(state.mint, "killed");
      this.bus.emit("risk", "risk.error_kill", {
        mint: state.mint,
        reason: errorMessage(error),
      });
      if (
        this.mode === "live" &&
        this.consecutiveRiskFailures >= this.policy.riskFailureKillThreshold
      )
        await this.engageKillSwitch("risk_health_degraded");
    } finally {
      this.processing.delete(state.mint);
      this.riskBusy = false;
    }
  }

  arm(token: string, leaseMs: number): number {
    const readiness = this.readiness();
    if (!readiness.canArm)
      throw new Error(`desk is not ready: ${readiness.reasons.join("; ")}`);
    const riskFreshForMs = Math.max(
      1,
      this.lastPassingRiskAtMs! + 15 * 60_000 - Date.now(),
    );
    return this.control.arm(token, Math.min(leaseMs, riskFreshForMs));
  }

  markSourceDegraded(error: unknown, source: string): void {
    const component =
      source === "event_parser" || source === "pump_logs"
        ? "eventStream"
        : "rpc";
    this.health.set(component, "degraded", `${source}: ${errorMessage(error)}`);
    this.bus.emit("system", `${component}.degraded`, {
      reason: errorMessage(error),
      source,
    });
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
    let solUsd = this.latestSolMark?.priceUsd;
    if (solUsd == null) {
      try {
        const mark = await this.prices.getMark();
        this.latestSolMark = mark;
        solUsd = mark.priceUsd;
      } catch {
        // Confirmation remains authoritative even when the display mark is unavailable.
      }
    }
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
                item.mint === intent.mint &&
                item.mode === this.mode &&
                item.wallet === intent.wallet,
            )
        : undefined;
    if (intent.side === "sell" && !sellPosition)
      throw new Error("manual sell has no matching open position");
    const confirmed: ExecutionResult = {
      ...execution,
      actualSolDeltaLamports: nativeSolDeltaFromTransaction({
        transaction: confirmedTransaction,
        wallet: intent.wallet,
      }).toString(),
      actualTokenAmountBaseUnits,
      confirmedAtMs: Date.now(),
      feeLamports: feeLamportsFromTransaction(confirmedTransaction).toString(),
      observedSolUsd: solUsd,
      signature,
      status: "confirmed",
    };
    this.ledger.saveExecution(confirmed);
    this.ledger.updateIntentStatus(intent.id, "confirmed");
    this.applyWalletDelta(confirmed);
    const confirmedAtMs = confirmed.confirmedAtMs!;
    if (intent.side === "buy") {
      const opened = this.openPosition(intent, confirmed, state);
      this.maybeRecordPortfolioMark(confirmedAtMs, true);
      return opened;
    }

    const position = sellPosition!;
    this.applyExitFill(
      position,
      confirmed,
      state,
      BigInt(actualTokenAmountBaseUnits),
      "manual_confirmation",
      confirmedAtMs,
    );
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
    this.maybeRecordPortfolioMark(confirmedAtMs, true);
    return position;
  }

  snapshot(): DeskSnapshot {
    const control = this.control.snapshot();
    const generatedAtMs = Date.now();
    const rawPositions = this.ledger.listPositions(false);
    const portfolio = buildPortfolio({
      activeMode: this.mode,
      nowMs: generatedAtMs,
      positions: rawPositions,
      sessionStartedAtMs: this.sessionStartedAtMs,
      solMark: this.latestSolMark,
      stateForMint: (mint) => this.candidates.get(mint),
      wallet: this.executor.wallet,
      walletBalanceLamports: this.walletBalanceLamports,
    });
    return {
      armedUntilMs: control.armedUntilMs,
      candidates: this.candidates.list(100),
      events: this.ledger.recentEvents(150),
      health: this.health.snapshot(),
      killSwitch: control.killSwitch,
      mode: this.mode,
      portfolio: {
        generatedAtMs,
        history: {
          live: this.ledger.listPortfolioMarks("live", this.executor.wallet),
          manual: this.ledger.listPortfolioMarks(
            "manual",
            this.executor.wallet,
          ),
          shadow: this.ledger.listPortfolioMarks(
            "shadow",
            this.executor.wallet,
          ),
        },
        positions: portfolio.positions,
        solUsd: this.latestSolMark?.priceUsd ?? null,
        solUsdObservedAtMs: this.latestSolMark?.observedAtMs ?? null,
        summaries: portfolio.summaries,
      },
      positions: rawPositions,
      readiness: this.readiness(),
      rpc: this.rpc.snapshot(),
    };
  }

  async engageKillSwitch(reason: string): Promise<void> {
    this.control.engageKillSwitch();
    this.bus.emit("head", "control.kill_switch", { engaged: true, reason });
    for (const position of this.ledger
      .listPositions(true)
      .filter(
        (item) =>
          item.status === "open" &&
          item.mode === this.mode &&
          item.wallet === this.executor.wallet,
      )) {
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
    const openPositions = this.ledger
      .listPositions(true)
      .filter(
        (position) =>
          position.mode === this.mode &&
          position.wallet === this.executor.wallet,
      );
    if (openPositions.length >= this.policy.maxOpenPositions)
      throw new Error("maximum open positions reached");
    const dayStart = new Date(nowMs);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dailySpend = this.ledger.dailySpendUsdCents(
      dayStart.getTime(),
      this.mode,
      this.executor.wallet,
    );
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
        solUsd,
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
        this.applyWalletDelta(result);
        this.openPosition(intent, result, state);
        this.maybeRecordPortfolioMark(result.confirmedAtMs ?? nowMs, true);
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
      if (this.mode === "live")
        await this.engageKillSwitch("execution_health_degraded");
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
      entryFeeUsd: executionFeeUsd(result),
      entryMarketCapUsd: state.currentMarketCapUsd,
      entrySolLamports: intent.maxLamports,
      entrySlippageBps: buySlippageBps(result),
      entryTimeMs: result.confirmedAtMs ?? Date.now(),
      entryValueUsd: buyValueUsd(intent, result),
      exitFills: [],
      feesUsd: executionFeeUsd(result) ?? 0,
      highWaterMarketCapUsd: state.currentMarketCapUsd,
      id: newId("pos"),
      mint: state.mint,
      mode: this.mode,
      lastMarketCapUsd: state.currentMarketCapUsd,
      realizedPnlUsd: 0,
      realizedProceedsUsd: 0,
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
      .find(
        (item) =>
          item.mint === state.mint &&
          item.status === "open" &&
          item.mode === this.mode &&
          item.wallet === this.executor.wallet,
      );
    if (!position) return;
    position.highWaterMarketCapUsd = Math.max(
      position.highWaterMarketCapUsd,
      state.currentMarketCapUsd,
    );
    position.lastMarketCapUsd = state.currentMarketCapUsd;
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
        solUsd: this.latestSolMark?.priceUsd,
      });
      this.ledger.saveExecution(result);
      this.ledger.updateIntentStatus(intent.id, result.status);
      if (result.status === "paper_filled" || result.status === "confirmed") {
        const filled = result.actualTokenAmountBaseUnits
          ? BigInt(result.actualTokenAmountBaseUnits)
          : amount;
        this.applyWalletDelta(result);
        this.applyExitFill(
          position,
          result,
          state,
          filled,
          decision.reason,
          result.confirmedAtMs ?? nowMs,
        );
        this.ledger.upsertPosition(position);
        const closed = BigInt(position.remainingTokenBaseUnits) === 0n;
        this.candidates.setPhase(state.mint, closed ? "closed" : "confirmed");
        this.bus.emit(
          "finance",
          closed ? "position.closed" : "position.scaled",
          { decision, position },
        );
        this.maybeRecordPortfolioMark(result.confirmedAtMs ?? nowMs, true);
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
      .filter(
        (item) =>
          item.status === "open" &&
          item.mode === this.mode &&
          item.wallet === this.executor.wallet,
      )) {
      const state = this.candidates.get(position.mint);
      if (!state) {
        await this.engageKillSwitch("position_state_missing");
        this.bus.emit("rug", "monitor.state_missing", {
          mint: position.mint,
          positionId: position.id,
        });
        continue;
      }
      if (this.riskBusy) {
        this.bus.emitTransient("rug", "monitor.risk_deferred", {
          mint: position.mint,
          reason: "entry risk gate is busy",
        });
        continue;
      }
      this.riskBusy = true;
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
      } finally {
        this.riskBusy = false;
      }
    }
    this.maybeRecordPortfolioMark(Date.now());
  }

  private async preflightInfrastructure(): Promise<void> {
    await this.refreshRpcHealth();

    const latestRisk = this.ledger.latestRiskReport();
    if (latestRisk && Date.now() - latestRisk.checkedAtMs <= 15 * 60_000)
      this.health.heartbeat(
        "risk",
        `recent completed check ${latestRisk.passed ? "passed" : "killed"}`,
        latestRisk.checkedAtMs,
      );
    const latestPassingRisk = this.ledger.latestPassingRiskReport();
    if (latestPassingRisk)
      this.lastPassingRiskAtMs = latestPassingRisk.checkedAtMs;

    if (this.mode === "shadow") return;
    if (this.mode === "manual") {
      this.health.set(
        "execution",
        "degraded",
        "Phantom must connect and match the configured wallet",
      );
      return;
    }
    try {
      const balance =
        this.walletBalanceLamports == null
          ? await this.connection.getBalance(
              new PublicKey(this.executor.wallet),
              "processed",
            )
          : Number(this.walletBalanceLamports);
      this.walletBalanceLamports = BigInt(balance);
      if (balance < 5_000_000)
        throw new Error("execution wallet has less than 0.005 SOL");
      this.health.heartbeat(
        "execution",
        `local signer verified; ${(balance / 1_000_000_000).toFixed(4)} SOL`,
      );
    } catch (error) {
      this.health.set("execution", "down", errorMessage(error));
    }
  }

  private async refreshRpcHealth(): Promise<void> {
    try {
      const slot = await this.connection.getSlot("processed");
      if (this.mode !== "shadow") {
        const balance = await this.connection.getBalance(
          new PublicKey(this.executor.wallet),
          "processed",
        );
        this.walletBalanceLamports = BigInt(balance);
      }
      this.health.heartbeat("rpc", `processed slot ${slot}`);
    } catch (error) {
      this.health.set("rpc", "degraded", errorMessage(error));
    }
  }

  private applyWalletDelta(result: ExecutionResult): void {
    if (
      this.mode === "shadow" ||
      this.walletBalanceLamports == null ||
      result.actualSolDeltaLamports == null
    )
      return;
    this.walletBalanceLamports += BigInt(result.actualSolDeltaLamports);
  }

  private applyExitFill(
    position: Position,
    result: ExecutionResult,
    state: MintState,
    requestedFilled: bigint,
    reason: string,
    atMs: number,
  ): void {
    const remainingBefore = BigInt(position.remainingTokenBaseUnits);
    const filled =
      requestedFilled > remainingBefore ? remainingBefore : requestedFilled;
    const original = BigInt(position.tokenAmountBaseUnits);
    const soldFraction = bigintRatio(filled, original);
    const entryValueUsd = position.entryValueUsd;
    const costBasisUsd =
      entryValueUsd == null ? null : entryValueUsd * soldFraction;
    const proceedsUsd = sellProceedsUsd(position, result, state, soldFraction);
    const feeUsd = executionFeeUsd(result);
    if (costBasisUsd != null && proceedsUsd != null) {
      const realizedPnlUsd = proceedsUsd - costBasisUsd;
      position.exitFills = [
        ...(position.exitFills ?? []),
        {
          atMs,
          costBasisUsd,
          feeUsd,
          marketCapUsd: state.currentMarketCapUsd,
          proceedsUsd,
          realizedPnlUsd,
          reason,
          signature: result.signature,
          slippageBps: sellSlippageBps(result),
          tokenAmountBaseUnits: filled.toString(),
        },
      ];
      position.realizedPnlUsd = (position.realizedPnlUsd ?? 0) + realizedPnlUsd;
      position.realizedProceedsUsd =
        (position.realizedProceedsUsd ?? 0) + proceedsUsd;
    }
    position.feesUsd = (position.feesUsd ?? 0) + (feeUsd ?? 0);
    position.lastMarketCapUsd = state.currentMarketCapUsd;
    position.remainingTokenBaseUnits = (remainingBefore - filled).toString();
    position.status =
      BigInt(position.remainingTokenBaseUnits) === 0n ? "closed" : "open";
    if (position.status === "closed") position.closedAtMs = atMs;
  }

  private maybeRecordPortfolioMark(nowMs: number, force = false): void {
    if (!this.latestSolMark) return;
    const bucketMs = Math.floor(nowMs / 30_000) * 30_000;
    if (!force && bucketMs <= this.lastPortfolioMarkAtMs) return;
    const portfolio = buildPortfolio({
      activeMode: this.mode,
      nowMs,
      positions: this.ledger.listPositions(false),
      sessionStartedAtMs: this.sessionStartedAtMs,
      solMark: this.latestSolMark,
      stateForMint: (mint) => this.candidates.get(mint),
      wallet: this.executor.wallet,
      walletBalanceLamports: this.walletBalanceLamports,
    });
    for (const mode of ["shadow", "manual", "live"] as const) {
      const summary = portfolio.summaries[mode];
      this.ledger.savePortfolioMark({
        atMs: bucketMs,
        mode,
        netWorthUsd: summary.netWorthUsd,
        realizedPnlUsd: summary.realizedPnlUsd,
        totalPnlUsd: summary.totalPnlUsd,
        unrealizedPnlUsd: summary.unrealizedPnlUsd,
        wallet: this.executor.wallet,
      });
    }
    this.lastPortfolioMarkAtMs = Math.max(this.lastPortfolioMarkAtMs, bucketMs);
  }

  private handleBackgroundFailure(source: string, error: unknown): void {
    this.health.set("risk", "degraded", `${source}: ${errorMessage(error)}`);
    this.bus.emit("system", "background.error", {
      reason: errorMessage(error),
      source,
    });
    if (this.mode === "live") this.control.engageKillSwitch();
  }

  private readiness(): DeskSnapshot["readiness"] {
    const reasons: string[] = [];
    const health = this.health.snapshot();
    const control = this.control.snapshot();
    const rpc = this.rpc.snapshot();
    if (this.mode !== "live")
      reasons.push(`${this.mode} mode cannot arm live buys`);
    for (const component of [
      "eventStream",
      "priceOracle",
      "rpc",
      "risk",
      "execution",
    ]) {
      if (health[component]?.status !== "ok")
        reasons.push(
          `${component} is ${health[component]?.status ?? "missing"}`,
        );
    }
    if (control.killSwitch) reasons.push("kill switch is engaged");
    if (
      !this.lastPassingRiskAtMs ||
      Date.now() - this.lastPassingRiskAtMs > 15 * 60_000
    )
      reasons.push("no passing risk report in the last 15 minutes");
    if (rpc.last429AtMs && Date.now() - rpc.last429AtMs < 60_000)
      reasons.push("RPC rate limit was hit within the last 60 seconds");
    if (rpc.queueDepth > rpc.maxRequestsPerSecond * 2)
      reasons.push("RPC queue is backlogged");
    return { canArm: reasons.length === 0, reasons };
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
    evidence: { onChain: {}, rugcheck: {} },
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

function buyValueUsd(
  intent: OrderIntent,
  result: ExecutionResult,
): number | undefined {
  const nativeValue = solDeltaUsd(result);
  if (nativeValue != null && nativeValue < 0) return Math.abs(nativeValue);
  return intent.spendUsdCents == null ? undefined : intent.spendUsdCents / 100;
}

function sellProceedsUsd(
  position: Position,
  result: ExecutionResult,
  state: MintState,
  soldFraction: number,
): number | null {
  const nativeValue = solDeltaUsd(result);
  if (nativeValue != null && nativeValue > 0) return nativeValue;
  if (result.mode !== "shadow" || position.entryValueUsd == null) return null;
  return (
    position.entryValueUsd *
    soldFraction *
    (state.currentMarketCapUsd / position.entryMarketCapUsd)
  );
}

function executionFeeUsd(result: ExecutionResult): number | null {
  if (result.feeLamports == null || result.observedSolUsd == null) return null;
  return (
    (Number(BigInt(result.feeLamports)) / 1_000_000_000) * result.observedSolUsd
  );
}

function solDeltaUsd(result: ExecutionResult): number | null {
  if (result.actualSolDeltaLamports == null || result.observedSolUsd == null)
    return null;
  return (
    (Number(BigInt(result.actualSolDeltaLamports)) / 1_000_000_000) *
    result.observedSolUsd
  );
}

function buySlippageBps(result: ExecutionResult): number | null {
  if (
    result.expectedTokenAmountBaseUnits == null ||
    result.actualTokenAmountBaseUnits == null
  )
    return null;
  return shortfallBps(
    BigInt(result.expectedTokenAmountBaseUnits),
    BigInt(result.actualTokenAmountBaseUnits),
  );
}

function sellSlippageBps(result: ExecutionResult): number | null {
  if (
    result.expectedTokenAmountBaseUnits == null ||
    result.actualSolDeltaLamports == null
  )
    return null;
  const actual = BigInt(result.actualSolDeltaLamports);
  if (actual <= 0n) return null;
  return shortfallBps(BigInt(result.expectedTokenAmountBaseUnits), actual);
}

function shortfallBps(expected: bigint, actual: bigint): number | null {
  if (expected <= 0n || actual < 0n) return null;
  return Number(((expected - actual) * 10_000_000n) / expected) / 1_000;
}

function bigintRatio(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n || numerator <= 0n) return 0;
  return Number((numerator * 1_000_000_000n) / denominator) / 1_000_000_000;
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
