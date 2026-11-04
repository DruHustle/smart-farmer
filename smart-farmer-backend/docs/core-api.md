# Core API v1

This is the implemented contract. The API owns authorisation, balances, lifecycle rules and credentials. Clients must not import backend source. All timestamps are ISO 8601 instants with an offset; calendar dates use `YYYY-MM-DD`. Display operational dates in the farm's returned timezone. Numeric PostgreSQL balances are returned as decimal strings. Unknown facts are `null`.

## Identity and people

Send `Authorization: Bearer <token>` to authenticated routes. Opaque session tokens expire after seven days; the server stores only their SHA-256 digest. All responses use `Cache-Control: no-store`.

| Method and path | Request | Response / rules |
| --- | --- | --- |
| `POST /v1/register` | `{username,password,language,farmName}` | `{userId,farmId,recoveryCode}`, 201. Password 12–128 characters; usernames 3–80 letters, digits, dot, underscore or hyphen. `language` is `sn` or `nd`. The recovery code is shown once. |
| `POST /v1/sessions` | `{username,password,deviceName?}` | `{token,userId,username,language,expiresAt}`. |
| `GET /v1/me` | — | `{id,username,language}`. |
| `PATCH /v1/me` | `{language}` | Updated identity. |
| `GET /v1/sessions` | — | `{items:[{id,label,created_at,expires_at,current}]}` for this account. |
| `DELETE /v1/sessions/current` or `/v1/sessions/:id` | — | 204; revokes only this account's selected session. |
| `POST /v1/recovery-codes` | `{password}` | Reauthenticates, replaces the old code, returns `{recoveryCode}` once. |
| `POST /v1/recover` | `{username,recoveryCode,password}` | Consumes the code, changes password, revokes **all** sessions; 204. Sign in again and obtain a replacement code. |
| `GET /v1/farms` | — | `{items:[{id,name,timezone,role}]}`. |
| `POST /v1/farms` | `{name,timezone?}` | Creates an additional farm owned by the current account; `{id}`, 201. |
| `GET /v1/farms/:farmId/members` | — | `{items:[{id,username,role}]}`. |
| `POST /v1/farms/:farmId/invitations` | `{role,expiresInHours?}` | `{id,token,expiresAt}`, 201. Owner/manager; only owners can invite managers. Role is manager, worker or adviser; expiry 1–168 hours, default 72. |
| `GET /v1/farms/:farmId/invitations` | — | Invitation metadata without tokens; managers only. |
| `DELETE /v1/farms/:farmId/invitations/:id` | — | Revokes an unused invitation; 204. |
| `POST /v1/invitations/accept` | New user: `{token,username,password,language}`; existing authenticated user: `{token}` | `{userId,farmId,recoveryCode?}`, 201. One-use token; does not change an existing member's role. The issuer must still have permission. |
| `PATCH /v1/farms/:farmId/members/:userId` | `{role}` | Owners only; cannot remove the last owner. |
| `DELETE /v1/farms/:farmId/members/:userId` | — | Owners only; unassigns work and revokes farm access without altering the person's access to other farms. |

Invitations and recovery work without an email/SMS provider. Give the invite or personal recovery code to the intended person through a trusted channel. They are bearer secrets, not passwords shared by a farm. There is no claimed SMS delivery or approved Onesa SSO integration. A farm manager cannot reset another person's global multi-farm account.

## Projects and field records

`GET /v1/farms/:farmId/projects` returns `{items,nextCursor}`. Optional `limit` (1–100) and `cursor` (last project ID) paginate by creation time and ID. Fields include `id,name,crop,irrigation,planting_date,variety,objective,area_ha,stage,enterprise_type,status,version,as_of_date,opening_count,current_count,count_basis,details`. `status` is `active` or `closed`.

Owners/managers create projects with `POST` to the same route:

Clients may provide an `id` UUID and must retain it across retries after an ambiguous response. An identical request by the same actor returns the same project (200); conflicting reuse returns 409. Without `id`, the server generates a new ID for each creation request.

