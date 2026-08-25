import type { Connection, Logs, PublicKey } from "@solana/web3.js";
import { BorshCoder, EventParser } from "@coral-xyz/anchor";
import { PUMP_PROGRAM_ID, pumpIdl } from "@pump-fun/pump-sdk";
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
  private logsListener: number | null = null;
  private slotListener: number | null = null;
  private catchingUp = false;
  private liveGeneration = 0;
  private lastSlotAtMs = 0;
  private readonly parser = new EventParser(
    PUMP_PROGRAM_ID,
    new BorshCoder(pumpIdl as never),
  );

  constructor(
    private readonly connection: Connection,
    private readonly onHeartbeat: (slot: number, atMs: number) => void = () =>
      undefined,
    private readonly onError: (error: unknown, source: string) => void = () =>
      undefined,
    private readonly checkpoint: {
      get(): string | null;
      set(signature: string): void;
    } = { get: () => null, set: () => undefined },
  ) {}

  async start(handler: EventHandler): Promise<void> {
    if (this.logsListener !== null)
      throw new Error("Pump event source already started");
    this.logsListener = this.connection.onLogs(
      PUMP_PROGRAM_ID,
      (logs, context) =>
        void this.handleLogs(handler, logs, context.slot).catch((error) =>
          this.onError(error, "pump_logs"),
        ),
      "processed",
    );
    this.slotListener = this.connection.onSlotChange(({ slot }) => {
      const nowMs = Date.now();
      const recoveredFromGap =
        this.lastSlotAtMs > 0 && nowMs - this.lastSlotAtMs > 5_000;
      this.lastSlotAtMs = nowMs;
      this.onHeartbeat(slot, nowMs);
      if (recoveredFromGap) void this.safeCatchUp(handler, "slot_gap");
    });
    await this.safeCatchUp(handler, "startup");
  }

  async stop(): Promise<void> {
    const removals: Promise<void>[] = [];
    if (this.logsListener !== null)
      removals.push(this.connection.removeOnLogsListener(this.logsListener));
    if (this.slotListener !== null)
      removals.push(
        this.connection.removeSlotChangeListener(this.slotListener),
      );
    await Promise.allSettled(removals);
    this.logsListener = null;
    this.slotListener = null;
    this.lastSlotAtMs = 0;
  }

  private async handleLogs(
    handler: EventHandler,
    notification: Logs,
    slot: number,
  ): Promise<void> {
    if (notification.err) return;
    this.liveGeneration += 1;
    // Persist receipt order before awaiting downstream work. A slow risk check
    // must not let an older callback overwrite a newer live checkpoint.
    this.checkpoint.set(notification.signature);
    await this.parseAndHandle(
      handler,
      notification.logs,
      slot,
      notification.signature,
    );
  }

  private async safeCatchUp(
    handler: EventHandler,
    source: string,
  ): Promise<void> {
    try {
      await this.catchUp(handler);
    } catch (error) {
      this.onError(error, `catchup_${source}`);
    }
  }

  private async catchUp(handler: EventHandler): Promise<void> {
    if (this.catchingUp) return;
    const until = this.checkpoint.get();
    if (!until) return;
    this.catchingUp = true;
    const generationAtStart = this.liveGeneration;
    try {
      const signatures = await this.connection.getSignaturesForAddress(
        PUMP_PROGRAM_ID,
        { limit: 100, until },
        "confirmed",
      );
      let newestCatchUpSignature: string | null = null;
      for (const item of signatures.reverse()) {
        const transaction = await this.connection.getTransaction(
          item.signature,
          { commitment: "confirmed", maxSupportedTransactionVersion: 0 },
        );
        if (transaction?.meta?.err || !transaction?.meta?.logMessages) continue;
        await this.parseAndHandle(
          handler,
          transaction.meta.logMessages,
          transaction.slot,
          item.signature,
        );
        newestCatchUpSignature = item.signature;
      }
      if (newestCatchUpSignature && this.liveGeneration === generationAtStart)
        this.checkpoint.set(newestCatchUpSignature);
    } finally {
      this.catchingUp = false;
    }
  }

  private async parseAndHandle(
    handler: EventHandler,
    logs: string[],
    slot: number,
    signature: string,
  ): Promise<void> {
    try {
      for (const parsed of this.parser.parseLogs(logs)) {
        const kind = pumpEventKind(parsed.name);
        if (kind === "create") {
          await handler(
            toCreateEvent(
              parsed.data as unknown as PumpCreateAnchorEvent,
              slot,
              signature,
            ),
          );
        } else if (kind === "trade") {
          await handler(
            toTradeEvent(
              parsed.data as unknown as PumpTradeAnchorEvent,
              slot,
              signature,
            ),
          );
        }
      }
    } catch (error) {
      this.onError(error, "event_parser");
    }
  }
}

export function pumpEventKind(name: string): "create" | "trade" | null {
  const normalized = name.toLowerCase();
  if (normalized === "createevent") return "create";
  if (normalized === "tradeevent") return "trade";
  return null;
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
