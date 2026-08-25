import type { Connection, PublicKey } from "@solana/web3.js";
import { BorshCoder, EventParser } from "@coral-xyz/anchor";
import { PUMP_PROGRAM_ID, getPumpProgram, pumpIdl } from "@pump-fun/pump-sdk";
import type {
  PumpCreateEvent,
  PumpEvent,
  PumpTradeEvent,
} from "../domain/types.js";

type EventHandler = (event: PumpEvent) => void | Promise<void>;

export interface PumpEventSource {
  start(handler: EventHandler): Promise<void>;
  stop(): Promise<void>;
}

export class AnchorPumpEventSource implements PumpEventSource {
  private createListener: number | null = null;
  private tradeListener: number | null = null;
  private slotListener: number | null = null;
  private catchupTimer: NodeJS.Timeout | null = null;
  private catchingUp = false;
  private readonly program;

  constructor(
    private readonly connection: Connection,
    private readonly onHeartbeat: (slot: number, atMs: number) => void = () =>
      undefined,
    private readonly checkpoint: {
      get(): string | null;
      set(signature: string): void;
    } = { get: () => null, set: () => undefined },
  ) {
    this.program = getPumpProgram(connection);
  }

  async start(handler: EventHandler): Promise<void> {
    if (this.createListener !== null || this.tradeListener !== null)
      throw new Error("Pump event source already started");
    this.createListener = await this.program.addEventListener(
      "createEvent",
      async (event, slot, signature) => {
        await handler(
          toCreateEvent(
            event as unknown as PumpCreateAnchorEvent,
            slot,
            signature,
          ),
        );
        this.checkpoint.set(signature);
      },
    );
    this.tradeListener = await this.program.addEventListener(
      "tradeEvent",
      async (event, slot, signature) => {
        await handler(
          toTradeEvent(
            event as unknown as PumpTradeAnchorEvent,
            slot,
            signature,
          ),
        );
        this.checkpoint.set(signature);
      },
    );
    this.slotListener = this.connection.onSlotChange(({ slot }) =>
      this.onHeartbeat(slot, Date.now()),
    );
    await this.catchUp(handler);
    this.catchupTimer = setInterval(() => void this.catchUp(handler), 10_000);
  }

  async stop(): Promise<void> {
    const removals: Promise<void>[] = [];
    if (this.createListener !== null)
      removals.push(this.program.removeEventListener(this.createListener));
    if (this.tradeListener !== null)
      removals.push(this.program.removeEventListener(this.tradeListener));
    if (this.slotListener !== null)
      removals.push(
        this.connection.removeSlotChangeListener(this.slotListener),
      );
    if (this.catchupTimer) clearInterval(this.catchupTimer);
    await Promise.allSettled(removals);
    this.createListener = null;
    this.tradeListener = null;
    this.slotListener = null;
    this.catchupTimer = null;
  }

  private async catchUp(handler: EventHandler): Promise<void> {
    if (this.catchingUp) return;
    const until = this.checkpoint.get();
    if (!until) return;
    this.catchingUp = true;
    try {
      const signatures = await this.connection.getSignaturesForAddress(
        PUMP_PROGRAM_ID,
        { limit: 100, until },
        "confirmed",
      );
      const parser = new EventParser(
        PUMP_PROGRAM_ID,
        new BorshCoder(pumpIdl as never),
      );
      for (const item of signatures.reverse()) {
        const transaction = await this.connection.getTransaction(
          item.signature,
          { commitment: "confirmed", maxSupportedTransactionVersion: 0 },
        );
        if (!transaction?.meta?.logMessages) continue;
        for (const parsed of parser.parseLogs(transaction.meta.logMessages)) {
          if (parsed.name === "createEvent") {
            await handler(
              toCreateEvent(
                parsed.data as unknown as PumpCreateAnchorEvent,
                transaction.slot,
                item.signature,
              ),
            );
          } else if (parsed.name === "tradeEvent") {
            await handler(
              toTradeEvent(
                parsed.data as unknown as PumpTradeAnchorEvent,
                transaction.slot,
                item.signature,
              ),
            );
          }
        }
        this.checkpoint.set(item.signature);
      }
    } finally {
      this.catchingUp = false;
    }
  }
}

export class ReplayPumpEventSource implements PumpEventSource {
  private stopped = false;

  constructor(
    private readonly events: PumpEvent[],
    private readonly speed = 0,
  ) {}

  async start(handler: EventHandler): Promise<void> {
    this.stopped = false;
    let previousAt = this.events[0]?.observedAtMs ?? 0;
    for (const event of this.events) {
      if (this.stopped) return;
      if (this.speed > 0) {
        const delay = Math.max(
          0,
          (event.observedAtMs - previousAt) / this.speed,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      await handler(event);
      previousAt = event.observedAtMs;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

interface NumberLike {
  toString(): string;
}

interface PumpCreateAnchorEvent {
  bondingCurve: PublicKey;
  creator: PublicKey;
  isCashbackEnabled: boolean;
  isMayhemMode: boolean;
  mint: PublicKey;
  name: string;
  quoteMint: PublicKey;
  symbol: string;
  timestamp: NumberLike;
  tokenProgram: PublicKey;
  tokenTotalSupply: NumberLike;
  uri: string;
  virtualSolReserves: NumberLike;
  virtualTokenReserves: NumberLike;
}

interface PumpTradeAnchorEvent {
  creator: PublicKey;
  isBuy: boolean;
  mint: PublicKey;
  quoteAmount: NumberLike;
  solAmount: NumberLike;
  timestamp: NumberLike;
  tokenAmount: NumberLike;
  user: PublicKey;
  virtualSolReserves: NumberLike;
  virtualTokenReserves: NumberLike;
}

function toCreateEvent(
  event: PumpCreateAnchorEvent,
  slot: number,
  signature: string,
): PumpCreateEvent {
  const now = Date.now();
  return {
    blockTimeMs: Number(event.timestamp.toString()) * 1_000,
    bondingCurve: event.bondingCurve.toBase58(),
    creator: event.creator.toBase58(),
    isCashbackEnabled: event.isCashbackEnabled,
    isMayhemMode: event.isMayhemMode,
    kind: "create",
    mint: event.mint.toBase58(),
    name: event.name,
    observedAtMs: now,
    quoteMint: event.quoteMint.toBase58(),
    signature,
    slot,
    symbol: event.symbol,
    tokenProgram: event.tokenProgram.toBase58(),
    tokenTotalSupplyBaseUnits: event.tokenTotalSupply.toString(),
    uri: event.uri,
    virtualSolReservesLamports: event.virtualSolReserves.toString(),
    virtualTokenReservesBaseUnits: event.virtualTokenReserves.toString(),
  };
}

function toTradeEvent(
  event: PumpTradeAnchorEvent,
  slot: number,
  signature: string,
): PumpTradeEvent {
  const now = Date.now();
  return {
    blockTimeMs: Number(event.timestamp.toString()) * 1_000,
    creator: event.creator.toBase58(),
    isBuy: event.isBuy,
    kind: "trade",
    mint: event.mint.toBase58(),
    observedAtMs: now,
    quoteAmountBaseUnits: event.quoteAmount.toString(),
    signature,
    slot,
    solAmountLamports: event.solAmount.toString(),
    tokenAmountBaseUnits: event.tokenAmount.toString(),
    trader: event.user.toBase58(),
    virtualSolReservesLamports: event.virtualSolReserves.toString(),
    virtualTokenReservesBaseUnits: event.virtualTokenReserves.toString(),
  };
}
