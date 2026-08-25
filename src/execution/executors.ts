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
  BuiltTransaction,
  ExecutionContext,
  Executor,
  TransactionBuilder,
} from "./types.js";
import {
  ExecutionError,
  asExecutionError,
  describePumpSimulationError,
} from "./types.js";
import {
  feeLamportsFromTransaction,
  nativeSolDeltaFromTransaction,
  tokenDeltaFromTransaction,
} from "./token-balance.js";
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
    if (this.clock() >= intent.expiresAtMs)
      throw new ExecutionError("intent expired", "intent", false, false);
    if (intent.mint !== context.mintState.mint)
      throw new ExecutionError(
        "intent mint does not match candidate",
        "validation",
        false,
        false,
      );
    if (
      intent.riskSnapshotHash !== context.riskReport.rawHash ||
      !context.riskReport.passed
    )
      throw new ExecutionError(
        "risk snapshot is invalid or failed",
        "validation",
        false,
        false,
      );
    if (intent.wallet !== this.wallet)
      throw new ExecutionError(
        "intent wallet mismatch",
        "validation",
        false,
        false,
      );
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
      let built: BuiltTransaction;
      try {
        built =
          intent.side === "buy"
            ? await this.builder.buildBuy(intent)
            : await this.builder.buildSell(intent);
      } catch (error) {
        throw asExecutionError(error, "build", true, false);
      }
      expectedTokenAmountBaseUnits = built.expectedOutAmountBaseUnits;
    }
    return {
      confirmedAtMs: context.mintState.lastObservedAtMs,
      expectedTokenAmountBaseUnits:
        expectedTokenAmountBaseUnits ?? approximateOut(intent, context),
      intentId: intent.id,
      mode: "shadow",
      observedSolUsd: context.solUsd,
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
    let built: BuiltTransaction;
    try {
      built =
        intent.side === "buy"
          ? await this.builder.buildBuy(intent)
          : await this.builder.buildSell(intent);
    } catch (error) {
      throw asExecutionError(error, "build", true, false);
    }
    try {
      await validateBuiltTransaction({
        connection: this.connection,
        expectedMint: intent.mint,
        expectedWallet: this.wallet,
        transactionBase64: built.transactionBase64,
      });
    } catch (error) {
      throw asExecutionError(error, "validation", false, false);
    }
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
      if (!control.allowed)
        throw new ExecutionError(control.reason, "control", false, false);
    }
    let built: BuiltTransaction;
    try {
      built =
        intent.side === "buy"
          ? await this.builder.buildBuy(intent)
          : await this.builder.buildSell(intent);
    } catch (error) {
      throw asExecutionError(error, "build", true, false);
    }
    let transaction: VersionedTransaction;
    try {
      transaction = await validateBuiltTransaction({
        connection: this.connection,
        expectedMint: intent.mint,
        expectedWallet: this.wallet,
        transactionBase64: built.transactionBase64,
      });
    } catch (error) {
      throw asExecutionError(error, "validation", false, false);
    }
    this.recheckBuyControls(intent);
    transaction.sign([this.keypair]);
    let simulation;
    try {
      simulation = await this.connection.simulateTransaction(transaction, {
        commitment: "confirmed",
        sigVerify: true,
      });
    } catch (error) {
      throw asExecutionError(error, "simulation", true, false);
    }
    if (simulation.value.err)
      throw new ExecutionError(
        describePumpSimulationError(simulation.value.err, intent.side),
        "simulation",
        true,
        false,
      );
    if (Date.now() >= intent.expiresAtMs)
      throw new ExecutionError(
        "intent expired before broadcast",
        "intent",
        true,
        false,
      );
    this.recheckBuyControls(intent);
    let signature: string;
    try {
      signature = await this.connection.sendRawTransaction(
        transaction.serialize(),
        {
          maxRetries: 2,
          preflightCommitment: "confirmed",
          skipPreflight: false,
        },
      );
    } catch (error) {
      throw asExecutionError(error, "broadcast", false, true);
    }
    let confirmation;
    try {
      confirmation = await this.connection.confirmTransaction(
        signature,
        "confirmed",
      );
    } catch (error) {
      throw asExecutionError(error, "confirmation", false, true);
    }
    if (confirmation.value.err)
      throw new ExecutionError(
        "transaction failed: " + JSON.stringify(confirmation.value.err),
        "confirmation",
        false,
        true,
      );
    let confirmedTransaction;
    try {
      confirmedTransaction = await validateConfirmedSignature({
        connection: this.connection,
        expectedMint: intent.mint,
        expectedWallet: this.wallet,
        signature,
      });
    } catch (error) {
      throw asExecutionError(error, "reconciliation", false, true);
    }
    let actualTokenAmountBaseUnits: string;
    let actualSolDeltaLamports: string;
    let feeLamports: string;
    try {
      actualTokenAmountBaseUnits = tokenDeltaFromTransaction({
        mint: intent.mint,
        side: intent.side,
        transaction: confirmedTransaction,
        wallet: this.wallet,
      }).toString();
      actualSolDeltaLamports = nativeSolDeltaFromTransaction({
        transaction: confirmedTransaction,
        wallet: this.wallet,
      }).toString();
      feeLamports = feeLamportsFromTransaction(confirmedTransaction).toString();
    } catch (error) {
      throw asExecutionError(error, "reconciliation", false, true);
    }
    return {
      actualSolDeltaLamports,
      actualTokenAmountBaseUnits,
      confirmedAtMs: Date.now(),
      expectedTokenAmountBaseUnits: built.expectedOutAmountBaseUnits,
      feeLamports,
      intentId: intent.id,
      mode: "live",
      observedSolUsd: context.solUsd,
      signature,
      status: "confirmed",
    };
  }

  private recheckBuyControls(intent: OrderIntent): void {
    if (intent.side !== "buy") return;
    const control = this.control.canExecute();
    if (!control.allowed)
      throw new ExecutionError(control.reason, "control", false, false);
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
