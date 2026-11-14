import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { calendarDate, fromMinor, money, toMinor, type Invoice } from '../accounting';
import { c, Form, options, selectField, textField } from '../completion-ui';
import { sharePrivateReport } from '../exports';
import { errorText, textFor } from '../i18n';
import { string } from '../product';
import { farmNow } from '../time';
import type { Language } from '../types';
import type { Workspace } from '../use-workspace';
import { Button, Card, Field, Notice, Sheet, Toggle, styles } from '../ui';
import { accountingMutation, accountingPath, Amount, InvoicePreview } from './accounting-ui';

export function InvoiceDetail({ work, language, invoice, onChanged, onEdit, onNativePrompt, onDocument }: { work: Workspace; language: Language; invoice: Invoice; onChanged: (invoice: Invoice) => void; onEdit: () => void; onNativePrompt: (active: boolean) => void; onDocument: (id: string) => void }) {
  const t = textFor(language); const [action, setAction] = useState(''); const [preview, setPreview] = useState(false); const [reviewed, setReviewed] = useState(false);
  const [reason, setReason] = useState(''); const [sending, setSending] = useState(false); const busy = useRef(false);
  const today = farmNow(work.snapshot?.farm.timezone || 'Africa/Harare').slice(0, 10);
  const current = invoice.snapshot || invoice.preview; const finalized = invoice.status === 'posted' || invoice.status === 'issued';
  const purchasable = invoice.kind === 'purchase' || invoice.kind === 'sale';
  const outstanding = BigInt(invoice.balanceMinor); const finalizedDuplicates = invoice.duplicateCandidates.filter(item => item.status === 'posted' || item.status === 'issued'); const exactDuplicate = finalizedDuplicates.some(item => item.reason !== 'supplier_reference');
  const change = (result: unknown) => { setAction(''); onChanged(result as Invoice); };
  async function finalize() {
    if (!reviewed || busy.current || exactDuplicate) return;
    busy.current = true; setSending(true);
    try {
      await work.onlineAction(async () => {
        const result = await accountingMutation<Invoice>(work, `/invoices/${invoice.id}/${invoice.kind === 'purchase' ? 'post' : 'issue'}`, { version: invoice.version, reviewed: true, confirmed: true, ...(finalizedDuplicates.length ? { duplicateOverrideReason: reason.trim() } : {}) });
        setAction(''); setReviewed(false); onChanged(result);
      });
    } finally { busy.current = false; setSending(false); }
  }
  async function share() {
    onNativePrompt(true);
    try { await work.onlineAction(() => sharePrivateReport(work.session, accountingPath(work, `/invoices/${invoice.id}/${invoice.status === 'draft' ? 'preview.pdf' : 'pdf'}`), 'pdf', invoice.number || c(language, 'invoicePreview'))); }
    finally { onNativePrompt(false); }
  }
  return <>
    <PendingInvoiceActions work={work} language={language} invoice={invoice} onChanged={onChanged} />
    <Card title={invoice.number || invoice.reference || c(language, 'invoiceDraft')}>
      <Text testID="invoice-status" style={styles.heading}>{c(language, invoice.status)}</Text>
      <Text testID="invoice-party-name" selectable style={styles.text}>{invoice.party.name}</Text>
      {purchasable && invoice.status !== 'draft' && invoice.status !== 'void' ? <Text testID="invoice-payment-status" style={styles.text}>{c(language, invoice.paymentStatus)}</Text> : null}
      {invoice.dueDate ? <Text style={styles.text}>{c(language, 'dueDate')}: {invoice.dueDate}{finalized && outstanding > 0n && invoice.dueDate < today ? ` · ${c(language, 'overdue')}` : ''}</Text> : null}
      <Amount label={c(language, 'invoiceTotal')} value={invoice.totals.totalMinor} currency={invoice.currency} scale={invoice.minorUnit} />
      <Amount testID="invoice-paid" label={c(language, 'paidAmount')} value={invoice.paidMinor} currency={invoice.currency} scale={invoice.minorUnit} />
      <Amount label={c(language, 'creditedAmount')} value={invoice.creditedMinor} currency={invoice.currency} scale={invoice.minorUnit} />
      <Amount testID="invoice-balance" label={c(language, 'outstandingAmount')} value={invoice.balanceMinor} currency={invoice.currency} scale={invoice.minorUnit} />
      <Text style={styles.caption}>{c(language, 'version')}: {invoice.version}</Text>
    </Card>
    {!work.online ? <Notice text={t.stale} /> : null}
    <Button secondary title={t.refresh} busy={work.busy} disabled={!work.online} onPress={() => { void work.onlineAction(async () => onChanged(await work.api.request<Invoice>(accountingPath(work, `/invoices/${invoice.id}`)))); }} />
    <View style={styles.row}><Button testID="invoice-preview" secondary title={c(language, 'invoicePreview')} onPress={() => setPreview(true)} />{invoice.snapshot || invoice.status === 'draft' ? <Button testID="invoice-share" secondary title={c(language, 'shareInvoice')} disabled={!work.online} busy={work.busy} onPress={() => { void share(); }} /> : null}</View>
    {invoice.documentId ? <Button secondary title={c(language, 'sourceDocument')} onPress={() => onDocument(invoice.documentId!)} /> : null}
    {invoice.status === 'draft' && purchasable ? <>
      <Notice text={c(language, 'savedDraftOnly')} /><Button testID="invoice-edit" secondary title={t.edit} onPress={onEdit} />
      {invoice.duplicateCandidates.length ? <Card title={c(language, 'possibleDuplicate')}><Notice error text={c(language, exactDuplicate ? 'source_already_invoiced' : 'duplicate_invoice')} />{invoice.duplicateCandidates.map(item => <Text key={item.id} selectable style={styles.text}>{item.partyName} · {item.number || item.reference} · {item.currency} {item.totalMinor} ({c(language, 'minorUnits')})</Text>)}</Card> : null}
      <Button testID="invoice-finalize" title={c(language, invoice.kind === 'purchase' ? 'postBill' : 'issueInvoice')} disabled={!work.online || exactDuplicate} onPress={() => { work.setError(null); setReviewed(false); setReason(''); setAction('finalize'); }} />
      <Button secondary danger title={c(language, 'discardInvoiceDraft')} disabled={!work.online} onPress={() => setAction('void')} />
    </> : null}
    {finalized && purchasable ? <>
      <Notice text={c(language, 'manualPaymentHint')} />
      {outstanding > 0n ? <><Button testID="invoice-add-payment" title={c(language, 'addPayment')} disabled={!work.online} onPress={() => setAction('payment')} /><Button secondary title={c(language, 'creditInvoice')} disabled={!work.online} onPress={() => setAction('credit')} /></> : null}
      {BigInt(invoice.paidMinor) === 0n && BigInt(invoice.creditedMinor) === 0n && !invoice.sourceEntryId ? <Button secondary danger title={c(language, 'voidInvoice')} disabled={!work.online} onPress={() => setAction('void')} /> : null}
    </> : null}
    <Card title={c(language, 'payments')}>{invoice.payments.length ? invoice.payments.map(payment => <View key={payment.id} style={styles.item}><Text style={styles.text}>{payment.paidOn} · {c(language, payment.method)} · {money(payment.amountMinor, payment.currency, invoice.minorUnit)}</Text><Text selectable style={styles.caption}>{payment.reference} {payment.note}</Text>{payment.origin === 'legacy' ? <Text style={styles.caption}>{c(language, 'legacyPayment')}</Text> : null}{payment.reversalOf || payment.reversedBy ? <Text style={styles.caption}>{c(language, 'reversed')}</Text> : finalized && purchasable ? <Button secondary title={c(language, 'reversePayment')} disabled={!work.online} onPress={() => setAction(`reverse:${payment.id}`)} /> : null}</View>) : <Text style={styles.muted}>{t.empty}</Text>}</Card>
    {invoice.credits.length ? <Card title={c(language, 'credits')}>{invoice.credits.map(credit => <Text key={credit.id} style={styles.text}>{credit.number} · {money(credit.totalMinor, invoice.currency, invoice.minorUnit)} · {c(language, credit.status)}</Text>)}</Card> : null}
    <Card title={c(language, 'history')}>{invoice.history.map(item => <View key={item.id} style={styles.item}><Text style={styles.text}>{c(language, item.action)} · {item.at}</Text><Text selectable style={styles.caption}>{item.reason}</Text></View>)}</Card>
    <Sheet title={c(language, 'invoicePreview')} visible={preview} onClose={() => setPreview(false)} closeLabel={t.close} closeTestID="invoice-preview-close"><InvoicePreview invoice={current} language={language} draft={invoice.status === 'draft'} /></Sheet>
    <Sheet title={c(language, 'review')} visible={Boolean(action)} onClose={() => { if (!sending) setAction(''); }} closeLabel={t.close} keyboardDismissLabel={t.hideKeyboard}>
      {work.error ? <Notice error text={errorText(language, work.error)} /> : null}
      {action === 'finalize' ? <>
        <InvoicePreview invoice={current} language={language} draft />
        {finalizedDuplicates.length ? <Field label={c(language, 'duplicateOverrideReason')} value={reason} onChangeText={setReason} multiline maxLength={1000} /> : null}
        <Toggle testID="invoice-reviewed" label={c(language, 'reviewedInvoice')} hint={c(language, invoice.kind === 'purchase' ? 'postBillHint' : 'issueInvoiceHint')} value={reviewed} onChange={setReviewed} />
        <Button testID="invoice-confirm-finalize" title={c(language, invoice.kind === 'purchase' ? 'postBill' : 'issueInvoice')} disabled={!work.online || !reviewed || Boolean(finalizedDuplicates.length && reason.trim().length < 3)} busy={sending} onPress={() => { void finalize(); }} />
      </> : null}
      {action === 'payment' ? <Form key={`payment:${invoice.version}`} work={work} language={language} hint={c(language, 'manualPaymentHint')} fields={[textField('amount', true), { key: 'paidOn', type: 'date', required: true }, selectField('method', options(language, ['cash', 'bank', 'mobile_money', 'other']), true), textField('reference'), textField('note')]} initial={{ paidOn: today, amount: fromMinor(invoice.balanceMinor, invoice.minorUnit) }} submit={body => {
        const amountMinor = toMinor(string(body.amount), invoice.minorUnit); if (BigInt(amountMinor) <= 0n || BigInt(amountMinor) > outstanding) throw new Error('payment_exceeds_balance');
        return accountingMutation<Invoice>(work, `/invoices/${invoice.id}/payments`, { version: invoice.version, amountMinor, currency: invoice.currency, paidOn: calendarDate(string(body.paidOn)), method: body.method, reference: body.reference || '', note: body.note || '', confirmed: true });
      }} onSaved={change} /> : null}
      {action === 'void' ? <Form key={`void:${invoice.version}`} work={work} language={language} hint={c(language, 'voidInvoiceHint')} fields={[textField('reason', true)]} submit={body => accountingMutation<Invoice>(work, `/invoices/${invoice.id}/void`, { reason: body.reason, version: invoice.version, confirmed: true })} onSaved={change} /> : null}
      {action.startsWith('reverse:') ? <Form key={`${action}:${invoice.version}`} work={work} language={language} hint={c(language, 'reversePaymentHint')} fields={[textField('reason', true), { key: 'paidOn', type: 'date', required: true }]} initial={{ paidOn: today }} submit={body => accountingMutation<Invoice>(work, `/invoices/${invoice.id}/payments/${action.slice(8)}/reverse`, { reason: body.reason, paidOn: calendarDate(string(body.paidOn)), version: invoice.version, confirmed: true })} onSaved={change} /> : null}
      {action === 'credit' ? <Form key={`credit:${invoice.version}`} work={work} language={language} hint={c(language, 'creditInvoiceHint')} fields={[textField('amount', true), { key: 'issueDate', type: 'date', required: true }, textField('reason', true)]} initial={{ issueDate: today }} submit={body => {
        const amountMinor = toMinor(string(body.amount), invoice.minorUnit); if (BigInt(amountMinor) <= 0n || BigInt(amountMinor) > outstanding) throw new Error('payment_exceeds_balance');
        return accountingMutation<Invoice>(work, `/invoices/${invoice.id}/credits`, { version: invoice.version, amountMinor, issueDate: calendarDate(string(body.issueDate)), reason: body.reason, confirmed: true });
      }} onSaved={() => {
        // The credit response is the new credit; refresh its originating invoice separately.
        setAction(''); void work.api.request<Invoice>(accountingPath(work, `/invoices/${invoice.id}`)).then(onChanged).catch(work.setError);
      }} /> : null}
    </Sheet>
  </>;
}

