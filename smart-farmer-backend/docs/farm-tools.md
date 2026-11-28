# Farm tools, advice and basic-phone access

This change extends the existing Smart Farmer applications. It preserves Onesa
sign-in, current farm memberships, the encrypted field-record queues, public
policy pages and equipment interlocks. New farm-tool mutations require an
online authenticated connection. They do not enter the offline field outbox.

Apply additive migrations `020_monitoring.sql` and `021_farm_tools.sql` before
starting the updated API and maintenance worker. `/ready` checks the new tables.
No farm facts, prices, extension contacts, reviewed agronomy or device readings
are seeded. The two independent clients contain their own interface code and
draft Shona/Northern Ndebele catalogs; fluent human approval is still required.

Forecast and threshold-rule contracts are in [monitoring-api.md](monitoring-api.md).

## Common contracts

Routes below are relative to `/v1/farms/:farmId`. Read requests require a live
session and membership in that exact farm. All writes recheck membership under
the same farm lock as revocation. The advisor also rechecks authorization after
the provider response.

Collection responses use `{items, nextCursor}` with `limit` (1–100, default 50)
and UUID `cursor`. Clients must follow the cursor to see further entries. Input
fields use camelCase; persisted record fields use snake_case. POST creates need
a caller-generated UUID `id`; retry the identical payload and ID after an
uncertain response. Reusing an ID for another payload, actor or farm returns
409. Creation audit records preserve provenance.

Owners/managers create prices, directories, guides, trials and growing systems.
Owners, managers, workers and advisers can request support visits, add trial
samples and record water measurements. Only owners/managers confirm or complete visits.
The basic-phone record channel is limited to owners, managers and workers.

## Sourced market prices

`GET /market-prices` optionally filters `commodity` and `market`, with literal,
case-insensitive exact matching. `POST /market-prices` accepts:

```json
{
  "id": "UUID",
  "commodity": "Crop or livestock name",
  "market": "Named market",
  "price": 12.5,
  "currency": "USD",
  "unit": "Explicit quantity or unit covered by the price",
  "observedAt": "ISO timestamp",
  "source": "Actual quotation or publication",
  "sourceUrl": "https://optional-source.example/",
  "note": "Optional qualifications"
}
```

These are sourced observations, not executable offers or automatic market
settlements. Currencies and unit bases stay separate. The application does not
claim that a live exchange feed is connected, infer a missing date/source, or
turn a historical quote into today's price. Managers can add verified current
quotes through the interface.

## Support centres, training and visits

`GET/POST /support/centres` holds the farm's curated directory. Creation needs
`id`, `name`, `kind` (`extension_officer` or `support_centre`), `area`, HTTPS
`sourceUrl` and actual `verifiedOn` date. Optional latitude/longitude must be
supplied together; phone uses international E.164 format, and email is optional.
No contact details are inferred.

The read endpoint sorts by distance from optional confirmed query coordinates
(`latitude` and `longitude`) or the farm's saved coordinates. `distanceKm` is null
when either side lacks a location. Cursor pagination preserves distance order.
Distance is a straight-line calculation, not a travel-time promise.

`GET/POST /support/guides` records `id`, `title`, `summary`, `content`, `language`
(`en`, `sn`, `nd`), HTTPS `sourceUrl`, `reviewedBy` and `reviewedOn`. These review
fields record an actual human's supplied attestation; the software does not
approve its own agronomy. Optional HTTPS `videoUrl` and `videoSizeKb` describe an
explicitly opened external resource. Text remains available without downloading
a video. A video size may be supplied only with a video URL.

`GET/POST /support/visits` records `id`, `centreId`, a future `requestedFor`
timestamp and `reason`. The initial state is **requested**. This saves a request
inside the farm; it does not send an external message or claim an officer has
accepted an appointment. The directory contact lets a farmer arrange the visit.
An owner/manager records the actual result with
`PATCH /support/visits/:id` and `{version, status, note}`. Valid states are
`confirmed`, `completed`, `cancelled`; completion requires confirmation first.
Stale edits return 409. Cancellation/completion retain the audit history.

## Trials with evidence

`GET/POST /trials` creates a named comparison linked to an existing farm project.
Fields: `id`, `name`, `projectId`, distinct `controlLabel`/`treatmentLabel`,
`practice`, one fixed `metric` and `unit`, actual `startedOn`, optional `note`.

`POST /trials/:id/observations` accepts `id`, `arm` (`control` or `treatment`),
finite numeric `value`, `observedAt`, `source`, optional `note` and up to eight
private `mediaIds`. Samples cannot predate the trial. Images must belong to the
same farm/project's ordinary nonfinancial activities. Receipt, asset and camera
evidence cannot be attached through this route.
The private media list exposes a read-only `trial_eligible` flag so selectors
exclude receipt-linked images even when their stored `financial` flag is false.
Both clients also require the trial's project; the API repeats every check.

`GET /trials/:id` returns `trial`, a paginated `observations` array, `nextCursor`
and `summary`. Summary uses all recorded samples, even when observation pages
are partial. It reports each arm's sample count and arithmetic mean, treatment
minus control, and relative change using the absolute control baseline. An
absent arm or zero baseline produces null, never infinity or a fabricated gain.
The visible qualification explains that this descriptive comparison does not
establish causation. It does not normalize unequal plot areas without evidence.

`shareText` is deliberately limited to the comparison. Copy/share is initiated
by the farmer; creating a trial never publishes farm records, uploads private
images to a forum, or claims a scientifically approved result.

## Hydroponics and aquaponics

