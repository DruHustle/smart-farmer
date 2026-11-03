# Integrations API v1

Core identity, project, inventory and animal contracts are in [core-api.md](core-api.md). All private routes use `Authorization: Bearer <session token>`. Server permissions apply even when controls are hidden in a client. IDs are UUIDs; timestamps require an ISO-8601 offset. Monetary values have two decimal places; quantities have at most six, with whole-unit inventory enforced for countable items.

## Equipment

- `GET /v1/farms/:farmId/assets`: all farm members; returns `items` and optional `nextCursor`. Readings include `integration_state`, `capabilities`, `last_observed_at`, `latest_telemetry`, and `fresh`.
- `POST /v1/farms/:farmId/assets`: manager/owner. Fields: `id`, `name`, `category` (`borehole|pump|pivot|valve|tank|sensor|power|camera|other`), optional nullable `model`, `protocol` (`unconfigured|simulator|mqtt|http|modbus`), `parentAssetId`, and `staleAfterSeconds` (10–3600). Non-simulator transports remain unconfigured.
- `POST .../assets/:assetId/simulate`: manager/owner; `{running, interlockOk}` supplies visibly simulated state.
- `POST .../assets/:assetId/gateway-token`: owner only; returns one private asset-scoped simulation token and expiry. Reissuing invalidates the old token.
- `GET .../assets/:assetId/commands`: managers; current command history.
- `POST .../assets/:assetId/commands`: `{id, command: start|stop, confirmed: true, expiresAt}`. Fresh telemetry, a supported simulated capability, interlocks and no unresolved active command are required. Commands cannot be queued offline.
- `POST .../assets/:assetId/commands/:commandId/simulate`: explicit administrator simulator result; `{status: acknowledged|confirmed|rejected|failed, feedback?: {running,interlock_ok}, reason?}`. Confirmation needs matching feedback.
- Gateway routes use the asset token instead of a user session: `POST /v1/edge/telemetry`, `POST /v1/edge/commands/next`, and `POST /v1/edge/commands/:commandId/result`. Polling dispatches at most once. Deadline and credential validity are checked again after lock waits.

Telemetry body: `{id,observedAt,measurements:{running,interlock_ok,flow_l_min?,pressure_kpa?}}`. Field names define units; the persisted source is `simulator`. Late observations retain their original time and cannot replace a newer current-state sample. Device mapping/quality metadata for physical transports remains part of future commissioning.

## Private media

`POST /v1/farms/:farmId/media` accepts `{id,activityId,mimeType,dataBase64,filename?}` from owner/manager/worker. Upload the activity metadata first; media has independent retries. Supported MIME types: JPEG, PNG, WebP, MP4 audio, MPEG audio, WebM audio and WAV audio. The maximum decoded size is 5 MiB. File signatures, canonical base64, activity ownership and farm quota are checked. Reusing an ID with different content, ownership, MIME type, filename or activity is a conflict.

`GET /v1/farms/:farmId/media?activityId=...` lists authorized metadata. `GET .../media/:mediaId/content` returns authenticated binary data with private/no-store headers. Cost receipts require management permission. Object keys and credentials are not exposed. Content access is audited. The initial local/persistent-volume adapter implements `ObjectStore`; no external bucket credentials are configured.

## Cameras

`GET/POST /v1/farms/:farmId/camera-events` and `POST .../camera-events/:eventId/acknowledge` require owner/manager access. Create body: `{id,assetId,kind:motion|person,observedAt,retentionDays?}` (1–90 days). The camera must be explicitly simulated. Responses retain event and receipt times, distinguish delayed observations, and preserve the detection type. The maintenance worker purges expired events. No public stream endpoint exists.

## Marketplace

Public `GET /v1/market/listings?q=&cursor=` exposes only deliberate listing data and collection area; it does not expose private project, equipment or security records. Available quantity is limited by current stock minus reservations. Listings with an active sale restriction are not offered.

Managers use `GET/POST /v1/farms/:farmId/listings` and `POST .../listings/:listingId/archive`. Create fields: `{id,stockItemId,title,quantity,price,currency,collectionArea,terms?}`. Publishing is explicit. Live-animal inventory units (`bird`, `rabbit`, `fish`, or livestock-project `count`) are blocked until marketplace reservations and the live-animal ledger are linked; direct livestock sales remain available through the animal workflow.

Signed-in buyers reserve with `POST /v1/market/listings/:listingId/orders` and `{id,quantity}`. The transaction locks the source stock and listing; simultaneous attempts cannot oversell. `GET /v1/market/orders` returns the caller's buyer or authorized seller orders. `POST /v1/market/orders/:orderId/status` accepts `cancelled` (buyer or seller) or `fulfilled` (seller). Cancellation releases stock; fulfillment decrements stock and records revenue once. Treatment restrictions are checked again at fulfillment. Reservations currently remain until fulfillment/cancellation; there is no automatic reservation expiry.

Seller-only `POST /v1/market/orders/:orderId/payments` records `{id,amount,currency,note?}` against a fulfilled order. Payments are explicitly manual, cannot exceed the outstanding balance, and must use the order currency. Revenue and cash received are separate entries. No payment provider is configured.

## Machinery and services

`GET /v1/services?q=` is public. Manager `POST /v1/farms/:farmId/services` accepts `{id,name,description,serviceArea,rate,currency,rateBasis,operatorIncluded,fuelIncluded,terms?,resourceAssetId?}`. Link listings for the same physical machine to the same provider-owned asset when applicable.

`POST /v1/services/:serviceId/bookings` takes `{id,farmId,projectId?,startsAt,endsAt,note?}`. A request is not a confirmed booking. `GET /v1/farms/:farmId/bookings` gives authorized requester/provider records. `POST .../bookings/:bookingId/status` requires `{status,version,amount?,currency?}`. Provider quotes; customer explicitly accepts the current version; customer records completion; either party may cancel eligible states. A stale version returns 409. Completion creates one agreed project expense. Confirmed resource overlaps are rejected; unlinked listings can only be checked individually.

`POST /v1/reviews` takes `{id,bookingId?|orderId?,rating,note?}`, exactly one interaction ID, and permits reviews only from the authorized customer after completion.

## Error handling and persistence

401 requires renewed authentication. 404 hides inaccessible farm resources. 409 distinguishes idempotency mismatch, insufficient stock, treatment restrictions, stale versions, overlaps and command-state conflicts. 429 must respect retry/backoff. Do not silently turn a validation/permission refusal into offline success. A field record can stay as a recoverable local draft, but the server remains authoritative.

These APIs are backed by versioned PostgreSQL migrations, immutable source events and transactional effects. They are not an assertion that every workflow in the original product brief is complete; see [status.md](status.md).
