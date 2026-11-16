import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { ApiError } from '../api';
import { actionBody, definiteAccountingRejection, money, type Currency, type CurrencyScale, type InvoiceSnapshot, type InvoiceTotals } from '../accounting';
import { c, farmPath } from '../completion-ui';
import { textFor } from '../i18n';
import { object, rows, string } from '../product';
import type { Language } from '../types';
import type { Workspace } from '../use-workspace';
import { Button, Card, Notice, Sheet, styles } from '../ui';

export const accountingPath = (work: Workspace, suffix = '') => farmPath(work, `/accounting${suffix}`);
const inFlight = new WeakMap<object, Map<string, { body: string; result: Promise<unknown> }>>();
export async function accountingMutation<T>(work: Workspace, suffix: string, body: Record<string, unknown>, method = 'POST', fixedId?: string): Promise<T> {
  const { id: _ignored, ...intent } = body;
  const key = `${method}:${suffix}${fixedId ? `:${fixedId}` : ''}`; const activeKey = `${work.farmId}:${key}`; const serialized = JSON.stringify(intent);
  let requests = inFlight.get(work.repository); if (!requests) { requests = new Map(); inFlight.set(work.repository, requests); }
  const active = requests.get(activeKey);
  if (active) { if (active.body !== serialized) throw new Error('accounting_pending_review'); return active.result as Promise<T>; }
  const run = async () => {
    const payload = await actionBody(work.repository, work.farmId, key, intent, () => fixedId || Crypto.randomUUID());
    try {
      const result = await work.api.request<T>(accountingPath(work, suffix), method, payload);
      // A committed action stays successful even if local cleanup fails. Its exact retry remains safe.
      void work.repository.saveFormDraft(work.farmId, `accounting-action:${key}`, null).catch(work.setError);
      return result;
    } catch (error) {
      // Only a definitive rejection resolves this intent; authorization, rate limits and interrupted replays do not.
      if (error instanceof ApiError && definiteAccountingRejection(error)) await work.repository.saveFormDraft(work.farmId, `accounting-action:${key}`, null);
      throw error;
    }
  };
  const result = run().finally(() => requests!.delete(activeKey)); requests.set(activeKey, { body: serialized, result });
  return result;
}
export function Amount({ label, value, currency, scale, testID }: { label: string; value: string; currency: string; scale: CurrencyScale; testID?: string }) {
  return <View style={styles.between}><Text style={styles.label}>{label}</Text><Text testID={testID} selectable style={styles.text}>{money(value, currency, scale)}</Text></View>;
}
export function Totals({ totals, currency, scale, language }: { totals: InvoiceTotals; currency: string; scale: CurrencyScale; language: Language }) {
  return <Card><Amount label={c(language, 'subtotal')} value={totals.subtotalMinor} currency={currency} scale={scale} /><Amount label={c(language, 'discountAmount')} value={totals.discountMinor} currency={currency} scale={scale} /><Amount label={c(language, 'taxTotal')} value={totals.taxMinor} currency={currency} scale={scale} /><Amount testID="invoice-total" label={c(language, 'invoiceTotal')} value={totals.totalMinor} currency={currency} scale={scale} /></Card>;
}
export function InvoicePreview({ invoice, language, draft = false }: { invoice: InvoiceSnapshot; language: Language; draft?: boolean }) {
  return <>
    {draft ? <Notice text={c(language, 'savedDraftOnly')} /> : null}
    {invoice.rounding === 'credit_proportional' ? <Notice text={c(language, 'creditProportional')} /> : null}
    <Card title={invoice.number || c(language, 'invoiceDraft')}>
      <Text selectable style={styles.heading}>{invoice.issuer.legalName}</Text><Text selectable style={styles.text}>{[invoice.issuer.address, invoice.issuer.email, invoice.issuer.phone, invoice.issuer.taxNumber].filter(Boolean).join('\n')}</Text>
      <Text selectable style={styles.heading}>{invoice.party.name}</Text><Text selectable style={styles.text}>{[invoice.party.address, invoice.party.email, invoice.party.phone, invoice.party.taxNumber].filter(Boolean).join('\n')}</Text>
      <Text style={styles.text}>{c(language, 'reference')}: {invoice.reference || '—'}</Text>
      <Text style={styles.text}>{c(language, 'issueDate')}: {invoice.issueDate}</Text><Text style={styles.text}>{c(language, 'dueDate')}: {invoice.dueDate || '—'}</Text>
      {invoice.postingDate && invoice.postingDate !== invoice.issueDate ? <Text style={styles.text}>{c(language, 'postedOn')}: {invoice.postingDate}</Text> : null}
    </Card>
    {invoice.lines.map(line => <Card key={line.id} title={line.description}>{invoice.rounding === 'credit_proportional' ? <><Amount label={c(language, 'subtotal')} value={line.netMinor} currency={invoice.currency} scale={invoice.minorUnit} /><Amount label={c(language, 'taxTotal')} value={line.taxMinor} currency={invoice.currency} scale={invoice.minorUnit} /></> : <><Text style={styles.text}>{line.quantity} × {invoice.currency} {line.unitPrice}</Text><Text style={styles.text}>{c(language, 'taxPercent')}: {line.taxRateBps / 100}%</Text><Amount label={c(language, 'discountAmount')} value={line.discountMinor} currency={invoice.currency} scale={invoice.minorUnit} /></>}<Amount label={c(language, 'invoiceTotal')} value={line.totalMinor} currency={invoice.currency} scale={invoice.minorUnit} /></Card>)}
    <Totals totals={invoice.totals} currency={invoice.currency} scale={invoice.minorUnit} language={language} />
    {invoice.terms ? <Card title={c(language, 'terms')}><Text selectable style={styles.text}>{invoice.terms}</Text></Card> : null}
    {invoice.notes ? <Card title={c(language, 'notes')}><Text selectable style={styles.text}>{invoice.notes}</Text></Card> : null}
  </>;
}