```json
{"name":"Existing maize","enterpriseType":"crop","crop":"maize","irrigation":true}
```

Optional crop fields: `plantingDate`, `variety`, `objective`, `areaHa`, `stage`. Unknowns remain null; no historical activity is manufactured. Animal `enterpriseType` values are `broiler`, `layer`, `breeder`, `hatchery`, `rabbit_breeding`, `rabbit_growout`, `fish` and `fish_nursery`. Their `crop` may be omitted. Documented opening stock uses `openingCount`, `countBasis` (`verified` or `estimated`) and `asOfDate`; all three are required together. Omit the count to keep it unknown. Use an explicit zero opening count for a genuinely new, empty enterprise. `details` holds bounded descriptive fields, such as species, breed, facility or location. No animal counts or farm facts are seeded.

`PATCH /v1/farms/:farmId/projects/:projectId` requires `version` and a nonempty `reason`; it accepts changed crop/name/stage/status fields in camelCase. Stale versions return `409 {error:"version_conflict",current:<current project>}`. The audit preserves the prior and updated state. Enterprise type and opening balances cannot be silently reclassified. Animal balance corrections use an adjustment event. Animal closure uses a close event.

`POST /v1/farms/:farmId/activities`:

```json
{"id":"client-generated-uuid","projectId":"project-uuid","kind":"irrigation","observedAt":"2026-11-03T10:00:00+02:00","note":"Recorded observation","quantity":10,"unit":"litre"}
```

Kinds: `work`, `rain`, `irrigation`, `observation`, `harvest`, `cost`, `input_use`. Quantity and unit are provided together or omitted. `input_use` and `harvest` require positive quantity, unit and `stockItemId`; harvest stock must belong to the same project. `cost` requires `amount` and `currency` and owner/manager permission. For a task completion in the same transaction, pass `taskId` and `taskVersion`; the task must belong to that project and be assigned to the worker or managed by the caller. The activity becomes completion evidence.

Creation returns 201 `{id}`; the same actor retrying an identical validated record returns 200 `{id}`. A changed payload or actor with the same ID returns `idempotency_conflict`. Stock, cost and task effects commit exactly once with the activity. Insufficient stock, stale task version, an invalid project or restriction rolls back the entire record. Persistent client outboxes must retain the same ID and payload for retries and expose conflicts for review.

`GET /v1/farms/:farmId/activities` returns `{items,nextCursor}` with `limit` and `cursor` pagination. It retains observation and entry times. Workers/advisers cannot retrieve cost activities. Quantity/unit on rain and irrigation are observations; no sensor accuracy or conversion from runtime to water volume is implied.

## Tasks, incidents and guidance

`GET /v1/farms/:farmId/tasks` returns `{items}`. Owner/manager `POST` accepts `{id,title,projectId?,assigneeId?,dueAt?,instructions?}`. `PATCH /tasks/:taskId` requires `{version,...changes}`. Editable fields are `status`, `evidence`, `reason`, `assigneeId`, `dueAt`, `instructions`, `title`. Status is `planned`, `started`, `completed`, `blocked` or `cancelled`. Workers can update progress only on tasks assigned to them. Completion requires evidence; a block, cancellation or reschedule requires a reason. Reopening a final task requires manager permission and a reason. Task rows return snake_case columns and `version`.

`GET/POST /v1/farms/:farmId/incidents`: create with `{id,projectId?,title,description?,severity,assigneeId?}`; severity is low/medium/high/urgent. Workers can report; managers assign. `PATCH /incidents/:incidentId` takes `{version,status,note?,assigneeId?}` where status is open/acknowledged/resolved. The responder or original reporter can update progress; assignment is managerial. Resolution requires a note. All updates retain audit history and return the new row.

`GET /v1/farms/:farmId/projects/:projectId/companion` returns `{mode:"record_based",provider:"unconfigured",missingFields,nextTasks,ruleVersion,...}`. This is deterministic missing-data and outstanding-task guidance, not a model answer or agronomy/veterinary recommendation. It does not claim work is completed or invent measurements, treatments or yields.

