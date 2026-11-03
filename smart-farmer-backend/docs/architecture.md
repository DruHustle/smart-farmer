# Architecture and deployment notes

## Boundaries and model

The backend owns all persistence and authorization. Web calls `/v1` over HTTPS in any future deployment. Mobile and edge will be independent clients of the versioned contract. No frontend imports backend implementation. The current schema has users, hashed sessions, farms, memberships, crop projects and immutable basic activities. Membership is checked on every farm endpoint; owner and manager can create projects, while owner, manager and worker can record activities. Usernames are unique globally. Activity client IDs and payload hashes reject conflicting retries. Quantity and unit must be supplied together; no unit conversions or inventory effects exist yet.

Registration creates a farm and owner in one database transaction. Authentication uses scrypt password hashes and random bearer tokens stored only as hashes on the server, with a seven-day expiry and explicit sign-out. The web holds a token in memory, so a refresh requires sign-in. No authentication provider, invitation, password recovery, device management, CSRF/cookie flow, multifactor authentication, account lockout or secure offline cache has been implemented. Registration is open and needs a production onboarding policy. Rate limiting is per process and does not replace infrastructure protection. No security audit has occurred.

The initial farm timezone is Africa/Harare; observations are stored as instants. Current web entry uses the device's local time when converting the form, so users must use a device set to farm time until farm-time entry is implemented. No historical measurements, balances, equipment or animal projects are seeded. The active maize crop must be created explicitly; unknown values remain null. Basic activity records have no stock, cost allocation, audit correction or project lifecycle effects.

## Implemented API

All JSON endpoints except `/health`, `/ready`, `/v1/register`, and `POST /v1/sessions` require `Authorization: Bearer <token>`. Auth failure is 401; inaccessible farm/project is 404; invalid input 400; idempotency mismatch 409. Lists currently have a fixed 100-row limit and no cursor. Times are ISO 8601; quantity and unit are paired, with unit supplied as text and no conversions. Do not depend on this early contract as stable.

- `POST /v1/register`: username, password (12–128 characters), language (`sn` or `nd`), farmName.
- `POST /v1/sessions`: username and password; returns a bearer token and language. `DELETE /v1/sessions/current` revokes it.
- `GET /v1/farms`; `GET`/`POST /v1/farms/:farmId/projects`.
- `GET`/`POST /v1/farms/:farmId/activities`: POST takes a client-generated UUID, projectId, kind, observedAt, note and optional paired quantity/unit. A retry by the same actor with the same validated payload returns the original ID; reuse with different data returns 409. These are basic observations only.

## Future deployment: Vercel and Onesa UG Oracle VM

The requested topology is Vercel for web and the identified Onesa UG Oracle VM for the backend. Neither target has been configured or changed. A production release is blocked by the missing capabilities and security review in [status.md](status.md), as well as confirmed Vercel project, VM access, database/storage, HTTPS hostnames, DNS, backups and operational ownership.

For an isolated future environment, set the Vercel project root to `smart-farmer-frontend/web`, install with `npm ci`, build with `npm run build`, output `dist`, and set the public `VITE_API_URL` to the HTTPS API origin. Build the backend image from `smart-farmer-backend/Dockerfile`; inject `DATABASE_URL`, `WEB_ORIGIN` and `PORT` through a protected runtime configuration, configure TLS termination and a restrictive firewall, and use a separately managed persistent PostgreSQL instance. The container does not automatically migrate: apply versioned migrations from a release checkout before starting the matching release. Migration rollback is not automated: take and verify a backup first, use an explicit reviewed forward fix or restore an isolated backup, and roll the image back only if schema compatibility has been verified. Do not deploy this early slice to the existing VM.

The local Compose file is for development, binds PostgreSQL to localhost and uses a persistent volume. It is not a production topology. No backup/restore procedure has been implemented or verified; database and eventual object storage backups must be independent and restored together to an isolated environment before release. Never publish database ports, `.env` files, camera streams or gateway credentials.

## Technical references checked

- [Node.js release schedule](https://nodejs.org/en/about/previous-releases): Node 24 LTS; local Node 20 is end-of-life.
- [Fastify v5 migration](https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/): Node 20 or later.
- [Expo workflow](https://docs.expo.dev/workflow/overview/): native projects require prebuild or separate native development.
- [Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite): `VITE_` variables are exposed to frontend builds and must never contain secrets.
