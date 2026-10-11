import { Fragment, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
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
  Textarea,
  Title,
} from '@mantine/core';
import { IconChevronDown, IconChevronLeft, IconChevronRight, IconPlus, IconPrinter, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { EndOfServiceDto, GroupSummaryDto, PayLineDto, PayRunDetailDto, PayRunDto, PayslipDto } from '@hrms/shared';
import { get, post, put } from '../../lib/api';
import { useAuth } from '../../auth/AuthContext';
import { useCompanies, useEmployeeOptions } from '../../lib/refdata';
import { EmptyRow, ErrorAlert, PageHeader, StatusBadge, localName, notifyError, notifySaved } from '../../components/common';

const RUN_COLOR: Record<string, string> = { draft: 'inactive', submitted: 'requested', approved: 'success', superseded: 'inactive' };
const PAY_COLOR: Record<string, string> = { pending: 'requested', paid: 'success', failed: 'failed', cancelled: 'inactive' };

function useMoney() {
  const { settings } = useAuth();
  const locale = `${settings.language === 'ar' ? 'ar' : 'en-GB'}-u-nu-${settings.numerals}`;
  return (n: number, currency?: string) =>
    `${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}${currency ? ` ${currency}` : ''}`;
}

function lastMonth() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

function Totals({ totals }: { totals: PayRunDto['totals'] }) {
  const money = useMoney();
  const { t } = useTranslation();
  if (!totals.length) return <Text c="dimmed">—</Text>;
  return (
    <Stack gap={2}>
      {totals.map((x) => (
        <Text key={x.currency} size="sm">
          {t('pay.net')}: <b>{money(x.net, x.currency)}</b>{' '}
          <Text span size="xs" c="dimmed">
            ({x.employees})
          </Text>
        </Text>
      ))}
    </Stack>
  );
}

/** Payroll runs per company, group summary and end of service (PAY-02, PAY-11). */
export function PayrollPage() {
  const { t } = useTranslation();
  const { settings, can } = useAuth();
  const navigate = useNavigate();
  const lang = settings.language;
  const companies = useCompanies();
  const [companyId, setCompanyId] = useState<string | null>(null);
  const company = companyId ?? companies.data?.[0]?.id ?? null;
  const runs = useQuery({ queryKey: ['payroll', 'runs', company], queryFn: () => get<PayRunDto[]>(`/payroll/runs?companyId=${company}`), enabled: !!company && (can('payroll.view') || can('payroll.prepare')) });
  const [period, setPeriod] = useState(lastMonth());
  const create = useMutation({
    mutationFn: () => post<PayRunDetailDto>('/payroll/runs', { companyId: company, period }),
    onSuccess: (r) => void navigate(`/payroll/${r.id}`),
  });
  const runsTab = can('payroll.view') || can('payroll.prepare');
  return (
    <>
      <PageHeader title={t('pay.title')} />
      <Tabs defaultValue={runsTab ? 'runs' : 'summary'} keepMounted={false}>
        <Tabs.List mb="md">
          {runsTab && <Tabs.Tab value="runs">{t('pay.runs')}</Tabs.Tab>}
          {can('payroll.summary.view') && <Tabs.Tab value="summary">{t('pay.summary')}</Tabs.Tab>}
          {runsTab && <Tabs.Tab value="eos">{t('pay.eos')}</Tabs.Tab>}
        </Tabs.List>
        <Tabs.Panel value="runs">
          <Group mb="md" align="flex-end" wrap="wrap">
            <Select w={240} label={t('pay.company')} data={(companies.data ?? []).map((c) => ({ value: c.id, label: localName(lang, c) }))} value={company} onChange={setCompanyId} allowDeselect={false} />
            {can('payroll.prepare') && (
              <>
                <TextInput type="month" label={t('pay.period')} value={period} onChange={(e) => setPeriod(e.currentTarget.value)} dir="ltr" />
                <Button leftSection={<IconPlus size={16} />} loading={create.isPending} disabled={!company || !period} onClick={() => create.mutate()}>
                  {t('pay.newRun')}
                </Button>
              </>
            )}
          </Group>
          <ErrorAlert error={create.error ?? runs.error} />
          <Alert variant="light" color="yellow" mb="md">
            {t('pay.noStatutory')}
          </Alert>
          <Paper>
            <Table highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('pay.period')}</Table.Th>
                  <Table.Th>{t('pay.status')}</Table.Th>
                  <Table.Th>{t('pay.totals')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {runs.data?.length === 0 && <EmptyRow colSpan={3} />}
                {runs.data?.map((r) => (
                  <Table.Tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => void navigate(`/payroll/${r.id}`)} opacity={r.status === 'superseded' ? 0.55 : 1}>
                    <Table.Td dir="ltr" style={{ textAlign: 'start' }}>
                      {r.period}
                      {r.revision > 1 && (
                        <Text span size="xs" c="dimmed">
                          {' '}
                          · {t('pay.revision', { n: r.revision })}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <StatusBadge status={RUN_COLOR[r.status] ?? 'inactive'} label={t(`pay.statuses.${r.status}`)} />
                    </Table.Td>
                    <Table.Td>
                      <Totals totals={r.totals} />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Paper>
        </Tabs.Panel>
        <Tabs.Panel value="summary">
          <GroupSummary />
        </Tabs.Panel>
        <Tabs.Panel value="eos">
          <EndOfServicePanel />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}

function GroupSummary() {
  const { t } = useTranslation();
  const { settings } = useAuth();
  const money = useMoney();
  const companies = useCompanies();
  const [period, setPeriod] = useState(lastMonth());
  const q = useQuery({ queryKey: ['payroll', 'summary', period], queryFn: () => get<GroupSummaryDto>(`/payroll/summary?period=${period}`), enabled: /^\d{4}-\d{2}$/.test(period) });
  return (
    <Stack>
      <TextInput w={200} type="month" label={t('pay.period')} value={period} onChange={(e) => setPeriod(e.currentTarget.value)} dir="ltr" />
      <ErrorAlert error={q.error} />
      <Paper>
        <Table>
          <Table.Tbody>
            {q.data?.companies.map((c) => (
              <Table.Tr key={c.companyId}>
                <Table.Td>{localName(settings.language, companies.data?.find((x) => x.id === c.companyId) ?? { nameAr: '—', nameEn: '—' })}</Table.Td>
                <Table.Td>{c.status ? <StatusBadge status={RUN_COLOR[c.status] ?? 'inactive'} label={t(`pay.statuses.${c.status}`)} /> : <Text c="dimmed" size="sm">{t('pay.notCreated')}</Text>}</Table.Td>
                <Table.Td>
                  <Totals totals={c.totals} />
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Paper>
      {q.data && (
        <Card withBorder>
          <Title order={4} size="h5" mb="xs">
            {t('pay.totals')}
          </Title>
          {q.data.totals.map((x) => (
            <Text key={x.currency}>
              {t('pay.gross')} {money(x.gross, x.currency)} · {t('pay.deductions')} {money(x.deductions, x.currency)} · <b>{t('pay.net')} {money(x.net, x.currency)}</b> ({x.employees})
            </Text>
          ))}
          {q.data.converted && (
            <Text mt="xs">
              {t('pay.converted', { currency: q.data.converted.currency })}: <b>{money(q.data.converted.net, q.data.converted.currency)}</b>
              {q.data.converted.missingRates.length > 0 && (
                <Text span c="orange" size="sm">
                  {' '}
                  · {t('pay.missingRates', { list: q.data.converted.missingRates.join(', ') })}
                </Text>
              )}
            </Text>
          )}
        </Card>
      )}
    </Stack>
  );
}

function EndOfServicePanel() {
  const { t } = useTranslation();
  const { settings } = useAuth();
  const money = useMoney();
  const employees = useEmployeeOptions();
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [endDate, setEndDate] = useState(new Date().toISOString().slice(0, 10));
  const calc = useMutation({ mutationFn: () => get<EndOfServiceDto>(`/payroll/end-of-service/${employeeId}?endDate=${endDate}`) });
  return (
    <Stack maw={640}>
      <Group align="flex-end" wrap="wrap">
        <Select
          w={320}
          label={t('pay.employee')}
          searchable
          data={(employees.data ?? []).map((e) => ({ value: e.id, label: `${e.employeeNo} · ${settings.language === 'ar' ? e.fullNameAr : e.fullNameEn}` }))}
          value={employeeId}
          onChange={setEmployeeId}
        />
        <TextInput type="date" label={t('pay.eosEndDate')} value={endDate} onChange={(e) => setEndDate(e.currentTarget.value)} />
        <Button disabled={!employeeId} loading={calc.isPending} onClick={() => calc.mutate()}>
          {t('pay.calculate')}
        </Button>
      </Group>
      <ErrorAlert error={calc.error} />
      {calc.data && (
        <Card withBorder>
          <Text>
            {t('pay.serviceYears')}: <b>{calc.data.serviceYears}</b> · {t('pay.monthlyBase')}: <b>{money(calc.data.monthlyBase, calc.data.currency)}</b>
          </Text>
          <Text size="lg" mt="xs">
            {t('pay.eosResult')}: <b>{money(calc.data.amount, calc.data.currency)}</b>
          </Text>
          {calc.data.explanation.map((x, i) => (
            <Text key={i} size="xs" c="dimmed" dir="ltr" style={{ textAlign: 'start' }}>
              {x}
            </Text>
          ))}
        </Card>
      )}
    </Stack>
  );
}

// --- run detail -----------------------------------------------------------------------------

export function PayrollRunPage() {
  const { id } = useParams();
  const { t } = useTranslation();
  const { settings, can } = useAuth();
  const lang = settings.language;
  const money = useMoney();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['payroll', 'run', id], queryFn: () => get<PayRunDetailDto>(`/payroll/runs/${id}`) });
  const companies = useCompanies();
  const [open, setOpen] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ kind: 'item' | 'payment'; line: PayLineDto } | { kind: 'reopen' } | { kind: 'fx' } | null>(null);
  const run = q.data;
  const act = async (path: string) => {
    try {
      await post(path);
      await qc.invalidateQueries({ queryKey: ['payroll'] });
      notifySaved(t);
    } catch (err) {
      notifyError(t, err);
    }
  };
  if (!run) return <ErrorAlert error={q.error} />;
  const draft = run.status === 'draft' && can('payroll.prepare');
  const co = companies.data?.find((c) => c.id === run.companyId);
  return (
    <>
      <PageHeader
        title={`${t('pay.title')} ${run.period}`}
        subtitle={`${co ? localName(lang, co) : ''} · ${t('pay.revision', { n: run.revision })}`}
        actions={
          <Group gap="xs">
            {draft && (
              <>
                <Button variant="default" onClick={() => setDialog({ kind: 'fx' })}>
                  {t('pay.fxRates')}
                </Button>
                <Button variant="default" onClick={() => void act(`/payroll/runs/${run.id}/calculate`)}>
                  {t('pay.recalculate')}
                </Button>
                <Button onClick={() => void act(`/payroll/runs/${run.id}/submit`)}>{t('pay.submit')}</Button>
              </>
            )}
            {run.status === 'approved' && can('payroll.reopen') && (
              <Button variant="light" color="orange" onClick={() => setDialog({ kind: 'reopen' })}>
                {t('pay.reopen')}
              </Button>
            )}
          </Group>
        }
      />
      <Card withBorder mb="md">
        <Group gap="xl" wrap="wrap">
          <StatusBadge status={RUN_COLOR[run.status] ?? 'inactive'} label={t(`pay.statuses.${run.status}`)} />
          <Totals totals={run.totals} />
          {run.lockedAt && <Text size="sm">{t('pay.lockedNote')}</Text>}
          {run.reopenReason && <Text size="sm">{t('pay.reopenedNote', { reason: run.reopenReason })}</Text>}
          {run.revisionOfId && (
            <Anchor component={Link} to={`/payroll/${run.revisionOfId}`} size="sm">
              {t('pay.revision', { n: run.revision - 1 })}
            </Anchor>
          )}
          {run.workflowInstanceId && (
            <Anchor component={Link} to="/tasks?tab=mine" size="sm">
              {t('nav.tasks')}
            </Anchor>
          )}
        </Group>
      </Card>
      <Paper>
        <Table.ScrollContainer minWidth={760}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={36} />
                <Table.Th>{t('pay.employee')}</Table.Th>
                <Table.Th>{t('pay.days')}</Table.Th>
                <Table.Th>{t('pay.gross')}</Table.Th>
                <Table.Th>{t('pay.deductions')}</Table.Th>
                <Table.Th>{t('pay.net')}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {run.lines.length === 0 && <EmptyRow colSpan={7} />}
              {run.lines.map((l) => (
                <Fragment key={l.id}>
                  <Table.Tr style={{ cursor: 'pointer' }} onClick={() => setOpen(open === l.id ? null : l.id)}>
                    <Table.Td>{open === l.id ? <IconChevronDown size={16} /> : lang === 'ar' ? <IconChevronLeft size={16} /> : <IconChevronRight size={16} />}</Table.Td>
                    <Table.Td>
                      {lang === 'ar' ? l.employeeName.ar : l.employeeName.en}
                      <Text size="xs" c="dimmed" dir="ltr">
                        {l.employeeNo}
                      </Text>
                      {l.warnings.map((w) => (
                        <Badge key={w} size="xs" color="orange" variant="light" me={4}>
                          {t(`pay.warnings.${w}`, { defaultValue: w })}
                        </Badge>
                      ))}
                    </Table.Td>
                    <Table.Td>
                      {l.daysPaid}/{l.periodDays}
                    </Table.Td>
                    <Table.Td>{money(l.gross, l.currency)}</Table.Td>
                    <Table.Td>{money(l.deductions, l.currency)}</Table.Td>
                    <Table.Td fw={600}>{money(l.net, l.currency)}</Table.Td>
                    <Table.Td>
                      {l.payments.length > 0 && <StatusBadge status={PAY_COLOR[l.payments.at(-1)!.status] ?? 'inactive'} label={t(`pay.paymentStatuses.${l.payments.at(-1)!.status}`)} />}
                    </Table.Td>
                  </Table.Tr>
                  {open === l.id && (
                    <Table.Tr>
                      <Table.Td colSpan={7} bg="var(--mantine-color-gray-0)">
                        <LineDetail run={run} line={l} onAdd={() => setDialog({ kind: 'item', line: l })} onPay={() => setDialog({ kind: 'payment', line: l })} />
                      </Table.Td>
                    </Table.Tr>
                  )}
                </Fragment>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Paper>
      {dialog?.kind === 'item' && <ManualItemModal runId={run.id} line={dialog.line} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'payment' && <PaymentModal line={dialog.line} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'fx' && <FxModal run={run} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'reopen' && <ReopenModal run={run} onClose={() => setDialog(null)} onDone={(newId) => void navigate(`/payroll/${newId}`)} />}
    </>
  );
}

function ItemsTable({ items, currency, onRemove }: { items: PayLineDto['items']; currency: string; onRemove?: (id: string) => void }) {
  const { t } = useTranslation();
  const money = useMoney();
  return (
    <Table>
      <Table.Tbody>
        {items.map((i) => (
          <Table.Tr key={i.id}>
            <Table.Td>
              {i.label}
              <Text size="xs" c="dimmed">
                {t(`pay.sources.${i.source}`)}
              </Text>
            </Table.Td>
            <Table.Td dir="ltr" style={{ textAlign: 'start' }}>
              <Text size="xs" c="dimmed">
                {i.explanation}
              </Text>
            </Table.Td>
            <Table.Td c={i.kind === 'deduction' ? 'red.7' : undefined} style={{ whiteSpace: 'nowrap' }}>
              {i.kind === 'deduction' ? '− ' : ''}
              {money(i.amount, currency)}
            </Table.Td>
            {onRemove && (
              <Table.Td w={40}>
                {i.source === 'manual' && (
                  <ActionIcon size="sm" variant="subtle" color="red" aria-label={t('pay.remove')} onClick={() => onRemove(i.id)}>
                    <IconTrash size={14} />
                  </ActionIcon>
                )}
              </Table.Td>
            )}
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

function LineDetail({ run, line, onAdd, onPay }: { run: PayRunDetailDto; line: PayLineDto; onAdd: () => void; onPay: () => void }) {
  const { t } = useTranslation();
  const { can, fmt } = useAuth();
  const money = useMoney();
  const qc = useQueryClient();
  const draft = run.status === 'draft' && can('payroll.prepare');
  const remove = async (itemId: string) => {
    try {
      await post(`/payroll/runs/${run.id}/items/${itemId}/remove`);
      await qc.invalidateQueries({ queryKey: ['payroll'] });
    } catch (err) {
      notifyError(t, err);
    }
  };
  return (
    <Stack gap="xs" p="xs">
      <ItemsTable items={line.items} currency={line.currency} onRemove={draft ? (i) => void remove(i) : undefined} />
      <Group gap="xs">
        {draft && (
          <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={onAdd}>
            {t('pay.addItem')}
          </Button>
        )}
        {run.status === 'approved' && can('payroll.payments.manage') && (
          <Button size="xs" variant="light" onClick={onPay}>
            {t('pay.recordPayment')}
          </Button>
        )}
        <Button size="xs" variant="subtle" component={Link} to={`/payslips/${line.id}`}>
          {t('pay.payslip')}
        </Button>
      </Group>
      {line.payments.length > 0 && (
        <Table>
          <Table.Tbody>
            {line.payments.map((p) => (
              <Table.Tr key={p.id}>
                <Table.Td>{fmt.dateTime(p.createdAt)}</Table.Td>
                <Table.Td>
                  <StatusBadge status={PAY_COLOR[p.status] ?? 'inactive'} label={t(`pay.paymentStatuses.${p.status}`)} />
                </Table.Td>
                <Table.Td>{t(`pay.methods.${p.method}`)}</Table.Td>
                <Table.Td>{money(p.amount, p.currency)}</Table.Td>
                <Table.Td dir="ltr">{p.reference ?? ''}</Table.Td>
                <Table.Td>{p.paidOn ? fmt.date(p.paidOn) : ''}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

function ManualItemModal({ runId, line, onClose }: { runId: string; line: PayLineDto; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [form, setForm] = useState({ kind: 'earning' as 'earning' | 'deduction', label: '', amount: 0, note: '' });
  const save = useMutation({
    mutationFn: () => post(`/payroll/runs/${runId}/employees/${line.employeeId}/items`, { ...form, note: form.note || undefined }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['payroll'] });
      onClose();
      notifySaved(t);
    },
  });
  return (
    <Modal opened onClose={onClose} title={t('pay.addItem')}>
      <Stack>
        <ErrorAlert error={save.error} />
        <Select aria-label={t('pay.items')} data={(['earning', 'deduction'] as const).map((k) => ({ value: k, label: t(`pay.${k}`) }))} value={form.kind} onChange={(v) => setForm({ ...form, kind: (v ?? 'earning') as 'earning' | 'deduction' })} allowDeselect={false} />
        <TextInput label={t('pay.label')} value={form.label} onChange={(e) => setForm({ ...form, label: e.currentTarget.value })} />
        <NumberInput label={`${t('pay.amount')} (${line.currency})`} min={0.01} decimalScale={2} value={form.amount} onChange={(v) => setForm({ ...form, amount: Number(v) || 0 })} />
        <Textarea label={t('pay.note')} value={form.note} onChange={(e) => setForm({ ...form, note: e.currentTarget.value })} autosize />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button disabled={form.label.trim().length < 2 || form.amount <= 0} loading={save.isPending} onClick={() => save.mutate()}>
            {t('app.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function PaymentModal({ line, onClose }: { line: PayLineDto; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [form, setForm] = useState({ status: 'paid', method: 'bank_transfer', amount: line.net, reference: '', paidOn: new Date().toISOString().slice(0, 10), note: '' });
  const save = useMutation({
    mutationFn: () => post(`/payroll/lines/${line.id}/payments`, { ...form, reference: form.reference || undefined, note: form.note || undefined, paidOn: form.paidOn || undefined }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['payroll'] });
      onClose();
      notifySaved(t);
    },
  });
  return (
    <Modal opened onClose={onClose} title={t('pay.recordPayment')}>
      <Stack>
        <ErrorAlert error={save.error} />
        <SimpleGrid cols={2}>
          <Select label={t('pay.status')} data={['pending', 'paid', 'failed', 'cancelled'].map((s) => ({ value: s, label: t(`pay.paymentStatuses.${s}`) }))} value={form.status} onChange={(v) => setForm({ ...form, status: v ?? 'paid' })} allowDeselect={false} />
          <Select label={t('pay.method')} data={['bank_transfer', 'cash', 'cheque'].map((s) => ({ value: s, label: t(`pay.methods.${s}`) }))} value={form.method} onChange={(v) => setForm({ ...form, method: v ?? 'bank_transfer' })} allowDeselect={false} />
          <NumberInput label={`${t('pay.amount')} (${line.currency})`} decimalScale={2} min={0.01} value={form.amount} onChange={(v) => setForm({ ...form, amount: Number(v) || 0 })} />
          <TextInput type="date" label={t('pay.paidOn')} value={form.paidOn} onChange={(e) => setForm({ ...form, paidOn: e.currentTarget.value })} />
        </SimpleGrid>
        <TextInput label={t('pay.reference')} value={form.reference} onChange={(e) => setForm({ ...form, reference: e.currentTarget.value })} dir="ltr" />
        <Textarea label={t('pay.note')} value={form.note} onChange={(e) => setForm({ ...form, note: e.currentTarget.value })} autosize />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button disabled={form.amount <= 0} loading={save.isPending} onClick={() => save.mutate()}>
            {t('app.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function FxModal({ run, onClose }: { run: PayRunDetailDto; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [rows, setRows] = useState<{ currency: string; rate: number }[]>(Object.entries(run.fxRates).map(([currency, rate]) => ({ currency, rate })));
  const save = useMutation({
    mutationFn: () => put(`/payroll/runs/${run.id}/fx-rates`, { rates: Object.fromEntries(rows.filter((r) => /^[A-Z]{3}$/.test(r.currency) && r.rate > 0).map((r) => [r.currency, r.rate])) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['payroll'] });
      onClose();
      notifySaved(t);
    },
  });
  return (
    <Modal opened onClose={onClose} title={t('pay.fxRates')}>
      <Stack>
        <ErrorAlert error={save.error} />
        <Text size="sm" c="dimmed">
          {t('pay.fxHint')}
        </Text>
        {rows.map((r, i) => (
          <Group key={i} gap="xs" align="flex-end">
            <TextInput w={100} label={t('pay.currency')} value={r.currency} maxLength={3} dir="ltr" onChange={(e) => setRows(rows.map((x, n) => (n === i ? { ...x, currency: e.currentTarget.value.toUpperCase() } : x)))} />
            <NumberInput w={160} label={t('pay.rate')} decimalScale={6} min={0} value={r.rate} onChange={(v) => setRows(rows.map((x, n) => (n === i ? { ...x, rate: Number(v) || 0 } : x)))} />
            <ActionIcon mb={4} variant="subtle" color="red" aria-label={t('pay.remove')} onClick={() => setRows(rows.filter((_, n) => n !== i))}>
              <IconTrash size={14} />
            </ActionIcon>
          </Group>
        ))}
        <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setRows([...rows, { currency: '', rate: 1 }])}>
          {t('pay.currency')}
        </Button>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            {t('app.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function ReopenModal({ run, onClose, onDone }: { run: PayRunDetailDto; onClose: () => void; onDone: (id: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => post<PayRunDetailDto>(`/payroll/runs/${run.id}/reopen`, { reason }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['payroll'] });
      onClose();
      onDone(r.id);
    },
  });
  return (
    <Modal opened onClose={onClose} title={t('pay.reopen')}>
      <Stack>
        <ErrorAlert error={save.error} />
        <Alert color="orange">{t('pay.reopenHint')}</Alert>
        <Textarea label={t('pay.reopenReason')} value={reason} onChange={(e) => setReason(e.currentTarget.value)} required autosize minRows={2} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button color="orange" disabled={reason.trim().length < 5} loading={save.isPending} onClick={() => save.mutate()}>
            {t('pay.reopen')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// --- payslips (PAY-03) ----------------------------------------------------------------------

export function PayslipsPage() {
  const { t } = useTranslation();
  const money = useMoney();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['payroll', 'payslips'], queryFn: () => get<PayslipDto[]>('/payroll/payslips/mine') });
  return (
    <>
      <PageHeader title={t('pay.payslips')} />
      <ErrorAlert error={q.error} />
      <Paper>
        <Table highlightOnHover>
          <Table.Tbody>
            {q.data?.length === 0 && <EmptyRow colSpan={4} />}
            {q.data?.map((p) => (
              <Table.Tr key={p.lineId} style={{ cursor: 'pointer' }} onClick={() => void navigate(`/payslips/${p.lineId}`)}>
                <Table.Td dir="ltr" style={{ textAlign: 'start' }}>
                  {p.period}
                </Table.Td>
                <Table.Td>{money(p.net, p.currency)}</Table.Td>
                <Table.Td>{p.paymentStatus && <StatusBadge status={PAY_COLOR[p.paymentStatus] ?? 'inactive'} label={t(`pay.paymentStatuses.${p.paymentStatus}`)} />}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Paper>
    </>
  );
}

export function PayslipPage() {
  const { lineId } = useParams();
  const { t } = useTranslation();
  const { settings, fmt } = useAuth();
  const money = useMoney();
  const q = useQuery({ queryKey: ['payroll', 'payslip', lineId], queryFn: () => get<PayslipDto>(`/payroll/payslips/${lineId}`) });
  const p = q.data;
  if (!p) return <ErrorAlert error={q.error} />;
  const ar = settings.language === 'ar';
  return (
    <>
      <style>{`@media print { body * { visibility: hidden; } #payslip, #payslip * { visibility: visible; } #payslip { position: absolute; inset: 0; padding: 24px; } }`}</style>
      <PageHeader
        title={`${t('pay.payslip')} ${p.period}`}
        actions={
          <Button variant="default" leftSection={<IconPrinter size={16} />} onClick={() => window.print()}>
            {t('pay.print')}
          </Button>
        }
      />
      <Paper id="payslip" p="xl" withBorder maw={760}>
        <Group justify="space-between" mb="md" align="flex-start">
          <Stack gap={2}>
            <Title order={3} size="h4">
              {ar ? p.companyName.ar : p.companyName.en}
            </Title>
            <Text>
              {t('pay.payslip')} · <span dir="ltr">{p.period}</span>
            </Text>
          </Stack>
          <Stack gap={2} align="flex-end">
            <Text fw={600}>{ar ? p.employeeName.ar : p.employeeName.en}</Text>
            <Text size="sm" dir="ltr">
              {p.employeeNo}
            </Text>
            <Text size="sm">
              {t('pay.payDay')}: {fmt.date(p.payDay)} · {t('pay.days')}: {p.daysPaid}
            </Text>
          </Stack>
        </Group>
        <ItemsTable items={p.items} currency={p.currency} />
        <Group justify="flex-end" gap="xl" mt="md">
          <Text>
            {t('pay.gross')}: <b>{money(p.gross, p.currency)}</b>
          </Text>
          <Text>
            {t('pay.deductions')}: <b>{money(p.deductions, p.currency)}</b>
          </Text>
          <Text size="lg">
            {t('pay.net')}: <b>{money(p.net, p.currency)}</b>
          </Text>
        </Group>
        {p.paymentStatus && (
          <Text size="sm" mt="sm">
            {t('pay.status')}: {t(`pay.paymentStatuses.${p.paymentStatus}`)}
          </Text>
        )}
      </Paper>
    </>
  );
}
