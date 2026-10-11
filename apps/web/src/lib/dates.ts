import dayjs from 'dayjs';
import 'dayjs/locale/ar';
import 'dayjs/locale/en';
import type { DatesProviderSettings } from '@mantine/dates';

// Arabic month and day names with Western digits (the "latn" numerals setting); the stock
// Arabic locale always converts digits to Arabic-Indic.
const ar = dayjs.Ls.ar!;
dayjs.locale({ ...ar, name: 'ar-latn', preparse: undefined, postformat: undefined } as unknown as ILocale, undefined, true);

/** Calendar settings for the language and numerals chosen in the general settings. */
export function datesLocale(language: string, numerals: string): DatesProviderSettings {
  if (language === 'ar') {
    // Week starts on Saturday; Friday and Saturday shown as the weekend.
    return { locale: numerals === 'arab' ? 'ar' : 'ar-latn', firstDayOfWeek: 6, weekendDays: [5, 6] };
  }
  return { locale: 'en', firstDayOfWeek: 1, weekendDays: [0, 6] };
}
