# Forecasts and sensor monitoring

Migration `020_monitoring.sql` adds forecast refresh state, explicit farm alert
rules and durable alert evidence. Apply it before starting the updated API and
worker. Existing weather observations, forecasts, equipment mappings, identity,
notification opt-ins and delivery queues are preserved.

## Forecast provider setup

`WEATHER_PROVIDER=met-no` uses the MET Norway Locationforecast compact API. It
does not require an API subscription or key. Set `MET_WEATHER_USER_AGENT` to an
identifying application name and a real company contact address or website;
the application leaves this value unset until an operator supplies it. For
example, the value has the form `SmartFarmer/0.2 https://YOUR-COMPANY-CONTACT-PAGE`.
No account or paid subscription is created by this feature.

MET calls run on the server. Coordinates are truncated to four decimal places
in provider requests. Forecasts retain the exact user-confirmed farm coordinates
they correspond to. The refresh cache is shared across farms using identical rounded provider coordinates. It waits at least three hours plus a small
per-farm spread, respects a later provider `Expires` header and uses
`If-Modified-Since` after the first response. Rainfall totals covering six hours
are never treated as hourly rainfall; unavailable hourly values remain null.
Wind is converted from m/s to km/h and the attribution records that change.
The response includes the provider, source documentation, license and fetch
time for presentation alongside the forecast.

The existing `WEATHER_PROVIDER=open-meteo` adapter remains available. Production
still requires `OPEN_METEO_API_KEY`: Open-Meteo's free hosted endpoint is for
non-commercial use. Never remove that check to activate a commercial deployment.
`WEATHER_API_URL` is an optional operator-selected endpoint; loopback HTTP is
permitted only in `NODE_ENV=test`.

The farm owner must confirm latitude/longitude and `weatherEnabled=true` through
the existing settings endpoint. Creating an enabled weather rule opts that farm
into background refresh. Each maintenance pass refreshes at most one due farm;
subsequent passes evaluate its new forecast. A failed request preserves the last
good forecast, records a visible error and backs off. Changing coordinates makes
the old forecast stale and eligible for replacement. Disabling weather prevents
new forecast alerts and automatic refresh.

Provider references, reviewed 28 November 2026:

