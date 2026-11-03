# Setup, release and recovery

This repository prepares software for a reviewed release. No production domain, VM, database, provider or physical installation is provisioned by these instructions.

## Requirements and independent builds

- Node 24 LTS and npm. Native development requires at least Node 24.3.
- PostgreSQL 17 for the API. Docker Compose is the supplied local development option.
- Android native builds require the Android SDK/JDK supported by the committed Expo/React Native version. iOS/iPad native builds require macOS, Xcode and CocoaPods; distribution requires the appropriate signing accounts.
- Backup/recovery additionally requires matching PostgreSQL client tools, `tar` and Python 3.12 or newer for restricted archive extraction.

Each deployable owns its implementation and dependencies. There is no backend/frontend shared application package. iPhone and iPad share `smart-farmer-frontend/mobile/ios`.

### Container development

From `smart-farmer-backend`:

```sh
cp .env.example .env
# Replace POSTGRES_PASSWORD in the private .env file.
docker compose up --build -d
```

Compose starts a persistent PostgreSQL volume, runs versioned migrations as a separate one-shot service, then starts API and maintenance worker. The API and database ports bind to localhost. Private media has its own persistent volume. The image runs as the non-root `node` user. Compose uses PGHOST/PGUSER/PGPASSWORD/PGDATABASE rather than interpolating a possibly special-character password into a connection URL.

The API has `/health` for process liveness and `/ready` for database/schema readiness, including the product and operational migrations. API and worker share the same private media volume so retention and orphan cleanup operate on the stored objects. The worker writes a heartbeat checked by `dist/worker-health.js`; a running process alone does not establish worker health. Container restart policy is recovery assistance, not high availability.

### Host development

```sh
# smart-farmer-backend; export DATABASE_URL and WEB_ORIGIN first.
npm ci
npm run migrate
npm run dev
# Separate terminal, same database configuration:
npm run worker
# smart-farmer-frontend/web:
npm ci
npm run dev
```

The Node processes do not implicitly load `.env`. Export the required variables, or invoke Node with its explicit `--env-file` option. `HOST=127.0.0.1` is appropriate for local tests. A native development device needs a deliberately reachable development API or HTTPS staging host, not the phone's own localhost address.

```sh
# smart-farmer-frontend/mobile:
npm ci
npm run typecheck
npm test
npm run android
# On a macOS/Xcode host:
npm run ios
```

The committed native projects are generated from `app.json` and the app's config plugin. Review regenerated native diffs after `npm run native:generate`. Use a development build for SQLCipher/native modules; Expo Go does not establish the required encrypted native-storage behavior. The mobile README describes device unlock, camera/microphone permissions and platform test steps.

`npm run build` in the mobile directory creates iOS and Android JavaScript bundles after typechecking. It is not an IPA/APK build and does not establish device or app-store acceptance.

## Verification gates

```sh
# TEST_DATABASE_URL must name an isolated test database.
LOG_LEVEL=silent npm test                 # backend, real PostgreSQL
npm test --prefix edge                  # gateway safety rules
npm test --prefix ../smart-farmer-frontend/web
npm run test:e2e --prefix ../smart-farmer-frontend/web
npm test --prefix ../smart-farmer-frontend/mobile
npm run build --prefix ../smart-farmer-frontend/mobile
npm run test:backup                     # requires pg_dump and pg_restore
```

The browser harness builds both backend and web, migrates the specified isolated database, and starts its own local API/web/browser children. It uses `CHROMIUM_PATH` when supplied or an installed Playwright Chromium. Do not point any test command at a production database. Ordinary backend tests create/drop uniquely named schemas. Backup verification creates/drops uniquely named test databases and therefore needs a test role allowed to create databases.

GitHub Actions runs PostgreSQL integration tests, browser journeys, web/edge/native tests, both native bundle exports and an encrypted restore check. A separate native workflow compiles SQLCipher into Android and iOS simulator applications and exercises Android, iPhone and iPad journeys, preserving evidence artifacts. It uses the PostgreSQL service container's matching client utilities for backup verification. Native signing and real hardware/device tests remain separate release gates.

## Database and media backup

The utility `scripts/backup.mjs` creates a native PostgreSQL custom-format dump, an immutable-object media archive and integrity manifest, then encrypts the complete package using AES-256-GCM. The key must be an owner-readable-only file containing 32 random bytes. Keep it separate from both the archive and the application server.

