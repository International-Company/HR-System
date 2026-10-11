import { useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
} from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { DEFAULT_LEAVE_RULES, type LeaveBalanceDto, type LeaveRequestDto, type LeaveRules, type LeaveTypeDto, type PermissionRequestDto } from '@hrms/shared';
import { get, patch, post } from '../../lib/api';
import { useAuth } from '../../auth/AuthContext';
import { useCompanies, useDocumentCategories, useEmployeeOptions } from '../../lib/refdata';
import { EmptyRow, ErrorAlert, PageHeader, localName, notifySaved } from '../../components/common';
import {
  AdjustModal,
  BalanceCards,
  LeaveRequestModal,
  LedgerModal,
  PermissionModal,
  PermissionsTable,
  RequestsTable,
  SectionTitle,
  useLeaveTypes,
} from './LeaveParts';

/** Balances, requests and permissions of one employee (self-service and the profile tab). */
export function EmployeeLeaveTab({ employeeId }: { employeeId: string }) {
  const { t } = useTranslation();
  const { session, can } = useAuth();
  const self = session?.user.employeeId === employeeId;
  const requests = useQuery({ queryKey: ['leave', 'requests', employeeId], queryFn: () => get<LeaveRequestDto[]>(`/leave/employees/${employeeId}/requests`) });
  const permissions = useQuery({ queryKey: ['leave', 'permissions', employeeId], queryFn: () => get<PermissionRequestDto[]>(`/leave/employees/${employeeId}/permissions`) });
  const [modal, setModal] = useState<'leave' | 'permission' | 'adjust' | null>(null);
  const [ledger, setLedger] = useState<LeaveBalanceDto | null>(null);
  const staff = !self && can('leave.request.manage');
  const mayRequest = (self && can('leave.request.create')) || staff;
  const canCancel = (r: { status: string }) => (r.status === 'pending' ? self || staff : staff);

  return (
    <Stack gap={0}>
      <SectionTitle
        actions={
          <Group gap="xs">
            {!self && can('leave.balance.adjust') && (
              <Button size="xs" variant="default" onClick={() => setModal('adjust')}>
                {t('leave.adjust')}
              </Button>
            )}
            {mayRequest && (
              <>
                <Button size="xs" variant="light" onClick={() => setModal('permission')}>
                  {t('leave.requestPermission')}
                </Button>
                <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setModal('leave')}>
                  {t('leave.request')}
                </Button>
              </>
            )}
          </Group>
        }
      >
        {self ? t('leave.balances') : t('leave.balance')}
      </SectionTitle>
      <BalanceCards employeeId={employeeId} onLedger={setLedger} />

      <SectionTitle>{self ? t('leave.myRequests') : t('leave.requests')}</SectionTitle>
      <Paper>
        <ErrorAlert error={requests.error} />
        <RequestsTable rows={requests.data ?? []} canCancel={canCancel} />
      </Paper>

      <SectionTitle>{self ? t('leave.myPermissions') : t('leave.permissions')}</SectionTitle>
      <Paper>
        <ErrorAlert error={permissions.error} />
        <PermissionsTable rows={permissions.data ?? []} canCancel={canCancel} />
      </Paper>

      <LeaveRequestModal opened={modal === 'leave'} onClose={() => setModal(null)} employeeId={employeeId} onBehalf={!self} />
      <PermissionModal opened={modal === 'permission'} onClose={() => setModal(null)} employeeId={employeeId} onBehalf={!self} />
      <AdjustModal opened={modal === 'adjust'} onClose={() => setModal(null)} employeeId={employeeId} />
      <LedgerModal employeeId={employeeId} balance={ledger} onClose={() => setLedger(null)} />
    </Stack>
  );
}

/** Employee self-service (LEV-03, LEV-05). */
export function LeavePage() {
  const { t } = useTranslation();
  const { session } = useAuth();
  const employeeId = session?.user.employeeId;
  return (
    <>
      <PageHeader title={t('leave.title')} />
      {employeeId ? <EmployeeLeaveTab employeeId={employeeId} /> : <Alert>{t('errors.FORBIDDEN')}</Alert>}
    </>
  );
}

