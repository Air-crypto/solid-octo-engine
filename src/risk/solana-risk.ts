import { PublicKey, type Connection } from "@solana/web3.js";
import { PUMP_PROGRAM_ID, bondingCurvePda } from "@pump-fun/pump-sdk";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import type {
  MintState,
  PolicyConfig,
  RiskCheck,
  RiskReport,
} from "../domain/types.js";
import { stableHash } from "../core/hash.js";
import type { RiskProvider } from "./types.js";

interface OnChainSnapshot {
  contextSlot: number;
  creatorAmount: bigint;
  curveOwner: string;
  curveTokenAccount: string;
  freezeAuthority: string | null;
  largestNonCurveAmount: bigint;
  mintAuthority: string | null;
  mintOwner: string;
  totalSupply: bigint;
}

interface RugcheckSnapshot {
  available: boolean;
  insiderNetworks: number | null;
  insiderRaw: unknown;
  lpLockedPct: number | null;
  summaryRaw: unknown;
}

export class SolanaRiskProvider implements RiskProvider {
  constructor(
    private readonly connection: Connection,
    private readonly rugcheckBaseUrl: string,
  ) {}

  async assess(
    state: MintState,
    policy: PolicyConfig,
    nowMs = Date.now(),
  ): Promise<RiskReport> {
    const started = performance.now();
    const onChainStarted = performance.now();
    const onChainPromise = this.onChainSnapshot(state, policy).then(
      (value) => ({
        latencyMs: Math.round(performance.now() - onChainStarted),
        value,
      }),
    );
    const rugcheckStarted = performance.now();
    const rugcheckPromise = fetchRugcheck(
      this.rugcheckBaseUrl,
      state.mint,
      policy.riskTimeoutMs,
    ).then((value) => ({
      latencyMs: Math.round(performance.now() - rugcheckStarted),
      value,
    }));

    const [onChainResult, rugcheckResult] = await Promise.all([
      onChainPromise,
      rugcheckPromise,
    ]);
    const onChain = onChainResult.value;
    const rugcheck = rugcheckResult.value;
    const expectedCurve = bondingCurvePda(new PublicKey(state.mint)).toBase58();
    const topHolderPct = percentage(
      onChain.largestNonCurveAmount,
      onChain.totalSupply,
    );
    const creatorHolderPct = percentage(
      onChain.creatorAmount,
      onChain.totalSupply,
    );
    const officialCurve =
      state.bondingCurve === expectedCurve &&
      onChain.curveOwner === PUMP_PROGRAM_ID.toBase58();

    const checks: RiskCheck[] = [
      check("mint_account", onChain.totalSupply > 0n, "mint decoded on-chain"),
      check(
        "token_program",
        onChain.mintOwner === TOKEN_PROGRAM_ID.toBase58() ||
          onChain.mintOwner === TOKEN_2022_PROGRAM_ID.toBase58(),
        onChain.mintOwner,
      ),
      check(
        "event_token_program_matches",
        onChain.mintOwner === state.tokenProgram,
        `${state.tokenProgram} event / ${onChain.mintOwner} chain`,
      ),
      check(
        "mint_authority_revoked",
        !policy.requireMintAuthorityRevoked || onChain.mintAuthority == null,
        onChain.mintAuthority ?? "revoked",
      ),
      check(
        "freeze_authority_revoked",
        !policy.requireFreezeAuthorityRevoked ||
          onChain.freezeAuthority == null,
        onChain.freezeAuthority ?? "revoked",
      ),
      check(
        "official_bonding_curve",
        !policy.requireOfficialBondingCurve || officialCurve,
        `${state.bondingCurve} expected ${expectedCurve}; owner ${onChain.curveOwner}`,
      ),
      check(
        "pregraduation_liquidity",
        officialCurve,
        "canonical Pump bonding curve; conventional AMM LP does not exist yet",
      ),
      check(
        "top_non_curve_holder_pct",
        topHolderPct <= policy.maxTopHolderPct,
        `${topHolderPct.toFixed(2)}% (canonical curve inventory excluded)`,
      ),
      check(
        "creator_holder_pct",
        creatorHolderPct <= policy.maxCreatorHolderPct,
        `${creatorHolderPct.toFixed(2)}%`,
      ),
      policy.requireRugcheck
        ? unknownAwareCheck(
            "rugcheck_available",
            rugcheck.available,
            rugcheck.summaryRaw,
          )
        : { detail: "optional", name: "rugcheck_available", status: "pass" },
      policy.requireRugcheck
        ? rugcheck.lpLockedPct == null
          ? {
              detail: "Rugcheck did not return lpLockedPct",
              name: "rugcheck_lp_locked_pct",
              status: "unknown",
            }
          : check(
              "rugcheck_lp_locked_pct",
              rugcheck.lpLockedPct >= policy.minRugcheckLpLockedPct,
              `${rugcheck.lpLockedPct.toFixed(2)}%`,
            )
        : {
            detail: "optional",
            name: "rugcheck_lp_locked_pct",
            status: "pass",
          },
      policy.requireInsidersZero
        ? rugcheck.insiderNetworks == null
          ? {
              detail: "Rugcheck insider networks were unavailable",
              name: "insiders_zero",
              status: "unknown",
            }
          : check(
              "insiders_zero",
              rugcheck.insiderNetworks === 0,
              `${rugcheck.insiderNetworks} network(s)`,
            )
        : { detail: "optional", name: "insiders_zero", status: "pass" },
    ];

    const evidence = {
      onChain: {
        contextSlot: onChain.contextSlot,
        creatorAmount: onChain.creatorAmount.toString(),
        creatorHolderPct,
        curveOwner: onChain.curveOwner,
        curveTokenAccount: onChain.curveTokenAccount,
        largestNonCurveAmount: onChain.largestNonCurveAmount.toString(),
        mintOwner: onChain.mintOwner,
        topNonCurveHolderPct: topHolderPct,
        totalSupply: onChain.totalSupply.toString(),
      },
      rugcheck: {
        available: rugcheck.available,
        insiderNetworks: rugcheck.insiderNetworks,
        insiderRaw: compactEvidence(rugcheck.insiderRaw),
        lpLockedPct: rugcheck.lpLockedPct,
        summaryRaw: compactEvidence(rugcheck.summaryRaw),
      },
    };
    const sourceLatencyMs = {
      rugcheck: rugcheckResult.latencyMs,
      solanaRpc: onChainResult.latencyMs,
    };
    const raw = {
      checks,
      evidence,
      mint: state.mint,
      sourceLatencyMs,
      totalMs: Math.round(performance.now() - started),
    };
    return {
      checkedAtMs: nowMs,
      checks,
      evidence,
      mint: state.mint,
      passed: checks.every((item) => item.status === "pass"),
      rawHash: stableHash(raw),
      sourceLatencyMs,
      tokenProgram: onChain.mintOwner,
    };
  }

