/** Wall-clock farm time. Never interpret datetime-local in the owner's device zone. */
export function localDateTime(value: Date | string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(new Date(value));
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}
export function farmTimeToUtc(value: string, timeZone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('invalid_time');
  const parts = match.slice(1).map(Number);
  const target = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4]);
  const calendar = new Date(target);
  if (calendar.toISOString().slice(0, 16) !== value) throw new Error('invalid_time');
  let candidate = target;
  for (let i = 0; i < 4; i++) {
    const observed = Date.parse(`${localDateTime(new Date(candidate), timeZone)}:00Z`);
    candidate += target - observed;
  }
  if (localDateTime(new Date(candidate), timeZone) !== value) throw new Error('invalid_time');
  return new Date(candidate).toISOString();
}
export function farmDate(value: Date | string, timeZone: string): string {return localDateTime(value, timeZone).slice(0, 10);}
/** Numeric dates avoid an English month-name fallback on browsers without nd/sn ICU data. */
export function displayTime(value: string, _language: 'sn' | 'nd', timeZone: string): string {
  if (!Number.isFinite(new Date(value).getTime())) return '—';
  const wall = localDateTime(value, timeZone);
  return `${wall.slice(8, 10)}/${wall.slice(5, 7)}/${wall.slice(0, 4)} ${wall.slice(11, 16)}`;
}
export function displayDate(value: string, _language: 'sn' | 'nd'): string {
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) return '—';
  return `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
}
export function displayNumber(value: unknown, language: 'sn' | 'nd', decimals = 3): string {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat(`${language}-ZW`, {maximumFractionDigits: decimals}).format(Number(value));
}
export function displayMoney(value: unknown, currency: string, language: 'sn' | 'nd'): string {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '—';
  const digits = currencyMinorUnit(currency);
  return `${currency} ${new Intl.NumberFormat(`${language}-ZW`, {minimumFractionDigits: digits, maximumFractionDigits: digits}).format(Number(value))}`;
}

/** Legacy operational reports retain the precision of the explicitly recorded currency. */
export function currencyMinorUnit(currency: string): number {
  try {return new Intl.NumberFormat('en', {style: 'currency', currency}).resolvedOptions().maximumFractionDigits ?? 2;}
  catch {return 2;}
}
