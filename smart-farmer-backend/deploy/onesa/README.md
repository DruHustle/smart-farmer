# Smart Farmer Onesa deployment candidate

This is a **candidate**, not a deployed or capacity-qualified production stack. The owner approved `https://farmer.onesa.eu` on the Onesa UG backend. The host is shared and has limited disk and memory; measure build, peak workload, storage growth and failure isolation before installing anything. Do not replace or prune existing databases, images, volumes or other applications.

The API, singleton maintenance worker, optional dedicated PostgreSQL and static web each have their own project network, limits, health checks and named data volumes. Only the API and web bind host loopback. Node-RED runs on the separately commissioned farm gateway; the Python agent retains validation and command policy. The independently provisioned Activepieces candidate remains optional and must not receive application or machine authority by default.

## Qualify images on native ARM64

From a checkout of the reviewed release commit, run the following command with an account that can use the local ARM64 Docker daemon. The receipt path must be new. Use a directory outside the checkout for release records.

```bash
bash smart-farmer-backend/deploy/onesa/qualify-arm64.sh /private/receipts/farmer-arm64.env
```

The script builds API, web, database and backup images sequentially from a Git archive of the current commit. It uses a disposable internal Docker network, dedicated test database and media volume. It checks the API and web revisions, worker heartbeat, account registration and login, private attachment upload, encrypted backup and restore into an empty database. Each successful run retains four locally tagged images and writes their immutable image IDs to the receipt. The qualification removes its test containers, network and volume. On a shared host, set `FARMER_BUILDER` to the name of a resource-limited Buildx builder. The script publishes no host ports or registry images.

GitHub runs the same check on its standard Linux ARM64 runner. The Oracle operator must qualify the images on the target daemon and use its own receipt for the production Compose configuration. Independent builds may have different image IDs. Keep the target receipt and images for rollback.

## Prepare and qualify

1. Build the API from this reviewed source with `docker build --platform linux/arm64 --build-arg APP_REVISION=<full-reviewed-commit> -t <candidate> smart-farmer-backend`, and the web image from `smart-farmer-frontend/web` with both `--build-arg APP_REVISION=<full-reviewed-commit>` and `--build-arg VITE_API_URL=https://farmer.onesa.eu`. Record source revision, scan results and immutable image digests. Confirm the API and web image `org.opencontainers.image.revision` labels, API `/version` and web `/release.json` all equal the reviewed commit; a response or label alone can be configured and is not proof of image provenance. The API Dockerfile, web Dockerfile and PostgreSQL base are pinned. Verify the intended ARM64 image manifests and load or distribute the exact reviewed images before release.
2. Copy `compose.env.example` and `runtime.env.example` to separate owner-only files outside the repository. Replace placeholders with reviewed immutable image references (`registry/image@sha256:<digest>`, or a locally loaded `sha256:<image-id>`), distinct unused loopback ports and private credentials. Use Compose 2.30 or newer. Runtime values must be unquoted; encode special URL characters and `#` in database URLs. Do not print the runtime environment in logs.
3. Use either a dedicated external PostgreSQL connection in `DATABASE_URL` with `sslmode=verify-full`, or the dedicated local `db` profile using matching `PGHOST=db`, `PGUSER`, `PGPASSWORD` and `PGDATABASE`. For the local option, build and scan `Dockerfile.database`, record its immutable image digest as `FARMER_DB_IMAGE`, and verify startup and recovery with that image. The local profile creates a new database volume; **do not start it** until the existing deployment/database inventory proves that is intended. Do not migrate or replace a verified production database with an empty one. External PostgreSQL is separately configured and never shares another application's schema or credentials.
4. Export the variables from the private Compose settings file in a protected shell and run `node deploy/onesa/validate.mjs`, then `docker compose --env-file <private-compose-env> -f deploy/onesa/compose.yml config --quiet`. Validation rejects mutable images, non-HTTPS origins, conflicting ports, permissive runtime-file modes, incomplete DB configuration and unverified external TLS settings. It does **not** prove the target, image provenance, ingress, capacity, backups or recovery.
5. In isolated infrastructure, prove migrations, API `/ready`, worker heartbeat, media persistence, queue recovery, authentication, role isolation, command expiry, simulator-to-UI delivery, backup/restore and rollback with the exact images. Set a reviewed capacity and alerting plan. Test the release against a restored production copy if a production database exists. Preserve the current release, its images and independently verified backup before any migration.

