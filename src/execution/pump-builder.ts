import { NATIVE_MINT } from "@solana/spl-token";
import type { BuiltTransaction, TransactionBuilder } from "./types.js";
import type { OrderIntent } from "../domain/types.js";

interface PumpSwapResponse {
  pumpMintInfo?: { expectedOutAmount?: string; hasGraduated?: boolean };
  transaction?: string;
}

export class PumpApiTransactionBuilder implements TransactionBuilder {
  constructor(
    private readonly endpoint = "https://fun-block.pump.fun/agents/swap",
  ) {}

  buildBuy(intent: OrderIntent): Promise<BuiltTransaction> {
    return this.build(
      intent,
      NATIVE_MINT.toBase58(),
      intent.mint,
      intent.maxLamports,
    );
  }

  buildSell(intent: OrderIntent): Promise<BuiltTransaction> {
    if (!intent.tokenAmountBaseUnits)
      throw new Error("sell intent requires tokenAmountBaseUnits");
    return this.build(
      intent,
      intent.mint,
      NATIVE_MINT.toBase58(),
      intent.tokenAmountBaseUnits,
    );
  }

  private async build(
    intent: OrderIntent,
    inputMint: string,
    outputMint: string,
    amount: string,
  ): Promise<BuiltTransaction> {
    if (Date.now() >= intent.expiresAtMs)
      throw new Error("intent expired before transaction build");
    const response = await fetch(this.endpoint, {
      body: JSON.stringify({
        amount,
        encoding: "base64",
        feePayer: intent.wallet,
        frontRunningProtection: false,
        inputMint,
        outputMint,
        slippagePct: intent.maxSlippageBps / 100,
        tipAmount: 0,
        user: intent.wallet,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok)
      throw new Error(`Pump transaction builder returned ${response.status}`);
    const body = (await response.json()) as PumpSwapResponse;
    if (!body.transaction || !body.pumpMintInfo?.expectedOutAmount)
      throw new Error("Pump transaction builder response is incomplete");
    return {
      expectedOutAmountBaseUnits: body.pumpMintInfo.expectedOutAmount,
      transactionBase64: body.transaction,
    };
  }
}
