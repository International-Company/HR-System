import { Badge, Group, Table, Text, Tooltip } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { AttendanceDayDto } from '@hrms/shared';
import { useAuth } from '../../auth/AuthContext';
import { EmptyRow, StatusBadge } from '../../components/common';

const STATUS_COLOR: Record<string, string> = {
  present: 'success',
  incomplete: 'denied',
  absent_pending: 'denied',
  absent_confirmed: 'failed',
  excused: 'inactive',
  not_required: 'inactive',
  upcoming: 'inactive',
};

export const hm = (mins: number) => (mins ? `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}` : '—');

/** Attendance days with times, minutes and exception flags (shared by employee and HR views). */
export function AttendanceDaysTable({ days, onSelect }: { days: AttendanceDayDto[]; onSelect?: (d: AttendanceDayDto) => void }) {
  const { t } = useTranslation();
  const { fmt } = useAuth();
  return (
    <Table.ScrollContainer minWidth={820}>
      <Table highlightOnHover={!!onSelect}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('att.day')}</Table.Th>
            <Table.Th>{t('att.status')}</Table.Th>
            <Table.Th>{t('att.inOut')}</Table.Th>
            <Table.Th>{t('att.worked')}</Table.Th>
            <Table.Th>{t('att.late')}</Table.Th>
            <Table.Th>{t('att.early')}</Table.Th>
            <Table.Th>{t('att.overtime')}</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {days.length === 0 && <EmptyRow colSpan={8} />}
          {days.map((d) => (
            <Table.Tr key={d.workDate} onClick={onSelect ? () => onSelect(d) : undefined} style={onSelect ? { cursor: 'pointer' } : undefined}>
              <Table.Td>
                <Text size="sm">{fmt.date(d.workDate)}</Text>
                <Text size="xs" c="dimmed">
                  {t(`att.classes.${d.dayClass}`)}
                  {d.scheduledStart ? ` · ${d.scheduledStart}–${d.scheduledEnd}` : ''}
                </Text>
              </Table.Td>
              <Table.Td>
                <StatusBadge status={STATUS_COLOR[d.status] ?? 'inactive'} label={t(`att.statuses.${d.status}`)} />
              </Table.Td>
              <Table.Td dir="ltr" style={{ textAlign: 'start' }}>
                {d.firstIn ?? '—'} – {d.lastOut ?? '—'}
              </Table.Td>
              <Table.Td>{hm(d.workedMinutes || d.holidayWorkMinutes)}</Table.Td>
              <Table.Td c={d.lateMinutes ? 'orange.8' : undefined}>{d.lateMinutes || '—'}</Table.Td>
              <Table.Td c={d.earlyMinutes ? 'orange.8' : undefined}>{d.earlyMinutes || '—'}</Table.Td>
              <Table.Td c={d.overtimeMinutes ? 'brand.7' : undefined}>{d.overtimeMinutes || '—'}</Table.Td>
              <Table.Td>
                <Group gap={4}>
                  {d.flags
                    .filter((f) => !['late', 'early_departure', 'overtime', 'possible_absence'].includes(f))
                    .map((f) => (
                      <Tooltip key={f} label={f === 'administrative_closure' ? t('att.adminClosureNote') : t(`att.flags.${f}`, { defaultValue: f })} withArrow>
                        <Badge size="xs" variant="light" color={f === 'holiday_work' || f === 'rest_day_work' ? 'blue' : 'orange'}>
                          {t(`att.flags.${f}`, { defaultValue: f })}
                        </Badge>
                      </Tooltip>
                    ))}
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
