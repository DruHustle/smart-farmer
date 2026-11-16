import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { ApiError, audit, checkReplay, manageRoles, type Context } from "../context.js";
import { auth, row } from "../product/common.js";
import { uuid } from "../core.js";
import { sha256 } from "../security.js";
import { getObjectStore } from "../integrations/object-store.js";
import { requireStorageSpace } from "../integrations/storage-quota.js";
import { extractInvoice, ExtractionError, MAX_DOCUMENT_BYTES, validDocumentSignature, type DocumentMime, type InvoiceExtraction } from "./ocr.js";

type DocumentRow = {
  id: string; farm_id: string; actor_id: string; mime_type: DocumentMime;
  filename: string; size_bytes: number; content_hash: string; object_key: string;
  state: "queued" | "processing" | "ready" | "failed"; extraction: InvoiceExtraction | null;
  error_code: string | null; attempts: number; lease_token: string | null;
  created_at: Date; updated_at: Date;
};
function documentView(d: DocumentRow) {
  return { id: d.id, farmId: d.farm_id, mimeType: d.mime_type, filename: d.filename,
    sizeBytes: Number(d.size_bytes), contentHash: d.content_hash, state: d.state,
    extraction: d.extraction, errorCode: d.error_code, attempts: d.attempts,
    createdAt: d.created_at, updatedAt: d.updated_at };
}

/** Use the same lock order as farm membership mutations; recheck after waiting. */
async function privateTransaction<T>(ctx: Context, request: FastifyRequest, reply: FastifyReply, action: (client: PoolClient, farmId: string, actor: string) => Promise<T>) {
  const access = await auth(ctx, request, reply, manageRoles);
  if (!access) return;
  return ctx.transaction(async client => {
    await client.query("SELECT id FROM farms WHERE id=$1 FOR UPDATE", [access.farmId]);
    const membership = (await client.query("SELECT role FROM memberships WHERE farm_id=$1 AND user_id=$2 FOR SHARE", [access.farmId, access.actor])).rows[0];
    if (!membership || !manageRoles.includes(membership.role)) throw new ApiError("not_found", 404);
    return action(client, access.farmId, access.actor);
  });
}
function documentId(request: FastifyRequest) {
  return z.object({ documentId: uuid }).parse(request.params).documentId;
}
async function selected(client: PoolClient, farmId: string, id: string) {
  return row((await client.query<DocumentRow>("SELECT * FROM accounting_documents WHERE farm_id=$1 AND id=$2", [farmId, id])).rows[0]);
}

