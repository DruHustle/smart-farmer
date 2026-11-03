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
