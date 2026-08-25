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

function sumOwnerMint(
  balances: NonNullable<ParsedTransactionWithMeta["meta"]>["preTokenBalances"],
  wallet: string,
  mint: string,
): bigint {
  return (balances ?? [])
    .filter((balance) => balance.owner === wallet && balance.mint === mint)
    .reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n);
}