`GET/POST /growing-systems` accepts `id`, `name`, `type` (`hydroponics` or
`aquaponics`), `cropProjectId`, optional `fishProjectId`, `locationId`, positive
`volumeLitres` and `notes`. A crop project is required. Aquaponics additionally
requires an actual fish project from the same farm. Project types and all farm
relations are validated by the API and foreign keys.

`GET /growing-systems/:id` returns `system`, paginated `logs` and `nextCursor`.
`POST /growing-systems/:id/logs` needs `id`, actual `observedAt`, `source`, and at
least one measurement:

| Field | Unit / validation |
| --- | --- |
| `ph` | pH, 0–14 |
| `ecMsCm` | mS/cm, 0–200 |
| `temperatureC` | °C, −10–100 |
| `dissolvedOxygenMgL` | mg/L, 0–100 |
| `ammoniaMgL`, `nitriteMgL`, `nitrateMgL` | mg/L, 0–10,000 |

These are input sanity bounds, **not** recommended operating ranges. Null means
unmeasured; zero remains zero. No fertilizer dosing, pump control or automatic
fish/crop stock adjustment follows from a log.

## Farm advisor and private photographs

The existing `POST /projects/:projectId/companion/chat` now accepts English,
Shona and Northern Ndebele (`language: en | sn | nd`). It retains `question` and
selected reviewed `referenceIds`. Optional imagery uses
`image: {mimeType, base64}` plus explicit `imageConsent: true`.

Accepted source types are JPEG, PNG and WebP, up to 1.5 MiB and 20 million decoded
pixels. The server verifies the actual file type, rejects animation, orients and
resizes to at most 1280 px, converts to JPEG and strips metadata before a
provider request. The request body ceiling is scoped to this route. Neither
the original nor base64 is logged, persisted or made public.

The existing server-side `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` adapter can point
to an approved compatible Onesa AI service. The farm must have `aiEnabled=true`.
No provider account, paid model or credential is created by this change. With
AI disabled or the provider unconfigured, the advisor supplies the existing honest
record-based context and returns `imageAnalysed:false`; it never fabricates a
visual analysis. A configured provider outage is surfaced as an error.

Model requests include permitted project facts, open tasks, observations, plans
and selected reviewed sources. Images and farm text are untrusted evidence.
The model cannot execute commands, permissions, payments, trade or treatments.
Responses distinguish unknowns, use only supplied reference IDs, and direct
uncertain plant/animal symptoms to qualified human help. No diagnosis or dose is
asserted from a photo alone. Shona/Ndebele responses carry
`languageReview:'pending'`; interface translations also await fluent review.

## Basic-phone SMS/USSD adapter

The integration supports records and alerts through a configured operator
gateway. It does not provision a telephone number, USSD short code or paid SMS
contract. `GET /basic-phone` truthfully returns `configured`, masked verified SMS
channels, the current link and supported commands. There is no invented service
number in either interface.

Set an independent 32-byte hex `BASIC_PHONE_WEBHOOK_SECRET` and the existing
`PROVIDER_SECRET_KEY` after choosing the gateway. SMS alert delivery still uses
the existing verified-channel, opt-in and quiet-hours notification pipeline.

`POST /basic-phone/link` with `{id, channelId, projectId, consent:true}` requires a
verified enabled SMS channel owned by that user. It returns a single-use
12-character code and a ten-minute expiry, bounded by the current session.
Tokens and pairing codes are encrypted at rest. Access never outlives the
original Onesa session; every provider command checks that session and its
current central grant, membership and channel status again. Signing out,
revocation or expiry stops records. `DELETE /basic-phone/link` revokes the
member's farm links.

The operator posts to `/v1/integrations/basic-phone`:

```json
{"id":"unique-provider-event-id","channel":"sms","from":"+263...","sessionId":"","text":"RAIN 12.5","timestamp":"ISO timestamp"}
```

The `X-Farmer-Signature` header is the hex HMAC-SHA256, using the decoded hex
secret, of `JSON.stringify([id, channel, from, sessionId, text, timestamp])` in
that exact order. Normalize the text to trimmed form before signing. Requests
more than five minutes old or in the future are rejected. For transport retries,
reuse the same complete envelope and event ID. A repeated ID with different
content returns 409; a verified replay never creates a second observation.

The gateway receives `{message, continueSession}` and is responsible for sending
the SMS or rendering the USSD response. No outgoing message is sent while
running API tests. Supported commands:

- `LINK <code>`: confirm the currently verified number. Exactly one active farm
  binding is allowed per physical number, including across shared-phone accounts.
- `RAIN <mm>`: record a measured rainfall observation.
- `NOTE <text>`: record a project observation without financial, stock or control effects.
- `ALERTS`: the latest three currently visible unacknowledged alerts; scheduled
  future alerts and private camera alerts without current access remain hidden.
- `STATUS`: current project open-task count and session expiry.
- `STOP`: revoke phone record access, disable that SMS channel and opt out of SMS alerts.

For USSD, empty text presents a menu. Gateway cumulative inputs `1*12.5`,
`2*field observation`, `3`, `4`, `0` map to rain, note, alerts, status and stop.
The gateway still needs actual operator acceptance tests, agreed service costs
and language review before any production basic-phone claim.

## Delivery evidence

`test/farm-tools.test.ts` exercises real disposable PostgreSQL records, tenant
isolation, role checks, pagination, idempotency, provenance, sample statistics,
project relations, consented private images, provider callbacks and live session
revocation. The web feature journeys use the real API/database and accessibility
checks. Native type checking/unit tests are distinct from installed simulator or
physical-device evidence. Record exact revisions/results in the release PR.
