import {
  Keypair,
  PublicKey,
  type AccountInfo,
  type Connection,
  type FetchFn,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PUMP_PROGRAM_ID, bondingCurvePda } from "@pump-fun/pump-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MintState } from "../src/domain/types.js";
import { RpcRateController } from "../src/rpc/rate-controller.js";
import {
  SolanaRiskProvider,
  isRpcReadinessError,
} from "../src/risk/solana-risk.js";
import { policy } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("RPC rate controller", () => {
  it("holds every web3 HTTP request inside the configured rolling RPS cap", async () => {
    vi.useFakeTimers();
    const underlying = vi.fn(async () => new Response("{}", { status: 200 }));
    const controller = new RpcRateController(
      2,
      underlying as unknown as FetchFn,
    );
    const request = (method: string) =>
      controller.fetch("https://rpc.invalid", {
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method }),
        method: "POST",
      });

    const responses = [request("a"), request("b"), request("c")];
    await vi.advanceTimersByTimeAsync(0);
    expect(underlying).toHaveBeenCalledTimes(2);
    expect(controller.snapshot().queueDepth).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all(responses);
    expect(underlying).toHaveBeenCalledTimes(3);
    expect(controller.snapshot()).toMatchObject({
      byMethod: { a: 1, b: 1, c: 1 },
      queueDepth: 0,
      total: 3,
    });
  });

  it("records a 429 without starting web3's unbounded retry loop", async () => {
    const controller = new RpcRateController(
      8,
      (async () => new Response("limited", { status: 429 })) as FetchFn,
    );
    await controller.fetch("https://rpc.invalid", {
      body: JSON.stringify({ method: "getSlot" }),
      method: "POST",
    });
    expect(controller.snapshot().rateLimited).toBe(1);
    expect(controller.snapshot().last429AtMs).not.toBeNull();
  });
});

