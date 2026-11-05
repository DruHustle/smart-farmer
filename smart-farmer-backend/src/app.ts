import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { isIP } from "node:net";
import type pg from "pg";
import { ApiError, createContext } from "./context.js";
import { registerProduct } from "./product.js";
import { registerOperations } from "./operations.js";
import { registerIdentity } from "./identity.js";
import { registerCore } from "./core.js";
import { registerFarmEdgeRoutes } from "./edge.js";
import { registerLivestock } from "./livestock.js";
import { registerAccounting } from "./accounting/routes.js";
import { registerAccountingDocuments } from "./accounting/documents.js";
import { registerAccountingPdf } from "./accounting/invoice-pdf.js";
import {
  registerIntegrations,
  type IntegrationOptions,
} from "./integrations.js";

export function buildApp(
  db: pg.Pool,
  origin: string,
  integrations: IntegrationOptions = {},
) {
  // Forwarded client addresses are accepted only from explicitly named proxy
  // IPs; a deployment must also ensure its ingress replaces untrusted headers.
  const trustedProxies = (process.env.TRUST_PROXY_IPS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (trustedProxies.length > 8 || trustedProxies.some((value) => !isIP(value)))
    throw new Error("TRUST_PROXY_IPS must contain at most eight exact IP addresses");
  const app = Fastify({
    trustProxy: trustedProxies.length ? trustedProxies : false,
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 32_768,
  });
  app.register(cors, {
    origin: [origin],
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
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
      return reply.code(error.status).send({
        error: error.code,
        ...(error.details && typeof error.details === "object"
          ? error.details
          : {}),
      });
    if (error instanceof z.ZodError)
      return reply.code(400).send({
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
  // The rate-limit plugin installs an onRoute hook during registration. Routes
  // must be added after that hook exists, including their per-route limits.
  app.after(() => {
    app.get("/health", async () => ({ status: "ok" }));
    app.get("/version", async () => ({
      revision: /^[a-f0-9]{40}$/.test(process.env.APP_REVISION ?? "")
        ? process.env.APP_REVISION
        : null,
    }));
    app.get("/ready", async (_req, reply) => {
      try {
        const r = await db.query(
          "SELECT to_regclass('worker_heartbeats') IS NOT NULL AND to_regclass('service_amendments') IS NOT NULL AND to_regclass('storage_scan_cursors') IS NOT NULL AND to_regclass('financial_corrections') IS NOT NULL AND to_regclass('farm_edge_observations') IS NOT NULL AND to_regclass('accounting_invoices') IS NOT NULL AND to_regclass('accounting_documents') IS NOT NULL AND to_regclass('accounting_journals') IS NOT NULL AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='private_media' AND column_name='asset_id') AS ready",
        );
        if (!r.rows[0].ready) throw new Error("Schema not ready");
        return { status: "ok" };
      } catch {
        return reply.code(503).send({ status: "unavailable" });
      }
    });
    const ctx = createContext(db);
    registerIdentity(app, ctx);
    registerFarmEdgeRoutes(app, db, ctx.user, ctx.member);
    registerCore(app, ctx);
    registerLivestock(app, ctx);
    registerIntegrations(app, ctx, integrations);
    registerProduct(app, ctx);
    registerAccounting(app, ctx);
    registerAccountingDocuments(app, ctx);
    registerAccountingPdf(app, ctx);
    registerOperations(app, ctx);
  });
  return app;
}
