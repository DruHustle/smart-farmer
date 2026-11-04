function localParts(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

export function farmNow(timeZone: string, now: Date = new Date()): string {
  return localParts(now, timeZone);
}

/** Parse farm wall time without consulting the phone's timezone. Reject missing/ambiguous times. */
export function farmTimeToIso(value: string, timeZone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('invalid_date');
  const wall = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 16) !== value) throw new Error('invalid_date');
  let candidate = wall;
  for (let step = 0; step < 4; step++) {
    const rendered = localParts(new Date(candidate), timeZone);
    candidate += wall - Date.parse(`${rendered}:00Z`);
  }
  if (localParts(new Date(candidate), timeZone) !== value) throw new Error('invalid_date');
  for (const offset of [-120, -60, -30, 30, 60, 120]) {
    if (localParts(new Date(candidate + offset * 60_000), timeZone) === value) throw new Error('ambiguous_date');
  }
  return new Date(candidate).toISOString();
}

export function formatFarmTime(instant: string, timeZone: string, language: 'sn' | 'nd'): string {
  const date = new Date(instant);
  if (!Number.isFinite(date.valueOf())) return '—';
  // Numeric farm dates avoid an English month-name fallback on devices without sn/nd ICU data.
  const parts = localParts(date, timeZone);
  return `${parts.slice(8, 10)}/${parts.slice(5, 7)}/${parts.slice(0, 4)} ${parts.slice(11)}`;
}

export function optionalNumber(value: string, minimum = 0): number | null {
  if (!value.trim()) return null;
  if (!/^-?\d+(?:[.,]\d+)?$/.test(value.trim())) throw new Error('invalid_number');
  const result = Number(value.replace(',', '.'));
  if (!Number.isFinite(result) || result < minimum) throw new Error('invalid_number');
  return result;
}
