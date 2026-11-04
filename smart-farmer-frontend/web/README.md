# Smart Farmer web

An independent React/TypeScript client for the Smart Farmer HTTP API. It does not import backend or native-app implementation code. The primary destinations are Today, Farm, Market, Services, and More; a sidebar replaces the bottom navigation on larger screens. Shona (`sn`) and Zimbabwean Northern Ndebele (`nd`) are the only interface catalogs. The catalogs are machine-authored and still require fluent agricultural review before a farm rollout.

## Build and run

Use Node.js 24 and the locked dependencies:

```bash
npm ci
cp .env.example .env.local
npm run dev
npm test
npm run build
```

Run the backend separately according to its README. `VITE_API_URL` must identify that API, and `WEB_ORIGIN` on the API must match the website. The API URL is embedded when the client builds. Preview the production shell for offline testing:

```bash
npm exec vite preview -- --host 127.0.0.1
```

Serve `dist/` using HTTPS in production. Localhost is supported for development. Encryption, service workers, microphone access, and clipboard sharing require a secure context. The service worker is generated during production builds. It precaches the application shell, scripts, styles and icons, excludes authenticated/API responses, and loads the HLS player only when a person requests video.

### Private camera deployment

Chrome/Firefox use a lazily loaded HLS player with short-lived, camera-session-scoped Bearer credentials. Requests outside the same API origin and session path are rejected by the player. Safari native HLS uses the backend's HttpOnly session cookie and therefore requires the website and API under the same HTTPS origin, normally through a reverse proxy for `/v1/`. The server rechecks membership and camera grants on every playlist and segment request. Private stream tokens, snapshots, and clips are never put into a public URL or browser cache. Switching farm or role unmounts the private viewers and revokes local blob URLs.

## Workflow inventory

| Area | Implemented web behavior |
| --- | --- |
| Identity and people | Owner registration; invitation join in either language; recovery-code acknowledgement; login and mailbox-free recovery; encrypted old-cache rekey or recoverable archive; session revocation; owner role changes and membership revocation; invitation revocation. |
| Existing operations | Existing crop facts may remain unknown. Animal projects record opening count, date, source and verified/estimated basis. Documented financial opening balances remain separate from later activity. Explicit pre-opening historical animal entries require a source and cannot change current counts, stock or money. |
| Crop planning | Sourced field assessments, soil tests, readiness checklists, crop-stage/grading/storage records, fuel/labour/irrigation sessions; comparison of water, labour, soil, area, equipment, market, previous crop and location fit; sourced/versioned templates; explicit anchor date; draft previews and separate approval; rescheduling previews bound to an impact token. |
| Daily work | Work, observations, measured rain/irrigation, stock-linked inputs/harvest, photos and voice notes; task-linked completion; assignment, progress, evidence and reasoned rescheduling; incidents with assignment, acknowledgement, follow-up, history and resolution. |
| Poultry | Broiler placement, feed, growth, loss, transfer, partial sales, closure; layers/breeders with egg collection/rejects/consumption/sales; recorded egg incubation, hatch results, downstream chick transfer and count/cost traceability. |
| Rabbits | Identified parents, mating, kindling, stillbirths, litter-linked individual identity, fostering, weaning, grow-out, sale, care, restrictions, parents/offspring/sibling timelines and performance. |
| Fish | Broodstock, hatchery, nursery and grow-out projects; spawning, hatch results, explicit count basis, stocking, sourced water measurements/calibration, feed, growth samples, transfer, weighed partial/final harvest and reconciliation. |
| Inventory and accounting | Opening stock; purchases, consumption, losses and reasoned adjustments; grade/location/pack metadata; explicit pack conversion; traceable stock-to-stock transfer; sourced valuation that changes future costs only; movement and valuation histories; budgets, actual expenses, linked receipts, shared-cost allocations, reasoned replacements/clearing with retained history, documented-expense reversals, versioned opening-balance corrections and direct animal-sale receipts. |
| Reports | Project/date/period filters; currency-separated expenditure, consumption, sales, cash and unpaid amounts; budget variance; recorded margin with missing-cost qualifications; stock/count reconciliation; duplicate review/corrections; authorized Shona/Ndebele CSV and PDF export. |
| Equipment | Unknown-asset registration; linked assets; make/model/controller/firmware/location/responsible person; telemetry mappings, command mappings, explicit commissioning evidence and reauthentication; one-time gateway credential rotation; source/freshness-aware readings; usage, recurring maintenance and maintenance costs; private asset photographs, voice evidence and PDF documents with manager-only financial files. |
| Commands | Explicit confirmation; separate requested, dispatched, acknowledged and feedback-confirmed states; stale/uncommissioned controls disabled; simulator actions visibly separate. Actuator commands cannot enter the offline outbox. The server and gateway enforce interlocks and expiry. |
| Cameras | Capability configuration, zones, farm-time active schedules, duplicate suppression and retention; protected snapshot request/retry with truthful source/time; short-lived private live/event playback; grants/revocation; delayed motion/person events, acknowledgement and explicitly reviewed farm-visible incident follow-up. |
| Marketplace | Deliberate stock or live-animal publication; count basis; explicit base-unit quantity covered by the price (including bags/lots); provisional expected harvest; photos; availability/expiry; category search; edit/archive; shareable `/?listing=ID` links; enquiries and replies; offers; reservations, fulfilment, cancellation, manual receipts, eligible reviews, buyer requests/responses/edit/close and authorized moderation. |
| Machinery/services | Capability, area, rate basis, minimum/mobilisation charges, availability, cancellation terms and equipment resource; project/task-linked request; quote and acceptance; resource conflict rejection; work records; separately approved amendments; declared deposit versus provider-recorded manual receipt, balance/refund; completion, linked project cost and task; review/history. |
| Notifications/weather | Measured weather distinct from forecasts; source/time/location/calibration; honest provider configuration; user quiet hours and channel preferences; inbox/acknowledgement/delivery attempts; email/SMS ownership verification and resend; simulation codes explicitly identified. |
| Farm Companion | Context from recorded facts, tasks, observations, incidents, sourced references, templates and related cycles; missing-data follow-up; structured template proposals create a draft only, then require approval. Optional server-side AI remains read-only and clearly unavailable when not configured. |
| Adviser participation | Sourced observations, permitted assessments, non-financial animal observations and own/assigned incident follow-up. Count, stock, money, assignment, planning approval and control mutations remain unavailable to this farm role. An account's personal marketplace buyer activity remains separate from its farm role. |

