# Product backend completion evidence

This document maps the completed business backend to the 24 acceptance outcomes in the full [Codex brief](product-brief.txt). It supplements [the complete status matrix](status.md) and [the product API](product-api.md). All facts used in the tests are isolated synthetic fixtures. No farm production records, physical controls, real buyer messages or live payment settlements were used.

## Implemented business backend

- Sourced project records; eight-criterion crop comparisons with explicit unknowns; immutable template versions; draft previews, explicit approval, single task creation and reschedule impact tokens.
- Documented opening states, historical-only animal records, species-specific chicken/rabbit/fish events, egg versus live-animal counts, birth/litter cohort caps, individual timelines and version-ordered count reconciliation.
- Inventory quantities, pack conversions, grade/location metadata, transfers, forward-only documented valuation, measured use/loss costs, budgets, shared-cost attribution, reversible allocations, compensating expenses and audited opening-balance corrections.
- Currency-separated actual cost, inventory purchase, input consumption, accrued sales, cash, unearned deposits and matched outstanding obligations; current-stock, daily/weekly/season, usage and production reports. Complete profit is never invented from incomplete records.
- Explicit stock/live-animal publication, base-quantity pricing, metadata-free public photo derivatives, provisional harvests, enquiries, offers, buyer requests, atomic reservations, expiry, cancellation, fulfilment, manual receipts, moderation and completed-interaction reviews.
- Resource-aware services, minimum/mobilisation charges, quote acceptance, actual work, accepted/rejected amendments, task linkage, manual payment declarations/provider acknowledgements, refund limits and one expense/provider revenue at completion.
- Narrow adviser observation/evidence participation, financial receipt privacy, deterministic Companion context and paginated history/resource feeds.

## Acceptance mapping

| #   | Backend evidence                                                                                                                                                                        | Execution boundary                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | `core.test.ts` exercises invitations, roles, language, recovery, session races and revocation; `product.test.ts` adds scoped adviser contribution and financial denial.                 | Client/device sign-in and fluent wording are separate evidence.                                     |
| 2   | `api.test.ts` and `core.test.ts` preserve unknown active-crop facts and reject stale edits; product planning tests create a new sourced plan without inventing activities.              | Actual Lawfield dates/area/variety remain user-supplied.                                            |
| 3   | Core activity tests assert one record, stock movement, cost and task completion after duplicate/concurrent IDs.                                                                         | Offline capture, restart and upload are verified by the independent clients/CI.                     |
| 4   | Version conflicts and duplicate-payload checks; product duplicate review and one compensating reversal retain original records and block invalidated sole task evidence.                | Semantic duplicates require explicit manager review.                                                |
| 5   | Crop records, tasks/incidents, harvest stock, market sale/payment, budget/actual and currency-separated season report; product finance/trade tests verify derived effects.              | Complete browser/native season journeys are client acceptance.                                      |
| 6   | Core broiler placement/feed/sample/mortality/partial sale/payment/closure workflow, plus shared live-animal reservation/count tests.                                                    | Physical counts/care instructions are recorded inputs.                                              |
| 7   | Core layer collection/rejects/consumption/sale/continuing flock; grade-specific stock and production metrics.                                                                           | Farm-specific production targets remain sourced templates.                                          |
| 8   | Core incubation/hatch/zero-live hatch, downstream count and cost allocation; sourced hatchery plans and birth cohort identity caps.                                                     | No universal incubation schedule is seeded.                                                         |
| 9   | Core mating/kindling/fostering/weaning and zero-live outcomes; product birth/litter cap race, transfer-preserved lineage and individual history.                                        | Actual parents/litter identities must be known or left unknown.                                     |
| 10  | Core fish water/source/sample/feed/estimated transfer/partial harvest/reconciliation; product performance and valuation checks.                                                         | Integrated water sensors require configured verified hardware.                                      |
| 11  | Product broodstock spawning → eggs → partial hatch/failure → nursery → grow-out. Tests prove broodstock is not deducted and eggs cannot be transferred as live fish.                    | Optional setup creates no fictional hatchery.                                                       |
| 12  | Core incident assignment/acknowledgement/resolution audit; product adviser-owned follow-up and paginated incident history.                                                              | Root notification/provider tests cover external delivery boundaries.                                |
| 13  | Root operations tests cover unknown assets, configuration, commissioning, usage and maintenance costs.                                                                                  | Hardware commissioning is not represented as a business-backend test.                               |
| 14  | Existing integration and real HTTP gateway tests cover expiry, retry, rotation, dispatch, feedback, outages and unknown outcomes.                                                       | Physical fail-safe behavior remains model-specific verification.                                    |
| 15  | Root camera tests cover private sessions/grants, delayed timestamps, clips, quotas, retention and gateway source formats.                                                               | Live camera/analytics compatibility needs the supplied model/network.                               |
| 16  | Product stock/live reservations, concurrent no-oversell, order fulfilment, identity-loss cancellation, expiry, offers, enquiry privacy, requests, moderation and sanitized publication. | All marketplace participants and content are synthetic fixtures.                                    |
| 17  | Existing service overlap/resource-lock tests and product quote/deposit/work/amendment/task/completion/refund tests.                                                                     | Manual acknowledgements explicitly are not processor settlement.                                    |
| 18  | Pack/conversion, weighted and unknown valuation, historical cost non-repricing, transfer conservation, cost allocation races, matched receivables, corrections and multiple currencies. | Missing costs remain disclosed; no currency exchange is assumed.                                    |
| 19  | Farm-scoped endpoints and new adviser/cross-farm tests; legacy receipt linkage stays private after upgrade.                                                                             | Offline cache/device isolation and camera grants have their own client/root tests.                  |
| 20  | User preference feeds deterministic prompts, PDF/CSV language selection and independent client catalogues; both PDF languages use an embedded Unicode font.                             | Fluent Shona/Northern Ndebele review is explicitly unclaimed.                                       |
| 21  | This backend supplies the same documented versioned contract to independent native/web applications.                                                                                    | Backend tests are not Android, iOS, iPad or accessibility validation.                               |
| 22  | Root encrypted backup/restore/object-storage tests; the product upgrade test preserves existing media bytes, financial entries and restrictions.                                        | Off-host key custody, deployment and recurring restore operations require the target configuration. |
| 23  | Product documented opening balances, audited revisions and pre-opening historical-only evidence; historical counts cannot be applied twice to current state.                            | Real opening balances/count basis remain required farm inputs.                                      |
| 24  | Existing current-time restrictions plus product transfer/market/release tests; cross-project input/feed preserve source restriction provenance while local feeding remains available.   | Dates/scope/authorizer come from verified recorded instructions.                                    |

