import type { ReactNode } from 'react';
import { DatePickerInput, DateTimePicker, MonthPickerInput, type DatePickerInputProps, type DateTimePickerProps, type MonthPickerInputProps } from '@mantine/dates';
import { IconCalendar } from '@tabler/icons-react';

/**
 * Calendar fields that replace the browser's native date inputs. Values stay plain strings in the
 * formats the API uses: date "YYYY-MM-DD", month "YYYY-MM", date-time "YYYY-MM-DDTHH:mm" (local).
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
  return (
    <DateTimePicker
      valueFormat="D MMMM YYYY HH:mm"
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
