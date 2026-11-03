import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import type pg from "pg";
import { ApiError, createContext } from "./context.js";
import { registerProduct } from "./product.js";
import { registerOperations } from "./operations.js";
import { registerIdentity } from "./identity.js";
import { registerCore } from "./core.js";
import { registerLivestock } from "./livestock.js";
import { registerIntegrations } from "./integrations.js";

export function buildApp(db: pg.Pool, origin: string) {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 32_768,
  });
  app.register(cors, {
    origin,
    credentials: true,
    exposedHeaders: ["X-Observed-At", "X-Media-Source", "Content-Disposition"],
  });
  app.register(rateLimit, { max: 600, timeWindow: "1 minute" });
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cache-Control", "no-store");
    return payload;
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ApiError)
      return reply
        .code(error.status)
        .send({
          error: error.code,
          ...(error.details && typeof error.details === "object"
            ? error.details
            : {}),
        });
    if (error instanceof z.ZodError)
      return reply
        .code(400)
        .send({
          error: "invalid_input",
          details: error.issues.map((i) => ({
            path: i.path,
            message: i.message,
          })),
        });
    const pgError = error as { code?: string; detail?: string };
    if (pgError.code === "23503")
      return reply.code(404).send({ error: "related_record_not_found" });
    if (pgError.code === "23505")
      return reply.code(409).send({ error: "record_conflict" });
    if (pgError.code === "23514" || pgError.code === "22003")
      return reply.code(400).send({ error: "invalid_input" });
    if (pgError.code === "40P01" || pgError.code === "40001")
      return reply.code(409).send({ error: "retry_transaction" });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500)
      return reply
        .code(status)
        .send({ error: status === 429 ? "rate_limited" : "invalid_request" });
    app.log.error(error);
    return reply.code(500).send({ error: "internal_error" });
  });
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_req, reply) => {
    try {
      const r = await db.query(
        "SELECT to_regclass('worker_heartbeats') IS NOT NULL AND to_regclass('service_amendments') IS NOT NULL AND to_regclass('storage_scan_cursors') IS NOT NULL AS ready",
      );
      if (!r.rows[0].ready) throw new Error("Schema not ready");
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });
  const ctx = createContext(db);
  registerIdentity(app, ctx);
  registerCore(app, ctx);
  registerLivestock(app, ctx);
  registerIntegrations(app, ctx);
  registerProduct(app, ctx);
  registerOperations(app, ctx);
  return app;
}
