import { z } from "zod";
import { ApiError } from "../context.js";
import { digest, fetchJson, openSecret, safeEndpoint, sealSecret } from "./common.js";
import { renderNotificationEmail } from "./email-template.js";
import { emailBrand } from "./email-brand.js";

// Resend retains idempotency keys for 24 hours. Leave an hour for clock/network
// uncertainty; a late retry requires reconciliation, never a fresh delivery ID.
export const notificationRetryWindowMs = 23 * 60 * 60 * 1000;
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1).max(256),
  channel: z.enum(["email", "push", "sms"]),
  endpoint: z.string().min(1).max(2048),
  credentialHash: fingerprint,
  recipientHash: fingerprint,
  body: z.string().min(1).max(16384),
  bodyHash: fingerprint,
  preparedAt: z.iso.datetime(),
}).strict();
export type NotificationRequest = z.infer<typeof requestSchema>;
export type NotificationContent = { title: string; body: string; privatePushBody?: string; language?: string };
export type NotificationResult = { state: string; providerId: string | null; error?: string };

export class NotificationRequestHold extends Error {
  constructor(public readonly code: string) { super(code); }
}

/** One mailbox, optionally with a display name; retain valid explicit values. */
export function validNotificationFrom(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 320 || /[\x00-\x1f\x7f]/.test(value)) return false;
  const trimmed = value.trim();
  if (z.email().safeParse(trimmed).success) return true;
  const match = /^([^<>]+)\s*<([^<>]+)>$/.exec(trimmed);
  return Boolean(match?.[1].trim() && z.email().safeParse(match?.[2]).success);
}

function connection(channel: NotificationRequest["channel"]) {
  if (process.env.NOTIFICATION_MODE !== "live")
    throw new NotificationRequestHold("notification_provider_changed");
  const credential = channel === "email" ? process.env.RESEND_API_KEY
    : channel === "sms" ? process.env.SMS_WEBHOOK_TOKEN : (process.env.EXPO_ACCESS_TOKEN ?? "");
  if (typeof credential !== "string" || (channel !== "push" && !credential) || /[\r\n]/.test(credential))
    throw new NotificationRequestHold("notification_provider_changed");
  let endpoint: string;
  try {
    endpoint = safeEndpoint(channel === "email"
      ? process.env.RESEND_API_URL || "https://api.resend.com/emails"
      : channel === "push" ? process.env.EXPO_PUSH_URL || "https://exp.host/--/api/v2/push/send"
        : process.env.SMS_WEBHOOK_URL!, true).href;
  } catch {
    throw new NotificationRequestHold("notification_provider_changed");
  }
  return {
    endpoint, credential,
    credentialHash: digest(JSON.stringify(["notification-provider-v1", channel, endpoint, credential])),
  };
}

export function prepareNotificationRequest(
  channel: string, address: string, content: NotificationContent, id: string,
): NotificationRequest {
  const kind = z.enum(["email", "push", "sms"]).parse(channel);
  const current = connection(kind);
  if (kind === "email" && !validNotificationFrom(process.env.NOTIFICATION_FROM))
    throw new ApiError("invalid_notification_sender", 409);
  const email = {
    from: process.env.NOTIFICATION_FROM, to: [address], subject: content.title, text: content.body,
  };
  const richEmail = kind === "email" ? { ...email, html: renderNotificationEmail(content, id.startsWith("verify:")), attachments: [{ filename: emailBrand.filename, content: emailBrand.base64, content_type: "image/png", content_id: emailBrand.cid }] } : email;
  // Escaping long content can expand HTML. Preserve the full plain-text message
  // within the existing request-size limit instead of dropping accepted content.
  const emailBody = Buffer.byteLength(JSON.stringify(richEmail)) <= 16384 ? richEmail : email;
  const body = JSON.stringify(kind === "email" ? emailBody : kind === "push" ? {
    to: address, title: id.startsWith("verify:") ? content.title : "Smart Farmer",
    body: id.startsWith("verify:") ? content.body : (content.privatePushBody ?? "Smart Farmer"),
    data: { notificationId: id }, ttl: 3600, sound: "default",
  } : { id, to: address, text: content.title + "\n" + content.body });
  const request = requestSchema.parse({
    version: 1, id, channel: kind, endpoint: current.endpoint,
    credentialHash: current.credentialHash, recipientHash: digest(address),
    body, bodyHash: digest(body), preparedAt: new Date().toISOString(),
  });
  validateBody(request);
  return request;
}

