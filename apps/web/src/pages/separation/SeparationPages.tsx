import { useState } from 'react';
import { Alert, Anchor, Badge, Button, Card, Checkbox, Group, Modal, Paper, Select, SimpleGrid, Stack, Switch, Table, Text, TextInput, Textarea } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { SEPARATION_TYPES, type EmployeeDto, type SeparationDto, type SeparationType } from '@hrms/shared';
import { get, post } from '../../lib/api';
import { useAuth } from '../../auth/AuthContext';
import { lookupOptions, useCompanies, useDepartments, useLookups } from '../../lib/refdata';
import { EmptyRow, ErrorAlert, PageHeader, StatusBadge, localName, notifyError, notifySaved } from '../../components/common';

const COLOR: Record<string, string> = { pending: 'requested', approved: 'denied', rejected: 'inactive', cancelled: 'inactive', completed: 'failed' };
const today = () => new Date().toISOString().slice(0, 10);

function useMoney() {
  const { settings } = useAuth();
  const locale = `${settings.language === 'ar' ? 'ar' : 'en-GB'}-u-nu-${settings.numerals}`;
  return (n: number, currency: string) => `${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} ${currency}`;
}

function SeparationCard({ s, showEmployee }: { s: SeparationDto; showEmployee?: boolean }) {
  const { t } = useTranslation();
  const { settings, fmt, can, session } = useAuth();
  const money = useMoney();
  const qc = useQueryClient();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const own = s.initiatedBySelf && s.employeeId === session?.user.employeeId;
  const manage = can('separation.manage');
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['separations'] }), qc.invalidateQueries({ queryKey: ['employee'] })]);
  const cancel = useMutation({
    mutationFn: () => post(`/separations/${s.id}/cancel`, { reason }),
    onSuccess: async () => {
      setCancelling(false);
      await refresh();
      notifySaved(t);
    },
  });
  const eligibility = async (v: boolean) => {
    try {
      await post(`/separations/${s.id}/eligibility`, { rehireEligible: v });
      await refresh();
    } catch (err) {
      notifyError(t, err);
    }
  };
  return (
    <Card withBorder>
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <Stack gap={4}>
          <Group gap="xs">
            <Text fw={600}>{t(`sep.types.${s.type}`)}</Text>
            <StatusBadge status={COLOR[s.status] ?? 'inactive'} label={t(`sep.statuses.${s.status}`)} />
            {!s.rehireEligible && (
              <Badge color="red" variant="light" size="sm">
                {t('sep.notEligible')}
              </Badge>
            )}
          </Group>
          {showEmployee && (
            <Anchor component={Link} to={`/employees/${s.employeeId}`} size="sm">
              {settings.language === 'ar' ? s.employeeName.ar : s.employeeName.en} · <span dir="ltr">{s.employeeNo}</span>
            </Anchor>
          )}
          <Text size="sm">
            {t('sep.lastWorkingDay')}: <b>{fmt.date(s.lastWorkingDay)}</b>
            {s.initiatedBySelf && ` · ${t('sep.selfInitiated')}`}
          </Text>
          <Text size="sm" c="dimmed">
            {s.reason}
          </Text>
          {s.cancelReason && (
            <Text size="xs" c="dimmed">
              {t('sep.cancelReason')}: {s.cancelReason}
            </Text>
          )}
          {s.settlement && (
            <Text size="sm">
              {t('sep.settlement')}: <b>{money(s.settlement.amount, s.settlement.currency)}</b> ({t('sep.serviceYears', { n: s.settlement.serviceYears })})
            </Text>
          )}
        </Stack>
        <Group gap="xs">
          {((s.status === 'pending' && (own || manage)) || (s.status === 'approved' && manage)) && (
            <Button size="xs" variant="light" color="red" onClick={() => setCancelling(true)}>
              {t('sep.cancel')}
            </Button>
          )}
          {manage && (s.status === 'completed' || s.status === 'approved') && (
            <Button size="xs" variant="subtle" onClick={() => void eligibility(!s.rehireEligible)}>
              {s.rehireEligible ? t('sep.makeIneligible') : t('sep.makeEligible')}
            </Button>
          )}
        </Group>
      </Group>
      <Modal opened={cancelling} onClose={() => setCancelling(false)} title={t('sep.cancel')}>
        <Stack>
          <ErrorAlert error={cancel.error} />
          {s.status === 'approved' && <Alert>{t('sep.cancelApprovedHint')}</Alert>}
          <Textarea label={t('sep.cancelReason')} value={reason} onChange={(e) => setReason(e.currentTarget.value)} autosize minRows={2} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setCancelling(false)}>
              {t('app.cancel')}
            </Button>
            <Button color="red" disabled={reason.trim().length < 3} loading={cancel.isPending} onClick={() => cancel.mutate()}>
              {t('app.confirm')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Card>
  );
}

