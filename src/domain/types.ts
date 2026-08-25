export type DeskMode = "shadow" | "manual" | "live";

export type PumpEvent = PumpCreateEvent | PumpTradeEvent;

export interface PumpEventBase {
  blockTimeMs: number;
  kind: "create" | "trade";
  mint: string;
  observedAtMs: number;
  signature: string;
  slot: number;
}

export interface PumpCreateEvent extends PumpEventBase {
  bondingCurve: string;
  creator: string;
  isCashbackEnabled: boolean;
  isMayhemMode: boolean;
  kind: "create";
  name: string;
  quoteMint: string;
  symbol: string;
  tokenProgram: string;
  tokenTotalSupplyBaseUnits: string;
  uri: string;
  virtualSolReservesLamports: string;
  virtualTokenReservesBaseUnits: string;
}

export interface PumpTradeEvent extends PumpEventBase {
  creator: string;
  isBuy: boolean;
  kind: "trade";
  quoteAmountBaseUnits: string;
  solAmountLamports: string;
  tokenAmountBaseUnits: string;
  trader: string;
  virtualSolReservesLamports: string;
  virtualTokenReservesBaseUnits: string;
}

export interface PriceMark {
  observedAtMs: number;
  priceUsd: number;
  sources: Array<{ name: string; priceUsd: number }>;
  spreadPct: number;
}

export interface MintState {
  bondingCurve: string;
  createdAtMs: number;
  creationSignature: string;
  creationSlot: number;
  creator: string;
  currentMarketCapUsd: number;
  highWaterMarketCapUsd: number;
  lastEventSignature: string;
  lastObservedAtMs: number;
  lastSlot: number;
  mint: string;
  name: string;
  phase: MintPhase;
  previousMarketCapUsd: number;
  quoteMint: string;
  symbol: string;
  tokenProgram: string;
  tokenTotalSupplyBaseUnits: string;
  virtualSolReservesLamports: string;
  virtualTokenReservesBaseUnits: string;
}

export type MintPhase =
  | "seen"
  | "eligible"
  | "risk_pending"
  | "killed"
  | "ready"
  | "intent_created"
  | "sent"
  | "confirmed"
  | "exiting"
  | "closed";

export interface PolicyConfig {
  armLeaseMaxMs: number;
  defaultSpendUsdCents: number;
  entryMarketCapUsd: number;
  exitIntentTtlMs: number;
  exitMaxAttempts: number;
  exitRetryCooldownMs: number;
  exitRetryDelayMs: number;
  holdRiskFailureKillThreshold: number;
  holdRiskRetryDelayMs: number;
  holdRiskTimeoutMs: number;
  intentTtlMs: number;
  maxAgeMs: number;
  maxCreatorHolderPct: number;
  maxDailySpendUsdCents: number;
  maxOpenPositions: number;
  maxOracleSpreadPct: number;
  maxPriceAgeMs: number;
  maxSlippageBps: number;
  maxSpendUsdCents: number;
  maxTopHolderPct: number;
  minSpendUsdCents: number;
  requireFreezeAuthorityRevoked: boolean;
  requireInsidersZero: boolean;
  requireMintAuthorityRevoked: boolean;
  requireOfficialBondingCurve: boolean;
  requireRugcheck: boolean;
  riskFailureKillThreshold: number;
  riskReadinessRetries: number;
  riskReadinessRetryDelayMs: number;
  riskTimeoutMs: number;
  spikeCeilingMarketCapUsd: number;
  stopLossPct: number;
  takeProfitPct: number;
  takeProfitSellFraction: number;
  timeStopMs: number;
  trailingStopPct: number;
  version: number;
}

export interface PolicyDecision {
  eligible: boolean;
  reasons: string[];
  snapshotHash: string;
}

export type RiskCheckStatus = "pass" | "fail" | "unknown";

export interface RiskCheck {
  detail: string;
  name: string;
  status: RiskCheckStatus;
}

export interface RiskReport {
  checkedAtMs: number;
  checks: RiskCheck[];
  evidence: {
    onChain: Record<string, unknown>;
    rugcheck: Record<string, unknown>;
  };
  mint: string;
  passed: boolean;
  rawHash: string;
  sourceLatencyMs: Record<string, number>;
  tokenProgram: string;
}

export interface OrderIntent {
  createdAtMs: number;
  expiresAtMs: number;
  id: string;
  maxLamports: string;
  maxSlippageBps: number;
  mint: string;
  policySnapshotHash: string;
  riskSnapshotHash: string;
  side: "buy" | "sell";
  spendUsdCents?: number;
  tokenAmountBaseUnits?: string;
  wallet: string;
}

