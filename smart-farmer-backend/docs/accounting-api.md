# Farm accounting API

Base: `/v1/farms/:farmId/accounting`. Every endpoint, including private documents/PDFs, requires an authenticated farm owner or manager. Unauthorized farm/object access returns 404. A missing/expired bearer session returns 401. Financial mutations are online-only and require explicit review; they do not enter the field-data outbox or execute a bank/mobile-money transfer.

The authoritative DTOs are `src/accounting/types.ts`. Responses use camelCase. Lists return `{items,nextCursor}` with `limit` 1–100 (default 100) and UUID `cursor`. Every create/action body contains a stable UUID `id`; retry the same intent with the same ID and body. A changed payload, actor or farm for a used ID returns `409 idempotency_conflict`. Edits/finalization/payment actions require the currently displayed integer `version`; a stale version returns `409 version_conflict`.

## Exact amounts and dates

- `currency` is an explicitly selected supported three-letter currency. `/settings` returns supported `{code,minorUnit}` metadata. There is no automatic currency conversion or exchange-rate lookup.
- Monetary `*Minor` values are decimal integer **strings**, never JS numbers. For USD, `"1250"` means 12.50; for JPY, `"1250"` means 1,250. Use the returned `minorUnit` (0–3).
- A document's subtotal, discount and total are each bounded to `999999999999999` minor units. Drafts have 1–100 lines; description length is at most 500 characters. Invoice/journal mutation requests have a bounded 256 KiB body limit.
- Line `quantity` and `unitPrice` are nonnegative decimal strings with at most six places; quantity must be positive. Unit price is in major currency units. `discountMinor` is a nonnegative integer string. Rates are integer basis points: 1,500 means 15%.
- Prices are tax-exclusive. The server rounds each quantity × unit price to the currency unit, subtracts the line discount, rounds tax on that net amount, then sums the resulting integer amounts. Rounding is explicitly `line_half_up`. Supplied OCR totals never override calculated totals.
- Calendar dates are `YYYY-MM-DD`. Due date cannot precede issue date. Reports are grouped by currency and never add different currencies together.

## Settings

`GET /settings` → `{configured,settings:AccountingSettings|null,currencies:[{code,minorUnit}]}`.

`PUT /settings` body:

```json
{
  "id":"request-uuid", "version":0,
  "business":{"legalName":"Farm legal name","tradingName":"","address":"","email":"","phone":"","registrationNumber":"","taxNumber":""},
  "defaultCurrency":"USD", "invoicePrefix":"INV", "startingNumber":1,
  "taxRates":[{"name":"Configured rate","rateBps":1500}],
  "lockedThrough":null, "reason":"Initial accounting setup"
}
```

`version:0` creates settings. Later updates use the current version. `startingNumber` is accepted only before any sales invoice/credit number is issued; later numbering is server-managed. Empty tax-rate lists are allowed; zero tax is allowed, and nonzero line rates must be explicitly configured. This is invoice bookkeeping, not a claim of tax registration or jurisdiction-specific compliance. Issued documents retain the identity, rates and terms that were reviewed at issue time.

PUT returns the same `{configured,settings,currencies}` shape as GET. Names are at most 160 characters, address 500, email 254 (valid or empty), phone 50, registration/tax IDs 100. Prefix is 1–16 ASCII letters/digits/underscore/hyphen and must begin with a letter/digit. Starting number is 1–999999999; rates have unique names, at most 30 entries, and integer `rateBps` 0–10000. An audit reason is 3–1000 characters. Managers can explicitly reopen a locked period by changing `lockedThrough` with an audit reason; reopening never edits existing journals.

## Drafts and detail

`GET /invoices?kind=purchase|sale|purchase_credit|sale_credit&status=draft|posted|issued|void&limit=100&cursor=...` returns invoice detail DTOs in a page.

`POST /invoices` creates a draft. Body is `AccountingInvoiceDraft`:

```json
{
  "id":"invoice-uuid", "kind":"purchase", "currency":"USD",
  "party":{"name":"Supplier","address":"","email":"","phone":"","taxNumber":""},
  "reference":"SUP-100", "issueDate":"2026-11-05", "dueDate":"2026-12-05",
  "notes":"", "terms":"", "documentId":null, "sourceEntryId":null,
  "lines":[{"id":"line-uuid","description":"Feed","quantity":"2","unitPrice":"12.50","discountMinor":"0","taxRateBps":0,"accountCode":"5000","projectId":null}]
}
```

