import {useState} from 'react';
import {useFarm} from '../context';
import {invoiceMoney} from '../lib/accounting';
import {useList, useResource} from '../lib/resources';
import {displayDate} from '../lib/time';
import {MoreButton, ResourceState} from '../components/completion';
import {Empty, Field, Icon, PageHead, Section} from '../components/ui';
import {SupplierDocuments} from './accounting/Documents';
import {AccountingSetup} from './accounting/Setup';
import {InvoiceEditor} from './accounting/InvoiceEditor';
import {InvoiceDetail, InvoiceStatusBadge, PaymentStatusBadge} from './accounting/InvoiceDetail';
import {AccountingReports} from './accounting/Reports';
import {PendingAccountingActions} from './accounting/PendingActions';
import type {AccountingInvoiceDetail, AccountingSummary, InvoiceDocument, SettingsResponse} from './accounting/types';

type AccountingTab = 'summary' | 'purchase' | 'sale' | 'reports' | 'setup';
type View = {type: 'list'} | {type: 'new'; kind: 'purchase' | 'sale'; document?: InvoiceDocument | null} | {type: 'detail'; id: string} | {type: 'edit'; invoice: AccountingInvoiceDetail};

export function Accounting({initialInvoiceId}: {initialInvoiceId?: string}) {
  const {manager, t} = useFarm();
  return manager ? <AccountingWorkspace initialInvoiceId={initialInvoiceId}/> : <Empty title={t.financialAccess}/>;
}

function AccountingWorkspace({initialInvoiceId}: {initialInvoiceId?: string}) {
  const {farm, t, online, navigate} = useFarm();
  const configuration = useResource<SettingsResponse>(`/v1/farms/${farm.id}/accounting/settings`, {configured: false, settings: null, currencies: []});
  const [tab, setTab] = useState<AccountingTab>('summary');
  const [view, setView] = useState<View>(() => initialInvoiceId ? {type: 'detail', id: initialInvoiceId} : {type: 'list'});
  const [revision, setRevision] = useState(0);
  const settings = configuration.value;
  const tabs: Array<[AccountingTab, string]> = [['summary', t.accountingSummary], ['purchase', t.supplierInvoices], ['sale', t.salesInvoices], ['reports', t.invoiceReports], ['setup', t.accountingSetup]];
  const open = (id: string) => setView({type: 'detail', id});
  return <>
    <PageHead title={t.accounting} subtitle={t.accountingHint} action={<button type="button" className="secondary" onClick={() => navigate('reports')}>{t.existingReports}</button>}/>
    <nav className="workspace-tabs accounting-tabs" aria-label={t.accounting}>{tabs.map(([key, title]) => <button type="button" key={key} className={tab === key ? 'selected' : ''} aria-current={tab === key ? 'page' : undefined} onClick={() => {setTab(key); setView({type: 'list'});}}>{title}</button>)}</nav>
    <ResourceState {...configuration}/>
    {!online && <p className="notice subtle">{t.online_required}</p>}
    <PendingAccountingActions onResolved={async (value, request) => {
      const result = value as {id?: string; kind?: string};
      if (typeof result?.id === 'string' && typeof result.kind === 'string' && request.path.includes('/invoices')) open(result.id);
      else {setView({type: 'list'}); setTab(request.path.includes('/journals') ? 'reports' : 'setup'); await configuration.reload();}
      setRevision(old => old + 1);
    }}/>
    {!configuration.savedAt ? (!configuration.loading && <Empty title={t.noData}/>) : view.type === 'detail' ? <InvoiceDetail key={`${view.id}-${revision}`} invoiceId={view.id} onBack={() => setView({type: 'list'})} onOpen={open} onEdit={invoice => setView({type: 'edit', invoice})}/> : view.type === 'new' || view.type === 'edit' ? <InvoiceEditor key={`${revision}-${view.type === 'edit' ? `${view.invoice.id}-${view.invoice.version}` : `new-${view.kind}-${view.document?.id ?? ''}`}`} kind={view.type === 'edit' ? view.invoice.kind === 'purchase' ? 'purchase' : 'sale' : view.kind} invoice={view.type === 'edit' ? view.invoice : undefined} document={view.type === 'new' ? view.document : undefined} configuration={settings} onSaved={invoice => open(invoice.id)} onCancel={() => setView({type: 'list'})}/> : !settings.configured || tab === 'setup' ? <>
      {!settings.configured && <p className="notice subtle">{t.accountingSetupRequired}</p>}
      <AccountingSetup key={`${settings.settings?.version ?? 0}-${revision}`} settings={settings.settings} currencies={settings.currencies} reload={configuration.reload}/>
    </> : tab === 'summary' ? <AccountingOverview key={revision}/> : tab === 'reports' ? <AccountingReports key={revision} configuration={settings}/> : <>
      {tab === 'purchase' && <SupplierDocuments key={revision} onDraft={document => setView({type: 'new', kind: 'purchase', document})}/>}
      <InvoiceList key={`${tab}-${revision}`} kind={tab} onOpen={open} onNew={() => setView({type: 'new', kind: tab})}/>
    </>}
  </>;
}

