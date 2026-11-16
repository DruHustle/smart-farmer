import {useState} from 'react';
import {useFarm} from '../../context';
import {amountToMinor, decimalInput, minorToInput} from '../../lib/accounting';
import {useList, useResource} from '../../lib/resources';
import {MoreButton, ResourceState} from '../../components/completion';
import {Field, Icon, Section, formValue} from '../../components/ui';
import {AccountingForm} from './AccountingForm';
import {accountName} from './accountNames';
import type {AccountingAccount, AccountingInvoiceDetail, InvoiceDocument, SettingsResponse} from './types';

type EditableLine = {id: string; description: string; quantity: string; unitPrice: string; discount: string; taxRateBps: string; accountCode: string; projectId: string};
function blankLine(kind: 'purchase' | 'sale'): EditableLine {return {id: crypto.randomUUID(), description: '', quantity: '', unitPrice: '', discount: '0', taxRateBps: '', accountCode: kind === 'purchase' ? '5000' : '4000', projectId: ''};}

export function InvoiceEditor({kind, configuration, invoice, document, onSaved, onCancel}: {
  kind: 'purchase' | 'sale'; configuration: SettingsResponse; invoice?: AccountingInvoiceDetail;
  document?: InvoiceDocument | null; onSaved: (invoice: AccountingInvoiceDetail) => void; onCancel: () => void;
}) {
  const {farm, t, data} = useFarm();
  const base = `/v1/farms/${farm.id}/accounting`;
  const accounts = useResource<{items: AccountingAccount[]}>(`${base}/accounts`, {items: []});
  const sources = useList<{id: string; description: string; reference: string; postedOn: string; amountMinor: string | null; originalAmount: string; eligible: boolean; eligibilityError: string | null; currency: string; minorUnit: number; alreadyInvoiced: boolean; invoiceId: string | null; projects: Array<{projectId: string; amountMinor: string | null; originalAmount: string}>}>(`${base}/sources?kind=${kind}`);
  const [sourceId, setSourceId] = useState(invoice?.sourceEntryId ?? '');
  const selectedSource = sources.items.find(source => source.id === sourceId);
  const suggestion = document?.extraction?.suggestions;
  const [currency, setCurrency] = useState(invoice?.currency ?? (document ? suggestion?.currency ?? '' : configuration.settings?.defaultCurrency ?? ''));
  const scale = configuration.currencies.find(item => item.code === currency)?.minorUnit;
  const [lines, setLines] = useState<EditableLine[]>(() => invoice ? invoice.lines.map(line => ({
    id: line.id, description: line.description, quantity: line.quantity, unitPrice: line.unitPrice,
    discount: minorToInput(line.discountMinor, invoice.minorUnit), taxRateBps: String(line.taxRateBps), accountCode: line.accountCode, projectId: line.projectId ?? '',
  })) : suggestion?.lines.length ? suggestion.lines.map(line => ({...blankLine(kind), ...line})) : [blankLine(kind)]);
  const party = invoice?.party;
  const availableAccounts = accounts.value.items.filter(account => account.active && account.type === (kind === 'purchase' ? 'expense' : 'income'));
  const taxRates = configuration.settings?.taxRates.filter(rate => rate.rateBps !== 0) ?? [];
  return <Section title={invoice ? t.editInvoiceDraft : kind === 'purchase' ? t.newSupplierInvoice : t.newSalesInvoice} action={<button type="button" className="text-button" onClick={onCancel}><Icon name="back"/>{t.back}</button>}>
    {document && <p className="notice subtle">{t.extractionHint}<br/>{t.sourceDocument}: {document.filename}</p>}
    <AccountingForm<AccountingInvoiceDetail> path={invoice ? `${base}/invoices/${invoice.id}` : `${base}/invoices`} method={invoice ? 'PATCH' : 'POST'} title={t.saveInvoiceDraft} onResult={onSaved} build={(form, id) => {
      if (scale === undefined) throw new Error('unsupported_currency');
      const payload = {
        id, ...(invoice ? {version: invoice.version} : {kind}), currency,
        party: {name: formValue(form, 'partyName'), address: formValue(form, 'partyAddress'), email: formValue(form, 'partyEmail'), phone: formValue(form, 'partyPhone'), taxNumber: formValue(form, 'partyTaxNumber')},
        reference: formValue(form, 'reference'), issueDate: formValue(form, 'issueDate'), dueDate: formValue(form, 'dueDate') || null,
        notes: formValue(form, 'notes'), terms: formValue(form, 'terms'), documentId: document?.id ?? invoice?.documentId ?? null,
        sourceEntryId: sourceId || null,
        lines: lines.map(line => {
          const key = `line-${line.id}`;
          const quantity = decimalInput(formValue(form, `${key}-quantity`));
          if (!/[1-9]/.test(quantity)) throw new Error('invalid_amount');
          const rate = formValue(form, `${key}-taxRateBps`);
          if (!rate || !/^\d+$/.test(rate)) throw new Error('accounting_invalid_tax');
          return {id: line.id, description: formValue(form, `${key}-description`), quantity, unitPrice: decimalInput(formValue(form, `${key}-unitPrice`)), discountMinor: amountToMinor(formValue(form, `${key}-discount`), scale), taxRateBps: Number(rate), accountCode: formValue(form, `${key}-accountCode`), projectId: formValue(form, `${key}-projectId`) || null};
        }),
      };
      return payload;
    }}>
      <fieldset className="repeat-card"><legend>{kind === 'purchase' ? t.invoiceSupplier : t.invoiceCustomer}</legend>
        <Field label={t.invoicePartyName}><input name="partyName" required maxLength={160} defaultValue={party?.name ?? suggestion?.party?.name ?? ''}/></Field>
        <Field label={t.invoiceAddress}><textarea name="partyAddress" maxLength={500} defaultValue={party?.address ?? ''}/></Field>
        <div className="field-row"><Field label={t.invoiceEmail}><input name="partyEmail" type="email" maxLength={254} defaultValue={party?.email ?? ''}/></Field><Field label={t.invoicePhone}><input name="partyPhone" type="tel" maxLength={50} defaultValue={party?.phone ?? ''}/></Field></div>
        <Field label={t.invoiceTaxId}><input name="partyTaxNumber" maxLength={100} defaultValue={party?.taxNumber ?? ''}/></Field>
      </fieldset>
      <div className="field-row">
        <Field label={kind === 'purchase' ? t.invoiceReference : t.invoiceCustomerReference}><input name="reference" required={kind === 'purchase'} maxLength={100} defaultValue={invoice?.reference ?? suggestion?.reference ?? ''}/></Field>
        <Field label={t.currency}><select name="currency" required value={currency} onChange={event => setCurrency(event.target.value)}><option value="">{t.select}</option>{configuration.currencies.map(item => <option key={item.code} value={item.code}>{item.code}</option>)}</select></Field>
      </div>
      <div className="field-row"><Field label={t.invoiceIssueDate}><input name="issueDate" type="date" required defaultValue={invoice?.issueDate ?? suggestion?.issueDate ?? ''}/></Field><Field label={t.invoiceDueDate}><input name="dueDate" type="date" defaultValue={invoice?.dueDate ?? suggestion?.dueDate ?? ''}/></Field></div>
      <details className="attachment-disclosure"><summary>{t.invoiceSourceEntry}</summary><p className="muted small">{t.invoiceSourceHint}</p><ResourceState {...sources}/><Field label={t.invoiceSourceEntry}><select name="sourceEntryId" value={sourceId} onChange={event => setSourceId(event.target.value)}><option value="">{t.none}</option>{sourceId && !sources.items.some(source => source.id === sourceId) && <option value={sourceId}>{t.source}</option>}{sources.items.map(source => <option key={source.id} value={source.id} disabled={source.id !== invoice?.sourceEntryId && (source.eligible === false || (source.alreadyInvoiced && source.invoiceId !== invoice?.id) || source.currency !== currency)}>{source.postedOn} · {source.description || source.reference || t.source} · {source.currency} {source.amountMinor === null ? source.originalAmount : minorToInput(source.amountMinor, source.minorUnit)}{source.eligible === false ? ` · ${t.source_currency_precision}` : source.alreadyInvoiced && source.invoiceId !== invoice?.id ? ` · ${t.source_already_invoiced}` : ''}</option>)}</select></Field>{sources.items.some(source => source.eligible === false) && <p className="notice subtle">{t.source_currency_precision}</p>}{selectedSource?.projects?.length ? <div><h3>{t.invoiceSourceProjects}</h3><p className="muted small">{t.invoiceSourceProjectsHint}</p><ul>{selectedSource.projects.map((allocation, index) => <li key={`${allocation.projectId}-${index}`}>{data.projects.find(project => project.id === allocation.projectId)?.name ?? t.project} · {selectedSource.currency} {allocation.amountMinor === null ? allocation.originalAmount : minorToInput(allocation.amountMinor, selectedSource.minorUnit)}</li>)}</ul></div> : null}<MoreButton {...sources}/></details>
      <fieldset className="repeat-card invoice-lines"><legend>{t.invoiceLineItems}</legend>
        <p className="muted small">{t.invoiceTotalsHint}</p>
        {lines.map((line, index) => <fieldset className="repeat-card invoice-line" key={line.id}>
          <legend>{t.invoiceLine} {index + 1}</legend>
          <Field label={t.description}><input name={`line-${line.id}-description`} required maxLength={500} defaultValue={line.description}/></Field>
          <div className="field-row">
            <Field label={t.quantity}><input name={`line-${line.id}-quantity`} type="text" inputMode="decimal" pattern="[0-9]{1,15}([.][0-9]{1,6})?" maxLength={22} required defaultValue={line.quantity}/></Field>
            <Field label={`${t.invoiceUnitPrice}${currency ? ` · ${currency}` : ''}`}><input name={`line-${line.id}-unitPrice`} type="text" inputMode="decimal" pattern="[0-9]{1,15}([.][0-9]{1,6})?" maxLength={22} required defaultValue={line.unitPrice}/></Field>
          </div>
          <div className="field-row">
            <Field label={`${t.invoiceDiscount}${currency ? ` · ${currency}` : ''}`}><input name={`line-${line.id}-discount`} type="text" inputMode="decimal" pattern={scale ? `[0-9]+([.][0-9]{1,${scale}})?` : '[0-9]+'} required maxLength={30} defaultValue={line.discount}/></Field>
            <Field label={t.invoiceTaxRate} hint={t.invoiceTaxHint}><select name={`line-${line.id}-taxRateBps`} required defaultValue={line.taxRateBps}><option value="">{t.select}</option><option value="0">{t.accountingNoTax}</option>{taxRates.map(rate => <option key={rate.name} value={rate.rateBps}>{rate.name} · {rate.rateBps / 100}%</option>)}{line.taxRateBps && line.taxRateBps !== '0' && !taxRates.some(rate => String(rate.rateBps) === line.taxRateBps) && <option value={line.taxRateBps}>{Number(line.taxRateBps) / 100}%</option>}</select></Field>
          </div>
          <div className="field-row">
            <Field label={t.accountingAccount}><select name={`line-${line.id}-accountCode`} required defaultValue={line.accountCode}>{availableAccounts.length ? availableAccounts.map(account => <option key={account.code} value={account.code}>{account.code} · {accountName(account, t)}</option>) : <option value={line.accountCode}>{line.accountCode} · {kind === 'purchase' ? t.accountingExpense : t.accountingIncome}</option>}</select></Field>
            <Field label={t.project}><select name={`line-${line.id}-projectId`} defaultValue={line.projectId}><option value="">{t.none}</option>{data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field>
          </div>
          <button type="button" className="text-button danger-text" disabled={lines.length === 1} onClick={() => setLines(old => old.filter(item => item.id !== line.id))}>{t.removeInvoiceLine} {index + 1}</button>
        </fieldset>)}
        <button type="button" className="secondary" disabled={lines.length >= 100} onClick={() => setLines(old => [...old, blankLine(kind)])}><Icon name="plus"/>{t.addInvoiceLine}</button>
      </fieldset>
      <Field label={t.note}><textarea name="notes" maxLength={2000} defaultValue={invoice?.notes ?? ''}/></Field>
      <Field label={t.terms}><textarea name="terms" maxLength={2000} defaultValue={invoice?.terms ?? ''}/></Field>
      <p className="muted small">{t.invoicePreviewHint}</p>
    </AccountingForm>
  </Section>;
}