  private async onChainSnapshot(
    state: MintState,
    policy: PolicyConfig,
  ): Promise<OnChainSnapshot> {
    const mintKey = new PublicKey(state.mint);
    const curveKey = bondingCurvePda(mintKey);
    const tokenProgram = new PublicKey(state.tokenProgram);
    const [accounts, largest, creatorAccounts] = await Promise.all([
      retryReadiness(
        async () =>
          await this.connection.getMultipleAccountsInfoAndContext(
            [mintKey, curveKey],
            { commitment: "processed", minContextSlot: state.lastSlot },
          ),
        (value) => Boolean(value.value[0] && value.value[1]),
        policy,
        "mint or bonding curve account is not ready",
      ),
      retryReadiness(
        async () =>
          await this.connection.getTokenLargestAccounts(mintKey, "processed"),
        () => true,
        policy,
        "token largest accounts are not ready",
      ),
      retryReadiness(
        async () =>
          await this.connection.getTokenAccountsByOwner(
            new PublicKey(state.creator),
            { programId: tokenProgram },
            { commitment: "processed", minContextSlot: state.lastSlot },
          ),
        () => true,
        policy,
        "creator token accounts are not ready",
      ),
    ]);
    const mintInfo = accounts.value[0];
    const curveInfo = accounts.value[1];
    if (!mintInfo || !curveInfo)
      throw new Error("mint or bonding curve account is not ready");
    const mint = unpackMint(mintKey, mintInfo, mintInfo.owner);
    const curveTokenAccount = getAssociatedTokenAddressSync(
      mintKey,
      curveKey,
      true,
      mintInfo.owner,
    ).toBase58();
    const largestNonCurveAmount = largest.value
      .filter(
        ({ address }) =>
          address.toBase58() !== curveTokenAccount &&
          address.toBase58() !== curveKey.toBase58(),
      )
      .reduce(
        (maximum, account) =>
          BigInt(account.amount) > maximum ? BigInt(account.amount) : maximum,
        0n,
      );
    const creatorAmount = creatorAccounts.value.reduce(
      (sum, { account, pubkey }) => {
        const tokenAccount = unpackAccount(pubkey, account, tokenProgram);
        return tokenAccount.mint.equals(mintKey)
          ? sum + tokenAccount.amount
          : sum;
      },
      0n,
    );
    return {
      contextSlot: Math.min(
        accounts.context.slot,
        creatorAccounts.context.slot,
      ),
      creatorAmount,
      curveOwner: curveInfo.owner.toBase58(),
      curveTokenAccount,
      freezeAuthority: mint.freezeAuthority?.toBase58() ?? null,
      largestNonCurveAmount,
      mintAuthority: mint.mintAuthority?.toBase58() ?? null,
      mintOwner: mintInfo.owner.toBase58(),
      totalSupply: mint.supply,
    };
  }
}

