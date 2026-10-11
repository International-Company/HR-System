import { Fragment, useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  FileButton,
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
  Textarea,
  Title,
} from '@mantine/core';
import { IconLock, IconPlus, IconPrinter, IconSignature } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { ContractDto, ContractSummaryDto, ContractTemplateDto, ContractTypePolicy, ContractVersionDto } from '@hrms/shared';
import { get, post, put, upload } from '../../lib/api';
import { useAuth } from '../../auth/AuthContext';
import { useCompanies, useEmployeeOptions, useLookups } from '../../lib/refdata';
import { EmptyRow, ErrorAlert, PageHeader, StatusBadge, localName, notifyError, notifySaved } from '../../components/common';

const STATUS_COLOR: Record<string, string> = {
  draft: 'inactive',
  awaiting_signature: 'requested',
  active: 'success',
  expired: 'denied',
  ended: 'inactive',
  renewed: 'inactive',
  cancelled: 'inactive',
  signed: 'success',
};

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Contract text: plain text rendered safely (no HTML); blank line = paragraph, "# " = heading. */
export function ContractText({ body, language }: { body: string; language: 'ar' | 'en' }) {
  return (
    <div dir={language === 'ar' ? 'rtl' : 'ltr'} lang={language} style={{ textAlign: 'start' }}>
      {body.split(/\n{2,}/).map((p, i) =>
        p.startsWith('# ') ? (
          <Title key={i} order={3} size="h4" mb="sm" mt={i ? 'md' : 0}>
            {p.slice(2)}
          </Title>
        ) : (
          <Text key={i} mb="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {p}
          </Text>
        ),
      )}
    </div>
  );
}

export function useContractTypes() {
  const lookups = useLookups();
  return (lookups.data ?? []).filter((l) => l.kind === 'contract_type');
}