/** Company list of separations (TRM-02). */
export function SeparationsPage() {
  const { t } = useTranslation();
  const { settings } = useAuth();
  const companies = useCompanies();
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const company = companyId ?? companies.data?.[0]?.id ?? null;
  const list = useQuery({
    queryKey: ['separations', company, status],
    queryFn: () => get<SeparationDto[]>(`/separations?companyId=${company}${status ? `&status=${status}` : ''}`),
    enabled: !!company,
  });
  return (
    <>
      <PageHeader title={t('sep.title')} subtitle={t('sep.exitNote')} />
      <Group mb="md" align="flex-end">
        <Select w={240} label={t('sep.company')} data={(companies.data ?? []).map((c) => ({ value: c.id, label: localName(settings.language, c) }))} value={company} onChange={setCompanyId} allowDeselect={false} />
        <Select w={200} label={t('sep.status')} clearable placeholder={t('sep.all')} data={['pending', 'approved', 'completed', 'cancelled', 'rejected'].map((s) => ({ value: s, label: t(`sep.statuses.${s}`) }))} value={status} onChange={setStatus} />
      </Group>
      <ErrorAlert error={list.error} />
      <Stack>
        {list.data?.length === 0 && (
          <Paper p="lg">
            <Table>
              <Table.Tbody>
                <EmptyRow colSpan={1} />
              </Table.Tbody>
            </Table>
          </Paper>
        )}
        {list.data?.map((s) => <SeparationCard key={s.id} s={s} showEmployee />)}
      </Stack>
    </>
  );
}

/** Profile tab: separations of the employee, starting one, resigning, rehiring. */
export function EmployeeSeparationTab({ employee: e }: { employee: EmployeeDto }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const list = useQuery({ queryKey: ['separations', 'employee', e.id], queryFn: () => get<SeparationDto[]>(`/separations/employee/${e.id}`) });
  const [dialog, setDialog] = useState<'start' | 'resign' | 'rehire' | null>(null);
  const open = list.data?.some((s) => s.status === 'pending' || s.status === 'approved');
  const terminated = e.status === 'terminated';
  return (
    <Stack>
      <Group justify="flex-end" gap="xs">
        {!terminated && !open && e.access.self && can('separation.request') && (
          <Button variant="light" color="red" onClick={() => setDialog('resign')}>
            {t('sep.resign')}
          </Button>
        )}
        {!terminated && !open && !e.access.self && can('separation.request') && (
          <Button variant="light" color="red" onClick={() => setDialog('start')}>
            {t('sep.start')}
          </Button>
        )}
        {terminated && e.access.manageLifecycle && <Button onClick={() => setDialog('rehire')}>{t('sep.rehire')}</Button>}
      </Group>
      <ErrorAlert error={list.error} />
      {list.data?.length === 0 && (
        <Text c="dimmed" ta="center">
          —
        </Text>
      )}
      {list.data?.map((s) => <SeparationCard key={s.id} s={s} />)}
      {(dialog === 'start' || dialog === 'resign') && <StartModal employeeId={e.id} self={dialog === 'resign'} onClose={() => setDialog(null)} />}
      {dialog === 'rehire' && <RehireModal employee={e} onClose={() => setDialog(null)} />}
    </Stack>
  );
}

