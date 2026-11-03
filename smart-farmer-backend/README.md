# Smart Farmer

Farm management for the phone-first web and native Android/iPhone/iPad applications, with an independently deployable TypeScript/Fastify API, PostgreSQL and farm gateway. The operating brief is for Lawfield Farm in Zimbabwe: active irrigated maize, chickens, rabbits and fish, Shona and Zimbabwean Northern Ndebele, and equipment models to be supplied later.

The repository has been reviewed against the complete [Codex build prompt](docs/product-brief.txt). This development release adds complete crop and listed-livestock workflows, planning, encrypted offline field recording, native projects, stock/cost reconciliation, verified equipment adapters, private camera playback, trading, booking, provider adapters and recovery tooling. See the [acceptance matrix and verification record](docs/status.md) for exact software evidence and external commissioning prerequisites.

## Where to start

- [Setup, independent builds, deployment, backup and rollback](docs/operations.md)
- [Architecture and permission boundaries](docs/architecture.md)
- [Core API and animal workflows](docs/core-api.md)
- [Equipment, media and commerce API](docs/integrations-api.md)
- [Hardware compatibility and commissioning](docs/hardware-and-commissioning.md)
- [Native application instructions](../smart-farmer-frontend/mobile/README.md)
- [Web application instructions](../smart-farmer-frontend/web/README.md)

## Local stack

From this directory, copy `.env.example` to a private `.env`, replace the local database password, and run `docker compose up --build -d`. This starts PostgreSQL, migration, API and maintenance-worker processes with persistent database/media volumes and localhost-bound ports. Then run `npm ci` and `npm run dev` in `../smart-farmer-frontend/web`.

Alternatively use Node 24 and an existing isolated PostgreSQL 17 database: export `DATABASE_URL` and `WEB_ORIGIN`, run `npm ci`, `npm run migrate`, `npm run dev`, and run `npm run worker` separately. Each frontend has its own dependency lockfile; neither imports backend implementation or the other frontend's UI.

Run backend tests with an explicit isolated `TEST_DATABASE_URL`. The integration suite fails if its database is missing rather than reporting skipped tests as success. The web/native READMEs and operations guide list their independent verification commands.

No real farm measurements, animal counts, balances, hardware credentials, payment-provider settlement or native signing identities are supplied as seed data. Unknown facts stay unknown. Demonstration/test fixtures are isolated and must not be published as real listings or farm data.
