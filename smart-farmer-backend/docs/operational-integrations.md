# Operational integrations and activation

All providers are disabled or explicitly simulated until configuration and farm consent exist. No real farm coordinate, sensor reading, financial balance, camera endpoint or provider credential is seeded. API contracts are in [operations-api.md](operations-api.md); source code and verification fixtures live in `src/operations`, `src/integrations/object-store.ts`, `test/operations.test.ts`, `test/object-store.test.ts` and `edge/test`.

## Runtime and independent processes

Use Node 24 and PostgreSQL 17. The API, maintenance worker, web frontend, native clients and gateways run independently. Start API/worker with the same reviewed database schema and server secrets. `GET /health` checks process availability; `GET /ready` checks the operational schema/database. Farm operations health exposes worker freshness, backup outcome and pending garbage; a stale worker requires investigation, not an assumption that a container restart recovered all work.

The worker expires commands and reservations, retires camera/field media according to approved retention, creates deduplicated due-work notifications, sends opted-in provider messages and checks push receipts. Database claims use locks to prevent concurrent deliveries. Interrupted sends become `unknown`; they are not blindly treated as successful or redelivered.

## Weather

Set `WEATHER_PROVIDER=open-meteo`. Production requires `OPEN_METEO_API_KEY` and uses the customer API. Confirm the provider account/licensing and quota for the intended commercial use. The owner must explicitly enable farm weather and enter confirmed latitude/longitude; default coordinates are null. Refresh fetches a three-day forecast with UTC instants, declared units, source URL and retrieval time. The interface separately displays manual/gauge observations, instrument/calibration/source and observation time. Six-hour-old forecasts are marked stale. Forecast precipitation never becomes a measured rainfall record.