## Concrete regression coverage

`test/product.test.ts` contains 16 integrated business scenarios. Assertions verify persisted outcomes and meaningful rejection paths, including concurrent approval/replay, stale schedule previews, oversubscribed shared allocations, live-animal orders versus direct sales, identified mortality, expired reservations, concurrent birth-cohort registration, acknowledgement/refund limits, privacy and bag-versus-kg pricing. The rabbit lineage regression verifies that linked births supply documented mating parents when selectors are blank, conflicting parents are rejected, and retries at the cohort cap preserve one identity and unchanged live counts. The final restriction test also holds a real project lock so two otherwise valid stock-consuming transactions overlap before they proceed.

`test/migration-upgrade.test.ts` creates a populated schema using published migrations 001–006. It preserves an existing financial expense/allocation/opening balance, private attachment bytes, treatment restriction, stock and per-unit listing. It invokes the real migration runner for 007/008, invokes it again as a no-op, and exercises the upgraded API. Published migrations remain unchanged; new refinements are additive in 008.

PDF verification uses the actual HTTP report endpoint with two currencies, a prior-period outstanding sale, a budget, input use/loss, missing prices and long Unicode names. Both Shona and Ndebele reports were rendered and inspected as two-page documents; glyphs and missing-data legends were visible. Quantities trim database padding and keep units attached with a nonbreaking space. The original private images and public metadata-free derivatives are separately tested.

## Reproduce

Use Node 24 and a disposable PostgreSQL database:

```bash
npm ci
npm run build
TEST_DATABASE_URL=postgresql://... npm test
```

`npm test` executes all backend `.test.ts` files, including upgrade, business, core, operational, object-storage and real HTTP gateway scenarios. The scratch environment verification wrapper used PostgreSQL 17.6 over TCP and left no farm data. The independent edge, browser/native, container and encrypted archive gates are recorded in `docs/status.md` and CI rather than being counted as backend results here.

No remaining code work in this business-backend scope depends on receiving a farm area, count, opening balance, medical instruction, device model or provider secret. Those values activate/configure the completed workflows and must not be invented. Production deployment, actual device commissioning, fluent language review and live provider settlement remain separate verification steps.