/** HR / managers: company requests, recording for employees, leave types. */
export function LeaveManagePage() {
  const { t } = useTranslation();
  const { settings, can } = useAuth();
  const lang = settings.language;
  const companies = useCompanies();
  const [companyId, setCompanyId] = useState<string | null>(null);
  const company = companyId ?? companies.data?.[0]?.id ?? null;
  const now = new Date();
  const [from, setFrom] = useState(new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10));
  const [to, setTo] = useState(new Date(now.getFullYear(), now.getMonth() + 2, 0).toISOString().slice(0, 10));
  const requests = useQuery({
    queryKey: ['leave', 'company', company, from, to],
    queryFn: () => get<LeaveRequestDto[]>(`/leave/requests?companyId=${company}&from=${from}&to=${to}`),
    enabled: !!company && can('leave.request.view'),
  });
  const employees = useEmployeeOptions(can('leave.request.manage'));
  const [employeeId, setEmployeeId] = useState<string | null>(null);

  return (
    <>
      <PageHeader title={t('leave.manage')} />
      <Tabs defaultValue={can('leave.request.view') ? 'requests' : 'types'} keepMounted={false}>
        <Tabs.List mb="md">
          {can('leave.request.view') && <Tabs.Tab value="requests">{t('leave.requests')}</Tabs.Tab>}
          {can('leave.request.manage') && <Tabs.Tab value="record">{t('leave.recordFor')}</Tabs.Tab>}
          {can('leave.types.manage') && <Tabs.Tab value="types">{t('leave.types')}</Tabs.Tab>}
        </Tabs.List>
        <Tabs.Panel value="requests">
          <Group mb="md" align="flex-end" wrap="wrap">
            <Select w={240} label={t('leave.company')} data={(companies.data ?? []).map((c) => ({ value: c.id, label: localName(lang, c) }))} value={company} onChange={setCompanyId} allowDeselect={false} />
            <TextInput type="date" label={t('leave.from')} value={from} onChange={(e) => setFrom(e.currentTarget.value)} />
            <TextInput type="date" label={t('leave.to')} value={to} onChange={(e) => setTo(e.currentTarget.value)} />
          </Group>
          <Paper>
            <ErrorAlert error={requests.error} />
            <RequestsTable rows={requests.data ?? []} showEmployee canCancel={() => can('leave.request.manage')} />
          </Paper>
        </Tabs.Panel>
        <Tabs.Panel value="record">
          <Select
            mb="md"
            maw={420}
            label={t('leave.employee')}
            searchable
            data={(employees.data ?? []).map((e) => ({ value: e.id, label: `${e.employeeNo} · ${lang === 'ar' ? e.fullNameAr : e.fullNameEn}` }))}
            value={employeeId}
            onChange={setEmployeeId}
          />
          {employeeId && <EmployeeLeaveTab key={employeeId} employeeId={employeeId} />}
        </Tabs.Panel>
        <Tabs.Panel value="types">
          <LeaveTypesPanel />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}

