import type { PoolClient } from "pg";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { z } from "zod";
import { ApiError } from "../context.js";
export {
  authorize,
  managers,
  recorders,
  uuid,
  instant,
  hash,
  operationLock,
  requireRow,
} from "../integrations/common.js";
export const listQuery = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const text = z.string().trim().min(1).max(2000);
export function paged(rows: any[], limit: number) {
  return {
    items: rows.slice(0, limit),
    nextCursor: rows.length > limit ? rows[limit - 1].id : null,
  };
}
export function checkVersion(row: any, version: number) {
  if (row.version !== version)
    throw new ApiError("version_conflict", 409, { current: row });
}
export async function memberExists(
  c: PoolClient,
  farmId: string,
  userId: string | null | undefined,
) {
  if (
    userId &&
    !(
      await c.query(
        "SELECT 1 FROM memberships WHERE farm_id=$1 AND user_id=$2 FOR KEY SHARE",
        [farmId, userId],
      )
    ).rowCount
  )
    throw new ApiError("related_record_not_found", 404);
}
export function validateInstant(value: string) {
  if (Date.parse(value) > Date.now() + 300000)
    throw new ApiError("future_observation");
}
export function secretConfigured() {
  return /^[0-9a-f]{64}$/i.test(process.env.PROVIDER_SECRET_KEY || "");
}
function key() {
  if (!secretConfigured()) throw new ApiError("provider_unconfigured", 409);
  return Buffer.from(process.env.PROVIDER_SECRET_KEY!, "hex");
}
export function sealSecret(value: string, context: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(context));
  return {
    iv: iv.toString("base64"),
    data: Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]).toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}
export function openSecret(value: any, context: string) {
  const cipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(value.iv, "base64"),
  );
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([
    cipher.update(Buffer.from(value.data, "base64")),
    cipher.final(),
  ]).toString("utf8");
}
export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export function safeEndpoint(value: string, allowTest = false) {
  const u = new URL(value);
  if (u.username || u.password || u.hash)
    throw new ApiError("invalid_provider_endpoint");
  if (
    u.protocol !== "https:" &&
    !(
      allowTest &&
      process.env.NODE_ENV === "test" &&
      u.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(u.hostname)
    )
  )
    throw new ApiError("https_required");
  return u;
}
export async function fetchJson(
  url: URL | string,
  options: RequestInit = {},
  timeout = 10000,
) {
  const response = await fetch(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok)
    throw new ApiError(
      response.status === 429
        ? "provider_rate_limited"
        : "provider_unavailable",
      503,
    );
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body?.getReader();
  if (reader)
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > 2_000_000) {
          await reader.cancel();
          throw new ApiError("provider_response_too_large", 502);
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError("invalid_provider_response", 502);
  }
}
export const defaultSettings = {
  weatherEnabled: false,
  latitude: null as number | null,
  longitude: null as number | null,
  fishHatcheryEnabled: false,
  mediaRetentionDays: null as number | null,
  cameraRetentionDays: 7,
  aiEnabled: false,
  dataSharingEnabled: false,
};
export function settings(row: any) {
  return {
    ...defaultSettings,
    ...row.operations_settings,
    timezone: row.timezone,
  };
}
