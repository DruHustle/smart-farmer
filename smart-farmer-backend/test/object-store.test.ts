import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3ObjectStore } from "../src/integrations/object-store.js";
// @ts-ignore The deployment CLI intentionally remains independent plain JavaScript.
import { uploadVerifiedBackup } from "../scripts/offhost-backup.mjs";
// @ts-ignore Deployment utility is plain JavaScript.
import { restoreObjects } from "../scripts/restore-object-storage.mjs";

test("S3-compatible protocol fixture verifies signed immutable put/get/delete, collision detection and independent encrypted backup readback", async () => {
  const objects = new Map<string, Buffer>();
  const seen: any[] = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://localhost").pathname;
    seen.push({
      method: req.method,
      authorization: req.headers.authorization,
      path,
    });
    if (req.method === "PUT") {
      if (req.headers["if-none-match"] === "*" && objects.has(path)) {
        res.statusCode = 412;
        res.setHeader("content-type", "application/xml");
        res.end("<Error><Code>PreconditionFailed</Code></Error>");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      let data = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "aws-chunked") {
        // Decode the SDK checksum-trailer transfer used for streamed backups.
        const decoded: Buffer[] = [];
        let position = 0;
        while (position < data.length) {
          const end = data.indexOf("\r\n", position);
          const size = parseInt(
            data.toString("ascii", position, end).split(";")[0],
            16,
          );
          if (!size) break;
          position = end + 2;
          decoded.push(data.subarray(position, position + size));
          position += size + 2;
        }
        data = Buffer.concat(decoded);
      }
      objects.set(path, data);
      res.setHeader("ETag", '"fixture"');
      res.end();
      return;
    }
    if (req.method === "DELETE") {
      objects.delete(path);
      res.statusCode = 204;
      res.end();
      return;
    }
    const data = objects.get(path);
    if (!data) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/xml");
      res.end("<Error><Code>NoSuchKey</Code></Error>");
      return;
    }
    res.setHeader("content-length", data.length);
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader(
      "x-amz-checksum-sha256",
      createHash("sha256").update(data).digest("base64"),
    );
    res.end(data);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const endpoint = "http://127.0.0.1:" + (server.address() as any).port;
  const prior = process.env.S3_ALLOW_LOCAL,
    priorNode = process.env.NODE_ENV;
  process.env.S3_ALLOW_LOCAL = "true";
  process.env.NODE_ENV = "test";
  const store = new S3ObjectStore({
      bucket: "private-fixture",
      region: "us-east-1",
      endpoint,
      accessKeyId: "fixture",
      secretAccessKey: "fixture-only",
    }),
    dir = await mkdtemp(join(tmpdir(), "s3-backup-fixture-"));
  try {
    const bytes = Buffer.from("Immutable private evidence"),
      key =
        randomUUID() +
        "/" +
        randomUUID() +
        "-" +
        createHash("sha256").update(bytes).digest("hex");
    await store.put(key, bytes);
    await store.put(key, bytes);
    assert.deepEqual(await store.get(key), bytes);
    await assert.rejects(
      store.put(key, Buffer.from("collision")),
      /Immutable object mismatch/,
    );
    await assert.rejects(store.get("../outside"));
    assert.ok(
      seen.every((s) => s.authorization?.startsWith("AWS4-HMAC-SHA256")),
    );
    const path = join(dir, "encrypted.sfbak");
    const encrypted = Buffer.concat([
      Buffer.from("SFBK1"),
      Buffer.alloc(64, 123),
    ]);
    await writeFile(path, encrypted);
    const backup = await uploadVerifiedBackup(path, {
      bucket: "separate-backup-fixture",
      region: "us-east-1",
      endpoint,
      accessKeyId: "backup-fixture",
      secretAccessKey: "separate-fixture-only",
    });
    assert.equal(backup.verified, true);
    assert.equal(
      backup.sha256,
      createHash("sha256").update(encrypted).digest("hex"),
    );
    assert.ok(
      seen.some(
        (s) =>
          s.method === "GET" && s.path.startsWith("/separate-backup-fixture/"),
      ),
    );
    await mkdir(join(dir, key.split("/")[0]), { recursive: true });
    await writeFile(join(dir, key), bytes);
    const restoredDb = {
      query: async (sql: string, args?: string[]) =>
        sql.startsWith("SELECT to_regclass")
          ? {
              rows: [
                {
                  name: args?.[0] === "private_media" ? "private_media" : null,
                },
              ],
            }
          : {
              rows: [
                {
                  object_key: key,
                  content_hash: createHash("sha256")
                    .update(bytes)
                    .digest("hex"),
                  size_bytes: bytes.length,
                },
              ],
            },
    };
    const restored = await restoreObjects(restoredDb, store, dir);
    assert.equal(restored.verifiedMediaFiles, 1);
    assert.equal(restored.productionCutover, false);
    await writeFile(join(dir, key), Buffer.alloc(bytes.length));
    await assert.rejects(
      restoreObjects(restoredDb, store, dir),
      /checksum mismatch/,
    );
    await store.delete(key);
    await assert.rejects(store.get(key));
  } finally {
    store.client.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
    if (prior === undefined) delete process.env.S3_ALLOW_LOCAL;
    else process.env.S3_ALLOW_LOCAL = prior;
    if (priorNode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNode;
  }
});
