import { useState } from 'react';
import { Group, Paper, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { AttendanceDayDto } from '@hrms/shared';
import { get } from '../../lib/api';
import { ErrorAlert } from '../../components/common';
import { AttendanceDaysTable } from './AttendanceDaysTable';

/** Attendance history in the employee profile (ATT-13); the API enforces scope. */
export function EmployeeAttendanceTab({ employeeId }: { employeeId: string }) {
  const { t } = useTranslation();
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(today);
  const days = useQuery({
    queryKey: ['attendance', 'days', employeeId, from, to],
    queryFn: () => get<AttendanceDayDto[]>(`/attendance/employees/${employeeId}/days?from=${from}&to=${to}`),
  });
  return (
    <Paper p="md">
      <Group mb="md">
        <TextInput type="date" label={t('att.from')} value={from} max={to} onChange={(e) => setFrom(e.currentTarget.value)} />
        <TextInput type="date" label={t('att.to')} value={to} max={today} onChange={(e) => setTo(e.currentTarget.value)} />
      </Group>
      <ErrorAlert error={days.error} />
      <AttendanceDaysTable days={[...(days.data ?? [])].reverse()} />
    </Paper>
  );
}
