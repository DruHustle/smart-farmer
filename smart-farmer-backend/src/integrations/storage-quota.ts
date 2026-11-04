import type { Pool, PoolClient } from "pg";
import { ApiError } from "../context.js";

export function storageQuota(kind: "field" | "camera") {
  const name =
    kind === "field" ? "MEDIA_FARM_QUOTA_BYTES" : "CAMERA_FARM_QUOTA_BYTES";
  const value = Number(
    process.env[name] || (kind === "field" ? 262144000 : 524288000),
  );
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`Invalid ${name}`);
  return value;
}

export async function storageUsage(db: Pool | PoolClient, farmId: string) {
  const row = (
    await db.query(
      `SELECT
    (SELECT COALESCE(sum(size_bytes),0) FROM private_media WHERE farm_id=$1) AS media,
    (SELECT COALESCE(sum(size_bytes),0) FROM camera_segments WHERE farm_id=$1) +
    (SELECT COALESCE(sum(size_bytes),0) FROM camera_snapshots WHERE farm_id=$1) AS camera,
    (SELECT COALESCE(sum(size_bytes),0) FROM object_garbage WHERE farm_id=$1 AND deleted_at IS NULL AND media_kind IN ('field','unknown')) AS pending_media,
    (SELECT COALESCE(sum(size_bytes),0) FROM object_garbage WHERE farm_id=$1 AND deleted_at IS NULL AND media_kind IN ('camera','unknown')) AS pending_camera`,
      [farmId],
    )
  ).rows[0];
  return {
    media: Number(row.media),
    camera: Number(row.camera),
    pendingMedia: Number(row.pending_media),
    pendingCamera: Number(row.pending_camera),
  };
}

/** Caller holds the farm row lock. Retired bytes remain charged until deletion succeeds. */
export async function requireStorageSpace(
  db: PoolClient,
  farmId: string,
  kind: "field" | "camera",
  bytes: number,
) {
  const used = await storageUsage(db, farmId);
  const charged =
    kind === "field"
      ? used.media + used.pendingMedia
      : used.camera + used.pendingCamera;
  if (charged + bytes > storageQuota(kind))
    throw new ApiError(
      kind === "field" ? "media_quota_exceeded" : "camera_quota_exceeded",
      409,
    );
}
