import type { ComponentHealth } from "../domain/types.js";

export class HealthRegistry {
  private readonly components = new Map<string, ComponentHealth>();

  set(
    name: string,
    status: ComponentHealth["status"],
    detail: string,
    nowMs = Date.now(),
  ): void {
    this.components.set(name, {
      detail,
      lastOkAtMs:
        status === "ok"
          ? nowMs
          : (this.components.get(name)?.lastOkAtMs ?? null),
      status,
    });
  }

  heartbeat(name: string, detail = "healthy", nowMs = Date.now()): void {
    this.set(name, "ok", detail, nowMs);
  }

  snapshot(): Record<string, ComponentHealth> {
    return Object.fromEntries(this.components);
  }
}
