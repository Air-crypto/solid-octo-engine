import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { MintDeskEngine } from "../core/engine.js";

const armSchema = z.object({
  leaseMs: z.number().int().positive(),
  token: z.string(),
});
const tokenSchema = z.object({ token: z.string() });
const confirmSchema = z.object({ signature: z.string().min(40).max(128) });

export async function createServer(config: AppConfig, engine: MintDeskEngine) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  await app.register(cors, { origin: false });

  app.get("/api/config", async () => ({
    expectedSignerPublicKey: config.expectedSignerPublicKey ?? null,
    mode: config.mode,
    policy: config.policy,
  }));
  app.get("/api/snapshot", async () => engine.snapshot());
  app.get("/api/health", async () => ({
    control: engine.control.snapshot(),
    health: engine.health.snapshot(),
    mode: engine.mode,
  }));
  app.get("/api/manual/pending", async () => {
    if (engine.mode !== "manual") return [];
    return engine.ledger.pendingManualExecutions();
  });

  app.get("/api/events", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    });
    for (const event of engine.ledger.recentEvents(50))
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    const unsubscribe = engine.bus.subscribe((event) =>
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`),
    );
    const heartbeat = setInterval(
      () => reply.raw.write(": heartbeat\n\n"),
      15_000,
    );
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.end();
    });
  });

  app.post("/api/control/arm", async (request, reply) => {
    try {
      const body = armSchema.parse(request.body);
      return { armedUntilMs: engine.control.arm(body.token, body.leaseMs) };
    } catch (error) {
      return reply.code(403).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.post("/api/control/disarm", async () => {
    engine.control.disarm();
    return { ok: true };
  });
  app.post("/api/control/kill", async () => {
    await engine.engageKillSwitch("manual_control");
    return { ok: true };
  });
  app.post("/api/control/release", async (request, reply) => {
    try {
      const body = tokenSchema.parse(request.body);
      engine.control.releaseKillSwitch(body.token);
      engine.bus.emit("head", "control.kill_switch", { engaged: false });
      return { ok: true };
    } catch (error) {
      return reply.code(403).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.post("/api/manual/:intentId/confirm", async (request, reply) => {
    try {
      const { intentId } = request.params as { intentId: string };
      const { signature } = confirmSchema.parse(request.body);
      return await engine.confirmManual(intentId, signature);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const dashboardPath = resolve("apps/dashboard/dist");
  if (existsSync(dashboardPath)) {
    await app.register(fastifyStatic, { root: dashboardPath });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/"))
        return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  } else {
    app.get("/", async (_request, reply) =>
      reply
        .type("text/plain")
        .send("Dashboard is not built. Run npm run build:dashboard."),
    );
  }
  return app;
}
