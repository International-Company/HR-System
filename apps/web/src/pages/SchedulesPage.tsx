import { useState } from 'react';
import {
  ActionIcon,
  Button,
  Checkbox,
  Group,
  Modal,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
} from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ScheduleAssignmentDto, ScheduleDayDto, ScheduleDto } from '@hrms/shared';
import { get, patch, post } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { employeeName, useCompanies, useDepartments, useEmployeeOptions } from '../lib/refdata';
import { EmptyRow, ErrorAlert, PageHeader, StatusBadge, localName, notifySaved } from '../components/common';
import { DateField } from '../components/DateFields';

type Draft = Omit<ScheduleDto, 'id' | 'version' | 'status'> & { id?: string; version?: number; status: 'active' | 'inactive' };

const defaultDays = (): ScheduleDayDto[] =>
  [1, 2, 3, 4, 5, 6, 7].map((d) => ({
    isoWeekday: d,
    isWorkday: d <= 5,
    startTime: d <= 5 ? '08:00' : null,
    endTime: d <= 5 ? '16:00' : null,
    breaks: [],
  }));

export function SchedulesPage() {
  const { t } = useTranslation();
  const { can, settings } = useAuth();
  const qc = useQueryClient();
  const companies = useCompanies();
  const schedules = useQuery({ queryKey: ['schedules'], queryFn: () => get<ScheduleDto[]>('/schedules') });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const cid = companyId ?? companies.data?.[0]?.id ?? null;
  const lang = settings.language;

  const save = useMutation({
    mutationFn: () => {
      const d = draft!;
      const days = d.days.map((x) => ({
        isoWeekday: x.isoWeekday,
        isWorkday: x.isWorkday,
        startTime: x.isWorkday ? x.startTime : null,
        endTime: x.isWorkday ? x.endTime : null,
        breaks: x.isWorkday ? x.breaks : [],
      }));
      const body = { nameAr: d.nameAr, nameEn: d.nameEn, graceInMinutes: d.graceInMinutes, graceOutMinutes: d.graceOutMinutes, days };
      return d.id
        ? patch(`/schedules/${d.id}`, { ...body, status: d.status, version: d.version })
        : post('/schedules', { ...body, code: d.code, companyId: d.companyId });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['schedules'] });
      setDraft(null);
      notifySaved(t);
    },
  });

  const setDay = (i: number, patchDay: Partial<ScheduleDayDto>) =>
    draft && setDraft({ ...draft, days: draft.days.map((d, n) => (n === i ? { ...d, ...patchDay } : d)) });
  const companyName = (id: string | null) => {
    if (!id) return t('cal.groupWide');
    const c = companies.data?.find((x) => x.id === id);
    return c ? localName(lang, c) : '—';
  };

  return (
    <>
      <PageHeader
        title={t('cal.schedules')}
        actions={
          can('schedules.manage') && (
            <Button
              leftSection={<IconPlus size={16} />}
              onClick={() => setDraft({ companyId: cid, code: '', nameAr: '', nameEn: '', graceInMinutes: 10, graceOutMinutes: 0, days: defaultDays(), status: 'active' })}
            >
              {t('cal.newSchedule')}
            </Button>
          )
        }
      />
      <Tabs defaultValue="schedules" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="schedules">{t('cal.schedules')}</Tabs.Tab>
          <Tabs.Tab value="assignments">{t('cal.assignments')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="schedules">
          <ErrorAlert error={schedules.error} />
          <Paper>
            <Table.ScrollContainer minWidth={760}>
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('app.name')}</Table.Th>
                    <Table.Th>{t('lookups.scope')}</Table.Th>
                    <Table.Th>{t('cal.workday')}</Table.Th>
                    <Table.Th>{t('cal.graceIn')}</Table.Th>
                    <Table.Th>{t('app.status')}</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {schedules.data?.length === 0 && <EmptyRow colSpan={6} />}
                  {schedules.data?.map((s) => (
                    <Table.Tr key={s.id}>
                      <Table.Td>
                        <Stack gap={0}>
                          <Text size="sm">{localName(lang, s)}</Text>
                          <Text size="xs" c="dimmed" dir="ltr">
                            {s.code}
                          </Text>
                        </Stack>
                      </Table.Td>
                      <Table.Td>{companyName(s.companyId)}</Table.Td>
                      <Table.Td>
                        <Text size="xs">
                          {s.days
                            .filter((d) => d.isWorkday)
                            .map((d) => `${t(`cal.weekdays.${d.isoWeekday}`)} ${d.startTime}–${d.endTime}`)
                            .join(' · ')}
                        </Text>
                      </Table.Td>
                      <Table.Td>{s.graceInMinutes}</Table.Td>
                      <Table.Td>
                        <StatusBadge status={s.status} label={t(`app.${s.status}`)} />
                      </Table.Td>
                      <Table.Td>
                        {can('schedules.manage') && (
                          <Button size="xs" variant="subtle" onClick={() => setDraft({ ...s })}>
                            {t('app.edit')}
                          </Button>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Paper>
        </Tabs.Panel>
        <Tabs.Panel value="assignments">
          <Select
            mb="md"
            w={280}
            label={t('emp.company')}
            data={(companies.data ?? []).map((c) => ({ value: c.id, label: localName(lang, c) }))}
            value={cid}
            onChange={setCompanyId}
            allowDeselect={false}
          />
          {cid && <Assignments companyId={cid} schedules={schedules.data ?? []} />}
        </Tabs.Panel>
      </Tabs>

      <Modal opened={!!draft} onClose={() => setDraft(null)} title={draft?.id ? t('app.edit') : t('cal.newSchedule')} size="xl">
        {draft && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <Stack>
              <ErrorAlert error={save.error} />
              <SimpleGrid cols={{ base: 1, sm: 3 }}>
                {!draft.id && (
                  <Select
                    label={t('lookups.scope')}
                    data={[
                      ...(can('schedules.manage') ? [{ value: '', label: t('cal.groupWide') }] : []),
                      ...(companies.data ?? []).map((c) => ({ value: c.id, label: localName(lang, c) })),
                    ]}
                    value={draft.companyId ?? ''}
                    onChange={(v) => setDraft({ ...draft, companyId: v || null })}
                    allowDeselect={false}
                  />
                )}
                {!draft.id && <TextInput label={t('app.code')} value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.currentTarget.value })} required dir="ltr" />}
                <TextInput label={t('app.nameAr')} value={draft.nameAr} onChange={(e) => setDraft({ ...draft, nameAr: e.currentTarget.value })} required dir="rtl" />
                <TextInput label={t('app.nameEn')} value={draft.nameEn} onChange={(e) => setDraft({ ...draft, nameEn: e.currentTarget.value })} required dir="ltr" />
                <NumberInput label={t('cal.graceIn')} min={0} max={240} value={draft.graceInMinutes} onChange={(v) => setDraft({ ...draft, graceInMinutes: Number(v) || 0 })} />
                <NumberInput label={t('cal.graceOut')} min={0} max={240} value={draft.graceOutMinutes} onChange={(v) => setDraft({ ...draft, graceOutMinutes: Number(v) || 0 })} />
              </SimpleGrid>
              <Paper p="sm">
                <Stack gap="xs">
                  {draft.days.map((d, i) => (
                    <Group key={d.isoWeekday} align="flex-end" wrap="wrap" gap="xs">
                      <Checkbox w={130} label={t(`cal.weekdays.${d.isoWeekday}`)} checked={d.isWorkday} onChange={(e) => setDay(i, { isWorkday: e.currentTarget.checked, startTime: d.startTime ?? '08:00', endTime: d.endTime ?? '16:00' })} />
                      {d.isWorkday ? (
                        <>
                          <TextInput w={110} type="time" label={t('cal.start')} value={d.startTime ?? ''} onChange={(e) => setDay(i, { startTime: e.currentTarget.value })} />
                          <TextInput w={110} type="time" label={t('cal.end')} value={d.endTime ?? ''} onChange={(e) => setDay(i, { endTime: e.currentTarget.value })} />
                          {d.startTime && d.endTime && d.endTime <= d.startTime && (
                            <Text size="xs" c="orange">
                              {t('cal.overnight')}
                            </Text>
                          )}
                          {d.breaks.map((b, bi) => (
                            <Group key={bi} gap={4} align="flex-end">
                              <TextInput w={100} type="time" label={t('cal.breaks')} value={b.startTime} onChange={(e) => setDay(i, { breaks: d.breaks.map((x, n) => (n === bi ? { ...x, startTime: e.currentTarget.value } : x)) })} />
                              <TextInput aria-label={t('cal.breaks')} w={100} type="time" value={b.endTime} onChange={(e) => setDay(i, { breaks: d.breaks.map((x, n) => (n === bi ? { ...x, endTime: e.currentTarget.value } : x)) })} />
                              <ActionIcon variant="subtle" color="red" mb={4} onClick={() => setDay(i, { breaks: d.breaks.filter((_, n) => n !== bi) })} aria-label={t('emp.remove')}>
                                <IconTrash size={14} />
                              </ActionIcon>
                            </Group>
                          ))}
                          <Button size="compact-xs" variant="subtle" mb={6} onClick={() => setDay(i, { breaks: [...d.breaks, { startTime: '12:00', endTime: '12:30', paid: false }] })}>
                            {t('cal.addBreak')}
                          </Button>
                        </>
                      ) : (
                        <Text size="sm" c="dimmed" mb={6}>
                          {t('cal.rest')}
                        </Text>
                      )}
                    </Group>
                  ))}
                </Stack>
              </Paper>
              {draft.id && (
                <Select
                  w={200}
                  label={t('app.status')}
                  data={[
                    { value: 'active', label: t('app.active') },
                    { value: 'inactive', label: t('app.inactive') },
                  ]}
                  value={draft.status}
                  onChange={(v) => setDraft({ ...draft, status: (v ?? 'active') as 'active' | 'inactive' })}
                  allowDeselect={false}
                />
              )}
              <Group justify="flex-end">
                <Button variant="default" onClick={() => setDraft(null)}>
                  {t('app.cancel')}
                </Button>
                <Button type="submit" loading={save.isPending}>
                  {t('app.save')}
                </Button>
              </Group>
            </Stack>
          </form>
        )}
      </Modal>
    </>
  );
}