export function registerAccountingDocuments(app: FastifyInstance, ctx: Context) {
  const prefix = "/v1/farms/:farmId/accounting/documents";
  app.post(prefix, { bodyLimit: 7_100_000, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    // Authenticate before decoding a potentially large upload.
    const access = await auth(ctx, request, reply, manageRoles);
    if (!access) return;
    const data = z.object({
      id: uuid, mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "application/pdf"]),
      filename: z.string().trim().min(1).max(150).regex(/^[^\x00-\x1f\x7f/\\]+$/),
      dataBase64: z.string().min(1).max(6_990_508),
    }).strict().parse(request.body);
    const bytes = Buffer.from(data.dataBase64, "base64");
    if (bytes.length > MAX_DOCUMENT_BYTES || bytes.toString("base64") !== data.dataBase64 || !validDocumentSignature(data.mimeType, bytes)) throw new ApiError("invalid_document");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const result = await privateTransaction(ctx, request, reply, async (client, farmId, actor) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`product:${data.id}`]);
      const payloadHash = sha256(JSON.stringify({ action: "upload_accounting_document", farmId, id: data.id, mimeType: data.mimeType, filename: data.filename, sizeBytes: bytes.length, contentHash: hash }));
      const old = (await client.query("SELECT * FROM product_requests WHERE id=$1", [data.id])).rows[0];
      if (old) {
        if (old.farm_id !== farmId) throw new ApiError("idempotency_conflict", 409);
        checkReplay(old, payloadHash, actor); return { ...old.response, replayed: true };
      }
      // Remember aliases as well as newly stored files: a hash-deduplicated upload
      // has still consumed its request ID and must not accept a different intent.
      async function remember(response: { document: ReturnType<typeof documentView>; duplicate: boolean; replayed: boolean }) {
        await client.query("INSERT INTO product_requests(id,farm_id,actor_id,payload_hash,response) VALUES($1,$2,$3,$4,$5)", [data.id, farmId, actor, payloadHash, JSON.stringify(response)]);
        return response;
      }
      const existing = (await client.query<DocumentRow>("SELECT * FROM accounting_documents WHERE id=$1", [data.id])).rows[0];
      if (existing) {
        if (existing.farm_id !== farmId || existing.actor_id !== actor || existing.content_hash !== hash || existing.mime_type !== data.mimeType || existing.filename !== data.filename) throw new ApiError("idempotency_conflict", 409);
        return remember({ document: documentView(existing), duplicate: false, replayed: true });
      }
      const duplicate = (await client.query<DocumentRow>("SELECT * FROM accounting_documents WHERE farm_id=$1 AND content_hash=$2", [farmId, hash])).rows[0];
      if (duplicate) return remember({ document: documentView(duplicate), duplicate: true, replayed: true });
      const pending = (await client.query("SELECT count(*) FROM accounting_documents WHERE farm_id=$1 AND state IN ('queued','processing')", [farmId])).rows[0].count;
      if (Number(pending) >= 20) throw new ApiError("scan_queue_full", 409);
      await requireStorageSpace(client, farmId, "field", bytes.length);
      const key = `${farmId}/${data.id}-${hash}`;
      await getObjectStore().put(key, bytes);
      const inserted = (await client.query<DocumentRow>(`INSERT INTO accounting_documents(id,farm_id,actor_id,mime_type,filename,size_bytes,content_hash,object_key,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued') RETURNING *`, [data.id, farmId, actor, data.mimeType, data.filename, bytes.length, hash, key])).rows[0];
      await audit(client, farmId, actor, "accounting_document", data.id, "uploaded", "supplier_invoice_scan", null, { mimeType: data.mimeType, sizeBytes: bytes.length, contentHash: hash });
      return remember({ document: documentView(inserted), duplicate: false, replayed: false });
    });
    if (result) return reply.code(result.replayed ? 200 : 201).send(result);
  });

  app.get(prefix, async (request, reply) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), cursor: uuid.optional(), state: z.enum(["queued", "processing", "ready", "failed"]).optional() }).parse(request.query);
    return privateTransaction(ctx, request, reply, async (client, farmId) => {
      const rows = (await client.query<DocumentRow>("SELECT * FROM accounting_documents WHERE farm_id=$1 AND ($2::uuid IS NULL OR id>$2) AND ($3::text IS NULL OR state=$3) ORDER BY id LIMIT $4", [farmId, query.cursor ?? null, query.state ?? null, query.limit + 1])).rows;
      return { items: rows.slice(0, query.limit).map(documentView), nextCursor: rows.length > query.limit ? rows[query.limit - 1].id : null };
    });
  });

  app.get(`${prefix}/:documentId`, async (request, reply) => privateTransaction(ctx, request, reply, async (client, farmId) => ({ document: documentView(await selected(client, farmId, documentId(request))) })));

  app.post(`${prefix}/:documentId/retry`, { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const data = z.object({ id: uuid }).strict().parse(request.body), id = documentId(request);
    return privateTransaction(ctx, request, reply, async (client, farmId, actor) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`product:${data.id}`]);
      const payloadHash = sha256(JSON.stringify({ action: "retry_scan", farmId, documentId: id, ...data }));
      const old = (await client.query("SELECT * FROM product_requests WHERE id=$1", [data.id])).rows[0];
      if (old) {
        if (old.farm_id !== farmId) throw new ApiError("idempotency_conflict", 409);
        checkReplay(old, payloadHash, actor); return old.response;
      }
      const d = await selected(client, farmId, id);
      if (d.state !== "failed") throw new ApiError("scan_not_failed", 409);
      if (d.attempts >= 3) throw new ApiError("scan_retry_limit", 409);
      const changed = (await client.query<DocumentRow>("UPDATE accounting_documents SET state='queued',error_code=NULL,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 RETURNING *", [id])).rows[0];
      const response = { document: documentView(changed) };
      await client.query("INSERT INTO product_requests(id,farm_id,actor_id,payload_hash,response) VALUES($1,$2,$3,$4,$5)", [data.id, farmId, actor, payloadHash, JSON.stringify(response)]);
      await audit(client, farmId, actor, "accounting_document", id, "retry_requested", "supplier_invoice_scan");
      return response;
    });
  });

  app.get(`${prefix}/:documentId/content`, async (request, reply) => {
    const result = await privateTransaction(ctx, request, reply, async (client, farmId, actor) => {
      const d = await selected(client, farmId, documentId(request));
      const bytes = await getObjectStore().get(d.object_key);
      if (bytes.length !== Number(d.size_bytes) || createHash("sha256").update(bytes).digest("hex") !== d.content_hash) throw new ApiError("document_integrity_failed", 503);
      await audit(client, farmId, actor, "accounting_document", d.id, "content_accessed", "private_financial_document");
      return { d, bytes };
    });
    if (!result) return;
    return reply.type(result.d.mime_type).header("Cache-Control", "private, no-store").header("Content-Security-Policy", "sandbox; default-src 'none'")
      .header("Content-Disposition", `attachment; filename="invoice-source${result.d.mime_type === "application/pdf" ? ".pdf" : result.d.mime_type === "image/jpeg" ? ".jpg" : result.d.mime_type === "image/webp" ? ".webp" : ".png"}"; filename*=UTF-8''${encodeURIComponent(result.d.filename).replace(/['()]/g, c => `%${c.charCodeAt(0).toString(16)}`)}`).send(result.bytes);
  });
}

