# Farmer accounting

Farmer owners and managers can record supplier bills, issue sales invoices, record manual payments and keep balanced books by currency. The web and mobile accounting screens use the same API and calculation rules. This is bookkeeping and document issuance; recording a payment does not move money or assert that a bank or mobile-money provider has verified it.

## Set up the farm's books

Open Accounting and enter the farm's business details, default currency, invoice prefix and starting number. Enter only tax rates that apply to the business. The farm's legal identity and tax registration are not inferred from its display name. Zero tax is an explicit selection; there is no assumed tax jurisdiction, conversion rate or recoverable purchase tax.

Settings changes apply to future documents. Issued invoices retain the reviewed business identity, customer details, prices, tax, terms and number from their issue time. Numbers are assigned when a sales invoice or credit is issued, not when a draft is saved. Voiding a document never recycles its number.

## Scan a supplier invoice

1. Take a photo, choose an image, or select a PDF. Accepted types are JPEG, PNG, WebP and PDF, up to 5 MiB per file and 6 PDF pages. Keep the whole page in frame, with legible text and even lighting.
2. Upload the source and start extraction. A worker processes the private file; the screen shows queued, processing, ready or failed status. Closing the screen does not discard the source. Owners and managers can resume the document from another device.
3. Review the original and the extracted text. Correct the supplier, reference, dates, currency, quantities, prices, discounts and tax. OCR confidence describes recognition quality, not the correctness of an amount. Ambiguous dates and currency symbols are left unselected.
4. Save a draft and review the server-calculated totals. If extraction fails, download the original and enter the bill manually. The attachment remains linked to the reviewed bill.
5. Confirm review and post the bill. This creates the payable and balanced journal. Scanning or saving a draft does not create an expense, payable or payment.

The scanner uses local Tesseract with English trained data; it does not send documents to an external OCR or AI provider. Other-language layouts, handwriting, rotated or poor-quality photos, tax-inclusive price layouts and complex tables may need manual entry. Extracted line items and printed totals are suggestions; the posting calculation never trusts an OCR total in place of the reviewed lines.

Identical file uploads return the existing private document. Posting the same source twice is blocked. A matching normalized supplier/reference warns about a possible duplicate; an intentional supplier-reference exception requires a recorded reason.

## Issue an invoice for a sale

Create a sales draft with the customer, date, due date, currency and items sold. Quantities and unit prices support up to six decimal places. Prices are tax-exclusive; discounts are entered as exact currency amounts and tax is selected from configured rates.

Review the draft and its PDF, then explicitly issue it. Issuance atomically allocates the next number, fixes the document snapshot, records revenue and creates the receivable. The private PDF can be downloaded, printed or shared using the device's normal share flow. Issuing an invoice does not automatically email the customer.

An existing recorded sale or expense can be linked when creating the invoice. The backend verifies the farm, kind, currency, amount and project allocation, adopts its provenance and existing receipts, and avoids a second operational income/expense entry. The original recognition date remains the accounting posting date even when the invoice is issued later. Earlier receipts/payments are recorded as customer/supplier advances and applied at recognition, preserving their actual dates. Invoice-managed sources use the accounting payment/correction flow thereafter.

The source picker shows historical amounts exactly. If an old record has more precision than its currency supports, it is marked ineligible for linking; the amount is not silently rounded. Review and correct that historical record through its audited workflow first.

## Payments and corrections

Record a full or partial payment with its date, method and reference. The screen shows paid, credited and outstanding amounts. Payments cannot exceed the outstanding balance or use a different currency. These are manually confirmed records; no bank transfer is initiated.

Issued documents are not edited in place. Use an explained void for an eligible unpaid invoice, a linked credit for a reduction, or a payment reversal to correct an erroneous payment. The original record, number, journal and audit trail remain. Correcting a paid amount may require recording the appropriate payment reversal/refund before a credit; the system does not perform that refund itself. Credits use the original line order and allocate the original net/tax amounts proportionally, including cumulative rounding for repeated small credits. Credits do not silently change physical stock. Backdated changes are checked against every affected historical balance, so a later reversal cannot be used to overpay or overcredit an earlier date.

If a response is lost, retry the same pending action. Its stable request identifier prevents a second invoice, payment or journal. Web and mobile retain the exact pending request in their encrypted local storage across restarts; it is retried only by an explicit action. Refresh and reconcile the current document before making a different financial change.

## Books, reports and historical records

Accounting reports separate sales, expenses, tax, cash movement, receivables, payables and overdue balances by currency. The ledger records balanced debit and credit amounts using exact integer minor units. Accounts, balanced opening/manual journals, reversals and period locks support reviewable bookkeeping adjustments. CSV exports include explicit currency/precision and escape spreadsheet formulas in entered text. The selected as-of date controls ledger and invoice exports: later payments, credits and voids do not rewrite an earlier balance. Invoice exports select documents by their issue date; the ledger follows their accounting posting date.

Project reports preserve the project attribution of each invoice line and credit. Partial payments are apportioned by cumulative invoice-line amounts so repeated tiny payments still add up exactly. A project's attributed balance can be a credit or debit even when the whole invoice is settled; these signed shares add to the invoice balance. Record collection or payment on the linked invoice, not on an individual project's attributed share.

Historical operational records are not automatically turned into invented opening books. Reports disclose unlinked legacy entries; these remain visible in the existing financial reports and can be reviewed and linked. Report scope and recording completeness matter when interpreting a margin or balance. Aging follows invoice obligations; standalone manual receivable/payable adjustments appear in the trial balance and balance sheet and need reconciliation against the invoices. Purchase tax initially goes to a separate expense account; any justified reclassification uses a reviewed journal.

## Privacy, offline use and recovery

Financial records, originals and PDFs are restricted to the farm's owner/manager roles. Downloads require authentication and carry no-store and sandbox headers. Invoice scans share the farm's existing field-media quota. Financial originals are excluded from ordinary media retention cleanup while referenced and are included in encrypted backups and verified object-storage restores.

Mobile scan sources and editable drafts use the existing encrypted local repository. Upload/extraction is explicit. Posting, issuing, paying, crediting and reversing are online actions; they do not enter the offline field-event outbox. Local attachment limits remain 5 MiB per file and 50 MiB per account.

The worker claims one document with a lease, runs bounded local extraction, and commits only if it still owns that lease. A worker interruption can be recovered without posting any accounting entry. Extraction has a 90-second overall command budget, a 20-second per-command timeout, a 24-megapixel input limit, bounded text output and at most 3 attempts. Temporary processing files are removed after each attempt. A failed scan remains available for manual review.

## Verification and deployment

Apply migration 011 before enabling the updated API and worker. It adds the accounting tables and widens the operational amount column to three decimal places so supported currencies retain their precision. The readiness endpoint checks the accounting schema. Keep the API, worker and backup tooling on the same reviewed revision.

Backend tests require a disposable PostgreSQL 17 database and the installed OCR/Poppler commands. `npm test` includes actual image OCR, text/raster PDF extraction, document access/duplicate/lease/quota/retention tests, exact invoice arithmetic, posting/payment lifecycle and existing workflows. `npm run test:backup` restores source documents and posted accounting records into an isolated empty target and checks their hashes, balances and journal equality. The web and mobile packages retain independent build and acceptance commands.

See [the API contract](accounting-api.md) for DTOs, request identifiers, mutation versions, calculation rules, reports and errors. See [operations](operations.md) for deployment and encrypted backup procedures.