Official references: [Open-Meteo forecast API](https://open-meteo.com/en/docs), [Open-Meteo terms](https://open-meteo.com/en/terms).

## Companion provider and reference governance

The record-based Companion, templates, proposed schedules and approvals work without an LLM. To enable contextual model explanations, configure `AI_BASE_URL` to an approved OpenAI-compatible HTTPS API origin/base path, `AI_MODEL` and `AI_API_KEY`, then explicitly enable the farm's AI setting. The server sends only the requested project context, current tasks, recent sourced observations/plans and references selected from that farm. Provider credentials stay on the server. Choose an endpoint/model whose data handling fits the farm's requirements.

References are farmer/manager supplied source texts with HTTPS source URL, publication date, version, language and reviewer statement. There is no invented agronomy corpus or claim of fluent/veterinary review. External reference text is treated as evidence, never permission to execute tools. Model replies are validated JSON; supplied reference IDs are checked against that farm's selected sources. Chat has no tool/action authority, never controls equipment, settles money or marks tasks complete. Proposed plans use separate versioned, explicitly approved business endpoints.

Cross-farm sharing defaults off and is stored as a separate consent choice. Enabling ordinary AI does not enable a training pipeline or cross-farm retrieval; no such pipeline runs in this release. No unsupported speech recognition/text-to-speech service is advertised; ordinary voice attachments remain available.

## Notifications and delivery truth

`NOTIFICATION_MODE=disabled` is the default. For isolated tests only, `NOTIFICATION_MODE=simulated` returns simulated outcomes and exposes ownership verification codes. Simulated mode is rejected as configured in production. Set `PROVIDER_SECRET_KEY` to a separately protected 32-byte hex key before using channels; addresses are encrypted with AES-GCM and bound to their channel ID. Preserve this key under the same custody controls as the database backup encryption key, using a distinct key value.

For real delivery set `NOTIFICATION_MODE=live` and configure:

| Channel | Configuration | Delivery meaning |
| --- | --- | --- |
| Push | Expo device/project setup; optional `EXPO_ACCESS_TOKEN` where required | Ticket means accepted; receipt is checked later; neither is human acknowledgement |
| Email | `RESEND_API_KEY`, validated `NOTIFICATION_FROM=Smart Farmer <notifications-farmer@onesa.eu>` | Accepted by provider; not claimed as inbox/human delivery |
| SMS | `SMS_WEBHOOK_URL`, `SMS_WEBHOOK_TOKEN` | Gateway must implement the documented idempotency contract and return accepted/delivered status honestly |

The selected email identity is **Smart Farmer <notifications-farmer@onesa.eu>**, on the shared `onesa.eu` sending domain. This is the value in `.env.example`, not an override of an existing protected runtime value. `NOTIFICATION_MODE` remains `disabled`; a sender example or a verified domain does not enable delivery, create an inbox, qualify recipient delivery, or grant notification consent. The sender must be one valid mailbox, optionally with a display name; control characters and header injection are rejected. Configure the sender and provider credential on the worker as well as the API that sends ownership verification codes.

SMS webhook contract: HTTPS `POST` with bearer authentication and `Idempotency-Key: <delivery-id>`, body `{id,to,text}`, response `{id,status:"accepted"|"delivered"}`. Every successful email, SMS or Expo ticket response needs a nonempty string receipt ID; malformed success responses remain uncertain. For SMS, the provider must retain the same key's outcome for at least 24 hours and return it for identical retries without sending a second SMS. Conflicting key reuse must be rejected. **Qualify that provider-side idempotency contract before enabling SMS**; preserving bytes locally does not prove that an arbitrary webhook deduplicates. Do not enable an adapter that ignores the key. Provider/network uncertainty stays explicit.

Queued `notification_deliveries` freeze the exact serialized provider request before the first provider call. Migration `009_notification_delivery_requests.sql` adds an AES-GCM encrypted request snapshot, body hash and preparation time without changing existing IDs, attempts, statuses or receipts. The authenticated encryption context binds the delivery, notification and channel IDs. The request binds its original recipient, provider endpoint and a nonsecret fingerprint of the credential; raw authorization credentials are never persisted. The claim transaction requires PostgreSQL `fsync=on`, sets `synchronous_commit=on` locally, and commits the encrypted snapshot and `sending` state before POST. This is a software durability boundary; storage, backup/restore and power-loss behavior still need deployment qualification.

Retries reuse the original request bytes and delivery ID, including the original sender, message, language and recipient. Changing the configured sender or notification text therefore affects newly prepared requests. Changing the provider credential/account, endpoint, mode, recipient identity or encryption key holds an attempted request as `unknown` instead of silently rebinding it. Unreadable, inconsistent or expired snapshots also hold. Automatic retries stop 23 hours after preparation, within Resend's documented 24-hour idempotency retention, and retain the existing attempt limits. The same conservative age bound applies to the qualified SMS contract and known push rate-limit retries. A later rate limit cannot turn an earlier unknown provider outcome into a definite failure. An accepted receipt remains provider acceptance, not proof that a person received or read a message.

Before this migration/version cutover, stop all old notification workers, retain a verified database/key backup, apply the additive migration through the existing runner, and start only the reviewed worker version. Do not run an older worker alongside or roll it back over the new retry records: it can rebuild current input under an existing key. Legacy pending rows with a prior attempt, start time, error or receipt and no snapshot cannot safely reconstruct their original request, so the new worker holds them for protected operator/provider reconciliation. Interrupted `sending` rows remain `unknown`; unknown rows are never automatically requeued. Preserve original IDs, snapshots, attempts and provider receipts during reconciliation. Do not reset counters, replace the payload or invent a new key to bypass a hold. Custody/key rotation must account for both existing encrypted channel addresses and pending request snapshots.

This durable replay boundary is for **queued deliveries**. Ownership verification remains an explicit direct-send flow: replaying channel creation returns the existing channel without sending again, and an authorized resend after its cooldown creates a new code and a distinct verification key. It does not automatically retry an uncertain earlier verification request. Verification expires after ten minutes and five wrong attempts; rate limits apply.

Push sends are not automatically retried after an ambiguous outcome because Expo does not make that a guarantee of exactly-once delivery. Device-not-registered receipts disable the token. A user must opt into each channel for each farm. Quiet hours use the farm timezone and may span midnight. Equal quiet-hour start/end means all-day quiet. Pending retries recheck membership, channel ownership/verification, opt-in, disablement, acknowledgement and camera access before a claim. Cancellation stops future attempts; it is not proof that an earlier uncertain attempt was never accepted. User acknowledgement is a separate inbox operation.

Messages are localized using the account language. User-authored titles/notes retain their original language. Task assignment, due work, incidents, maintenance, stale equipment and camera events use stable deduplication keys; a task overdue by a day escalates to managers. Camera notifications require current camera access when read/delivered. Shared-device clients must disable their push channel when signing out. Successful verification of the same push token by another account disables older-account registrations.

Official references: [Expo sending and receipt handling](https://docs.expo.dev/push-notifications/sending-notifications/), [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys), [PostgreSQL durable commit settings](https://www.postgresql.org/docs/17/runtime-config-wal.html).

## Payment provider activation

The payment boundary is implemented in `src/integrations/payments.ts`. Its default adapter is explicitly unconfigured: it cannot create a processor intent, verify settlement, or change a ledger. `GET /v1/farms/:farmId/payment-provider` reports this state to authenticated farm members. Manual market, animal and service receipts remain usable with their existing permissions, source records and `providerVerified: false`; a service supplier's manual acknowledgement is not processor settlement.

No processor is selected, no payment network call is made, and no environment flag enables a pretend live integration. To integrate a specific processor later:

1. Supply an authorized merchant account, supported currencies and settlement terms, reviewed HTTPS API/webhook origins, and server-only credentials. Keep test and live accounts separate. Currency minor-unit conventions and provider amount limits must be explicit.
2. Implement `PaymentProvider` and inject it at the trusted application composition root. `getStatus` must remain local and return truthful capabilities and `test` or `live` mode. `createIntent` receives an authorized farm/obligation reference, actor, stable idempotency key, expiry and exact `bigint` minor-unit amount; validate ranges before transport encoding and never round through floating-point arithmetic. An accepted intent is not a payment receipt.
3. Implement `verifySettlement` using independently authenticated provider API responses or a separately signature-verified webhook. Match the provider reference to the correct farm, obligation, amount and currency; retain provider transaction/event IDs and event/check times. Pending, failed, timed-out or ambiguous observations cannot become settled cash. Test-mode results must never enter live ledgers.
4. Add the processor-specific authorized intent/settlement orchestration and durable event deduplication before exposing live operations. Persist distinct provider provenance transactionally under the relevant obligation lock, enforce balances/refunds and uniqueness, and retain the original manual records. Browser claims, redirect URLs and a customer saying they paid are not verification. This release deliberately exposes only the read-only capability route; injection alone does not add settlement endpoints or financial writes.
5. Run the processor's isolated contract checks for signature/authentication failure, wrong farm/reference/currency/amount, duplicate and out-of-order events, expiry, cancellation/refund and uncertain outcomes. Review the reconciliation and activation procedure with the account owner before production use.

The current payment tests exercise default refusal, capability authentication/isolation, absence of financial effects, explicit test-mode reporting, and unchanged idempotent manual receipts for all three obligation types. They do not claim that any external processor has been commissioned.

## Private media and cameras

`MEDIA_PROVIDER=file` uses a private persistent `MEDIA_ROOT`; immutable filenames include farm ID, object ID and SHA-256. `MEDIA_PROVIDER=s3` uses a private bucket, `S3_BUCKET`, optional HTTPS `S3_ENDPOINT`, region and server-only AWS credentials or workload identity. Temporary AWS credentials may include `AWS_SESSION_TOKEN`. Block public bucket access and configure encryption/retention according to the deployment's requirements. No presigned public camera URL is generated.

S3 writes use conditional creation and checksums; retries must match existing bytes. API reads verify object integrity. The S3 protocol tests use an isolated compatible HTTP fixture with signed requests, conditional writes, collision handling and full independent-backup readback. They do not prove a particular cloud account's policy or availability.

Field photos/audio are capped at 5 MiB each. Farm field media defaults to 250 MiB, camera segments to 500 MiB; configure `MEDIA_FARM_QUOTA_BYTES` and `CAMERA_FARM_QUOTA_BYTES` for an approved capacity plan. Ordinary field evidence is retained indefinitely unless an owner explicitly selects a minimum 30-day retention. Public listing photos remain referenced and are not automatically retired. Camera retention is per-camera, 1–90 days. Expired metadata is retired with an audit record and object keys enter delayed garbage collection.

Garbage collection only removes known keys after rechecking all live references. A bounded periodic scan also finds interrupted-upload orphans older than 24 hours. Deletion is coordinated with the same advisory lock used by backups. Immutable data and metadata are never silently treated as a successful upload after a checksum mismatch. S3 policy must grant the service only its bucket/prefix and the required Get/Put/Delete/List operations.

Camera playlists and segments require a short-lived session token with current farm membership/camera grant rechecked on every request. Web HLS and native video use the scoped token in an Authorization header. Same-origin Safari playback uses the issued HttpOnly, Secure-in-production, SameSite=Strict session cookie. A web/API same-origin proxy is required for that Safari path; browser third-party-cookie behavior is not treated as a reliable cross-origin transport. CORS permits only `WEB_ORIGIN` with credentials. Credentials never appear in playlist URLs.

Camera configuration covers capability flags, detection zones, active schedules, deduplication and retention. Unknown person analytics remains disabled. Snapshot requests trigger a bounded edge capture; the response includes original observation time and source. Live viewing requests activate low-bandwidth capture for the session duration. Event clips are private and expire with their retention policy. Camera credentials remain in the gateway's protected configuration. See [hardware commissioning](hardware-and-commissioning.md).

## Independent encrypted backup and recurring restore

Build first (`npm ci && npm run build`). `scripts/backup.mjs create` takes an exported repeatable-read PostgreSQL snapshot, dumps that exact snapshot, and copies/checksums every referenced field/camera object from the selected store. The snapshot lock prevents retention or garbage collection from deleting those objects during capture. The bundle is encrypted with AES-256-GCM; only a private owner-readable 32-byte `BACKUP_KEY_FILE` is accepted. Keep that key off the database/media host and test recovery access.

Direct creation:

```sh
node scripts/backup.mjs create --output /private/backup/farm.sfbak
```

The independent scheduler uses separate destination credentials (`BACKUP_S3_BUCKET`, region/endpoint, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`). It rejects the same media bucket/endpoint. After upload it downloads and hashes the entire encrypted object to verify the independent copy. Enable only after configuration with `BACKUP_ENABLED=true`:

```sh
node scripts/offhost-backup.mjs --drill
```

`--drill` additionally requires `RESTORE_ADMIN_DATABASE_URL` pointing to an explicitly separate recovery administration database. It creates a uniquely named `smart_farmer_restore_drill_*` database, restores/checks attachments, then drops only that generated test database. The production source and existing databases are never a restore target. Results, failure status and verified hashes are recorded in `backup_runs`; secrets and connection strings are omitted from log messages.

For a manual recovery, create an empty database named `smart_farmer_restore_<unique_suffix>`, set `RESTORE_DATABASE_URL`, and use an empty destination directory:

```sh
node scripts/backup.mjs restore --archive /private/backup/farm.sfbak --media-dir /private/recovery/media --confirm-empty-target
```

The restore verifies authenticated encryption and checksums before restoring a single database transaction, rejects nonempty databases/directories and checks every restored object's bytes. It restores a file-based media tree independent of the original provider. A production S3 cutover must use an empty recovery bucket/prefix and a verified upload of this tree; keep it isolated until the operator approves the switch. Restoring this directory is not an automatic production cutover.

`ops/smart-farmer-backup.service` and `.timer` provide a daily backup/restore-drill schedule. Install only on the authorized host, create the dedicated OS user and protect `/etc/smart-farmer/backup.env`. Configure monitoring for failed service runs and stale/missing successful backups. `Dockerfile.backup` supplies Node 24, PostgreSQL 17 clients and Python 3.13 on Debian Trixie; it is independently buildable. The image build executes a restricted archive-extraction check as its unprivileged runtime user, verifying an ordinary file restores and traversal outside the target is refused. Mount the source media read-only when using the file store and mount the key read-only with the correct owner permissions. Destination expiry/lifecycle policies must be explicitly approved; the tool does not delete historical independent backups.

## Migration, release and rollback

Take and verify an independent backup before applying new migrations. Stop accepting writes for the final cutover/rehearsal where a fully consistent operator decision is required. Run `npm run migrate` once, then start the matching API and worker build. The runner records applied migration names under an advisory lock and applies new files transactionally; it does not compare checksums of previously applied files. Keep published migrations immutable through review and add corrections as new ordered migrations. Validate the new build against an isolated restored copy first.

Migrations 005/006 add product and operational tables/columns and constraints. Do not run a destructive down-migration over newly recorded work. If a code rollout must be rolled back, stop the new writers and use a previous build only after verifying schema compatibility on the recovery copy. For a data rollback, restore the verified pre-change archive into a new isolated target, reconcile work recorded since the backup, then have the owner approve the database/media target switch. Preserve the failed deployment's records for reconciliation. A single API/database host is not high availability.

The remaining production inputs are the authorized HTTPS target, capacity limits, independent destination/key custodian, provider accounts/consent, actual hardware documentation/commissioning and distribution/signing identities. These are activation inputs; deterministic farm records and simulated acceptance remain usable without them.


### Restore verified media to a separate object bucket

After an isolated database/media restore and `npm run build`, `node scripts/restore-object-storage.mjs --media-dir /verified/restore/media --confirm-isolated-storage` copies only database-referenced field photos, audio, camera clips and snapshots. Set `RESTORE_DATABASE_URL` to the isolated restored database and `RESTORE_MEDIA_S3_BUCKET`, `RESTORE_MEDIA_S3_REGION`, `RESTORE_MEDIA_S3_ENDPOINT` (when applicable), `RESTORE_MEDIA_S3_ACCESS_KEY_ID`, `RESTORE_MEDIA_S3_SECRET_ACCESS_KEY` and optional `RESTORE_MEDIA_S3_SESSION_TOKEN` to a separate recovery bucket. The source media bucket and backup bucket are rejected as destinations. The destination must be empty; `--resume-verified-copy` permits an interrupted copy to continue using immutable writes and byte/checksum verification. Source paths and hashes are checked and every remote object is read back. The utility never changes the application endpoint or performs production cutover.

Retired objects remain charged to the relevant farm quota until deletion succeeds. Camera usage includes both clips and snapshots. Media policy reports active and pending-deletion bytes separately. Unknown orphan objects are conservatively charged to both limits until cleanup.

Notification activation can recover from an expired or uncertain verification delivery: the owner of a channel can request a new code through its `resend` route after one minute. A disabled channel requires fresh ownership verification. Ordinary push notifications contain only a translated request to open the private inbox; farm record titles and notes are not placed on a shared device lock screen. Verification pushes contain the short-lived ownership code. OS/provider messages already accepted may still arrive after sign-out; the native client also unregisters its push channel during sign-out.


Camera zone IDs must correspond to actual preconfigured device analytics zones in the gateway's explicit topic mapping. Editing a drawn polygon does not remotely program arbitrary camera firmware. With configured zones, unzoned or unmapped events are ignored; both edge and server enforce the approved schedule in farm time, including events buffered during network loss. Live viewing remains a separate explicit authorized action. Independent FFmpeg capture batches are marked with HLS discontinuities so timestamp resets do not silently stall playback.
