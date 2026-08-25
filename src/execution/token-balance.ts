import type { ParsedTransactionWithMeta } from "@solana/web3.js";

export function tokenBalanceDelta(
  side: "buy" | "sell",
  before: bigint,
  after: bigint,
): bigint {
  const delta = side === "buy" ? after - before : before - after;
  if (delta <= 0n)
    throw new Error(
      `confirmed ${side} did not produce a positive token balance delta`,
    );
  return delta;
}

export function tokenDeltaFromTransaction(input: {
  mint: string;
  side: "buy" | "sell";
  transaction: ParsedTransactionWithMeta;
  wallet: string;
}): bigint {
  const before = sumOwnerMint(
    input.transaction.meta?.preTokenBalances ?? [],
    input.wallet,
    input.mint,
  );
  const after = sumOwnerMint(
    input.transaction.meta?.postTokenBalances ?? [],
    input.wallet,
    input.mint,
  );
  return tokenBalanceDelta(input.side, before, after);
}

export function nativeSolDeltaFromTransaction(input: {
  transaction: ParsedTransactionWithMeta;
  wallet: string;
}): bigint {
  const meta = input.transaction.meta;
  if (!meta) throw new Error("confirmed transaction metadata is unavailable");
  const index = input.transaction.transaction.message.accountKeys.findIndex(
    ({ pubkey }) => pubkey.toBase58() === input.wallet,
  );
  if (index < 0) throw new Error("confirmed transaction omitted desk wallet");
  const before = meta.preBalances[index];
  const after = meta.postBalances[index];
  if (before == null || after == null)
    throw new Error("confirmed transaction omitted wallet SOL balances");
  return BigInt(after) - BigInt(before);
}

export function feeLamportsFromTransaction(
  transaction: ParsedTransactionWithMeta,
): bigint {
  const fee = transaction.meta?.fee;
  if (fee == null || !Number.isSafeInteger(fee) || fee < 0)
    throw new Error("confirmed transaction fee is unavailable");
  return BigInt(fee);
}

function sumOwnerMint(
  balances: NonNullable<ParsedTransactionWithMeta["meta"]>["preTokenBalances"],
  wallet: string,
  mint: string,
): bigint {
  return (balances ?? [])
    .filter((balance) => balance.owner === wallet && balance.mint === mint)
    .reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n);
}
