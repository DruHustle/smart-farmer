import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { errorText, label, textFor } from './i18n';
import { completionText } from './completion-i18n';
import { formatFarmTime } from './time';
import { initials, numberText, object, parseFields, rows, string, type FormField, type Row } from './product';
import type { Language } from './types';
import type { Workspace } from './use-workspace';
import { Button, Card, Choice, Field, Notice, Sheet, Toggle, styles } from './ui';

export function c(language: Language, key: string): string { return completionText(language, key) ?? label(language, key); }
export function options(language: Language, values: readonly string[]) { return values.map(value => ({ value, label: c(language, value) })); }
export function farmPath(work: Workspace, suffix = '') { return `/v1/farms/${work.farmId}${suffix}`; }
export function projectOptions(work: Workspace) { return (work.snapshot?.projects || []).map(value => ({ value: value.id, label: value.name })); }
export function memberOptions(work: Workspace) { return (work.snapshot?.members || []).map(value => ({ value: value.id, label: value.username })); }
export function assetOptions(work: Workspace) { return (work.snapshot?.assets || []).map(value => ({ value: value.id, label: value.name })); }
export const textField = (key: string, required = false, extra: Partial<FormField> = {}): FormField => ({ key, required, ...extra });
export const numericField = (key: string, required = false, extra: Partial<FormField> = {}): FormField => ({ key, type: 'number', required, ...extra });
export const dateField = (key: string, required = true): FormField => ({ key, type: 'datetime', required });
export const selectField = (key: string, values: { value: string; label: string }[], required = false): FormField => ({ key, type: 'choice', options: values, required });

export function Fields({ fields, value, onChange, language, prefix = 'form' }: { fields: FormField[]; value: Row; onChange: (value: Row) => void; language: Language; prefix?: string }) {
  const t = textFor(language);
  return <>{fields.map(field => {
    if (field.when && value[field.when.key] !== field.when.equals) return null;
    const title = field.label || c(language, field.key);
    const update = (next: unknown) => onChange({ ...value, [field.key]: next });
    const id = `${prefix}-${field.key}`;
    if (field.type === 'rows') return <Card key={field.key} title={title}>{rows(value[field.key]).map((row, index) => <View key={index} style={[styles.item, { gap: 12 }]}><Fields fields={field.fields || []} value={row} onChange={next => update(rows(value[field.key]).map((item, i) => i === index ? next : item))} language={language} prefix={`${id}-${index}`} /><Button secondary title={t.remove} onPress={() => update(rows(value[field.key]).filter((_, i) => i !== index))} /></View>)}<Button testID={`${id}-add`} secondary title={c(language, 'add')} onPress={() => update([...rows(value[field.key]), initials(field.fields || [])])} /></Card>;
    if (field.type === 'boolean') return <Toggle key={field.key} label={title} hint={field.hint} value={value[field.key] === true} onChange={update} />;
    if (field.type === 'multi') return <Card key={field.key} title={title}>{(field.options || []).map(option => <Toggle key={option.value} label={option.label} value={Array.isArray(value[field.key]) && (value[field.key] as unknown[]).includes(option.value)} onChange={checked => { const selected = Array.isArray(value[field.key]) ? value[field.key] as string[] : []; update(checked ? [...selected, option.value] : selected.filter(item => item !== option.value)); }} />)}</Card>;
    if (field.type === 'choice') return <Choice key={field.key} testID={id} label={title} value={string(value[field.key])} options={[{ value: '', label: field.required ? t.choose : '—' }, ...(field.options || [])]} onChange={update} closeLabel={t.close} />;
    return <Field key={field.key} testID={id} label={`${title}${field.required ? ' *' : ''}`} value={string(value[field.key])} onChangeText={update} hint={field.hint || (field.type === 'datetime' ? t.farmTimeHint : field.type === 'date' ? 'YYYY-MM-DD' : field.type === 'time' ? 'HH:MM' : undefined)} multiline={field.multiline} secureTextEntry={field.type === 'password'} autoCapitalize={field.key.toLowerCase().includes('currency') ? 'characters' : 'none'} autoCorrect={field.type !== 'password'} keyboardType={field.type === 'number' ? 'decimal-pad' : field.type === 'integer' ? 'number-pad' : 'default'} maxLength={field.maxLength || 4000} />;
  })}</>;
}

