# Review, implementation and acceptance status

Reviewed on 2026-11-03 against the complete [Smart Farmer Codex brief](product-brief.txt). Baseline: `c58a01fb88a97f16eda43cf564ccf90a8981e836` on `DruHustle/smart-farmer/main`. Changes are in `review/smart-farmer-workflows-20261103` pending review. No production deployment, farm migration, native device commissioning or physical equipment operation was performed.

## Findings and development

The baseline was a small online prototype: registration, sessions, project creation and a generic activity form. Native directories and the edge gateway were placeholders; activity labels did not change stock or money; there was no durable client outbox, media storage, recovery, worker process or verified restore path.

This development pass adds persisted workflows across the independent backend, web, native and edge boundaries:

- Identity recovery, one-use invitations, language preferences, session revocation, farm membership and role enforcement.
- Existing-maize onboarding with unknown facts preserved, versioned corrections, tasks, incidents, field evidence, stock movements, separate costs/revenue/payments, currency-separated reports and protected CSV exports.
- Broiler, layer, breeder/hatchery, rabbit breeding/grow-out and fish/nursery events with opening balances, count reconciliation, lineage, explicit estimates, partial sales/harvests, closure and treatment restrictions carried through relevant transfers.
- A responsive Shona/Ndebele web app with an encrypted per-account cache, durable operation IDs, separate attachment outbox, conflict handling, offline restart/unlock and password-recovery handling that preserves encrypted drafts.
- Independent native source and generated Android/iOS projects, an encrypted SQLite repository, secure credentials, offline synchronization, camera/audio capture and local task reminders. iPad shares iOS. Native binary/device evidence remains separate from JavaScript and repository tests.
- Honest equipment capabilities, an outgoing HTTP simulator gateway, telemetry freshness, expiring audited commands, camera-event simulation/retention, private media, marketplace reservations, manual payments, service quotes and resource booking checks.
- An operations worker, persistent local container configuration, readiness checks, encrypted database/media backup tooling, an isolated restore test and expanded CI gates.

The review also corrected integrity/access issues found during implementation: retries cannot deduct stock twice; financial receipts and animal-cost metadata are withheld from workers; recovery revokes logins racing with an old password; credentials and command deadlines are rechecked after lock waits; concurrent reservations cannot oversell stock; and quote acceptance requires the current version.

This is a substantial development release, not completion of every requested product feature or production validation. The matrix distinguishes software evidence from remaining client, operational and external work.

## Requirements-to-implementation matrix

“API verified” refers to implemented rules exercised against a real isolated PostgreSQL database. It does not imply every screen, device, provider or physical process was tested. Backend evidence is in `test/core.test.ts`, `test/integrations.test.ts`, `test/api.test.ts` and `test/edge-http.test.ts` unless otherwise indicated.