function validateBody(request: NotificationRequest) {
  try {
    if (Buffer.byteLength(request.body) > 16384 || digest(request.body) !== request.bodyHash)
      throw new Error("body mismatch");
    const raw = JSON.parse(request.body);
    let address: string;
    if (request.channel === "email") {
      const body = z.object({
        from: z.string().refine(validNotificationFrom), to: z.array(z.email()).length(1),
        subject: z.string(), text: z.string(), html: z.string().min(1).optional(),
        // Permit the pinned inline artwork while retaining old HTML/plain-text requests.
        // Its original bytes remain frozen and are never replaced during a retry.
        attachments: z.array(z.object({ filename: z.literal(emailBrand.filename), content: z.string().min(1).max(4096).regex(/^[A-Za-z0-9+/]+={0,2}$/), content_type: z.literal("image/png"), content_id: z.literal(emailBrand.cid) }).strict()).length(1).optional(),
      }).strict().parse(raw);
      address = body.to[0];
    } else if (request.channel === "push") {
      const body = z.object({
        to: z.string().regex(/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/),
        title: z.string(), body: z.string(),
        data: z.object({ notificationId: z.literal(request.id) }).strict(),
        ttl: z.literal(3600), sound: z.literal("default"),
      }).strict().parse(raw);
      address = body.to;
    } else {
      const body = z.object({
        id: z.literal(request.id), to: z.string().regex(/^\+[1-9]\d{7,14}$/), text: z.string(),
      }).strict().parse(raw);
      address = body.to;
    }
    if (digest(address) !== request.recipientHash) throw new Error("recipient mismatch");
  } catch {
    throw new NotificationRequestHold("notification_request_invalid");
  }
}

type DeliveryIdentity = { id: string; notification_id: string; channel_id: string };
function requestContext(row: DeliveryIdentity) {
  return `notification-request:v1:${row.id}:${row.notification_id}:${row.channel_id}`;
}
export function sealNotificationRequest(request: NotificationRequest, row: DeliveryIdentity) {
  return sealSecret(JSON.stringify(request), requestContext(row));
}
export function restoreNotificationRequest(row: DeliveryIdentity & {
  channel: string; address_cipher: unknown; address_hash: string;
  request_cipher: unknown; request_body_hash: string; request_prepared_at: Date;
}): NotificationRequest {
  let request: NotificationRequest, address: string;
  try {
    request = requestSchema.parse(JSON.parse(openSecret(row.request_cipher, requestContext(row))));
    address = openSecret(row.address_cipher, row.channel_id);
  } catch {
    throw new NotificationRequestHold("notification_request_unreadable");
  }
  if (request.id !== row.id || request.channel !== row.channel || request.bodyHash !== row.request_body_hash ||
      new Date(row.request_prepared_at).toISOString() !== request.preparedAt)
    throw new NotificationRequestHold("notification_request_invalid");
  if (digest(address) !== row.address_hash || request.recipientHash !== row.address_hash)
    throw new NotificationRequestHold("notification_recipient_changed");
  validateBody(request);
  assertNotificationRequestCurrent(request);
  return request;
}

function assertNotificationRequestCurrent(request: NotificationRequest) {
  const age = Date.now() - Date.parse(request.preparedAt);
  if (age < -60000 || age >= notificationRetryWindowMs)
    throw new NotificationRequestHold("notification_request_expired");
  const current = connection(request.channel);
  if (current.endpoint !== request.endpoint || current.credentialHash !== request.credentialHash)
    throw new NotificationRequestHold("notification_provider_changed");
  return current;
}

function receiptId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value);
}

/** Use persisted request bytes; Authorization is read and checked, never stored. */
export async function sendNotificationRequest(request: NotificationRequest): Promise<NotificationResult> {
  const current = assertNotificationRequestCurrent(request);
  const r = await fetchJson(request.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(current.credential ? { Authorization: `Bearer ${current.credential}` } : {}),
      ...(request.channel === "push" ? {} : { "Idempotency-Key": request.id }),
    },
    body: request.body,
  });
  if (request.channel === "email") {
    if (!receiptId(r?.id)) throw new ApiError("invalid_provider_response", 502);
    return { state: "accepted", providerId: r.id };
  }
  if (request.channel === "push") {
    if (Array.isArray(r?.data) && r.data.length !== 1)
      throw new ApiError("invalid_provider_response", 502);
    const data = Array.isArray(r?.data) ? r.data[0] : r?.data;
    if (data?.status === "error") return {
      state: "failed", providerId: null,
      error: data?.details?.error === "DeviceNotRegistered" ? "device_not_registered" : "provider_rejected",
    };
    if (data?.status !== "ok" || !receiptId(data.id))
      throw new ApiError("invalid_provider_response", 502);
    return { state: "accepted", providerId: data.id };
  }
  if (!receiptId(r?.id) || !["accepted", "delivered"].includes(r?.status))
    throw new ApiError("invalid_provider_response", 502);
  return { state: r.status === "delivered" ? "provider_delivered" : "accepted", providerId: r.id };
}
