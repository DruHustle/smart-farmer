import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { editableInvoice, money, type Account, type AccountingSource, type AccountingSummary, type EditableInvoice, type Invoice, type SettingsResponse } from '../accounting';
import { c, Form, options, usePanel } from '../completion-ui';
import { sharePrivateReport } from '../exports';
import { textFor } from '../i18n';
import { allPages, string, type Row } from '../product';
import { farmNow } from '../time';
import type { Language, Project } from '../types';
import type { Workspace } from '../use-workspace';
import { Button, Card, Choice, Notice, Sheet, styles } from '../ui';
import { AccountingDocumentDetail, AccountingDocuments } from './AccountingDocuments';
import { AccountingSettingsPanel } from './AccountingSettings';
import { InvoiceEditor } from './InvoiceEditor';
import { InvoiceDetail } from './InvoiceDetail';
import { AccountingBooks } from './AccountingBooks';
import { accountingPath, Amount } from './accounting-ui';

export function AccountingPanel({ work, language, project, onNativePrompt, initialInvoiceId }: { work: Workspace; language: Language; project?: Project; onNativePrompt: (active: boolean) => void; initialInvoiceId?: string }) {
  const t = textFor(language); const [tab, setTab] = useState('accountingSummary'); const [status, setStatus] = useState('all'); const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<{ initial: EditableInvoice; version?: number } | null>(null); const [selected, setSelected] = useState<Invoice | null>(null); const [documentId, setDocumentId] = useState<string | null>(null);
  const [visible, setVisible] = useState(25); const [filters, setFilters] = useState<Row>({});
  const query = new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([, value]) => value).map(([key, value]) => [key, string(value)]))).toString();
  const context = usePanel(work, 'accounting-context', async () => { const [settings, accounts] = await Promise.all([work.api.request<SettingsResponse>(accountingPath(work, '/settings')), work.api.request<{ items: Account[] }>(accountingPath(work, '/accounts'))]); return { settings, accounts: accounts.items }; });
  const invoices = usePanel(work, 'accounting-invoices', () => allPages<Invoice>(work.api, accountingPath(work, '/invoices')));
  const linked = usePanel(work, `accounting-invoice:${initialInvoiceId || 'none'}`, () => initialInvoiceId ? work.api.request<Invoice>(accountingPath(work, `/invoices/${initialInvoiceId}`)) : Promise.resolve(null));
  const openedLink = useRef(false);
  useEffect(() => { if (linked.value) { if (!openedLink.current) { openedLink.current = true; setSelected(linked.value); } else setSelected(current => current?.id === initialInvoiceId ? linked.value : current); } }, [linked.value, initialInvoiceId]);
  const summary = usePanel(work, `accounting-summary:${query}`, () => work.api.request<AccountingSummary>(accountingPath(work, `/summary?${query}`)));
  const sources = usePanel(work, 'accounting-sources', async () => {
    const [purchase, sale] = await Promise.all([allPages<AccountingSource>(work.api, accountingPath(work, '/sources?kind=purchase')), allPages<AccountingSource>(work.api, accountingPath(work, '/sources?kind=sale'))]);
    return { purchase: purchase.filter(item => !item.alreadyInvoiced), sale: sale.filter(item => !item.alreadyInvoiced) };
  });
  function reload() { void Promise.all([context.reload(), invoices.reload(), summary.reload()]); }
  function changed(invoice: Invoice) { setSelected(invoice); setEditing(null); void invoices.reload(); void summary.reload(); }
  function newDraft(kind: 'purchase' | 'sale') {
    const value: EditableInvoice = { id: Crypto.randomUUID(), kind, party: { name: '', address: '', email: '', phone: '', taxNumber: '' }, currency: context.value?.settings.settings?.defaultCurrency || '', issueDate: farmNow(work.snapshot?.farm.timezone || 'Africa/Harare').slice(0, 10), dueDate: null, reference: '', notes: '', terms: '', documentId: null, sourceEntryId: null, lines: [{ id: Crypto.randomUUID(), description: '', quantity: '1', unitPrice: '', discountAmount: '0', taxRateBps: 0, accountCode: kind === 'purchase' ? '5000' : '4000', projectId: project?.id || null }] };
    setEditing({ initial: value });
  }
  function sourceDraft(initial: EditableInvoice) { setDocumentId(null); setSelected(null); setEditing({ initial }); }
  const list = (invoices.value || []).filter(item => (tab === 'supplierBills' ? item.kind === 'purchase' || item.kind === 'purchase_credit' : item.kind === 'sale' || item.kind === 'sale_credit') && (status === 'all' || item.status === status || (item.kind === 'purchase' || item.kind === 'sale') && item.paymentStatus === status && item.status !== 'draft' && item.status !== 'void') && `${item.party.name} ${item.reference} ${item.number || ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  async function exportCsv(kind: 'ledger' | 'invoices') {
    onNativePrompt(true); try { await work.onlineAction(() => sharePrivateReport(work.session, accountingPath(work, `/${kind}.csv?${query}`), 'csv', c(language, kind))); } finally { onNativePrompt(false); }
  }
  function sourceOption(item: AccountingSource) {
    const amount = item.amountMinor === null ? `${item.currency} ${item.originalAmount}` : money(item.amountMinor, item.currency, item.minorUnit);
    const allocations = (item.projects || []).map(allocation => {
      const name = allocation.projectId ? work.snapshot?.projects.find(project => project.id === allocation.projectId)?.name || `${c(language, 'project')} ${allocation.projectId}` : c(language, 'unassigned');
      const value = allocation.amountMinor === null ? `${item.currency} ${allocation.originalAmount}` : money(allocation.amountMinor, item.currency, item.minorUnit);
      return `\n${name}: ${value}`;
    }).join('');
    return { value: item.id, disabled: item.eligible === false || item.amountMinor === null, label: `${item.description || item.reference} · ${item.postedOn} · ${amount}${item.eligible === false ? ` · ${c(language, 'source_currency_precision')}` : ''}${allocations}` };
  }
  if (!work.canManage) return <Notice text={t.forbidden} />;
  return <>
    <Choice testID="accounting-tabs" label={c(language, 'accounting')} value={tab} onChange={value => { setTab(value); setStatus('all'); setVisible(25); }} options={options(language, ['accountingSummary', 'supplierBills', 'salesInvoices', 'scanInvoice', 'accountingBooks', 'accountingSettings'])} closeLabel={t.close} />
    {project ? <Notice text={c(language, 'farmAccountingHint')} /> : null}
    {!work.online ? <Notice text={t.stale} /> : null}
    <Button secondary title={t.refresh} busy={context.loading || invoices.loading || summary.loading} onPress={reload} />
    {context.value && !context.value.settings.configured ? <><Notice text={c(language, 'accounting_unconfigured')} /><Button secondary title={c(language, 'accountingSettings')} onPress={() => setTab('accountingSettings')} /></> : null}
    {tab === 'accountingSummary' ? <>
      <Notice text={c(language, 'accountingScopeHint')} />
      <Form work={work} language={language} fields={[{ key: 'from', type: 'date' }, { key: 'to', type: 'date' }, { key: 'asOf', type: 'date' }]} includeId={false} confirmation={false} submit={async body => { setFilters(body); }} />
      {summary.value ? <>
        <Text style={styles.caption}>{c(language, 'asOf')}: {summary.value.asOf} · {c(language, 'draftCount')}: {summary.value.draftCount} · {c(language, 'unlinkedLegacyEntries')}: {summary.value.unlinkedLegacyEntries}</Text>
        {summary.value.byCurrency.map(group => <Card key={group.currency} title={group.currency}>{(['salesMinor', 'expensesMinor', 'taxCollectedMinor', 'taxOnPurchasesMinor', 'cashReceivedMinor', 'cashPaidMinor', 'receivableMinor', 'payableMinor', 'overdueReceivableMinor', 'overduePayableMinor'] as const).map(key => <Amount key={key} label={c(language, key)} value={group[key]} currency={group.currency} scale={group.minorUnit} />)}</Card>)}
        {!summary.value.byCurrency.length ? <Text style={styles.muted}>{t.empty}</Text> : null}
      </> : null}
      <View style={styles.row}><Button secondary title={c(language, 'exportInvoices')} disabled={!work.online} busy={work.busy} onPress={() => { void exportCsv('invoices'); }} /><Button secondary title={c(language, 'exportLedger')} disabled={!work.online} busy={work.busy} onPress={() => { void exportCsv('ledger'); }} /></View>
    </> : null}
    {tab === 'supplierBills' || tab === 'salesInvoices' ? <>
      <Button testID={tab === 'supplierBills' ? 'invoice-new-purchase' : 'invoice-new-sale'} title={c(language, tab === 'supplierBills' ? 'newBill' : 'newInvoice')} disabled={!context.value?.settings.configured} onPress={() => newDraft(tab === 'supplierBills' ? 'purchase' : 'sale')} />
      <Choice testID="invoice-status-filter" label={c(language, 'status')} value={status} onChange={value => { setStatus(value); setVisible(25); }} closeLabel={t.close} options={options(language, ['all', 'draft', ...(tab === 'supplierBills' ? ['posted'] : ['issued']), 'unpaid', 'partial', 'paid', 'void'])} />
      <Form work={work} language={language} fields={[{ key: 'search' }]} includeId={false} confirmation={false} submit={async body => { setSearch(string(body.search)); setVisible(25); }} />
      {list.slice(0, visible).map(invoice => <Card key={invoice.id} title={invoice.number || invoice.reference || invoice.party.name}><Text style={styles.text}>{invoice.party.name}</Text><Text style={styles.caption}>{c(language, invoice.kind)} · {c(language, invoice.status)}{(invoice.kind === 'purchase' || invoice.kind === 'sale') && (invoice.status === 'posted' || invoice.status === 'issued') ? ` · ${c(language, invoice.paymentStatus)}` : ''}</Text><Text style={styles.text}>{money(invoice.totals.totalMinor, invoice.currency, invoice.minorUnit)} · {c(language, 'outstandingAmount')}: {money(invoice.balanceMinor, invoice.currency, invoice.minorUnit)}</Text><Button testID={`invoice-open-${invoice.id}`} secondary title={c(language, 'details')} onPress={() => setSelected(invoice)} /></Card>)}
      {!list.length ? <Text style={styles.muted}>{t.empty}</Text> : null}{list.length > visible ? <Button secondary title={c(language, 'loadMore')} onPress={() => setVisible(value => value + 25)} /> : null}
    </> : null}
    {tab === 'scanInvoice' ? <AccountingDocuments work={work} language={language} projectId={project?.id} onNativePrompt={onNativePrompt} onDraft={sourceDraft} /> : null}
    {tab === 'accountingSettings' && context.value ? <AccountingSettingsPanel work={work} language={language} data={context.value.settings} accounts={context.value.accounts} onChanged={reload} /> : null}
    {tab === 'accountingBooks' && context.value ? <AccountingBooks work={work} language={language} settings={context.value.settings} accounts={context.value.accounts} /> : null}
    <Sheet title={c(language, 'invoiceDraft')} visible={Boolean(editing)} onClose={() => setEditing(null)} closeLabel={t.close} keyboardDismissLabel={t.hideKeyboard}>{editing && context.value ? <InvoiceEditor key={`${editing.initial.id}:${editing.version ?? 'new'}`} work={work} language={language} {...editing} settings={context.value.settings} accounts={context.value.accounts} onSaved={changed} sources={(sources.value?.[editing.initial.kind] || []).map(sourceOption)} /> : null}</Sheet>
    <Sheet title={c(language, 'details')} visible={Boolean(selected)} onClose={() => setSelected(null)} closeLabel={t.close} keyboardDismissLabel={t.hideKeyboard}>{selected ? <InvoiceDetail key={selected.id} work={work} language={language} invoice={selected} onChanged={changed} onEdit={() => { setEditing({ initial: editableInvoice(selected), version: selected.version }); setSelected(null); }} onNativePrompt={onNativePrompt} onDocument={id => setDocumentId(id)} /> : null}</Sheet>
    <Sheet title={c(language, 'sourceDocument')} visible={Boolean(documentId)} onClose={() => setDocumentId(null)} closeLabel={t.close} keyboardDismissLabel={t.hideKeyboard}>{documentId ? <AccountingDocumentDetail key={documentId} work={work} language={language} id={documentId} onDraft={sourceDraft} onNativePrompt={onNativePrompt} projectId={project?.id} /> : null}</Sheet>
  </>;
}