export function Form({ work, language, title, fields, initial = {}, submit, onSaved, hint, confirmation = true, includeId = true, offline = false, draftKey }: { work: Workspace; language: Language; title?: string; fields: FormField[]; initial?: Row; submit: (body: Row) => Promise<unknown>; onSaved?: (result: unknown) => void | Promise<void>; hint?: string; confirmation?: boolean; includeId?: boolean; offline?: boolean; draftKey?: string }) {
  const [values, setValues] = useState<Row>(() => initials(fields, initial));
  const [review, setReview] = useState<Row | null>(null);
  const [sending, setSending] = useState(false);
  const id = useRef(Crypto.randomUUID()); const t = textFor(language);
  const draftReady = useRef(!draftKey);
  const [draftLoaded, setDraftLoaded] = useState(!draftKey);
  useEffect(() => { let active = true; if (draftKey) void work.repository.formDraft<{ id: string; values: Row }>(work.farmId, draftKey).then(saved => { if (active && saved) { id.current = saved.id; setValues(saved.values); } if (active) { draftReady.current = true; setDraftLoaded(true); } }).catch(work.setError); return () => { active = false; }; }, [draftKey, work.farmId]);
  const updateValues = (next: Row) => { setValues(next); if (draftKey && draftReady.current) void work.repository.saveFormDraft(work.farmId, draftKey, { id: id.current, values: next }).catch(work.setError); };
  async function send(body: Row) {
    if (sending) return;
    setSending(true);
    const run = async () => { const result = await submit({ ...(includeId ? { id: id.current } : {}), ...body }); if (onSaved) await onSaved(result); };
    let success = false;
    if (offline) { try { await run(); success = true; } catch (error) { work.setError(error); } } else success = await work.onlineAction(run);
    if (success) { id.current = Crypto.randomUUID(); setReview(null); updateValues(initials(fields, initial)); }
    setSending(false);
  }
  function prepare() { work.setError(null); try { const body = parseFields(fields, values, work.snapshot?.farm.timezone || 'Africa/Harare'); if (confirmation) setReview(body); else void send(body); } catch (error) { work.setError(error); } }
  if (!draftLoaded) return <Card title={title}>{work.error ? <Notice error text={errorText(language, work.error)} /> : <Text style={styles.muted}>{t.loading}</Text>}</Card>;
  return <Card title={title}>{work.error ? <Notice error text={errorText(language, work.error)} /> : null}{hint ? <Notice text={hint} /> : null}<Fields fields={fields} value={values} onChange={updateValues} language={language} /><Button testID="product-review" title={offline ? t.save : c(language, confirmation ? 'review' : 'confirm')} disabled={!offline && !work.online} busy={sending} onPress={prepare} /><Text style={styles.caption}>{offline ? t.savedLocally : c(language, 'onlineOnly')}</Text><Sheet title={c(language, 'review')} visible={Boolean(review)} onClose={() => setReview(null)} closeLabel={t.close}>{work.error ? <Notice error text={errorText(language, work.error)} /> : null}{review ? <FormSummary fields={fields} value={review} language={language} timezone={work.snapshot?.farm.timezone || 'Africa/Harare'} /> : null}<Button testID="product-confirm" title={c(language, 'confirm')} disabled={!offline && !work.online} busy={sending} onPress={() => { if (review) void send(review); }} /></Sheet></Card>;
}
function FormSummary({ fields, value, language, timezone }: { fields: FormField[]; value: Row; language: Language; timezone: string }) {
  return <>{fields.filter(field => field.type !== 'password' && value[field.key] !== undefined).map(field => <View key={field.key} style={styles.item}><Text style={styles.label}>{field.label || c(language, field.key)}</Text>{field.type === 'rows' ? rows(value[field.key]).map((item, i) => <Card key={i}><FormSummary fields={field.fields || []} value={item} language={language} timezone={timezone} /></Card>) : <Text style={styles.text}>{field.type === 'boolean' ? c(language, value[field.key] ? 'yes' : 'no') : field.type === 'datetime' ? formatFarmTime(string(value[field.key]), timezone, language) : field.type === 'choice' ? field.options?.find(option => option.value === value[field.key])?.label : field.type === 'multi' ? (value[field.key] as string[]).map(item => field.options?.find(option => option.value === item)?.label).join(' · ') : string(value[field.key])}</Text>}</View>)}</>;
}