## Stock, costs and money

`GET /v1/farms/:farmId/stock` returns stock ID, project, name, unit, quantity, reserved quantity and version. `unit_cost` and `currency` are visible only to owners/managers. Owner/manager `POST` takes `{id,name,unit,quantity,projectId?,unitCost?,currency?}`. Supported units are kg/g, l/ml, count, egg, bird, rabbit and fish. Unit cost and currency are a pair. This is a documented opening balance, not a fabricated purchase. An opening stock movement preserves its provenance.

Only kg↔g and l↔ml are automatically converted. Count/egg/bird/rabbit/fish are distinct units. Weight is never silently converted to animal counts. Amounts have at most two decimal places; quantities have at most six. A conversion that needs more than six decimals in the stock item's unit is rejected instead of rounded into a different physical quantity.

`GET /stock/:itemId/movements` returns movement history. Owner/manager `POST` takes `{id,kind,quantity,unit,observedAt,reason,amount?,currency?}`. Kind is `purchase`, `loss`, `consumption` or `adjustment`; only adjustment takes a signed quantity. A purchase may include documented expenditure. Loss and household consumption subtract stock; consumption respects active release restrictions. Negative available stock, including reserved stock, is rejected. Input-use activity and animal feed events record consumed cost separately from purchases/expenditure.

`GET /v1/farms/:farmId/reports?projectId=...` is owner/manager only. It returns totals grouped by **both currency and kind**, stock, declared project cost transfers and unpriced input movement count. Kinds remain separate: expense, input_consumption, revenue and payment. `profit` stays null and completeness is not asserted; do not add purchases and input consumption into a purported profit without a valuation policy. Exchange rates are not fabricated. `GET /reports.csv?language=sn|nd` exports permitted financial records with translated headers and CSV-formula protection.

`GET /projects/:projectId/ledger` gives detailed project entries. For revenue from a direct animal sale, `POST /projects/:projectId/payments` accepts `{id,revenueId,amount,currency,observedAt,note?}`. Payments cannot exceed that sale's outstanding balance or use another currency; replay is idempotent. Response identifies `provenance:"manual",providerVerified:false`. Marketplace payments use the commerce endpoints. Neither flow claims provider settlement.

## Animal lifecycle records

`GET /v1/farms/:farmId/projects/:projectId/events` returns `{items}` containing incoming and outgoing traceable events. `POST` uses:

```json
{"id":"client-uuid","type":"mortality","observedAt":"2026-11-03T10:00:00+02:00","count":1,"note":"Recorded loss"}
```

Common optional fields: `destinationProjectId`, `stockItemId`, `quantity`, `unit`, `amount`, `currency`, `metadata`. A repeated ID is processed once. Source and destination rows lock together in ID order; no count is created by an internal transfer. Counts cannot become negative. Unknown balances must first be reconciled explicitly. Estimated counts retain their basis across transfers. All events require an active animal project; they cannot be sent to crop projects.