`party` is the supplier for a purchase bill and the customer for a sales invoice. A linked `documentId` is private same-farm evidence. `sourceEntryId` optionally identifies an already recorded same-farm expense/revenue, preventing a second operational entry when the invoice is finalized. Account `5000` is the default expense account; `4000` is the default sales account. User-selected accounts must have the correct income/expense type. Optional `projectId` must belong to the farm.

Linking requires the original source's exact amount/currency and project attribution, including active historical expense allocations. `postingDate` in new snapshots preserves the source's farm-local recognition date; `issueDate` remains the actual document date supplied by the user. For a new invoice, both dates are equal. This permits a later invoice for an existing sale without moving the original sale between accounting periods. Source picker attribution must be reviewed; a mismatch returns `source_project_mismatch`.

`GET /invoices/:invoiceId` → `AccountingInvoiceDetail`. The top-level fields contain the current draft or immutable finalized data. `preview` always contains the calculated PDF DTO; `snapshot` is null for drafts and immutable after posting/issuing. Payments, credits, outstanding amounts and audit history are outside that immutable snapshot.

`PATCH /invoices/:invoiceId` replaces draft review fields. Body is the draft body without `kind`, with `id` as a new **request** UUID and `version`. The path identifies the invoice. Draft edits cannot change kind. Finalized documents cannot be edited in place.

## Review and finalization

- Purchase: `POST /invoices/:invoiceId/post`.
- Sale: `POST /invoices/:invoiceId/issue`.

Both bodies are `{id,version,confirmed:true,reviewed:true,duplicateOverrideReason?:string}`. Explicit reviewed fields are required even if OCR supplied suggestions. Attached documents must be `ready` or `failed`; a failed extraction still preserves the original for manual review and entry. Queued/processing documents cannot yet be posted. Purchase bills require a supplier reference. Exact reused document/source links are blocked; a matching normalized supplier/reference produces a duplicate warning and requires an explicit reason before an intentional exception. GET detail returns `duplicateCandidates` for review.

Posting/issuing atomically saves the immutable snapshot, balanced journal and one operational finance effect, or adopts the specified existing source without recording it twice. Sales invoice/credit numbering is allocated transactionally from the farm settings row; issued/voided numbers are retained and never recycled. A draft has no issued number.

Previously recorded cash is imported with `origin:"legacy"` and its original payment date; it is not added to operational cash a second time. Cash before recognition is posted to supplier advances (1500) or customer advances (2200), then applied to payables/receivables at recognition. Imported refunds remain negative records. Closed historical periods must be explicitly reopened before importing postings into them.

## Payments and corrections

`POST /invoices/:invoiceId/payments`:

```json
{"id":"payment-uuid","version":2,"amountMinor":"1250","currency":"USD","paidOn":"2026-11-05","method":"bank","reference":"Statement reference","note":"Recorded by owner","confirmed":true}
```

Methods: `cash`, `bank`, `mobile_money`, `other`. Amount must be positive, currency must match and the payment cannot exceed the locked outstanding balance. This records an explicitly confirmed manual receipt/payment; it does not claim provider verification. Response is updated `AccountingInvoiceDetail`. Duplicate retries return the original response without another payment.

Payment dates cannot precede recognition. Backdated payment/reversal/credit actions are checked against **every** affected effective-date boundary, including later existing transactions. An action that would make historical paid cash negative or over-settle an invoice returns `posting_balance_conflict` with the conflicting date. Checking only the present balance would permit an incorrect historical report after a later refund, so the full timeline remains authoritative.

`POST /invoices/:invoiceId/payments/:paymentId/reverse` body `{id,version,reason,paidOn,confirmed:true}` records an audited compensating payment and journal; the original record remains visible. Already reversed payments cannot be reversed again. Imported legacy payment provenance is preserved.

`POST /invoices/:invoiceId/void` body `{id,version,reason,confirmed:true}` returns the updated invoice. An unposted draft can be discarded into `void` with retained history and no number, snapshot, journal or finance effect. An unpaid finalized document with no credits can be voided with a reversing journal; its number/snapshot remain. A linked operational source is not silently voided: use a credit/correction against that source.

