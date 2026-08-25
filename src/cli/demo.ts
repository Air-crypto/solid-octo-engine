import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection } from "@solana/web3.js";
import { ReplayPumpEventSource } from "../adapters/pump-events.js";
import { StaticPriceOracle } from "../adapters/price-oracle.js";
import { createServer } from "../api/server.js";
import { loadConfig } from "../config.js";
import { ControlPlane } from "../core/control.js";
import { MintDeskEngine } from "../core/engine.js";
import { stableHash } from "../core/hash.js";
import type { PumpEvent, RiskReport } from "../domain/types.js";
import { ShadowExecutor } from "../execution/executors.js";
import type { RiskProvider } from "../risk/types.js";
import { Ledger } from "../storage/ledger.js";

interface ReplayFile {
  events: PumpEvent[];
  riskByMint: Record<string, boolean>;
  solUsd: number;
}

const file = process.argv[2] ?? "fixtures/vsexy-replay.json";
const fixture = JSON.parse(readFileSync(file, "utf8")) as ReplayFile;
const lastFixtureObservation = Math.max(
  ...fixture.events.map((event) => event.observedAtMs),
);
const clockShiftMs = Date.now() - lastFixtureObservation;
const events = fixture.events.map((event) => ({
  ...event,
  blockTimeMs: event.blockTimeMs + clockShiftMs,
  observedAtMs: event.observedAtMs + clockShiftMs,
}));
const baseConfig = loadConfig({ ...process.env, DESK_MODE: "shadow" });
const dbPath = join(mkdtempSync(join(tmpdir(), "solid-octo-demo-")), "demo.db");
const config = { ...baseConfig, dbPath, mode: "shadow" as const };
const ledger = new Ledger(dbPath);
const control = new ControlPlane(ledger, config.policy);
const source = new ReplayPumpEventSource(events);
const oracle = new StaticPriceOracle({
  priceUsd: fixture.solUsd,
  sources: [
    { name: "demo-a", priceUsd: fixture.solUsd },
    { name: "demo-b", priceUsd: fixture.solUsd },
  ],
  spreadPct: 0,
});
const risk: RiskProvider = {
  async assess(state, _policy, nowMs = Date.now()): Promise<RiskReport> {
    const passed = fixture.riskByMint[state.mint] ?? false;
    return {
      checkedAtMs: nowMs,
      checks: [
        {
          detail: "demo fixture",
          name: "fixture_risk",
          status: passed ? "pass" : "fail",
        },
      ],
      mint: state.mint,
      passed,
      rawHash: stableHash({ mint: state.mint, passed }),
      sourceLatencyMs: { fixture: 0 },
      tokenProgram: state.tokenProgram,
    };
  },
};
const replayNow = Math.max(...events.map((event) => event.observedAtMs));
const executor = new ShadowExecutor(
  "DemoWallet111111111111111111111111111111111",
  undefined,
  () => replayNow,
);
const connection = new Connection("http://127.0.0.1:8899");
const engine = new MintDeskEngine(
  "shadow",
  config.policy,
  ledger,
  control,
  source,
  oracle,
  risk,
  executor,
  connection,
);
const app = await createServer(config, engine);
await app.listen({ host: config.host, port: config.port });
await engine.start();
process.stdout.write(
  `Demo dashboard: http://${config.host}:${config.port}\nFixture: ${file}\n`,
);

async function shutdown(): Promise<void> {
  await engine.stop();
  await app.close();
  ledger.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown().finally(() => process.exit(0)));
}