The source of each operational fact is visible where it matters. The UI does not infer an agronomic timeline, treatment dose, historical stock effect, missing cost, physical hardware compatibility, or provider settlement from an unverified statement.

## Offline storage, synchronization and recovery

`src/lib/vault.ts` encrypts the account snapshot and separate attachment blobs in IndexedDB using AES-GCM and a password-derived PBKDF2 key. The partition includes the API origin and normalized username. The language preference is the only account preference stored in plaintext localStorage. Tokens, private data, and attachments do not enter the service worker cache. Locking drops the decrypted session; logout marks the vault as requiring online authentication and attempts to revoke the session.

An activity and its attachment references enter the encrypted outbox atomically. Attachment bytes are encrypted before that queue write. Observations can be recorded without waiting for media. Metadata synchronizes first, and larger media uploads are manual by default. Settings allow compact photos and automatic media upload independently. Upload state reports real transferred bytes, pending/failed status and retry. Photos are compacted to a maximum 1600-pixel edge and JPEG quality 0.8 when compact mode is enabled.

The queue permits activities, livestock observations/events, sourced project records, weather observations, asset usage, incidents, media, and task progress. Purchases, stock transfers/valuations, permissions, plan approval, bookings, payment operations and camera/actuator sessions require an online connection. Asset documents use the same encrypted queue; authorized PDF downloads are explicit and are never embedded as active page content. A request retains its original ID when a response is lost. Transient errors back off; material conflicts stop and preserve the draft. Task conflicts expose the current server version and evidence, and require an explicit reason before reapplying an eligible draft. Final tasks cannot be silently reopened by a worker. Discarding a draft removes only that draft and its dependent media.

Password recovery offers either the previous password to re-encrypt existing drafts, or a fresh online cache while preserving the old ciphertext as a recoverable archive. Neither choice silently destroys the archived drafts. Clearing browser storage or losing a device can still destroy local-only data. An offline device learns about server-side membership revocation only after reconnecting.

On refresh, revoked farm caches are removed. Any role change clears the farm's entire cached read snapshot, including ordinary observation notes that may have become private financial receipt evidence, while retaining drafts separately. Lists are rebuilt only from fresh reads permitted by the current role; a failed refresh cannot retain formerly permitted private data. Responses started under an older role cannot restore that cache. Core working lists follow all API cursors; long feature histories expose explicit load-more controls. Feature caches include farm, role and retrieval time. Switching identities or farms cannot reuse a previous private viewer.

## Language, time and accessibility