`POST /invoices/:invoiceId/credits` body `{id,version,amountMinor,issueDate,reason,confirmed:true}` creates and finalizes a linked credit document, capped at the remaining unpaid amount, and returns the NEW credit's `AccountingInvoiceDetail`. Refresh the parent to see its reduced balance. It reduces the obligation with a compensating journal and operational finance effect. To correct a paid amount, first record the appropriate payment reversal/refund, then credit it. This does not change physical stock or perform a real payment transfer.

Credit snapshots use `rounding:"credit_proportional"`. Requested gross credit is applied in original line order. For each original line, cumulative credited tax is the half-up proportion of original tax to original total; each new credit records the difference from prior credits. This preserves original line IDs/rates and guarantees that repeated tiny credits never exceed the original net/tax and that a full credit reverses both exactly. A corrective credit retains the original immutable issuer identity, even after settings change, and records the current review/date/reason. Credit `reference` contains the original issued number or supplier reference. Regular invoice snapshots use `line_half_up`.

Payment status is derived: `unpaid|partial|paid`. `paidMinor` is net recorded payments, `creditedMinor` is finalized credits, and `balanceMinor` is total minus those amounts (zero for voided documents). Drafts do not create obligations.

## Reports, ledger and historical records

`GET /summary?from=YYYY-MM-DD&to=YYYY-MM-DD&asOf=YYYY-MM-DD` → `AccountingSummary`. From/to filter posting flows inclusively; asOf controls unpaid/overdue balances. `byCurrency` contains exact sales, expense, tax, cash, receivable/payable and overdue totals. `scope:"accounting_postings"` and `unlinkedLegacyEntries` disclose historical records not yet classified into the new books.

`GET /reports?from=...&to=...&asOf=...` returns `AccountingReports`: `{summary,trialBalance,profitLoss,balanceSheet,aging}`. Trial-balance rows contain `{currency,minorUnit,accounts:[{code,name,type,debitMinor,creditMinor,balanceMinor}],totalDebitMinor,totalCreditMinor}`. Profit/loss rows contain `{currency,minorUnit,incomeMinor,expenseMinor,resultMinor}`. Balance-sheet rows contain `{currency,minorUnit,assetsMinor,liabilitiesMinor,equityMinor}`, with retained cumulative income minus expenses included in equity. Aging rows contain `{kind,currency,minorUnit,currentMinor,days1To30Minor,days31To60Minor,days61To90Minor,over90Minor}`. Flows use inclusive from/to; trial balance, balance sheet and aging use asOf. No statutory filing or complete historical profit claim is implied. Existing operational records remain available and can be explicitly linked/reviewed; a linked source cannot be settled twice through old and new receipt endpoints.

`GET /ledger?from=...&to=...&asOf=...&currency=...&limit=100&cursor=...` returns `AccountingJournal` entries with `{id,currency,minorUnit,postedOn,description,reason,sourceType,sourceId,reversalOf,reversedBy,lines:[{accountCode,debitMinor,creditMinor,description,projectId}]}`. `asOf` defaults to farm-local today; the inclusive upper bound is the earlier of to/asOf. `GET /ledger.csv` exports the same authenticated data with CSV formula escaping. `GET /invoices.csv` exports invoice totals, paid/credited amounts and void/balance status historically as of the requested date, with explicit currency/minor-unit columns. Exports are bounded; an oversized export returns `export_too_large` so dates can be narrowed rather than silently truncating records.

`GET /accounts` → `{items:[{code,name,type,system,active}]}`. Types are `asset|liability|equity|income|expense`.

System codes: 1000 cash, 1010 bank, 1020 mobile money, 1030 other cash, 1100 receivables, 1200 tax adjustments (asset; manual only), 1300 inventory, 1400 equipment, 1500 supplier advances, 2000 payables, 2100 tax collected, 2200 customer advances, 3000 opening equity, 4000 sales, 5000 expenses, 5100 tax on purchases. Purchase tax is recorded as an expense, not automatically claimed recoverable. Any justified reclassification requires an explicit balanced journal.

