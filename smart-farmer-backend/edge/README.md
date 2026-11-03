# Smart Farmer edge simulator

This is an independently runnable Node 24 gateway. It sends observed simulator telemetry to the API, polls for eligible commands, acknowledges receipt, and confirms the simulated state only after applying the command. It controls **no physical equipment**. MQTT, Modbus, HTTP hardware, ONVIF and RTSP drivers are not implemented.

## Run locally

1. Start and migrate the backend. Create a farm account and a `simulator` pump, pivot or valve through the web equipment page or [equipment API](../docs/integrations-api.md).
2. As the farm owner, issue a credential with `POST /v1/farms/:farmId/assets/:assetId/gateway-token`. The credential is scoped to that asset and shown once. Rotation invalidates the previous credential.
3. Copy `.env.example` to a private `.env` and set `ASSET_GATEWAY_TOKEN`, `API_URL`, and `GATEWAY_STATE_DIR`. Set `SIMULATOR_INTERLOCK_OK=true` only when intentionally testing the simulator's permissive interlock state.
4. From this directory, run:

```sh
node --env-file=.env src/gateway.mjs
```

There are no third-party runtime dependencies. `npm start` uses variables already in the process environment. `npm test` runs replay, deadline, interlock and buffer checks. The backend's `test/edge-http.test.ts` additionally launches this gateway against a real HTTP API and PostgreSQL database, including an outage and process restart.

HTTPS is required except on a development loopback address. The gateway does not listen for incoming connections. A 401 response stops it; replace an expired or rotated credential before restarting.

## Persistence and commands

The private state directory contains simulator state, previously executed command IDs, and up to 1,000 queued observations. IDs and original timestamps survive process restart. Overflow drops the oldest observation and increments an explicit loss counter. Credentials are not written into the state file or logs.

Commands are online-only. The API checks capability, fresh telemetry, interlocks, authorization and expiry before dispatch. The gateway checks the deadline again after acknowledgement. A dispatched command is not automatically redelivered after an uncertain response. Lost confirmation becomes an unknown outcome rather than assumed success. Test interlocks and simulator feedback are not evidence of a physical pump's state or electrical safety.

Do not delete the state directory to resolve an uncertain command without investigating the event. The current implementation provides process-restart durability; filesystem/power-loss durability and physical control commissioning require deployment-specific validation.

Read [hardware and commissioning](../docs/hardware-and-commissioning.md) for unknown hardware registration, actual-device prerequisites and commissioning.