`src/locales.ts`, `src/completion-locales.ts`, and `src/validation-locales.ts` contain the local catalogs. There is no `nr` catalog. Known API error codes and notification/provider states map to localized messages; unknown internal codes do not appear verbatim in interface labels. User-entered names, notes, source material and measurement units remain as recorded. Fluent review, especially agricultural and commercial terminology, is tracked separately and is not claimed here.

All datetime input uses the farm's IANA timezone, normally `Africa/Harare`. `src/lib/time.ts` converts farm wall time to UTC independently of device timezone. Date-only facts remain date-only. Numeric dates avoid silently falling back to English month names on browsers without `sn`/`nd` ICU data. Missing monetary values remain unknown, rather than displaying zero. Amounts always retain their recorded currency.

Forms provide accessible labels/descriptions, translated validation, keyboard focus, native modal semantics and phone-sized controls. Tables scroll inside their own labelled region. The browser suite performs separate small-phone, tablet and desktop overflow checks and axe WCAG A/AA scans in both languages. Browser viewport evidence does not demonstrate a native iOS or Android build, screen-reader usability or physical-device microphone behavior.

## Tests and acceptance evidence

```bash
npm test
npm run build
npx playwright install --with-deps chromium
TEST_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/smart_farmer_test \
  npm run test:e2e
```