/** A short claim transaction, bounded native processing, and fenced completion.
 * A crashed worker's expired lease is reclaimable; a stale worker cannot overwrite
 * a newer result. Scanning does not create any invoice, expense, or journal. */
export async function processAccountingDocument(db: Pool) {
  await db.query("UPDATE accounting_documents SET state='failed',error_code='scan_retry_limit',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE state='processing' AND lease_until<now() AND attempts>=3");
  const lease = randomUUID();
  const document = (await db.query<DocumentRow>(`WITH candidate AS (
      SELECT id FROM accounting_documents WHERE attempts<3 AND (state='queued' OR (state='processing' AND lease_until<now()))
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE accounting_documents d SET state='processing',attempts=attempts+1,lease_token=$1,lease_until=now()+interval '120 seconds',updated_at=now()
    FROM candidate c WHERE d.id=c.id RETURNING d.*`, [lease])).rows[0];
  if (!document) return { processed: 0 };
  let extraction: InvoiceExtraction | null = null, errorCode: string | null = null;
  try {
    const bytes = await getObjectStore().get(document.object_key);
    if (bytes.length !== Number(document.size_bytes) || createHash("sha256").update(bytes).digest("hex") !== document.content_hash) throw new ExtractionError("document_integrity_failed");
    extraction = await extractInvoice(bytes, document.mime_type);
  } catch (error) {
    errorCode = error instanceof ExtractionError ? error.code : "scan_failed";
  }
  const updated = await db.query("UPDATE accounting_documents SET state=$3,extraction=$4,error_code=$5,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2 AND state='processing'", [document.id, lease, extraction ? "ready" : "failed", extraction ? JSON.stringify(extraction) : null, errorCode]);
  return { processed: updated.rowCount ?? 0, ...(updated.rowCount ? { state: extraction ? "ready" : "failed" } : {}) };
}
