import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import pg from "pg";
async function digest(stream) {
  const h = createHash("sha256");
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    h.update(chunk);
  }
  return { hash: h.digest("hex"), bytes };
}
export async function uploadVerifiedBackup(path, options) {
  if (!options.bucket || !options.accessKeyId || !options.secretAccessKey)
    throw new Error("Independent backup bucket and credentials required");
  if (options.endpoint) {
    const u = new URL(options.endpoint);
    if (
      (u.protocol !== "https:" &&
        !(
          process.env.NODE_ENV === "test" &&
          ["127.0.0.1", "localhost"].includes(u.hostname)
        )) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      throw new Error("Secure backup endpoint required");
  }
  if (
    process.env.MEDIA_PROVIDER === "s3" &&
    options.bucket === process.env.S3_BUCKET &&
    (options.endpoint ?? "") === (process.env.S3_ENDPOINT ?? "")
  )
    throw new Error(
      "Backup destination must be independent from the source media bucket",
    );
  const source = await digest(createReadStream(path));
  const key =
    "smart-farmer/" +
    new Date().toISOString().replaceAll(":", "-") +
    "-" +
    source.hash +
    ".sfbak";
  const s3 = new S3Client({
    region: options.region || "us-east-1",
    endpoint: options.endpoint,
    forcePathStyle: Boolean(options.endpoint),
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
    maxAttempts: 3,
  });
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: options.bucket,
        Key: key,
        Body: createReadStream(path),
        ContentLength: source.bytes,
        ContentType: "application/octet-stream",
        ChecksumSHA256: Buffer.from(source.hash, "hex").toString("base64"),
        IfNoneMatch: "*",
        Metadata: { sha256: source.hash },
      }),
    );
    const downloaded = await s3.send(
      new GetObjectCommand({ Bucket: options.bucket, Key: key }),
    );
    const verified = await digest(downloaded.Body);
    if (verified.hash !== source.hash || verified.bytes !== source.bytes)
      throw new Error("Independent backup readback mismatch");
    return { key, sha256: source.hash, bytes: source.bytes, verified: true };
  } finally {
    s3.destroy();
  }
}
async function run(command, argv, env) {
  const child = spawn(command, argv, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => {
    out += c;
    if (out.length > 100000) child.kill();
  });
  child.stderr.resume();
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Backup operation failed; credentials omitted")),
    );
  });
  return JSON.parse(out.trim().split("\n").at(-1));
}
export async function scheduledBackup({ drill = false } = {}) {
  if (process.env.BACKUP_ENABLED !== "true")
    throw new Error(
      "Set BACKUP_ENABLED=true only after configuring independent storage and recovery identity",
    );
  const directory = await mkdtemp(join(tmpdir(), "smart-farmer-offhost-"));
  const archive = join(directory, "backup.sfbak"),
    id = randomUUID(),
    db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  let drillAdmin, drillName;
  try {
    await db.query(
      "INSERT INTO backup_runs(id,started_at,status) VALUES($1,now(),'running')",
      [id],
    );
    const script = resolve(
      fileURLToPath(new URL("./backup.mjs", import.meta.url)),
    );
    await run(
      process.execPath,
      [script, "create", "--output", archive],
      process.env,
    );
    const uploaded = await uploadVerifiedBackup(archive, {
      bucket: process.env.BACKUP_S3_BUCKET,
      region: process.env.BACKUP_S3_REGION,
      endpoint: process.env.BACKUP_S3_ENDPOINT,
      accessKeyId: process.env.BACKUP_S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.BACKUP_S3_SECRET_ACCESS_KEY,
    });
    let restore = null;
    if (drill) {
      if (!process.env.RESTORE_ADMIN_DATABASE_URL)
        throw new Error("An explicit isolated restore admin URL is required");
      const adminUrl = new URL(process.env.RESTORE_ADMIN_DATABASE_URL);
      if (adminUrl.href === new URL(process.env.DATABASE_URL).href)
        throw new Error("Restore administration must be explicitly separate");
      drillAdmin = new pg.Pool({ connectionString: adminUrl.href });
      drillName = "smart_farmer_restore_drill_" + id.replaceAll("-", "");
      await drillAdmin.query("CREATE DATABASE " + drillName);
      adminUrl.pathname = "/" + drillName;
      restore = await run(
        process.execPath,
        [
          script,
          "restore",
          "--archive",
          archive,
          "--media-dir",
          join(directory, "restored-media"),
          "--confirm-empty-target",
        ],
        { ...process.env, RESTORE_DATABASE_URL: adminUrl.href },
      );
      if (restore.status !== "restored_to_isolated_target")
        throw new Error("Restore drill did not verify");
    }
    await db.query(
      "UPDATE backup_runs SET completed_at=now(),status=$2,archive_hash=$3,destination=$4,verified=true WHERE id=$1",
      [
        id,
        drill ? "restore_verified" : "stored_verified",
        uploaded.sha256,
        uploaded.key,
      ],
    );
    return {
      id,
      status: drill ? "restore_verified" : "stored_verified",
      sha256: uploaded.sha256,
      verifiedMediaFiles: restore?.verifiedMediaFiles ?? null,
    };
  } catch (e) {
    await db
      .query(
        "UPDATE backup_runs SET completed_at=now(),status='failed',error_code='backup_or_restore_failed' WHERE id=$1",
        [id],
      )
      .catch(() => {});
    throw e;
  } finally {
    if (drillAdmin) {
      if (drillName)
        await drillAdmin.query(
          "DROP DATABASE IF EXISTS " + drillName + " WITH (FORCE)",
        );
      await drillAdmin.end();
    }
    await db.end();
    await rm(directory, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  scheduledBackup({ drill: process.argv.includes("--drill") })
    .then((r) => console.log(JSON.stringify(r)))
    .catch(() => {
      console.error(
        JSON.stringify({
          status: "backup_or_restore_failed",
          details: "Check configuration and isolated storage; secrets omitted",
        }),
      );
      process.exitCode = 1;
    });
