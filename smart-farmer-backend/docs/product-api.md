# Product completion API contract

Version 1, additive to core-api.md and integrations-api.md. All IDs are client UUIDs, timestamps are offset ISO instants, dates are YYYY-MM-DD. POST writes are idempotent by ID+actor+canonical body; PATCH requires current version and reason. A reused ID with different content is 409. Read lists return `{items,nextCursor}` and accept `limit` (1–100, default100), `cursor` UUID; consumers must follow nextCursor. Roles: M owner/manager, W owner/manager/worker, R any farm member. Financial fields/endpoints are M. Unknown values remain null. No guidance or estimate becomes an actual event automatically.

## Planning, structured observations and review

- `GET/POST /v1/farms/:farmId/locations` R/M. POST `{id,name,kind:plot|house|pond|tank|store|other,areaHa?:number|null,description?:string}`. Private farm locations. Projects accept optional `locationId` and `onboardingMode:new|existing` (default existing).
- `GET/POST /v1/farms/:farmId/projects/:projectId/records` R/W. POST `{id,type,observedAt,note?,animalId?:uuid|null,details}`. Types and details below. Records document observations without stock/count effects; use existing activity/animal-event routes for physical movement.
  - `assessment`: `{soilType?,waterAvailability?,labourAvailability?,equipmentAvailable?,pastCrops?,objective?,location?,source}` (strings); `usableAreaHa?` number.
  - `soil_test`: `{measurement,value,unit,sampleLocation,source,reportDate}`; measurement pH/nitrogen/phosphorus/potassium/other, numeric value, explicit test/report source. Optional `testMethod`.
  - `readiness`: `{checks:[{label,done:boolean}],source}`; checks record actual readiness, not inferred completion.
  - `husbandry`, `crop_stage`, `housing`, `pregnancy`, `hatch_observation`, `grading`, `storage`: `{finding,source,grade?,location?,quantity?,unit?}`. Optional fields remain optional and must use paired quantity/unit.
  - `fuel`, `labour`, `irrigation_session`: `{quantity,unit,source,startedAt?,endedAt?,assetId?}`; fuel in l/ml, labour in hour, irrigation observation unit explicit. Optional measured flow/pressure are separate sourced records.
- `GET/POST /v1/farms/:farmId/templates` R/M. POST `{id,name,enterpriseType,source,sourceDate,steps:[{key,title,instructions,offsetDays,requiredEvidence?:string}],language:sn|nd}`. A template is farm-owned and sourced. `PATCH /templates/:id` `{version,reason,...same editable fields}` creates immutable template version; GET `/templates/:id/versions` returns history.
- `GET/POST /v1/farms/:farmId/projects/:projectId/plans` R/M. POST `{id,templateId,templateVersion,anchorAt,assigneeId?:uuid|null,note?}` returns draft plan with preview task dates; does not create tasks. Unknown planting date never supplies an anchor.
- `POST /projects/:projectId/plans/:planId/approve` M `{id,version,confirmed:true}` creates tasks once, retains template snapshot.
- `POST /projects/:projectId/plans/:planId/reschedule` M `{id,version,anchorAt,reason,confirmed:boolean}`. false returns impact preview; true applies only after preview/current version, skips completed/cancelled tasks, audits every date change and increments plan/task versions. Returns `{plan,changes}`.
- `GET/POST /projects/:projectId/comparisons` R/M. POST `{id,objective,candidates:[{crop,reason,source,estimatedCost?:number|null,currency?:string|null,waterFit:unknown|suitable|unsuitable,labourFit:unknown|suitable|unsuitable,assumptions?:string}],budget?:number|null,currency?:string|null,selectedCrop?:string|null}`. Returns explainable candidate scores based only on submitted facts/assumptions, all estimates labelled. Does not change project crop automatically.
- `GET /projects/:projectId/performance` R. Returns project, counts, production by type/unit/day, feed by unit, losses, samples, missingData, review comparison (financial data M only); no unsupported universal productivity thresholds.
- `GET /v1/farms/:farmId/animals/:animalId/timeline` R. Identity, parent/offspring IDs and paginated relevant events/records, preserving original transfer projects and observed dates.
- `GET /v1/farms/:farmId/record-review` M lists possible duplicate activities with both records and reasons, never deletes automatically.
- `POST /activities/:activityId/corrections` M `{id,action:annotate|reverse,reason,duplicateOfActivityId?:uuid|null}`. Audited one-time compensating stock/financial entries; refuses unsafe downstream stock removal.