export function AccountingOverview({query = ''}: {query?: string}) {
  const {farm, t, lang} = useFarm();
  const summary = useResource<AccountingSummary | null>(`/v1/farms/${farm.id}/accounting/summary${query}`, null);
  const fields: Array<[keyof NonNullable<AccountingSummary['byCurrency'][number]>, string]> = [
    ['salesMinor', t.invoiceSalesTotal], ['expensesMinor', t.invoicePurchaseTotal], ['cashReceivedMinor', t.cashReceived], ['cashPaidMinor', t.cashPaid],
    ['receivableMinor', t.invoiceReceivables], ['payableMinor', t.invoicePayables], ['overdueReceivableMinor', t.accountingOverdueReceivable], ['overduePayableMinor', t.accountingOverduePayable],
    ['taxCollectedMinor', t.accountingTaxCollected], ['taxOnPurchasesMinor', t.accountingPurchaseTax],
  ];
  return <Section title={t.accountingSummary}>
    <ResourceState {...summary}/>
    <p className="notice subtle">{t.accountingScopeHint}</p>
    {summary.value && <><dl className="facts-grid"><div><dt>{t.accountingAsOf}</dt><dd>{displayDate(summary.value.asOf, lang)}</dd></div><div><dt>{t.invoiceDraftCount}</dt><dd>{summary.value.draftCount}</dd></div><div><dt>{t.accountingUnlinked}</dt><dd>{summary.value.unlinkedLegacyEntries}</dd></div></dl>
      {summary.value.byCurrency.length ? <div className="accounting-currencies">{summary.value.byCurrency.map(currency => <article className="accounting-currency" key={currency.currency}><h3>{currency.currency}</h3><dl>{fields.map(([key, title]) => <div key={key}><dt>{title}</dt><dd>{invoiceMoney(String(currency[key]), currency.currency, currency.minorUnit, lang)}</dd></div>)}</dl></article>)}</div> : <Empty icon="reports" title={t.emptyFinancials}/>}</>}
  </Section>;
}

function InvoiceList({kind, onOpen, onNew}: {kind: 'purchase' | 'sale'; onOpen: (id: string) => void; onNew: () => void}) {
  const {farm, t, lang, online} = useFarm();
  const [status, setStatus] = useState('');
  const path = `/v1/farms/${farm.id}/accounting/invoices?kind=${kind}${status ? `&status=${status}` : ''}`;
  const list = useList<AccountingInvoiceDetail>(path);
  return <Section title={kind === 'purchase' ? t.supplierInvoices : t.salesInvoices} action={kind === 'sale' && <button type="button" className="primary" disabled={!online} onClick={onNew}><Icon name="plus"/>{t.newSalesInvoice}</button>}>
    <Field label={t.status}><select name="invoiceStatus" value={status} onChange={event => setStatus(event.target.value)}><option value="">{t.invoiceAllStatuses}</option><option value="draft">{t.invoiceDraft}</option><option value={kind === 'purchase' ? 'posted' : 'issued'}>{kind === 'purchase' ? t.invoicePosted : t.invoiceIssued}</option><option value="void">{t.invoiceCancelled}</option></select></Field>
    <ResourceState {...list}/>
    {list.items.map(invoice => <article className="record-card invoice-list-row" key={invoice.id}>
      <div><h3>{invoice.number || invoice.reference || invoice.party.name}</h3><p>{invoice.party.name} · {displayDate(invoice.issueDate, lang)}</p>{invoice.number && invoice.reference && <p className="small">{invoice.reference}</p>}<div className="invoice-status-row"><InvoiceStatusBadge status={invoice.status}/>{invoice.status !== 'draft' && invoice.status !== 'void' && <PaymentStatusBadge status={invoice.paymentStatus}/>}</div></div>
      <div className="invoice-list-amount"><strong>{invoiceMoney(invoice.totals.totalMinor, invoice.currency, invoice.minorUnit, lang)}</strong>{invoice.status !== 'draft' && <small>{t.invoiceBalance}: {invoiceMoney(invoice.balanceMinor, invoice.currency, invoice.minorUnit, lang)}</small>}<button type="button" className="secondary" onClick={() => onOpen(invoice.id)}>{t.review}</button></div>
    </article>)}
    {!list.loading && !list.items.length && <Empty icon="reports" title={t.invoiceEmpty}/>}
    <MoreButton {...list}/>
  </Section>;
}
