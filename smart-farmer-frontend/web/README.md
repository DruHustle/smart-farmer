# Smart Farmer web 0.2

An independent React/TypeScript client for the Smart Farmer HTTP API. The phone layout has five primary destinations: today, farm, market, services, and more. Larger screens use a sidebar. The interface supports Shona (`sn`) and Zimbabwean Northern Ndebele (`nd`). The translation catalog is complete for the implemented labels, but it still needs review by native speakers before a farm rollout.

## Run locally

Use Node.js 24 and install the locked dependencies:

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Start the API separately using the backend README. Set `VITE_API_URL` to its origin and allow the web origin in the API's `WEB_ORIGIN`. The example API origin is `http://localhost:3000`. Production builds embed this URL, so set it before building.

```bash
npm run build
npm exec vite preview -- --host 127.0.0.1
```

Serve `dist/` through HTTPS in production. The browser requires a secure context for encryption, service workers, and microphone recording. Localhost development is supported. The service worker is generated only for production builds; use the preview server to test offline loading.

## Implemented workflows

- Register an owner account or join a farm with an invitation. Display the single-use recovery code and require acknowledgement before entering the app. Sign in, recover without email, manage invitations and active sessions, or rotate a recovery code.
- Create and edit crop projects, including an existing irrigated maize crop. Optional planting date, area, variety, stage, and objective stay unknown until supplied. Updates carry the server version and a reason.
- Create broiler, layer, breeder, hatchery, rabbit breeding/growout, fish, and fish nursery projects. Record the opening count, its date, and whether it is verified, estimated, or unknown. Forms expose the enterprise's supported events and their required facts, including hatch, mating, kindling, water observations, growth sampling, transfers, mortality, sales, care, and restrictions.
- Record work, rain, irrigation, observations, stock-linked input use and harvest, and manager costs. Attach a photograph or voice note. Images are resized to at most 1600 pixels on their longest side and encoded as JPEG. The API's five-megabyte file limit applies.
- Create and assign tasks, record progress and completion evidence, and raise or resolve incidents. Worker and manager controls follow the currently known farm role; the API remains the authorization authority.
- Manage stock, purchases, losses, consumption, and audited adjustments. Managers can read reports separated by currency and export the report data to CSV.
- Register equipment and inspect freshness and telemetry. Unknown hardware remains unconfigured. Simulator controls visibly identify the simulated equipment, request explicit command confirmation, and show acknowledgement separately from feedback-confirmed execution. Camera simulation events have a separate acknowledgement flow.
- Publish stock-backed produce listings, reserve stock, fulfil or cancel orders, record manual payments, and leave eligible reviews. Live animal marketplace listings remain blocked by the API; direct animal sales use the livestock event ledger.
- Publish services with an optional registered equipment resource, request a time slot, quote, confirm, complete or cancel a booking, and review completed services. Selecting the same resource on different listings lets the API reject overlapping bookings for that machine. Booking times use the farm timezone.

The companion panel uses the recorded facts and deterministic guidance. It does not claim live AI, verified agronomic diagnosis, or measured conditions that have not been supplied.

## Offline storage and recovery

`src/lib/vault.ts` stores an encrypted account snapshot and separately encrypted attachment blobs in IndexedDB. The partition includes API origin and normalized username. AES-GCM uses an account-specific key derived from the login password with PBKDF2. Context-bound authenticated encryption keeps records from being read under another account or attachment key.

The unencrypted browser preference is the chosen language. Session tokens, farm data, photographs and voice files do not enter plaintext localStorage or service-worker caches. A running session necessarily keeps decrypted information in memory; locking drops the mounted session and returns to the unlock screen. Logging out also marks the local vault as requiring online authentication and attempts to revoke the current server session.

A saved activity and all its attachment references enter the outbox in one encrypted write. Attachment bytes are saved before that write. A failed storage write therefore cannot leave a half-queued activity/media action. Metadata synchronizes first; larger media uploads require the explicit sync action. Retries reuse the original payload and ID. Conflicts remain visible and stop automatic retry. Network failures back off, and five unsuccessful attempts require review. Authentication failures request sign-in again.

Only activities, livestock events, incidents, media, and task progress can queue. Equipment commands, marketplace actions, bookings, permissions and financial management operations require an online connection. This prevents a delayed start/stop action from executing after reconnection.

After a server password reset, an existing encrypted cache may still require the previous password. The app offers two explicit choices:

