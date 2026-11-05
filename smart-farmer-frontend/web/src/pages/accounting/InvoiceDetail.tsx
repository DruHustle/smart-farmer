import {useId, type InputHTMLAttributes} from 'react';
import {useFarm} from '../../context';
import {amountToMinor, invoiceMoney} from '../../lib/accounting';
import {useResource} from '../../lib/resources';
import {displayDate, displayTime} from '../../lib/time';
import {downloadPrivate, ResourceState} from '../../components/completion';
import {Badge, Empty, ExpandForm, Field, Icon, Section, formValue} from '../../components/ui';
import {AccountingForm} from './AccountingForm';
import type {AccountingInvoiceDetail, AccountingInvoiceSnapshot, AccountingPayment, InvoiceDocument, InvoiceStatus} from './types';

export function InvoiceStatusBadge({status}: {status: InvoiceStatus}) {
  const {t} = useFarm();
  const titles = {draft: t.invoiceDraft, posted: t.invoicePosted, issued: t.invoiceIssued, void: t.invoiceCancelled};
  return <Badge value={titles[status]} tone={status === 'void' ? 'danger' : status === 'draft' ? undefined : 'success'}/>;
}

export function PaymentStatusBadge({status}: {status: AccountingInvoiceDetail['paymentStatus']}) {
  const {t} = useFarm();
  return <Badge value={{unpaid: t.invoiceUnpaid, partial: t.invoicePartial, paid: t.invoiceSettled}[status]} tone={status === 'paid' ? 'success' : undefined}/>;
}