| Event | Required additional fields / effects |
| --- | --- |
| acquisition / stocking | Positive `count`; stocking is fish-only. Adds counts. Optional documented amount/currency records expense. |
| mortality | Positive count and nonempty note; subtracts counts. |
| transfer | Positive count and same-species active destination. Subtracts source, adds destination, carries restrictions. Hatchery movement uses incubation/hatch instead. |
| sale | Positive count, amount and currency; manager-only. Checks restrictions, subtracts live animals, records revenue without asserting payment. |
| feed | Stock item, positive quantity and matching/convertible unit. Deducts feed once, allocates recorded unit cost where available. |
| egg_collection | Layer/breeder, positive collected count, egg stock belonging to this project. `metadata.rejects` defaults to zero and cannot exceed collection. Only saleable eggs enter stock. Bird count is unchanged. |
| egg_consumption / egg_loss / egg_sale | Positive count and same-project egg stock. Decreases eggs, leaves flock active. Sale additionally requires amount/currency and manager permission; consumption/sale enforce restrictions. |
| incubation | Hatchery, positive egg count and source egg stock. Moves eggs from stock into incubation; traceable source restrictions follow. |
| hatch | Hatchery, recorded live chick count, `metadata.eggsProcessed >= count` and greater than zero. A positive live count requires a broiler/layer/breeder destination; a total failed hatch can record zero live chicks with no destination. Disposes the processed eggs, creates only recorded live chicks, preserves the non-hatched difference. |
| mating | Rabbit breeding; `metadata.damId`, `sireId` reference same-farm identified female/male animals. Optional user-specified `followUpAt` creates a provisional task; no gestation date is invented. |
| kindling | Rabbit breeding source, live count, `metadata.matingEventId`, optional `metadata.stillborn`. A positive live count requires a rabbit grow-out litter destination; an all-stillborn litter may record zero live count without creating a destination. Preserves the parents' count, adds only live litter count. Only one actual kindling is allowed per mating. |
| fostering / weaning | Positive count and rabbit destination. A normal traceable transfer, without duplicating animals. |
| water_observation | Fish project; `metadata.measurement,value,unit,source`, optional testType/calibration. No universal thresholds or unmeasured values are supplied. |
| growth_sample | Positive quantity in g/kg, `metadata.sampleSize` and `measurementBasis` (mean_weight/total_sample_weight). Sampling does not change animal counts. |
| harvest | Broiler, rabbit grow-out or fish; positive removed count, positive output quantity/unit, output stock from the same project. Checks restrictions, removes animals and creates saleable output. |
| care | Nonempty note and `metadata.authorizedBy,administeredBy,instructionsSource`. Records verified instructions; it does not propose a drug/dose. Record applicable restrictions separately. |
| observation | Bounded structured metadata and/or note; no automatic count effect. |
| adjustment | Manager-only; `count` is the corrected current count, `metadata.reason` and `countBasis` (verified/estimated) required. Audit preserves prior count and basis. |
| close | Manager-only; zero remaining count and nonempty closure note. No implied closure from a partial sale or first egg sale. |

Transfers, fostering, weaning, hatch and kindling can carry `metadata.costAllocations:[{amount,currency,basis}]` when an allocation to live destination animals is documented. This is an internal allocation, not another purchase or sale. Omitted cost allocation stays unrecorded. `metadata.identityIds` optionally identifies each animal in an ordinary transfer, sale, mortality or harvest; the unique IDs must match the event count and belong to the active source group. Identified active animals cannot exceed the reconciled remaining group count.

`GET/POST /projects/:projectId/animals` maintains individual IDs. Create with `{id,identifier,sex?,birthDate?,damId?,sireId?}`; sex is female/male/unknown. Birth date may remain unknown. Parent species/sex/farm and self-parenting are checked. Identification documents existing animals and does not increase group counts. Individual records retain parents after transfer and record sold/dead/harvested status.

`GET/POST /projects/:projectId/restrictions`: owner/manager create with `{id,startsAt,endsAt,scope,reason,authorizedBy}`. Scope is all/harvest/sale/transfer, with explicit verified dates. Transfer propagation preserves the original restriction identity and authorisation. Enforcement uses current server time, so backdating an event cannot bypass a currently active restriction. Project locks serialize new restrictions with release checks. Expiry does not erase history. The server does not guess medicine withdrawal periods.

## Errors and limits

Errors have `{error:<stable code>}`. Validation adds `details:[{path,message}]`; version conflicts add `current`. Core codes include unauthorized (401); not_found/project_not_found/related_record_not_found (404); invalid_input/incompatible_units (400); idempotency_conflict/version_conflict/insufficient_stock/insufficient_animals/project_closed/treatment_restriction (409). `retry_transaction` (409) means a database concurrency retry is appropriate with the same idempotent payload. Domain errors are returned without SQL details. Rate limiting returns rate_limited (429).

Activity and project feeds paginate; task/stock/incident/animal history lists currently have bounded 100–500 record windows. Full historical pagination and streamed large exports remain release work. Finite list windows must not be labelled as a farm's complete history. The API has no automatic external message delivery and no medical or equipment decisions delegated to an AI.