`GET /sources?kind=purchase|sale&limit=100&cursor=...` → `{items:[{id,description,reference,postedOn,amountMinor,originalAmount,currency,minorUnit,sourceType,sourceId,alreadyInvoiced,invoiceId,eligible,eligibilityError,projects:[{projectId,amountMinor,originalAmount}]}],nextCursor}`. These are positive unreversed legacy expenses/revenue, excluding accounting effects and corrections. Already-invoiced sources are marked and cannot be linked again. Reference may be empty where historical records never captured it. `amountMinor` is a string or null; `originalAmount` preserves the original decimal value. A historical value incompatible with the currency precision (for example fractional JPY) remains visible as `eligible:false,eligibilityError:"source_currency_precision"`; no rounding repairs it silently. Project amounts follow the same string/null rule.

Legacy expense and project-ledger rows expose `accountingManaged` and `accountingInvoiceId`; managed sources must be corrected/settled in accounting. Legacy allocation/correction paths cannot alter these sources or send a three-decimal invoice into cent-only tables. Service receipt summaries expose the same marker for the current farm. Market seller rows expose it only to an authorized seller, with `accountingFarmId` for correct multi-farm navigation and current `accountingOutstanding`/`accountingCredited` major-unit strings; buyers do not receive the seller's private bookkeeping identifiers or adjustments.

Combined legacy project reports preserve exact invoice line attribution. Their `projectReceivables` metadata is `{scope:"attributed_invoice_balance",signed:true,settlement:"invoice_only"}`: project amounts are attributed shares of one farm invoice, not separate customer debts. Credits target original lines and cash is allocated cumulatively; a project can therefore carry a credit share while another carries a debit share. Signed shares reconcile to the farm obligation and are not clamped or settled independently.

`POST /accounts` body `{id,code,name,type}` creates a farm-specific account. System control accounts are reserved.

`POST /journals` body `{id,currency,postedOn,description,reason,confirmed:true,lines:[{accountCode,debitMinor,creditMinor,description,projectId?}]}` records a reviewed balanced manual/opening journal. Each line has exactly one positive side; totals must match in one currency. `POST /journals/:journalId/reverse` body `{id,postedOn,reason,confirmed:true}` appends a reversal only for an unreversed `sourceType:"manual"` journal. Invoice/payment/credit/void/advance journals are managed by their invoice lifecycle and cannot be reversed through the generic route. Posted journals cannot be edited/deleted, and a committed journal cannot receive additional lines. Posting in a locked accounting period is rejected.

## Document/OCR and PDF integration

The separate `/documents` routes own bounded private upload, queued OCR, status/preview/retry and authenticated download. Their document IDs can be attached to purchase drafts. OCR is a suggestion source and cannot post a bill, alter an issued snapshot or authorize payment.

Private `GET /invoices/:invoiceId/preview.pdf` renders a visibly marked draft preview. Private `GET /invoices/:invoiceId/pdf` renders the immutable finalized snapshot (and a void marker if applicable). Neither endpoint emails/sends invoices.

Backend PDF integration uses exported `getInvoiceDetail(ctx, req, reply)` from `src/accounting/routes.ts`, which performs the same owner/manager authorization and returns `AccountingInvoiceDetail|null` (null means an authentication response was already sent).

## Errors and audit

Errors use `{error:string,details?:object}` (validation errors use a details array). Relevant codes include `version_conflict`, `idempotency_conflict`, `accounting_unconfigured`, `unsupported_currency`, `tax_rate_unconfigured`, `invalid_amount`, `discount_exceeds_line`, `invoice_not_draft`, `invoice_not_finalized`, `document_not_ready`, `duplicate_invoice`, `source_already_invoiced`, `source_mismatch`, `source_project_mismatch`, `payment_exceeds_balance`, `posting_balance_conflict`, `currency_mismatch`, `invoice_has_payments`, `invoice_has_credits`, `linked_source_requires_credit`, `payment_already_reversed`, `period_locked`, `unbalanced_journal`, `journal_managed_source` and `invoice_managed_source`. Duplicate/version conflicts carry `{details:{candidates}}`/`{details:{currentVersion}}`. Every finalized change records actor, date, reason, source and immutable audit history; deleting history is not an API operation.
