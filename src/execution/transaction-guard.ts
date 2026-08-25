import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  type Connection,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
} from "@pump-fun/pump-sdk";

const ALLOWED_PROGRAMS = new Set([
  ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
  ComputeBudgetProgram.programId.toBase58(),
  PUMP_AMM_PROGRAM_ID.toBase58(),
  PUMP_FEE_PROGRAM_ID.toBase58(),
  PUMP_PROGRAM_ID.toBase58(),
  SystemProgram.programId.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
  TOKEN_PROGRAM_ID.toBase58(),
]);

export async function validateBuiltTransaction(input: {
  connection: Connection;
  expectedMint: string;
  expectedWallet: string;
  transactionBase64: string;
}): Promise<VersionedTransaction> {
  const transaction = VersionedTransaction.deserialize(
    Buffer.from(input.transactionBase64, "base64"),
  );
  const payer = transaction.message.staticAccountKeys[0]?.toBase58();
  if (payer !== input.expectedWallet)
    throw new Error(
      `transaction payer ${payer ?? "missing"} does not match expected wallet`,
    );

  const lookupAccounts = await Promise.all(
    transaction.message.addressTableLookups.map(async (lookup) => {
      const response = await input.connection.getAddressLookupTable(
        lookup.accountKey,
      );
      if (!response.value)
        throw new Error(
          `address lookup table ${lookup.accountKey.toBase58()} is missing`,
        );
      return response.value;
    }),
  );
  const keys = transaction.message.getAccountKeys({
    addressLookupTableAccounts: lookupAccounts as AddressLookupTableAccount[],
  });
  const allKeys: PublicKey[] = [];
  for (let index = 0; index < keys.length; index += 1)
    allKeys.push(keys.get(index)!);
  if (!allKeys.some((key) => key.toBase58() === input.expectedMint))
    throw new Error("transaction does not reference the intended mint");

  for (const instruction of transaction.message.compiledInstructions) {
    const program = keys.get(instruction.programIdIndex)?.toBase58();
    if (!program || !ALLOWED_PROGRAMS.has(program))
      throw new Error(
        `transaction invokes unapproved program ${program ?? "unknown"}`,
      );
  }
  return transaction;
}

export async function validateConfirmedSignature(input: {
  connection: Connection;
  expectedMint: string;
  expectedWallet: string;
  signature: string;
}): Promise<ParsedTransactionWithMeta> {
  let transaction: ParsedTransactionWithMeta | null = null;
  for (let attempt = 0; attempt < 4 && !transaction; attempt += 1) {
    transaction = await input.connection.getParsedTransaction(input.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!transaction && attempt < 3)
      await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!transaction || transaction.meta?.err)
    throw new Error("confirmed transaction is missing or failed");
  if (transaction.transaction.signatures[0] !== input.signature)
    throw new Error("signature is not the transaction's primary signature");

  const keys = transaction.transaction.message.accountKeys;
  const payer = keys[0];
  if (!payer?.signer || payer.pubkey.toBase58() !== input.expectedWallet) {
    throw new Error(
      "confirmed transaction payer does not match the expected wallet",
    );
  }
  if (!keys.some((key) => key.pubkey.toBase58() === input.expectedMint)) {
    throw new Error(
      "confirmed transaction does not reference the intended mint",
    );
  }

  const instructions = [
    ...transaction.transaction.message.instructions,
    ...(transaction.meta?.innerInstructions ?? []).flatMap(
      (group) => group.instructions,
    ),
  ];
  for (const instruction of instructions) {
    const program = instruction.programId.toBase58();
    if (!ALLOWED_PROGRAMS.has(program))
      throw new Error(
        `confirmed transaction invokes unapproved program ${program}`,
      );
  }
  return transaction;
}
