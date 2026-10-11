import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  FileInput,
  Group,
  Modal,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { IconPaperclip } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { LeaveBalanceDto, LeaveRequestDto, LeaveTypeDto, LedgerEntryDto, PermissionRequestDto } from '@hrms/shared';
import { get, post, upload } from '../../lib/api';
import { useAuth } from '../../auth/AuthContext';
import { EmptyRow, ErrorAlert, StatusBadge, notifySaved } from '../../components/common';
import { DateField, TimeField } from '../../components/DateFields';

export const LEAVE_STATUS_COLOR: Record<string, string> = { pending: 'requested', approved: 'success', rejected: 'failed', cancelled: 'inactive' };
const today = () => new Date().toISOString().slice(0, 10);
const days = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export function useLeaveTypes() {
  return useQuery({ queryKey: ['leave', 'types'], queryFn: () => get<LeaveTypeDto[]>('/leave/types'), staleTime: 60_000 });
}

export function useBalances(employeeId: string | null | undefined) {
  return useQuery({
    queryKey: ['leave', 'balances', employeeId],
    queryFn: () => get<LeaveBalanceDto[]>(`/leave/employees/${employeeId}/balances`),
    enabled: !!employeeId,
  });
}

/** Balance per applicable leave type (LEV-02). */
export function BalanceCards({ employeeId, onLedger }: { employeeId: string; onLedger?: (b: LeaveBalanceDto) => void }) {
  const { t } = useTranslation();
  const { settings } = useAuth();
  const q = useBalances(employeeId);
  return (
    <>
      <ErrorAlert error={q.error} />
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
        {q.data?.map((b) => (
          <Card key={b.leaveTypeId} withBorder padding="md">
            <Group justify="space-between" mb={4}>
              <Text fw={600}>{settings.language === 'ar' ? b.nameAr : b.nameEn}</Text>
              {b.tracked && onLedger && (
                <Button size="compact-xs" variant="subtle" onClick={() => onLedger(b)}>
                  {t('leave.ledger')}
                </Button>
              )}
            </Group>
            {b.tracked ? (
              <>
                <Text size="xl" fw={700} c={b.available < 0 ? 'red' : undefined}>
                  {days(b.available)}{' '}
                  <Text span size="sm" c="dimmed" fw={400}>
                    {t('leave.available')}
                  </Text>
                </Text>
                <Text size="xs" c="dimmed">
                  {t('leave.balance')}: {days(b.balance)} · {t('leave.pendingDays')}: {days(b.pending)} · {t('leave.usedThisYear')}: {days(b.usedThisYear)}
                </Text>
              </>
            ) : (
              <Text size="sm" c="dimmed">
                {b.maxDaysPerYear !== null ? t('leave.perYear', { n: b.maxDaysPerYear }) : t('leave.noBalance')} · {t('leave.usedThisYear')}: {days(b.usedThisYear)}
              </Text>
            )}
          </Card>
        ))}
      </SimpleGrid>
    </>
  );
}

