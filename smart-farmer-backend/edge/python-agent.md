# Optional Smart Farmer Python / Node-RED edge

Farm owners can use the optional [Node-RED package manager](../docs/node-red-packages.md)
after its private maintenance route is enrolled. It adds exact reviewed node/plugin
versions; package code can affect flows and devices, so approval and commissioning
remain separate from this observation-only ingestion path.

**Status: software candidate, not commissioned.** Smart Farmer has its *own* Node-RED,
Python Edge Agent, databases, secrets and operating procedures. It does not rely on
Smart Factory, IMSOP or a common Onesa runtime.

## Boundary

Equipment (borehole, pump, pivot, tank, flow/pressure/soil/weather sensors)
→ Node-RED connector and transformation
→ Python agent on the gateway (identity, schema, provenance boundary, local SQLite
outbox, optional future passive security/AI analysis)
→ signed HTTPS/TLS delivery
→ Smart Farmer API → farm-scoped PostgreSQL.

Alongside the existing standalone Node.js equipment and camera gateways, this independent Python path uses **signed HTTPS** from Python to the
backend, not a commissioned MQTT/TLS uplink. MQTT is supported as a Node-RED source;
a broker-backed cloud uplink must not be claimed until a matching subscriber and
operational acceptance exist. The application remains authoritative; the event
receiver records *unverified observations*, never measured running state without
commissioning. There is deliberately no remote-start/stop API.

### Device connection ownership

Only Node-RED reads commissioned vendor interfaces. Its flows may read Modbus,
OPC UA, MQTT, serial and vendor-specific equipment via separately reviewed plugins.
Do not enable two pollers for the same device: the first migration keeps old
adapters until a device-by-device cutover is verified. Python alone owns its
outbound identity and durable queue, and validates every mapped event again.

Keep camera video separate: RTSP/ONVIF stays on a local NVR/camera agent. Publish
privacy-reviewed event metadata and thumbnails via an object store only after the
camera-security feature is separately implemented. Never publish RTSP video on
MQTT or this JSON observation endpoint.

## Local gateway setup

- Use a **dedicated Linux gateway**, not a production PLC. Install Python 3.11+
  (no third-party packages required for this candidate), Docker Compose v2, and
  a broker if any upstream Node-RED adapters require it.
- In \`edge/.env.example\`, replace every placeholder in a **private root/service
  readable** environment file, never in Git. The two secrets must be independent.
  Choose source IDs assigned to this farm and review the asset/tag mapping.
- Set the backend's \`SMART_FARMER_EDGE_GATEWAYS\` to a secret JSON mapping, e.g.
  \`{"pi-farm-1":{"farmId":"<actual-farm-uuid>","secret":"<32+ random chars>","sources":["pivot-1"]}}\`.
  The gateway \`EDGE_OUTBOUND_SECRET\` must match the entry. The field \`farmId\`
  must be an existing farm. Keep the mapping in a secret store.
- Apply \`migrations/010_edge_observations.sql\` through the normal migration
  process after an independent database backup; do **not** reapply 001.
- Run from \`smart-farmer-backend/edge\`: \`python3 agent.py\`. Supply environment
  through a protected systemd unit or explicitly export it from the protected
  env file; the Python runtime deliberately does not load arbitrary .env files.
  It binds only \`127.0.0.1:18777\`.
- For Node-RED, put a private \`.env\` beside \`node-red/compose.yml\`, run
  \`docker compose --env-file .env config\`, then
  \`docker compose --env-file .env up -d\` on that **Linux** gateway. The
  example flow is disabled and simulated, and does not run automatically.
  Access the editor by SSH tunnel; the editor and Python listener are loopback
  only. Since host networking can reach other host interfaces, block unneeded
  container egress and restrict hardware destinations with OT firewall policy.
- Configure real adapter nodes only after vendor documentation, range, units,
  source timestamp, network allowlists and broker ACLs are reviewed.

## Contract and reliability

The local POST \`/ingest\` accepts an **exact** JSON event. Header
\`Authorization: Bearer <EDGE_INGRESS_TOKEN>\` is mandatory.
A \`measurement\` has \`schemaVersion:1\`, UUID \`eventId\`, commissioned
\`sourceId\`, \`observedAt\` with UTC offset, \`kind:"measurement"\` and
\`data: {assetId,metric,value,unit}\`. Equipment status instead has a
reviewed \`state\` and optional code; source text is never a command.

Python checks the allowlist, field types, non-finite values and timestamps,
then fsyncs the SQLite outbox before returning HTTP 202. Network failure retains
the same event ID and retries with a *new* five-minute HMAC timestamp. The API
verifies HMAC-SHA256 over \`<timestamp>.<raw request body>\`, maps the gateway
to exactly one authorized farm, rejects uncommissioned sources, and accepts
identical retries without duplicating records. Conflicting IDs are rejected.
The API returns a JSON receipt with `accepted`, `duplicate` and the submitted
`eventId`. The gateway also accepts the earlier two-field Farmer receipt. It
keeps readings in SQLite through maintenance pages, redirects, temporary
authentication failures and mismatched receipts, then retries with the same
event ID. Rejected payloads, uncommissioned sources and conflicting event IDs
remain quarantined for operator review.

GET \`/v1/farms/:farmId/equipment/observations\` requires a normal farm membership
and returns at most 100 recent records. Users from other farms receive 404.

## Optional security and AI

The Python agent already produces a local, durable \`security_events\` ledger for
rejected source identities, malformed messages and unauthorized ingress. This is
**passive cybersecurity evidence**, not a vulnerability scan or protection
certificate. Do not send raw sensor data to an external AI without explicit
privacy controls, authorization and model approval. An AI advisory module can be
added as a separate **read-only** step after validation, but none is activated
by this release. No model may issue commands automatically.

## Verification

\`\`\`sh
cd smart-farmer-backend/edge
python3 -m unittest discover -s . -p 'test_*.py' -v
# At the repo root with a disposable test PostgreSQL database:
npm test --prefix smart-farmer-backend
npm run build --prefix smart-farmer-backend
\`\`\`

Additional acceptance before production: real vendor gateway test, reconnect/
power-loss drills, long outage backlog, backups and restore, signed device-source
commissioning, permissions, a local broker ACL exercise, mobile/offline workflow,
and proof that no control path bypasses the safety PLC/controller.