- [MET Norway API terms](https://api.met.no/doc/TermsOfService)
- [Locationforecast update intervals and data](https://api.met.no/weatherapi/locationforecast/2.0/documentation)
- [MET Norway data license](https://api.met.no/doc/License)
- [Open-Meteo forecast contract](https://open-meteo.com/en/docs)
- [Open-Meteo hosted-service terms](https://open-meteo.com/en/terms)

## Existing forecast routes

Every route below uses a live authenticated session and current farm membership.

| Route | Role | Behavior |
| --- | --- | --- |
| `GET /v1/farms/:farmId/weather` | Any member | Saved forecast, measured observations, provider configuration and freshness. |
| `POST /v1/farms/:farmId/weather/refresh` | Owner or manager | Rechecks membership and farm opt-in; fetches or uses the permitted provider cache. Body `{}`. |

The response preserves `forecast`, `observations`, `configured` and `stale`, and
adds `locationMatched`, `nextRefreshAt` and `lastError`. A forecast contains
`kind: "forecast"`, `provider`, `sourceUrl`, `fetchedAt`, `timezone`, `validFrom`,
`validUntil`, confirmed `latitude`/`longitude`, `attribution`, `licenseUrl`,
`hourly` and `units`. Hourly ISO UTC times align with arrays of temperature,
relative humidity, precipitation and wind. Each value may be null.

A forecast is stale if its location differs from current settings, its validity
has ended, or it was fetched more than six hours ago. A recent network fetch
does not make an expired forecast valid. Forecasts stay separate from measured
rainfall and weather records.

## Dashboard and alert routes

| Route | Role | Behavior |
| --- | --- | --- |
| `GET /v1/farms/:farmId/monitoring` | Any member | Latest sensor metrics, bounded history, gateway status, rules and 20 recent alerts. |
| `GET /v1/farms/:farmId/monitoring/rules` | Any member | UUID cursor pagination, `limit` up to 100. |
| `POST /v1/farms/:farmId/monitoring/rules` | Owner or manager | Creates an explicit threshold; UUID request replay is idempotent. |
| `PATCH /v1/farms/:farmId/monitoring/rules/:ruleId` | Owner or manager | `{version, enabled}`; a stale version returns 409. |
| `GET /v1/farms/:farmId/monitoring/alerts` | Any member | UUID cursor pagination, `limit` up to 100; retained source evidence. |

Create-rule input:

```json
{
  "id": "client-generated UUID",
  "name": "A meaningful threshold name supplied by the farm",
  "source": "weather",
  "metric": "temperature_2m",
  "operator": "below",
  "threshold": 0,
  "unit": "C",
  "staleAfterSeconds": 900,
  "lookaheadHours": 24,
  "cooldownMinutes": 360,
  "enabled": true
}
```

The temperature value above illustrates the contract; it is not a default
agronomy rule or guarantee of frost protection. Thresholds are explicitly chosen
by the farmer or a qualified adviser. `above` and `below` are strict comparisons.
Weather metrics/units are `temperature_2m`/`C`, `precipitation`/`mm` for the hourly
amount, `relative_humidity_2m`/`%` and `wind_speed_10m`/`km/h`.

`source: "asset"` additionally requires `assetId` and an observed or configured
metric/unit belonging to that farm. Rules only alert on fresh, good-quality,
gateway observations from commissioned physical assets. Simulator, unknown,
bad-quality, stale and unit-mismatched readings do not trigger those alerts.

`source: "edge"` additionally requires `gatewayId`, `sourceId` and `edgeAssetId`.
They must correspond to a currently configured farm/source allowlist and an
actual received metric/unit. These incoming observations remain unverified
physical evidence: alerts explicitly retain `commissioned:false` and
`quality:"unverified"`. Revoking the gateway allowlist stops new alerts.

At most 100 rules can belong to a farm. The worker evaluates at most 100 per pass,
rotating by last-evaluated time. Every alert retains its rule name, threshold,
source, observation/forecast time and evidence. The worker applies cooldowns and
event deduplication under database row locks. Repeating the same observation or
forecast hour does not emit another alert after a cooldown. A later qualifying
observation can emit one once the cooldown ends.

## Notification delivery

Alerts enter the existing durable in-app inbox for the farm's current owners
and managers. Push, SMS and email reuse existing verified channels, explicit
preferences, quiet hours, retry rules, provider receipts and membership checks.
An in-app alert does not prove an SMS or push was delivered. Unconfigured external
channels stay unconfigured. Tests use isolated data and do not send messages to
real recipients. The additional Shona and Ndebele notification titles are draft
translations, subject to the existing fluent-language release review.

## Sensor and gateway evidence

`sensors` contains the latest observation per metric and up to 24 earlier points.
Fields include `source`, asset/gateway/source identifiers, metric, value, unit,
quality, simulated/commissioned flags, observation/receipt times, `stale` and the
freshness interval. A non-numeric reading is represented by `value:null`.
The dashboard returns at most 500 asset metrics and 500 edge metrics and sets
`truncated:true` if more exist; the existing observation endpoints retain the
complete records.

Gateway state is based on actual receipt time: `online` means an event arrived
within 15 minutes; `offline` means the latest receipt is older; `unknown` means a
configured gateway has never sent an event. An online gateway may have delivered
an old, stale sensor sample. Battery and data usage remain null unless fresh
`battery_percent` (`%`) or `data_usage_mb` (`MB`) measurements were actually
reported. Connection status never fabricates these values.

The dashboard declares `commandCapability:false`. Neither a threshold rule nor
an alert issues commands, changes plans, applies treatments or bypasses existing
equipment commissioning and actuation interlocks.

## Verification

`test/monitoring.test.ts` uses a real isolated PostgreSQL database ending in
`_test` and local fixture HTTP providers. It covers normalization, source windows,
conditional caching, provider failures, coordinates, tenant/role checks,
idempotency, versions, stale/uncertain/simulator/unit exclusions, concurrent
deduplication, existing notification queue integration, real HMAC edge ingestion,
gateway freshness and forecast opt-in. Record the exact command, revision and
results in the release evidence; these cases do not prove a live sensor or SMS
provider is commissioned.
