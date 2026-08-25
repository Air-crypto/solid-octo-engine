import { Connection } from "@solana/web3.js";
import { loadConfig } from "./config.js";
import { AnchorPumpEventSource } from "./adapters/pump-events.js";
import { MedianSolPriceOracle } from "./adapters/price-oracle.js";
import { createServer } from "./api/server.js";
import { ControlPlane } from "./core/control.js";
import { MintDeskEngine } from "./core/engine.js";
import { buildExecutor } from "./execution/executors.js";
import { PumpApiTransactionBuilder } from "./execution/pump-builder.js";
import { SolanaRiskProvider } from "./risk/solana-risk.js";
import { Ledger } from "./storage/ledger.js";
import { RpcRateController } from "./rpc/rate-controller.js";

const config = loadConfig();
const ledger = new Ledger(
  config.dbPath,
  config.eventRetentionMs,
  config.eventMaxRows,
);
const control = new ControlPlane(ledger, config.policy, config.armToken);
const rpc = new RpcRateController(config.rpcMaxRequestsPerSecond);
const connection = new Connection(config.rpcHttpUrl, {
  commitment: "processed",
  confirmTransactionInitialTimeout: 10_000,
  disableRetryOnRateLimit: true,
  fetch: rpc.fetch,
  wsEndpoint: config.rpcWsUrl,
});
const prices = new MedianSolPriceOracle();
const risk = new SolanaRiskProvider(connection, config.rugcheckBaseUrl);
const builder = new PumpApiTransactionBuilder();
const executor = buildExecutor({
  builder,
  connection,
  control,
  expectedWallet: config.expectedSignerPublicKey,
  keypairPath: config.executionKeypairPath,
  mode: config.mode,
});

let lastSlotAtMs = 0;
let engine: MintDeskEngine;
const source = new AnchorPumpEventSource(
  connection,
  (slot, atMs) => {
    lastSlotAtMs = atMs;
    engine.health.heartbeat("eventStream", `slot ${slot}`, atMs);
  },
  (error, sourceName) => engine.markSourceDegraded(error, sourceName),
  {
    get: () => ledger.getControl<string | null>("pumpCheckpoint", null),
    set: (signature) => ledger.setControl("pumpCheckpoint", signature),
  },
);
engine = new MintDeskEngine(
  config.mode,
  config.policy,
  ledger,
  control,
  source,
  prices,
  risk,
  executor,
  connection,
  rpc,
);
const app = await createServer(config, engine);
await app.listen({ host: config.host, port: config.port });
await engine.start();

const watchdog = setInterval(() => {
  if (lastSlotAtMs > 0 && Date.now() - lastSlotAtMs > 15_000) {
    engine.health.set(
      "eventStream",
      "down",
      "no slot heartbeat for 15 seconds",
    );
    if (config.mode === "live")
      void engine
        .engageKillSwitch("event_stream_stale")
        .catch((error) => engine.markSourceDegraded(error, "watchdog_kill"));
  }
}, 5_000);

async function shutdown(signal: string): Promise<void> {
  clearInterval(watchdog);
  engine.bus.emit("system", "engine.shutdown", { signal });
  await engine.stop();
  await app.close();
  ledger.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(
    signal,
    () => void shutdown(signal).finally(() => process.exit(0)),
  );
}