describe("fresh Pump risk snapshot", () => {
  it("retries fresh-index errors but never rate limits or timeouts", () => {
    expect(
      isRpcReadinessError(new Error("Invalid param: not a Token mint")),
    ).toBe(true);
    expect(isRpcReadinessError(new Error("429 Too Many Requests"))).toBe(false);
    expect(isRpcReadinessError(new Error("request timed out"))).toBe(false);
  });

  it("retries index readiness, excludes curve inventory, and uses Rugcheck's real endpoints", async () => {
    const mint = Keypair.generate().publicKey;
    const creator = Keypair.generate().publicKey;
    const curve = bondingCurvePda(mint);
    const curveTokenAccount = getAssociatedTokenAddressSync(
      mint,
      curve,
      true,
      TOKEN_PROGRAM_ID,
    );
    const mintData = Buffer.alloc(MINT_SIZE);
    MintLayout.encode(
      {
        decimals: 6,
        freezeAuthority: PublicKey.default,
        freezeAuthorityOption: 0,
        isInitialized: true,
        mintAuthority: PublicKey.default,
        mintAuthorityOption: 0,
        supply: 1_000n,
      },
      mintData,
    );
    const mintInfo: AccountInfo<Buffer> = {
      data: mintData,
      executable: false,
      lamports: 1,
      owner: TOKEN_PROGRAM_ID,
      rentEpoch: 0,
    };
    const curveInfo: AccountInfo<Buffer> = {
      data: Buffer.alloc(8),
      executable: false,
      lamports: 1,
      owner: PUMP_PROGRAM_ID,
      rentEpoch: 0,
    };
    const largest = vi
      .fn()
      .mockRejectedValueOnce(new Error("Invalid param: not a Token mint"))
      .mockResolvedValue({
        context: { slot: 12 },
        value: [
          tokenAmount(curveTokenAccount, "500"),
          tokenAmount(Keypair.generate().publicKey, "100"),
        ],
      });
    const connection = {
      getMultipleAccountsInfoAndContext: vi.fn(async () => ({
        context: { slot: 12 },
        value: [mintInfo, curveInfo],
      })),
      getTokenAccountsByOwner: vi.fn(async () => ({
        context: { slot: 12 },
        value: [],
      })),
      getTokenLargestAccounts: largest,
    } as unknown as Connection;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/insiders/networks")
          ? new Response("[]", { status: 200 })
          : new Response(
              JSON.stringify({ lpLockedPct: 100, risks: [], score: 0 }),
              { status: 200 },
            ),
      ),
    );
    const state: MintState = {
      bondingCurve: curve.toBase58(),
      createdAtMs: 1_000,
      creationSignature: "create",
      creationSlot: 10,
      creator: creator.toBase58(),
      currentMarketCapUsd: 3_240,
      highWaterMarketCapUsd: 3_240,
      lastEventSignature: "trade",
      lastObservedAtMs: 1_500,
      lastSlot: 12,
      mint: mint.toBase58(),
      name: "TEST",
      phase: "risk_pending",
      previousMarketCapUsd: 3_100,
      quoteMint: PublicKey.default.toBase58(),
      symbol: "TEST",
      tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
      tokenTotalSupplyBaseUnits: "1000",
      virtualSolReservesLamports: "1",
      virtualTokenReservesBaseUnits: "1",
    };

    const report = await new SolanaRiskProvider(
      connection,
      "https://api.rugcheck.xyz/v1",
    ).assess(state, policy, 1_500);

    expect(largest).toHaveBeenCalledTimes(2);
    expect(report.passed).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detail: expect.stringContaining("10.00%"),
          name: "top_non_curve_holder_pct",
          status: "pass",
        }),
        expect.objectContaining({ name: "insiders_zero", status: "pass" }),
        expect.objectContaining({
          name: "rugcheck_lp_locked_pct",
          status: "pass",
        }),
      ]),
    );
    expect(report.evidence.onChain.curveTokenAccount).toBe(
      curveTokenAccount.toBase58(),
    );
  });

  it("uses Helius V2 for Token-2022 and derives both concentration checks from one scan", async () => {
    const mint = Keypair.generate().publicKey;
    const creator = Keypair.generate().publicKey;
    const curve = bondingCurvePda(mint);
    const curveTokenAccount = getAssociatedTokenAddressSync(
      mint,
      curve,
      true,
      TOKEN_2022_PROGRAM_ID,
    );
    const rpcRequest = vi.fn(async (_method: string, _args: unknown[]) => ({
      id: 1,
      jsonrpc: "2.0",
      result: {
        context: { apiVersion: "3.1.9", slot: 12 },
        value: {
          accounts: [
            rawSlicedTokenAccount(curveTokenAccount, curve, 600n),
            rawSlicedTokenAccount(Keypair.generate().publicKey, creator, 40n),
            rawSlicedTokenAccount(
              Keypair.generate().publicKey,
              Keypair.generate().publicKey,
              100n,
            ),
          ],
          paginationKey: null,
        },
      },
    }));
    const connection = {
      _rpcRequest: rpcRequest,
      getMultipleAccountsInfoAndContext: vi.fn(async () => ({
        context: { slot: 12 },
        value: [
          mintAccountInfo(TOKEN_2022_PROGRAM_ID, 1_000n),
          curveAccountInfo(),
        ],
      })),
      rpcEndpoint: "https://mainnet.helius-rpc.com/?api-key=secret",
    } as unknown as Connection;
    stubPassingRugcheck();

    const report = await new SolanaRiskProvider(
      connection,
      "https://api.rugcheck.xyz/v1",
    ).assess(
      mintState(mint, creator, curve, TOKEN_2022_PROGRAM_ID),
      policy,
      1_500,
    );

    expect(report.passed).toBe(true);
    expect(report.evidence.onChain).toMatchObject({
      creatorAmount: "40",
      holderAccountCount: 3,
      holderSource: "helius_program_accounts_v2",
      largestNonCurveAmount: "100",
    });
    expect(rpcRequest).toHaveBeenCalledTimes(1);
    expect(rpcRequest).toHaveBeenCalledWith(
      "getProgramAccountsV2",
      expect.arrayContaining([
        TOKEN_2022_PROGRAM_ID.toBase58(),
        expect.objectContaining({
          dataSlice: { length: 40, offset: 32 },
          encoding: "base64",
          filters: [{ memcmp: { bytes: mint.toBase58(), offset: 0 } }],
          limit: 10_000,
          minContextSlot: 12,
          withContext: true,
        }),
      ]),
    );
    const config = rpcRequest.mock.calls[0]![1][1] as Record<string, unknown>;
    expect(config).not.toHaveProperty("dataSize");
  });

  it("fails closed when a Token-2022 holder scan cannot be one consistent page", async () => {
    const mint = Keypair.generate().publicKey;
    const creator = Keypair.generate().publicKey;
    const curve = bondingCurvePda(mint);
    const curveTokenAccount = getAssociatedTokenAddressSync(
      mint,
      curve,
      true,
      TOKEN_2022_PROGRAM_ID,
    );
    const connection = {
      _rpcRequest: vi.fn(async () => ({
        id: 1,
        jsonrpc: "2.0",
        result: {
          context: { apiVersion: "3.1.9", slot: 12 },
          value: {
            accounts: [rawSlicedTokenAccount(curveTokenAccount, curve, 600n)],
            paginationKey: "another-page",
          },
        },
      })),
      getMultipleAccountsInfoAndContext: vi.fn(async () => ({
        context: { slot: 12 },
        value: [
          mintAccountInfo(TOKEN_2022_PROGRAM_ID, 1_000n),
          curveAccountInfo(),
        ],
      })),
      rpcEndpoint: "https://mainnet.helius-rpc.com/?api-key=secret",
    } as unknown as Connection;
    stubPassingRugcheck();

    await expect(
      new SolanaRiskProvider(connection, "https://api.rugcheck.xyz/v1").assess(
        mintState(mint, creator, curve, TOKEN_2022_PROGRAM_ID),
        policy,
        1_500,
      ),
    ).rejects.toThrow("consistent single-slot holder snapshot is unavailable");
  });

  it("falls back to standard program accounts for Token-2022 on other providers", async () => {
    const mint = Keypair.generate().publicKey;
    const creator = Keypair.generate().publicKey;
    const curve = bondingCurvePda(mint);
    const curveTokenAccount = getAssociatedTokenAddressSync(
      mint,
      curve,
      true,
      TOKEN_2022_PROGRAM_ID,
    );
    const getProgramAccounts = vi.fn(async () => ({
      context: { slot: 12 },
      value: [
        slicedTokenAccount(curveTokenAccount, curve, 600n),
        slicedTokenAccount(Keypair.generate().publicKey, creator, 40n),
      ],
    }));
    const connection = {
      getMultipleAccountsInfoAndContext: vi.fn(async () => ({
        context: { slot: 12 },
        value: [
          mintAccountInfo(TOKEN_2022_PROGRAM_ID, 1_000n),
          curveAccountInfo(),
        ],
      })),
      getProgramAccounts,
      rpcEndpoint: "https://rpc.example.invalid",
    } as unknown as Connection;
    stubPassingRugcheck();

    const report = await new SolanaRiskProvider(
      connection,
      "https://api.rugcheck.xyz/v1",
    ).assess(
      mintState(mint, creator, curve, TOKEN_2022_PROGRAM_ID),
      policy,
      1_500,
    );

    expect(report.passed).toBe(true);
    expect(report.evidence.onChain).toMatchObject({
      creatorAmount: "40",
      holderAccountCount: 2,
      holderSource: "program_accounts",
    });
    expect(getProgramAccounts).toHaveBeenCalledWith(
      TOKEN_2022_PROGRAM_ID,
      expect.objectContaining({
        dataSlice: { length: 40, offset: 32 },
        filters: [{ memcmp: { bytes: mint.toBase58(), offset: 0 } }],
      }),
    );
  });
});

