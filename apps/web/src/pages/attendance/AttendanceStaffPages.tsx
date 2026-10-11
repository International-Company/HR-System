import { useState } from 'react';
import { Anchor, Button, Group, Modal, Paper, Select, Stack, Table, Tabs, Text, TextInput, Textarea } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { AttendanceDeviceDto, NetworkRangeDto } from '@hrms/shared';
import { get, post } from '../../lib/api';
import { useAuth } from '../../auth/AuthContext';
import { useCompanies, useLocations } from '../../lib/refdata';
import { EmptyRow, ErrorAlert, PageHeader, StatusBadge, localName, notifyError, notifySaved } from '../../components/common';
import { hm } from './AttendanceDaysTable';
import { DateField } from '../../components/DateFields';

interface ReviewRow {
  employeeId: string;
  employeeNo: string;
  name: { ar: string; en: string };
  workDate: string;
  status: string;
  dayClass: string;
  lateMinutes: number;
  earlyMinutes: number;
  overtimeMinutes: number;
  workedMinutes: number;
  closure: string;
  flags: string[];
  reviewNote: string | null;
}

function useCompanyPicker() {
  const companies = useCompanies();
  const [companyId, setCompanyId] = useState<string | null>(null);
  return { companies, companyId: companyId ?? companies.data?.[0]?.id ?? null, setCompanyId };
}

