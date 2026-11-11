# Smart Farmer

Farm management for the phone-first web and native Android/iPhone/iPad applications, with an independently deployable TypeScript/Fastify API, PostgreSQL and farm gateway. The operating brief is for Lawfield Farm in Zimbabwe: active irrigated maize, chickens, rabbits and fish, Shona and Zimbabwean Northern Ndebele, and equipment models to be supplied later.

The repository has been reviewed against the complete [Codex build prompt](docs/product-brief.txt). This development release adds complete crop and listed-livestock workflows, planning, encrypted offline field recording, native projects, stock/cost reconciliation, verified equipment adapters, private camera playback, trading, booking, provider adapters and recovery tooling. See the [acceptance matrix and verification record](docs/status.md) for exact software evidence and external commissioning prerequisites.

## Where to start

- [Setup, independent builds, deployment, backup and rollback](docs/operations.md)
- [Architecture and permission boundaries](docs/architecture.md)
- [Core API and animal workflows](docs/core-api.md)
- [Farmer accounting: supplier scans, sales invoices and books](docs/accounting.md)
- [Accounting API and exact amount contracts](docs/accounting-api.md)
- [Equipment, media and commerce API](docs/integrations-api.md)
- [Farmer Forum sharing, ownership, moderation and API](docs/forum.md)
- [Hardware compatibility and commissioning](docs/hardware-and-commissioning.md)
- [Native application instructions](../smart-farmer-frontend/mobile/README.md)
- [Web application instructions](../smart-farmer-frontend/web/README.md)

## Local stack

From this directory, copy `.env.example` to a private `.env`, replace the local database password, and run `docker compose up --build -d`. This starts PostgreSQL, migration, API and maintenance-worker processes with persistent database/media volumes and localhost-bound ports. Then run `npm ci` and `npm run dev` in `../smart-farmer-frontend/web`.

Alternatively use Node 24 and an existing isolated PostgreSQL 17 database: export `DATABASE_URL` and `WEB_ORIGIN`, run `npm ci`, `npm run migrate`, `npm run dev`, and run `npm run worker` separately. Invoice scanning additionally requires `tesseract` with the English language data and Poppler's `pdfinfo`, `pdftotext` and `pdftoppm` on the worker's PATH. The backend image includes these tools. Each frontend has its own dependency lockfile; neither imports backend implementation or the other frontend's UI.

The web also has an [optional static Docker/PWA image and localhost-only Compose service](../smart-farmer-frontend/web/README.md#optional-static-container). It uses the same public build-time API origin and leaves this backend/database/worker stack independent. Private Safari camera playback still requires the documented same-origin HTTPS ingress.

Run backend tests with an explicit isolated `TEST_DATABASE_URL`. The integration suite fails if its database is missing rather than reporting skipped tests as success. The web/native READMEs and operations guide list their independent verification commands.

Membership changes and removals recheck the acting owner's role inside the farm-locked transaction. A request queued before that owner is demoted cannot restore its own authority or remove another member. PostgreSQL concurrency tests cover both cases while preserving the last-owner guard.

No real farm measurements, animal counts, balances, hardware credentials, payment-provider settlement or native signing identities are supplied as seed data. Unknown facts stay unknown. Demonstration/test fixtures are isolated and must not be published as real listings or farm data.

Shared sign-in accepts a current Portal assertion scoped to the Farmer client.
An approved user has the Farmer product role `user`. Platform administrators
require the `admin` Farmer role and MFA. Both enter with their existing farm
memberships, and a first sign-in creates an empty farm list. The API checks the
central grant on authenticated requests and enforces each farm role locally.
