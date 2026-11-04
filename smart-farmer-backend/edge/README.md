# Smart Farmer gateways

Node 24 processes run independently from the API and clients. Install with `npm ci`. Keep each asset's state directory on a persistent private volume. All cloud connections are outbound and authenticated with a credential scoped to that asset; HTTPS is required outside development loopback. Credentials expire after 30 days and an owner can rotate them.

| Process | Start | Purpose |
| --- | --- | --- |
| Equipment simulator | `npm start` | Durable observations and start/stop feedback without physical equipment |
| Equipment adapter | `npm run hardware` | Approved HTTP, MQTT, Modbus TCP or Modbus RTU mappings |
| Camera gateway | `npm run camera` | Allowlisted ONVIF discovery/events and bounded RTSP capture for requested live views/event clips |

`npm test` exercises real local HTTP and MQTT servers, a Modbus TCP server, Modbus RTU framing/CRC over an isolated Linux serial pseudo-terminal, ONVIF SOAP responses, unsupported operations, expiry, stale readings and replay rules. These fixtures do not establish compatibility with a farm device. The backend's `test/edge-http.test.ts` also starts the simulator against the real API/PostgreSQL, interrupts connectivity, restarts it and verifies that expired control does not execute.

## Simulator

Register a pump, pivot or valve with protocol `simulator`. Issue a token as owner through `POST /v1/farms/:farmId/assets/:assetId/gateway-token`. Export `API_URL`, `ASSET_GATEWAY_TOKEN`, `GATEWAY_STATE_DIR`, and intentionally set `SIMULATOR_INTERLOCK_OK=true` to test starts. Then run `npm start`. False/unset interlock blocks a start. Source is always `simulator`.

## Real equipment configuration

First register the actual asset without enabling control. Record the known make/model, controller and firmware, then submit its public mapping using the owner integration form. Public mappings contain a private configuration *reference*, measurement names/units and approved operations. Connection endpoints and credential environment references live only in the protected gateway configuration.

Set `GATEWAY_CONFIG` to an owner-reviewed JSON file. The following is an **HTTP protocol simulator example**, not a device specification:

```json
{
  "version": 1,
  "configurationHash": "COPY_THE_64_CHARACTER_HASH_FROM_THE_INTEGRATION_RESPONSE",
  "protocol": "http",
  "pollMs": 5000,
  "timeoutMs": 3000,
  "connection": {
    "url": "https://approved-device.example.invalid",
    "telemetryPath": "/telemetry",
    "tokenEnv": "DEVICE_API_TOKEN"
  },
  "telemetry": [
    {"name":"running","unit":"boolean","address":"running"},
    {"name":"interlock_ok","unit":"boolean","address":"interlock_ok"},
    {"name":"pressure_kpa","unit":"kPa","address":"pressure","scale":0.1}
  ],
  "commands": [
    {"name":"start","address":"/start","value":true},
    {"name":"stop","address":"/stop","value":false}
  ]
}
```

HTTP command bodies are `{id,value,expiresAt}` with an `Idempotency-Key` header. The device adapter must actually implement that contract; pointing it at an unrelated vendor URL does not create compatibility. Endpoints cannot redirect or move to a different origin. Feedback, rather than HTTP acceptance, determines confirmation.

MQTT uses `protocol: "mqtt"`, a `mqtts:` broker URL, optional `usernameEnv`/`passwordEnv`, concrete telemetry addresses such as `pump/state#running`, and concrete command topics. Payloads are JSON. Commands include their ID, approved value and expiry, use QoS 1 and are never retained. All configured feedback must be recent. Use a dedicated broker identity limited to these topics. Broker acknowledgement alone is not device execution.

Modbus uses `modbus-tcp` (`host`, `port`, `unitId`) or `modbus-rtu` (`path`, `baudRate`, `unitId`, optional `parity`/`stopBits`). Explicit `allowInsecure: true` acknowledges the isolated device network/serial link. Addresses are `coil:N`, `discrete:N`, `holding:N` or `input:N`. Registers support unsigned 16-bit values, `format:"int16"`, or `format:"float32"` with explicit `wordOrder`. Scale and offset are applied once. Only configured coils/holding registers can be written, only for mapped start/stop values. No arbitrary-write endpoint exists. Linux `/dev/pts/N` supports the test fixture; it is not evidence of an installed RS485 device.

The gateway will not dispatch controls until the API has recorded fresh hardware feedback and owner commissioning. It reads the local interlock again after cloud acknowledgement, persists the command intent before writing and never repeats a stored command ID after restart. A network/write ambiguity produces `outcome_unknown`. Controller-enforced interlocks and manual override remain essential; the gateway cannot guarantee a physical fail-safe.

## Camera configuration

Install FFmpeg with the H.264 encoder available on the edge host. Set `CAMERA_CONFIG` to a protected JSON file:

```json
{
  "deviceService":"https://camera.example.invalid/onvif/device_service",
  "allowedHosts":["camera.example.invalid"],
  "usernameEnv":"CAMERA_USERNAME",
  "passwordEnv":"CAMERA_PASSWORD",
  "profileToken":"MODEL_SPECIFIC_LOW_BANDWIDTH_PROFILE",
  "eventTopics":[{"topic":"EXACT_VENDOR_MOTION_TOPIC","kind":"motion","zoneId":null}],
  "personAnalyticsVerified":false
}
```

Supply the exact reported profile/topic identifiers from device documentation or an authorized inspection. There is no network discovery/scan. Every URL returned by ONVIF must match the explicit hostname allowlist. HTTP/RTSP require explicit isolated-network acknowledgement; do not forward these ports to the public internet. Private credentials appear only in the local capture process environment/configuration and its protected process arguments, never client URLs or logs. Restrict OS access on the gateway.

The API camera configuration controls supported live/snapshot/motion/person features, zones, schedules, deduplication, grants and retention. A topic is treated as person detection only when that exact topic and verified analytics capability were configured. Motion is never upgraded to person detection. PTZ reported by a device remains disabled: no arbitrary movement is exposed without a concrete, reviewed device control mapping.

Live capture starts only while an authorized short-lived viewing session exists. Each bounded capture is up to eight seconds at 640px, 10fps and approximately 350 kbit/s, segmented for private HLS. Event clips are captured after the detected event; this implementation does not promise pre-event footage. Segments upload independently from event metadata. The cloud stores binary media in the object store, not PostgreSQL. Local camera/recorder operation still depends on local power and configured recording; this gateway does not claim to replace a recorder.

## Capacity and recovery

Simulator buffering is capped at 1,000 observations; hardware buffering at 10,000 typed/legacy observations. Overflow increments a visible diagnostic counter. Camera buffering is capped at 120 queued event/segment records; live segments older than 30 seconds are dropped because they are no longer live. A permanent rejection drops that video upload while retaining the server event. Provision storage and monitoring for the actual farm workload.

State writes use private files and atomic replacement. Hardware command intent is fsynced before device writes; validate storage/power-loss behavior on the commissioned host. A 401 stops the process; replace rotated/expired credentials before restarting. Configuration-hash changes require explicitly archiving the old state and recommissioning. Investigate unknown outcomes before touching the replay journal.

See [commissioning](../docs/hardware-and-commissioning.md) and [provider/operations setup](../docs/operational-integrations.md).
