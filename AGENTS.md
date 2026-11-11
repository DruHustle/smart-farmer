# Smart Farmer engineering

The canonical source is `DruHustle/smart-farmer`. Keep the web, native, backend
and edge applications independently buildable. Read the affected README,
`smart-farmer-backend/docs/status.md` and release workflow before changes.
Preserve existing work, histories, memberships, encrypted offline queues and
physical actuation interlocks. Use synthetic records for tests. Never store
credentials, private farm records, signing keys or provisioning profiles in Git.

Keep extra worktrees in `local-tools/worktrees`, deployment evidence in
`local-tools/deployment-evidence`, verification evidence in
`local-tools/release-verification`, and migration records in
`local-tools/migrations`. Keep these artifacts local unless explicitly reviewed
for publication. Do not create a workspace-root `release-verification` directory.

Use Node 24 and committed npm lockfiles. Backend checks require an explicitly
isolated PostgreSQL database ending in `_test`; invoice checks also require
Tesseract and Poppler. Run backend `npm test`, web `npm test && npm run build`,
native `npm test && npm run typecheck`, and the affected real browser journeys.
`smart-farmer-frontend/web/test/browser.mjs` exercises actual API/database flows.
Native JavaScript export does not prove an APK/AAB, signed iPhone archive,
physical device, Apple Pay/Google Pay, or store acceptance.

Onesa Portal is the identity authority. Bind identities by issuer and subject,
never email alone. Approved ordinary accounts receive farm access only through
explicit memberships; global administrators still require current MFA.
Preserve PKCE/state, live revocation, return destinations and retry identifiers.
Native signing, physical commissioning, provider integrations and fluent human
language approval need actual evidence and their named owners.

As of 11 November 2026, customer/native qualification is in draft PR #24;
inspect its exact head and any stacked native PRs before duplicating work.
Do not treat prior CI or a candidate branch as production deployment evidence.
Record the exact tested revision, environment, command and remaining blocker.
