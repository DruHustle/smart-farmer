import {useRef, type ReactNode} from 'react';
import {useFarm} from '../context';
import {label} from '../locales';
import {jsonBody, apiOrigin, ApiError} from '../lib/api';
import {displayDate, displayNumber, displayTime, farmTimeToUtc, localDateTime} from '../lib/time';
import {Badge, Field, Form, Submit} from './ui';
export type Row = {id: string; [key: string]: unknown};
export const text = (value: unknown) => value === null || value === undefined ? '' : String(value);
export const rows = (value: unknown): Row[] => Array.isArray(value) ? value as Row[] : [];
export const asObject = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function EnumSelect({name, values, initial, required = false}: {name: string; values: string[]; initial?: string; required?: boolean}) {const {t} = useFarm(); return <select name={name} defaultValue={initial} required={required}>{values.map(value => <option value={value} key={value}>{label(t, value)}</option>)}</select>;}
export function TimeField({name = 'observedAt', title, initial, required = true}: {name?: string; title?: string; initial?: string | null; required?: boolean}) {const {farm, t} = useFarm(); return <Field label={title ?? t.when} hint={`${t.farmTime}: ${farm.timezone}`}><input type="datetime-local" name={name} required={required} defaultValue={initial === null ? '' : localDateTime(initial ?? new Date(), farm.timezone)}/></Field>;}
export const timestamp = (form: FormData, name: string, timezone: string) => form.get(name) ? farmTimeToUtc(String(form.get(name)), timezone) : undefined;
export function ResourceState({savedAt, failed, loading}: {savedAt?: string; failed?: boolean; loading?: boolean}) {const {t, lang, farm, online} = useFarm(); return <div className="resource-state" aria-live="polite">{loading ? t.loading : failed ? t.limitedSync : !online ? t.offlineOnlyRecords : ''}{savedAt && <small>{t.lastUpdated}: {displayTime(savedAt, lang, farm.timezone)}</small>}</div>;}
export function MoreButton({nextCursor, more, moreBusy}: {nextCursor?: string | null; more: () => Promise<void>; moreBusy?: boolean}) {const {t, online} = useFarm(); return nextCursor ? <button className="secondary load-more" disabled={!online || moreBusy} onClick={() => void more()}>{t.loadMore}</button> : null;}
/** Keep the same request identity after a lost response; allocate a new identity only after success. */
export function ActionForm({path, build, after, children, method = 'POST', actionLabel, queued = false, queueLabel = 'records', className = '', onResult}: {path: string; build: (form: FormData, id: string) => unknown; after?: () => Promise<void> | void; children: ReactNode; method?: 'POST' | 'PATCH'; actionLabel?: string; queued?: boolean; queueLabel?: string; className?: string; onResult?: (value: unknown) => void}) {
  const {run, call, t, online, enqueue, farm, notify} = useFarm(); const requestId = useRef(crypto.randomUUID());
  return <Form className={className} onSubmit={async (f, form) => {const ok = await run(async () => {
    const payload = build(f, requestId.current);
    if (queued) await enqueue({id: requestId.current, farmId: farm.id, path, method, payload: payload as Record<string, unknown>, label: queueLabel});
    else {if (!online) throw new Error('online_required'); const result = await call(path, jsonBody(payload, method)); onResult?.(result);}
    requestId.current = crypto.randomUUID(); try {await after?.();} catch {notify(t.limitedSync);}
  }, queued ? t.queued : t.saved); if (ok) form.reset();}}>{children}<Submit>{actionLabel ?? t.save}</Submit>{!queued && !online && <small>{t.online_required}</small>}</Form>;
}
export function Facts({entries}: {entries: Array<[string, unknown, ('date' | 'time' | 'number' | 'label')?]>}) {const {t, farm, lang} = useFarm(); return <dl className="facts-grid">{entries.filter(([, value]) => value !== undefined).map(([key, value, type], index) => <div key={`${key}-${index}`}><dt>{label(t, key)}</dt><dd>{value === null || value === '' ? t.unknown : type === 'time' ? displayTime(text(value), lang, farm.timezone) : type === 'date' ? displayDate(text(value), lang) : type === 'number' ? displayNumber(value, lang) : type === 'label' ? label(t, text(value)) : text(value)}</dd></div>)}</dl>;}
export function Status({value}: {value: unknown}) {const {t} = useFarm(); return value ? <Badge value={label(t, text(value))}/> : null;}
export function DataTable({title, columns, items}: {title: string; columns: Array<{key: string; title: string; format?: 'number' | 'money' | 'time' | 'label'}>; items: Array<Record<string, unknown>>}) {const {t, lang, farm} = useFarm(); return <div className="table-scroll"><table><caption>{title}</caption><thead><tr>{columns.map(c => <th key={c.key} scope="col">{c.title}</th>)}</tr></thead><tbody>{items.map((item, i) => <tr key={text(item.id) || i}>{columns.map(c => <td key={c.key}>{item[c.key] === undefined || item[c.key] === null ? '—' : c.format === 'label' ? label(t, text(item[c.key])) : c.format === 'time' ? displayTime(text(item[c.key]), lang, farm.timezone) : c.format === 'number' || c.format === 'money' ? displayNumber(item[c.key], lang, c.format === 'money' ? 2 : 3) : text(item[c.key])}</td>)}</tr>)}</tbody></table>{!items.length && <p className="muted">{t.noData}</p>}</div>;}
export async function downloadPrivate(path: string, token: string, filename: string) {
  const response = await fetch(apiOrigin + path, {headers: {Authorization: `Bearer ${token}`}, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(30_000)});
  if (!response.ok) {const body = await response.json().catch(() => ({})); throw new ApiError(body.error ?? 'error', response.status);}
  const url = URL.createObjectURL(await response.blob()); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 3000);
}