function tokenAmount(address: PublicKey, amount: string) {
  return {
    address,
    amount,
    decimals: 6,
    uiAmount: Number(amount) / 1_000_000,
    uiAmountString: (Number(amount) / 1_000_000).toString(),
  };
}

function mintAccountInfo(
  owner: PublicKey,
  supply: bigint,
): AccountInfo<Buffer> {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      decimals: 6,
      freezeAuthority: PublicKey.default,
      freezeAuthorityOption: 0,
      isInitialized: true,
      mintAuthority: PublicKey.default,
      mintAuthorityOption: 0,
      supply,
    },
    data,
  );
  return {
    data,
    executable: false,
    lamports: 1,
    owner,
    rentEpoch: 0,
  };
}

function curveAccountInfo(): AccountInfo<Buffer> {
  return {
    data: Buffer.alloc(8),
    executable: false,
    lamports: 1,
    owner: PUMP_PROGRAM_ID,
    rentEpoch: 0,
  };
}

function tokenAccountSlice(owner: PublicKey, amount: bigint): Buffer {
  const data = Buffer.alloc(40);
  owner.toBuffer().copy(data, 0);
  data.writeBigUInt64LE(amount, 32);
  return data;
}

function rawSlicedTokenAccount(
  pubkey: PublicKey,
  owner: PublicKey,
  amount: bigint,
) {
  return {
    account: {
      data: [tokenAccountSlice(owner, amount).toString("base64"), "base64"],
      executable: false,
      lamports: 1,
      owner: TOKEN_2022_PROGRAM_ID.toBase58(),
      rentEpoch: 0,
      space: 170,
    },
    pubkey: pubkey.toBase58(),
  };
}

function slicedTokenAccount(
  pubkey: PublicKey,
  owner: PublicKey,
  amount: bigint,
) {
  return {
    account: {
      data: tokenAccountSlice(owner, amount),
      executable: false,
      lamports: 1,
      owner: TOKEN_2022_PROGRAM_ID,
      rentEpoch: 0,
    },
    pubkey,
  };
}

function mintState(
  mint: PublicKey,
  creator: PublicKey,
  curve: PublicKey,
  tokenProgram: PublicKey,
): MintState {
  return {
    bondingCurve: curve.toBase58(),
    createdAtMs: 1_000,
    creationSignature: "create",
    creationSlot: 10,
    creator: creator.toBase58(),
    currentMarketCapUsd: 3_240,
    highWaterMarketCapUsd: 3_240,
    lastEventSignature: "trade",
    lastObservedAtMs: 1_500,
    lastSlot: 12,
    mint: mint.toBase58(),
    name: "TEST",
    phase: "risk_pending",
    previousMarketCapUsd: 3_100,
    quoteMint: PublicKey.default.toBase58(),
    symbol: "TEST",
    tokenProgram: tokenProgram.toBase58(),
    tokenTotalSupplyBaseUnits: "1000",
    virtualSolReservesLamports: "1",
    virtualTokenReservesBaseUnits: "1",
  };
}

function stubPassingRugcheck(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.includes("/insiders/networks")
        ? new Response("[]", { status: 200 })
        : new Response(
            JSON.stringify({ lpLockedPct: 100, risks: [], score: 0 }),
            { status: 200 },
          ),
    ),
  );
}
