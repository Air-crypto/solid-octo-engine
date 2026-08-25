import { readFileSync, statSync } from "node:fs";
import {
  Keypair,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import type {
  DeskMode,
  ExecutionResult,
  OrderIntent,
} from "../domain/types.js";
import type { ControlPlane } from "../core/control.js";
import type {
  ExecutionContext,
  Executor,
  TransactionBuilder,
} from "./types.js";
import { tokenDeltaFromTransaction } from "./token-balance.js";
import {
  validateBuiltTransaction,
  validateConfirmedSignature,
} from "./transaction-guard.js";

abstract class BaseExecutor implements Executor {
  constructor(private readonly clock: () => number = Date.now) {}

  abstract readonly wallet: string;
  abstract execute(
    intent: OrderIntent,
    context: ExecutionContext,
  ): Promise<ExecutionResult>;

  protected validateIntent(
    intent: OrderIntent,
    context: ExecutionContext,
  ): void {
    if (this.clock() >= intent.expiresAtMs) throw new Error("intent expired");
    if (intent.mint !== context.mintState.mint)
      throw new Error("intent mint does not match candidate");
    if (
      intent.riskSnapshotHash !== context.riskReport.rawHash ||
      !context.riskReport.passed
    )
      throw new Error("risk snapshot is invalid or failed");
    if (intent.wallet !== this.wallet)
      throw new Error("intent wallet mismatch");
  }
}

export class ShadowExecutor extends BaseExecutor {
  readonly wallet: string;

  constructor(
    wallet: string,
    private readonly builder?: TransactionBuilder,
    clock: () => number = Date.now,
  ) {
    super(clock);
    this.wallet = wallet;
  }

  async execute(
    intent: OrderIntent,
    context: ExecutionContext,
  ): Promise<ExecutionResult> {
    this.validateIntent(intent, context);
    let expectedTokenAmountBaseUnits: string | undefined;
    if (this.builder) {
      const built =
        intent.side === "buy"
          ? await this.builder.buildBuy(intent)
          : await this.builder.buildSell(intent);
      expectedTokenAmountBaseUnits = built.expectedOutAmountBaseUnits;
    }
    return {
      confirmedAtMs: context.mintState.lastObservedAtMs,
      expectedTokenAmountBaseUnits:
        expectedTokenAmountBaseUnits ?? approximateOut(intent, context),
      intentId: intent.id,
      mode: "shadow",
      status: "paper_filled",
    };
  }
}

export class ManualPhantomExecutor extends BaseExecutor {
  readonly wallet: string;

  constructor(
    wallet: string,
    private readonly builder: TransactionBuilder,
    private readonly connection: Connection,
  ) {
    super();
    this.wallet = wallet;
  }

  async execute(
    intent: OrderIntent,
    context: ExecutionContext,
  ): Promise<ExecutionResult> {
    this.validateIntent(intent, context);
    const built =
      intent.side === "buy"
        ? await this.builder.buildBuy(intent)
        : await this.builder.buildSell(intent);
    await validateBuiltTransaction({
      connection: this.connection,
      expectedMint: intent.mint,
      expectedWallet: this.wallet,
      transactionBase64: built.transactionBase64,
    });
    return {
      expectedTokenAmountBaseUnits: built.expectedOutAmountBaseUnits,
      intentId: intent.id,
      mode: "manual",
      status: "awaiting_manual_signature",
      transactionBase64: built.transactionBase64,
    };
  }
}

export class LocalKeypairExecutor extends BaseExecutor {
  readonly wallet: string;
  private readonly keypair: Keypair;

  constructor(
    keypairPath: string,
    expectedWallet: string,
    private readonly builder: TransactionBuilder,
    private readonly connection: Connection,
    private readonly control: ControlPlane,
  ) {
    super();
    const mode = statSync(keypairPath).mode & 0o777;
    if ((mode & 0o077) !== 0)
      throw new Error(
        "execution keypair file must not be readable by group or others",
      );
    const secret = JSON.parse(readFileSync(keypairPath, "utf8")) as number[];
    this.keypair = Keypair.fromSecretKey(Uint8Array.from(secret));
    this.wallet = this.keypair.publicKey.toBase58();
    if (this.wallet !== expectedWallet)
      throw new Error(
        "execution keypair does not match EXPECTED_SIGNER_PUBLIC_KEY",
      );
  }

  async execute(
    intent: OrderIntent,
    context: ExecutionContext,
  ): Promise<ExecutionResult> {
    this.validateIntent(intent, context);
    if (intent.side === "buy") {
      const control = this.control.canExecute();
      if (!control.allowed) throw new Error(control.reason);
    }
    const built =
      intent.side === "buy"
        ? await this.builder.buildBuy(intent)
        : await this.builder.buildSell(intent);
    const transaction = await validateBuiltTransaction({
      connection: this.connection,
      expectedMint: intent.mint,
      expectedWallet: this.wallet,
      transactionBase64: built.transactionBase64,
    });
    this.recheckBuyControls(intent);
    transaction.sign([this.keypair]);
    const simulation = await this.connection.simulateTransaction(transaction, {
      commitment: "confirmed",
      sigVerify: true,
    });
    if (simulation.value.err)
      throw new Error(
        `transaction simulation failed: ${JSON.stringify(simulation.value.err)}`,
      );
    if (Date.now() >= intent.expiresAtMs)
      throw new Error("intent expired before broadcast");
    this.recheckBuyControls(intent);
    const signature = await this.connection.sendRawTransaction(
      transaction.serialize(),
      { maxRetries: 2, preflightCommitment: "confirmed", skipPreflight: false },
    );
    const confirmation = await this.connection.confirmTransaction(
      signature,
      "confirmed",
    );
    if (confirmation.value.err)
      throw new Error(
        `transaction failed: ${JSON.stringify(confirmation.value.err)}`,
      );
    const confirmedTransaction = await validateConfirmedSignature({
      connection: this.connection,
      expectedMint: intent.mint,
      expectedWallet: this.wallet,
      signature,
    });
    const actualTokenAmountBaseUnits = tokenDeltaFromTransaction({
      mint: intent.mint,
      side: intent.side,
      transaction: confirmedTransaction,
      wallet: this.wallet,
    }).toString();
    return {
      actualTokenAmountBaseUnits,
      confirmedAtMs: Date.now(),
      expectedTokenAmountBaseUnits: built.expectedOutAmountBaseUnits,
      intentId: intent.id,
      mode: "live",
      signature,
      status: "confirmed",
    };
  }

  private recheckBuyControls(intent: OrderIntent): void {
    if (intent.side !== "buy") return;
    const control = this.control.canExecute();
    if (!control.allowed) throw new Error(control.reason);
  }
}

export function buildExecutor(input: {
  builder: TransactionBuilder;
  connection: Connection;
  control: ControlPlane;
  expectedWallet?: string;
  keypairPath?: string;
  mode: DeskMode;
}): Executor {
  const wallet = input.expectedWallet ?? "SHADOW_WALLET_NOT_CONFIGURED";
  if (input.mode === "shadow") return new ShadowExecutor(wallet);
  if (input.mode === "manual") {
    if (!input.expectedWallet)
      throw new Error("manual mode requires EXPECTED_SIGNER_PUBLIC_KEY");
    return new ManualPhantomExecutor(
      input.expectedWallet,
      input.builder,
      input.connection,
    );
  }
  if (!input.expectedWallet || !input.keypairPath)
    throw new Error("live mode signer configuration is incomplete");
  return new LocalKeypairExecutor(
    input.keypairPath,
    input.expectedWallet,
    input.builder,
    input.connection,
    input.control,
  );
}

function approximateOut(
  intent: OrderIntent,
  context: ExecutionContext,
): string {
  if (intent.side === "sell") return intent.maxLamports;
  const sol = BigInt(context.mintState.virtualSolReservesLamports);
  const tokens = BigInt(context.mintState.virtualTokenReservesBaseUnits);
  const input = BigInt(intent.maxLamports);
  if (sol <= 0n || tokens <= 0n) return "0";
  return ((input * tokens) / (sol + input)).toString();
}
