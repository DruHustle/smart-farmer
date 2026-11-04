# Integrations API v1

Core identity, project, inventory and animal contracts are in [core-api.md](core-api.md). All private routes use `Authorization: Bearer <session token>`. Server permissions apply even when controls are hidden in a client. IDs are UUIDs; timestamps require an ISO-8601 offset. Monetary values have two decimal places; quantities have at most six, with whole-unit inventory enforced for countable items.

## Equipment

- `GET /v1/farms/:farmId/assets`: all farm members; accepts `limit` (1–100) and `cursor`, returns `items` and `nextCursor`. Readings include `integration_state`, `capabilities`, `last_observed_at`, `latest_telemetry`, and `fresh`.
- `POST /v1/farms/:farmId/assets`: manager/owner. Fields: `id`, `name`, `category` (`borehole|pump|pivot|valve|tank|sensor|power|camera|other`), optional nullable `model`, `protocol` (`unconfigured|simulator|mqtt|http|modbus`), `parentAssetId`, and `staleAfterSeconds` (10–3600). Non-simulator transports start unconfigured; configuration, commissioning and actual transport adapters are documented in [operations-api.md](operations-api.md) and [hardware-and-commissioning.md](hardware-and-commissioning.md).
- `POST .../assets/:assetId/simulate`: manager/owner; `{running, interlockOk}` supplies visibly simulated state.
- `POST .../assets/:assetId/gateway-token`: owner only; returns one private asset-scoped token, its simulation/gateway purpose and expiry. Configuration is required. Reissuing invalidates the old token and is audited.
- `GET .../assets/:assetId/commands`: managers; cursor-paginated command history, newest first by creation time and ID.
- `POST .../assets/:assetId/commands`: `{id, command: start|stop, confirmed: true, expiresAt}`. Fresh telemetry, an approved capability, interlocks and no unresolved active command are required. Physical commands additionally require current model-specific control commissioning bound to the configuration. Commands cannot be queued offline.
- `POST .../assets/:assetId/commands/:commandId/simulate`: explicit administrator simulator result; `{status: acknowledged|confirmed|rejected|failed, feedback?: {running,interlock_ok}, reason?}`. Confirmation needs matching feedback.
- Gateway routes use the asset token instead of a user session: `POST /v1/edge/telemetry`, `POST /v1/edge/commands/next`, and `POST /v1/edge/commands/:commandId/result`. Polling dispatches at most once. Deadline and credential validity are checked again after lock waits.

Command-feedback telemetry body: `{id,observedAt,measurements:{running,interlock_ok,flow_l_min?,pressure_kpa?}}`. Field names define units; the persisted source is derived from the asset protocol (`simulator` or `gateway`), never selected by the caller. Physical observations must match the current configuration hash. Late observations retain their original time and cannot replace a newer current-state sample. Additional typed measurements retain measurement, unit, quality and both times; see [operations-api.md](operations-api.md). Working HTTP, MQTT, Modbus TCP/RTU and ONVIF/RTSP gateway boundaries have fixture-based contract tests; each real controller still requires its own approved mapping and commissioning.

## Private media

`POST /v1/farms/:farmId/media` accepts `{id,activityId?,assetId?,financial?,mimeType,dataBase64,filename?}`, with exactly one activity or asset parent. Upload parent metadata first; media has independent retries. Owner/manager/worker can upload permitted evidence, and advisers can attach their own non-financial evidence. Supported MIME types: JPEG, PNG, WebP, MP4 audio, MPEG audio, WebM audio, WAV audio and PDF. The maximum decoded size is 5 MiB. File signatures, canonical base64, parent ownership/current permission and farm quota are checked. Reusing an ID with different content, ownership, MIME type, filename, financial classification or parent is a conflict.

`GET /v1/farms/:farmId/media?activityId=...` or `?assetId=...` lists authorized metadata with `limit`/`cursor` pagination. `GET .../media/:mediaId/content` returns authenticated binary data with attachment, sandbox and private/no-store headers. Explicit financial attachments, cost activities and activities linked as receipts require management permission. Camera-asset attachments additionally require current camera permission, even before live streaming is configured. Permission is checked on listing, upload replay and each download. Object keys and credentials are not exposed. Content access is audited. `ObjectStore` has working local/persistent-volume and S3 implementations; production configuration and retention/quotas are in the [activation guide](operational-integrations.md).

## Cameras

`GET /v1/farms/:farmId/camera-events` and `POST .../camera-events/:eventId/acknowledge` require current management permission or an explicit camera grant; simulator event creation requires manager permission. Create body: `{id,assetId,kind:motion|person,observedAt,retentionDays?}` (1–90 days). The camera must be explicitly simulated. Responses retain event and receipt times, distinguish delayed observations, and preserve the detection type. The maintenance worker purges expired events. Private expiring live/event HLS sessions, camera grants, snapshots, gateway uploads, zones, schedules, retention and incident follow-up are documented in [operations-api.md](operations-api.md). No public stream endpoint exists.

## Marketplace