1. Supply the previous password to preserve and re-encrypt cached records and queued attachments.
2. Start a fresh online cache while retaining the previous ciphertext as an archive. The account screen can later recover its pending records with the previous password.

Neither choice silently deletes the old drafts. Browser storage clearing, profile deletion, and device loss can still destroy local-only records. A strong password and the device's own screen lock remain important on shared equipment.

When a refresh discovers revoked farm access, it drops that farm's cached data. When a manager becomes a worker or adviser, it removes cached financial reports, stock valuations, cost activities, bookings and seller-order data before fetching the rest of the farm again. An offline device cannot discover server-side permission changes until it reconnects.

## Dates, localization and accessibility

All farm date/time input uses the farm's IANA timezone, normally `Africa/Harare`. `src/lib/time.ts` converts that wall time to UTC explicitly, independently of the owner's phone or laptop timezone. Date-only facts stay date-only. Invalid calendar dates and nonexistent local times are rejected.

Labels live in `src/locales.ts`. `nd` is Northern Ndebele; there is no `nr` catalog. Native-speaker review, especially livestock and booking terminology, remains a release prerequisite. Form controls have explicit accessible names and descriptions, visible focus states, and touch targets suitable for a phone. Dialogs use the native dialog element. The interface avoids invented farm examples in the active account.

## PWA behavior

The manifest supplies 192- and 512-pixel icons plus the vector source. The generated service worker caches the exact built shell, scripts, styles and icons. It does not cache API responses or authenticated requests. Offline loading uses the saved application shell; unlocking an account requires its local password. Browser installation availability varies by platform.

## Tests

```bash
npm test
npm run build
```

The unit suite covers both catalogs, encrypted account isolation, restart and concurrent writes, response-loss retry with stable IDs, metadata/media ordering, conflict and revoked-session behavior, unsafe outbox rejection, both password-recovery paths, atomic record/media queue persistence, and farm timezone conversion with invalid-date rejection.

The browser suite requires a disposable PostgreSQL database and builds both applications. It launches the API, Vite preview, and Chromium as children of one process. It binds the API to `127.0.0.1` and does not rely on a machine-specific repository path.

```bash
npx playwright install --with-deps chromium
TEST_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/smart_farmer_test \
  npm run test:e2e
```

Optional environment variables:

| Variable | Purpose |
| --- | --- |
| `CHROMIUM_PATH` | Use an explicitly installed Chromium executable. |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE` | Compatibility alias for the executable override. |
| `TEST_ARTIFACTS_DIR` | Directory for screenshots, results, and failure logs; created automatically. The default is a fresh temporary directory. |

The authored browser journey covers owner registration and recovery-code acknowledgement, unknown-fact maize onboarding, stock-linked offline activity with photo, restart and unlock, both interface languages, Harare entry from a Los Angeles browser, exactly-once stock/cost effects, password recovery and cache re-encryption, and the equipment simulator acknowledgement/feedback sequence. It also checks 320px and desktop layout overflow and browser runtime errors. It exits nonzero on failure; missing browser or database support is not reported as a pass. Each build command has a 60-second deadline, ordinary browser actions have a 10-second timeout, service-worker control has a 15-second timeout, and the entire harness has a four-minute watchdog. Step, console, failed-request, and server diagnostics accompany failures.

### Verification in this development environment

The production build and unit suite pass. The real PostgreSQL browser harness reaches API and web readiness, but the supplied execution sandbox denies Chromium's process-singleton socket (`Operation not permitted`) before a page opens. Consequently no browser journey or screenshot is claimed as passed here. CI installs its own Chromium and runs the same `test:e2e` entry point; its result must be reviewed before treating the browser journey as accepted.

## Deliberate limits

- The web browser client is independent from the native app. It has no backend or native implementation imports.
- Native installation, real-device camera/audio, background sync and screen-reader usability need device testing. A source build does not demonstrate those outcomes.
- Only a commissioned adapter may operate real equipment. These UI simulator tests are not proof that a borehole, pump, pivot or camera works in the field.
- Individual animal identity/restriction selectors require their online lookup; cached project events and normal field recording work offline. The UI does not promise offline access to every management operation.
- Cached lists are bounded by the API response. There is no full-history pagination or enterprise reconciliation UI yet.
- Manual payment records are bookkeeping; there is no payment gateway or escrow integration.

See the backend's `docs/core-api.md`, `docs/integrations-api.md`, and `docs/hardware-and-commissioning.md` for the authoritative server contract and deployment boundaries.