## Money, stock and reporting

- Stock create accepts optional `{grade,locationId,packSize,packUnit}`. `packSize`+`packUnit` are paired, explicit conversion to base unit only. `POST /stock/:itemId/packs` M `{id,kind:purchase|consumption|loss,packCount,observedAt,reason,amount?:number,currency?:string}` applies configured pack conversion, one stock movement and optional purchase expenditure.
- `GET/POST /projects/:projectId/budgets` M. POST `{id,versionName,lines:[{category,description,amount,currency}],reason}` immutable budget versions. Categories seed/fertiliser/feed/fuel/labour/equipment/transport/care/other.
- `GET/POST /projects/:projectId/opening-balances` M. POST `{id,asOfDate,kind:cost|sales|cash_received,amount,currency,source}` documents opening finances without fabricating historical transactions.
- `GET/POST /v1/farms/:farmId/expenses` M. POST `{id,projectId?:uuid|null,category,amount,currency,observedAt,note,receiptActivityId?:uuid|null}`; shared costs may initially have no project.
- `GET/POST /v1/farms/:farmId/expenses/:entryId/allocations` M. POST `{id,allocations:[{projectId,amount,basis}]}`; total allocations cannot exceed original expense. Retains source cost once; reports subtract outflow/add inflow without duplicating farm expenditure.
- `GET /v1/farms/:farmId/reports/summary?projectId=&from=&to=&period=day|week|season` M. Totals separated by currency and kind; budgets/actuals, production, cash received/unpaid, opening balances, shared allocations, input valuation, missing-cost indicators, recorded margin clearly limited to recorded costs (complete profit remains unclaimed without completeness declaration). Farm timezone determines period boundaries.
- `GET /v1/farms/:farmId/reports/performance?projectId=&from=&to=` R; financial fields M only. Daily/weekly activities, stock, animal metrics, irrigation/fuel/labour usage and maintenance references.
- `GET /v1/farms/:farmId/reports/summary.pdf?language=sn|nd&projectId=&from=&to=&period=` M returns localized downloadable report. `GET /reports/summary.csv` same data, safe cells. Existing CSV/report routes remain compatible.

## Fish production extensions (existing animal events endpoint)

New enterprise types: `fish_breeder`, `fish_hatchery` (hatchery current_count represents eggs, not fish). Existing fish/fish_nursery remain unchanged. These are optional projects, never seeded.

- Event `spawning`: fish_breeder source, `count` eggs, fish_hatchery `destinationProjectId`, `metadata:{eggCountBasis:verified|estimated,source,damId?,sireId?}`. Broodstock count unchanged; egg count added; restrictions/traceability carry.
- Event `fish_hatch`: fish_hatchery source, `count` live fry (zero permitted for failed hatch), fish_nursery destination when count>0, `metadata:{eggsProcessed,source}`. Removes processed eggs, adds only live fry. Normal downstream transfer then moves fingerlings to fish grow-out.
- Event `egg_disposition`: chicken/fish hatchery, positive `count`, `note`, `metadata:{disposition:loss|discard|test,source}`; removes eggs without creating animals.
- Existing transfers never mix hatchery eggs with live fish; spawning/hatching remain dedicated operations. Existing costAllocations apply to documented transfers, not a second purchase.

## Marketplace extensions

Existing stock listing/order/payment routes retain shapes and gain:

- Listing create: existing fields plus optional `animalProjectId` **instead of** `stockItemId`, `category:produce|input|animal|equipment|other`, `grade`, `condition`, `priceBasis`, `availabilityAt`, `expiresAt`, `expectedHarvest:boolean` (defaultfalse), `photoMediaIds:uuid[]`. Expected harvest is explicitly provisional and cannot reserve unproduced stock. Animal listings derive live count and use `bird|rabbit|fish`, not duplicate stock inventory.
- GET public listings returns version, public fields, available quantity, publication status, public photo URLs and review aggregates; never exact private farm location or project/animal IDs. Own farm listing feed includes private linkage for managers.
- `PATCH /v1/farms/:farmId/listings/:listingId` M `{version,reason,title?,price?,currency?,collectionArea?,terms?,grade?,condition?,priceBasis?,availabilityAt?,expiresAt?,photoMediaIds?,status?:active|archived}`. Financial/order snapshots remain unchanged; expired/archived listings cannot accept orders.
- `GET /v1/market/listings/:listingId` public shareable listing detail; photos through `/photos/:mediaId`. Only deliberately published non-financial photo attachments are public while the listing is active.
- Existing create-order body adds optional `identityIds` for named animals. Live reservations atomically reserve project count and chosen identities; fulfilment decreases live count once, records a sale event and revenue; cancellation/expiry releases reservations. Restrictions are checked on reservation and fulfilment, and direct animal releases cannot consume reserved animals. Orders expire after24h by default and return `expires_at`.
- `GET/POST /v1/market/listings/:listingId/enquiries`: authenticated buyer/seller; POST `{id,message}`. `POST /v1/market/enquiries/:enquiryId/messages` `{id,message}`; only participants; GET enquiry includes messages.
- `GET/POST /v1/market/listings/:listingId/offers`: authenticated buyer/seller; POST `{id,quantity,amount,currency,message?,expiresAt}`. Amount is the total offer. `POST /v1/market/offers/:offerId/status` seller `{id,version,status:accepted|rejected}` or buyer `{...,status:withdrawn}`. Acceptance creates an atomic reservation order at agreed amount, never a second unreserved promise. Responses include orderId.
- `GET/POST /v1/market/requests`: public browse/authenticated creation `{id,title,category,quantity,unit,area,details,expiresAt}`. `PATCH /v1/market/requests/:id` owner `{version,reason,status:open|closed,...editable fields}`. `GET/POST /requests/:id/responses` participants, POST `{id,message,listingId?}`; supplier deliberately shares listing, private farm data never exposed.
- `POST /v1/market/reports` authenticated `{id,listingId?:uuid,requestId?:uuid,reason}`. `GET /v1/farms/:farmId/moderation` M shows reports against own published resources; `POST /moderation/:reportId/resolve` M `{id,action:archive|dismiss,note}`; all actions audited. Operators use explicit environment-configured moderator IDs, no self-assigned global moderator permission. Global moderator queue `/v1/market/moderation` only configured moderators.
- `GET /v1/market/listings/:listingId/reviews` and `GET /v1/services/:serviceId/reviews` public completed-interaction reviews; existing POST `/v1/reviews` unchanged.

## Machinery & Services extensions

- Service create gains optional `minimumCharge`, `mobilisationCharge`, `cancellationTerms`, `capability`, `availabilityNote`; same currency as rate. Resource link unchanged.
- `GET /v1/farms/:farmId/services` M own listings; `PATCH /services/:id` M `{version,reason,...editable fields,active?}`. Resource identity cannot change while confirmed bookings exist.
- Booking create accepts optional `taskId`, `requestedQuantity`, `requestedUnit`. Task must belong to customer farm/project. Existing quote status body can add `workDescription`, `quotedQuantity`, `quotedUnit`, `depositRequired` (monetary amount), `mobilisationCharge`; quote version must be explicitly accepted.
- `POST /v1/farms/:farmId/bookings/:bookingId/work` provider M `{id,observedAt,quantity,unit,note}` logs actual work against accepted scope; no automatic completion/payment.
- `GET/POST /v1/farms/:farmId/bookings/:bookingId/payments` participant M; POST `{id,kind:deposit|balance|refund,amount,currency,note}` records a manually declared payment; `providerVerified:false`. Total charges/deposit balances/cash remain distinct; refunds cannot exceed recorded paid cash. Completion charges expense once; provider revenue once; payment ledgers preserve provenance.
- `POST /.../bookings/:bookingId/amendment` provider M `{id,version,amount,currency,reason,workDescription}` proposes a revision; customer `POST /.../amendments/:id/accept` `{version,confirmed:true}` accepts exact new charges. Existing accepted quote unchanged until explicit acceptance. Final completion uses accepted amount, records actual-vs-agreed and optionally completes linked task with job evidence.
- `GET /.../bookings/:bookingId/history` participant M shows quotes/status changes, work, payments and amendments.

