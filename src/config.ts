import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { z } from "zod";
import type { DeskMode, PolicyConfig } from "./domain/types.js";

const optionalString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().optional(),
);
const optionalArmToken = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(24).optional(),
);

const envSchema = z.object({
  DESK_ARM_TOKEN: optionalArmToken,
  DESK_DB_PATH: z.string().default("./data/desk.db"),
  DESK_EVENT_MAX_ROWS: z.coerce.number().int().min(1_000).default(50_000),
  DESK_EVENT_RETENTION_HOURS: z.coerce.number().positive().default(24),
  DESK_HOST: z.string().default("127.0.0.1"),
  DESK_MODE: z.enum(["shadow", "manual", "live"]).default("shadow"),
  DESK_POLICY_PATH: z.string().default("./config/policy.json"),
  DESK_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  EXPECTED_SIGNER_PUBLIC_KEY: optionalString,
  RUGCHECK_BASE_URL: z.string().url().default("https://api.rugcheck.xyz/v1"),
  SOLANA_EXECUTION_KEYPAIR_PATH: optionalString,
  SOLANA_RPC_HTTP_URL: z
    .string()
    .url()
    .default("https://api.mainnet-beta.solana.com"),
  SOLANA_RPC_MAX_RPS: z.coerce.number().int().min(1).max(500).default(8),
  SOLANA_RPC_WS_URL: z
    .string()
    .url()
    .default("wss://api.mainnet-beta.solana.com"),
});

const policySchema = z.object({
  armLeaseMaxMs: z.number().int().positive(),
  defaultSpendUsdCents: z.number().int().positive(),
  entryMarketCapUsd: z.number().positive(),
  exitIntentTtlMs: z.number().int().positive(),
  exitMaxAttempts: z.number().int().min(1).max(10),
  exitRetryCooldownMs: z.number().int().positive(),
  exitRetryDelayMs: z.number().int().min(0),
  holdRiskFailureKillThreshold: z.number().int().min(2).max(10),
  holdRiskRetryDelayMs: z.number().int().positive(),
  holdRiskTimeoutMs: z.number().int().positive(),
  intentTtlMs: z.number().int().positive(),
  maxAgeMs: z.number().int().positive(),
  maxCreatorHolderPct: z.number().min(0).max(100),
  maxDailyShadowSpendUsdCents: z.number().int().positive(),
  maxDailySpendUsdCents: z.number().int().positive(),
  maxOpenPositions: z.number().int().positive(),
  maxOracleSpreadPct: z.number().positive(),
  maxPriceAgeMs: z.number().int().positive(),
  maxSlippageBps: z.number().int().min(1).max(10_000),
  maxSpendUsdCents: z.number().int().positive(),
  maxTopHolderPct: z.number().min(0).max(100),
  minSpendUsdCents: z.number().int().positive(),
  requireFreezeAuthorityRevoked: z.boolean(),
  requireInsidersZero: z.boolean(),
  requireMintAuthorityRevoked: z.boolean(),
  requireOfficialBondingCurve: z.boolean(),
  requireRugcheck: z.boolean(),
  riskFailureKillThreshold: z.number().int().positive(),
  riskReadinessRetries: z.number().int().min(0).max(10),
  riskReadinessRetryDelayMs: z.number().int().positive(),
  riskTimeoutMs: z.number().int().positive(),
  spikeCeilingMarketCapUsd: z.number().positive(),
  stopLossPct: z.number().positive().lt(100),
  takeProfitPct: z.number().positive(),
  takeProfitSellFraction: z.number().gt(0).lte(1),
  timeStopMs: z.number().int().positive(),
  trailingStopPct: z.number().positive().lt(100),
  version: z.number().int().positive(),
});

export interface AppConfig {
  armToken?: string;
  dbPath: string;
  eventMaxRows: number;
  eventRetentionMs: number;
  executionKeypairPath?: string;
  expectedSignerPublicKey?: string;
  host: string;
  mode: DeskMode;
  policy: PolicyConfig;
  port: number;
  rpcHttpUrl: string;
  rpcMaxRequestsPerSecond: number;
  rpcWsUrl: string;
  rugcheckBaseUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env === process.env) {
    try {
      loadEnvFile(".env");
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
  }
  const parsed = envSchema.parse(env);
  const policyPath = resolve(parsed.DESK_POLICY_PATH);
  const policy = policySchema.parse(
    JSON.parse(readFileSync(policyPath, "utf8")),
  ) as PolicyConfig;

  if (
    policy.defaultSpendUsdCents < policy.minSpendUsdCents ||
    policy.defaultSpendUsdCents > policy.maxSpendUsdCents
  ) {
    throw new Error(
      "defaultSpendUsdCents must be within the configured spend range",
    );
  }
  if (policy.entryMarketCapUsd >= policy.spikeCeilingMarketCapUsd) {
    throw new Error("entryMarketCapUsd must be below spikeCeilingMarketCapUsd");
  }
  if (parsed.DESK_MODE === "live") {
    if (
      !parsed.DESK_ARM_TOKEN ||
      !parsed.EXPECTED_SIGNER_PUBLIC_KEY ||
      !parsed.SOLANA_EXECUTION_KEYPAIR_PATH
    ) {
      throw new Error(
        "live mode requires DESK_ARM_TOKEN, EXPECTED_SIGNER_PUBLIC_KEY, and SOLANA_EXECUTION_KEYPAIR_PATH",
      );
    }
  }

  return {
    armToken: parsed.DESK_ARM_TOKEN,
    dbPath: resolve(parsed.DESK_DB_PATH),
    eventMaxRows: parsed.DESK_EVENT_MAX_ROWS,
    eventRetentionMs: parsed.DESK_EVENT_RETENTION_HOURS * 60 * 60 * 1_000,
    executionKeypairPath: parsed.SOLANA_EXECUTION_KEYPAIR_PATH
      ? resolve(parsed.SOLANA_EXECUTION_KEYPAIR_PATH)
      : undefined,
    expectedSignerPublicKey: parsed.EXPECTED_SIGNER_PUBLIC_KEY,
    host: parsed.DESK_HOST,
    mode: parsed.DESK_MODE,
    policy,
    port: parsed.DESK_PORT,
    rpcHttpUrl: parsed.SOLANA_RPC_HTTP_URL,
    rpcMaxRequestsPerSecond: parsed.SOLANA_RPC_MAX_RPS,
    rpcWsUrl: parsed.SOLANA_RPC_WS_URL,
    rugcheckBaseUrl: parsed.RUGCHECK_BASE_URL,
  };
}