The backup image uses UID/GID 1000, matching the API's media owner. Preserve owner-only permissions and verify real attachment readback and restoration on the selected storage; do not make private media world-readable to work around an ownership mismatch.

## Platform administrator sign-in

Register the confidential Farmer client with the Portal issuer and its frontend callback allowlist using the exact callback `https://farmer.onesa.eu/auth/onesa/callback`. The private Compose environment supplies the API-only client ID, client secret, issuer and enable flag. Migration `016_onesa_identity.sql` adds the issuer/subject projection and encrypted grant. Use the normal migration procedure before deploying the API.

After deployment, `GET /v1/onesa/config` should return the registered public client ID, issuer and callback. Complete sign-in with an approved MFA-enabled Onesa administrator and check that only explicitly joined farms appear. The same callback also returns proof-bound codes to the existing Farmer mobile apps.

## Ingress and safety gate

The public site uses the existing dedicated Farmer tunnel. The Portal monitor requests `/health`. The API owns that exact path, `/ready`, `/version`, `/v1` and its descendants. Send these paths to the loopback API. Send the homepage, `/healthz`, `/release.json`, `/auth/onesa/callback` and other application paths to the static web server. The public API paths must retain their full path and query. The static server returns a browser shell on several unmatched paths, so an HTML HTTP 200 cannot verify API health or a revision.

[Cloudflare ingress example](cloudflared-ingress.example.yml) uses the candidate Compose defaults of 18131 for the API and 18132 for web. Confirm the installed ports, VM loopback namespace, zone, TLS and existing tunnel identity. An operator can compare the ordered rules with the dedicated tunnel's current configuration and preserve existing credentials and origin settings. A remotely managed connector takes its rules from its existing dashboard or API configuration. A locally managed connector takes them from its existing file. Validate this example without starting a connector:

```sh
cloudflared tunnel --config cloudflared-ingress.example.yml ingress validate
cloudflared tunnel --config cloudflared-ingress.example.yml ingress rule https://farmer.onesa.eu/health
cloudflared tunnel --config cloudflared-ingress.example.yml ingress rule https://farmer.onesa.eu/auth/onesa/callback
```

After switching the reviewed routing to the qualified origins, run the read-only check from outside the VM. Supply the full reviewed source SHA shared by the web and API builds. The check requires the API health/readiness JSON, matching web and API revisions, and Farmer's configured client, expected Company Portal issuer and callback. The optional third argument identifies the expected issuer for an isolated qualification deployment.

```sh
node verify-web-ingress.mjs https://farmer.onesa.eu "$FARMER_RELEASE_SHA"
```

Then open the site in a new browser, follow Company Portal sign-in, create a synthetic farm record and reopen it through the same account in a second browser. Check the recorded owner and that a lost-response retry produced one record before releasing to farmers.

`TRUST_PROXY_IPS` is empty by default. When using a proxy, configure only its verified exact source IP address(es), not a subnet or a blanket trust setting. The ingress must replace untrusted forwarded-client headers and the API port must remain reachable only from the trusted ingress. Test spoofed and genuine client addresses, per-client authentication and global rate limits through the actual tunnel before allowing public traffic. A wrong proxy identity can collapse all users into one rate limit or trust a forged address. Do not enable this setting based only on container assumptions.

Only after these gates: start an explicitly approved local DB if needed, run the migration once via the `ops` profile, verify the schema, start exactly one API and worker, confirm readiness and durable storage, then start the web service and perform isolated authorized acceptance through HTTPS. Create disposable acceptance users only within the approved test workflow. The owner confirmed this is the first production deployment and that authorized engineers may hold the existing owner role. Keep AI advisory and hardware commands disabled until the equipment, interlocks, authorized engineer, operator, fresh-state checks and audit path are separately commissioned. Camera media remains on its authorized separate pipeline.

Before rollback, preserve new data and queue state. Restore backups to new isolated database and media targets, prove compatibility, and retain the current release until the recovery path is independently verified. No command in this candidate changes DNS, starts containers, removes volumes or modifies production by itself.