| # | Acceptance outcome | Implemented evidence | Remaining scope / verification |
| --- | --- | --- | --- |
| 1 | Invite, language, sign-in, recovery, permissions | One-use invitations/recovery, multi-farm membership, preferences, revocation and login/recovery race; client identity forms. | No email/SMS provider; fluent language review and actual native-device journey. |
| 2 | Existing maize and later confirmed facts | Versioned projects retain unknown dates/area/variety; API unknown-state and stale-version checks. | Full crop planning templates, scheduled agronomy and season comparisons. |
| 3 | Offline evidence, restart, one stock/cost effect | Transactional activity/task/stock/cost API; encrypted client repositories, durable IDs and separate media. Browser acceptance script exercises restart/photo sync. | Physical-device kill/restart, poor-network and storage-pressure campaigns; native media permissions. |
| 4 | Concurrent records and visible conflicts | Version/ID payload conflicts and competing stock-use tests; client retry/review states. | Semantic duplicate detection and richer manager conflict review. |
| 5 | Crop work through harvest, trade, payment, review | Field observations, irrigation/rain, tasks/incidents, harvest inventory, commerce and currency-separated reports; API tests. | Comprehensive season planning, budgets, shared-cost policy, weekly/PDF reports and a complete browser season journey. |
| 6 | Broiler lifecycle | Placement, feed, weight sample, mortality, partial sales, manual receipt and explicit closure; API test. | Farm/user acceptance and native-device journey. |
| 7 | Layer eggs and continuing production | Collection/rejects, consumption/loss/sale, egg stock and continuing flock; API test. | Productivity trend UI and device journey. |
| 8 | Incubation and traceable chicks | Source eggs, incubation, hatch/failure, downstream project and documented cost allocation; API test. | Specialized hatchery scheduling/monitoring UI and field acceptance. |
| 9 | Rabbits, fostering, weaning, lineage | Parents, mating, kindling including zero-live outcome, fostering/weaning/grow-out and transfer history; API test. | Full individual timeline UI and actual breeding workflow acceptance. |
| 10 | Fish stock, water, feed, sampling, harvest | Sourced water observations, feed, sample basis, estimated transfers, partial harvest and reconciliation; API test. | Species-specific plans, quality-control workflow and pond/device acceptance. |
| 11 | Fish nursery-to-grow-out | Nursery stocking and traceable estimated transfer; API test. | Complete spawning/egg/hatching workflow is not implemented. |
| 12 | Incidents and follow-up | Report, assign, acknowledge and resolve with audit/evidence; API test and clients. | External escalation, delivery retries and acknowledgement notifications. |
| 13 | Unknown equipment and telemetry | Unknown assets have no invented capabilities; simulator telemetry/freshness and scoped tokens; API and real HTTP gateway tests. | Physical drivers, commissioning and full maintenance scheduling/history. |
| 14 | Command failure cases | Confirmation, freshness, interlocks, dispatch/ack/feedback, replay, expiry, unknown outcome, lock-wait expiry, credential rotation and reconnect. | No physical command is enabled; model-specific fail-safe controls/feedback need commissioning. |
| 15 | Private camera events and retention | Simulated motion/person events, original/received timestamps, acknowledgement, cross-farm denial and retention worker. | ONVIF/RTSP, private stream proxy, credentials and stream/reconnect tests. |
| 16 | Marketplace and no overselling | Deliberate publication, browsing, atomic reservations, cancellation, fulfilment, manual payment and completed-order review; concurrency test. | Enquiries/offers, buyer requests, moderation, full edit/expiry and settlement provider. Live-animal listings are rejected until reservations and animal counts share one transaction. |
| 17 | Services quote, booking and project cost | Request/quote/versioned acceptance, overlap checks, completion and one project expense; API test. Linked physical resources share the overlap gate. | Deposits, actual-vs-agreed work, task linkage, mobilisation/minimum-charge structure and provider payments. |
| 18 | Stock, counts, money, units, currencies | Opening/movement/event ledgers, explicit g/kg and ml/l conversion, whole-unit checks, count corrections and currency-separated totals. | Pack sizes, valuation/shared-cost policy and full reconciliation reports. Complete profit is not claimed. |
| 19 | Cross-farm isolation | Scoped records, restricted media/receipts, reports, camera events and role checks; encrypted account/origin caches with membership refresh. | Independent penetration test; offline revocation cannot remotely erase an unlocked disconnected device. |
| 20 | Language and offline formatting | Only `sn`/`nd` offered; catalogs, farm-time conversion, offline labels and language preferences have automated coverage. | Fluent Zimbabwean reviewers; complete notification/validation and native locale/accessibility verification. |
| 21 | Native, iPad, browser, accessibility | Independent native projects/repository tests; browser script checks 320px, 390px and desktop overflow. | Signed builds, physical Android/iPhone/iPad journeys, font scaling, screen readers and accessibility audit. JavaScript export is not device validation. |
| 22 | Database and attachment restore | AES-GCM archive, checksums, protected key, empty-target restore and attachment/nonempty-target/tamper tests in CI. | Final CI result is recorded with the PR. Off-host destination, schedule, key custody, alerts and recurring restore drills need configuration. |
| 23 | Existing animal opening state | Unknown versus verified/estimated counts with as-of date and no fabricated events; reconciliation tests. | Real opening counts, supporting records and farm approval. |
| 24 | Restrictions through releases | Authorized restrictions, lineage/transfer propagation, current-time enforcement; tests prevent backdating bypass, restricted sales and output reservations. | Verified care instructions/release periods; live-animal marketplace remains blocked pending ledger integration. |

## Verification record

Available checks use synthetic fixtures and disposable PostgreSQL 17.6, not farm records. The final local backend build and **18 tests passed with zero failures or skips**, including the real HTTP gateway outage/restart scenario. The separate edge suite passed both tests. The web production build and **8 unit tests** passed. Native typechecking, **14 tests with zero failures or skips**, iOS/Android JavaScript exports, platform generation and Expo fingerprint generation passed. Runtime dependency audits for backend, web and native reported zero vulnerabilities.

The local browser run reached API and web-server readiness, but system Chromium could not create its required process-singleton socket in this execution environment (`Operation not permitted`). That attempt is not counted as browser acceptance. CI uses its installed Playwright Chromium to execute the browser journey and retain screenshots/results. The review PR records the final CI result, including actual encrypted dump/restore and Docker checks.

Commands and environments are in [operations](operations.md), [web setup](../../smart-farmer-frontend/web/README.md), [native setup](../../smart-farmer-frontend/mobile/README.md) and [edge setup](../edge/README.md). CI runs API/concurrency tests, browser/offline tests, edge tests, native repository tests/JavaScript exports, Docker build/configuration and encrypted backup/restore.

Local limitations: no Docker daemon, PostgreSQL dump/restore client, macOS/Xcode host, mobile emulator/device, signing identity or connected farm equipment. Browser, Docker and archive verification are delegated to CI; archive tests use PostgreSQL 17 clients. No physical-hardware, signed-app or production-load result is claimed.

## Remaining inputs and software priorities

1. **Native release:** macOS/Xcode, Android host/device, signing and app distribution; verify compiled SQLCipher, media/notification permissions, offline restart, accessibility and iPad.
2. **Languages:** fluent Shona and Zimbabwean Northern Ndebele reviewers for common workflows, errors, permission prompts and offline states.
3. **Hardware:** exact models, protocol documents, wiring/interlocks, network and commissioning operator; see [hardware guide](hardware-and-commissioning.md). Unconfigured devices cannot accept commands.
4. **Providers:** weather, object storage, payment, push and optional email/SMS choices/credentials/quotas. Manual observations/payments and simulator events keep explicit provenance.
5. **Operations:** authorized target, HTTPS origin, storage sizing, independent backup destination/key custody, alerting, retention, migrations and restore rehearsal.
6. **Product completion:** crop plans/templates, full fish hatchery, live-animal marketplace accounting, enquiries/moderation/expiry, machinery accounting, notification queue, scalable pagination and complete reports. These are software work, not credential blockers.

No areas, planting dates, animal counts, balances, device models, settlements or language approvals have been invented. The checked-in brief remains the source for future completion work.
