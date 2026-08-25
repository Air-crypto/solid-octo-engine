export interface DeskEvent {
  atMs: number;
  data: unknown;
  id: string;
  role: Role;
  type: string;
}

export type Role =
  | "scout"
  | "sniper"
  | "risk"
  | "rug"
  | "whale"
  | "exit"
  | "finance"
  | "head"
  | "system";

export interface MintState {
  createdAtMs: number;
  currentMarketCapUsd: number;
  highWaterMarketCapUsd: number;
  mint: string;
  name: string;
  phase: string;
  symbol: string;
}

export interface Position {
  entryMarketCapUsd: number;
  entryTimeMs: number;
  highWaterMarketCapUsd: number;
  id: string;
  mint: string;
  mode: string;
  remainingTokenBaseUnits: string;
  status: string;
}

export type DeskMode = "shadow" | "manual" | "live";

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
  status: string;
  unrealizedPnlUsd: number | null;
  wallet: string;
}

export interface PortfolioSummary {
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

export interface Snapshot {
  armedUntilMs: number | null;
  candidates: MintState[];
  events: DeskEvent[];
  health: Record<string, { detail: string; status: string }>;
  killSwitch: boolean;
  mode: DeskMode;
  portfolio: {
    generatedAtMs: number;
    history: Record<DeskMode, PortfolioMark[]>;
    positions: PortfolioPosition[];
    solUsd: number | null;
    solUsdObservedAtMs: number | null;
    summaries: Record<DeskMode, PortfolioSummary>;
  };
  positions: Position[];
  readiness: { canArm: boolean; reasons: string[] };
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

export interface PublicConfig {
  expectedSignerPublicKey: string | null;
  mode: Snapshot["mode"];
  policy: Record<string, number | boolean>;
}

export interface ManualPending {
  execution: {
    expectedTokenAmountBaseUnits?: string;
    intentId: string;
    transactionBase64: string;
  };
  intent: {
    maxLamports: string;
    mint: string;
    side: "buy" | "sell";
    spendUsdCents?: number;
    tokenAmountBaseUnits?: string;
    wallet: string;
  };
}

export interface PhantomProvider {
  connect(): Promise<{ publicKey: { toBase58(): string } }>;
  isPhantom?: boolean;
  publicKey?: { toBase58(): string };
  signAndSendTransaction(
    transaction: unknown,
  ): Promise<{ signature: string } | string>;
}

declare global {
  interface Window {
    phantom?: { solana?: PhantomProvider };
  }
}
