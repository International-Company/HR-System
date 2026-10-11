import { useEffect, useState } from 'react';
import {
  Alert,
  Anchor,
  Button,
  Checkbox,
  Group,
  Modal,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconDownload, IconPrinter } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import type { DatasetDef, ReportFilters, ReportResultDto, SavedReportDto } from '@hrms/shared';
import { del, download, get, post, put } from '../../lib/api';
import { useAuth } from '../../auth/AuthContext';
import { useCompanies, useDepartments } from '../../lib/refdata';
import { EmptyRow, ErrorAlert, PageHeader, localName, notifyError, notifySaved } from '../../components/common';
import { DateField, MonthField } from '../../components/DateFields';

type Schedule = SavedReportDto['schedule'];

/** Report builder on curated datasets (RPT-01..05). */
export function ReportsPage() {
  const { t } = useTranslation();
  const { settings, fmt, can } = useAuth();
  const lang = settings.language;
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const companies = useCompanies();
  const [filters, setFilters] = useState<ReportFilters>({ companyId: '' });
  const company = filters.companyId || companies.data?.[0]?.id || '';
  const catalogue = useQuery({ queryKey: ['reports', 'datasets', company], queryFn: () => get<DatasetDef[]>(`/reports/datasets?companyId=${company}`), enabled: !!company });
  const departments = useDepartments(company || null);
  const [dataset, setDataset] = useState<string | null>(null);
  const [fields, setFields] = useState<string[]>([]);
  const [result, setResult] = useState<ReportResultDto | null>(null);
  const [editing, setEditing] = useState<SavedReportDto | null>(null);
  const [saving, setSaving] = useState(false);
  const def = catalogue.data?.find((d) => d.key === dataset);
  const saved = useQuery({ queryKey: ['reports', 'saved'], queryFn: () => get<SavedReportDto[]>('/reports/saved') });
  const outputs = useQuery({ queryKey: ['reports', 'outputs'], queryFn: () => get<{ id: string; fileName: string; rowCount: number; createdAt: string }[]>('/reports/outputs') });

  useEffect(() => {
    // Keep only fields that the chosen dataset offers in this company.
    if (def) setFields((f) => (f.length ? f.filter((k) => def.fields.some((x) => x.key === k)) : def.fields.slice(0, 6).map((x) => x.key)));
  }, [def]);

  const body = () => ({ dataset, fields, filters: { ...filters, companyId: company } });
  const run = useMutation({ mutationFn: () => post<ReportResultDto>('/reports/run', body()), onSuccess: setResult });
  const exportAs = async (format: 'xlsx' | 'csv') => {
    try {
      await download(`/reports/export?format=${format}`, body());
    } catch (err) {
      notifyError(t, err);
    }
  };
  const load = (r: SavedReportDto) => {
    setFilters(r.filters);
    setDataset(r.dataset);
    setFields(r.fields);
    setEditing(r);
    setResult(null);
  };
  const remove = async (id: string) => {
    try {
      await del(`/reports/saved/${id}`);
      await qc.invalidateQueries({ queryKey: ['reports'] });
    } catch (err) {
      notifyError(t, err);
    }
  };
  const outputId = params.get('output');

  return (
    <>
      <style>{`@media print { body * { visibility: hidden; } #report-print, #report-print * { visibility: visible; } #report-print { position: absolute; inset: 0; } }`}</style>
      <PageHeader title={t('rpt.title')} subtitle={t('rpt.hiddenNote')} />
      {outputId && (
        <Alert mb="md">
          <Anchor href={`/api/v1/reports/outputs/${outputId}`}>{outputs.data?.find((o) => o.id === outputId)?.fileName ?? t('rpt.deliveries')}</Anchor>
        </Alert>
      )}
      <SimpleGrid cols={{ base: 1, lg: 3 }} spacing="md">
        <Paper p="md" style={{ gridColumn: 'span 2' }}>
          <Stack>
            <Title order={3} size="h5">
              {t('rpt.builder')}
            </Title>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <Select
                label={t('rpt.company')}
                data={(companies.data ?? []).map((c) => ({ value: c.id, label: localName(lang, c) }))}
                value={company || null}
                onChange={(v) => {
                  setFilters({ ...filters, companyId: v ?? '', departmentId: null });
                  setResult(null);
                }}
                allowDeselect={false}
              />
              <Select
                label={t('rpt.dataset')}
                data={(catalogue.data ?? []).map((d) => ({ value: d.key, label: lang === 'ar' ? d.ar : d.en }))}
                value={dataset}
                onChange={(v) => {
                  setDataset(v);
                  setFields([]);
                  setResult(null);
                  setEditing(null);
                }}
              />
            </SimpleGrid>
            {def && (
              <>
                <Text size="sm" fw={500}>
                  {t('rpt.fields')}
                </Text>
                <Group gap="sm">
                  <Checkbox label={t('rpt.selectAll')} checked={fields.length === def.fields.length} onChange={(e) => setFields(e.currentTarget.checked ? def.fields.map((f) => f.key) : [])} />
                  {def.fields.map((f) => (
                    <Checkbox key={f.key} label={lang === 'ar' ? f.ar : f.en} checked={fields.includes(f.key)} onChange={(e) => setFields(e.currentTarget.checked ? [...fields, f.key] : fields.filter((k) => k !== f.key))} />
                  ))}
                </Group>
                <Text size="sm" fw={500}>
                  {t('rpt.filters')}
                </Text>
                <Group align="flex-end" wrap="wrap">
                  {def.filters.includes('department') && (
                    <Select w={200} label={t('rpt.department')} clearable data={(departments.data ?? []).map((d) => ({ value: d.id, label: localName(lang, d) }))} value={filters.departmentId ?? null} onChange={(v) => setFilters({ ...filters, departmentId: v })} />
                  )}
                  {def.filters.includes('dateRange') && (
                    <>
                      <DateField label={t('rpt.from')} value={filters.from ?? ''} onChange={(v) => setFilters({ ...filters, from: v || undefined })} />
                      <DateField label={t('rpt.to')} value={filters.to ?? ''} onChange={(v) => setFilters({ ...filters, to: v || undefined })} />
                    </>
                  )}
                  {def.filters.includes('month') && <MonthField label={t('rpt.month')} value={filters.month ?? ''} onChange={(v) => setFilters({ ...filters, month: v || undefined })} />}
                  {def.filters.includes('status') && def.statuses && (
                    <Select w={180} label={t('rpt.status')} clearable data={def.statuses} value={filters.status ?? null} onChange={(v) => setFilters({ ...filters, status: v ?? undefined })} />
                  )}
                  {def.filters.includes('withinDays') && (
                    <NumberInput w={160} label={t('rpt.withinDays')} min={1} max={730} value={filters.withinDays ?? ''} onChange={(v) => setFilters({ ...filters, withinDays: v === '' ? undefined : Number(v) })} />
                  )}
                </Group>
                <Group>
                  <Button disabled={!fields.length} loading={run.isPending} onClick={() => run.mutate()}>
                    {t('rpt.run')}
                  </Button>
                  {can('reports.export') && (
                    <>
                      <Button variant="default" leftSection={<IconDownload size={16} />} disabled={!fields.length} onClick={() => void exportAs('xlsx')}>
                        {t('rpt.excel')}
                      </Button>
                      <Button variant="default" disabled={!fields.length} onClick={() => void exportAs('csv')}>
                        {t('rpt.csv')}
                      </Button>
                      <Button variant="default" leftSection={<IconPrinter size={16} />} disabled={!result} onClick={() => window.print()}>
                        {t('rpt.print')}
                      </Button>
                    </>
                  )}
                  <Button variant="light" disabled={!fields.length} onClick={() => setSaving(true)}>
                    {t('rpt.save')}
                  </Button>
                </Group>
              </>
            )}
            <ErrorAlert error={run.error ?? catalogue.error} />
          </Stack>
        </Paper>

        <Stack>
          <Paper p="md">
            <Title order={3} size="h5" mb="xs">
              {t('rpt.saved')}
            </Title>
            {saved.data?.length === 0 && <Text c="dimmed">—</Text>}
            {saved.data?.map((r) => (
              <Group key={r.id} justify="space-between" wrap="nowrap" mb={4}>
                <Stack gap={0}>
                  <Anchor component="button" onClick={() => load(r)} size="sm">
                    {r.name}
                  </Anchor>
                  <Text size="xs" c="dimmed">
                    {r.schedule ? `${t(`rpt.frequencies.${r.schedule.frequency}`)} · ${String(r.schedule.hour).padStart(2, '0')}:00` : t('rpt.noSchedule')}
                    {r.lastRunAt ? ` · ${t('rpt.lastRun')} ${fmt.dateTime(r.lastRunAt)}` : ''}
                  </Text>
                </Stack>
                <Button size="compact-xs" variant="subtle" color="red" onClick={() => void remove(r.id)}>
                  {t('rpt.delete')}
                </Button>
              </Group>
            ))}
          </Paper>
          <Paper p="md">
            <Title order={3} size="h5" mb="xs">
              {t('rpt.deliveries')}
            </Title>
            {outputs.data?.length === 0 && <Text c="dimmed">—</Text>}
            {outputs.data?.map((o) => (
              <Group key={o.id} justify="space-between">
                <Anchor href={`/api/v1/reports/outputs/${o.id}`} size="sm">
                  {o.fileName}
                </Anchor>
                <Text size="xs" c="dimmed">
                  {t('rpt.rows', { n: o.rowCount })} · {fmt.dateTime(o.createdAt)}
                </Text>
              </Group>
            ))}
          </Paper>
        </Stack>
      </SimpleGrid>

      {result && (
        <Paper mt="md" id="report-print">
          {result.truncated && <Alert color="orange">{t('rpt.truncated')}</Alert>}
          <Group justify="space-between" p="sm">
            <Title order={3} size="h5">
              {def ? (lang === 'ar' ? def.ar : def.en) : ''}
            </Title>
            <Text size="sm" c="dimmed">
              {t('rpt.rows', { n: result.rows.length })}
            </Text>
          </Group>
          <Table.ScrollContainer minWidth={Math.max(600, result.columns.length * 130)}>
            <Table striped>
              <Table.Thead>
                <Table.Tr>
                  {result.columns.map((c) => (
                    <Table.Th key={c.key}>{lang === 'ar' ? c.ar : c.en}</Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {result.rows.length === 0 && <EmptyRow colSpan={result.columns.length} />}
                {result.rows.map((r, i) => (
                  <Table.Tr key={i}>
                    {result.columns.map((c) => {
                      const v = r[c.key];
                      const shown = v === null || v === undefined ? '' : c.type === 'date' ? fmt.date(String(v)) : c.type === 'money' || c.type === 'number' || c.type === 'percent' ? fmt.number(Number(v)) + (c.type === 'percent' ? '%' : '') : String(v);
                      return <Table.Td key={c.key}>{shown}</Table.Td>;
                    })}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Paper>
      )}

      {saving && <SaveModal initial={editing} body={body()} onClose={() => setSaving(false)} />}
    </>
  );
}

function SaveModal({ initial, body, onClose }: { initial: SavedReportDto | null; body: { dataset: string | null; fields: string[]; filters: ReportFilters }; onClose: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [name, setName] = useState(initial?.name ?? '');
  const [schedule, setSchedule] = useState<Schedule>(initial?.schedule ?? null);
  const save = useMutation({
    mutationFn: () => (initial ? put(`/reports/saved/${initial.id}`, { ...body, name, schedule }) : post('/reports/saved', { ...body, name, schedule })),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['reports', 'saved'] });
      onClose();
      notifySaved(t);
    },
  });
  return (
    <Modal opened onClose={onClose} title={t('rpt.save')}>
      <Stack>
        <ErrorAlert error={save.error} />
        <TextInput label={t('rpt.name')} value={name} onChange={(e) => setName(e.currentTarget.value)} />
        {can('reports.export') && <Switch label={t('rpt.schedule')} checked={!!schedule} onChange={(e) => setSchedule(e.currentTarget.checked ? { frequency: 'weekly', hour: 7 } : null)} />}
        {schedule && (
          <Group grow>
            <Select
              label={t('rpt.frequency')}
              data={(['daily', 'weekly', 'monthly'] as const).map((f) => ({ value: f, label: t(`rpt.frequencies.${f}`) }))}
              value={schedule.frequency}
              onChange={(v) => setSchedule({ ...schedule, frequency: (v ?? 'weekly') as 'daily' | 'weekly' | 'monthly' })}
              allowDeselect={false}
            />
            <NumberInput label={t('rpt.hour')} min={0} max={23} value={schedule.hour} onChange={(v) => setSchedule({ ...schedule, hour: Number(v) || 0 })} />
          </Group>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button disabled={name.trim().length < 2} loading={save.isPending} onClick={() => save.mutate()}>
            {t('app.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
