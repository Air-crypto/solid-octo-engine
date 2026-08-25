import { describe, expect, it } from "vitest";
import { pumpIdl } from "@pump-fun/pump-sdk";
import { pumpEventKind } from "../src/adapters/pump-events.js";

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
});