/** New leave request, for oneself or (staff) for an employee. */
export function LeaveRequestModal({ opened, onClose, employeeId, onBehalf }: { opened: boolean; onClose: () => void; employeeId: string; onBehalf?: boolean }) {
  const { t } = useTranslation();
  const { settings } = useAuth();
  const qc = useQueryClient();
  const balances = useBalances(opened ? employeeId : null);
  const types = useLeaveTypes();
  const [form, setForm] = useState({ leaveTypeId: '', startDate: today(), endDate: today(), reason: '' });
  const [file, setFile] = useState<File | null>(null);
  useEffect(() => {
    if (opened) {
      setForm({ leaveTypeId: '', startDate: today(), endDate: today(), reason: '' });
      setFile(null);
    }
  }, [opened]);
  const type = types.data?.find((x) => x.id === form.leaveTypeId);
  const submit = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.set('leaveTypeId', form.leaveTypeId);
      fd.set('startDate', form.startDate);
      fd.set('endDate', form.endDate);
      if (form.reason.trim()) fd.set('reason', form.reason.trim());
      if (onBehalf) fd.set('employeeId', employeeId);
      if (file) fd.set('file', file);
      return upload<LeaveRequestDto>('/leave/requests', fd);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['leave'] });
      onClose();
      notifySaved(t);
    },
  });
  const attachment = type?.rules.attachment ?? 'none';
  return (
    <Modal opened={opened} onClose={onClose} title={t('leave.request')}>
      <Stack>
        <ErrorAlert error={submit.error} />
        <Select
          label={t('leave.type')}
          data={(balances.data ?? []).map((b) => ({
            value: b.leaveTypeId,
            label: `${settings.language === 'ar' ? b.nameAr : b.nameEn}${b.tracked ? ` (${days(b.available)})` : ''}`,
          }))}
          value={form.leaveTypeId || null}
          onChange={(v) => setForm({ ...form, leaveTypeId: v ?? '' })}
          allowDeselect={false}
          required
        />
        <Group grow>
          <DateField label={t('leave.from')} value={form.startDate} onChange={(v) => setForm({ ...form, startDate: v, endDate: v > form.endDate ? v : form.endDate })} required />
          <DateField label={t('leave.to')} value={form.endDate} min={form.startDate} onChange={(v) => setForm({ ...form, endDate: v })} required />
        </Group>
        <Textarea label={t('leave.reason')} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.currentTarget.value })} autosize minRows={2} />
        {attachment !== 'none' && (
          <FileInput
            label={attachment === 'required' ? t('leave.attachmentRequired') : t('leave.attachment')}
            description={type?.rules.attachmentCategoryId ? t('leave.attachmentRestricted') : undefined}
            leftSection={<IconPaperclip size={16} />}
            accept=".pdf,.jpg,.jpeg,.png"
            value={file}
            onChange={setFile}
            clearable
            required={attachment === 'required'}
          />
        )}
        <Text size="xs" c="dimmed">
          {t('leave.chainNote')}
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button
            disabled={!form.leaveTypeId || form.endDate < form.startDate || (attachment === 'required' && !file)}
            loading={submit.isPending}
            onClick={() => submit.mutate()}
          >
            {t('leave.request')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function PermissionModal({ opened, onClose, employeeId, onBehalf }: { opened: boolean; onClose: () => void; employeeId: string; onBehalf?: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [form, setForm] = useState({ date: today(), startTime: '08:00', endTime: '09:00', reason: '' });
  useEffect(() => {
    if (opened) setForm({ date: today(), startTime: '08:00', endTime: '09:00', reason: '' });
  }, [opened]);
  const submit = useMutation({
    mutationFn: () => post<PermissionRequestDto>('/leave/permissions', { ...form, ...(onBehalf ? { employeeId } : {}) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['leave'] });
      onClose();
      notifySaved(t);
    },
  });
  return (
    <Modal opened={opened} onClose={onClose} title={t('leave.requestPermission')}>
      <Stack>
        <ErrorAlert error={submit.error} />
        <DateField label={t('leave.date')} value={form.date} onChange={(v) => setForm({ ...form, date: v })} required />
        <Group grow>
          <TimeField label={t('leave.start')} value={form.startTime} onChange={(v) => setForm({ ...form, startTime: v })} required />
          <TimeField label={t('leave.end')} value={form.endTime} onChange={(v) => setForm({ ...form, endTime: v })} required />
        </Group>
        <Textarea label={t('leave.reason')} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.currentTarget.value })} required autosize minRows={2} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button disabled={form.reason.trim().length < 3 || form.endTime <= form.startTime} loading={submit.isPending} onClick={() => submit.mutate()}>
            {t('leave.requestPermission')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Leave requests with status; cancel where the viewer may (the API decides finally). */
export function RequestsTable({ rows, showEmployee, canCancel }: { rows: LeaveRequestDto[]; showEmployee?: boolean; canCancel: (r: LeaveRequestDto) => boolean }) {
  const { t } = useTranslation();
  const { settings, fmt } = useAuth();
  const ar = settings.language === 'ar';
  const [cancel, setCancel] = useState<LeaveRequestDto | null>(null);
  return (
    <>
      <Table.ScrollContainer minWidth={720}>
        <Table>
          <Table.Thead>
            <Table.Tr>
              {showEmployee && <Table.Th>{t('leave.employee')}</Table.Th>}
              <Table.Th>{t('leave.type')}</Table.Th>
              <Table.Th>{t('leave.from')}</Table.Th>
              <Table.Th>{t('leave.to')}</Table.Th>
              <Table.Th>{t('leave.days')}</Table.Th>
              <Table.Th>{t('leave.status')}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.length === 0 && <EmptyRow colSpan={showEmployee ? 7 : 6} />}
            {rows.map((r) => (
              <Table.Tr key={r.id}>
                {showEmployee && <Table.Td>{ar ? r.employeeName.ar : r.employeeName.en}</Table.Td>}
                <Table.Td>
                  <Group gap={4} wrap="nowrap">
                    {ar ? r.leaveTypeName.ar : r.leaveTypeName.en}
                    {r.hasAttachment &&
                      (r.attachmentId ? (
                        <a href={`/api/v1/documents/${r.attachmentId}/content`} target="_blank" rel="noreferrer" aria-label={t('leave.attachment')}>
                          <IconPaperclip size={14} />
                        </a>
                      ) : (
                        <IconPaperclip size={14} color="gray" aria-label={t('leave.attachmentRestricted')} />
                      ))}
                  </Group>
                  {r.reason && (
                    <Text size="xs" c="dimmed" lineClamp={1}>
                      {r.reason}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>{fmt.date(r.startDate)}</Table.Td>
                <Table.Td>{fmt.date(r.endDate)}</Table.Td>
                <Table.Td>{days(r.days)}</Table.Td>
                <Table.Td>
                  <StatusBadge status={LEAVE_STATUS_COLOR[r.status] ?? 'inactive'} label={t(`leave.statuses.${r.status}`)} />
                  {r.cancelReason && (
                    <Text size="xs" c="dimmed">
                      {r.cancelReason}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  {(r.status === 'pending' || r.status === 'approved') && canCancel(r) && (
                    <Button size="compact-xs" variant="subtle" color="red" onClick={() => setCancel(r)}>
                      {t('leave.cancel')}
                    </Button>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      <CancelModal request={cancel} onClose={() => setCancel(null)} />
    </>
  );
}

function CancelModal({ request, onClose }: { request: LeaveRequestDto | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  useEffect(() => setReason(''), [request]);
  const save = useMutation({
    mutationFn: () => post(`/leave/requests/${request!.id}/cancel`, { reason }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['leave'] });
      await qc.invalidateQueries({ queryKey: ['attendance'] });
      onClose();
      notifySaved(t);
    },
  });
  return (
    <Modal opened={!!request} onClose={onClose} title={t('leave.cancel')}>
      <Stack>
        <ErrorAlert error={save.error} />
        {request?.status === 'approved' && <Alert color="yellow">{t('leave.cancelHint')}</Alert>}
        <Textarea label={t('leave.cancelReason')} value={reason} onChange={(e) => setReason(e.currentTarget.value)} required autosize minRows={2} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button color="red" disabled={reason.trim().length < 3} loading={save.isPending} onClick={() => save.mutate()}>
            {t('app.confirm')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function PermissionsTable({ rows, showEmployee, canCancel }: { rows: PermissionRequestDto[]; showEmployee?: boolean; canCancel: (p: PermissionRequestDto) => boolean }) {
  const { t } = useTranslation();
  const { settings, fmt } = useAuth();
  const qc = useQueryClient();
  const cancel = useMutation({
    mutationFn: (id: string) => post(`/leave/permissions/${id}/cancel`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['leave'] });
      notifySaved(t);
    },
  });
  return (
    <Table.ScrollContainer minWidth={600}>
      <ErrorAlert error={cancel.error} />
      <Table>
        <Table.Tbody>
          {rows.length === 0 && <EmptyRow colSpan={6} />}
          {rows.map((p) => (
            <Table.Tr key={p.id}>
              {showEmployee && <Table.Td>{settings.language === 'ar' ? p.employeeName.ar : p.employeeName.en}</Table.Td>}
              <Table.Td>{fmt.date(p.date)}</Table.Td>
              <Table.Td dir="ltr" style={{ textAlign: 'start' }}>
                {p.startTime} – {p.endTime}
              </Table.Td>
              <Table.Td>
                {p.minutes} {t('leave.minutes')}
                <Text size="xs" c="dimmed" lineClamp={1}>
                  {p.reason}
                </Text>
              </Table.Td>
              <Table.Td>
                <StatusBadge status={LEAVE_STATUS_COLOR[p.status] ?? 'inactive'} label={t(`leave.statuses.${p.status}`)} />
              </Table.Td>
              <Table.Td>
                {(p.status === 'pending' || p.status === 'approved') && canCancel(p) && (
                  <Button size="compact-xs" variant="subtle" color="red" loading={cancel.isPending && cancel.variables === p.id} onClick={() => cancel.mutate(p.id)}>
                    {t('leave.cancel')}
                  </Button>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

/** HR: opening balance or adjustment (audited, never one's own). */
export function AdjustModal({ opened, onClose, employeeId }: { opened: boolean; onClose: () => void; employeeId: string }) {
  const { t } = useTranslation();
  const { settings } = useAuth();
  const qc = useQueryClient();
  const balances = useBalances(opened ? employeeId : null);
  const [form, setForm] = useState({ leaveTypeId: '', kind: 'opening' as 'opening' | 'adjustment', amount: 0, effectiveDate: today(), note: '' });
  useEffect(() => {
    if (opened) setForm({ leaveTypeId: '', kind: 'opening', amount: 0, effectiveDate: today(), note: '' });
  }, [opened]);
  const save = useMutation({
    mutationFn: () => post('/leave/balances/adjust', { employeeId, ...form }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['leave'] });
      onClose();
      notifySaved(t);
    },
  });
  return (
    <Modal opened={opened} onClose={onClose} title={t('leave.adjust')}>
      <Stack>
        <ErrorAlert error={save.error} />
        <Select
          label={t('leave.type')}
          data={(balances.data ?? []).filter((b) => b.tracked).map((b) => ({ value: b.leaveTypeId, label: `${settings.language === 'ar' ? b.nameAr : b.nameEn} (${days(b.balance)})` }))}
          value={form.leaveTypeId || null}
          onChange={(v) => setForm({ ...form, leaveTypeId: v ?? '' })}
          allowDeselect={false}
        />
        <Select
          label={t('leave.note')}
          data={(['opening', 'adjustment'] as const).map((k) => ({ value: k, label: t(`leave.adjustKinds.${k}`) }))}
          value={form.kind}
          onChange={(v) => setForm({ ...form, kind: (v ?? 'opening') as 'opening' | 'adjustment' })}
          allowDeselect={false}
        />
        <Group grow>
          <NumberInput label={t('leave.amount')} decimalScale={2} min={-366} max={366} value={form.amount} onChange={(v) => setForm({ ...form, amount: Number(v) || 0 })} />
          <DateField label={t('leave.effectiveDate')} value={form.effectiveDate} max={today()} onChange={(v) => setForm({ ...form, effectiveDate: v })} />
        </Group>
        <Textarea label={t('leave.note')} value={form.note} onChange={(e) => setForm({ ...form, note: e.currentTarget.value })} required autosize minRows={2} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button disabled={!form.leaveTypeId || !form.amount || form.note.trim().length < 3} loading={save.isPending} onClick={() => save.mutate()}>
            {t('app.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function LedgerModal({ employeeId, balance, onClose }: { employeeId: string; balance: LeaveBalanceDto | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { settings, fmt } = useAuth();
  const q = useQuery({
    queryKey: ['leave', 'ledger', employeeId, balance?.leaveTypeId],
    queryFn: () => get<LedgerEntryDto[]>(`/leave/employees/${employeeId}/ledger?leaveTypeId=${balance!.leaveTypeId}`),
    enabled: !!balance,
  });
  return (
    <Modal opened={!!balance} onClose={onClose} size="lg" title={`${t('leave.ledger')} — ${balance ? (settings.language === 'ar' ? balance.nameAr : balance.nameEn) : ''}`}>
      <ErrorAlert error={q.error} />
      <Table>
        <Table.Tbody>
          {q.data?.length === 0 && <EmptyRow colSpan={4} />}
          {q.data?.map((e) => (
            <Table.Tr key={e.id}>
              <Table.Td>{fmt.date(e.effectiveDate)}</Table.Td>
              <Table.Td>{t(`leave.ledgerKinds.${e.kind}`)}</Table.Td>
              <Table.Td dir="ltr" style={{ textAlign: 'start' }} c={e.amount < 0 ? 'red.7' : 'green.8'}>
                {e.amount > 0 ? '+' : ''}
                {days(e.amount)}
              </Table.Td>
              <Table.Td>
                <Text size="xs" c="dimmed">
                  {e.note}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Modal>
  );
}

export function SectionTitle({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <Group justify="space-between" mb="sm" mt="lg">
      <Title order={3} size="h5">
        {children}
      </Title>
      {actions}
    </Group>
  );
}
