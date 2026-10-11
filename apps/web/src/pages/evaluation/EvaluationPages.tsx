import { useState } from 'react';
import { Alert, Badge, Button, Group, Modal, Paper, Progress, Select, Stack, Table, Text, TextInput, Textarea, Tooltip } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { EvaluationResultDto } from '@hrms/shared';
import { get, post } from '../../lib/api';
import { useAuth } from '../../auth/AuthContext';
import { useCompanies } from '../../lib/refdata';
import { EmptyRow, ErrorAlert, PageHeader, StatusBadge, localName, notifySaved } from '../../components/common';

const color = (score: number) => (score >= 90 ? 'green' : score >= 75 ? 'teal' : score >= 60 ? 'yellow' : 'red');

function lastMonth() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

function Components({ r }: { r: EvaluationResultDto }) {
  const { t } = useTranslation();
  return (
    <Group gap={6} wrap="nowrap">
      {r.components
        .filter((c) => c.weight > 0)
        .map((c) => (
          <Tooltip key={c.key} label={`${t(`evl.components.${c.key}`)}: ${c.score} (${t('evl.weight')} ${c.weight}%) · ${c.detail}`} withArrow>
            <Progress value={c.score} color={color(c.score)} w={46} size="lg" />
          </Tooltip>
        ))}
    </Group>
  );
}

function ResultsTable({ rows, showEmployee }: { rows: EvaluationResultDto[]; showEmployee?: boolean }) {
  const { t } = useTranslation();
  const { settings } = useAuth();
  const ar = settings.language === 'ar';
  return (
    <Table.ScrollContainer minWidth={640}>
      <Table>
        <Table.Thead>
          <Table.Tr>
            {showEmployee ? <Table.Th>{t('evl.employee')}</Table.Th> : <Table.Th>{t('evl.period')}</Table.Th>}
            <Table.Th>{t('evl.score')}</Table.Th>
            <Table.Th>{t('evl.band')}</Table.Th>
            <Table.Th />
            <Table.Th>{t('evl.status')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.length === 0 && <EmptyRow colSpan={5} />}
          {rows.map((r) => (
            <Table.Tr key={r.id}>
              <Table.Td>
                {showEmployee ? (
                  <Link to={`/employees/${r.employeeId}`}>{ar ? r.employeeName.ar : r.employeeName.en}</Link>
                ) : (
                  <span dir="ltr">{r.period}</span>
                )}
              </Table.Td>
              <Table.Td>
                <Text fw={700} c={color(r.score)}>
                  {r.score.toFixed(1)}
                </Text>
              </Table.Td>
              <Table.Td>
                <Badge variant="light" color={color(r.score)}>
                  {ar ? r.band.nameAr : r.band.nameEn}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Components r={r} />
              </Table.Td>
              <Table.Td>
                <StatusBadge status={r.status === 'final' ? 'success' : 'inactive'} label={`${t(`evl.statuses.${r.status}`)} · ${t('evl.version', { n: r.calcVersion })}`} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

/** Company results per period: calculate, finalise, recalculate (CEV-02). */
export function EvaluationPage() {
  const { t } = useTranslation();
  const { settings, can } = useAuth();
  const qc = useQueryClient();
  const companies = useCompanies();
  const [companyId, setCompanyId] = useState<string | null>(null);
  const company = companyId ?? companies.data?.[0]?.id ?? null;
  const [period, setPeriod] = useState(lastMonth());
  const valid = /^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/.test(period);
  const list = useQuery({ queryKey: ['evaluation', company, period], queryFn: () => get<EvaluationResultDto[]>(`/evaluation/results?companyId=${company}&period=${period}`), enabled: !!company && valid });
  const [msg, setMsg] = useState<string | null>(null);
  const [recalc, setRecalc] = useState(false);
  const [reason, setReason] = useState('');
  const run = useMutation({
    mutationFn: (kind: 'calculate' | 'finalize' | 'recalculate') => post<{ calculated?: number; skippedFinal?: number; finalized?: number }>(`/evaluation/${kind}`, { companyId: company, period, ...(kind === 'recalculate' ? { reason } : {}) }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['evaluation'] });
      setMsg(r.finalized !== undefined ? t('evl.finalized', { n: r.finalized }) : t('evl.calculated', { calculated: r.calculated ?? 0, skipped: r.skippedFinal ?? 0 }));
      setRecalc(false);
      setReason('');
      notifySaved(t);
    },
  });
  const manage = can('evaluation.manage');
  return (
    <>
      <PageHeader title={t('evl.title')} subtitle={t('evl.intro')} />
      <Group mb="md" align="flex-end" wrap="wrap">
        <Select w={240} label={t('evl.company')} data={(companies.data ?? []).map((c) => ({ value: c.id, label: localName(settings.language, c) }))} value={company} onChange={setCompanyId} allowDeselect={false} />
        <TextInput w={140} label={t('evl.period')} placeholder="2026-03 / 2026-Q1" dir="ltr" value={period} onChange={(e) => setPeriod(e.currentTarget.value.toUpperCase())} error={!valid} />
        {manage && (
          <>
            <Button disabled={!valid} loading={run.isPending && run.variables === 'calculate'} onClick={() => run.mutate('calculate')}>
              {t('evl.calculate')}
            </Button>
            <Button variant="light" disabled={!valid || !list.data?.some((r) => r.status === 'draft')} loading={run.isPending && run.variables === 'finalize'} onClick={() => run.mutate('finalize')}>
              {t('evl.finalize')}
            </Button>
            <Button variant="subtle" color="orange" disabled={!valid || !list.data?.some((r) => r.status === 'final')} onClick={() => setRecalc(true)}>
              {t('evl.recalculate')}
            </Button>
          </>
        )}
      </Group>
      <ErrorAlert error={run.error ?? list.error} />
      {msg && (
        <Alert mb="md" withCloseButton onClose={() => setMsg(null)}>
          {msg}
        </Alert>
      )}
      <Paper>
        <ResultsTable rows={list.data ?? []} showEmployee />
      </Paper>
      <Modal opened={recalc} onClose={() => setRecalc(false)} title={t('evl.recalculate')}>
        <Stack>
          <Alert color="orange">{t('evl.recalcHint')}</Alert>
          <Textarea label={t('evl.reason')} autosize minRows={2} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setRecalc(false)}>
              {t('app.cancel')}
            </Button>
            <Button color="orange" disabled={reason.trim().length < 5} loading={run.isPending} onClick={() => run.mutate('recalculate')}>
              {t('evl.recalculate')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

/** Profile tab: the employee's results over time. */
export function EmployeeEvaluationTab({ employeeId }: { employeeId: string }) {
  const q = useQuery({ queryKey: ['evaluation', 'employee', employeeId], queryFn: () => get<EvaluationResultDto[]>(`/evaluation/employees/${employeeId}`) });
  return (
    <Paper p="md">
      <ErrorAlert error={q.error} />
      <ResultsTable rows={[...(q.data ?? [])].reverse()} />
    </Paper>
  );
}