export interface ExecutionResult {
  actualSolDeltaLamports?: string;
  actualTokenAmountBaseUnits?: string;
  confirmedAtMs?: number;
  expectedTokenAmountBaseUnits?: string;
  feeLamports?: string;
  intentId: string;
  mode: DeskMode;
  observedSolUsd?: number;
  signature?: string;
  status:
    | "paper_filled"
    | "awaiting_manual_signature"
    | "submitted"
    | "confirmed"
    | "rejected";
  transactionBase64?: string;
}

export interface PositionExitFill {
  atMs: number;
  costBasisUsd: number;
  feeUsd: number | null;
  marketCapUsd: number;
  proceedsUsd: number;
  realizedPnlUsd: number;
  reason: string;
  signature?: string;
  slippageBps: number | null;
  tokenAmountBaseUnits: string;
}

export interface Position {
  closedAtMs?: number;
  entryFeeUsd?: number | null;
  entryMarketCapUsd: number;
  entrySolLamports: string;
  entrySlippageBps?: number | null;
  entryTimeMs: number;
  entryValueUsd?: number;
  exitFills?: PositionExitFill[];
  feesUsd?: number;
  highWaterMarketCapUsd: number;
  id: string;
  lastMarketCapUsd?: number;
  mint: string;
  mode: DeskMode;
  realizedPnlUsd?: number;
  realizedProceedsUsd?: number;
  remainingTokenBaseUnits: string;
  status: "open" | "closing" | "closed";
  tokenAmountBaseUnits: string;
  wallet: string;
}

export interface PortfolioPosition {
  closedAtMs: number | null;
  costBasisUsd: number | null;
  currentMarketCapUsd: number | null;
  currentValueUsd: number | null;
  entryMarketCapUsd: number;
  entryTimeMs: number;
  entryValueUsd: number | null;
  feesUsd: number | null;
  id: string;
  legacy: boolean;
  mint: string;
  mode: DeskMode;
  realizedPnlUsd: number | null;
  returnPct: number | null;
  slippageBps: number | null;
  status: Position["status"];
  unrealizedPnlUsd: number | null;
  wallet: string;
}

export interface PortfolioModeSummary {
  capitalDeployedUsd: number;
  closedPositions: number;
  dailyPnlUsd: number;
  feesUsd: number;
  legacyPositions: number;
  mode: DeskMode;
  netWorthUsd: number | null;
  openPositionValueUsd: number;
  openPositions: number;
  realizedPnlUsd: number;
  sessionPnlUsd: number;
  totalPnlUsd: number;
  totalReturnPct: number | null;
  unrealizedPnlUsd: number;
  wallet: string;
  walletSol: number | null;
  walletValueUsd: number | null;
}

export interface PortfolioMark {
  atMs: number;
  mode: DeskMode;
  netWorthUsd: number | null;
  realizedPnlUsd: number;
  totalPnlUsd: number;
  unrealizedPnlUsd: number;
  wallet: string;
}

export interface PortfolioSnapshot {
  generatedAtMs: number;
  history: Record<DeskMode, PortfolioMark[]>;
  positions: PortfolioPosition[];
  solUsd: number | null;
  solUsdObservedAtMs: number | null;
  summaries: Record<DeskMode, PortfolioModeSummary>;
}

export type ExitReason =
  "take_profit" | "stop_loss" | "trailing_stop" | "time_stop" | "kill_switch";

export interface ExitDecision {
  fraction: number;
  reason: ExitReason;
  triggered: boolean;
}

export interface DeskEvent<T = unknown> {
  atMs: number;
  data: T;
  id: string;
  role:
    | "scout"
    | "sniper"
    | "risk"
    | "rug"
    | "whale"
    | "exit"
    | "finance"
    | "head"
    | "system";
  type: string;
}

export interface DeskSnapshot {
  armedUntilMs: number | null;
  candidates: MintState[];
  events: DeskEvent[];
  health: Record<string, ComponentHealth>;
  killSwitch: boolean;
  mode: DeskMode;
  portfolio: PortfolioSnapshot;
  positions: Position[];
  readiness: ReadinessSnapshot;
  rpc: {
    byMethod: Record<string, number>;
    failed: number;
    last429AtMs: number | null;
    maxRequestsPerSecond: number;
    queueDepth: number;
    rateLimited: number;
    total: number;
  };
}

export interface ReadinessSnapshot {
  canArm: boolean;
  reasons: string[];
}

export interface ComponentHealth {
  detail: string;
  lastOkAtMs: number | null;
  status: "ok" | "degraded" | "down" | "disabled";
}