export function ContractsTable({ rows }: { rows: ContractSummaryDto[] }) {
  const { t } = useTranslation();
  const { settings, fmt } = useAuth();
  const types = useContractTypes();
  const lang = settings.language;
  return (
    <Table.ScrollContainer minWidth={760}>
      <Table highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('ctr.number')}</Table.Th>
            <Table.Th>{t('ctr.employee')}</Table.Th>
            <Table.Th>{t('ctr.type')}</Table.Th>
            <Table.Th>{t('ctr.start')}</Table.Th>
            <Table.Th>{t('ctr.end')}</Table.Th>
            <Table.Th>{t('ctr.status')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.length === 0 && <EmptyRow colSpan={6} />}
          {rows.map((c) => {
            const type = types.find((x) => x.id === c.contractTypeId);
            return (
              <Table.Tr key={c.id}>
                <Table.Td dir="ltr" style={{ textAlign: 'start' }}>
                  <Anchor component={Link} to={`/contracts/${c.id}`}>
                    {c.contractNo}
                  </Anchor>
                </Table.Td>
                <Table.Td>
                  {lang === 'ar' ? c.employeeName.ar : c.employeeName.en}
                  <Text size="xs" c="dimmed" dir="ltr">
                    {c.employeeNo}
                  </Text>
                </Table.Td>
                <Table.Td>{type ? localName(lang, type) : '—'}</Table.Td>
                <Table.Td>{fmt.date(c.startDate)}</Table.Td>
                <Table.Td>{c.endDate ? fmt.date(c.endDate) : t('ctr.openEnded')}</Table.Td>
                <Table.Td>
                  <StatusBadge status={STATUS_COLOR[c.status] ?? 'inactive'} label={t(`ctr.statuses.${c.status}`)} />
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

/** Contracts module (CON-10, CON-11). */
export function ContractsPage() {
  const { t } = useTranslation();
  const { settings, can, session } = useAuth();
  const lang = settings.language;
  const companies = useCompanies();
  const types = useContractTypes();
  const staff = can('contracts.manage') || can('contracts.sign') || !!session?.roles.some((r) => r.scopeType !== 'SELF' && session.permissions.includes('contracts.view'));
  const [filters, setFilters] = useState<{ companyId: string | null; status: string | null; contractTypeId: string | null; expiringWithin: number | ''; q: string }>({
    companyId: null,
    status: null,
    contractTypeId: null,
    expiringWithin: '',
    q: '',
  });
  const qs = new URLSearchParams(
    Object.entries(filters)
      .filter(([, v]) => v !== null && v !== '')
      .map(([k, v]) => [k, String(v)]),
  ).toString();
  const toSign = useQuery({ queryKey: ['contracts', 'to-sign'], queryFn: () => get<ContractSummaryDto[]>('/contracts/to-sign') });
  const mine = useQuery({
    queryKey: ['contracts', 'employee', session?.user.employeeId],
    queryFn: () => get<ContractSummaryDto[]>(`/contracts/employee/${session!.user.employeeId}`),
    enabled: !!session?.user.employeeId,
  });
  const search = useQuery({ queryKey: ['contracts', 'search', qs], queryFn: () => get<ContractSummaryDto[]>(`/contracts?${qs}`), enabled: staff });
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader
        title={t('ctr.title')}
        actions={
          can('contracts.manage') ? (
            <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
              {t('ctr.new')}
            </Button>
          ) : undefined
        }
      />
      <Tabs defaultValue={toSign.data?.length ? 'sign' : staff ? 'search' : 'mine'} keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="sign" rightSection={toSign.data?.length ? <Badge size="xs">{toSign.data.length}</Badge> : null}>
            {t('ctr.toSign')}
          </Tabs.Tab>
          {session?.user.employeeId && <Tabs.Tab value="mine">{t('ctr.mine')}</Tabs.Tab>}
          {staff && <Tabs.Tab value="search">{t('ctr.search')}</Tabs.Tab>}
        </Tabs.List>
        <Tabs.Panel value="sign">
          <Paper>
            <ContractsTable rows={toSign.data ?? []} />
          </Paper>
        </Tabs.Panel>
        <Tabs.Panel value="mine">
          <Paper>
            <ContractsTable rows={mine.data ?? []} />
          </Paper>
        </Tabs.Panel>
        <Tabs.Panel value="search">
          <Group mb="md" align="flex-end" wrap="wrap">
            <Select w={200} label={t('ctr.company')} clearable data={(companies.data ?? []).map((c) => ({ value: c.id, label: localName(lang, c) }))} value={filters.companyId} onChange={(v) => setFilters({ ...filters, companyId: v })} />
            <Select
              w={170}
              label={t('ctr.status')}
              clearable
              data={['draft', 'awaiting_signature', 'active', 'expired', 'ended', 'renewed', 'cancelled'].map((s) => ({ value: s, label: t(`ctr.statuses.${s}`) }))}
              value={filters.status}
              onChange={(v) => setFilters({ ...filters, status: v })}
            />
            <Select w={180} label={t('ctr.type')} clearable data={types.map((x) => ({ value: x.id, label: localName(lang, x) }))} value={filters.contractTypeId} onChange={(v) => setFilters({ ...filters, contractTypeId: v })} />
            <NumberInput w={150} label={t('ctr.expiringWithin')} min={1} max={365} value={filters.expiringWithin} onChange={(v) => setFilters({ ...filters, expiringWithin: v === '' ? '' : Number(v) })} />
            <TextInput w={220} label={t('ctr.query')} value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.currentTarget.value })} />
          </Group>
          <Paper>
            <ErrorAlert error={search.error} />
            <ContractsTable rows={search.data ?? []} />
          </Paper>
        </Tabs.Panel>
      </Tabs>
      <NewContractModal opened={creating} onClose={() => setCreating(false)} />
    </>
  );
}

export function NewContractModal({ opened, onClose, employeeId }: { opened: boolean; onClose: () => void; employeeId?: string }) {
  const { t } = useTranslation();
  const { settings } = useAuth();
  const lang = settings.language;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const employees = useEmployeeOptions(opened && !employeeId);
  const templates = useQuery({ queryKey: ['contracts', 'templates'], queryFn: () => get<ContractTemplateDto[]>('/contracts/templates'), enabled: opened });
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState<{ employeeId: string | null; templateId: string | null; startDate: string; endDate: string; probationEnd: string; fieldValues: Record<string, string> }>({
    employeeId: employeeId ?? null,
    templateId: null,
    startDate: today,
    endDate: '',
    probationEnd: '',
    fieldValues: {},
  });
  const tpl = templates.data?.find((x) => x.id === form.templateId);
  const create = useMutation({
    mutationFn: () =>
      post<ContractDto>('/contracts', {
        employeeId: employeeId ?? form.employeeId,
        templateId: form.templateId,
        startDate: form.startDate,
        endDate: form.endDate || null,
        probationEnd: form.probationEnd || null,
        fieldValues: form.fieldValues,
      }),
    onSuccess: async (c) => {
      await qc.invalidateQueries({ queryKey: ['contracts'] });
      onClose();
      void navigate(`/contracts/${c.id}`);
    },
  });
  return (
    <Modal opened={opened} onClose={onClose} title={t('ctr.new')} size="lg">
      <Stack>
        <ErrorAlert error={create.error} />
        {!employeeId && (
          <Select
            label={t('ctr.employee')}
            searchable
            data={(employees.data ?? []).map((e) => ({ value: e.id, label: `${e.employeeNo} · ${lang === 'ar' ? e.fullNameAr : e.fullNameEn}` }))}
            value={form.employeeId}
            onChange={(v) => setForm({ ...form, employeeId: v })}
          />
        )}
        <Select
          label={t('ctr.template')}
          data={(templates.data ?? []).filter((x) => x.status === 'active').map((x) => ({ value: x.id, label: `${x.name} (${t(`ctr.languages.${x.language}`)})` }))}
          value={form.templateId}
          onChange={(v) => setForm({ ...form, templateId: v, fieldValues: {} })}
        />
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <TextInput type="date" label={t('ctr.start')} value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.currentTarget.value })} required />
          <TextInput type="date" label={t('ctr.end')} value={form.endDate} min={form.startDate} onChange={(e) => setForm({ ...form, endDate: e.currentTarget.value })} />
          <TextInput type="date" label={t('ctr.probationEnd')} value={form.probationEnd} onChange={(e) => setForm({ ...form, probationEnd: e.currentTarget.value })} />
        </SimpleGrid>
        {tpl?.fields.map((f) => (
          <TextInput key={f.key} label={f.label} required={f.required} value={form.fieldValues[f.key] ?? ''} onChange={(e) => setForm({ ...form, fieldValues: { ...form.fieldValues, [f.key]: e.currentTarget.value } })} />
        ))}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button disabled={!(employeeId ?? form.employeeId) || !form.templateId} loading={create.isPending} onClick={() => create.mutate()}>
            {t('app.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Contracts tab in the employee profile (CON-10). */
export function EmployeeContractsTab({ employeeId }: { employeeId: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const list = useQuery({ queryKey: ['contracts', 'employee', employeeId], queryFn: () => get<ContractSummaryDto[]>(`/contracts/employee/${employeeId}`) });
  const [creating, setCreating] = useState(false);
  return (
    <Paper p="md">
      {can('contracts.manage') && (
        <Group justify="flex-end" mb="sm">
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)}>
            {t('ctr.new')}
          </Button>
        </Group>
      )}
      <ErrorAlert error={list.error} />
      <ContractsTable rows={list.data ?? []} />
      <NewContractModal opened={creating} onClose={() => setCreating(false)} employeeId={employeeId} />
    </Paper>
  );
}

// --- detail ---------------------------------------------------------------------------------

type Dialog =
  | { kind: 'sign'; version: ContractVersionDto; signatureId: string }
  | { kind: 'edit' }
  | { kind: 'addendum' }
  | { kind: 'renew' }
  | { kind: 'end' }
  | { kind: 'probation' }
  | null;

export function ContractDetailPage() {
  const { id } = useParams();
  const { t } = useTranslation();
  const { settings, fmt, can } = useAuth();
  const lang = settings.language;
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['contracts', 'detail', id], queryFn: () => get<ContractDto>(`/contracts/${id}`) });
  const related = useQuery({ queryKey: ['contracts', 'related', q.data?.renewalOfId, q.data?.renewedById], queryFn: async () => {
    const ids = [q.data?.renewalOfId, q.data?.renewedById].filter(Boolean) as string[];
    return Promise.all(ids.map((x) => get<ContractDto>(`/contracts/${x}`).catch(() => null)));
  }, enabled: !!q.data && !!(q.data.renewalOfId || q.data.renewedById) });
  const types = useContractTypes();
  const [dialog, setDialog] = useState<Dialog>(null);
  const c = q.data;
  const manage = can('contracts.manage');
  const refresh = () => qc.invalidateQueries({ queryKey: ['contracts'] });
  const act = async (path: string, body?: unknown) => {
    try {
      await post(path, body);
      await refresh();
      notifySaved(t);
    } catch (err) {
      notifyError(t, err);
    }
  };
  const uploadCopy = async (versionId: string, file: File | null) => {
    if (!file) return;
    const fd = new FormData();
    fd.set('file', file);
    try {
      await upload(`/contracts/${id}/versions/${versionId}/signed-copy`, fd);
      await refresh();
      notifySaved(t);
    } catch (err) {
      notifyError(t, err);
    }
  };

  if (!c) return <ErrorAlert error={q.error} />;
  const type = types.find((x) => x.id === c.contractTypeId);
  const openVersion = c.versions.some((v) => v.status === 'draft' || v.status === 'awaiting_signature');
  const byId = (x: string | null) => related.data?.find((r) => r?.id === x);

  return (
    <>
      <style>{`@media print { body * { visibility: hidden; } #contract-print, #contract-print * { visibility: visible; } #contract-print { position: absolute; inset: 0; padding: 24px; } .no-print { display: none !important; } }`}</style>
      <PageHeader
        title={`${t('ctr.title')} ${c.contractNo}`}
        subtitle={`${lang === 'ar' ? c.employeeName.ar : c.employeeName.en} · ${type ? localName(lang, type) : ''}`}
        actions={
          <Group gap="xs" className="no-print">
            <Button variant="default" leftSection={<IconPrinter size={16} />} onClick={() => window.print()}>
              {t('ctr.print')}
            </Button>
            {manage && c.status === 'draft' && <Button variant="default" onClick={() => setDialog({ kind: 'edit' })}>{t('ctr.edit')}</Button>}
            {manage && c.status === 'active' && !openVersion && (
              <>
                <Button variant="default" onClick={() => setDialog({ kind: 'addendum' })}>
                  {t('ctr.addendum')}
                </Button>
                {c.endDate && <Button variant="default" onClick={() => setDialog({ kind: 'renew' })}>{t('ctr.renew')}</Button>}
                {c.probationEnd && (!c.probationOutcome || c.probationOutcome === 'extended') && (
                  <Button variant="default" onClick={() => setDialog({ kind: 'probation' })}>
                    {t('ctr.probation')}
                  </Button>
                )}
                <Button variant="light" color="red" onClick={() => setDialog({ kind: 'end' })}>
                  {t('ctr.endContract')}
                </Button>
              </>
            )}
            {manage && c.status === 'expired' && c.endDate && <Button variant="default" onClick={() => setDialog({ kind: 'renew' })}>{t('ctr.renew')}</Button>}
          </Group>
        }
      />
      <Card withBorder mb="md" className="no-print">
        <Group gap="xl" wrap="wrap">
          <StatusBadge status={STATUS_COLOR[c.status] ?? 'inactive'} label={t(`ctr.statuses.${c.status}`)} />
          <Text size="sm">
            {t('ctr.start')}: <b>{fmt.date(c.startDate)}</b>
          </Text>
          <Text size="sm">
            {t('ctr.end')}: <b>{c.endDate ? fmt.date(c.endDate) : t('ctr.openEnded')}</b>
          </Text>
          {c.probationEnd && (
            <Text size="sm">
              {t('ctr.probationEnd')}: <b>{fmt.date(c.probationEnd)}</b>
              {c.probationOutcome && ` · ${t(`ctr.outcomes.${c.probationOutcome}`)}`}
            </Text>
          )}
          {c.renewalOfId && (
            <Anchor component={Link} to={`/contracts/${c.renewalOfId}`} size="sm">
              {t('ctr.renewalOf', { no: byId(c.renewalOfId)?.contractNo ?? '…' })}
            </Anchor>
          )}
          {c.renewedById && (
            <Anchor component={Link} to={`/contracts/${c.renewedById}`} size="sm">
              {t('ctr.renewedBy', { no: byId(c.renewedById)?.contractNo ?? '…' })}
            </Anchor>
          )}
          {c.endReason && <Text size="sm">{c.endReason}</Text>}
        </Group>
      </Card>

      <div id="contract-print">
        {c.versions.map((v) => (
          <Paper key={v.id} p="lg" mb="md" withBorder>
            <Group justify="space-between" mb="sm" className="no-print" wrap="wrap">
              <Group gap="xs">
                <Badge variant="light">{t(`ctr.kinds.${v.kind}`)}</Badge>
                <Text size="sm" c="dimmed">
                  {t('ctr.version', { n: v.versionNo })} · {t('ctr.effective')} {fmt.date(v.effectiveDate)}
                </Text>
                <StatusBadge status={STATUS_COLOR[v.status] ?? 'inactive'} label={t(`ctr.versionStatuses.${v.status}`)} />
                {v.lockedAt && <IconLock size={14} aria-label={t('ctr.lockedNote')} />}
              </Group>
              {manage && (v.status === 'draft' || v.status === 'awaiting_signature') && (
                <Group gap="xs">
                  {v.status === 'draft' && (
                    <Button size="xs" onClick={() => void act(`/contracts/${id}/versions/${v.id}/send`)}>
                      {t('ctr.send')}
                    </Button>
                  )}
                  <FileButton onChange={(f) => void uploadCopy(v.id, f)} accept="application/pdf,image/jpeg,image/png">
                    {(props) => (
                      <Button size="xs" variant="default" {...props}>
                        {t('ctr.uploadSigned')}
                      </Button>
                    )}
                  </FileButton>
                  <Button size="xs" variant="subtle" color="red" onClick={() => void act(`/contracts/${id}/versions/${v.id}/cancel`)}>
                    {t('ctr.cancelVersion')}
                  </Button>
                </Group>
              )}
            </Group>
            {v.status !== 'cancelled' && <ContractText body={v.body} language={v.language} />}
            {v.lockedAt && (
              <Text size="xs" c="dimmed" className="no-print">
                {t('ctr.lockedNote')}
              </Text>
            )}
            {v.signatures.length > 0 && (
              <Stack gap={4} mt="md">
                <Text size="sm" fw={600}>
                  {t('ctr.signatures')}
                </Text>
                {v.signatures.map((s) => (
                  <Fragment key={s.id}>
                    <Group gap="xs" wrap="wrap">
                      <Text size="sm" w={110}>
                        {t(`ctr.roles.${s.role}`)}
                      </Text>
                      {s.status === 'signed' ? (
                        <Text size="sm">
                          {s.typedName ?? s.signerName ?? '—'} · {s.signedAt ? fmt.dateTime(s.signedAt) : ''} · {s.method ? t(`ctr.methods.${s.method}`) : ''}
                        </Text>
                      ) : (
                        <Text size="sm" c="dimmed">
                          {t('ctr.pending')}
                        </Text>
                      )}
                      {s.canSign && (
                        <Button size="compact-xs" className="no-print" leftSection={<IconSignature size={14} />} onClick={() => setDialog({ kind: 'sign', version: v, signatureId: s.id })}>
                          {t('ctr.sign')}
                        </Button>
                      )}
                    </Group>
                    {s.status === 'signed' && (s.ip || s.documentHash) && (
                      <Text size="xs" c="dimmed" dir="ltr" style={{ textAlign: 'start', wordBreak: 'break-all' }} className="no-print">
                        {s.ip ? `IP ${s.ip} · ` : ''}
                        {s.userAgent ? `${s.userAgent.slice(0, 80)} · ` : ''}
                        SHA-256 {s.documentHash}
                      </Text>
                    )}
                  </Fragment>
                ))}
                {v.signedCopyId && (
                  <Anchor href={`/api/v1/documents/${v.signedCopyId}/content`} size="sm" className="no-print">
                    {t('ctr.signedCopy')}
                  </Anchor>
                )}
              </Stack>
            )}
          </Paper>
        ))}
      </div>

      {dialog?.kind === 'sign' && <SignModal version={dialog.version} signatureId={dialog.signatureId} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && <EditDraftModal contract={c} onClose={() => setDialog(null)} />}
      {dialog && ['addendum', 'renew', 'end', 'probation'].includes(dialog.kind) && (
        <ChangeModal kind={dialog.kind as 'addendum' | 'renew' | 'end' | 'probation'} contract={c} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

function SignModal({ version, signatureId, onClose }: { version: ContractVersionDto; signatureId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const sign = useMutation({
    mutationFn: async () => post(`/contracts/signatures/${signatureId}/sign`, { documentHash: await sha256(version.body), typedName: name, consent: true }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['contracts'] });
      onClose();
      notifySaved(t);
    },
  });
  return (
    <Modal opened onClose={onClose} title={t('ctr.signTitle')} size="lg">
      <Stack>
        <ErrorAlert error={sign.error} />
        <Paper withBorder p="md" mah={320} style={{ overflow: 'auto' }}>
          <ContractText body={version.body} language={version.language} />
        </Paper>
        <Alert variant="light">{t('ctr.signNote')}</Alert>
        <TextInput label={t('ctr.typedName')} value={name} onChange={(e) => setName(e.currentTarget.value)} required />
        <Checkbox label={t('ctr.consent')} checked={consent} onChange={(e) => setConsent(e.currentTarget.checked)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button leftSection={<IconSignature size={16} />} disabled={!consent || name.trim().length < 3} loading={sign.isPending} onClick={() => sign.mutate()}>
            {t('ctr.sign')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function EditDraftModal({ contract: c, onClose }: { contract: ContractDto; onClose: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const templates = useQuery({ queryKey: ['contracts', 'templates'], queryFn: () => get<ContractTemplateDto[]>('/contracts/templates') });
  const v = c.versions[0]!;
  const tpl = templates.data?.find((x) => x.id === c.templateId);
  const [form, setForm] = useState({ startDate: c.startDate, endDate: c.endDate ?? '', probationEnd: c.probationEnd ?? '', fieldValues: {} as Record<string, string>, manual: false, body: v.body });
  const save = useMutation({
    mutationFn: () =>
      put(`/contracts/${c.id}/draft`, {
        startDate: form.startDate,
        endDate: form.endDate || null,
        probationEnd: form.probationEnd || null,
        fieldValues: form.fieldValues,
        bodyOverride: form.manual ? form.body : null,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['contracts'] });
      onClose();
      notifySaved(t);
    },
  });
  return (
    <Modal opened onClose={onClose} title={t('ctr.edit')} size="xl">
      <Stack>
        <ErrorAlert error={save.error} />
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <TextInput type="date" label={t('ctr.start')} value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.currentTarget.value })} />
          <TextInput type="date" label={t('ctr.end')} value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.currentTarget.value })} />
          <TextInput type="date" label={t('ctr.probationEnd')} value={form.probationEnd} onChange={(e) => setForm({ ...form, probationEnd: e.currentTarget.value })} />
        </SimpleGrid>
        {!form.manual &&
          tpl?.fields.map((f) => (
            <TextInput key={f.key} label={f.label} required={f.required} value={form.fieldValues[f.key] ?? ''} onChange={(e) => setForm({ ...form, fieldValues: { ...form.fieldValues, [f.key]: e.currentTarget.value } })} />
          ))}
        {can('contracts.manual_edit') && <Switch label={t('ctr.manualText')} checked={form.manual} onChange={(e) => setForm({ ...form, manual: e.currentTarget.checked })} />}
        {form.manual && <Textarea autosize minRows={12} value={form.body} onChange={(e) => setForm({ ...form, body: e.currentTarget.value })} dir={v.language === 'ar' ? 'rtl' : 'ltr'} />}
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

function ChangeModal({ kind, contract: c, onClose }: { kind: 'addendum' | 'renew' | 'end' | 'probation'; contract: ContractDto; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({ date: kind === 'end' ? today : '', text: '', outcome: 'confirmed' as 'confirmed' | 'extended' | 'not_confirmed' });
  const save = useMutation({
    mutationFn: () => {
      if (kind === 'addendum') return post<ContractDto>(`/contracts/${c.id}/addenda`, { templateId: null, effectiveDate: form.date || today, body: form.text, fieldValues: {} });
      if (kind === 'renew') return post<ContractDto>(`/contracts/${c.id}/renew`, { newEndDate: form.date, templateId: null });
      if (kind === 'end') return post<ContractDto>(`/contracts/${c.id}/end`, { endDate: form.date, reason: form.text });
      return post<ContractDto>(`/contracts/${c.id}/probation`, { outcome: form.outcome, newProbationEnd: form.outcome === 'extended' ? form.date : null, note: form.text });
    },
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ['contracts'] });
      onClose();
      notifySaved(t);
      if (res.id !== c.id) void navigate(`/contracts/${res.id}`);
    },
  });
  const title = { addendum: t('ctr.addendum'), renew: t('ctr.renew'), end: t('ctr.endContract'), probation: t('ctr.probation') }[kind];
  return (
    <Modal opened onClose={onClose} title={title} size={kind === 'addendum' ? 'lg' : 'md'}>
      <Stack>
        <ErrorAlert error={save.error} />
        {kind === 'probation' && (
          <Select
            label={t('ctr.probationOutcome')}
            data={(['confirmed', 'extended', 'not_confirmed'] as const).map((o) => ({ value: o, label: t(`ctr.outcomes.${o}`) }))}
            value={form.outcome}
            onChange={(v) => setForm({ ...form, outcome: (v ?? 'confirmed') as typeof form.outcome })}
            allowDeselect={false}
          />
        )}
        {(kind !== 'probation' || form.outcome === 'extended') && (
          <TextInput
            type="date"
            label={{ addendum: t('ctr.effective'), renew: t('ctr.newEnd'), end: t('ctr.endDate'), probation: t('ctr.newProbationEnd') }[kind]}
            value={form.date}
            onChange={(e) => setForm({ ...form, date: e.currentTarget.value })}
          />
        )}
        {kind !== 'renew' && (
          <Textarea
            label={kind === 'addendum' ? t('ctr.addendumText') : kind === 'end' ? t('ctr.reason') : t('ctr.note')}
            autosize
            minRows={kind === 'addendum' ? 8 : 2}
            value={form.text}
            onChange={(e) => setForm({ ...form, text: e.currentTarget.value })}
          />
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button color={kind === 'end' ? 'red' : undefined} disabled={(kind !== 'addendum' && kind !== 'probation' && !form.date) || (kind !== 'renew' && form.text.trim().length < 3)} loading={save.isPending} onClick={() => save.mutate()}>
            {t('app.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// --- setup (CON-01, CON-04) ---------------------------------------------------------------------

export function ContractTypeRules() {
  const { t } = useTranslation();
  const { settings } = useAuth();
  const qc = useQueryClient();
  const types = useContractTypes();
  const policies = useQuery({ queryKey: ['contracts', 'type-policies'], queryFn: () => get<{ contractTypeId: string; policy: ContractTypePolicy }[]>('/contracts/type-policies') });
  const save = async (id: string, policy: ContractTypePolicy) => {
    try {
      await put(`/contracts/type-policies/${id}`, policy);
      await qc.invalidateQueries({ queryKey: ['contracts', 'type-policies'] });
      notifySaved(t);
    } catch (err) {
      notifyError(t, err);
    }
  };
  const f = (k: string) => t(`ctr.rules.${k}`);
  return (
    <Stack>
      {types.map((ty) => {
        const p = policies.data?.find((x) => x.contractTypeId === ty.id)?.policy;
        if (!p) return null;
        const set = (patch: Partial<ContractTypePolicy>) => void save(ty.id, { ...p, ...patch });
        return (
          <Card key={ty.id} withBorder>
            <Title order={4} size="h5" mb="sm">
              {localName(settings.language, ty)}
            </Title>
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
              <Select label={f('renewal')} data={(['extend', 'new_contract'] as const).map((x) => ({ value: x, label: f(`renewals.${x}`) }))} value={p.renewal} onChange={(v) => set({ renewal: (v ?? 'extend') as ContractTypePolicy['renewal'] })} allowDeselect={false} />
              <Switch mt="xl" label={f('autoRenew')} checked={p.autoRenew} onChange={(e) => set({ autoRenew: e.currentTarget.checked })} />
              <NumberInput label={f('autoRenewMonths')} min={1} max={60} value={p.autoRenewMonths} onBlur={(e) => set({ autoRenewMonths: Number(e.currentTarget.value) || 12 })} />
              <Select
                label={f('signers')}
                data={[
                  { value: 'employee,company', label: `${t('ctr.roles.employee')} + ${t('ctr.roles.company')}` },
                  { value: 'company', label: t('ctr.roles.company') },
                  { value: 'employee', label: t('ctr.roles.employee') },
                ]}
                value={p.signers.join(',')}
                onChange={(v) => set({ signers: (v ?? 'employee,company').split(',') as ContractTypePolicy['signers'] })}
                allowDeselect={false}
              />
              <NumberInput label={f('defaultDurationMonths')} min={1} max={120} value={p.defaultDurationMonths ?? ''} onBlur={(e) => set({ defaultDurationMonths: e.currentTarget.value ? Number(e.currentTarget.value) : null })} />
              <NumberInput label={f('probationDays')} min={0} max={365} value={p.probationDays ?? ''} onBlur={(e) => set({ probationDays: e.currentTarget.value ? Number(e.currentTarget.value) : null })} />
              <NumberInput label={f('retentionYears')} min={1} max={100} value={p.retentionYears} onBlur={(e) => set({ retentionYears: Number(e.currentTarget.value) || 10 })} />
            </SimpleGrid>
          </Card>
        );
      })}
    </Stack>
  );
}