## Release and maintenance

`registerProduct(app,ctx)` registers additive product routes. `runProductMaintenance(client)` expires listings/buyer requests/offers and releases expired reservations transactionally; root maintenance worker calls it. Core/livestock/commerce list endpoints gain cursor support without removing existing fields. No fixture farm records or production messages are seeded.

## Final refinements and integrity rules

### Scoped adviser participation

`adviser` remains the existing membership role (a veterinary adviser uses that role). In addition to reading permitted farm context, advisers may write observation/rain activities without stock, money or task-completion fields; sourced assessment, soil, husbandry, pregnancy, hatch-observation, crop-stage and housing records; observation/care/water-observation/growth-sample animal events without count, stock, transfer or money effects; and incidents. They may update incident notes/status only where they are the creator or assigned responder. They may upload their own non-financial evidence. They cannot change project counts, stocks, finances, assignments, plans, equipment controls or private farm commercial commitments. Public personal buyer participation belongs to the authenticated account and is independent of a membership's farm role.

An activity linked by `financial_entries.receipt_activity_id` is financial evidence even when its original kind was `observation`. Non-managers cannot list/read its activity or media, or append media to it. Explicit financial asset attachments follow the same rule. Public listing photos require deliberate publication of a same-farm non-financial image. Public image responses re-encode a bounded, orientation-corrected WebP and discard EXIF/GPS/other metadata; private originals are unchanged. Camera stream segments are never listing-photo objects.

### Explicit prices and physical reservations

Listing POST/PATCH accepts `priceQuantity`: the positive number of the listing's **base units** covered by `price`. It defaults to one only for `priceBasis: "unit"`; a custom bag/lot basis requires an explicit quantity. For example, a 50 kg bag priced at USD 20 is `{price:20, priceBasis:"bag", priceQuantity:50}` for a kg stock item. The public response includes `price_quantity`; an order for 50 kg costs USD 20. Automatic totals are rounded to the currency's stored two-decimal money precision. A negotiated offer's `amount` remains an explicit total. Existing accepted orders retain their price/currency snapshots when a listing changes.

Public animal listings include `count_basis`. Counts marked estimated never become verified merely by listing, reserving, transferring or fulfilling them. Reserving live animals locks their project and reserves the same `current_count` used by direct events. Selected identities are reserved with that order; where anonymous counts are exhausted, available identities are selected within the transaction. Direct sales/transfers cannot consume reserved animals. An identified mortality or verified count correction cancels incompatible commitments with `physical_loss_or_count_correction` before recording the physical fact. Identifying an otherwise anonymous reserved animal is rejected until that commitment is resolved. Expiry releases reservations in the same transaction and rechecks status after locks.

### Existing animal history and birth cohorts

Animal-event POST additionally accepts `historicalOnly: true` with `metadata.historySource` (a nonempty documented source). This is manager-only, must precede the project's opening `as_of_date` in the farm timezone, and writes historical evidence **without** current count, stock, financial or scheduled-task effects. Do not pass amount/currency, cost allocations or a follow-up task for a historical-only record. Ordinary count/stock mutations before the opening date return `409 historical_record_required` instead of counting the history a second time. Historical-only rows are visible in history and excluded from current-cycle flow metrics.