Public `GET /v1/market/listings?q=&cursor=` exposes only deliberate listing data and collection area; it does not expose private project, equipment or security records. Available quantity is limited by current stock minus reservations. Listings with an active sale restriction are not offered.

Managers use `GET/POST /v1/farms/:farmId/listings` and `POST .../listings/:listingId/archive`. Create fields include `{id,stockItemId?|animalProjectId?,title,quantity,price,priceBasis?,priceQuantity?,currency,collectionArea,terms?}` with one physical source. Publishing is explicit. Live-animal reservations use the same project count and identities as husbandry events; they do not create duplicate stock inventory. Expected harvest is labelled provisional and cannot reserve unproduced stock. Complete edit/photo, expiry, enquiry/offer, buying-request and moderation contracts are in [product-api.md](product-api.md).

Signed-in buyers reserve with `POST /v1/market/listings/:listingId/orders` and `{id,quantity,identityIds?}`. The transaction locks the source stock or animal project and listing; simultaneous attempts cannot oversell. `GET /v1/market/orders` returns the caller's buyer or authorized seller orders. `POST /v1/market/orders/:orderId/status` accepts `cancelled` (buyer or seller) or `fulfilled` (seller). Cancellation or expiry releases reservations; fulfillment decreases stock/animal count and records revenue once. Treatment restrictions are checked again at fulfillment. Orders have a default 24-hour expiry; the worker rechecks their state under lock before releasing them.

Seller-only `POST /v1/market/orders/:orderId/payments` records `{id,amount,currency,note?}` against a fulfilled order. Payments are explicitly manual, cannot exceed the outstanding balance, and must use the order currency. Revenue and cash received are separate entries. No payment provider is configured.

## Payment provider boundary

Authenticated farm members may read `GET /v1/farms/:farmId/payment-provider`. It rechecks current membership, exposes no amounts or credentials, and reports the installed adapter's capabilities. The default response is:

```json
{
  "provider": null,
  "mode": "unconfigured",
  "configured": false,
  "capabilities": { "createIntents": false, "verifySettlements": false },
  "supportedCurrencies": [],
  "manualReceipts": { "available": true, "provenance": "manual", "providerVerified": false }
}
```

This capability response does not grant financial permissions. Existing market, animal-sale and service-payment endpoints keep their management/participant checks and manual provenance. A customer's unacknowledged service payment remains a manual declaration; the service supplier's acknowledgement is still not processor verification. Client-supplied `providerVerified` fields are rejected by the strict payment schemas.

`src/integrations/payments.ts` defines the server-only `PaymentProvider` contract, `createPaymentProvider` factory and `UnconfiguredPaymentProvider`. The trusted composition root may inject a reviewed adapter using `buildApp(db, origin, { paymentProvider })`; requests and environment flags cannot select a processor. The default adapter refuses both `createIntent` and `verifySettlement` with `PaymentProviderUnavailableError` (`code: payment_provider_unconfigured`, status 503, non-retryable until configured). This is an internal adapter error: this release exposes no HTTP intent, settlement or provider-activation route.

The internal contract uses exact `bigint` minor units plus currency, farm-scoped obligation references, stable idempotency/intent/event/transaction identifiers, and explicit `test` versus `live` mode. Intent creation is separate from independently verified settlement. Adapter calls do not write financial entries; existing manual receipts never call this interface. [Provider activation requirements](operational-integrations.md#payment-provider-activation) describe the additional processor-specific work needed for live settlement.

## Machinery and services

`GET /v1/services?q=` is public. Manager `POST /v1/farms/:farmId/services` accepts `{id,name,description,serviceArea,rate,currency,rateBasis,operatorIncluded,fuelIncluded,terms?,resourceAssetId?}`. Link listings for the same physical machine to the same provider-owned asset when applicable.

`POST /v1/services/:serviceId/bookings` takes `{id,farmId,projectId?,startsAt,endsAt,note?}`. A request is not a confirmed booking. `GET /v1/farms/:farmId/bookings` gives authorized requester/provider records. `POST .../bookings/:bookingId/status` requires `{status,version,amount?,currency?}`. Provider quotes; customer explicitly accepts the current version; customer records completion; either party may cancel eligible states. A stale version returns 409. Completion creates one agreed project expense. Confirmed resource overlaps are rejected; unlinked listings can only be checked individually.

`POST /v1/reviews` takes `{id,bookingId?|orderId?,rating,note?}`, exactly one interaction ID, and permits reviews only from the authorized customer after completion.

## Error handling and persistence

401 requires renewed authentication. 404 hides inaccessible farm resources. 409 distinguishes idempotency mismatch, insufficient stock, treatment restrictions, stale versions, overlaps and command-state conflicts. 429 must respect retry/backoff. Do not silently turn a validation/permission refusal into offline success. A field record can stay as a recoverable local draft, but the server remains authoritative.

These APIs are backed by versioned PostgreSQL migrations, immutable source events and transactional effects. See [status.md](status.md) for the full requirements matrix and the distinction between software verification and physical commissioning/provider activation.
