# Smart Farmer — Livestock tracking and marketplace discovery

## Operational boundary
This is an additive preview for the **Farmer** product. It must remain isolated until the accounting candidate, PostgreSQL migration, native app journeys, rollback, and host capacity are verified. Existing hardware controls and unattended automation remain disabled.

### GPS livestock devices
Apple AirTag / Find My requires Apple's own location network. The product stores a **manual reference only** for an AirTag; it never claims automatic coordinates or proximity from Apple. Use hardware with owner-controlled GNSS positioning plus an authorized LoRaWAN, cellular or satellite uplink for a real deployment. LoRaWAN requires gateways and coverage; 2G/4G requires a carrier SIM/data plan, roaming and expected power budget; a satellite uplink requires its own subscription.

A tracker belongs to one farm and exactly one animal project, optionally to an individual identity. If no animal identity is selected, the tracker is a *herd representative*: it does **not** locate every animal in the herd. Only authenticated farm members see coordinates or trail history.

Registration generates a 32-byte one-time random gateway credential. Save that token **outside** the app on a trusted gateway/device secret store; only its SHA-256 hash is retained. It can be rotated or permanently revoked. Never put it in a public URL, browser local storage, git, screenshots, or logs. A header **X-Tracker-Token** is required for read-only ingestion; this prototype is not an OEM device driver. Configure the real gateway to convert trusted vendor telemetry to:

```http
POST /v1/trackers/{trackerId}/observations
X-Tracker-Token: <one-time registration credential>
Content-Type: application/json

{"id":"<unique UUID>","observedAt":"2026-11-05T10:15:00Z","latitude":-17.83,"longitude":31.05,"accuracyMeters":8,"batteryPercent":79,"quality":"gnss"}
```

Replace the placeholders and coordinates with actual device observations. For a tracker registered as `demo`, `quality` must be `simulated`; a demo point cannot masquerade as GNSS. Each idempotent UUID can be ingested again with the same payload but not changed. A reading more than 14 days old or over 5 minutes in the future is rejected. Latest position is chosen by **observation time**, not arrival order; older offline uploads cannot overwrite a fresher fix.

User interface: web **Farm → Animals → Herd tracking** and native **Farm → Animals**. Both show tag identity, source, age, battery, coordinates, history and explicit external-map actions. A map link sends exact coordinates to OpenStreetMap *only when clicked*. No auto-sharing or publicly accessible location endpoint is provided.

A location observed more than **30 minutes** ago is marked *stale*. A circle geofence is a farmer-entered radius of 30–50,000 m. A definite outside alert requires a sufficiently accurate fix and distance greater than radius **plus** reported accuracy; uncertain positions should not trigger definitive alarms. Battery readings at or below 15% open an alert. Acknowledgement is not the same as resolution. GPS positions, alerts and animal identities are private, sensitive operational information; use least privilege and data-retention policies.

**Not yet commissioned:** GPS collars/ear tags, LoRaWAN network server or SIM APN configuration, vendor authentication and signing, data-use consent, real radio propagation, active animal health sensing, actual anti-poaching response procedures, continuous push/SMS alerts, and hardware acceptance tests.

### Farmer Marketplace (Kleinanzeigen-inspired)
Preserve working agricultural listings, images, stock-linked availability, seller/buyer conversations, offers, reservations, buying requests, reviews and reports. Add:

| Buyer journey | Smart Farmer implementation |
|---|---|
| Browse and search | Text, category, collection area, price range, condition and currency filters |
| Save interesting listings | Account-scoped favourites, removable any time |
| Save search and be alerted | Up to 30 saved searches; matching new listings appear in **in-app** alerts, pause/delete supported |
| Follow sellers | Farm seller subscriptions; new-listing alerts and public active-listing count |
| Post ads | Existing farm stock/animal listing workflow with up to ten public-safe photographs and explicit availability |
| Contact / negotiate | Existing private enquiries/messages and binding offer workflow |
| Purchase | Existing reservation and order progression, with stock controls, review and moderation |
| Payments | **Manual declarations only**. No escrow, buyer protection, provider settlement, or instant refund is advertised |
| Delivery | Existing farm service-booking infrastructure, not a guaranteed carrier/shipping label integration |

Featured/sponsored ads, full seller profiles/badges, advanced ranking, AI photo-to-listing, external buyer/seller identity verification, shipping labels, provider-backed payments/escrow, and push notifications remain **integration work**, not implemented claims. Do not copy Kleinanzeigen graphics, assets, name or brand; only use its common marketplace workflows as a reference.

### Deployment and testing gates
1. Apply all migrations sequentially to disposable PostgreSQL, test rollback in a separate restored database, and verify media accounting backups are unaffected.
2. Run `npm test` in `smart-farmer-backend` with `TEST_DATABASE_URL` set to a disposable PostgreSQL 17 database; include `tracking-discovery.test.ts`.
3. Run web build and browser acceptance. Check screen width, form input validation, authenticated farm isolation, stale/unknown device states and external-map opt-in.
4. Run native unit/type checks plus actual iOS and Android simulator journeys; keep existing iOS sign-in/TLS/XCTest blockers visible.
5. Commission one **read-only** GPS collar through a supported gateway. Verify real-coordinate accuracy, delayed-data ordering, 12-hour connectivity, battery thresholds, geofences, role separation, credential rotation and offline recovery.
6. Only after real API/web and native release verification may the stacked PR be promoted. No unattended drone/hardware controls are enabled by this work.