Animal creation additionally accepts optional `birthEventId`. It must identify an actual same-farm/same-species kindling or hatch with a positive live count. Recorded rabbit parents must agree with the mating record when provided. Concurrent identification cannot exceed the live count recorded for that birth; transfers retain this cohort link. `GET /projects/:projectId/cohort-births` returns a paginated selection of direct/upstream birth cohorts with `id`, `type`, `observed_at`, `note`, `source_project_name`, `count`, `historical_only`, `destination_project_id`, and `remainingIdentities`. Individual timeline responses additionally expose `birthEvent` and `siblings` alongside `parents`, `children` and events.

### Stock metadata, transfers and documented valuation

| Endpoint under `/v1/farms/:farmId` | Permission / input                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `PATCH /stock/:itemId`             | M; `{version,reason,name?,grade?,locationId?,packSize?,packUnit?}`. Base unit/project do not change.               |
| `GET /stock/:itemId/transfers`     | R; paginated incoming and outgoing movements.                                                                      |
| `POST /stock/:itemId/transfers`    | M; `{id,destinationStockItemId,quantity,unit,observedAt,reason}`.                                                  |
| `GET /stock/:itemId/valuations`    | M; paginated documented valuation history.                                                                         |
| `POST /stock/:itemId/valuations`   | M; `{id,version,unitCost,currency,source,reason}`. `unitCost` is a number or null; `currency` is a string or null. |
| `GET /reconciliation`              | M; stock balances against movements/reservations and animals against version-ordered event/opening ledgers.        |

A stock transfer records equal physical quantities after explicit compatible-unit conversion, keeps origin/destination, carries applicable treatment restrictions, and transfers recorded inventory value without an external purchase or sale. A linked source project requires a traceable destination project. Opposite-direction transfers lock projects and stocks in a consistent order. Whole-count stocks never acquire fractional heads/eggs/items.

Inventory purchases use weighted documented unit cost only when the prior value and purchase currency are compatible. Unknown prior value or mixed currencies leaves the result unvalued; no exchange rate is invented. A documented valuation affects future consumption/loss costs and the current stock-value view; it does not silently reprice past unvalued movements. Consumption and known-cost losses each recognize cost once. Inventory purchases are reported separately so their cost is not counted again with input consumption. Animal reconciliation marks unavailable legacy sequence/opening information as incomplete instead of manufacturing a balanced ledger.

### Financial corrections, receivables and report interpretation

| Endpoint under `/v1/farms/:farmId`                       | Permission / input                                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `PATCH /projects/:projectId/opening-balances/:balanceId` | M; `{version,amount,asOfDate,source,reason}`; old/new values retained in audit.                             |
| `POST /expenses/:entryId/reallocate`                     | M; `{id,reason,allocations:[{projectId,amount,basis}]}`; empty array clears attribution.                    |
| `GET /expenses/:entryId/allocations/history`             | M; pagination; includes current and explicitly reversed rows.                                               |
| `POST /expenses/:entryId/corrections`                    | M; `{id,reason}`; compensates one `documented_expense` and reverses its active allocations atomically.      |
| `POST /projects/:projectId/payments`                     | M; `{id,revenueId,amount,currency,observedAt,note?}` for direct animal/egg sale revenue; manual provenance. |
| `GET /projects/:projectId/ledger`                        | M; pagination; revenue rows include matched `paid` and `outstanding`; other rows return null.               |

Expenses feed includes `reversed`. The normal allocations feed returns active attribution; history keeps previous attribution and reversal actor/time. Corrections create compensating ledger entries and retain the original expense. Retrying cannot compensate twice, and a reversed expense cannot be allocated again. Activity-based cost corrections use the activity correction endpoint so linked stock and completion evidence are handled together. If a reversed activity was a task's sole completion evidence, the task becomes blocked with an audit reason.

A summary contains currency-separated `byCurrency` with `recordedCosts`, `recordedSales`, `cashReceived`, `cashPaid`, `inventoryPurchases`, `inputConsumption`, `recordedMargin`, `outstandingRecordedSales`, `receivablesAsOf`, and `unearnedServiceDeposits`. **Outstanding sales are matched to their own obligations and receipts as of the report end**, including older unpaid sales. They are not calculated by subtracting unrelated period cash from period sales. Accepted but unperformed service deposits remain unearned cash; cancellation does not manufacture job revenue or an expense. Refunds reduce recorded cash and cannot exceed previously acknowledged receipts.

