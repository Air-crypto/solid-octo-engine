import { PublicKey, type Connection } from "@solana/web3.js";
import { PUMP_PROGRAM_ID, bondingCurvePda } from "@pump-fun/pump-sdk";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type {
  MintState,
  PolicyConfig,
  RiskCheck,
  RiskReport,
} from "../domain/types.js";
import { stableHash } from "../core/hash.js";
import type { RiskProvider } from "./types.js";

interface RugcheckSummary {
  creatorHolderPct: number | null;
  insiders: number | null;
  raw: unknown;
  topHolderPct: number | null;
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
    const sourceLatencyMs: Record<string, number> = {};
    const onChainStarted = performance.now();
    const [mintInfo, curveInfo, supply, largest, creatorAccounts] =
      await Promise.all([
        this.connection.getParsedAccountInfo(
          new PublicKey(state.mint),
          "confirmed",
        ),
        this.connection.getAccountInfo(
          bondingCurvePda(new PublicKey(state.mint)),
          "confirmed",
        ),
        this.connection.getTokenSupply(new PublicKey(state.mint), "confirmed"),
        this.connection.getTokenLargestAccounts(
          new PublicKey(state.mint),
          "confirmed",
        ),
        this.creatorTokenAccounts(state.creator),
      ]);
    sourceLatencyMs.solanaRpc = Math.round(performance.now() - onChainStarted);

    const parsed =
      mintInfo.value?.data &&
      typeof mintInfo.value.data === "object" &&
      "parsed" in mintInfo.value.data
        ? (mintInfo.value.data.parsed as {
            info?: {
              freezeAuthority?: string | null;
              mintAuthority?: string | null;
            };
          })
        : null;
    const owner = mintInfo.value?.owner.toBase58() ?? "unknown";
    const expectedCurve = bondingCurvePda(new PublicKey(state.mint)).toBase58();
    const totalSupply = BigInt(supply.value.amount);
    const topAmount = largest.value[0]?.amount
      ? BigInt(largest.value[0].amount)
      : 0n;
    const topHolderPct =
      totalSupply > 0n
        ? Number((topAmount * 10_000n) / totalSupply) / 100
        : 100;
    const creatorAmount = creatorAccounts
      .filter((account) => account.mint === state.mint)
      .reduce((sum, account) => sum + BigInt(account.amount), 0n);
    const creatorHolderPct =
      totalSupply > 0n
        ? Number((creatorAmount * 10_000n) / totalSupply) / 100
        : 100;

    let rugcheck: RugcheckSummary = {
      creatorHolderPct: null,
      insiders: null,
      raw: null,
      topHolderPct: null,
    };
    const rugStarted = performance.now();
    try {
      rugcheck = await fetchRugcheck(
        this.rugcheckBaseUrl,
        state.mint,
        policy.riskTimeoutMs,
      );
    } catch (error) {
      rugcheck = {
        creatorHolderPct: null,
        insiders: null,
        raw: { error: error instanceof Error ? error.message : String(error) },
        topHolderPct: null,
      };
    }
    sourceLatencyMs.rugcheck = Math.round(performance.now() - rugStarted);

