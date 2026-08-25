import type {
  DeskMode,
  MintState,
  PortfolioModeSummary,
  PortfolioPosition,
  Position,
  PriceMark,
} from "../domain/types.js";

const MODES: DeskMode[] = ["shadow", "manual", "live"];

export function buildPortfolio(input: {
  activeMode: DeskMode;
  nowMs: number;
  positions: Position[];
  sessionStartedAtMs: number;
  solMark: PriceMark | null;
  stateForMint: (mint: string) => MintState | undefined;
  wallet: string;
  walletBalanceLamports: bigint | null;
}): {
  positions: PortfolioPosition[];
  summaries: Record<DeskMode, PortfolioModeSummary>;
} {
  const positions = input.positions.map((position) =>
    portfolioPosition(position, input.stateForMint(position.mint)),
  );
  return {
    positions,
    summaries: Object.fromEntries(
      MODES.map((mode) => [
        mode,
        summarizeMode(mode, positions, input.positions, input),
      ]),
    ) as Record<DeskMode, PortfolioModeSummary>,
  };
}

function portfolioPosition(
  position: Position,
  state: MintState | undefined,
): PortfolioPosition {
  const entryValueUsd = finiteOrNull(position.entryValueUsd);
  const currentMarketCapUsd = finiteOrNull(
    state?.currentMarketCapUsd ?? position.lastMarketCapUsd,
  );
  const originalTokens = BigInt(position.tokenAmountBaseUnits);
  const remainingTokens = BigInt(position.remainingTokenBaseUnits);
  const remainingFraction = ratio(remainingTokens, originalTokens);
  const costBasisUsd =
    entryValueUsd == null ? null : entryValueUsd * remainingFraction;
  const currentValueUsd =
    position.status === "closed"
      ? entryValueUsd == null
        ? null
        : 0
      : entryValueUsd == null || currentMarketCapUsd == null
        ? null
        : entryValueUsd *
          remainingFraction *
          (currentMarketCapUsd / position.entryMarketCapUsd);
  const unrealizedPnlUsd =
    costBasisUsd == null || currentValueUsd == null
      ? null
      : currentValueUsd - costBasisUsd;
  const realizedPnlUsd = finiteOrNull(position.realizedPnlUsd);
  const totalKnownPnl =
    realizedPnlUsd == null && unrealizedPnlUsd == null
      ? null
      : (realizedPnlUsd ?? 0) + (unrealizedPnlUsd ?? 0);
  const slippage = [
    position.entrySlippageBps,
    ...(position.exitFills ?? []).map((fill) => fill.slippageBps),
  ].filter((value): value is number => value != null && Number.isFinite(value));
  return {
    closedAtMs: position.closedAtMs ?? null,
    costBasisUsd,
    currentMarketCapUsd,
    currentValueUsd,
    entryMarketCapUsd: position.entryMarketCapUsd,
    entryTimeMs: position.entryTimeMs,
    entryValueUsd,
    feesUsd: finiteOrNull(position.feesUsd),
    id: position.id,
    legacy: entryValueUsd == null,
    mint: position.mint,
    mode: position.mode,
    realizedPnlUsd,
    returnPct:
      totalKnownPnl == null || entryValueUsd == null || entryValueUsd <= 0
        ? null
        : (totalKnownPnl / entryValueUsd) * 100,
    slippageBps:
      slippage.length === 0
        ? null
        : slippage.reduce((sum, value) => sum + value, 0) / slippage.length,
    status: position.status,
    unrealizedPnlUsd,
    wallet: position.wallet,
  };
}

function summarizeMode(
  mode: DeskMode,
  views: PortfolioPosition[],
  raw: Position[],
  input: {
    activeMode: DeskMode;
    nowMs: number;
    sessionStartedAtMs: number;
    solMark: PriceMark | null;
    wallet: string;
    walletBalanceLamports: bigint | null;
  },
): PortfolioModeSummary {
  const positions = views.filter(
    (position) => position.mode === mode && position.wallet === input.wallet,
  );
  const rawPositions = raw.filter(
    (position) => position.mode === mode && position.wallet === input.wallet,
  );
  const realizedPnlUsd = sumKnown(positions, "realizedPnlUsd");
  const unrealizedPnlUsd = sumKnown(positions, "unrealizedPnlUsd");
  const capitalDeployedUsd = sumKnown(positions, "entryValueUsd");
  const feesUsd = sumKnown(positions, "feesUsd");
  const openPositionValueUsd = positions
    .filter((position) => position.status !== "closed")
    .reduce((sum, position) => sum + (position.currentValueUsd ?? 0), 0);
  const totalPnlUsd = realizedPnlUsd + unrealizedPnlUsd;
  const dayStart = new Date(input.nowMs);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dailyRealized = rawPositions.reduce(
    (sum, position) =>
      sum +
      (position.exitFills ?? [])
        .filter((fill) => fill.atMs >= dayStart.getTime())
        .reduce((fillSum, fill) => fillSum + fill.realizedPnlUsd, 0),
    0,
  );
  const sessionRealized = rawPositions.reduce(
    (sum, position) =>
      sum +
      (position.exitFills ?? [])
        .filter((fill) => fill.atMs >= input.sessionStartedAtMs)
        .reduce((fillSum, fill) => fillSum + fill.realizedPnlUsd, 0),
    0,
  );
  const dailyUnrealized = positions
    .filter(
      (position) =>
        position.status !== "closed" &&
        position.entryTimeMs >= dayStart.getTime(),
    )
    .reduce((sum, position) => sum + (position.unrealizedPnlUsd ?? 0), 0);
  const sessionUnrealized = positions
    .filter(
      (position) =>
        position.status !== "closed" &&
        position.entryTimeMs >= input.sessionStartedAtMs,
    )
    .reduce((sum, position) => sum + (position.unrealizedPnlUsd ?? 0), 0);
  const walletSol =
    mode === input.activeMode && input.walletBalanceLamports != null
      ? Number(input.walletBalanceLamports) / 1_000_000_000
      : null;
  const walletValueUsd =
    walletSol == null || input.solMark == null
      ? null
      : walletSol * input.solMark.priceUsd;
  return {
    capitalDeployedUsd,
    closedPositions: positions.filter(
      (position) => position.status === "closed",
    ).length,
    dailyPnlUsd: dailyRealized + dailyUnrealized,
    feesUsd,
    legacyPositions: positions.filter((position) => position.legacy).length,
    mode,
    netWorthUsd:
      walletValueUsd == null ? null : walletValueUsd + openPositionValueUsd,
    openPositionValueUsd,
    openPositions: positions.filter((position) => position.status !== "closed")
      .length,
    realizedPnlUsd,
    sessionPnlUsd: sessionRealized + sessionUnrealized,
    totalPnlUsd,
    totalReturnPct:
      capitalDeployedUsd > 0 ? (totalPnlUsd / capitalDeployedUsd) * 100 : null,
    unrealizedPnlUsd,
    wallet: input.wallet,
    walletSol,
    walletValueUsd,
  };
}

function ratio(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n || numerator <= 0n) return 0;
  return Number((numerator * 1_000_000_000n) / denominator) / 1_000_000_000;
}

function finiteOrNull(value: number | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

function sumKnown<
  K extends "entryValueUsd" | "feesUsd" | "realizedPnlUsd" | "unrealizedPnlUsd",
>(positions: PortfolioPosition[], key: K): number {
  return positions.reduce((sum, position) => sum + (position[key] ?? 0), 0);
}