Example key generation, once, outside the repository:

```sh
node -e "require('node:fs').writeFileSync(process.argv[1],require('node:crypto').randomBytes(32),{flag:'wx',mode:0o600})" /secure/offline/smart-farmer-backup.key
```

With the correct source database and host-accessible media directory:

```sh
export BACKUP_KEY_FILE=/secure/offline/smart-farmer-backup.key
export MEDIA_ROOT=/private/smart-farmer/media
node scripts/backup.mjs create --output /private/backups/smart-farmer.sfbak
```

Use `PG_DUMP_BIN`/`PG_RESTORE_BIN` to select matching PostgreSQL client executables if they are not on PATH. The key is never written into the archive. The utility checks referenced media hashes, excludes incomplete temporary uploads, and refuses to overwrite an existing archive. A PostgreSQL exported snapshot keeps the database dump and referenced object list consistent. A shared backup/retention advisory lock prevents deletion during capture. Only referenced field attachments and camera segments/snapshots enter the archive; every object is verified before encryption.

The off-host scheduler, separate backup container image and systemd timer are supplied in `scripts/offhost-backup.mjs`, `Dockerfile.backup` and `ops/`. The scheduler uses independent destination credentials, uploads encrypted archives, reads them back to verify SHA-256 and can restore into a newly created isolated database. Activation still requires the destination, protected keys and recovery identity. See [provider and recovery setup](operational-integrations.md).

### Restore safely into isolation

Create a **new empty** PostgreSQL database named `smart_farmer_restore_<unique_suffix>`, and select a new empty private media directory. Then:

```sh
# Export RESTORE_DATABASE_URL for that new database through private environment configuration.
node scripts/backup.mjs restore --archive /private/backups/smart-farmer.sfbak --media-dir /private/restore/media --confirm-empty-target
```

The restore command requires the independent target name and checks that the database and media destination are empty, including non-table application objects such as sequences, functions and types. It authenticates encryption before extraction, validates archive entries/checksums, and restores in one PostgreSQL transaction without `--clean`. Every restored media reference is checked against staged object size and SHA-256 before media is copied and success is reported. It does not switch application traffic or overwrite a running environment. Verify accounts, project/stock records, financial totals by currency and read permissions in the restored instance before planning any cutover. A failed restore stays an isolated diagnostic target; do not reuse it as production without inspection.

## Migrations, rollback and retained evidence

Migrations are ordered SQL files recorded in `schema_migrations` under an advisory lock. They run in transactions and are not automatically reversed. Apply them once to an isolated restored copy first. Record the application revision, migration set, configuration names and verified backup digest for each release. Configuration examples contain placeholders only.

For deployment, identify the authorized host and HTTPS origins, inject secrets through its protected runtime configuration, mount database/media volumes, run migrations, start API/worker and verify readiness plus critical user journeys. The prepared stack does not imply available capacity or permission to change the existing Onesa VM.

For application rollback, retain the previous image and verify its schema compatibility. Prefer a reviewed forward repair for additive data/schema changes. If data restoration is required, restore into a new isolated database/media pair and validate it before a separately controlled cutover. Never drop the current database or reuse the test restore flag as a production overwrite mechanism.

## Operational limits to resolve before farm use

- Off-host backup destination and schedule, key custody, retention policy and a restore rehearsal in the actual hosting environment.
- Farm membership/onboarding policy, shared-device procedures and authorization for every assigned role. Worker financial access is deliberately restricted.
- HTTPS, reverse-proxy/client-IP configuration, monitored API/worker health, private database access and storage capacity alerts.
- The local media adapter needs a persistent private volume. A production object-store adapter/bucket policy has not been activated. Media quota defaults to 250 MiB per farm and maximum attachment size to 5 MiB.
- Private camera playback and generic HTTP/MQTT/Modbus TCP/RTU/ONVIF/RTSP drivers are implemented. Farm model-specific mappings, physical interlocks and actual device commissioning still require the installation. Notification, weather and optional read-only AI adapters require provider configuration and farm consent. Manual payment records do not claim external settlement.
- The worker reconciles old unreferenced objects in bounded pages and applies owner-configured field-media retention and camera retention. Pending deletion remains included in storage quotas. Monitor worker heartbeat, retries, quota and the last independently verified backup through operations health.
- Machine-generated Shona/Ndebele catalogues need fluent agriculture/domain review. Native camera, encrypted storage, notification permissions and layout need signed device verification.