function LeaveTypesPanel() {
  const { t } = useTranslation();
  const { settings } = useAuth();
  const lang = settings.language;
  const types = useLeaveTypes();
  const companies = useCompanies();
  const [edit, setEdit] = useState<LeaveTypeDto | 'new' | null>(null);
  return (
    <Paper>
      <Group justify="space-between" p="sm">
        <Text size="sm" c="dimmed">
          {t('leave.overrideHint')}
        </Text>
        <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEdit('new')}>
          {t('leave.newType')}
        </Button>
      </Group>
      <Table>
        <Table.Tbody>
          {types.data?.length === 0 && <EmptyRow colSpan={5} />}
          {types.data?.map((ty) => (
            <Table.Tr key={ty.id} onClick={() => setEdit(ty)} style={{ cursor: 'pointer' }} opacity={ty.status === 'active' ? 1 : 0.5}>
              <Table.Td dir="ltr" style={{ textAlign: 'start' }}>
                {ty.code}
              </Table.Td>
              <Table.Td>{lang === 'ar' ? ty.nameAr : ty.nameEn}</Table.Td>
              <Table.Td>{ty.companyId ? localName(lang, companies.data?.find((c) => c.id === ty.companyId) ?? { nameAr: '—', nameEn: '—' }) : t('leave.groupWide')}</Table.Td>
              <Table.Td>
                <Badge variant="light" color={ty.paid ? 'green' : 'gray'}>
                  {ty.paid ? t('leave.paid') : t('leave.unpaid')}
                </Badge>
              </Table.Td>
              <Table.Td>
                {ty.rules.accrual === 'none' ? t('leave.rules.accruals.none') : `${ty.rules.entitlementDays} · ${t(`leave.rules.accruals.${ty.rules.accrual}`)}`}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <LeaveTypeModal value={edit} onClose={() => setEdit(null)} />
    </Paper>
  );
}

function LeaveTypeModal({ value, onClose }: { value: LeaveTypeDto | 'new' | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { settings } = useAuth();
  const lang = settings.language;
  const qc = useQueryClient();
  const companies = useCompanies();
  const categories = useDocumentCategories();
  const isNew = value === 'new';
  const initial = value && value !== 'new' ? value : null;
  const [form, setForm] = useState<{ companyId: string | null; code: string; nameAr: string; nameEn: string; paid: boolean; status: 'active' | 'inactive'; rules: LeaveRules }>(() => ({
    companyId: initial?.companyId ?? null,
    code: initial?.code ?? '',
    nameAr: initial?.nameAr ?? '',
    nameEn: initial?.nameEn ?? '',
    paid: initial?.paid ?? true,
    status: initial?.status ?? 'active',
    rules: initial?.rules ?? DEFAULT_LEAVE_RULES,
  }));
  const [key, setKey] = useState<string | null>(null);
  const currentKey = initial?.id ?? (isNew ? 'new' : null);
  if (currentKey !== key) {
    setKey(currentKey);
    setForm({
      companyId: initial?.companyId ?? null,
      code: initial?.code ?? '',
      nameAr: initial?.nameAr ?? '',
      nameEn: initial?.nameEn ?? '',
      paid: initial?.paid ?? true,
      status: initial?.status ?? 'active',
      rules: initial?.rules ?? DEFAULT_LEAVE_RULES,
    });
  }
  const save = useMutation({
    mutationFn: () =>
      isNew
        ? post('/leave/types', { companyId: form.companyId, code: form.code, nameAr: form.nameAr, nameEn: form.nameEn, paid: form.paid, rules: form.rules })
        : patch(`/leave/types/${initial!.id}`, { nameAr: form.nameAr, nameEn: form.nameEn, paid: form.paid, status: form.status, rules: form.rules }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['leave'] });
      onClose();
      notifySaved(t);
    },
  });
  const r = form.rules;
  const setRule = <K extends keyof LeaveRules>(k: K, v: LeaveRules[K]) => setForm({ ...form, rules: { ...r, [k]: v } });
  const opt = (v: number | string) => (v === '' || v === null ? null : Number(v));
  const f = (k: string) => t(`leave.rules.${k}`);
  return (
    <Modal opened={!!value} onClose={onClose} size="xl" title={isNew ? t('leave.newType') : t('leave.editType')}>
      <Stack>
        <ErrorAlert error={save.error} />
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Select
            label={t('leave.company')}
            disabled={!isNew}
            data={[{ value: '', label: t('leave.groupWide') }, ...(companies.data ?? []).map((c) => ({ value: c.id, label: localName(lang, c) }))]}
            value={form.companyId ?? ''}
            onChange={(v) => setForm({ ...form, companyId: v || null })}
            allowDeselect={false}
          />
          <TextInput label={t('leave.code')} disabled={!isNew} value={form.code} onChange={(e) => setForm({ ...form, code: e.currentTarget.value.toUpperCase() })} dir="ltr" required />
          <TextInput label={t('leave.nameAr')} value={form.nameAr} onChange={(e) => setForm({ ...form, nameAr: e.currentTarget.value })} required />
          <TextInput label={t('leave.nameEn')} value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.currentTarget.value })} required />
          <Switch label={t('leave.paid')} checked={form.paid} onChange={(e) => setForm({ ...form, paid: e.currentTarget.checked })} />
          {!isNew && <Switch label={t('leave.active')} checked={form.status === 'active'} onChange={(e) => setForm({ ...form, status: e.currentTarget.checked ? 'active' : 'inactive' })} />}
        </SimpleGrid>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Select
            label={f('accrual')}
            data={(['yearly', 'monthly', 'none'] as const).map((x) => ({ value: x, label: f(`accruals.${x}`) }))}
            value={r.accrual}
            onChange={(v) => setRule('accrual', (v ?? 'yearly') as LeaveRules['accrual'])}
            allowDeselect={false}
          />
          {r.accrual !== 'none' ? (
            <NumberInput label={f('entitlementDays')} min={0} max={366} decimalScale={2} value={r.entitlementDays} onChange={(v) => setRule('entitlementDays', Number(v) || 0)} />
          ) : (
            <NumberInput label={f('maxDaysPerYear')} min={0} max={366} value={r.maxDaysPerYear ?? ''} onChange={(v) => setRule('maxDaysPerYear', opt(v))} />
          )}
          <Select
            label={f('countDays')}
            data={(['workdays', 'calendar'] as const).map((x) => ({ value: x, label: f(`countDayModes.${x}`) }))}
            value={r.countDays}
            onChange={(v) => setRule('countDays', (v ?? 'workdays') as LeaveRules['countDays'])}
            allowDeselect={false}
          />
          <Select
            label={f('deductWhen')}
            disabled={r.accrual === 'none'}
            data={(['approval', 'submission'] as const).map((x) => ({ value: x, label: f(`deductModes.${x}`) }))}
            value={r.deductWhen}
            onChange={(v) => setRule('deductWhen', (v ?? 'approval') as LeaveRules['deductWhen'])}
            allowDeselect={false}
          />
          {r.accrual !== 'none' && (
            <>
              <NumberInput label={f('allowNegativeDays')} min={0} max={366} value={r.allowNegativeDays} onChange={(v) => setRule('allowNegativeDays', Number(v) || 0)} />
              <NumberInput label={f('carryoverMaxDays')} min={0} max={366} value={r.carryoverMaxDays ?? ''} onChange={(v) => setRule('carryoverMaxDays', opt(v))} />
              <NumberInput label={f('carryoverExpiryMonths')} min={1} max={12} value={r.carryoverExpiryMonths ?? ''} onChange={(v) => setRule('carryoverExpiryMonths', opt(v))} />
            </>
          )}
          <NumberInput label={f('maxDaysPerRequest')} min={1} max={366} value={r.maxDaysPerRequest ?? ''} onChange={(v) => setRule('maxDaysPerRequest', opt(v))} />
          <NumberInput label={f('minNoticeDays')} min={0} max={365} value={r.minNoticeDays} onChange={(v) => setRule('minNoticeDays', Number(v) || 0)} />
          <NumberInput label={f('retroactiveDays')} min={0} max={365} value={r.retroactiveDays} onChange={(v) => setRule('retroactiveDays', Number(v) || 0)} />
          <Select
            label={f('attachment')}
            data={(['none', 'optional', 'required'] as const).map((x) => ({ value: x, label: f(`attachments.${x}`) }))}
            value={r.attachment}
            onChange={(v) => setRule('attachment', (v ?? 'none') as LeaveRules['attachment'])}
            allowDeselect={false}
          />
          {r.attachment !== 'none' && (
            <Select
              label={f('attachmentCategory')}
              clearable
              data={(categories.data ?? []).map((c) => ({ value: c.id, label: localName(lang, c) }))}
              value={r.attachmentCategoryId}
              onChange={(v) => setRule('attachmentCategoryId', v)}
            />
          )}
        </SimpleGrid>
        {r.accrual !== 'none' && (
          <Stack gap="xs">
            <Group justify="space-between">
              <Text size="sm" fw={500}>
                {f('serviceTiers')}
              </Text>
              <Button size="compact-xs" variant="light" onClick={() => setRule('serviceTiers', [...r.serviceTiers, { fromYears: 5, days: r.entitlementDays + 5 }])}>
                {f('addTier')}
              </Button>
            </Group>
            {r.serviceTiers.map((tier, i) => (
              <Group key={i} align="flex-end" gap="xs">
                <NumberInput w={140} label={f('fromYears')} min={1} max={60} value={tier.fromYears} onChange={(v) => setRule('serviceTiers', r.serviceTiers.map((x, n) => (n === i ? { ...x, fromYears: Number(v) || 1 } : x)))} />
                <NumberInput w={140} label={f('entitlementDays')} min={0} max={366} value={tier.days} onChange={(v) => setRule('serviceTiers', r.serviceTiers.map((x, n) => (n === i ? { ...x, days: Number(v) || 0 } : x)))} />
                <ActionIcon variant="subtle" color="red" mb={4} aria-label={t('emp.remove')} onClick={() => setRule('serviceTiers', r.serviceTiers.filter((_, n) => n !== i))}>
                  <IconTrash size={14} />
                </ActionIcon>
              </Group>
            ))}
          </Stack>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button disabled={!form.code || !form.nameAr || !form.nameEn} loading={save.isPending} onClick={() => save.mutate()}>
            {t('app.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