export function Action({ work, language, title, detail, action, onSaved, danger = false }: { work: Workspace; language: Language; title: string; detail?: string; action: () => Promise<unknown>; onSaved?: () => void | Promise<void>; danger?: boolean }) {
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false);
  return <><Button secondary danger={danger} title={title} disabled={!work.online} onPress={() => { work.setError(null); setOpen(true); }} /><Sheet title={title} visible={open} onClose={() => setOpen(false)} closeLabel={textFor(language).close}>{work.error ? <Notice error text={errorText(language, work.error)} /> : null}<Notice text={detail || c(language, 'onlineOnly')} /><Button testID="action-confirm" title={c(language, 'confirm')} busy={busy} disabled={!work.online} onPress={() => { if (busy) return; setBusy(true); void work.onlineAction(async () => { await action(); await onSaved?.(); setOpen(false); }).finally(() => setBusy(false)); }} /></Sheet></>;
}

export function usePanel<T>(work: Workspace, key: string, read: () => Promise<T>) {
  const [value, setValue] = useState<T | null>(null); const [loading, setLoading] = useState(false);
  const epoch = useRef(0); const reader = useRef(read); reader.current = read;
  const reload = useCallback(async () => {
    const generation = ++epoch.current; const cacheKey = `farm:${work.farmId}:panel:${key}`;
    setLoading(true);
    try {
      const cached = await work.repository.preference<T>(cacheKey);
      if (generation !== epoch.current) return;
      setValue(cached);
      if (work.online) { const next = await reader.current(); if (generation !== epoch.current) return; await work.repository.setPreference(cacheKey, next); if (generation === epoch.current) setValue(next); }
    } catch (error) { if (generation === epoch.current) work.setError(error); }
    finally { if (generation === epoch.current) setLoading(false); }
  }, [work.farmId, work.online, work.repository, key]);
  useEffect(() => { setValue(null); void reload(); return () => { epoch.current++; }; }, [reload]);
  return { value, loading, reload };
}

export function Facts({ value, fields, language, timezone }: { value: Row; fields: string[]; language: Language; timezone?: string }) {
  return <>{fields.filter(key => value[key] !== undefined && value[key] !== null).map(key => {
    const v = value[key]; const labelKey = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    const shown = ['mortalityRate', 'hatchRate'].includes(key) ? `${numberText(Number(v) * 100, language)}%` : typeof v === 'boolean' ? c(language, v ? 'yes' : 'no') : typeof v === 'number' ? numberText(v, language) : /(_at|At)$/.test(key) && typeof v === 'string' && Number.isFinite(Date.parse(v)) && timezone ? formatFarmTime(v, timezone, language) : ['mortalityRate', 'hatchRate'].includes(key) ? `${numberText(Number(v) * 100, language)}%` : ['status', 'type', 'kind', 'category', 'mode', 'integration_state', 'delivery_state', 'state', 'severity', 'count_basis', 'countBasis', 'onboarding_mode'].includes(key) || key.endsWith('Fit') ? c(language, key === 'mode' && v === 'model' ? 'model_ai' : string(v)) : key === 'source' && ['manual', 'simulated', 'simulator', 'gateway', 'gauge'].includes(string(v)) ? c(language, string(v)) : string(v);
    if (typeof v === 'object') return null;
    return <View key={key} style={styles.item}><Text style={styles.caption}>{c(language, labelKey)}</Text><Text selectable style={styles.text}>{shown}</Text></View>;
  })}</>;
}

export function Records({ items, language, timezone, titleKey = 'title', fields = ['type', 'status', 'observed_at', 'note', 'quantity', 'unit', 'amount', 'currency'], children }: { items: Row[]; language: Language; timezone: string; titleKey?: string; fields?: string[]; children?: (item: Row) => React.ReactNode }) {
  const [visible, setVisible] = useState(40);
  useEffect(() => { setVisible(40); }, [items.length, items[0]?.id]);
  if (!items.length) return <Text style={styles.muted}>{textFor(language).empty}</Text>;
  return <>{items.slice(0, visible).map((item, index) => <Card key={string(item.id) || index} title={string(item[titleKey]) || (item.type ? c(language, string(item.type)) : undefined)}><Facts value={item} fields={fields} language={language} timezone={timezone} />{children?.(item)}</Card>)}{items.length > visible ? <Button secondary title={`${c(language, 'loadMore')} (${visible}/${items.length})`} onPress={() => setVisible(value => value + 40)} /> : null}</>;
}