    const effectiveTopPct = rugcheck.topHolderPct ?? topHolderPct;
    const effectiveCreatorPct = rugcheck.creatorHolderPct ?? creatorHolderPct;
    const checks: RiskCheck[] = [
      check(
        "mint_account",
        Boolean(mintInfo.value),
        "mint account exists on-chain",
      ),
      check(
        "token_program",
        owner === TOKEN_PROGRAM_ID.toBase58() ||
          owner === TOKEN_2022_PROGRAM_ID.toBase58(),
        owner,
      ),
      check(
        "mint_authority_revoked",
        !policy.requireMintAuthorityRevoked ||
          parsed?.info?.mintAuthority == null,
        String(parsed?.info?.mintAuthority ?? "revoked"),
      ),
      check(
        "freeze_authority_revoked",
        !policy.requireFreezeAuthorityRevoked ||
          parsed?.info?.freezeAuthority == null,
        String(parsed?.info?.freezeAuthority ?? "revoked"),
      ),
      check(
        "official_bonding_curve",
        !policy.requireOfficialBondingCurve ||
          (state.bondingCurve === expectedCurve &&
            curveInfo?.owner.equals(PUMP_PROGRAM_ID) === true),
        `${state.bondingCurve} expected ${expectedCurve}`,
      ),
      check(
        "top_holder_pct",
        effectiveTopPct <= policy.maxTopHolderPct,
        `${effectiveTopPct.toFixed(2)}%`,
      ),
      check(
        "creator_holder_pct",
        effectiveCreatorPct <= policy.maxCreatorHolderPct,
        `${effectiveCreatorPct.toFixed(2)}%`,
      ),
      policy.requireRugcheck
        ? unknownAwareCheck(
            "rugcheck_available",
            rugcheck.raw != null &&
              !(isRecord(rugcheck.raw) && "error" in rugcheck.raw),
            rugcheck.raw,
          )
        : { detail: "optional", name: "rugcheck_available", status: "pass" },
      policy.requireInsidersZero
        ? rugcheck.insiders == null
          ? {
              detail: "Rugcheck did not return an insider count",
              name: "insiders_zero",
              status: "unknown",
            }
          : check(
              "insiders_zero",
              rugcheck.insiders === 0,
              String(rugcheck.insiders),
            )
        : { detail: "optional", name: "insiders_zero", status: "pass" },
    ];

    const raw = {
      checks,
      mint: state.mint,
      owner,
      rugcheck: rugcheck.raw,
      sourceLatencyMs,
      totalMs: Math.round(performance.now() - started),
    };
    return {
      checkedAtMs: nowMs,
      checks,
      mint: state.mint,
      passed: checks.every((item) => item.status === "pass"),
      rawHash: stableHash(raw),
      sourceLatencyMs,
      tokenProgram: owner,
    };
  }

  private async creatorTokenAccounts(
    owner: string,
  ): Promise<Array<{ amount: string; mint: string }>> {
    const publicKey = new PublicKey(owner);
    const responses = await Promise.all([
      this.connection.getParsedTokenAccountsByOwner(
        publicKey,
        { programId: TOKEN_PROGRAM_ID },
        "confirmed",
      ),
      this.connection.getParsedTokenAccountsByOwner(
        publicKey,
        { programId: TOKEN_2022_PROGRAM_ID },
        "confirmed",
      ),
    ]);
    return responses.flatMap((response) =>
      response.value.map(({ account }) => {
        const parsed = account.data as {
          parsed: { info: { mint: string; tokenAmount: { amount: string } } };
        };
        return {
          amount: parsed.parsed.info.tokenAmount.amount,
          mint: parsed.parsed.info.mint,
        };
      }),
    );
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
    : { detail: JSON.stringify(raw), name, status: "unknown" };
}

async function fetchRugcheck(
  baseUrl: string,
  mint: string,
  timeoutMs: number,
): Promise<RugcheckSummary> {
  const response = await fetch(
    `${baseUrl.replace(/\/$/, "")}/tokens/${mint}/report/summary`,
    { signal: AbortSignal.timeout(timeoutMs) },
  );
  if (!response.ok) throw new Error(`Rugcheck ${response.status}`);
  const raw = (await response.json()) as unknown;
  const record = isRecord(raw) ? raw : {};
  const insiders = numberFrom(
    record.insiderCount ?? record.insiders ?? record.insiderNetworks,
  );
  const topHolderPct = numberFrom(
    record.topHolderPct ?? record.topHolderPercentage,
  );
  const creatorHolderPct = numberFrom(
    record.creatorHolderPct ?? record.creatorPercentage,
  );
  return { creatorHolderPct, insiders, raw, topHolderPct };
}

function numberFrom(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" &&
    value.trim() !== "" &&
    Number.isFinite(Number(value))
  )
    return Number(value);
  if (Array.isArray(value)) return value.length;
  if (isRecord(value)) return Object.keys(value).length;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
