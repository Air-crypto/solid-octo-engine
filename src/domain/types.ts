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
  riskTimeoutMs: number;
  spikeCeilingMarketCapUsd: number;
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
  actualTokenAmountBaseUnits?: string;
  confirmedAtMs?: number;
  expectedTokenAmountBaseUnits?: string;
  intentId: string;
  mode: DeskMode;
  signature?: string;
  status:
    | "paper_filled"
    | "awaiting_manual_signature"
    | "submitted"
    | "confirmed"
    | "rejected";
  transactionBase64?: string;
}

export interface Position {
  entryMarketCapUsd: number;
  entrySolLamports: string;
  entryTimeMs: number;
  highWaterMarketCapUsd: number;
  id: string;
  mint: string;
  mode: DeskMode;
  remainingTokenBaseUnits: string;
  status: "open" | "closing" | "closed";
  tokenAmountBaseUnits: string;
  wallet: string;
}

export type ExitReason =
  "take_profit" | "trailing_stop" | "time_stop" | "kill_switch";

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
  positions: Position[];
}

export interface ComponentHealth {
  detail: string;
  lastOkAtMs: number | null;
  status: "ok" | "degraded" | "down" | "disabled";
}