/** Non-invoice actions also retain a visible exact-replay path after navigation/restart. */
export function PendingAccountingActions({ work, language, paths, currencies, onResolved }: { work: Workspace; language: Language; paths: { suffix: string; method?: string; label: string }[]; currencies: Currency[]; onResolved: (suffix: string) => void }) {
  type Pending = { suffix: string; method: string; label: string; id: string; body: Record<string, unknown> };
  const [pending, setPending] = useState<Pending[]>([]); const [review, setReview] = useState<Pending | null>(null);
  const identity = JSON.stringify(paths);
  useEffect(() => {
    let active = true;
    void Promise.all(paths.map(async path => { const method = path.method || 'POST'; const saved = await work.repository.formDraft<{ id: string; body: string }>(work.farmId, `accounting-action:${method}:${path.suffix}`); return saved ? { ...path, method, id: saved.id, body: JSON.parse(saved.body) as Record<string, unknown> } : null; })).then(values => { if (active) setPending(values.filter((value): value is Pending => value !== null)); }).catch(work.setError);
    return () => { active = false; };
  }, [work.farmId, work.repository, identity, work.error]);
  if (!pending.length) return null;
  const t = textFor(language); const currency = currencies.find(item => item.code === review?.body.currency);
  return <Card title={c(language, 'unconfirmedAction')}><Notice text={c(language, 'accounting_pending_review')} />{pending.map(item => <Button key={item.id} secondary title={`${item.label} · ${c(language, 'review')}`} onPress={() => setReview(item)} />)}
    <Sheet title={c(language, 'unconfirmedAction')} visible={Boolean(review)} onClose={() => { if (!work.busy) setReview(null); }} closeLabel={t.close} keyboardDismissLabel={t.hideKeyboard}>
      {review ? <>
        <Text style={styles.heading}>{review.label}</Text>
        {['currency', 'postedOn', 'description', 'reason', 'code', 'name', 'type', 'defaultCurrency', 'invoicePrefix', 'lockedThrough'].filter(key => review.body[key] !== undefined && review.body[key] !== null).map(key => <Text key={key} selectable style={styles.text}>{c(language, key)}: {string(review.body[key])}</Text>)}
        {review.body.business ? <Card>{Object.entries(object(review.body.business)).filter(([, value]) => value).map(([key, value]) => <Text key={key} selectable style={styles.text}>{c(language, key)}: {string(value)}</Text>)}</Card> : null}
        {rows(review.body.taxRates).map((rate, index) => <Text key={index} style={styles.text}>{string(rate.name)} · {Number(rate.rateBps) / 100}%</Text>)}
        {rows(review.body.lines).map((line, index) => <Card key={index}><Text style={styles.text}>{string(line.accountCode)} · {string(line.description)}</Text>{currency ? <><Amount label={c(language, 'debit')} value={string(line.debitMinor)} currency={currency.code} scale={currency.minorUnit} /><Amount label={c(language, 'credit')} value={string(line.creditMinor)} currency={currency.code} scale={currency.minorUnit} /></> : null}</Card>)}
        <Text selectable style={styles.caption}>{review.id}</Text>
        <Button title={c(language, 'retrySameRequest')} disabled={!work.online} busy={work.busy} onPress={() => { void work.onlineAction(async () => {
          await accountingMutation(work, review.suffix, review.body, review.method);
          setPending(values => values.filter(item => item.id !== review.id)); setReview(null); onResolved(review.suffix);
        }); }} />
      </> : null}
    </Sheet>
  </Card>;
}
