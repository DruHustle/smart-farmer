# Optional farm Node-RED package management

This source feature adds **Node-RED nodes, plugins and node libraries** from the
Smart Farmer web Equipment page. It is disabled until an operator enrolls a
private farm gateway. It does not install packages as part of deployment, import
flows, activate devices, manage arbitrary Function-node dependencies, or expose
saved flow libraries. Real farm commissioning remains a separate acceptance step.

Installing a package executes code inside Node-RED and may affect existing flows
and connected devices. A farm **owner** must review the exact package, version and
gateway and explicitly acknowledge this before each request. Manager, worker and
adviser roles cannot use the management API. An owner should approve installation
only in an appropriate equipment maintenance window.

## Existing topology and private maintenance route

The existing dedicated Linux farm gateway runs Node-RED with host networking on
`127.0.0.1:1880/admin`, durable `node_red_data:/data`, and its existing encrypted
flow credentials. Python owns the independent signed, outbound observation path
and durable SQLite queue. Package management does not change that ingestion
contract or authorize equipment commands through it.

The web browser calls the Smart Farmer backend. Its management client accepts
only an operator-configured, literal loopback HTTP URL ending in `/admin` with an
explicit port. **Loopback in the API container is not the gateway's loopback.** A
separately approved private maintenance forward must share the API network
namespace, or the UI remains unavailable. Setting a token alone is insufficient.

`compose.node-red-management.yml` is an optional overlay for the existing local
backend `compose.yml`. Its supervised SSH sidecar shares `service:api`, forwards
`127.0.0.1:18880` to the authorized gateway's `127.0.0.1:1880`, verifies the pinned
SSH host key and uses a private existing SSH configuration. There is no published
management port. Supply an operator-reviewed immutable SSH-client image, non-root
UID/GID, and a read-only private directory containing the authorized SSH config,
identity and known_hosts. The config's `node-red-gateway` alias must reference
container paths under `/run/node-red-ssh`. Do not enable public 1880 access or
create new firewall trust as part of this feature.

The overlay is never included automatically. After normal authorization and
private route verification, an operator may explicitly include it with
`docker compose -f compose.yml -f compose.node-red-management.yml --profile node-red-management`.
For several gateways, commission one separate private forward/listener per
gateway with distinct IDs and ports; the example covers one. The UI has no SSH,
host, port, command, credential or network-configuration fields.

## Enrollment and durable state

1. Back up the gateway's `/data` and preserve `NODE_RED_CREDENTIAL_SECRET`. Keep
   the existing editor bcrypt credentials, `/flows` basic authentication, signed
   observation keys, Python queue and asset mappings. No second device poller is
   added. Review the Node-RED image before changing the existing runtime.
2. This implementation verifies the **Node-RED 4.1.4** Admin API contract. Use that
   reviewed version/digest for an enrolled gateway. Its supported
   [`POST /nodes` handler](https://github.com/node-red/node-red/blob/4.1.4/packages/node_modules/@node-red/editor-api/lib/admin/nodes.js)
   passes a separate `version` field into the runtime installer. Do not encode
   `module@version`, use the editor upload route, or assume another version has
   this contract without testing it.
3. On the gateway, set a stable lower-case `NODE_RED_RUNTIME_ID` UUID and an
   independent random 64-hex-character `NODE_RED_ADMIN_TOKEN`. The optional token
   receives only `nodes.read`, `nodes.write`, `plugins.read`, and `settings.read`;
   the existing editor login remains separate. Node-RED's configured palette
   policy allows additions but refuses updates and archive uploads, including
   requests racing from another editor. See the official
   [admin authentication permissions](https://nodered.org/docs/user-guide/runtime/securing-node-red).
4. Through the normal additive migration process, apply
   `013_node_red_package_operations.sql` after a database backup. The separate
   accounting/tracking candidates own 011/012; this migration has no dependency
   on either and never edits previously applied migrations. New management fails
   closed if its storage is absent; the existing unconfigured API remains usable.
5. Keep the existing `SMART_FARMER_EDGE_GATEWAYS` signed-ingestion allowlist. Set
   the following **private server configuration** only after route enrollment:

   ```text
   SMART_FARMER_NODE_RED_MANAGEMENT_ENABLED=true
   SMART_FARMER_NODE_RED_GATEWAYS={"pi-farm-1":{"runtimeId":"<stable-uuid>","label":"Farm irrigation gateway","version":"4.1.4","adminUrl":"http://127.0.0.1:18880/admin","token":"<independent-64-hex-token>"}}
   ```

   Each key must already exist in `SMART_FARMER_EDGE_GATEWAYS`; its farm is derived
   from that signed-ingestion enrollment. Runtime UUIDs and private routes must
   be unique, with at most 32 configured gateways. A changed farm, gateway, URL,
   runtime ID, version, label or token invalidates outstanding package reviews.

## Authorization and installation outcomes

All routes under `/v1/farms/:farmId/node-red/gateways` require a valid opaque
session and current farm owner membership. The service checks these again in
the database reservation and immediately before the mutating request. Reviews
last ten minutes, bind the owner session, farm, gateway, runtime revision and
exact selection, and do not expose credentials or private paths. Only canonical
npm names and exact semantic versions are accepted; paths, URLs, archives,
aliases, ranges and tags are rejected. Registry metadata must declare Node-RED
nodes or plugins. This identifies package type, not package trustworthiness;
owners must review the chosen publisher and package code before approving.

A PostgreSQL transaction takes a global per-runtime advisory lock, records the
unique request and audit event, and commits **before** the background Admin API
POST. That transaction is independent of the HTTP request and never spans npm
execution. Every API process sees the same slot, and only one install can remain
pending for a runtime. Reusing the same request ID returns the original outcome;
reusing it for another selection is refused.

Network requests refuse redirects, cap responses at 1 MiB, and use bounded
deadlines (8 seconds for reads, 120 for installation). The server sends only
`{module, version}` to the enrolled Admin API. It checks the runtime identity,
exact version, narrow permissions and add-only policy before installation.
Success requires read-back of the exact module version without reported load
errors or a pending version. It does not prove calibration, commissioning, that
disabled nodes are enabled, or safe active-flow behavior.

Lost responses, timeouts, and verification failures after an accepted POST are
saved as `unconfirmed`. They continue to block new installations across API
restarts. There is no automatic replay, startup unlock or install retry. The
owner's **Check saved outcome** action only reads inventory; absence cannot prove
a still-running npm operation has failed. A confirmed exact read-back can clear
the uncertainty. If it cannot, an operator must inspect the original runtime and
its saved operation during maintenance; do not delete the slot to guess success.

The web panel uses the optional `node-red-package-management-v1` capability from
the current authenticated farms response. Older APIs omit it, so a web rollback
does not issue unknown management requests. Installation is never placed in the
offline outbox. Preserve database operation history and gateway `/data` across
releases; rolling back the application does not uninstall runtime packages.

## Acceptance before activation

Run backend tests with a disposable PostgreSQL database, the web browser owner
journey, and edge settings tests through normal CI. Separately verify the actual
private tunnel, pinned host key, runtime ID/version, permissions, persisted data,
session revocation, and backup/restore on the intended farm gateway. Source and
fixture qualification do not commission physical equipment or install a live
package. Approval of a package installation must remain a fresh owner action.
