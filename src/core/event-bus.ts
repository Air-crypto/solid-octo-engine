import { EventEmitter } from "node:events";
import type { DeskEvent } from "../domain/types.js";
import { newId } from "./hash.js";
import type { Ledger } from "../storage/ledger.js";

export class DeskEventBus {
  private readonly emitter = new EventEmitter();

  constructor(private readonly ledger: Ledger) {
    this.emitter.setMaxListeners(100);
  }

  emit<T>(
    role: DeskEvent["role"],
    type: string,
    data: T,
    atMs = Date.now(),
    persist = true,
  ): DeskEvent<T> {
    const event: DeskEvent<T> = { atMs, data, id: newId("evt"), role, type };
    if (persist) this.ledger.appendEvent(event);
    this.emitter.emit("event", event);
    return event;
  }

  emitTransient<T>(
    role: DeskEvent["role"],
    type: string,
    data: T,
    atMs = Date.now(),
  ): DeskEvent<T> {
    return this.emit(role, type, data, atMs, false);
  }

  subscribe(listener: (event: DeskEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
}
