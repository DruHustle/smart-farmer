# Smart Farmer

Smart Farmer supports crop and livestock work, offline field records, connected farm equipment, private security cameras, agricultural trading and machinery services. The web interface is available in English (`en`), Shona (`sn`) and Zimbabwean Northern Ndebele (`nd`). The native apps offer Shona and Zimbabwean Northern Ndebele. Unknown farm facts remain unknown until an authorised person supplies them.

## Independent applications

| Application | Source | Run and build instructions |
| --- | --- | --- |
| Responsive web/PWA | `smart-farmer-frontend/web` | [Web setup](smart-farmer-frontend/web/README.md) |
| Android, iPhone and iPad | `smart-farmer-frontend/mobile` | [Native setup](smart-farmer-frontend/mobile/README.md) |
| API and maintenance worker | `smart-farmer-backend` | [Backend setup](smart-farmer-backend/README.md) |
| Equipment and camera gateways | `smart-farmer-backend/edge` | [Gateway setup](smart-farmer-backend/edge/README.md) |

Use Node 24 and the committed lockfiles. The backend uses PostgreSQL 17; native builds require the documented Android/iOS toolchains. iPad uses the same iOS application. There is no shared application runtime package across backend, web or mobile.

Sign in or create an account in Company Portal. Smart Farmer uses the approved Portal identity and the memberships granted to it. Existing records and pending offline work are preserved. A deployment with unavailable Portal configuration cannot create a Farmer password account. Password fixtures are confined to a test runtime with a loopback web origin.

## Workflows

The application includes active or new crop seasons; sourced planning and approved task templates; broilers, layers, chicken breeding/hatching, rabbit breeding/grow-out and fish nursery/hatchery/grow-out; inventory, expenses, budgets, sales, recorded receipts and reports; versioned corrections and traceability; stock/animal marketplace reservations; service quotes, deposits, schedules, work and completion; private camera events and viewing; maintenance and verified equipment controls.

Field records and attachments use separate encrypted durable queues. Commercial commitments and equipment commands require current online authorisation. A manually recorded payment is never represented as automatic provider settlement, and simulator observations cannot establish hardware commissioning.

Farm tools add sourced market prices, local support directories and visit requests, reviewed training guides, control/treatment field trials, and hydroponic/aquaponic water logs. Weather forecasts and sensor dashboards show freshness, source and missing data explicitly; threshold alerts use existing verified notification channels. The farm advisor and basic-phone gateway require the documented provider setup before live use. New Shona/Ndebele text remains pending fluent human approval.

## Verification and release preparation

- [Complete Codex brief](smart-farmer-backend/docs/product-brief.txt)
- [Requirements and acceptance evidence](smart-farmer-backend/docs/status.md)
- [All documentation](docs/README.md)
- [Provider, backup and recovery setup](smart-farmer-backend/docs/operational-integrations.md)
- [Hardware commissioning](smart-farmer-backend/docs/hardware-and-commissioning.md)
- [Forecasts, sensor dashboards and alert rules](smart-farmer-backend/docs/monitoring-api.md)
- [Farm tools, advisor and basic-phone setup](smart-farmer-backend/docs/farm-tools.md)

CI exercises PostgreSQL workflows, browser journeys, edge transports, native storage rules and builds, container images, and encrypted isolated restore. Native acceptance separately compiles SQLCipher into Android and iOS simulator applications. Exact results are recorded with the review branch/PR and acceptance matrix.

Production hosting, provider credentials/consent, signing/distribution, actual farm device commissioning and fluent human language approval require the corresponding authorised people and resources. The repository contains no invented Lawfield measurements, balances, equipment models, farm records or production secrets.
