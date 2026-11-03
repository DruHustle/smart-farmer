import type { ApiClient } from './api';
import type { Language } from './types';
import { farmTimeToIso } from './time';

export type Row = { id?: string; version?: number; [key: string]: unknown };
export type Page<T> = { items: T[]; nextCursor?: string | null };
export type Option = { value: string; label: string };
export type FormField = {
  key: string; label?: string; type?: 'text' | 'number' | 'integer' | 'date' | 'time' | 'datetime' | 'boolean' | 'choice' | 'multi' | 'rows' | 'password';
  required?: boolean; multiline?: boolean; minimum?: number; maximum?: number; maxLength?: number;
  options?: Option[]; fields?: FormField[]; initial?: unknown; hint?: string;
};
export function string(value: unknown): string { return value === null || value === undefined ? '' : String(value); }
export function rows(value: unknown): Row[] { return Array.isArray(value) ? value.filter((row): row is Row => Boolean(row && typeof row === 'object' && !Array.isArray(row))) : []; }
export function object(value: unknown): Row { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
export function number(value: unknown): number { const n = Number(value); if (!Number.isFinite(n)) throw new Error('invalid_number'); return n; }
export function numberText(value: unknown, language: Language): string { if (value === null || value === undefined || value === '') return '—'; const n = Number(value); return Number.isFinite(n) ? new Intl.NumberFormat(`${language}-ZW`, { maximumFractionDigits: 4 }).format(n) : string(value); }
export function initials(fields: FormField[], existing: Row = {}): Row {
  return Object.fromEntries(fields.map(field => [field.key, existing[field.key] ?? field.initial ?? (field.type === 'boolean' ? false : field.type === 'multi' ? [] : field.type === 'rows' ? [] : '')]));
}
export function parseFields(fields: FormField[], values: Row, timezone: string): Row {
  const body: Row = {};
  for (const field of fields) {
    const raw = values[field.key];
    if (field.type === 'boolean') { body[field.key] = raw === true; if (field.required && raw !== true) throw new Error('required'); continue; }
    if (field.type === 'rows') {
      const items = rows(raw);
      if (field.required && items.length === 0) throw new Error('required');
      body[field.key] = items.map(item => parseFields(field.fields || [], item, timezone)); continue;
    }
    if (field.type === 'multi') { const selected = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []; if (field.required && !selected.length) throw new Error('required'); if (selected.some(item => !field.options?.some(option => option.value === item))) throw new Error('invalid_input'); body[field.key] = selected; continue; }
    const value = string(raw).trim();
    if (!value) { if (field.required) throw new Error('required'); continue; }
    if (field.type === 'number' || field.type === 'integer') {
      if (!/^-?\d+(?:[.,]\d+)?$/.test(value)) throw new Error('invalid_number');
      const numeric = Number(value.replace(',', '.'));
      if (!Number.isFinite(numeric) || field.type === 'integer' && !Number.isInteger(numeric) || numeric < (field.minimum ?? 0) || field.maximum !== undefined && numeric > field.maximum) throw new Error('invalid_number');
      body[field.key] = numeric;
    } else if (field.type === 'datetime') body[field.key] = farmTimeToIso(value, timezone);
    else if (field.type === 'date') { if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('invalid_date'); body[field.key] = value; }
    else if (field.type === 'time') { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('invalid_date'); body[field.key] = value; }
    else if (field.type === 'choice') { if (!field.options?.some(option => option.value === value)) throw new Error('invalid_input'); body[field.key] = value; }
    else { if (value.length > (field.maxLength ?? 4000)) throw new Error('invalid_input'); body[field.key] = value; }
  }
  return body;
}
/** Follow server cursors, detect loops, and never silently truncate a private history. */
export async function allPages<T>(api: ApiClient, path: string): Promise<T[]> {
  const values: T[] = []; const seen = new Set<string>(); let cursor: string | undefined;
  do {
    const next = `${path}${path.includes('?') ? '&' : '?'}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page = await api.request<Page<T>>(next);
    values.push(...page.items);
    cursor = page.nextCursor || undefined;
    if (cursor && seen.has(cursor)) throw new Error('request_failed');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return values;
}
