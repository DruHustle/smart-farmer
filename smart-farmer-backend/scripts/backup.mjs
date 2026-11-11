import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import { copyIntoEmptyMediaDirectory } from "./backup-media.mjs";

const magic = Buffer.from("SFBK1");
const [action, ...args] = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
if (!["create", "restore"].includes(action))
  throw new Error(
    "Usage: backup.mjs create --output /path/archive.sfbak | restore --archive /path/archive.sfbak --media-dir /empty/path --confirm-empty-target",
  );
const keyFile = process.env.BACKUP_KEY_FILE;
if (!keyFile)
  throw new Error(
    "BACKUP_KEY_FILE must point to a private 32-byte random key file",
  );
const keyStat = await lstat(keyFile);
if (!keyStat.isFile() || (keyStat.mode & 0o077) !== 0)
  throw new Error(
    "Backup key must be a regular file readable only by its owner",
  );
const key = await readFile(keyFile);
if (key.length !== 32)
  throw new Error("Backup key must contain exactly 32 bytes");
const working = await mkdtemp(join(tmpdir(), "smart-farmer-backup-"));
const childEnv = (connection) => {
  const env = { ...process.env };
  if (connection) {
    const url = new URL(connection);
    if (!["postgres:", "postgresql:"].includes(url.protocol))
      throw new Error("PostgreSQL URL required");
    Object.assign(env, {
      PGHOST: url.hostname,
      PGPORT: url.port || "5432",
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    });
    if (url.searchParams.has("sslmode"))
      env.PGSSLMODE = url.searchParams.get("sslmode");
  }
  return env;
};
async function execute(
  command,
  argv,
  env = process.env,
  { input, output } = {},
) {
  const child = spawn(command, argv, {
    env,
    stdio: [input ? "pipe" : "ignore", output ? "pipe" : "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });
  const finished = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `${basename(command)} failed (${code}). Check the isolated target and client version; connection details are omitted.`,
            ),
          ),
    );
  });
  const transfers = [];
  if (input) transfers.push(pipeline(createReadStream(input), child.stdin));
  if (output)
    transfers.push(
      pipeline(
        child.stdout,
        createWriteStream(output, { flags: "wx", mode: 0o600 }),
      ),
    );
  await Promise.all([finished, ...transfers]);
}
async function digest(file) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}

async function referencedObjects(db) {
  const tables = ["private_media", "accounting_documents", "camera_segments", "camera_snapshots"];
  const rows = [];
  for (const table of tables)
    if (
      (await db.query("SELECT to_regclass($1) AS name", [table])).rows[0].name
    )
      rows.push(
        ...(
          await db.query(
            "SELECT object_key,content_hash,size_bytes FROM " + table,
          )
        ).rows,
      );
  return { rows };
}
async function snapshotMedia(client, destination) {
  await mkdir(destination, { mode: 0o700 });
  const objects = (await referencedObjects(client)).rows;
  const store =
    process.env.MEDIA_PROVIDER === "s3"
      ? (await import("../dist/integrations/object-store.js")).getObjectStore()
      : null;
  for (const item of objects) {
    if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}-[0-9a-f]{64}$/.test(item.object_key))
      throw new Error("Invalid media object key");
    const content = store
      ? await store.get(item.object_key)
      : await readFile(
          join(
            resolve(process.env.MEDIA_ROOT || ".data/media"),
            item.object_key,
          ),
        );
    if (
      content.length !== Number(item.size_bytes) ||
      createHash("sha256").update(content).digest("hex") !== item.content_hash
    )
      throw new Error("Referenced media integrity check failed");
    const path = join(destination, item.object_key);
    await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
  }
  return objects.length;
}

