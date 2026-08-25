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