function StartModal({ employeeId, self, onClose }: { employeeId: string; self: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [form, setForm] = useState<{ type: SeparationType; lastWorkingDay: string; reason: string; rehireEligible: boolean }>({
    type: self ? 'resignation' : 'termination',
    lastWorkingDay: today(),
    reason: '',
    rehireEligible: true,
  });
  const save = useMutation({
    mutationFn: () => post('/separations', { ...form, ...(self ? {} : { employeeId }) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['separations'] });
      onClose();
      notifySaved(t);
    },
  });
  return (
    <Modal opened onClose={onClose} title={self ? t('sep.resign') : t('sep.start')}>
      <Stack>
        <ErrorAlert error={save.error} />
        {!self && (
          <Select label={t('sep.type')} data={SEPARATION_TYPES.map((x) => ({ value: x, label: t(`sep.types.${x}`) }))} value={form.type} onChange={(v) => setForm({ ...form, type: (v ?? 'termination') as SeparationType })} allowDeselect={false} />
        )}
        <TextInput type="date" label={t('sep.lastWorkingDay')} value={form.lastWorkingDay} onChange={(e) => setForm({ ...form, lastWorkingDay: e.currentTarget.value })} required />
        <Textarea label={t('sep.reason')} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.currentTarget.value })} autosize minRows={3} required />
        {!self && <Switch label={t('sep.rehireEligible')} checked={form.rehireEligible} onChange={(e) => setForm({ ...form, rehireEligible: e.currentTarget.checked })} />}
        <Alert variant="light">{self ? t('sep.noticeNote') : t('sep.exitNote')}</Alert>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button color="red" disabled={form.reason.trim().length < 3 || !form.lastWorkingDay} loading={save.isPending} onClick={() => save.mutate()}>
            {t('app.confirm')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function RehireModal({ employee: e, onClose }: { employee: EmployeeDto; onClose: () => void }) {
  const { t } = useTranslation();
  const { settings } = useAuth();
  const lang = settings.language;
  const qc = useQueryClient();
  const companies = useCompanies();
  const lookups = useLookups();
  const [form, setForm] = useState({
    effectiveDate: today(),
    probationEndDate: '',
    companyId: e.current?.companyId ?? '',
    departmentId: null as string | null,
    jobTitleId: e.current?.jobTitleId ?? null,
    reason: '',
    overrideIneligible: false,
  });
  const departments = useDepartments(form.companyId || null);
  const save = useMutation({
    mutationFn: () =>
      post(`/employees/${e.id}/rehire`, {
        effectiveDate: form.effectiveDate,
        probationEndDate: form.probationEndDate || null,
        assignment: { companyId: form.companyId, departmentId: form.departmentId, jobTitleId: form.jobTitleId },
        reason: form.reason,
        overrideIneligible: form.overrideIneligible,
      }),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ['employee'] }), qc.invalidateQueries({ queryKey: ['separations'] }), qc.invalidateQueries({ queryKey: ['employee-history'] })]);
      onClose();
      notifySaved(t);
    },
  });
  return (
    <Modal opened onClose={onClose} title={t('sep.rehire')} size="lg">
      <Stack>
        <ErrorAlert error={save.error} />
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput type="date" label={t('sep.rehireDate')} value={form.effectiveDate} onChange={(ev) => setForm({ ...form, effectiveDate: ev.currentTarget.value })} />
          <TextInput type="date" label={t('sep.probationEnd')} value={form.probationEndDate} onChange={(ev) => setForm({ ...form, probationEndDate: ev.currentTarget.value })} />
          <Select
            label={t('sep.company')}
            data={(companies.data ?? []).map((c) => ({ value: c.id, label: localName(lang, c) }))}
            value={form.companyId || null}
            onChange={(v) => setForm({ ...form, companyId: v ?? '', departmentId: null })}
            allowDeselect={false}
          />
          <Select label={t('sep.department')} clearable data={(departments.data ?? []).map((d) => ({ value: d.id, label: localName(lang, d) }))} value={form.departmentId} onChange={(v) => setForm({ ...form, departmentId: v })} />
          <Select label={t('sep.jobTitle')} clearable searchable data={lookupOptions(lookups.data, 'job_title', lang, form.companyId)} value={form.jobTitleId} onChange={(v) => setForm({ ...form, jobTitleId: v })} />
        </SimpleGrid>
        <Textarea label={t('sep.reason')} value={form.reason} onChange={(ev) => setForm({ ...form, reason: ev.currentTarget.value })} autosize minRows={2} />
        <Checkbox label={t('sep.override')} checked={form.overrideIneligible} onChange={(ev) => setForm({ ...form, overrideIneligible: ev.currentTarget.checked })} />
        <Alert variant="light">{t('sep.accountNote')}</Alert>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button disabled={!form.companyId || form.reason.trim().length < 3} loading={save.isPending} onClick={() => save.mutate()}>
            {t('sep.rehire')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** One separation (linked from approval notifications). */
export function SeparationDetailPage() {
  const { id } = useParams();
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['separations', 'one', id], queryFn: () => get<SeparationDto>(`/separations/${id}`) });
  return (
    <>
      <PageHeader title={t('sep.title')} />
      <ErrorAlert error={q.error} />
      {q.data && <SeparationCard s={q.data} showEmployee />}
    </>
  );
}
