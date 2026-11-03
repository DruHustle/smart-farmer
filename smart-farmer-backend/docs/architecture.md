# Architecture

## Independent applications and processes

| Boundary | Location | Responsibility |
|---|---|---|
| Responsive web / PWA | `smart-farmer-frontend/web` | Shona/Ndebele UI, encrypted browser vault, field-record outbox, forms and rendering |
| Native Android / iPhone / iPad | `smart-farmer-frontend/mobile` | Independent React Native UI, native permissions, SecureStore, SQLCipher repository and durable sync |
| API | `smart-farmer-backend/src` | Authentication, farm-scoped permissions, validation, business transactions and versioned API |
| Maintenance worker | `src/worker.ts` | Command deadlines, expired camera events/sessions and worker heartbeat |
| Farm gateway | `edge` | Outgoing authenticated transport, durable telemetry buffer, simulator interlocks and replay journal |
| Private object storage | `src/integrations/media.ts` | `ObjectStore` interface and private filesystem/persistent-volume implementation |

Backend and frontends communicate through the documented `/v1` API. The web and mobile applications do not import backend implementation or each other's UI. There is no root shared runtime application package. Native iOS serves iPhone and iPad within one project.

## Identity and farm isolation

A user has one account and a separate role on each farm. The initial roles are owner, manager, worker and adviser. Owners govern membership, managers organize work, workers record assigned work/observations, and advisers can read permitted farm context. Invitations have hashed single-use tokens and an expiry; creating a manager invitation requires an owner. Revocation checks the current membership rather than relying on a role embedded in a long-lived token.

Passwords use salted scrypt hashes. Session and recovery secrets are random and stored hashed on the server. Sessions expire after seven days and can be individually revoked. Recovery is a single-use offline code, not a claimed email/SMS integration. Login/recovery locking prevents an old-password verification from leaving a valid new session after concurrent password reset. Changing the last owner's role/removing the last owner is denied.

Financial activities/reports/valuations and financial receipts require management permission. Media endpoints join their activity and recheck financial access. Private camera events also require management access. Public commerce returns deliberate listing details and collection/service area, not private farm location, equipment, camera or project records. Database foreign keys pair farm and entity IDs to prevent cross-farm references as well as route-level access checks.

The currently implemented username/password identity is independent of other Onesa applications. An approved Onesa identity-provider contract has not been connected. Adding such integration must preserve farm-specific membership and local worker recovery behavior.

## Records, stock and money

Crop projects preserve unknown planting facts as null; existing animals have an explicit as-of date, opening count and unknown/verified/estimated basis. Creating an opening state does not manufacture historical events.

Immutable activity IDs and validated payload hashes make replayed field submissions idempotent. Input consumption, stock movement, project cost and optional task completion commit together or roll back together. A conflicting payload under the same ID returns 409. Quantity families permit explicit mass/volume conversions; countable inventory cannot acquire fractional counts. Stock cannot go below reservations or zero.

Project/task edits use versions. Concurrent edits return conflicts instead of silently overwriting a newer record. Animal changes are auditable events; corrections require a reason. Chicken egg collection/rejects, incubation and hatch transfers; rabbit identity/parents/mating/kindling/fostering/weaning; and fish nursery/grow-out/observations/transfers/harvest share accounting infrastructure while retaining species rules.

Treatment restrictions are recorded from supplied authorization and timing. They use server time to prevent backdated releases, propagate with affected project transfers/egg-to-chick flow, and are checked at applicable harvest, transfer, sale, reservation and fulfillment steps. They currently conservatively apply at project/batch level. This is not a medication-advice or automatically verified veterinary-prescription service.

Financial entries retain currency and source. Reports aggregate by currency and distinguish expenses, consumed inputs, revenue and manually recorded receipts. Shared-project cost transfers are explicit reallocations, not a new external purchase/sale. The application does not fabricate a complete profit number when inputs are missing.

## Offline and shared devices

The browser stores AES-GCM encrypted data in IndexedDB, with an account/API-origin-specific vault and password-derived key. Tokens/plaintext are not stored in localStorage. Explicit offline unlocking is separate from a rejected online sign-in. Password recovery supports re-encrypting downloaded records with the prior local password or retaining a locked encrypted archive while starting a fresh online cache. Language preference can be changed offline.

The native client uses a separate SQLCipher database/key per account and API origin. Secrets live in the platform's SecureStore and private data requires local device unlock. The encrypted binary is required; there is no silent plaintext SQLite fallback. Actual platform encryption/permissions remain a native-device verification gate.

Both clients persist the outbox before acknowledging local recording. Metadata and media have independent retry state; a failed photo does not erase a successful activity. Conflict/permission errors retain drafts rather than pretending a write succeeded. Current farm membership is rechecked on reconnection. Rejected/revoked access is never bypassed by cached roles. Locking/account switching closes the active private workspace.

Purchases, bookings, permissions and equipment commands require online server authorization. They are excluded from ordinary deferred field-work queues. In particular, reconnecting cannot start a pump from a stale offline action.

## Equipment and privacy

Real hardware remains unconfigured. Explicit simulator assets have narrowly defined capabilities and telemetry provenance. A command must be authorized, current, supported and unexpired, with fresh device state and local interlocks. Dispatch occurs once; acknowledgement and feedback confirmation remain distinct. The gateway rechecks deadlines locally, persists its replay journal and buffers observations only. Pending commands become expired or outcome-unknown as appropriate, never silently retried.

Private media is stored outside the relational database under server-generated UUID/hash keys. MIME signatures, canonical encoding, size, quota and actor/farm checks protect uploads. Authenticated downloads check content hashes and write access audit records. The public web server never mounts the media directory. Unknown camera URLs are not fetched by the backend; a future camera adapter needs a separately reviewed destination policy.

## Limits and production state

The repository contains no production seed records and no external provider secrets. AI Companion guidance is deterministic and explicitly identified; live model inference, speech services, weather feeds, remote notification delivery and payment settlement are not configured. Physical adapters, ONVIF/RTSP video, native device acceptance, language review and actual hosting recovery must be completed before representing the system as production-validated.

The local container topology is one API/database/worker installation with durable volumes; it is not high availability. Independent encrypted backup/restore tooling and CI coverage are documented in [operations.md](operations.md). The [acceptance matrix](status.md) identifies remaining software scope as well as external prerequisites.

## Reference basis

The existing Node 24/Fastify/PostgreSQL baseline was retained; dependencies are locked independently. Transaction design follows PostgreSQL 17's documented row/advisory locking rules. Native dependencies/configuration were selected against the current Expo documentation. User/API schemas are application-owned; uploaded text never becomes executable validation code.

- https://www.postgresql.org/docs/17/explicit-locking.html
- https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/
- https://nodejs.org/docs/latest-v24.x/api/fs.html
- https://docs.expo.dev/workflow/overview/

Repository code, tests and current CI are the evidence for implementation status; these documentation links do not establish that a specific app workflow has passed.
