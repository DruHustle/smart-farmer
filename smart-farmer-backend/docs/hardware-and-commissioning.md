# Hardware compatibility and commissioning

No physical Smart Farmer installation has been operated or commissioned during development. The tested transport paths below use synthetic protocol servers and serial fixtures. Registering a protocol or passing a fixture test does not certify a pump, pivot, inverter or camera model.

| Capability | Implemented verification | Required installation evidence |
| --- | --- | --- |
| Simulator | Actual API/PostgreSQL gateway restart, offline buffer, interlock, expiry and feedback tests | No physical claim |
| HTTP | Authenticated JSON reads, fixed operation paths, immutable command IDs, no redirects | Vendor endpoint schema, device acknowledgement and observed state |
| MQTT | Local broker, explicit topics, QoS 1, nonretained commands, freshness rejection | Broker TLS/ACLs, controller message/expiry/replay behavior |
| Modbus TCP | Actual protocol server with coils/register scaling and allowlisted writes | Register map, unit ID, electrical topology, signed/float word order |
| Modbus RTU | Serial pseudo-terminal with real RTU frames and CRC | Serial/RS485 adapter, baud/parity/termination and controller map |
| ONVIF | SOAP security, profiles, stream URI, pull-point events and host allowlist fixtures | Exact camera/recorder model, supported profile, topic and analytics mapping |
| RTSP/private HLS | Bounded FFmpeg capture implementation, real MPEG-TS simulator playback through authenticated API | Actual camera codec/transport, edge capacity and live reconnect test |
| PTZ and vendor-specific pivot programmes | Capability remains explicitly disabled until a supported control mapping is reviewed | Model-specific motion/programme commands, stop behavior and physical verification |

## Asset lifecycle

Assets can be registered with unknown models and no fabricated readings. Link source, pump, power, storage and pivot/zone assets when those relationships are actually known. Record location and responsible person. Usage, maintenance, history and manual observations work without a sensor.

Owner integration configuration records the selected transport, private connection reference, typed measurements and approved start/stop mappings. This produces a configuration hash and `connected-awaiting-verification`. Simulator configuration produces `simulated` and cannot be used as real commissioning evidence. Gateway tokens are scoped to one asset and rotate through the owner endpoint.

A real gateway must provide recent observations bound to the current hash. Read-only commissioning requires known model, identity/mapping/feedback checks, evidence and password reauthentication. Control commissioning additionally requires local interlocks, manual override and network-loss checks, actual command mappings and explicit owner confirmation. The state becomes `verified-read-only` or `verified-control-enabled` accordingly.

Changing model, controller, firmware or integration mapping invalidates commissioning, rotates away the existing credential and terminates outstanding commands. Authorized commands become rejected; previously dispatched commands become outcome-unknown. Existing observations and audits remain. Ordinary field offline queues cannot contain equipment commands.

## Commissioning record for each asset

1. Identify make/model, serial/asset label, controller, firmware and source protocol documentation/version. Photograph labels and retain the authorized evidence in private farm records.
2. Confirm the private endpoint/serial device and access policy. Use the minimum read/write credentials. Explicitly approve any plaintext isolated network; prefer TLS wherever the controller supports it.
3. Compare every telemetry address, unit, scale, sign/word order and quality flag against a known reference. Preserve observation/receipt timestamps and check clock skew. Unsupported readings remain absent.
4. Test disconnected/stale input, process restart, token rotation and buffer limits. Set a justified freshness threshold. Confirm neither delayed telemetry nor an old command can initiate a late start.
5. Test controller-enforced local interlocks and manual override under the owner's physical supervision. Record behavior during power loss, network loss, gateway failure and manual control. Define the manual operating and emergency-stop procedures.
6. Verify each approved operation on an isolated safe installation: request, dispatch, acknowledgement, observed state, rejected interlock, expired command, duplicate delivery, missing feedback and uncertain outcome. Acknowledgement is not confirmation.
7. Record evidence and check all required fields in the owner commissioning form; reauthenticate and explicitly enable only the verified mode. Restrict ongoing controls to authorized managers/owners.
8. Retain the register/topic map and configuration hash with the evidence. Any relevant hardware/configuration change requires a new review. Do not erase the command journal to work around an unknown result.

For a pivot, list which position, sector, speed, direction, fault and programme capabilities the controller actually exposes. Generic typed telemetry can display them, but an unsupported operation must remain disabled. For cameras, verify low-bandwidth profile, snapshot support, exact motion/person topics, privacy zones/schedules, private HLS on every client, codec compatibility and storage/retention capacity. Software PTZ remains disabled pending an approved device mapping.

## Verification limits

The commissioning form records an authorized person's assertion and supporting text; it cannot independently prove the wiring or physical tests. No make/model, local network, real controller state, camera analytics quality or physical safety has been inferred from simulator results. See [edge setup](../edge/README.md) for runnable protocol configuration and capacity limits.