export function InvoiceDetail({invoiceId, onBack, onEdit, onOpen}: {invoiceId: string; onBack: () => void; onEdit: (invoice: AccountingInvoiceDetail) => void; onOpen: (invoiceId: string) => void}) {
  const {farm, t, lang, online, run, notify, snapshot} = useFarm();
  const path = `/v1/farms/${farm.id}/accounting/invoices/${invoiceId}`;
  const resource = useResource<AccountingInvoiceDetail | null>(path, null);
  const invoice = resource.value;
  async function accepted(value: AccountingInvoiceDetail) {
    resource.setValue(value);
    try {await resource.reload();} catch {notify(t.limitedSync);}
  }
  if (!invoice) return <Section title={t.accounting}><ResourceState {...resource}/><button type="button" className="text-button" onClick={onBack}>{t.invoiceBackToList}</button>{!resource.loading && <Empty title={t.noData}/>}</Section>;
  const purchase = invoice.kind.startsWith('purchase');
  const isCredit = invoice.kind.endsWith('_credit');
  const finalized = invoice.status === 'posted' || invoice.status === 'issued';
  const money = (value: string) => invoiceMoney(value, invoice.currency, invoice.minorUnit, lang);
  const finalizedDuplicates = invoice.duplicateCandidates.filter(item => item.status === 'posted' || item.status === 'issued');
  const hardDuplicate = finalizedDuplicates.some(item => item.reason === 'document' || item.reason === 'source_entry');
  const needsOverride = finalizedDuplicates.some(item => item.reason === 'supplier_reference');
  return <div className="invoice-detail">
    <div className="button-row invoice-detail-navigation"><button type="button" className="text-button" onClick={onBack}><Icon name="back"/>{t.invoiceBackToList}</button><button type="button" className="text-button" disabled={!online || resource.loading} onClick={() => void run(resource.reload)}><Icon name="sync"/>{t.invoiceReload}</button></div>
    <ResourceState {...resource}/>
    <Section title={invoice.number || invoice.reference || invoice.party.name}>
      <div className="invoice-status-row"><InvoiceStatusBadge status={invoice.status}/>{finalized && !isCredit && <PaymentStatusBadge status={invoice.paymentStatus}/>}</div>
      {invoice.status !== 'draft' && <dl className="facts-grid invoice-balance-facts"><div><dt>{t.invoiceTotal}</dt><dd>{money(invoice.totals.totalMinor)}</dd></div><div><dt>{t.invoicePaid}</dt><dd>{money(invoice.paidMinor)}</dd></div><div><dt>{t.invoiceCredited}</dt><dd>{money(invoice.creditedMinor)}</dd></div><div><dt>{t.invoiceBalance}</dt><dd>{money(invoice.balanceMinor)}</dd></div></dl>}
      <div className="button-row">
        {invoice.status === 'draft' && <button type="button" className="secondary" disabled={!online} onClick={() => onEdit(invoice)}>{t.editInvoiceDraft}</button>}
        {(invoice.status === 'draft' || invoice.snapshot) && <button type="button" className="secondary" disabled={!online} onClick={() => void run(() => downloadPrivate(`${path}/${invoice.status === 'draft' ? 'preview.pdf' : 'pdf'}?language=${lang}`, snapshot.identity.token, `${invoice.status === 'draft' ? 'draft-' : ''}${invoice.number || invoice.reference || 'invoice'}.pdf`))}>{invoice.status === 'draft' ? t.invoicePreviewDownload : t.invoiceDownload}</button>}
        {(invoice.status === 'draft' || invoice.snapshot) && <button type="button" className="text-button" disabled={!online || resource.loading} onClick={() => void run(async () => {await resource.reload(); requestAnimationFrame(() => window.print());})}>{t.invoicePrint}</button>}
      </div>
      {invoice.documentId && <SourceDownload documentId={invoice.documentId}/>}
      <p className="muted small">{invoice.status === 'draft' ? t.invoicePreviewHint : t.invoicePrintHint}</p>
    </Section>
    <InvoicePaper invoice={invoice.snapshot ?? invoice.preview} status={invoice.status}/>
    {invoice.status === 'draft' && <Section title={purchase ? t.postSupplierInvoice : t.issueSalesInvoice}>
      <p>{t.invoiceIssueHint}</p>
      {invoice.duplicateCandidates.length > 0 && <div className="notice"><p>{t.invoiceDuplicate}</p><ul>{invoice.duplicateCandidates.map(candidate => <li key={candidate.id}><button type="button" className="text-button" onClick={() => onOpen(candidate.id)}>{candidate.number || candidate.reference || candidate.partyName}</button> · {candidate.partyName} · {candidate.currency} · <InvoiceStatusBadge status={candidate.status}/></li>)}</ul>{hardDuplicate && <p>{t.source_already_invoiced}</p>}</div>}
      <AccountingForm<AccountingInvoiceDetail> key={`finalize-${invoice.version}`} path={`${path}/${purchase ? 'post' : 'issue'}`} title={purchase ? t.postSupplierInvoice : t.issueSalesInvoice} disabled={hardDuplicate} onResult={accepted} build={(form, id) => ({id, version: invoice.version, confirmed: true, reviewed: form.has('reviewed'), ...(needsOverride ? {duplicateOverrideReason: formValue(form, 'duplicateOverrideReason')} : {})})}>
        {needsOverride && !hardDuplicate && <Field label={t.invoiceDuplicateReason}><textarea name="duplicateOverrideReason" required minLength={3} maxLength={1000}/></Field>}
        <label className="check-label"><input type="checkbox" name="reviewed" required/>{t.invoiceReviewed}</label>
      </AccountingForm>
    </Section>}
    {(finalized || invoice.status === 'void') && !isCredit && <>
      <Section title={t.invoicePayments}>
        <p className="notice subtle">{t.invoicePaymentHint}</p>
        {finalized && BigInt(invoice.balanceMinor) > 0n ? <ExpandForm title={t.recordInvoicePayment}>
          <AccountingForm<AccountingInvoiceDetail> key={`pay-${invoice.version}`} path={`${path}/payments`} title={t.recordInvoicePayment} onResult={accepted} build={(form, id) => {
            const amountMinor = amountToMinor(formValue(form, 'amount'), invoice.minorUnit);
            if (BigInt(amountMinor) <= 0n) throw new Error('invalid_amount');
            if (BigInt(amountMinor) > BigInt(invoice.balanceMinor)) throw new Error('payment_exceeds_balance');
            return {id, version: invoice.version, amountMinor, currency: invoice.currency, paidOn: formValue(form, 'paidOn'), method: formValue(form, 'method'), reference: formValue(form, 'paymentReference'), note: formValue(form, 'paymentNote'), confirmed: form.has('confirmed')};
          }}>
            <Field label={`${t.amount} · ${invoice.currency}`} hint={`${t.invoiceBalance}: ${money(invoice.balanceMinor)}`}><MoneyInput name="amount" scale={invoice.minorUnit}/></Field>
            <Field label={t.invoicePaymentDate}><input name="paidOn" type="date" required/></Field>
            <Field label={t.invoicePaymentMethod}><select name="method" required defaultValue=""><option value="">{t.select}</option><option value="cash">{t.invoicePaymentCash}</option><option value="bank">{t.invoicePaymentBank}</option><option value="mobile_money">{t.invoicePaymentMobile}</option><option value="other">{t.other}</option></select></Field>
            <Field label={t.paymentReference}><input name="paymentReference" maxLength={100}/></Field>
            <Field label={t.note}><textarea name="paymentNote" maxLength={1000}/></Field>
            <label className="check-label"><input name="confirmed" type="checkbox" required/>{t.invoicePaymentConfirmed}</label>
          </AccountingForm>
        </ExpandForm> : <p>{t.accountingZeroBalance}</p>}
        {invoice.payments.length === 0 && <p className="muted">{t.noData}</p>}
        {invoice.payments.map(payment => <PaymentRecord key={payment.id} invoice={invoice} payment={payment} accepted={accepted}/>)}
      </Section>
      <Section title={t.invoiceCreditNotes}>
        {invoice.credits.map(credit => <article className="record-card" key={credit.id}><button type="button" className="text-button" onClick={() => onOpen(credit.id)}>{credit.number || t.invoiceCredit}</button><p>{money(credit.totalMinor)}</p><InvoiceStatusBadge status={credit.status}/></article>)}
        {finalized && BigInt(invoice.balanceMinor) > 0n && <ExpandForm title={t.invoiceCredit}>
          <p>{t.invoiceCreditHint}</p>
          <AccountingForm<AccountingInvoiceDetail> key={`credit-${invoice.version}`} path={`${path}/credits`} title={t.invoiceCredit} onResult={async value => {await resource.reload().catch(() => notify(t.limitedSync)); if (value.id !== invoice.id) onOpen(value.id); else resource.setValue(value);}} build={(form, id) => ({id, version: invoice.version, amountMinor: amountToMinor(formValue(form, 'creditAmount'), invoice.minorUnit), issueDate: formValue(form, 'creditDate'), reason: formValue(form, 'creditReason'), confirmed: form.has('confirmed')})}>
            <Field label={`${t.amount} · ${invoice.currency}`} hint={`${t.invoiceBalance}: ${money(invoice.balanceMinor)}`}><MoneyInput name="creditAmount" scale={invoice.minorUnit}/></Field>
            <Field label={t.invoiceIssueDate}><input name="creditDate" type="date" required/></Field>
            <Field label={t.reason}><textarea name="creditReason" required minLength={3} maxLength={1000}/></Field>
            <label className="check-label"><input name="confirmed" type="checkbox" required/>{t.confirm}</label>
          </AccountingForm>
        </ExpandForm>}
      </Section>
    </>}
    {(finalized || invoice.status === 'draft') && !isCredit && <Section title={t.invoiceCancel}>
      <p>{t.invoiceCancelHint}</p>
      {finalized && invoice.sourceEntryId ? <p className="notice subtle">{t.linked_source_requires_credit}</p> : BigInt(invoice.paidMinor) !== 0n ? <p className="notice subtle">{t.invoice_has_payments}</p> : invoice.credits.length ? <p className="notice subtle">{t.invoice_has_credits}</p> : <ExpandForm title={t.invoiceCancel}>
        <AccountingForm<AccountingInvoiceDetail> key={`void-${invoice.version}`} path={`${path}/void`} title={t.invoiceCancel} onResult={accepted} build={(form, id) => ({id, version: invoice.version, reason: formValue(form, 'voidReason'), confirmed: form.has('confirmed')})}>
          <Field label={t.reason}><textarea name="voidReason" required minLength={3} maxLength={1000}/></Field>
          <label className="check-label"><input name="confirmed" type="checkbox" required/>{t.invoiceCancelConfirmed}</label>
        </AccountingForm>
      </ExpandForm>}
    </Section>}
    <Section title={t.invoiceHistory}>
      <p className="small">{t.invoiceVersion}: {invoice.version}</p>
      {invoice.history.map(item => <article className="record-card" key={item.id}><h3>{historyTitle(t, item.action)}</h3><p>{displayTime(item.at, lang, farm.timezone)}</p>{item.reason && <p className="preserve-lines">{item.reason}</p>}</article>)}
    </Section>
  </div>;
}

