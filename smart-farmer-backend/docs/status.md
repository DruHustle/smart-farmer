# Implementation and acceptance status

Last updated 2026-11-03. This is an early, incomplete development slice. A check is only marked passing when actually executed. No real farm data or external integrations have been configured.

## Implemented so far

- Separate backend and web code; Node 24, React/Vite, Fastify and PostgreSQL; migrations, local database volume and backend container definition.
- Username/password registration and sessions; farm-scoped membership authorization; basic project creation and activity recording. Optional crop facts remain unknown when absent. Idempotent activity API retries do not create duplicate activity rows.
- A responsive web form with `sn` and `nd` language selections. Translations are preliminary and **not reviewed by native speakers**; coverage and correctness are not verified. Language selection changes the current UI but is only stored at registration, not updated per user afterward.
- Preliminary deployment notes for Vercel and the Onesa UG Oracle VM. No deployment or physical equipment tests.

No actual stock, costs, task scheduling, media, offline outbox or project updates are implemented. Activity kinds are descriptive only and do not affect inventory or money. The UI is online-only and its current observation-time entry depends on device timezone. Browser refresh loses the session. There is no iOS or Android application, edge process, simulator, worker, object-storage adapter, PWA, recovery, invitations or production security review. Do not use this prototype for farm decisions or production data.

## Acceptance matrix

| # | Outcome in brief | State / evidence |
|---|---|---|
| 1 | Worker invitation, language, login, recovery, permissions | Not implemented; owner registration/login and API role checks only. |
| 2 | Existing irrigated maize, unknowns, later updates | Partial: project create and null unknown fields; no edit flow. API integration test exercises nulls. |
| 3 | Offline work, media, restart, one stock/cost effect | Not implemented; activity endpoint has idempotent IDs only. |
| 4 | Concurrent conflicts and resolution | Not implemented; conflicting reuse of activity ID returns 409. |
| 5 | Complete crop season, stock, sale, payment, review | Not implemented; basic field records only. |
| 6 | Broiler lifecycle | Not implemented. |
| 7 | Layers and egg inventory | Not implemented. |
| 8 | Incubation and traceable chick transfers | Not implemented. |
| 9 | Rabbit breeding, fostering, grow-out | Not implemented. |
| 10 | Fish grow-out and reconciliation | Not implemented. |
| 11 | Fish nursery transfer | Not implemented. |
| 12 | Incident workflow | Not implemented. |
| 13 | Unknown equipment and simulator | Not implemented. |
| 14 | Safe equipment command lifecycle | Not implemented; no remote commands are exposed. |
| 15 | Camera privacy, events, retention | Not implemented. |
| 16 | Marketplace and atomic stock reservation | Not implemented. |
| 17 | Services quote, booking and conflicts | Not implemented. |
| 18 | Stock, counts, money, units and currencies | Not implemented; activity quantity is unconverted text unit only. |
| 19 | Cross-farm access including media, exports and caches | Partial: API project isolation integration test; media, exports and caches do not exist. |
| 20 | Language coverage, validation, notifications, offline | Not implemented completely; unreviewed preliminary web labels only. |
| 21 | Native journeys, tablet, accessibility | Not implemented or tested. |
| 22 | Restore database and media backups | Not implemented or tested. |
| 23 | Existing animal opening state | Not implemented. |
| 24 | Treatment restrictions through transfers and sales | Not implemented. |

## Next development work

Implement secure identity lifecycle and membership invitations; contract and farm-time handling; secure offline storage/outbox with conflict resolution and media; tasks; inventory and transaction-safe accounting; crop lifecycle; all specified chicken, rabbit and fish workflows; equipment and camera framework with simulated contracts; marketplace and services; translations reviewed by fluent speakers; native apps; backup/restore and release security review. Add outcome-based integration, browser and native tests for every acceptance row. Do not confuse preliminary scaffolding with completed workflows.

## Verification performed on 2026-11-03

`npm run build` passed for backend and web using Node 24.12.0. `npm test` passed against a disposable PostgreSQL 17 container: two backend tests covered password/token handling, registration, sign-in/out, cross-farm project denial, unknown crop facts, idempotent activity retry, conflicting retry and paired quantity/unit validation; one web test checked the two language options exist. This is not browser, native, accessibility, production security, backup or full end-to-end validation. The initial GitHub Actions run passed; the workflow was subsequently restored under `.github/workflows` and updated for the separate project commands.
