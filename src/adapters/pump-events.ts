import type { Connection, Logs } from "@solana/web3.js";
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
  private lastParserErrorAtMs = 0;
  private parserErrorsSinceReport = 0;
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
    let parsedEvents: Array<{ data: unknown; name: string }>;
    try {
      parsedEvents = [...this.parser.parseLogs(logs)];
    } catch (error) {
      this.reportParserError(error, "log_envelope");
      return;
    }
    for (const parsed of parsedEvents) {
      let event: PumpEvent | null = null;
      try {
        const kind = pumpEventKind(parsed.name);
        if (kind === "create")
          event = toCreateEvent(parsed.data, slot, signature);
        else if (kind === "trade")
          event = toTradeEvent(parsed.data, slot, signature);
      } catch (error) {
        this.reportParserError(error, parsed.name);
        continue;
      }
      if (event) await handler(event);
    }
  }

  private reportParserError(error: unknown, eventName: string): void {
    this.parserErrorsSinceReport += 1;
    const nowMs = Date.now();
    if (nowMs - this.lastParserErrorAtMs < 60_000) return;
    const count = this.parserErrorsSinceReport;
    this.parserErrorsSinceReport = 0;
    this.lastParserErrorAtMs = nowMs;
    const detail = error instanceof Error ? error.message : String(error);
    this.onError(
      new Error(
        `${eventName}: ${detail}; ${count} parser error(s) since report`,
      ),
      "event_parser",
    );
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

export function toCreateEvent(
  rawEvent: unknown,
  slot: number,
  signature: string,
): PumpCreateEvent {
  const event = eventRecord(rawEvent, "CreateEvent");
  const now = Date.now();
  return {
    blockTimeMs: timestampMs(field(event, "timestamp")),
    bondingCurve: base58(field(event, "bondingCurve", "bonding_curve")),
    creator: base58(field(event, "creator")),
    isCashbackEnabled: booleanField(
      field(event, "isCashbackEnabled", "is_cashback_enabled"),
    ),
    isMayhemMode: booleanField(field(event, "isMayhemMode", "is_mayhem_mode")),
    kind: "create",
    mint: base58(field(event, "mint")),
    name: stringField(field(event, "name")),
    observedAtMs: now,
    quoteMint: base58(field(event, "quoteMint", "quote_mint")),
    signature,
    slot,
    symbol: stringField(field(event, "symbol")),
    tokenProgram: base58(field(event, "tokenProgram", "token_program")),
    tokenTotalSupplyBaseUnits: integerString(
      field(event, "tokenTotalSupply", "token_total_supply"),
    ),
    uri: stringField(field(event, "uri")),
    virtualSolReservesLamports: integerString(
      field(event, "virtualSolReserves", "virtual_sol_reserves"),
    ),
    virtualTokenReservesBaseUnits: integerString(
      field(event, "virtualTokenReserves", "virtual_token_reserves"),
    ),
  };
}

export function toTradeEvent(
  rawEvent: unknown,
  slot: number,
  signature: string,
): PumpTradeEvent {
  const event = eventRecord(rawEvent, "TradeEvent");
  const now = Date.now();
  const solAmount = field(event, "solAmount", "sol_amount");
  return {
    blockTimeMs: timestampMs(field(event, "timestamp")),
    creator: base58(field(event, "creator")),
    isBuy: booleanField(field(event, "isBuy", "is_buy")),
    kind: "trade",
    mint: base58(field(event, "mint")),
    observedAtMs: now,
    quoteAmountBaseUnits: integerString(
      optionalField(event, "quoteAmount", "quote_amount") ?? solAmount,
    ),
    signature,
    slot,
    solAmountLamports: integerString(solAmount),
    tokenAmountBaseUnits: integerString(
      field(event, "tokenAmount", "token_amount"),
    ),
    trader: base58(field(event, "user")),
    virtualSolReservesLamports: integerString(
      field(event, "virtualSolReserves", "virtual_sol_reserves"),
    ),
    virtualTokenReservesBaseUnits: integerString(
      field(event, "virtualTokenReserves", "virtual_token_reserves"),
    ),
  };
}

function eventRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${name} payload is not an object`);
  return value as Record<string, unknown>;
}

function optionalField(
  event: Record<string, unknown>,
  camelName: string,
  snakeName = camelName,
): unknown {
  return event[camelName] ?? event[snakeName];
}

function field(
  event: Record<string, unknown>,
  camelName: string,
  snakeName = camelName,
): unknown {
  const value = optionalField(event, camelName, snakeName);
  if (value == null) throw new Error(`event field ${snakeName} is missing`);
  return value;
}

function base58(value: unknown): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "toBase58" in value &&
    typeof value.toBase58 === "function"
  )
    return value.toBase58() as string;
  throw new Error("event public key is malformed");
}

function integerString(value: unknown): string {
  if (
    typeof value === "bigint" ||
    typeof value === "number" ||
    typeof value === "string"
  )
    return String(value);
  if (
    typeof value === "object" &&
    value !== null &&
    "toString" in value &&
    typeof value.toString === "function"
  )
    return value.toString();
  throw new Error("event integer is malformed");
}

function timestampMs(value: unknown): number {
  const timestamp = Number(integerString(value));
  if (!Number.isSafeInteger(timestamp))
    throw new Error("event timestamp is malformed");
  return timestamp * 1_000;
}

function stringField(value: unknown): string {
  if (typeof value !== "string") throw new Error("event string is malformed");
  return value;
}

function booleanField(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("event boolean is malformed");
  return value;
}