`recordedMargin` is a partial comparison of documented sales and documented costs, not a complete profit claim. `profit` remains null and `missing` identifies unpriced input/loss movements, unvalued current stock and unknown unrecorded costs. Opening balances are sourced facts, not fabricated historical events. Reports apply the latest documented corrections/attribution. `from` is inclusive, `to` exclusive; daily/weekly buckets and date-only opening facts use the farm timezone. Stock is a current snapshot at report generation, clearly labelled in the PDF. No exchange rates are applied. PDF exports embed the licensed Noto Sans font and preserve original entered names; PDF/CSV headings and missing-data explanations use the requested `sn`/`nd` language.

### Service payment acknowledgement and cancellation

Customer POST `/bookings/:bookingId/payments` creates a `declared` manual claim and no cash ledger effect. A provider POST records the receipt directly. A provider may acknowledge a customer claim with `POST /bookings/:bookingId/payments/:paymentId/acknowledge {}`. The booking lock serializes acknowledgement, overpayment and refund checks. Retrying acknowledgement is safe. All these records retain `providerVerified:false`; human acknowledgement is not payment-processor settlement.

GET payments returns `items`, `manuallyRecordedPaid`, `outstanding`, `depositOutstanding`, `cancelledHeldPayment`, and `providerVerified:false`. Only the provider records refunds. Cancellation retains the actual acknowledged cash until an actual refund is recorded and rejects pending amendments. It creates neither a completed-job expense nor earned service revenue. Customer amendment `/accept` and `/reject` both take `{version,confirmed:true}`; completion requires any proposal to be resolved. Task-linked completion also requires a recorded actual-work row.

### Companion, observations and history

The deterministic GET Companion now returns project facts, `nextTasks`, localized `nextActions` and `followUpQuestions`, current assessment/readiness, recent records, sourced templates, approved/draft plans, reference metadata, comparisons and related farm cycles. `finance` is manager-only. It returns `mode:"record_based"`, `provider:"deterministic_templates"`; it does not pretend to be a live model response. Plan approval remains a separate explicit authenticated write. Root operational `/companion/chat` is a separate read-only provider boundary.

Comparison candidates accept optional `soilFit`, `areaFit`, `equipmentFit`, `marketFit`, `pastCropFit`, and `locationFit`, in addition to water/labour fit and a documented cost estimate. Each fit is `unknown|suitable|unsuitable` and defaults to unknown. Unknown criteria and market assumptions are exposed. Scores are a transparent comparison of entered judgments and comparable budget data, not a universal crop/yield/profit model.

Project performance also includes `usage` (fuel/labour/irrigation-session quantities grouped by their recorded units) and farm-local `workByDay`. Counters omit reversed activities and historical-only animal flows. An estimated weight sample stays labelled as a sample; estimated biomass is not a census, and no feed-conversion ratio is asserted without measured cohort weight gain. `GET /incidents/:incidentId/history` returns paginated follow-up audit entries with actor, old/new states, reason and timestamps.

Invitation listing now follows `{items,nextCursor}`, with `limit` and UUID `cursor`; invitation secrets are never included in that feed.

### Migration and verification

Published migrations 001–006 remain immutable. Asset evidence is in operational migration 007; the additive financial correction/price-basis fields are in `008_product_refinements.sql`. Tests apply all migrations to disposable databases and additionally run the real migration command against a populated 001–006 schema, then run it again to verify it is a no-op. No production data or deployed schema was modified during implementation.

Cross-project input use and feed consumption lock source and destination projects in order, enforce the source’s recorded transfer/all hold, and carry the original restriction scope, dates and authorizer to the destination. Same-project feeding does not release the held animals and remains available. Stock quantity locks permit foreign-key readers while still serializing balance updates, so two legitimate input records need not deadlock each other.
