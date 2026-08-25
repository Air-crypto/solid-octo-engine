import type {
  ExecutionResult,
  MintState,
  OrderIntent,
  RiskReport,
} from "../domain/types.js";

export interface BuiltTransaction {
  expectedOutAmountBaseUnits: string;
  transactionBase64: string;
}

export interface TransactionBuilder {
  buildBuy(intent: OrderIntent): Promise<BuiltTransaction>;
  buildSell(intent: OrderIntent): Promise<BuiltTransaction>;
}

export interface ExecutionContext {
  mintState: MintState;
  riskReport: RiskReport;
  solUsd?: number;
}

export interface Executor {
  readonly wallet: string;
  execute(
    intent: OrderIntent,
    context: ExecutionContext,
  ): Promise<ExecutionResult>;
}

export type ExecutionStage =
  | "intent"
  | "control"
  | "build"
  | "validation"
  | "simulation"
  | "broadcast"
  | "confirmation"
  | "reconciliation";

export class ExecutionError extends Error {
  constructor(
    message: string,
    readonly stage: ExecutionStage,
    readonly safeToRetry: boolean,
    readonly broadcastPossible: boolean,
  ) {
    super(message);
    this.name = "ExecutionError";
  }
}

export function asExecutionError(
  error: unknown,
  stage: ExecutionStage,
  safeToRetry: boolean,
  broadcastPossible: boolean,
): ExecutionError {
  if (error instanceof ExecutionError) return error;
  return new ExecutionError(
    error instanceof Error ? error.message : String(error),
    stage,
    safeToRetry,
    broadcastPossible,
  );
}

export function describePumpSimulationError(
  error: unknown,
  side: "buy" | "sell",
): string {
  const encoded = JSON.stringify(error);
  if (side === "buy" && encoded.includes('"Custom":6002'))
    return "Pump 6002 TooMuchSolRequired: buy moved beyond the slippage cap";
  if (side === "sell" && encoded.includes('"Custom":6003'))
    return "Pump 6003 TooLittleSolReceived: sell moved beyond the slippage floor";
  return "transaction simulation failed: " + encoded;
}
