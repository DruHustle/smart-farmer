import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  link,
  rm,
  open,
  readdir,
  stat,
} from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

export interface ObjectPage {
  items: { key: string; modifiedAt: Date; size: number }[];
  nextCursor: string | null;
}
export interface ObjectStore {
  list(farmId: string, cursor?: string): Promise<ObjectPage>;
  readonly kind: "file" | "s3";
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}
export function validateObjectKey(key: string) {
  if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}-[0-9a-f]{64}$/.test(key))
    throw new Error("Invalid object key");
  return key;
}
export class FileObjectStore implements ObjectStore {
  readonly kind = "file" as const;
  readonly root: string;
  constructor(root = process.env.MEDIA_ROOT || ".data/media") {
    this.root = resolve(root);
  }
  private path(key: string) {
    validateObjectKey(key);
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep))
      throw new Error("Invalid object key");
    return path;
  }
  async put(key: string, data: Buffer) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(tmp, "wx", 0o600);
      try {
        await file.writeFile(data);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(tmp, path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (!(await readFile(path)).equals(data))
          throw new Error("Immutable object mismatch");
      }
    } finally {
      await rm(tmp, { force: true });
    }
  }
  async list(farmId: string, cursor?: string): Promise<ObjectPage> {
    if (!/^[0-9a-f-]{36}$/.test(farmId)) throw new Error("Invalid farm prefix");
    let names: string[];
    try {
      names = (await readdir(resolve(this.root, farmId)))
        .filter((n) => /^[0-9a-f-]{36}-[0-9a-f]{64}$/.test(n))
        .sort()
        .filter((n) => !cursor || n > cursor);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return { items: [], nextCursor: null };
      throw e;
    }
    const items = await Promise.all(
      names.slice(0, 200).map(async (name) => {
        const info = await stat(this.path(farmId + "/" + name));
        return {
          key: farmId + "/" + name,
          modifiedAt: info.mtime,
          size: info.size,
        };
      }),
    );
    return { items, nextCursor: names.length > 200 ? names[199] : null };
  }
  get(key: string) {
    return readFile(this.path(key));
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
}
export class S3ObjectStore implements ObjectStore {
  readonly kind = "s3" as const;
  readonly client: S3Client;
  readonly bucket: string;
  constructor(options: {
    bucket: string;
    region: string;
    endpoint?: string;
    forcePathStyle?: boolean;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
  }) {
    if (!options.bucket) throw new Error("S3 bucket required");
    this.bucket = options.bucket;
    if (options.endpoint) {
      const u = new URL(options.endpoint);
      if (
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        !["https:", "http:"].includes(u.protocol)
      )
        throw new Error("Invalid S3 endpoint");
      if (
        u.protocol !== "https:" &&
        !(
          process.env.S3_ALLOW_LOCAL === "true" &&
          ["127.0.0.1", "localhost"].includes(u.hostname)
        )
      )
        throw new Error("S3 HTTPS required");
    }
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
      credentials:
        options.accessKeyId && options.secretAccessKey
          ? {
              accessKeyId: options.accessKeyId,
              secretAccessKey: options.secretAccessKey,
              sessionToken: options.sessionToken,
            }
          : undefined,
      maxAttempts: 3,
    });
  }
  async list(farmId: string, cursor?: string): Promise<ObjectPage> {
    if (!/^[0-9a-f-]{36}$/.test(farmId)) throw new Error("Invalid farm prefix");
    const r = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: farmId + "/",
        MaxKeys: 200,
        ContinuationToken: cursor,
      }),
    );
    return {
      items: (r.Contents ?? [])
        .filter(
          (x) =>
            x.Key &&
            x.LastModified &&
            /^[0-9a-f-]{36}\/[0-9a-f-]{36}-[0-9a-f]{64}$/.test(x.Key),
        )
        .map((x) => ({
          key: validateObjectKey(x.Key!),
          modifiedAt: x.LastModified!,
          size: x.Size ?? 0,
        })),
      nextCursor: r.IsTruncated ? (r.NextContinuationToken ?? null) : null,
    };
  }
  async put(key: string, data: Buffer) {
    validateObjectKey(key);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: data,
          ContentType: "application/octet-stream",
          ChecksumSHA256: createHash("sha256").update(data).digest("base64"),
          IfNoneMatch: "*",
          Metadata: { sha256: createHash("sha256").update(data).digest("hex") },
        }),
      );
    } catch (e) {
      if (
        (e as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode !== 412
      )
        throw e;
      if (!(await this.get(key)).equals(data))
        throw new Error("Immutable object mismatch");
    }
  }
  async get(key: string) {
    validateObjectKey(key);
    const r = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!r.Body) throw new Error("Missing object body");
    let size = 0;
    const parts: Buffer[] = [];
    for await (const part of r.Body as AsyncIterable<Uint8Array>) {
      size += part.length;
      if (size > 5 * 1024 * 1024)
        throw new Error("Object exceeds allowed size");
      parts.push(Buffer.from(part));
    }
    return Buffer.concat(parts);
  }
  async delete(key: string) {
    validateObjectKey(key);
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}
let cached: { fingerprint: string; store: ObjectStore } | undefined;
export function getObjectStore(): ObjectStore {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        process.env.MEDIA_PROVIDER,
        process.env.MEDIA_ROOT,
        process.env.S3_BUCKET,
        process.env.S3_ENDPOINT,
        process.env.AWS_REGION,
        process.env.AWS_ACCESS_KEY_ID,
        process.env.AWS_SECRET_ACCESS_KEY,
        process.env.AWS_SESSION_TOKEN,
      ]),
    )
    .digest("hex");
  if (cached?.fingerprint === fingerprint) return cached.store;
  const kind = process.env.MEDIA_PROVIDER || "file";
  if (!["file", "s3"].includes(kind)) throw new Error("Invalid MEDIA_PROVIDER");
  const store =
    kind === "file"
      ? new FileObjectStore()
      : new S3ObjectStore({
          bucket: process.env.S3_BUCKET || "",
          region: process.env.AWS_REGION || "us-east-1",
          endpoint: process.env.S3_ENDPOINT,
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          sessionToken: process.env.AWS_SESSION_TOKEN,
        });
  cached = { fingerprint, store };
  return store;
}
