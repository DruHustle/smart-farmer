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
export function displayTime(value: string, language: 'sn' | 'nd', timeZone: string): string {
  if (!Number.isFinite(new Date(value).getTime())) return '—';
  return new Intl.DateTimeFormat(`${language}-ZW`, {timeZone, dateStyle: 'medium', timeStyle: 'short'}).format(new Date(value));
}
export function displayDate(value: string, language: 'sn' | 'nd'): string {
  return new Intl.DateTimeFormat(`${language}-ZW`, {timeZone: 'UTC', dateStyle: 'medium'}).format(new Date(`${value.slice(0, 10)}T12:00:00Z`));
}