async function verifyReferencedMedia(db, directory) {
  const objects = await referencedObjects(db);
  for (const item of objects.rows) {
    if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}-[0-9a-f]{64}$/.test(item.object_key))
      throw new Error("Invalid media object key");
    const file = join(directory, item.object_key);
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.size !== Number(item.size_bytes) ||
      (await digest(file)) !== item.content_hash
    )
      throw new Error("Referenced media integrity check failed");
  }
  return objects.rows.length;
}
async function safeMedia(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
      throw new Error("Media source contains a link or special file");
    if (info.isDirectory()) await safeMedia(path);
  }
}
// Extraction accepts only the files produced by this tool. Python's data filter
// also prevents path traversal, ownership restoration and special-file creation.
const extraction = `import pathlib,re,sys,tarfile
archive,target,kind=sys.argv[1:]
with tarfile.open(archive) as t:
 members=t.getmembers()
 for m in members:
  name=m.name.removeprefix('./')
  if kind=='outer':
   valid=m.isfile() and name in {'db.dump','media.tar','manifest.json'}
  else:
   valid=(m.isdir() and (name in {'','.'} or re.fullmatch(r'[0-9a-f-]{36}',name))) or (m.isfile() and re.fullmatch(r'[0-9a-f-]{36}/[0-9a-f-]{36}-[0-9a-f]{64}',name))
  if not valid: raise SystemExit('Unexpected archive entry')
 t.extractall(target,filter='data')
`;
try {
  if (action === "create") {
    const destination = option("--output");
    if (!destination) throw new Error("--output is required");
    const media = join(working, "media");
    const dump = join(working, "db.dump"),
      mediaTar = join(working, "media.tar"),
      bundle = join(working, "bundle.tar.gz");
    const source = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const snapshot = await source.connect();
    try {
      await snapshot.query("SELECT pg_advisory_lock(928175)");
      await snapshot.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const id = (await snapshot.query("SELECT pg_export_snapshot() AS id"))
        .rows[0].id;
      await execute(
        process.env.PG_DUMP_BIN || "pg_dump",
        [
          "--format=custom",
          "--no-owner",
          "--no-privileges",
          "--snapshot=" + id,
        ],
        childEnv(process.env.DATABASE_URL),
        { output: dump },
      );
      await snapshotMedia(snapshot, media);
      await execute("tar", ["-cf", mediaTar, "-C", media, "."]);
      await snapshot.query("COMMIT");
    } finally {
      await snapshot.query("ROLLBACK");
      await snapshot.query("SELECT pg_advisory_unlock(928175)");
      snapshot.release();
      await source.end();
    }
    const manifest = {
      format: 1,
      createdAt: new Date().toISOString(),
      database: await digest(dump),
      media: await digest(mediaTar),
      mediaPolicy:
        "exported PostgreSQL snapshot; verified referenced field and camera objects; retention lock",
    };
    await writeFile(join(working, "manifest.json"), JSON.stringify(manifest), {
      mode: 0o600,
    });
    await execute("tar", [
      "-czf",
      bundle,
      "-C",
      working,
      "db.dump",
      "media.tar",
      "manifest.json",
    ]);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(magic);
    const output = resolve(destination);
    await mkdir(resolve(output, ".."), { recursive: true, mode: 0o700 });
    await writeFile(output, Buffer.concat([magic, nonce]), {
      flag: "wx",
      mode: 0o600,
    });
    try {
      await pipeline(
        createReadStream(bundle),
        cipher,
        createWriteStream(output, { flags: "a", mode: 0o600 }),
      );
      await appendFile(output, cipher.getAuthTag());
    } catch (error) {
      await rm(output, { force: true });
      throw error;
    }
    console.log(
      JSON.stringify({
        status: "created",
        file: output,
        sha256: await digest(output),
        encrypted: true,
      }),
    );
  } else {
    const archive = option("--archive"),
      destination = option("--media-dir"),
      target = process.env.RESTORE_DATABASE_URL;
    if (
      !archive ||
      !destination ||
      !target ||
      !args.includes("--confirm-empty-target")
    )
      throw new Error(
        "Restore requires archive, media directory, RESTORE_DATABASE_URL and --confirm-empty-target",
      );
    const targetUrl = new URL(target);
    if (!/^smart_farmer_restore_[a-z0-9_]+$/.test(targetUrl.pathname.slice(1)))
      throw new Error(
        "Use a separate database named smart_farmer_restore_<unique_suffix>",
      );
    if (target === process.env.DATABASE_URL)
      throw new Error("Restore target must differ from source");
    const media = resolve(destination);
    try {
      const info = await lstat(media);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (await readdir(media)).length
      )
        throw new Error("Restore media directory must be empty");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const db = new pg.Pool({ connectionString: target });
    try {
      const existing = await db.query(`
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
        UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
        UNION ALL SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
        UNION ALL SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname NOT IN ('public','information_schema')
        LIMIT 1`);
      if (existing.rowCount) throw new Error("Restore database must be empty");
    } finally {
      await db.end();
    }
    const file = resolve(archive),
      size = (await stat(file)).size;
    if (size < 34) throw new Error("Invalid backup");
    const handle = await import("node:fs/promises").then((m) =>
      m.open(file, "r"),
    );
    const header = Buffer.alloc(17),
      tag = Buffer.alloc(16);
    try {
      await handle.read(header, 0, 17, 0);
      await handle.read(tag, 0, 16, size - 16);
    } finally {
      await handle.close();
    }
    if (!header.subarray(0, 5).equals(magic))
      throw new Error("Unknown backup format");
    const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(5));
    decipher.setAAD(magic);
    decipher.setAuthTag(tag);
    const bundle = join(working, "bundle.tar.gz");
    await pipeline(
      createReadStream(file, { start: 17, end: size - 17 }),
      decipher,
      createWriteStream(bundle, { flags: "wx", mode: 0o600 }),
    );
    await execute("python3", ["-c", extraction, bundle, working, "outer"]);
    const manifest = JSON.parse(
      await readFile(join(working, "manifest.json"), "utf8"),
    );
    if (
      manifest.format !== 1 ||
      manifest.database !== (await digest(join(working, "db.dump"))) ||
      manifest.media !== (await digest(join(working, "media.tar")))
    )
      throw new Error("Backup integrity mismatch");
    const stagedMedia = join(working, "media");
    await mkdir(stagedMedia, { mode: 0o700 });
    await execute("python3", [
      "-c",
      extraction,
      join(working, "media.tar"),
      stagedMedia,
      "media",
    ]);
    await execute(
      process.env.PG_RESTORE_BIN || "pg_restore",
      [
        "--exit-on-error",
        "--single-transaction",
        "--no-owner",
        "--no-privileges",
        "--dbname",
        targetUrl.pathname.slice(1),
      ],
      childEnv(target),
      { input: join(working, "db.dump") },
    );
    const restored = new pg.Pool({ connectionString: target });
    let verifiedMediaFiles;
    try {
      verifiedMediaFiles = await verifyReferencedMedia(restored, stagedMedia);
    } finally {
      await restored.end();
    }
    await copyIntoEmptyMediaDirectory(stagedMedia, media);
    console.log(
      JSON.stringify({
        status: "restored_to_isolated_target",
        mediaDirectory: media,
        verifiedMediaFiles,
        productionCutover: false,
      }),
    );
  }
} finally {
  key.fill(0);
  await rm(working, { recursive: true, force: true });
}
