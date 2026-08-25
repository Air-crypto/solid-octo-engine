import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { ReplayPumpEventSource } from "../adapters/pump-events.js";
import { StaticPriceOracle } from "../adapters/price-oracle.js";
import { ControlPlane } from "../core/control.js";
import { MintDeskEngine } from "../core/engine.js";
import { stableHash } from "../core/hash.js";
import type { PumpEvent, RiskReport } from "../domain/types.js";
import { ShadowExecutor } from "../execution/executors.js";
import type { RiskProvider } from "../risk/types.js";
import { RpcRateController } from "../rpc/rate-controller.js";
import { Ledger } from "../storage/ledger.js";

interface ReplayFile {
  events: PumpEvent[];
  riskByMint: Record<string, boolean>;
  solUsd: number;
}

const file = process.argv[2];
if (!file)
  throw new Error("usage: npm run replay -- fixtures/vsexy-replay.json");
const fixture = JSON.parse(readFileSync(file, "utf8")) as ReplayFile;
const baseConfig = loadConfig({ ...process.env, DESK_MODE: "shadow" });
const dbPath = join(
  mkdtempSync(join(tmpdir(), "solid-octo-replay-")),
  "replay.db",
);
const ledger = new Ledger(dbPath);
const control = new ControlPlane(ledger, baseConfig.policy);
const source = new ReplayPumpEventSource(fixture.events);
const oracle = new StaticPriceOracle({
  priceUsd: fixture.solUsd,
  sources: [
    { name: "replay-a", priceUsd: fixture.solUsd },
    { name: "replay-b", priceUsd: fixture.solUsd },
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
          detail: "fixture",
          name: "fixture_risk",
          status: passed ? "pass" : "fail",
        },
      ],
      evidence: { onChain: {}, rugcheck: {} },
      mint: state.mint,
      passed,
      rawHash: stableHash({ mint: state.mint, passed }),
      sourceLatencyMs: { fixture: 0 },
      tokenProgram: state.tokenProgram,
    };
  },
};
const replayNow = Math.max(
  ...fixture.events.map((event) => event.observedAtMs),
);
const executor = new ShadowExecutor(
  "ReplayWallet11111111111111111111111111111111",
  undefined,
  () => replayNow,
);
const connection = new Connection("http://127.0.0.1:8899");
const engine = new MintDeskEngine(
  "shadow",
  baseConfig.policy,
  ledger,
  control,
  source,
  oracle,
  risk,
  executor,
  connection,
  new RpcRateController(100),
);
await engine.start();
process.stdout.write(`${JSON.stringify(engine.snapshot(), null, 2)}\n`);
await engine.stop();
ledger.close();
