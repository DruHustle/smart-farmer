import type { FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { ApiError } from "../context.js";
import { sha256 } from "../security.js";
const permitted = [
  "simulated",
  "connected-awaiting-verification",
  "verified-read-only",
  "verified-control-enabled",
  "offline",
  "degraded",
];
export async function authenticateGateway(db: Pool, req: FastifyRequest) {
  const raw = req.headers.authorization?.match(
    /^Bearer ([A-Za-z0-9_-]{43})$/,
  )?.[1];
  if (!raw) throw new ApiError("unauthorized", 401);
  const asset = (
    await db.query(
      "SELECT * FROM assets WHERE gateway_token_hash=$1 AND gateway_expires_at>clock_timestamp()",
      [sha256(raw)],
    )
  ).rows[0];
  if (!asset || !permitted.includes(asset.integration_state))
    throw new ApiError("unauthorized", 401);
  return asset;
}
export async function lockGateway(c: PoolClient, authenticated: any) {
  const asset = (
    await c.query("SELECT * FROM assets WHERE id=$1 FOR UPDATE", [
      authenticated.id,
    ])
  ).rows[0];
  if (
    !asset ||
    asset.gateway_token_hash !== authenticated.gateway_token_hash ||
    !asset.gateway_expires_at ||
    new Date(asset.gateway_expires_at).getTime() <= Date.now() ||
    !permitted.includes(asset.integration_state)
  )
    throw new ApiError("unauthorized", 401);
  return asset;
}
export const controlEnabled = (asset: any) =>
  asset.integration_state === "simulated" ||
  (asset.integration_state === "verified-control-enabled" &&
    Boolean(asset.model && asset.configuration_hash));