function check(name: string, passed: boolean, detail: string): RiskCheck {
  return { detail, name, status: passed ? "pass" : "fail" };
}

function unknownAwareCheck(
  name: string,
  passed: boolean,
  raw: unknown,
): RiskCheck {
  return passed
    ? { detail: "available", name, status: "pass" }
    : { detail: JSON.stringify(compactEvidence(raw)), name, status: "unknown" };
}

async function fetchRugcheck(
  baseUrl: string,
  mint: string,
  timeoutMs: number,
): Promise<RugcheckSnapshot> {
  const root = baseUrl.replace(/\/$/, "");
  const [summary, insiders] = await Promise.all([
    fetchJson(`${root}/tokens/${mint}/report/summary`, timeoutMs),
    fetchJson(`${root}/tokens/${mint}/insiders/networks`, timeoutMs),
  ]);
  const summaryRecord = isRecord(summary.body) ? summary.body : {};
  return {
    available: summary.ok && !("error" in summaryRecord),
    insiderNetworks: insiders.ok ? insiderCount(insiders.body) : null,
    insiderRaw: insiders.body,
    lpLockedPct: numberFrom(
      summaryRecord.lpLockedPct ?? summaryRecord.lp_locked_pct,
    ),
    summaryRaw: summary.body,
  };
}

async function fetchJson(
  url: string,
  timeoutMs: number,
): Promise<{ body: unknown; ok: boolean }> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // The bounded response text is retained as evidence.
    }
    return {
      body: response.ok ? body : { error: `HTTP ${response.status}`, body },
      ok: response.ok,
    };
  } catch (error) {
    return {
      body: { error: error instanceof Error ? error.message : String(error) },
      ok: false,
    };
  }
}

async function retryReadiness<T>(
  operation: () => Promise<T>,
  ready: (value: T) => boolean,
  policy: PolicyConfig,
  message: string,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= policy.riskReadinessRetries; attempt += 1) {
    try {
      const value = await operation();
      if (ready(value)) return value;
      lastError = new Error(message);
    } catch (error) {
      lastError = error;
      if (!isRpcReadinessError(error)) throw error;
    }
    if (attempt < policy.riskReadinessRetries)
      await delay(policy.riskReadinessRetryDelayMs * (attempt + 1));
  }
  throw new Error(
    `${message}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export function isRpcReadinessError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not a token mint|mint or bonding curve account is not ready|minimum context slot|account (?:does not exist|not found)|could not find account/i.test(
    message,
  );
}

function insiderCount(raw: unknown): number | null {
  if (Array.isArray(raw)) return raw.length;
  if (!isRecord(raw)) return null;
  for (const key of ["networks", "insiderNetworks", "insiders"]) {
    if (Array.isArray(raw[key])) return raw[key].length;
  }
  return numberFrom(raw.count ?? raw.insiderCount);
}

function percentage(amount: bigint, supply: bigint): number {
  if (supply <= 0n) return 100;
  return Number((amount * 1_000_000n) / supply) / 10_000;
}

function numberFrom(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" &&
    value.trim() !== "" &&
    Number.isFinite(Number(value.replace("%", "")))
  )
    return Number(value.replace("%", ""));
  return null;
}

function compactEvidence(value: unknown): unknown {
  const encoded = JSON.stringify(value) ?? "null";
  if (encoded.length <= 32_000) return value;
  return {
    bytes: Buffer.byteLength(encoded),
    hash: stableHash(value),
    truncated: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