function MoneyInput({name, scale, ...attributes}: {name: string; scale: number} & InputHTMLAttributes<HTMLInputElement>) {
  return <input {...attributes} name={name} type="text" inputMode="decimal" pattern={scale ? `[0-9]+([.][0-9]{1,${scale}})?` : '[0-9]+'} required maxLength={30}/>;
}

function SourceDownload({documentId}: {documentId: string}) {
  const {farm, online, run, snapshot, t} = useFarm();
  const path = `/v1/farms/${farm.id}/accounting/documents/${documentId}`;
  const source = useResource<{document: InvoiceDocument | null}>(path, {document: null});
  return <div className="invoice-source"><ResourceState {...source}/><button type="button" className="text-button" disabled={!online || !source.value.document} onClick={() => void run(() => downloadPrivate(`${path}/content`, snapshot.identity.token, source.value.document?.filename || 'supplier-document'))}>{t.sourceDocument}{source.value.document ? ` · ${source.value.document.filename}` : ''}</button></div>;
}

function PaymentRecord({invoice, payment, accepted}: {invoice: AccountingInvoiceDetail; payment: AccountingPayment; accepted: (value: AccountingInvoiceDetail) => Promise<void>}) {
  const {farm, t, lang} = useFarm();
  const method = {cash: t.invoicePaymentCash, bank: t.invoicePaymentBank, mobile_money: t.invoicePaymentMobile, other: t.other};
  return <article className="record-card invoice-payment">
    <h3>{invoiceMoney(payment.amountMinor, payment.currency, invoice.minorUnit, lang)}</h3>
    <p>{displayDate(payment.paidOn, lang)} · {method[payment.method]}</p>
    {payment.reference && <p>{t.paymentReference}: {payment.reference}</p>}{payment.note && <p>{payment.note}</p>}
    {(payment.reversedBy || payment.reversalOf) && <Badge value={t.invoiceReversed}/>}
    {invoice.status !== 'void' && !payment.reversedBy && !payment.reversalOf && <ExpandForm title={t.invoiceCorrection}>
      <p>{t.invoiceCorrectionHint}</p>
      <AccountingForm<AccountingInvoiceDetail> key={`reverse-${invoice.version}`} path={`/v1/farms/${farm.id}/accounting/invoices/${invoice.id}/payments/${payment.id}/reverse`} title={t.invoiceCorrection} onResult={accepted} build={(form, id) => ({id, version: invoice.version, reason: formValue(form, 'reverseReason'), paidOn: formValue(form, 'reverseDate'), confirmed: form.has('confirmed')})}>
        <Field label={t.invoicePaymentDate}><input name="reverseDate" type="date" required/></Field>
        <Field label={t.reason}><textarea name="reverseReason" required minLength={3} maxLength={1000}/></Field>
        <label className="check-label"><input name="confirmed" type="checkbox" required/>{t.confirm}</label>
      </AccountingForm>
    </ExpandForm>}
  </article>;
}

