import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";

/** Copy only database-referenced objects and verify the remote bytes before cutover. */
export async function restoreObjects(db, store, directory) {
  const root = resolve(directory);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Restore media must be a regular directory");
  let verified = 0;
  for (const table of [
    "private_media",
    "camera_segments",
    "camera_snapshots",
  ]) {
    if (
      !(await db.query("SELECT to_regclass($1) AS name", [table])).rows[0].name
    )
      continue;
    const rows = (
      await db.query("SELECT object_key,content_hash,size_bytes FROM " + table)
    ).rows;
    for (const item of rows) {
      if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}-[0-9a-f]{64}$/.test(item.object_key))
        throw new Error("Invalid restored object key");
      const parent = await lstat(join(root, item.object_key.split("/")[0]));
      const path = join(root, item.object_key),
        file = await lstat(path);
      if (
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        !file.isFile() ||
        file.isSymbolicLink() ||
        file.size !== Number(item.size_bytes) ||
        file.size > 5242880
      )
        throw new Error("Invalid restored media file");
      const bytes = await readFile(path);
      if (
        createHash("sha256").update(bytes).digest("hex") !== item.content_hash
      )
        throw new Error("Restored media checksum mismatch");
      await store.put(item.object_key, bytes);
      const remote = await store.get(item.object_key);
      if (
        remote.length !== bytes.length ||
        createHash("sha256").update(remote).digest("hex") !== item.content_hash
      )
        throw new Error("Remote restore verification failed");
      verified++;
    }
  }
  return {
    status: "restored_objects_verified",
    verifiedMediaFiles: verified,
    productionCutover: false,
  };
}

async function main() {
  const args = process.argv.slice(2),
    directory = args[args.indexOf("--media-dir") + 1];
  if (
    !args.includes("--media-dir") ||
    !directory ||
    !args.includes("--confirm-isolated-storage")
  )
    throw new Error(
      "Use --media-dir /verified/restore/media --confirm-isolated-storage",
    );
  const connection = process.env.RESTORE_DATABASE_URL,
    bucket = process.env.RESTORE_MEDIA_S3_BUCKET;
  if (
    !connection ||
    !/^\/smart_farmer_restore_[a-z0-9_]+$/.test(new URL(connection).pathname) ||
    connection === process.env.DATABASE_URL
  )
    throw new Error("An isolated restored database is required");
  if (
    !bucket ||
    [process.env.S3_BUCKET, process.env.BACKUP_S3_BUCKET].includes(bucket)
  )
    throw new Error("A separate recovery storage bucket is required");
  if (
    !process.env.RESTORE_MEDIA_S3_ACCESS_KEY_ID ||
    !process.env.RESTORE_MEDIA_S3_SECRET_ACCESS_KEY
  )
    throw new Error("Explicit recovery storage credentials are required");
  const { S3ObjectStore } =
    await import("../dist/integrations/object-store.js");
  const store = new S3ObjectStore({
    bucket,
    region: process.env.RESTORE_MEDIA_S3_REGION || "us-east-1",
    endpoint: process.env.RESTORE_MEDIA_S3_ENDPOINT || undefined,
    accessKeyId: process.env.RESTORE_MEDIA_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.RESTORE_MEDIA_S3_SECRET_ACCESS_KEY,
    sessionToken: process.env.RESTORE_MEDIA_S3_SESSION_TOKEN || undefined,
  });
  const present = await store.client.send(
    new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }),
  );
  if (present.KeyCount && !args.includes("--resume-verified-copy"))
    throw new Error(
      "Recovery bucket must be empty; an interrupted copy may use --resume-verified-copy with immutable checksum verification",
    );
  const db = new pg.Pool({ connectionString: connection });
  try {
    console.log(JSON.stringify(await restoreObjects(db, store, directory)));
  } finally {
    await db.end();
    store.client.destroy();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    console.error(
      "Recovery storage verification failed. Production cutover was not performed; inspect the isolated target and protected configuration.",
    );
    process.exitCode = 1;
  });
}