/** HR / timekeeping exception queue (ATT-14). */
export function AttendanceReviewPage() {
  const { t } = useTranslation();
  const { settings, fmt } = useAuth();
  const lang = settings.language;
  const qc = useQueryClient();
  const { companies, companyId, setCompanyId } = useCompanyPicker();
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(today);
  const rows = useQuery({
    queryKey: ['attendance', 'review', companyId, from, to],
    queryFn: () => get<ReviewRow[]>(`/attendance/review?companyId=${companyId}&from=${from}&to=${to}`),
    enabled: !!companyId,
  });
  const [action, setAction] = useState<{ row: ReviewRow; action: 'confirm_absence' | 'excuse' | 'reopen'; note: string } | null>(null);
  const save = useMutation({
    mutationFn: () => post(`/attendance/employees/${action!.row.employeeId}/days/${action!.row.workDate}/review`, { action: action!.action, note: action!.note }),
    onSuccess: async () => {
      setAction(null);
      await qc.invalidateQueries({ queryKey: ['attendance', 'review'] });
      notifySaved(t);
    },
  });

  return (
    <>
      <PageHeader title={t('att.review')} subtitle={t('att.reviewHint')} />
      <Group mb="md" align="flex-end" wrap="wrap">
        <Select w={240} label={t('emp.company')} data={(companies.data ?? []).map((c) => ({ value: c.id, label: localName(lang, c) }))} value={companyId} onChange={setCompanyId} allowDeselect={false} />
        <DateField label={t('att.from')} value={from} onChange={(v) => setFrom(v)} />
        <DateField label={t('att.to')} value={to} onChange={(v) => setTo(v)} />
      </Group>
      <ErrorAlert error={rows.error} />
      <Paper>
        <Table.ScrollContainer minWidth={860}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('att.employee')}</Table.Th>
                <Table.Th>{t('att.day')}</Table.Th>
                <Table.Th>{t('att.status')}</Table.Th>
                <Table.Th>{t('att.worked')}</Table.Th>
                <Table.Th>{t('att.late')}</Table.Th>
                <Table.Th>{t('att.overtime')}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.data?.length === 0 && <EmptyRow colSpan={7} />}
              {rows.data?.map((r) => (
                <Table.Tr key={`${r.employeeId}-${r.workDate}`}>
                  <Table.Td>
                    <Anchor component={Link} to={`/employees/${r.employeeId}`} size="sm">
                      {lang === 'ar' ? r.name.ar : r.name.en}
                    </Anchor>
                    <Text size="xs" c="dimmed" dir="ltr">
                      {r.employeeNo}
                    </Text>
                  </Table.Td>
                  <Table.Td>{fmt.date(r.workDate)}</Table.Td>
                  <Table.Td>
                    <Stack gap={2}>
                      <StatusBadge status={r.status === 'present' ? 'success' : r.status === 'absent_confirmed' ? 'failed' : 'denied'} label={t(`att.statuses.${r.status}`)} />
                      <Text size="xs" c="dimmed">
                        {r.flags.map((f) => t(`att.flags.${f}`, { defaultValue: f })).join(' · ')}
                      </Text>
                    </Stack>
                  </Table.Td>
                  <Table.Td>{hm(r.workedMinutes)}</Table.Td>
                  <Table.Td>{r.lateMinutes || '—'}</Table.Td>
                  <Table.Td>{r.overtimeMinutes || '—'}</Table.Td>
                  <Table.Td>
                    <Group gap={4} wrap="nowrap">
                      {r.status === 'absent_pending' && (
                        <>
                          <Button size="compact-xs" color="red" variant="light" onClick={() => setAction({ row: r, action: 'confirm_absence', note: '' })}>
                            {t('att.confirmAbsence')}
                          </Button>
                          <Button size="compact-xs" variant="light" onClick={() => setAction({ row: r, action: 'excuse', note: '' })}>
                            {t('att.excuse')}
                          </Button>
                        </>
                      )}
                      {(r.status === 'absent_confirmed' || r.status === 'excused') && (
                        <Button size="compact-xs" variant="subtle" onClick={() => setAction({ row: r, action: 'reopen', note: '' })}>
                          {t('att.reopen')}
                        </Button>
                      )}
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Paper>
      <Modal opened={!!action} onClose={() => setAction(null)} title={action ? t(`att.${action.action === 'confirm_absence' ? 'confirmAbsence' : action.action}`) : ''}>
        {action && (
          <Stack>
            <ErrorAlert error={save.error} />
            <Textarea label={t('att.note')} value={action.note} onChange={(e) => setAction({ ...action, note: e.currentTarget.value })} required autosize minRows={2} />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setAction(null)}>
                {t('app.cancel')}
              </Button>
              <Button disabled={!action.note.trim()} loading={save.isPending} onClick={() => save.mutate()}>
                {t('app.confirm')}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}

/** Networks and devices administration (ATT-01, ATT-05). */
export function AttendanceAdminPage() {
  const { t } = useTranslation();
  const { settings, can, fmt } = useAuth();
  const lang = settings.language;
  const qc = useQueryClient();
  const { companies, companyId, setCompanyId } = useCompanyPicker();
  const locations = useLocations(companyId);
  const networks = useQuery({
    queryKey: ['attendance', 'networks', companyId],
    queryFn: () => get<NetworkRangeDto[]>(`/attendance/networks?companyId=${companyId}`),
    enabled: !!companyId && can('attendance.network.manage'),
  });
  const devices = useQuery({
    queryKey: ['attendance', 'company-devices', companyId],
    queryFn: () => get<AttendanceDeviceDto[]>(`/attendance/devices?companyId=${companyId}`),
    enabled: !!companyId && can('attendance.device.manage'),
  });
  const [form, setForm] = useState<{ cidr: string; label: string; workLocationId: string | null } | null>(null);
  const add = useMutation({
    mutationFn: () => post('/attendance/networks', { companyId, ...form }),
    onSuccess: async () => {
      setForm(null);
      await qc.invalidateQueries({ queryKey: ['attendance', 'networks'] });
      notifySaved(t);
    },
  });
  const act = async (path: string) => {
    try {
      await post(path);
      await qc.invalidateQueries({ queryKey: ['attendance'] });
      notifySaved(t);
    } catch (err) {
      notifyError(t, err);
    }
  };
  const fillMyIp = async () => {
    const r = await get<{ ip: string | null }>('/network/whoami');
    if (r.ip && form) setForm({ ...form, cidr: r.ip.replace(/^::ffff:/, '') });
  };

  return (
    <>
      <PageHeader title={t('att.admin')} subtitle={t('att.ipNote')} />
      <Select mb="md" w={260} label={t('emp.company')} data={(companies.data ?? []).map((c) => ({ value: c.id, label: localName(lang, c) }))} value={companyId} onChange={setCompanyId} allowDeselect={false} />
      <Tabs defaultValue="networks" keepMounted={false}>
        <Tabs.List mb="md">
          {can('attendance.network.manage') && <Tabs.Tab value="networks">{t('att.networks')}</Tabs.Tab>}
          {can('attendance.device.manage') && <Tabs.Tab value="devices">{t('att.deviceList')}</Tabs.Tab>}
        </Tabs.List>
        <Tabs.Panel value="networks">
          <Paper>
            <Group justify="flex-end" p="sm">
              <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setForm({ cidr: '', label: '', workLocationId: null })}>
                {t('att.addNetwork')}
              </Button>
            </Group>
            <Table>
              <Table.Tbody>
                {networks.data?.filter((n) => n.status === 'active').length === 0 && <EmptyRow colSpan={4} />}
                {networks.data
                  ?.filter((n) => n.status === 'active')
                  .map((n) => (
                    <Table.Tr key={n.id}>
                      <Table.Td>{n.label}</Table.Td>
                      <Table.Td dir="ltr" style={{ textAlign: 'start' }}>
                        {n.cidr}
                      </Table.Td>
                      <Table.Td>{n.workLocationId ? localName(lang, locations.data?.find((l) => l.id === n.workLocationId) ?? { nameAr: '—', nameEn: '—' }) : t('att.allLocations')}</Table.Td>
                      <Table.Td>
                        <Button size="compact-xs" variant="subtle" color="red" onClick={() => void act(`/attendance/networks/${n.id}/deactivate`)}>
                          {t('att.revoke')}
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
              </Table.Tbody>
            </Table>
          </Paper>
        </Tabs.Panel>
        <Tabs.Panel value="devices">
          <Paper>
            <Table>
              <Table.Tbody>
                {devices.data?.length === 0 && <EmptyRow colSpan={5} />}
                {devices.data?.map((d) => (
                  <Table.Tr key={d.id}>
                    <Table.Td>{d.userName}</Table.Td>
                    <Table.Td>
                      {d.label} · {d.kind === 'webauthn' ? t('att.methods.webauthn') : t('att.methods.pin')}
                    </Table.Td>
                    <Table.Td>
                      <StatusBadge status={d.status === 'approved' ? 'success' : 'requested'} label={t(`att.${d.status}`)} />
                    </Table.Td>
                    <Table.Td>{fmt.dateTime(d.createdAt)}</Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        {d.status === 'pending' && (
                          <Button size="compact-xs" onClick={() => void act(`/attendance/devices/${d.id}/approve`)}>
                            {t('att.approve')}
                          </Button>
                        )}
                        <Button size="compact-xs" variant="subtle" color="red" onClick={() => void act(`/attendance/devices/${d.id}/revoke`)}>
                          {t('att.revoke')}
                        </Button>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Paper>
        </Tabs.Panel>
      </Tabs>
      <Modal opened={!!form} onClose={() => setForm(null)} title={t('att.addNetwork')}>
        {form && (
          <Stack>
            <ErrorAlert error={add.error} />
            <TextInput label={t('att.label')} value={form.label} onChange={(e) => setForm({ ...form, label: e.currentTarget.value })} required />
            <Group align="flex-end" gap="xs">
              <TextInput style={{ flex: 1 }} label={t('att.cidr')} value={form.cidr} onChange={(e) => setForm({ ...form, cidr: e.currentTarget.value })} dir="ltr" required />
              <Button variant="light" onClick={() => void fillMyIp()}>
                {t('att.useMyIp')}
              </Button>
            </Group>
            <Select
              label={t('att.location')}
              clearable
              placeholder={t('att.allLocations')}
              data={(locations.data ?? []).map((l) => ({ value: l.id, label: localName(lang, l) }))}
              value={form.workLocationId}
              onChange={(v) => setForm({ ...form, workLocationId: v })}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setForm(null)}>
                {t('app.cancel')}
              </Button>
              <Button disabled={!form.cidr || !form.label} loading={add.isPending} onClick={() => add.mutate()}>
                {t('app.save')}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}

