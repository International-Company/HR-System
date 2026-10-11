import type { ReactNode } from 'react';
import {
  DatePickerInput,
  DateTimePicker,
  MonthPickerInput,
  TimePicker,
  type DatePickerInputProps,
  type DateTimePickerProps,
  type MonthPickerInputProps,
  type TimePickerProps,
} from '@mantine/dates';
import { IconCalendar, IconClock } from '@tabler/icons-react';
import { useAuth } from '../auth/AuthContext';

/**
 * Calendar fields that replace the browser's native date inputs. Values stay plain strings in the
 * formats the API uses: date "YYYY-MM-DD", month "YYYY-MM", date-time "YYYY-MM-DDTHH:mm" (local),
 * time "HH:mm".
 * An empty field is "".
 */
type Base = { value: string; onChange: (value: string) => void; min?: string; max?: string; label?: ReactNode };

const icon = <IconCalendar size={16} stroke={1.5} />;

export function DateField({ value, onChange, min, max, required, ...rest }: Base & Omit<DatePickerInputProps<'default'>, 'value' | 'onChange' | 'minDate' | 'maxDate' | 'type'>) {
  return (
    <DatePickerInput
      valueFormat="D MMMM YYYY"
      leftSection={icon}
      leftSectionPointerEvents="none"
      clearable={!required}
      required={required}
      {...rest}
      value={value || null}
      onChange={(v) => onChange(v ?? '')}
      minDate={min || undefined}
      maxDate={max || undefined}
    />
  );
}

export function MonthField({ value, onChange, min, max, required, ...rest }: Base & Omit<MonthPickerInputProps<'default'>, 'value' | 'onChange' | 'minDate' | 'maxDate' | 'type'>) {
  return (
    <MonthPickerInput
      valueFormat="MMMM YYYY"
      leftSection={icon}
      leftSectionPointerEvents="none"
      clearable={!required}
      required={required}
      {...rest}
      value={value ? `${value}-01` : null}
      onChange={(v) => onChange(v ? v.slice(0, 7) : '')}
      minDate={min ? `${min}-01` : undefined}
      maxDate={max ? `${max}-01` : undefined}
    />
  );
}

export function DateTimeField({ value, onChange, required, ...rest }: Base & Omit<DateTimePickerProps, 'value' | 'onChange' | 'minDate' | 'maxDate'>) {
  const time = useTimeSettings();
  return (
    <DateTimePicker
      valueFormat={time.format === '12h' ? 'D MMMM YYYY h:mm A' : 'D MMMM YYYY HH:mm'}
      timePickerProps={time}
      leftSection={icon}
      leftSectionPointerEvents="none"
      clearable={!required}
      required={required}
      {...rest}
      value={value ? value.replace('T', ' ') : null}
      onChange={(v) => onChange(v ? v.slice(0, 16).replace(' ', 'T') : '')}
    />
  );
}

export function TimeField({ value, onChange, required, ...rest }: Omit<Base, 'min' | 'max'> & Omit<TimePickerProps, 'value' | 'onChange'>) {
  return (
    <TimePicker
      withDropdown
      leftSection={<IconClock size={16} stroke={1.5} />}
      leftSectionPointerEvents="none"
      clearable={!required}
      required={required}
      {...useTimeSettings()}
      {...rest}
      value={value}
      onChange={onChange}
    />
  );
}

/** 12/24-hour clock from the general settings; Arabic AM/PM labels in Arabic. */
function useTimeSettings(): Pick<TimePickerProps, 'format' | 'amPmLabels'> {
  const { settings } = useAuth();
  return {
    format: settings.timeFormat === '12h' ? '12h' : '24h',
    amPmLabels: settings.language === 'ar' ? { am: 'ص', pm: 'م' } : { am: 'AM', pm: 'PM' },
  };
}