export function InvoicePaper({invoice, status}: {invoice: AccountingInvoiceSnapshot; status: InvoiceStatus}) {
  const {t, lang} = useFarm();
  const scrollHintId = useId();
  const money = (value: string) => invoiceMoney(value, invoice.currency, invoice.minorUnit, lang);
  const purchase = invoice.kind.startsWith('purchase');
  const proportional = invoice.rounding === 'credit_proportional';
  return <article className="invoice-paper" aria-label={t.invoicePreview}>
    <header className="invoice-paper-heading"><div><p className="eyebrow">{invoice.kind.endsWith('_credit') ? t.invoiceCredit : purchase ? t.supplierInvoices : t.salesInvoices}</p><h2>{invoice.number || invoice.reference || t.invoiceDraft}</h2></div><InvoiceStatusBadge status={status}/></header>
    <div className="invoice-parties">
      <section><h3>{purchase ? t.farm : t.invoiceSeller}</h3><strong>{invoice.issuer.legalName}</strong>{invoice.issuer.tradingName && <p>{invoice.issuer.tradingName}</p>}{invoice.issuer.address && <p className="preserve-lines">{invoice.issuer.address}</p>}{invoice.issuer.email && <p>{invoice.issuer.email}</p>}{invoice.issuer.phone && <p>{invoice.issuer.phone}</p>}{invoice.issuer.registrationNumber && <p>{t.accountingRegistration}: {invoice.issuer.registrationNumber}</p>}{invoice.issuer.taxNumber && <p>{t.invoiceTaxId}: {invoice.issuer.taxNumber}</p>}</section>
      <section><h3>{purchase ? t.invoiceSupplier : t.invoiceCustomer}</h3><strong>{invoice.party.name}</strong>{invoice.party.address && <p className="preserve-lines">{invoice.party.address}</p>}{invoice.party.email && <p>{invoice.party.email}</p>}{invoice.party.phone && <p>{invoice.party.phone}</p>}{invoice.party.taxNumber && <p>{t.invoiceTaxId}: {invoice.party.taxNumber}</p>}</section>
    </div>
    <dl className="facts-grid"><div><dt>{t.invoiceIssueDate}</dt><dd>{displayDate(invoice.issueDate, lang)}</dd></div><div><dt>{t.invoiceDueDate}</dt><dd>{invoice.dueDate ? displayDate(invoice.dueDate, lang) : '—'}</dd></div>{invoice.postingDate && invoice.postingDate !== invoice.issueDate && <div><dt>{t.accountingJournalDate}</dt><dd>{displayDate(invoice.postingDate, lang)}</dd></div>}{invoice.reference && <div><dt>{purchase ? t.invoiceReference : t.invoiceCustomerReference}</dt><dd>{invoice.reference}</dd></div>}<div><dt>{t.currency}</dt><dd>{invoice.currency}</dd></div></dl>
    <p id={scrollHintId} className="invoice-scroll-hint muted small">{t.invoiceScrollHint}</p>
    <div className="table-scroll" role="region" aria-label={t.invoiceLineItems} aria-describedby={scrollHintId} tabIndex={0}><table><caption>{t.invoiceLineItems}</caption><thead><tr><th scope="col">{t.description}</th>{proportional ? <th scope="col">{t.invoiceCreditNet}</th> : <><th scope="col">{t.quantity}</th><th scope="col">{t.invoiceUnitPrice}</th><th scope="col">{t.invoiceDiscount}</th></>}<th scope="col">{proportional ? t.invoiceOriginalTax : t.invoiceTaxRate}</th><th scope="col">{t.invoiceTaxTotal}</th><th scope="col">{t.invoiceTotal}</th></tr></thead><tbody>{invoice.lines.map(line => <tr key={line.id}><td>{line.description}</td>{proportional ? <td>{money(line.netMinor)}</td> : <><td>{line.quantity}</td><td>{invoice.currency} {line.unitPrice}</td><td>{money(line.discountMinor)}</td></>}<td>{line.taxRateBps / 100}%</td><td>{money(line.taxMinor)}</td><td>{money(line.totalMinor)}</td></tr>)}</tbody></table></div>
    <dl className="invoice-totals"><div><dt>{t.invoiceSubtotal}</dt><dd>{money(invoice.totals.subtotalMinor)}</dd></div><div><dt>{t.invoiceDiscount}</dt><dd>{money(invoice.totals.discountMinor)}</dd></div><div><dt>{t.invoiceTaxTotal}</dt><dd>{money(invoice.totals.taxMinor)}</dd></div><div className="invoice-grand-total"><dt>{t.invoiceTotal}</dt><dd>{money(invoice.totals.totalMinor)}</dd></div></dl>
    {invoice.taxBreakdown.length > 0 && <details className="invoice-tax-breakdown"><summary>{t.invoiceTaxTotal}</summary>{invoice.taxBreakdown.map(row => <p key={row.rateBps}>{row.rateBps / 100}% · {money(row.taxableMinor)} → {money(row.taxMinor)}</p>)}</details>}
    {invoice.notes && <section className="invoice-paper-notes"><h3>{t.note}</h3><p className="preserve-lines">{invoice.notes}</p></section>}
    {invoice.terms && <section className="invoice-paper-notes"><h3>{t.terms}</h3><p className="preserve-lines">{invoice.terms}</p></section>}
    <p className="small">{invoice.rounding === 'credit_proportional' ? t.invoiceCreditRounding : t.invoiceTotalsHint}</p>
  </article>;
}

function historyTitle(t: ReturnType<typeof useFarm>['t'], action: string): string {
  const labels: Record<string, string> = {draft_created: t.saveInvoiceDraft, created: t.saveInvoiceDraft, draft_updated: t.editInvoiceDraft, updated: t.editInvoiceDraft, posted: t.postSupplierInvoice, issued: t.issueSalesInvoice, invoice_posted: t.postSupplierInvoice, invoice_issued: t.issueSalesInvoice, payment_recorded: t.recordInvoicePayment, payment_reversed: t.invoiceCorrection, void: t.invoiceCancel, voided: t.invoiceCancel, credited: t.invoiceCredit, credit_created: t.invoiceCredit};
  return labels[action] ?? t.invoiceHistory;
}