function PendingInvoiceActions({ work, language, invoice, onChanged }: { work: Workspace; language: Language; invoice: Invoice; onChanged: (invoice: Invoice) => void }) {
  const [pending, setPending] = useState<{ suffix: string; body: Record<string, unknown>; id: string }[]>([]);
  useEffect(() => {
    let active = true;
    const paths = ['payments', 'post', 'issue', 'void', 'credits', ...invoice.payments.filter(item => !item.reversalOf).map(item => `payments/${item.id}/reverse`)];
    void Promise.all(paths.map(async path => {
      const suffix = `/invoices/${invoice.id}/${path}`;
      const saved = await work.repository.formDraft<{ id: string; body: string }>(work.farmId, `accounting-action:POST:${suffix}`);
      return saved ? { suffix, id: saved.id, body: JSON.parse(saved.body) as Record<string, unknown> } : null;
    })).then(values => { if (active) setPending(values.filter((value): value is NonNullable<typeof value> => value !== null)); }).catch(work.setError);
    return () => { active = false; };
  }, [work.farmId, work.repository, invoice.id, invoice.version, work.error]);
  if (!pending.length) return null;
  return <Card title={c(language, 'unconfirmedAction')}><Notice text={c(language, 'accounting_pending_review')} />{pending.map(item => <View key={item.id} style={styles.item}>
    {typeof item.body.amountMinor === 'string' ? <Text style={styles.text}>{money(item.body.amountMinor, invoice.currency, invoice.minorUnit)}</Text> : null}
    <Text selectable style={styles.caption}>{item.id}</Text>
    <Button secondary title={c(language, 'retrySameRequest')} busy={work.busy} disabled={!work.online} onPress={() => { void work.onlineAction(async () => {
      await accountingMutation(work, item.suffix, item.body);
      setPending(values => values.filter(value => value.id !== item.id));
      void work.api.request<Invoice>(accountingPath(work, `/invoices/${invoice.id}`)).then(onChanged).catch(work.setError);
    }); }} />
  </View>)}</Card>;
}
