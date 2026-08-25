const LAMPORTS_PER_SOL = 1_000_000_000;
const TOKEN_BASE_UNITS = 1_000_000;

export function bondingCurveMarketCapUsd(input: {
  solUsd: number;
  tokenTotalSupplyBaseUnits: string;
  virtualSolReservesLamports: string;
  virtualTokenReservesBaseUnits: string;
}): number {
  const virtualSol =
    Number(BigInt(input.virtualSolReservesLamports)) / LAMPORTS_PER_SOL;
  const virtualTokens =
    Number(BigInt(input.virtualTokenReservesBaseUnits)) / TOKEN_BASE_UNITS;
  const supply =
    Number(BigInt(input.tokenTotalSupplyBaseUnits)) / TOKEN_BASE_UNITS;
  if (
    !Number.isFinite(virtualSol) ||
    !Number.isFinite(virtualTokens) ||
    virtualTokens <= 0 ||
    supply <= 0
  ) {
    throw new Error("invalid bonding curve reserves");
  }
  return (virtualSol / virtualTokens) * supply * input.solUsd;
}

export function usdCentsToLamports(usdCents: number, solUsd: number): bigint {
  if (
    !Number.isInteger(usdCents) ||
    usdCents <= 0 ||
    !Number.isFinite(solUsd) ||
    solUsd <= 0
  ) {
    throw new Error("invalid spend or SOL/USD mark");
  }
  return BigInt(Math.floor((usdCents / 100 / solUsd) * LAMPORTS_PER_SOL));
}