The database must be isolated and disposable. Accelerated journeys honor the real API rate-limit response headers and pause near exhaustion; the harness does not raise production limits or mock responses. The harness builds both applications, migrates that database, and launches the API, Vite preview and real Chromium as children of one process. It never mocks the production API or treats a missing browser as a pass. Each build has a 60-second limit, normal actions use bounded 10–20-second timeouts, and the suite has a 12-minute watchdog. `CHROMIUM_PATH` or `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can select a known installed executable. `TEST_ARTIFACTS_DIR` sets the artifact directory; otherwise a temporary directory is created.

Artifacts include `results.json`, step/error/request/server logs, failure page text/screenshot, phone/tablet/desktop screenshots, axe JSON reports, and an actual downloaded report PDF. `test/browser.mjs` covers the established identity/offline/recovery/command path; `test/browser-completion.mjs` adds the wider operating workflows. The unit suite additionally checks encryption/account isolation, response-loss replay, atomic queue/media persistence, metadata/media ordering, material conflicts, transient transaction retry, unsafe queue rejection, recovery, pagination/cursor loops, and numeric farm-time formatting.

### Full brief traceability

The matrix describes the authored checks and where their execution evidence must be obtained. A listed check is not itself a claim that its latest CI execution passed.

| Brief acceptance | Browser check | Complementary gate |
| --- | --- | --- |
| 1 | Owner recovery; worker invitation/Ndebele join, permissions, adviser downgrade | Backend identity and membership tests; native journeys |
| 2 | Existing irrigated maize unknown facts; later confirmed facts without invented planting | Backend audit/version checks |
| 3 | Offline stock-linked input and photo, restart/unlock, exact one stock/cost effect; assigned irrigation completion | Native offline photo/restart test; backend idempotency |
| 4 | Two actors update one task; preserved conflict, current-state review and reasoned reapply | Backend overlapping record/correction tests |
| 5 | Assessment/plan, irrigation, incident/follow-up, partial harvest, stock sale/payment, budget/reports | Backend season/accounting integration |
| 6 | Broiler placement/feed/observation/loss/partial sales/closure | Animal ledger invariants |
| 7 | Layer collection/rejects/consumption/sale and continuing production | Egg ledger invariants |
| 8 | Recorded eggs incubate and hatch into traceable chicks | No duplicated counts/costs; stale/replay tests |
| 9 | Mating/kindling, litter-linked identity, fostering/weaning/grow-out/sale and lineage | Birth capacity and identity-transfer checks |
| 10 | Stocking, water source/calibration, feed, mean sample, transfer, partial/final harvest | Estimate/reconciliation and restriction checks |
| 11 | Fish broodstock → hatchery → nursery → grow-out | Fish hatch counts and transaction tests |
| 12 | Assign/acknowledge/follow up/resolve crop incident; camera event follow-up | Incident audit/escalation tests |
| 13 | Unknown asset, explicit simulated mapping, maintenance/usage; private asset PDF upload/download with financial role denial; baseline telemetry | Gateway transport and commissioning tests |
| 14 | Explicit simulated command, separate acknowledgement and confirmed feedback | Backend/edge rejection, timeout, expiry, replay, missing feedback and reconnect matrix |
| 15 | Private camera config/snapshot; delayed person event/source; authenticated live and event HLS manifests/segments decode into actual video; navigation pauses/detaches the private player; anonymous access denied | Session, segment, grants, retention/deduplication/ONVIF tests |
| 16 | Crop/live listing, enquiry, reserve, fulfil, manual payment, cancellation, concurrent oversell rejection | Offer, buyer-request, moderation, expiry/review tests |
| 17 | Quote/request/accept, declared deposit/acknowledgement, work, completion/task/cost | Resource overlap, amendment, cancellation/refund tests |
| 18 | Budget, actual cost, counts/stock, dual-currency reports, protected PDF | Reasoned allocation replacement/retained history, opening correction and expense reversal in browser; packs, transfers, valuation and reconciliation tests |
| 19 | Cross-farm camera/export denial; role/cache behavior | Backend/API/media tenant boundary; encrypted cache unit tests |
| 20 | Language switch online/offline; validation/notification catalog; numeric dates | Android/iOS language journeys |
| 21 | 320px phone, 768px tablet, 1280px desktop, keyboard and axe scans | Separate Android/iOS/iPad build and device automation |
| 22 | No browser substitute | Isolated PostgreSQL and media backup/restore test |
| 23 | Documented opening count and balance; no inferred history | Historical-only records and opening ledger tests |
| 24 | Treatment restriction rejects live reservation; counts remain protected | Transfer, partial harvest, reservation/fulfilment/direct-sale restriction propagation tests |

### Verified browser checkpoint

On 4 November 2026, commit `d1f5b89888ba7c6d3638cb70292fc376b2b48160` passed all **18 browser journey groups** in [CI run 41749922313, workflows job 126312189672](https://github.com/DruHustle/smart-farmer/actions/runs/41749922313/job/126312189672). The production clients used the real API and an isolated PostgreSQL database. This checkpoint includes the listing whole-count validation fix, documented rabbit-parent inheritance, complete farm-cache removal on role change even when the activity refresh fails, and accessible mobile navigation contrast.

The passing groups include the full crop season, poultry/rabbit/fish production, live-animal and crop reservations/fulfilment/manual receipts, service deposits/work/completion/accounting, private asset documents, treatment restrictions, currency-separated exports, offline recovery and two-actor conflict handling. Camera checks fetched authenticated live and event manifests and segments, played them until nonzero video dimensions and ready state were observed, rejected anonymous access, and verified that navigating away paused the detached player and removed its media source.

Four axe WCAG A/AA reports contain **zero violations**: Shona settings at 320×740, 768×1024 and 1280×900; and Ndebele notifications at 1280×900. The suite also checks horizontal overflow at those sizes, keyboard focus, and absence of runtime page errors. Automated scans cover those recorded screens; they do not substitute for fluent agricultural review, screen-reader evaluation or a native device journey.

Manual review of the same Ndebele artifact found seven empty notification-delivery tables under axe's `th-has-data-cells` **incomplete** category. The follow-up patch replaces only those empty delivery tables with a localized heading and empty-state text, retaining populated tables. A focused browser assertion checks that delivery tables have data cells and that empty deliveries render text without a table. This follow-up awaits its CI rerun; the 18-group pass above identifies the earlier checkpoint precisely. Final screenshot filenames now use `desktop-notifications.png` and `small-phone-notifications.png` to match the page captured.

The [browser-acceptance artifact, ID 13284714261](https://github.com/DruHustle/smart-farmer/actions/runs/41749922313/artifacts/13284714261), contains `results.json` with all 18 passes, the four axe reports, phone/tablet/desktop screenshots, and the downloaded report/private-evidence PDFs. GitHub retains this artifact for seven days. The workflow log retains the named journey results and checkpoint identity. The same workflows job passed the web's 12 unit tests and its production build.

Local Chromium launch remains blocked by the development sandbox's process-singleton socket permission before a page can open; the browser execution above occurred in CI. Native-device, live-provider, physical-hardware and fluent-language verification remain separate repository or rollout gates.

## Activation and external prerequisites

Farm record workflows work without AI, weather or notification credentials. Settings show the configured/unconfigured provider mode and the needed opt-ins. Production weather, AI, external notification delivery, live payment settlement and physical equipment/camera operation require their documented server configuration and commissioning. Manual payment records explicitly remain manual. Native build/signing/device checks and backup recovery belong to their separate repository gates.

Authoritative contracts and operating instructions are in the backend `docs/product-api.md`, `docs/operations-api.md`, `docs/core-api.md`, `docs/integrations-api.md`, `docs/hardware-and-commissioning.md`, and `docs/operations.md`.
