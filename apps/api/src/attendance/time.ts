/**
 * Time-zone helpers. Instants are stored in UTC; schedules are local wall-clock times in the
 * single group time zone (I18N-03, NFR-05).
 */

function parts(instant: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  return Object.fromEntries(f.formatToParts(instant).map((p) => [p.type, p.value])) as Record<string, string>;
}

export function localDate(instant: Date, tz: string): string {
  const p = parts(instant, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

export function localTime(instant: Date, tz: string): string {
  const p = parts(instant, tz);
  return `${p.hour}:${p.minute}`;
}

/** Offset of the zone at an instant, in milliseconds (local wall clock minus UTC). */
function offsetAt(instant: Date, tz: string): number {
  const p = parts(instant, tz);
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The UTC instant at which the wall clock in `tz` shows `date` `time` (HH:MM). */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let result = guess - offsetAt(new Date(guess), tz);
  // Re-evaluate once in case the offset differs at the result (DST transitions).
  result = guess - offsetAt(new Date(result), tz);
  return new Date(result);
}

export function addDays(isoDate: string, n: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const minutesBetween = (a: Date, b: Date) => Math.floor((b.getTime() - a.getTime()) / 60_000);
