# Hardware compatibility and commissioning

## Implemented capability boundary

No physical device has been commissioned. An asset can be registered before its make/model is known; this creates no invented readings or enabled controls. Water sources, pumps, storage, distribution and pivots may be separate linked assets. `parentAssetId` belongs to the same farm.

| Interface | Implemented now | Hardware claim |
|---|---|---|
| Simulator over authenticated HTTPS | Persistent telemetry, expiring commands, interlocks, feedback, replay journal and outage buffer | Software simulator only |
| MQTT | Protocol selection and explicit unconfigured capability manifest | No live driver or verified topic mapping yet |
| HTTP vendor devices | Protocol selection and explicit unconfigured capability manifest | No vendor endpoint or capability claim |
| Modbus TCP/RTU | Protocol selection and explicit unconfigured capability manifest | No arbitrary register-write interface; model-specific adapter remains |
| Cameras | Private simulated motion/person events, original event time, acknowledgement, retention | No ONVIF/RTSP live video or analytics integration yet |

The edge gateway uses an outgoing HTTP(S) connection. In production mode it requires HTTPS. Its credentials are scoped to one simulated asset, expire after 30 days, and rotate through an owner-only endpoint. They never enter web or mobile application source. A protocol name is not evidence of compatibility.

## Run the simulator

1. Sign in as owner or manager and register a pump, pivot or valve with protocol `simulator`.
2. As the owner, issue a gateway token with `POST /v1/farms/:farmId/assets/:assetId/gateway-token`. Copy it into a private environment variable, not a committed file.
3. In `smart-farmer-backend/edge`, export `API_URL`, `ASSET_GATEWAY_TOKEN`, `GATEWAY_STATE_DIR` and `SIMULATOR_INTERLOCK_OK=true`, then run `npm start` with Node 24. A false/unset interlock prevents starting.
4. Wait for fresh simulated telemetry. Submit an explicitly confirmed `start` or `stop` through the manager UI/API with an expiry at most 120 seconds away.
5. Observe dispatched, acknowledged and feedback-confirmed states separately. Acknowledgement alone does not establish that the operation completed.
6. Disconnect/reconnect the gateway. It buffers observations with original IDs/times and sends them after reconnection. Dispatched commands are never redelivered. Expired undispatched commands become `expired`; dispatched commands with no verified outcome become `outcome_unknown`.

`npm test` in the edge directory checks the simulator safety rules and bounded buffers. The backend `test/edge-http.test.ts` also starts the real gateway process against an HTTP API and PostgreSQL, verifies feedback, restarts through an outage, drains the durable buffer, and confirms that an expired command does not execute after reconnect.

The buffer is bounded at 1,000 observations and records a dropped-observation count. This is an explicit capacity limit, not a promise of unlimited offline retention. Keep the state directory on a persistent private volume and preserve it across restarts. Commands are never inserted into this observation buffer.

## Information needed for each real installation

Record the make/model, controller and firmware; supported protocol; documented measurement/register/topic map; units and quality fields; read-only and write permissions; network/addressing and power/loss-of-network behavior; manual override and physical interlocks; and the commissioning owner. Keep connection credentials in the gateway's protected runtime configuration.

For a borehole/pump, identify the water source, motor/controller and power supply separately. Confirm which water-level, runtime, flow, pressure, fault and power readings actually exist. For a pivot, confirm available position, direction, speed, programme and safety-stop capabilities. For a camera, confirm ONVIF/RTSP capabilities, motion versus person analytics, authenticated stream path, PTZ permissions, clip limits and retention.

## Commissioning sequence

1. Verify the model and protocol documents on an isolated test installation.
2. Implement and test a read-only adapter with explicit units, observed time, receipt time and stale thresholds.
3. Check credential rotation, least privilege, allowlisted destinations and private stream paths. The cloud API must not fetch arbitrary user-supplied camera URLs.
4. Record local interlocks and manual override. Test power/network loss locally with the device owner.
5. Map a short allowlist of approved commands. Verify expiry, duplicate delivery, lost acknowledgement and missing feedback using the real controller.
6. Enable physical control only after reviewed commissioning evidence and a defined rollback/manual-operation procedure.

The current code deliberately cannot mark an unknown real device as control-enabled. Physical drivers, configuration editing and a reviewed commissioning-state transition must be implemented before that enablement path is added. Do not remove the simulator-only gate as a shortcut.
