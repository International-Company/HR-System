import type { PublicSettings } from '@hrms/shared';

/**
 * Dates/times follow the single group-wide format and time zone (I18N-03).
 * Digits follow the numerals setting (Western by default).
 */
export function makeFormatter(s: Pick<PublicSettings, 'language' | 'timezone' | 'dateFormat' | 'timeFormat' | 'numerals'>) {
  const locale = `${s.language === 'ar' ? 'ar' : 'en-GB'}-u-nu-${s.numerals}`;
  const parts = (d: Date) =>
    Object.fromEntries(
      new Intl.DateTimeFormat(locale, {
        timeZone: s.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: s.timeFormat === '24h' ? 'h23' : 'h12',
      })
        .formatToParts(d)
        .map((p) => [p.type, p.value]),
    );

  const date = (value: string | Date | null | undefined): string => {
    if (!value) return '—';
    const p = parts(new Date(value));
    switch (s.dateFormat) {
      case 'YYYY-MM-DD':
        return `${p.year}-${p.month}-${p.day}`;
      case 'MM/DD/YYYY':
        return `${p.month}/${p.day}/${p.year}`;
      default:
        return `${p.day}/${p.month}/${p.year}`;
    }
  };
  const time = (value: string | Date | null | undefined): string => {
    if (!value) return '—';
    const p = parts(new Date(value));
    return s.timeFormat === '24h' ? `${p.hour}:${p.minute}` : `${p.hour}:${p.minute} ${p.dayPeriod ?? ''}`.trim();
  };
  const dateTime = (value: string | Date | null | undefined): string =>
    value ? `${date(value)} ${time(value)}` : '—';
  const number = (n: number | null | undefined): string =>
    n == null ? '—' : new Intl.NumberFormat(locale).format(n);
  const bytes = (n: number | null | undefined): string => {
    if (n == null) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(v)} ${units[i]}`;
  };
  return { date, time, dateTime, number, bytes };
}

export type Formatter = ReturnType<typeof makeFormatter>;
