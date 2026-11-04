import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { ApiError, audit } from "../context.js";
import {
  authorize,
  managers,
  recorders,
  requireRow,
  uuid,
  type Context,
} from "./common.js";
import { getObjectStore } from "./object-store.js";
import { requireStorageSpace } from "./storage-quota.js";
import { listQuery, paged } from "../operations/common.js";
export {
  FileObjectStore,
  S3ObjectStore,
  getObjectStore,
  type ObjectStore,
} from "./object-store.js";

const mime = z.enum([
  "image/jpeg",
  "image/png",
  "image/webp",
  "audio/mp4",
  "audio/mpeg",
  "audio/webm",
  "audio/wav",
  "application/pdf",
]);
function validSignature(type: z.infer<typeof mime>, data: Buffer) {
  if (data.length < 12) return false;
  switch (type) {
    case "image/jpeg":
      return data[0] === 255 && data[1] === 216 && data[2] === 255;
    case "image/png":
      return data
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case "image/webp":
      return (
        data.toString("ascii", 0, 4) === "RIFF" &&
        data.toString("ascii", 8, 12) === "WEBP"
      );
    case "audio/mp4":
      return data.toString("ascii", 4, 8) === "ftyp";
    case "audio/mpeg":
      return (
        data.toString("ascii", 0, 3) === "ID3" ||
        (data[0] === 255 && (data[1] & 224) === 224)
      );
    case "audio/webm":
      return data.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
    case "audio/wav":
      return (
        data.toString("ascii", 0, 4) === "RIFF" &&
        data.toString("ascii", 8, 12) === "WAVE"
      );
    case "application/pdf":
      return (
        /^%PDF-(1\.[0-9]|2\.0)/.test(data.toString("ascii", 0, 8)) &&
        data
          .subarray(Math.max(0, data.length - 1024))
          .includes(Buffer.from("%%EOF"))
      );
  }
}
export function registerMedia(app: FastifyInstance, ctx: Context) {
  const store = getObjectStore();
  async function assetAccess(
    client: PoolClient,
    farmId: string,
    userId: string,
    assetId: string,
  ) {
    return requireRow(
      (
        await client.query(
          "SELECT a.id FROM assets a JOIN memberships m ON m.farm_id=a.farm_id AND m.user_id=$3 WHERE a.farm_id=$1 AND a.id=$2 AND (a.category<>'camera' OR m.role IN ('owner','manager') OR EXISTS(SELECT 1 FROM camera_access ca WHERE ca.asset_id=a.id AND ca.user_id=$3))",
          [farmId, assetId, userId],
        )
      ).rows[0],
    );
  }
  app.post(
    "/v1/farms/:farmId/media",
    {
      bodyLimit: 7_100_000,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const auth = await authorize(ctx, req, reply, [...recorders, "adviser"]);
      if (!auth) return;
      const data = z
        .object({
          id: uuid,
          activityId: uuid.nullable().default(null),
          assetId: uuid.nullable().default(null),
          financial: z.boolean().default(false),
          mimeType: mime,
          dataBase64: z.string().min(1).max(6_990_508),
          filename: z
            .string()
            .trim()
            .min(1)
            .max(150)
            .regex(/^[^\x00-\x1f/\\]+$/)
            .default("attachment"),
        })
        .strict()
        .refine(
          (v) => Boolean(v.activityId) !== Boolean(v.assetId),
          "one_media_parent_required",
        )
        .parse(req.body);
      const bytes = Buffer.from(data.dataBase64, "base64");
      if (
        bytes.length > 5 * 1024 * 1024 ||
        bytes.toString("base64") !== data.dataBase64 ||
        !validSignature(data.mimeType, bytes)
      )
        throw new ApiError("invalid_media");
      const fingerprint = createHash("sha256").update(bytes).digest("hex");
      const replayed = await ctx.transaction(async (client) => {
        await client.query("SELECT id FROM farms WHERE id=$1 FOR UPDATE", [
          auth.farmId,
        ]);
        const financialAccess = await ctx.member(
          auth.farmId,
          auth.userId,
          managers,
        );
        if (data.financial && !financialAccess)
          throw new ApiError("not_found", 404);
        if (data.activityId) {
          const activity = requireRow(
            (
              await client.query(
                "SELECT a.actor_id,(a.kind='cost' OR EXISTS(SELECT 1 FROM financial_entries f WHERE f.farm_id=a.farm_id AND f.receipt_activity_id=a.id)) AS financial FROM activities a WHERE a.farm_id=$1 AND a.id=$2",
                [auth.farmId, data.activityId],
              )
            ).rows[0],
          );
          if (
            (activity.actor_id !== auth.userId || activity.financial) &&
            !financialAccess
          )
            throw new ApiError("not_found", 404);
        } else
          await assetAccess(client, auth.farmId, auth.userId, data.assetId!);
        const previous = (
          await client.query("SELECT * FROM private_media WHERE id=$1", [
            data.id,
          ])
        ).rows[0];
        if (previous) {
          if (
            previous.farm_id !== auth.farmId ||
            previous.actor_id !== auth.userId ||
            previous.activity_id !== data.activityId ||
            previous.asset_id !== data.assetId ||
            previous.financial !== data.financial ||
            previous.mime_type !== data.mimeType ||
            previous.content_hash !== fingerprint ||
            previous.filename !== data.filename
          )
            throw new ApiError("idempotency_conflict", 409);
          return true;
        }
        await requireStorageSpace(client, auth.farmId, "field", bytes.length);
        const key = `${auth.farmId}/${data.id}-${fingerprint}`;
        await store.put(key, bytes);
        await client.query(
          "INSERT INTO private_media(id,farm_id,activity_id,asset_id,financial,actor_id,mime_type,size_bytes,content_hash,object_key,filename) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [
            data.id,
            auth.farmId,
            data.activityId,
            data.assetId,
            data.financial,
            auth.userId,
            data.mimeType,
            bytes.length,
            fingerprint,
            key,
            data.filename,
          ],
        );
        return false;
      });
      return reply
        .code(replayed ? 200 : 201)
        .send({
          id: data.id,
          activityId: data.activityId,
          assetId: data.assetId,
          financial: data.financial,
          mimeType: data.mimeType,
          sizeBytes: bytes.length,
          status: "stored",
        });
    },
  );
  app.get("/v1/farms/:farmId/media", async (req, reply) => {
    const auth = await authorize(ctx, req, reply);
    if (!auth) return;
    const query = listQuery
      .extend({ activityId: uuid.optional(), assetId: uuid.optional() })
      .refine((v) => !v.activityId || !v.assetId)
      .parse(req.query);
    const canFinance = await ctx.member(auth.farmId, auth.userId, managers);
    const rows = (
      await ctx.db.query(
        `SELECT m.id,m.activity_id,m.asset_id,m.financial,m.mime_type,m.size_bytes,m.filename,m.created_at
      FROM private_media m LEFT JOIN activities a ON a.farm_id=m.farm_id AND a.id=m.activity_id LEFT JOIN assets s ON s.farm_id=m.farm_id AND s.id=m.asset_id
      WHERE m.farm_id=$1 AND ($2::uuid IS NULL OR m.activity_id=$2) AND ($6::uuid IS NULL OR m.asset_id=$6)
      AND ($3::boolean OR (NOT m.financial AND (a.id IS NULL OR (a.kind<>'cost' AND NOT EXISTS(SELECT 1 FROM financial_entries f WHERE f.farm_id=a.farm_id AND f.receipt_activity_id=a.id)))))
      AND (s.id IS NULL OR s.category<>'camera' OR $3::boolean OR EXISTS(SELECT 1 FROM camera_access ca WHERE ca.asset_id=s.id AND ca.user_id=$7))
      AND ($4::uuid IS NULL OR m.id>$4) ORDER BY m.id LIMIT $5`,
        [
          auth.farmId,
          query.activityId ?? null,
          canFinance,
          query.cursor ?? null,
          query.limit + 1,
          query.assetId ?? null,
          auth.userId,
        ],
      )
    ).rows;
    return paged(rows, query.limit);
  });
  app.get("/v1/farms/:farmId/media/:mediaId/content", async (req, reply) => {
    const auth = await authorize(ctx, req, reply);
    if (!auth) return;
    const { mediaId } = z.object({ mediaId: uuid }).parse(req.params);
    const media = requireRow(
      (
        await ctx.db.query(
          `SELECT m.*,a.kind,s.category,EXISTS(SELECT 1 FROM financial_entries f WHERE f.farm_id=a.farm_id AND f.receipt_activity_id=a.id) AS financial_receipt,
      EXISTS(SELECT 1 FROM camera_access ca WHERE ca.asset_id=s.id AND ca.user_id=$3) AS camera_granted
      FROM private_media m LEFT JOIN activities a ON a.farm_id=m.farm_id AND a.id=m.activity_id LEFT JOIN assets s ON s.farm_id=m.farm_id AND s.id=m.asset_id WHERE m.farm_id=$1 AND m.id=$2`,
          [auth.farmId, mediaId, auth.userId],
        )
      ).rows[0],
    );
    const financialAccess = await ctx.member(
      auth.farmId,
      auth.userId,
      managers,
    );
    if (
      !financialAccess &&
      (media.financial ||
        media.kind === "cost" ||
        media.financial_receipt ||
        (media.category === "camera" && !media.camera_granted))
    )
      throw new ApiError("not_found", 404);
    let bytes: Buffer;
    try {
      bytes = await store.get(media.object_key);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new ApiError("media_unavailable", 503);
      throw error;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== media.content_hash)
      throw new ApiError("media_integrity_error", 503);
    await ctx.transaction((client) =>
      audit(
        client,
        auth.farmId,
        auth.userId,
        "media",
        mediaId,
        "content_accessed",
        "authorised_private_download",
      ),
    );
    return reply
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .header(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(media.filename)}`,
      )
      .type(media.mime_type)
      .send(bytes);
  });
}
