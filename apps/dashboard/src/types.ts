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

export interface Snapshot {
  armedUntilMs: number | null;
  candidates: MintState[];
  events: DeskEvent[];
  health: Record<string, { detail: string; status: string }>;
  killSwitch: boolean;
  mode: "shadow" | "manual" | "live";
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
