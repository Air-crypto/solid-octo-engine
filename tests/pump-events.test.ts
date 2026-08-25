import { describe, expect, it } from "vitest";
import { BorshCoder, EventParser } from "@coral-xyz/anchor";
import { PUMP_PROGRAM_ID, pumpIdl } from "@pump-fun/pump-sdk";
import { Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  pumpEventKind,
  toCreateEvent,
  toTradeEvent,
} from "../src/adapters/pump-events.js";

describe("Pump Anchor event routing", () => {
  it("accepts the exact IDL event names and legacy camel case", () => {
    const names = pumpIdl.events.map((event) => event.name);
    expect(names).toContain("CreateEvent");
    expect(names).toContain("TradeEvent");
    expect(pumpEventKind("CreateEvent")).toBe("create");
    expect(pumpEventKind("TradeEvent")).toBe("trade");
    expect(pumpEventKind("createEvent")).toBe("create");
    expect(pumpEventKind("tradeEvent")).toBe("trade");
    expect(pumpEventKind("CompleteEvent")).toBeNull();
  });

  it("decodes the snake_case fields returned by the raw Borsh event coder", () => {
    const mint = Keypair.generate().publicKey;
    const curve = Keypair.generate().publicKey;
    const creator = Keypair.generate().publicKey;
    const user = Keypair.generate().publicKey;
    const quoteMint = Keypair.generate().publicKey;
    const create = toCreateEvent(
      {
        bonding_curve: curve,
        creator,
        is_cashback_enabled: false,
        is_mayhem_mode: true,
        mint,
        name: "SNAKE",
        quote_mint: quoteMint,
        symbol: "SNK",
        timestamp: 1_700_000_000n,
        token_program: TOKEN_PROGRAM_ID,
        token_total_supply: 1_000n,
        uri: "https://example.invalid/token.json",
        virtual_sol_reserves: 30n,
        virtual_token_reserves: 40n,
      },
      100,
      "create-signature",
    );
    expect(create).toMatchObject({
      blockTimeMs: 1_700_000_000_000,
      bondingCurve: curve.toBase58(),
      isMayhemMode: true,
      mint: mint.toBase58(),
      tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
      tokenTotalSupplyBaseUnits: "1000",
      virtualSolReservesLamports: "30",
    });

    const trade = toTradeEvent(
      {
        creator,
        is_buy: true,
        mint,
        quote_amount: 50n,
        sol_amount: 50n,
        timestamp: 1_700_000_001n,
        token_amount: 60n,
        user,
        virtual_sol_reserves: 70n,
        virtual_token_reserves: 80n,
      },
      101,
      "trade-signature",
    );
    expect(trade).toMatchObject({
      creator: creator.toBase58(),
      isBuy: true,
      mint: mint.toBase58(),
      quoteAmountBaseUnits: "50",
      solAmountLamports: "50",
      tokenAmountBaseUnits: "60",
      trader: user.toBase58(),
      virtualTokenReservesBaseUnits: "80",
    });
  });

  it("converts captured mainnet CreateEvent and TradeEvent payloads", () => {
    const createData =
      "G3KpTd7rY3YTAAAAR2xpdGNoZWQgSnVnZ2VybmF1dAYAAABHTElKVUdDAAAAaHR0cHM6Ly9pcGZzLmlvL2lwZnMvUW1icVpMODJhdFl4d1JpOEZGVVVTak13ZUV3Z2ZFV0NkbzZoOFJGa0ZIQ3ZyMS5Sq6YRYSgBPeS70qE8plTGi8eaXs8ORYGS7kiSJkaPl7Jc60Uck+mSOUBJ4ejc2tXc6SoZrcJxXCuhwcCRAzcPYOIScZJUklmsj3N9KhnS1rPK/UTNA/DrO3eIxQlmig9g4hJxklSSWayPc30qGdLWs8r9RM0D8Os7d4jFCWaKsvqNagAAAAAAENhH488DAACsI/wGAAAAAHjF+1HRAgAAgMakfo0DAAbd9uHudY/eGEJdvORszdq2GvxNg7kNJ/69+SjYoYv8AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACsI/wGAAAA";
    const tradeData =
      "vdt/007mYe4uUqumEWEoAT3ku9KhPKZUxovHml7PDkWBku5IkiZGj4WekQ4AAAAAgnolA+MHAAABD2DiEnGSVJJZrI9zfSoZ0tazyv1EzQPw6zt3iMUJZoqy+o1qAAAAAIVKtQoHAAAAfpWyRADIAwCFnpEOAAAAAH79n/huyQIAdOlUPz43otBGInrdy06cd0xEJYxD7fJKqKrh8AIUZltfAAAAAAAAAHBuIwAAAAAAD2DiEnGSVJJZrI9zfSoZ0tazyv1EzQPw6zt3iMUJZooeAAAAAAAAAFkwCwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAGJ1eQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIWekQ4AAAAAhUq1CgcAAACFnpEOAAAAAA==";
    const parser = new EventParser(
      PUMP_PROGRAM_ID,
      new BorshCoder(pumpIdl as never),
    );
    const decoded = [
      ...parser.parseLogs([
        `Program ${PUMP_PROGRAM_ID.toBase58()} invoke [1]`,
        `Program data: ${createData}`,
        `Program data: ${tradeData}`,
        `Program ${PUMP_PROGRAM_ID.toBase58()} success`,
      ]),
    ];
    expect(decoded.map((event) => event.name)).toEqual([
      "CreateEvent",
      "TradeEvent",
    ]);
    expect(Object.keys(decoded[0]!.data)).toContain("bonding_curve");
    expect(Object.keys(decoded[1]!.data)).toContain("sol_amount");
    const create = toCreateEvent(decoded[0]!.data, 441_708_951, "captured");
    const trade = toTradeEvent(decoded[1]!.data, 441_708_951, "captured");
    expect(create.mint).toBe("47psMzTJjbkBBZmeZj7bynsStswXrv8wNco96fympump");
    expect(create.virtualSolReservesLamports).toBe("30000000000");
    expect(trade.mint).toBe(create.mint);
    expect(trade.solAmountLamports).toBe("244424325");
  });

  it("retains compatibility with camelCase Program event payloads", () => {
    const key = Keypair.generate().publicKey;
    expect(
      toTradeEvent(
        {
          creator: key,
          isBuy: false,
          mint: key,
          quoteAmount: 1n,
          solAmount: 2n,
          timestamp: 3n,
          tokenAmount: 4n,
          user: key,
          virtualSolReserves: 5n,
          virtualTokenReserves: 6n,
        },
        1,
        "signature",
      ),
    ).toMatchObject({
      isBuy: false,
      quoteAmountBaseUnits: "1",
      solAmountLamports: "2",
      tokenAmountBaseUnits: "4",
    });
  });

  it("reports a stable missing-field error instead of dereferencing undefined", () => {
    expect(() => toTradeEvent({}, 1, "signature")).toThrow(
      "event field sol_amount is missing",
    );
  });
});