function Assignments({ companyId, schedules }: { companyId: string; schedules: ScheduleDto[] }) {
  const { t } = useTranslation();
  const { can, settings, fmt } = useAuth();
  const qc = useQueryClient();
  const lang = settings.language;
  const list = useQuery({ queryKey: ['schedule-assignments', companyId], queryFn: () => get<ScheduleAssignmentDto[]>(`/schedule-assignments?companyId=${companyId}`) });
  const departments = useDepartments(companyId);
  const employees = useEmployeeOptions();
  const [form, setForm] = useState<{ scheduleId: string | null; targetType: string; departmentId: string | null; employeeId: string | null; validFrom: string } | null>(null);
  const assign = useMutation({
    mutationFn: () => post('/schedule-assignments', { ...form, companyId }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['schedule-assignments', companyId] });
      setForm(null);
      notifySaved(t);
    },
  });
  const usable = schedules.filter((s) => s.status === 'active' && (!s.companyId || s.companyId === companyId));
  const sName = (id: string) => {
    const s = schedules.find((x) => x.id === id);
    return s ? localName(lang, s) : '—';
  };
  const targetName = (a: ScheduleAssignmentDto) => {
    if (a.targetType === 'department') {
      const d = departments.data?.find((x) => x.id === a.departmentId);
      return d ? localName(lang, d) : '—';
    }
    if (a.targetType === 'employee') {
      const e = employees.data?.find((x) => x.id === a.employeeId);
      return e ? employeeName(lang, e) : '—';
    }
    return t('cal.targets.company');
  };

  return (
    <Paper>
      <Group justify="flex-end" p="sm">
        {can('schedules.manage') && (
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setForm({ scheduleId: null, targetType: 'company', departmentId: null, employeeId: null, validFrom: new Date().toISOString().slice(0, 10) })}>
            {t('cal.assign')}
          </Button>
        )}
      </Group>
      <Table.ScrollContainer minWidth={600}>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('cal.target')}</Table.Th>
              <Table.Th>{t('cal.schedules')}</Table.Th>
              <Table.Th>{t('cal.validFrom')}</Table.Th>
              <Table.Th>{t('cal.validTo')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {list.data?.length === 0 && <EmptyRow colSpan={4} />}
            {list.data?.map((a) => (
              <Table.Tr key={a.id}>
                <Table.Td>
                  {t(`cal.targets.${a.targetType}`)}: {targetName(a)}
                </Table.Td>
                <Table.Td>{sName(a.scheduleId)}</Table.Td>
                <Table.Td>{fmt.date(a.validFrom)}</Table.Td>
                <Table.Td>{a.validTo ? fmt.date(a.validTo) : '—'}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      <Modal opened={!!form} onClose={() => setForm(null)} title={t('cal.assign')}>
        {form && (
          <Stack>
            <ErrorAlert error={assign.error} />
            <Select label={t('cal.schedules')} data={usable.map((s) => ({ value: s.id, label: localName(lang, s) }))} value={form.scheduleId} onChange={(v) => setForm({ ...form, scheduleId: v })} required />
            <Select
              label={t('cal.target')}
              data={(['company', 'department', 'employee'] as const).map((x) => ({ value: x, label: t(`cal.targets.${x}`) }))}
              value={form.targetType}
              onChange={(v) => setForm({ ...form, targetType: v ?? 'company', departmentId: null, employeeId: null })}
              allowDeselect={false}
            />
            {form.targetType === 'department' && (
              <Select label={t('emp.department')} data={(departments.data ?? []).map((d) => ({ value: d.id, label: localName(lang, d) }))} value={form.departmentId} onChange={(v) => setForm({ ...form, departmentId: v })} />
            )}
            {form.targetType === 'employee' && (
              <Select
                label={t('tasks.employee')}
                searchable
                data={(employees.data ?? []).filter((e) => e.companyId === companyId).map((e) => ({ value: e.id, label: `${employeeName(lang, e)} (${e.employeeNo})` }))}
                value={form.employeeId}
                onChange={(v) => setForm({ ...form, employeeId: v })}
              />
            )}
            <DateField label={t('cal.validFrom')} value={form.validFrom} onChange={(v) => setForm({ ...form, validFrom: v })} />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setForm(null)}>
                {t('app.cancel')}
              </Button>
              <Button disabled={!form.scheduleId} loading={assign.isPending} onClick={() => assign.mutate()}>
                {t('app.save')}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Paper>
  );
}
