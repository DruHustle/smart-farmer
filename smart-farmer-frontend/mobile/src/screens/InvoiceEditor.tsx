import React, { useEffect, useRef, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { fromMinor, invoiceTotals, newInvoiceLine, reviewedDraft, scaleFor, type Account, type EditableInvoice, type EditableLine, type Invoice, type InvoiceDraft, type SettingsResponse } from '../accounting';
import { c, projectOptions } from '../completion-ui';
import { errorText, textFor } from '../i18n';
import type { Language } from '../types';
import type { Workspace } from '../use-workspace';
import { Button, Card, Choice, Field, Notice, Sheet, styles } from '../ui';
import { accountingMutation, Totals } from './accounting-ui';
import { createFormCompletion, persistAndSubmitDraft, type FormAttempt } from '../form-completion';

type Stored = { value: EditableInvoice; version: number | null };
export function InvoiceEditor({ work, language, initial, version = null, settings, accounts, onSaved, sources = [] }: { work: Workspace; language: Language; initial: EditableInvoice; version?: number | null; settings: SettingsResponse; accounts: Account[]; onSaved: (invoice: Invoice) => void; sources?: { value: string; label: string; disabled?: boolean }[] }) {
  const t = textFor(language); const [value, setValue] = useState(initial); const latest = useRef(initial);
  const [loaded, setLoaded] = useState(false); const [restored, setRestored] = useState(false); const [stale, setStale] = useState(false);
  const [review, setReview] = useState<InvoiceDraft | null>(null); const [sending, setSending] = useState(false);
  const [reviewVisible, setReviewVisible] = useState(false); const [reviewToken, setReviewToken] = useState(0);
  const completion = useRef(createFormCompletion(Platform.OS === 'ios')).current;
  useEffect(() => { completion.attach(); return () => completion.dispose(); }, [completion]);
  const baseVersion = useRef(version);
  const draftKey = `accounting-editor:${initial.kind}:${version === null ? 'new' : initial.id}:${initial.documentId || 'manual'}`;
  useEffect(() => {
    let active = true;
    void work.repository.formDraft<Stored>(work.farmId, draftKey).then(saved => {
      if (!active) return;
      if (saved) { baseVersion.current = saved.version; latest.current = saved.value; setValue(saved.value); setRestored(true); setStale(saved.version !== version); }
      setLoaded(true);
    }).catch(work.setError);
    return () => { active = false; };
  }, [work.farmId, work.repository, draftKey, version]);
  function update(next: EditableInvoice) {
    latest.current = next; setValue(next);
    if (!completion.closeReview(reviewToken, hideReview)) setReview(null);
    void work.repository.saveFormDraft(work.farmId, draftKey, { value: next, version: baseVersion.current }).catch(work.setError);
  }
  function lineUpdate(id: string, patch: Partial<EditableLine>) { update({ ...latest.current, lines: latest.current.lines.map(line => line.id === id ? { ...line, ...patch } : line) }); }
  function prepare() {
    work.setError(null);
    try {
      const prepared = reviewedDraft(value, settings.currencies);
      for (const line of prepared.lines) if (line.taxRateBps && !settings.settings?.taxRates.some(rate => rate.rateBps === line.taxRateBps)) throw new Error('tax_rate_unconfigured');
      const token = completion.openReview();
      if (token !== null) { setReviewToken(token); setReview(prepared); setReviewVisible(true); }
    } catch (error) { work.setError(error); }
  }
  async function restoreUnconfirmed() {
    try {
      const actionKey = version === null ? `POST:/invoices:${value.id}` : `PATCH:/invoices/${initial.id}`;
      const saved = await work.repository.formDraft<{ body: string }>(work.farmId, `accounting-action:${actionKey}`);
      if (!saved) return;
      const draft = JSON.parse(saved.body) as InvoiceDraft; const scale = scaleFor(settings.currencies, draft.currency);
      update({ ...draft, id: value.id, kind: value.kind, lines: draft.lines.map(line => ({ ...line, discountAmount: fromMinor(line.discountMinor, scale) })) });
      work.setError(null);
    } catch (error) { work.setError(error); }
  }
  function hideReview() { setReviewVisible(false); if (Platform.OS !== 'ios') setReview(null); }
  async function save() {
    if (!review || stale) return;
    const prepared = review;
    await completion.run({
      reviewToken,
      attempt: async (): Promise<FormAttempt<Invoice>> => {
        let result: FormAttempt<Invoice> = { accepted: false };
        await work.onlineAction(async () => {
          const invoice = await persistAndSubmitDraft({
            // A fresh draft's identity is persisted before its first request, including untouched defaults.
            persist: () => work.repository.saveFormDraft(work.farmId, draftKey, { value, version }),
            submit: () => {
              if (version === null) return accountingMutation<Invoice>(work, '/invoices', prepared, 'POST', prepared.id);
              const { kind: _kind, ...body } = prepared;
              return accountingMutation<Invoice>(work, `/invoices/${initial.id}`, { ...body, version }, 'PATCH');
            },
            clear: () => work.repository.saveFormDraft(work.farmId, draftKey, null),
            cleanupError: work.setError,
          });
          result = { accepted: true, result: invoice };
        });
        return result;
      },
      accepted: () => {}, reset: () => {}, hideReview,
      saved: onSaved, busy: setSending, error: work.setError,
    });
  }
  if (!loaded) return <Notice text={work.error ? errorText(language, work.error) : t.loading} error={Boolean(work.error)} />;
  const currency = settings.currencies.find(item => item.code === value.currency);
  let totals: ReturnType<typeof invoiceTotals> | null = null;
  try { totals = invoiceTotals(reviewedDraft(value, settings.currencies).lines, currency!.minorUnit); } catch { /* Incomplete inputs do not invent a total. */ }
  const lineAccounts = accounts.filter(account => account.active && account.type === (value.kind === 'purchase' ? 'expense' : 'income'));
  const rates = [{ value: '0', label: '0%' }, ...(settings.settings?.taxRates || []).filter(rate => rate.rateBps !== 0).map(rate => ({ value: String(rate.rateBps), label: `${rate.name} · ${rate.rateBps / 100}%` }))];
  return <>
    {restored ? <Notice text={c(language, 'draftRestored')} /> : null}
    {stale ? <><Notice error text={c(language, 'invoice_conflict')} /><Button secondary title={c(language, 'discardLocalChanges')} onPress={() => { baseVersion.current = version; update(initial); setStale(false); setRestored(false); }} /></> : null}
    <Notice text={c(language, 'savedDraftOnly')} />
    {work.error ? <Notice error text={errorText(language, work.error)} /> : null}
    {work.error instanceof Error && work.error.message === 'accounting_pending_review' ? <Button secondary title={c(language, 'restoreUnconfirmedDraft')} onPress={() => { void restoreUnconfirmed(); }} /> : null}
    <Card title={c(language, value.kind === 'purchase' ? 'supplierBills' : 'salesInvoices')}>
      <Field testID="invoice-party" label={`${c(language, 'partyName')} *`} value={value.party.name} onChangeText={name => update({ ...value, party: { ...value.party, name } })} maxLength={160} />
      <Field testID="invoice-reference" label={c(language, 'reference')} value={value.reference} onChangeText={reference => update({ ...value, reference })} maxLength={100} />
      <Choice testID="invoice-currency" label={c(language, 'currency')} value={value.currency} onChange={currency => update({ ...value, currency })} closeLabel={t.close} options={[{ value: '', label: t.choose }, ...settings.currencies.map(item => ({ value: item.code, label: item.code }))]} />
      <Field testID="invoice-issue-date" label={c(language, 'issueDate')} hint="YYYY-MM-DD" value={value.issueDate} onChangeText={issueDate => update({ ...value, issueDate })} maxLength={10} />
      <Field testID="invoice-due-date" label={c(language, 'dueDate')} hint="YYYY-MM-DD" value={value.dueDate || ''} onChangeText={dueDate => update({ ...value, dueDate: dueDate || null })} maxLength={10} />
      <Field label={c(language, 'partyAddress')} value={value.party.address} multiline onChangeText={address => update({ ...value, party: { ...value.party, address } })} maxLength={500} />
      <Field label={c(language, 'partyEmail')} value={value.party.email} keyboardType="email-address" autoCapitalize="none" onChangeText={email => update({ ...value, party: { ...value.party, email } })} maxLength={254} />
      <Field label={c(language, 'partyPhone')} value={value.party.phone} keyboardType="phone-pad" onChangeText={phone => update({ ...value, party: { ...value.party, phone } })} maxLength={50} />
      <Field label={c(language, 'partyTaxNumber')} value={value.party.taxNumber} onChangeText={taxNumber => update({ ...value, party: { ...value.party, taxNumber } })} maxLength={100} />
    </Card>
    {value.lines.map((line, index) => <Card key={line.id} title={`${c(language, 'invoiceLine')} ${index + 1}`}>
      <Field testID={`invoice-line-${index}-description`} label={c(language, 'description')} value={line.description} onChangeText={description => lineUpdate(line.id, { description })} maxLength={500} />
      <Field testID={`invoice-line-${index}-quantity`} label={c(language, 'quantity')} value={line.quantity} keyboardType="decimal-pad" onChangeText={quantity => lineUpdate(line.id, { quantity })} maxLength={40} />
      <Field testID={`invoice-line-${index}-price`} label={`${c(language, 'unitPrice')} (${value.currency || '—'})`} value={line.unitPrice} keyboardType="decimal-pad" onChangeText={unitPrice => lineUpdate(line.id, { unitPrice })} maxLength={40} />
      <Field label={c(language, 'discountAmount')} value={line.discountAmount} keyboardType="decimal-pad" onChangeText={discountAmount => lineUpdate(line.id, { discountAmount })} maxLength={40} />
      <Choice testID={`invoice-line-${index}-tax`} label={c(language, 'taxPercent')} value={line.taxRateBps === null ? '' : String(line.taxRateBps)} onChange={rate => lineUpdate(line.id, { taxRateBps: rate === '' ? null : Number(rate) })} closeLabel={t.close} options={[{ value: '', label: t.choose }, ...rates]} />
      <Choice label={c(language, 'accountCode')} value={line.accountCode} onChange={accountCode => lineUpdate(line.id, { accountCode })} closeLabel={t.close} options={lineAccounts.map(account => ({ value: account.code, label: `${account.code} · ${account.name}` }))} />
      <Choice label={c(language, 'projectId')} value={line.projectId || ''} onChange={projectId => lineUpdate(line.id, { projectId: projectId || null })} closeLabel={t.close} options={[{ value: '', label: '—' }, ...projectOptions(work)]} />
      <Button secondary title={t.remove} disabled={sending} onPress={() => update({ ...value, lines: value.lines.filter(item => item.id !== line.id) })} />
    </Card>)}
    <Button testID="invoice-add-line" secondary title={c(language, 'addInvoiceLine')} disabled={value.lines.length >= 100 || sending} onPress={() => update({ ...value, lines: [...value.lines, newInvoiceLine(value.kind, Crypto.randomUUID(), value.lines[0]?.projectId || null)] })} />
    {sources.length || value.sourceEntryId ? <><Choice label={c(language, 'sourceEntryId')} value={value.sourceEntryId || ''} onChange={sourceEntryId => update({ ...value, sourceEntryId: sourceEntryId || null })} closeLabel={t.close} options={[{ value: '', label: c(language, 'newAccountingEntry') }, ...sources]} />{sources.some(source => source.disabled) ? <Notice text={c(language, 'source_currency_precision')} /> : null}{value.sourceEntryId ? <Notice text={c(language, 'sourceAttributionHint')} /> : null}</> : null}
    <Field label={c(language, 'terms')} value={value.terms} multiline onChangeText={terms => update({ ...value, terms })} maxLength={2000} />
    <Field label={c(language, 'notes')} value={value.notes} multiline onChangeText={notes => update({ ...value, notes })} maxLength={2000} />
    {totals && currency ? <Totals language={language} currency={value.currency} scale={currency.minorUnit} totals={totals} /> : null}
    <Text style={styles.caption}>{c(language, 'accountingDraftPrivacy')}</Text>
    <Button testID="invoice-review-draft" title={c(language, 'saveInvoiceDraft')} disabled={stale || !work.online || !settings.configured} busy={sending} onPress={prepare} />
    <Sheet key={reviewToken} title={c(language, 'review')} visible={reviewVisible} onClose={() => { completion.closeReview(reviewToken, hideReview); }} onDismiss={() => { if (completion.dismissed(reviewToken)) setReview(null); }} dismissible={!sending} closeLabel={t.close} keyboardDismissLabel={t.hideKeyboard}>
      {work.error ? <Notice error text={errorText(language, work.error)} /> : null}
      <Notice text={c(language, 'savedDraftOnly')} />
      {review ? <><Text style={styles.heading}>{review.party.name}</Text><Text style={styles.text}>{review.reference} · {review.issueDate}</Text>{review.lines.map(line => <View key={line.id} style={styles.item}><Text style={styles.text}>{line.description}</Text><Text style={styles.text}>{line.quantity} × {review.currency} {line.unitPrice}</Text></View>)}<Totals language={language} totals={invoiceTotals(review.lines, scaleFor(settings.currencies, review.currency))} currency={review.currency} scale={scaleFor(settings.currencies, review.currency)} /></> : null}
      <Button testID="invoice-confirm-draft" title={c(language, 'confirm')} busy={sending} disabled={!work.online} onPress={() => { void save(); }} />
    </Sheet>
  </>;
}
