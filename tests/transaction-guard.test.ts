import {
  Keypair,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import {
  tokenBalanceDelta,
  tokenDeltaFromTransaction,
} from "../src/execution/token-balance.js";
import {
  validateBuiltTransaction,
  validateConfirmedSignature,
} from "../src/execution/transaction-guard.js";

describe("transaction guard", () => {
  it("accepts an expected payer, mint, and allowlisted program", async () => {
    const payer = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const transaction = new VersionedTransaction(
      new TransactionMessage({
        instructions: [
          SystemProgram.transfer({
            fromPubkey: payer,
            lamports: 1,
            toPubkey: mint,
          }),
        ],
        payerKey: payer,
        recentBlockhash: Keypair.generate().publicKey.toBase58(),
      }).compileToV0Message(),
    );

    await expect(
      validateBuiltTransaction({
        connection: {} as Connection,
        expectedMint: mint.toBase58(),
        expectedWallet: payer.toBase58(),
        transactionBase64: Buffer.from(transaction.serialize()).toString(
          "base64",
        ),
      }),
    ).resolves.toBeInstanceOf(VersionedTransaction);
  });

  it("rejects a builder transaction that invokes an unapproved program", async () => {
    const payer = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const instruction = new TransactionInstruction({
      data: Buffer.alloc(0),
      keys: [{ isSigner: false, isWritable: false, pubkey: mint }],
      programId: Keypair.generate().publicKey,
    });
    const transaction = new VersionedTransaction(
      new TransactionMessage({
        instructions: [instruction],
        payerKey: payer,
        recentBlockhash: Keypair.generate().publicKey.toBase58(),
      }).compileToV0Message(),
    );

    await expect(
      validateBuiltTransaction({
        connection: {} as Connection,
        expectedMint: mint.toBase58(),
        expectedWallet: payer.toBase58(),
        transactionBase64: Buffer.from(transaction.serialize()).toString(
          "base64",
        ),
      }),
    ).rejects.toThrow("unapproved program");
  });

  it("verifies the on-chain wallet, mint, and program before accepting a manual fill", async () => {
    const payer = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const signature = "manual-signature";
    const getParsedTransaction = vi.fn(async () => ({
      meta: { err: null, innerInstructions: [] },
      transaction: {
        message: {
          accountKeys: [
            { pubkey: payer, signer: true, writable: true },
            { pubkey: mint, signer: false, writable: false },
          ],
          instructions: [{ programId: SystemProgram.programId }],
        },
        signatures: [signature],
      },
    }));

    await expect(
      validateConfirmedSignature({
        connection: { getParsedTransaction } as unknown as Connection,
        expectedMint: mint.toBase58(),
        expectedWallet: payer.toBase58(),
        signature,
      }),
    ).resolves.toMatchObject({ transaction: { signatures: [signature] } });
  });
});

describe("token balance reconciliation", () => {
  it("derives positive buy and sell fills and rejects a zero delta", () => {
    expect(tokenBalanceDelta("buy", 10n, 25n)).toBe(15n);
    expect(tokenBalanceDelta("sell", 25n, 4n)).toBe(21n);
    expect(() => tokenBalanceDelta("buy", 10n, 10n)).toThrow(
      "positive token balance delta",
    );
  });

  it("reconciles only the configured owner and mint from transaction metadata", () => {
    const transaction = {
      meta: {
        postTokenBalances: [
          { mint: "mint", owner: "wallet", uiTokenAmount: { amount: "125" } },
          { mint: "other", owner: "wallet", uiTokenAmount: { amount: "999" } },
        ],
        preTokenBalances: [
          { mint: "mint", owner: "wallet", uiTokenAmount: { amount: "25" } },
        ],
      },
    } as unknown as ParsedTransactionWithMeta;
    expect(
      tokenDeltaFromTransaction({
        mint: "mint",
        side: "buy",
        transaction,
        wallet: "wallet",
      }),
    ).toBe(100n);
  });
});
