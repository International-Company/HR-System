import { useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  FileInput,
  Group,
  Modal,
  MultiSelect,
  NumberInput,
  Paper,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Textarea,
  Timeline,
  Title,
} from '@mantine/core';
import { IconPlus, IconUpload } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  CANDIDATE_SOURCES,
  type ApplicationDto,
  type ApplicationSummaryDto,
  type CandidateDto,
  type DocumentCategoryDto,
  type RecruitmentStages,
  type VacancyDto,
} from '@hrms/shared';
import { get, patch, post, upload } from '../../lib/api';
import { useAuth } from '../../auth/AuthContext';
import { lookupOptions, useCompanies, useDepartments, useDocumentCategories, useEmployeeOptions, useLookups } from '../../lib/refdata';
import { EmptyRow, ErrorAlert, PageHeader, StatusBadge, localName, notifyError, notifySaved } from '../../components/common';
import { DateField, DateTimeField } from '../../components/DateFields';

const VAC_COLOR: Record<string, string> = { draft: 'inactive', open: 'success', on_hold: 'requested', closed: 'inactive', filled: 'success' };
const OUTCOME_COLOR: Record<string, string> = { open: 'requested', accepted: 'success', rejected: 'failed', withdrawn: 'inactive' };

function useStages() {
  return useQuery({ queryKey: ['recruitment', 'stages'], queryFn: () => get<RecruitmentStages>('/recruitment/stages'), staleTime: 60_000 });
}

function useStageName() {
  const { settings } = useAuth();
  const stages = useStages();
  return (key: string) => {
    const s = stages.data?.stages.find((x) => x.key === key);
    return s ? (settings.language === 'ar' ? s.nameAr : s.nameEn) : key;
  };
}

/** Recruitment module: vacancies and candidates per company (REC-01, REC-02). */
export function RecruitmentPage() {
  const { t } = useTranslation();
  const { settings, can } = useAuth();
  const companies = useCompanies();
  const [companyId, setCompanyId] = useState<string | null>(null);
  const company = companyId ?? companies.data?.[0]?.id ?? null;
  return (
    <>
      <PageHeader title={t('rec.title')} />
      <Select mb="md" w={260} label={t('rec.company')} data={(companies.data ?? []).map((c) => ({ value: c.id, label: localName(settings.language, c) }))} value={company} onChange={setCompanyId} allowDeselect={false} />
      {company && (
        <Tabs defaultValue="vacancies" keepMounted={false}>
          <Tabs.List mb="md">
            <Tabs.Tab value="vacancies">{t('rec.vacancies')}</Tabs.Tab>
            <Tabs.Tab value="candidates">{t('rec.candidates')}</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="vacancies">
            <VacanciesPanel companyId={company} manage={can('recruitment.manage')} />
          </Tabs.Panel>
          <Tabs.Panel value="candidates">
            <CandidatesPanel companyId={company} manage={can('recruitment.manage')} />
          </Tabs.Panel>
        </Tabs>
      )}
    </>
  );
}

function VacanciesPanel({ companyId, manage }: { companyId: string; manage: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const list = useQuery({ queryKey: ['recruitment', 'vacancies', companyId], queryFn: () => get<VacancyDto[]>(`/recruitment/vacancies?companyId=${companyId}`) });
  const [edit, setEdit] = useState<VacancyDto | 'new' | null>(null);
  return (
    <Paper>
      {manage && (
        <Group justify="flex-end" p="sm">
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEdit('new')}>
            {t('rec.newVacancy')}
          </Button>
        </Group>
      )}
      <ErrorAlert error={list.error} />
      <Table highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('rec.titleField')}</Table.Th>
            <Table.Th>{t('rec.status')}</Table.Th>
            <Table.Th>{t('rec.openings')}</Table.Th>
            <Table.Th>{t('rec.applications')}</Table.Th>
            <Table.Th>{t('rec.hired')}</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {list.data?.length === 0 && <EmptyRow colSpan={6} />}
          {list.data?.map((v) => (
            <Table.Tr key={v.id} style={{ cursor: 'pointer' }} onClick={() => void navigate(`/recruitment/vacancies/${v.id}`)}>
              <Table.Td>{v.title}</Table.Td>
              <Table.Td>
                <StatusBadge status={VAC_COLOR[v.status] ?? 'inactive'} label={t(`rec.vacancyStatuses.${v.status}`)} />
              </Table.Td>
              <Table.Td>{v.openings}</Table.Td>
              <Table.Td>{v.applications}</Table.Td>
              <Table.Td>{v.hired}</Table.Td>
              <Table.Td onClick={(e) => e.stopPropagation()}>
                {manage && (
                  <Button size="compact-xs" variant="subtle" onClick={() => setEdit(v)}>
                    {t('rec.editVacancy')}
                  </Button>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {edit && <VacancyModal companyId={companyId} value={edit} onClose={() => setEdit(null)} />}
    </Paper>
  );
}

function VacancyModal({ companyId, value, onClose }: { companyId: string; value: VacancyDto | 'new'; onClose: () => void }) {
  const { t } = useTranslation();
  const { settings } = useAuth();
  const lang = settings.language;
  const qc = useQueryClient();
  const lookups = useLookups();
  const departments = useDepartments(companyId);
  const categories = useDocumentCategories();
  const init = value === 'new' ? null : value;
  const [form, setForm] = useState({
    title: init?.title ?? '',
    description: init?.description ?? '',
    openings: init?.openings ?? 1,
    departmentId: init?.departmentId ?? null,
    jobTitleId: init?.jobTitleId ?? null,
    employmentCategoryId: init?.employmentCategoryId ?? null,
    contractTypeId: init?.contractTypeId ?? null,
    requiredDocumentCategoryIds: init?.requiredDocumentCategoryIds ?? [],
    status: init?.status ?? 'open',
  });
  const save = useMutation({
    mutationFn: () => (init ? patch(`/recruitment/vacancies/${init.id}`, form) : post('/recruitment/vacancies', { companyId, ...form, status: undefined }).then((v) => (form.status !== 'draft' ? patch(`/recruitment/vacancies/${(v as VacancyDto).id}`, form) : v))),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['recruitment'] });
      onClose();
      notifySaved(t);
    },
  });
  return (
    <Modal opened onClose={onClose} title={init ? t('rec.editVacancy') : t('rec.newVacancy')} size="lg">
      <Stack>
        <ErrorAlert error={save.error} />
        <TextInput label={t('rec.titleField')} value={form.title} onChange={(e) => setForm({ ...form, title: e.currentTarget.value })} required />
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Select label={t('rec.department')} clearable data={(departments.data ?? []).map((d) => ({ value: d.id, label: localName(lang, d) }))} value={form.departmentId} onChange={(v) => setForm({ ...form, departmentId: v })} />
          <Select label={t('rec.jobTitle')} clearable searchable data={lookupOptions(lookups.data, 'job_title', lang, companyId)} value={form.jobTitleId} onChange={(v) => setForm({ ...form, jobTitleId: v })} />
          <Select label={t('rec.category')} clearable data={lookupOptions(lookups.data, 'employment_category', lang, companyId)} value={form.employmentCategoryId} onChange={(v) => setForm({ ...form, employmentCategoryId: v })} />
          <Select label={t('rec.contractType')} clearable data={lookupOptions(lookups.data, 'contract_type', lang, companyId)} value={form.contractTypeId} onChange={(v) => setForm({ ...form, contractTypeId: v })} />
          <NumberInput label={t('rec.openings')} min={1} max={500} value={form.openings} onChange={(v) => setForm({ ...form, openings: Number(v) || 1 })} />
          <Select
            label={t('rec.status')}
            data={(['draft', 'open', 'on_hold', 'closed', 'filled'] as const).map((s) => ({ value: s, label: t(`rec.vacancyStatuses.${s}`) }))}
            value={form.status}
            onChange={(v) => setForm({ ...form, status: (v ?? 'open') as typeof form.status })}
            allowDeselect={false}
          />
        </SimpleGrid>
        <MultiSelect
          label={t('rec.requiredDocs')}
          data={(categories.data ?? []).filter((c: DocumentCategoryDto) => c.sensitivity !== 'medical').map((c: DocumentCategoryDto) => ({ value: c.id, label: localName(lang, c) }))}
          value={form.requiredDocumentCategoryIds}
          onChange={(v) => setForm({ ...form, requiredDocumentCategoryIds: v })}
        />
        <Textarea label={t('rec.description')} autosize minRows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.currentTarget.value })} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button disabled={form.title.trim().length < 2} loading={save.isPending} onClick={() => save.mutate()}>
            {t('app.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function CandidatesPanel({ companyId, manage }: { companyId: string; manage: boolean }) {
  const { t } = useTranslation();
  const { fmt } = useAuth();
  const [q, setQ] = useState('');
  const list = useQuery({ queryKey: ['recruitment', 'candidates', companyId, q], queryFn: () => get<CandidateDto[]>(`/recruitment/candidates?companyId=${companyId}${q ? `&q=${encodeURIComponent(q)}` : ''}`) });
  const [edit, setEdit] = useState<CandidateDto | 'new' | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <Paper>
      <Group justify="space-between" p="sm">
        <TextInput aria-label={t('rec.search')} w={260} placeholder={t('rec.search')} value={q} onChange={(e) => setQ(e.currentTarget.value)} />
        {manage && (
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEdit('new')}>
            {t('rec.newCandidate')}
          </Button>
        )}
      </Group>
      <Table highlightOnHover>
        <Table.Tbody>
          {list.data?.length === 0 && <EmptyRow colSpan={4} />}
          {list.data?.map((c) => (
            <Table.Tr key={c.id} style={{ cursor: manage ? 'pointer' : undefined }} onClick={() => manage && setEdit(c)}>
              <Table.Td>
                {c.fullNameAr} · {c.fullNameEn}
              </Table.Td>
              <Table.Td dir="ltr" style={{ textAlign: 'start' }}>
                {c.email ?? ''}
              </Table.Td>
              <Table.Td>{t(`rec.sources.${c.source}`)}</Table.Td>
              <Table.Td>
                {c.employeeId ? (
                  <Badge color="green" variant="light">
                    {t('rec.hiredAs')}
                  </Badge>
                ) : c.retainUntil < today ? (
                  <Badge color="orange" variant="light">
                    {t('rec.retentionDue')}
                  </Badge>
                ) : (
                  <Text size="xs" c="dimmed">
                    {t('rec.retainUntil')} {fmt.date(c.retainUntil)}
                  </Text>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {edit && <CandidateModal companyId={companyId} value={edit} onClose={() => setEdit(null)} />}
    </Paper>
  );
}

function CandidateModal({ companyId, value, onClose, onCreated }: { companyId: string; value: CandidateDto | 'new'; onClose: () => void; onCreated?: (c: CandidateDto) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const init = value === 'new' ? null : value;
  const [form, setForm] = useState({
    fullNameAr: init?.fullNameAr ?? '',
    fullNameEn: init?.fullNameEn ?? '',
    email: init?.email ?? '',
    phone: init?.phone ?? '',
    nationality: init?.nationality ?? '',
    source: init?.source ?? ('direct' as (typeof CANDIDATE_SOURCES)[number]),
    notes: init?.notes ?? '',
  });
  const body = () => ({ ...form, email: form.email || null, phone: form.phone || null, nationality: form.nationality || null });
  const save = useMutation({
    mutationFn: () => (init ? patch<CandidateDto>(`/recruitment/candidates/${init.id}`, body()) : post<CandidateDto>('/recruitment/candidates', { companyId, ...body() })),
    onSuccess: async (c) => {
      await qc.invalidateQueries({ queryKey: ['recruitment'] });
      onCreated?.(c);
      onClose();
      notifySaved(t);
    },
  });
  return (
    <Modal opened onClose={onClose} title={init ? t('rec.editCandidate') : t('rec.newCandidate')} size="lg">
      <Stack>
        <ErrorAlert error={save.error} />
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label={t('rec.nameAr')} value={form.fullNameAr} onChange={(e) => setForm({ ...form, fullNameAr: e.currentTarget.value })} required />
          <TextInput label={t('rec.nameEn')} value={form.fullNameEn} onChange={(e) => setForm({ ...form, fullNameEn: e.currentTarget.value })} required />
          <TextInput label={t('rec.email')} type="email" dir="ltr" value={form.email} onChange={(e) => setForm({ ...form, email: e.currentTarget.value })} />
          <TextInput label={t('rec.phone')} dir="ltr" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.currentTarget.value })} />
          <TextInput label={t('rec.nationality')} dir="ltr" maxLength={2} value={form.nationality} onChange={(e) => setForm({ ...form, nationality: e.currentTarget.value.toUpperCase() })} />
          <Select label={t('rec.source')} data={CANDIDATE_SOURCES.map((s) => ({ value: s, label: t(`rec.sources.${s}`) }))} value={form.source} onChange={(v) => setForm({ ...form, source: (v ?? 'direct') as typeof form.source })} allowDeselect={false} />
        </SimpleGrid>
        <Textarea label={t('rec.notes')} autosize minRows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.currentTarget.value })} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button disabled={!form.fullNameAr.trim() || !form.fullNameEn.trim()} loading={save.isPending} onClick={() => save.mutate()}>
            {t('app.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** One vacancy and its applications by stage (REC-03, REC-04). */
export function VacancyPage() {
  const { id } = useParams();
  const { t } = useTranslation();
  const { settings, can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const v = useQuery({ queryKey: ['recruitment', 'vacancy', id], queryFn: () => get<VacancyDto>(`/recruitment/vacancies/${id}`) });
  const apps = useQuery({ queryKey: ['recruitment', 'applications', id], queryFn: () => get<ApplicationSummaryDto[]>(`/recruitment/vacancies/${id}/applications`) });
  const stages = useStages();
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const candidates = useQuery({
    queryKey: ['recruitment', 'candidates', v.data?.companyId, ''],
    queryFn: () => get<CandidateDto[]>(`/recruitment/candidates?companyId=${v.data!.companyId}`),
    enabled: adding && !!v.data,
  });
  const [pick, setPick] = useState<string | null>(null);
  const apply = useMutation({
    mutationFn: (candidateId: string) => post<ApplicationDto>('/recruitment/applications', { vacancyId: id, candidateId }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['recruitment'] });
      setAdding(false);
      setPick(null);
    },
  });
  if (!v.data) return <ErrorAlert error={v.error} />;
  const lang = settings.language;
  return (
    <>
      <PageHeader
        title={v.data.title}
        subtitle={`${t(`rec.vacancyStatuses.${v.data.status}`)} · ${t('rec.openings')} ${v.data.openings} · ${t('rec.hired')} ${v.data.hired}`}
        actions={
          can('recruitment.manage') && v.data.status === 'open' ? (
            <Button leftSection={<IconPlus size={16} />} onClick={() => setAdding(true)}>
              {t('rec.addCandidate')}
            </Button>
          ) : undefined
        }
      />
      {v.data.description && (
        <Text mb="md" style={{ whiteSpace: 'pre-wrap' }}>
          {v.data.description}
        </Text>
      )}
      <ScrollArea>
        <Group align="flex-start" wrap="nowrap" gap="sm" pb="sm">
          {stages.data?.stages.map((s) => {
            const col = (apps.data ?? []).filter((a) => a.stage === s.key);
            return (
              <Paper key={s.key} p="sm" w={230} withBorder style={{ flexShrink: 0 }}>
                <Group justify="space-between" mb="xs">
                  <Text fw={600} size="sm">
                    {lang === 'ar' ? s.nameAr : s.nameEn}
                  </Text>
                  <Badge size="sm" variant="light" color={OUTCOME_COLOR[s.outcome] === 'success' ? 'green' : OUTCOME_COLOR[s.outcome] === 'failed' ? 'red' : 'gray'}>
                    {col.length}
                  </Badge>
                </Group>
                <Stack gap={6}>
                  {col.map((a) => (
                    <Card key={a.id} withBorder padding="xs" style={{ cursor: 'pointer' }} onClick={() => void navigate(`/recruitment/applications/${a.id}`)}>
                      <Text size="sm">{lang === 'ar' ? a.candidateName.ar : a.candidateName.en}</Text>
                      {a.employeeId && (
                        <Badge size="xs" color="green" variant="light">
                          {t('rec.hiredAs')}
                        </Badge>
                      )}
                    </Card>
                  ))}
                </Stack>
              </Paper>
            );
          })}
        </Group>
      </ScrollArea>
      <Modal opened={adding} onClose={() => setAdding(false)} title={t('rec.addCandidate')}>
        <Stack>
          <ErrorAlert error={apply.error} />
          <Select label={t('rec.pickCandidate')} searchable data={(candidates.data ?? []).map((c) => ({ value: c.id, label: `${c.fullNameAr} · ${c.fullNameEn}` }))} value={pick} onChange={setPick} />
          <Group justify="space-between">
            <Button variant="subtle" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)}>
              {t('rec.newCandidate')}
            </Button>
            <Button disabled={!pick} loading={apply.isPending} onClick={() => pick && apply.mutate(pick)}>
              {t('app.save')}
            </Button>
          </Group>
        </Stack>
      </Modal>
      {creating && <CandidateModal companyId={v.data.companyId} value="new" onClose={() => setCreating(false)} onCreated={(c) => apply.mutate(c.id)} />}
    </>
  );
}

/** One application: candidate, files, stage, history, interviews, offers, hiring. */
export function ApplicationPage() {
  const { id } = useParams();
  const { t } = useTranslation();
  const { settings, fmt, can } = useAuth();
  const lang = settings.language;
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['recruitment', 'application', id], queryFn: () => get<ApplicationDto>(`/recruitment/applications/${id}`) });
  const stages = useStages();
  const stageName = useStageName();
  const categories = useDocumentCategories();
  const [dialog, setDialog] = useState<'interview' | 'offer' | 'hire' | 'file' | { result: string } | null>(null);
  const [note, setNote] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['recruitment'] });
  const act = async (path: string, body?: unknown) => {
    try {
      await post(path, body);
      await refresh();
      notifySaved(t);
    } catch (err) {
      notifyError(t, err);
    }
  };
  const a = q.data;
  if (!a) return <ErrorAlert error={q.error} />;
  const manage = can('recruitment.manage');
  const catName = (cid: string) => {
    const c = categories.data?.find((x) => x.id === cid);
    return c ? localName(lang, c) : cid;
  };
  const closed = !!a.employeeId;
  return (
    <>
      <PageHeader
        title={lang === 'ar' ? a.candidate.fullNameAr : a.candidate.fullNameEn}
        subtitle={a.vacancyTitle}
        actions={
          <Group gap="xs">
            {a.employeeId ? (
              <Button component={Link} to={`/employees/${a.employeeId}`} variant="light" color="green">
                {t('rec.hiredAs')}
              </Button>
            ) : (
              manage && a.outcome === 'accepted' && can('employee.profile.create') && <Button onClick={() => setDialog('hire')}>{t('rec.hire')}</Button>
            )}
          </Group>
        }
      />
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <Stack>
          <Card withBorder>
            <Group justify="space-between" mb="xs">
              <StatusBadge status={OUTCOME_COLOR[a.outcome] ?? 'inactive'} label={stageName(a.stage)} />
              {manage && !closed && (
                <Select aria-label={t('rec.moveTo')}
                  w={200}
                  placeholder={t('rec.moveTo')}
                  data={(stages.data?.stages ?? []).filter((s) => s.key !== a.stage).map((s) => ({ value: s.key, label: lang === 'ar' ? s.nameAr : s.nameEn }))}
                  value={null}
                  onChange={(v) => v && void act(`/recruitment/applications/${a.id}/stage`, { stage: v })}
                />
              )}
            </Group>
            <Text size="sm" dir="ltr" style={{ textAlign: 'start' }}>
              {a.candidate.email ?? ''} {a.candidate.phone ? `· ${a.candidate.phone}` : ''} {a.candidate.nationality ? `· ${a.candidate.nationality}` : ''}
            </Text>
            <Text size="xs" c="dimmed">
              {t(`rec.sources.${a.candidate.source}`)} · {t('rec.retainUntil')} {fmt.date(a.candidate.retainUntil)}
            </Text>
            {a.candidate.notes && (
              <Text size="sm" mt="xs" style={{ whiteSpace: 'pre-wrap' }}>
                {a.candidate.notes}
              </Text>
            )}
          </Card>

          {manage && (
            <Card withBorder>
              <Group justify="space-between" mb="xs">
                <Title order={4} size="h5">
                  {t('rec.files')}
                </Title>
                <Button size="compact-xs" variant="light" leftSection={<IconUpload size={14} />} onClick={() => setDialog('file')}>
                  {t('rec.uploadFile')}
                </Button>
              </Group>
              {a.missingDocumentCategoryIds.length > 0 && (
                <Alert color="orange" mb="xs" p="xs">
                  {t('rec.missingDocs', { list: a.missingDocumentCategoryIds.map(catName).join(', ') })}
                </Alert>
              )}
              {a.documents.map((d) => (
                <Group key={d.id} justify="space-between">
                  <Anchor href={`/api/v1/recruitment/candidates/${a.candidate.id}/files/${d.id}`} size="sm">
                    {d.title}
                  </Anchor>
                  <Text size="xs" c="dimmed">
                    {catName(d.categoryId)}
                  </Text>
                </Group>
              ))}
            </Card>
          )}

          <Card withBorder>
            <Group justify="space-between" mb="xs">
              <Title order={4} size="h5">
                {t('rec.interviews')}
              </Title>
              {manage && !closed && a.outcome === 'open' && (
                <Button size="compact-xs" variant="light" onClick={() => setDialog('interview')}>
                  {t('rec.schedule')}
                </Button>
              )}
            </Group>
            {a.interviews.length === 0 && <Text c="dimmed">—</Text>}
            {a.interviews.map((i) => (
              <Stack key={i.id} gap={2} mb="sm">
                <Group justify="space-between">
                  <Text size="sm">
                    {fmt.dateTime(i.scheduledAt)} · {t(`rec.modes.${i.mode}`)} · {i.durationMinutes}′
                  </Text>
                  <Badge variant="light" color={i.status === 'done' ? 'green' : i.status === 'cancelled' ? 'gray' : 'blue'}>
                    {t(`rec.interviewStatuses.${i.status}`)}
                  </Badge>
                </Group>
                <Text size="xs" c="dimmed">
                  {i.interviewers.map((x) => x.name).join('، ')}
                  {i.location ? ` · ${i.location}` : ''}
                </Text>
                {i.result && (
                  <Text size="sm">
                    {t(`rec.results.${i.result}`)}
                    {i.score ? ` · ${i.score}/5` : ''} — {i.feedback}
                  </Text>
                )}
                <Group gap="xs">
                  {i.canRecordResult && i.status === 'scheduled' && (
                    <Button size="compact-xs" variant="light" onClick={() => setDialog({ result: i.id })}>
                      {t('rec.recordResult')}
                    </Button>
                  )}
                  {manage && i.status === 'scheduled' && (
                    <Button size="compact-xs" variant="subtle" color="red" onClick={() => void act(`/recruitment/interviews/${i.id}/cancel`)}>
                      {t('rec.cancel')}
                    </Button>
                  )}
                </Group>
              </Stack>
            ))}
          </Card>

          {manage && (
            <Card withBorder>
              <Group justify="space-between" mb="xs">
                <Title order={4} size="h5">
                  {t('rec.offers')}
                </Title>
                {can('recruitment.offers') && !closed && !a.offers.some((o) => ['draft', 'pending_approval', 'approved', 'sent', 'accepted'].includes(o.status)) && (
                  <Button size="compact-xs" variant="light" onClick={() => setDialog('offer')}>
                    {t('rec.newOffer')}
                  </Button>
                )}
              </Group>
              {a.offers.length === 0 && <Text c="dimmed">—</Text>}
              {a.offers.map((o) => (
                <Stack key={o.id} gap={4} mb="sm">
                  <Group justify="space-between">
                    <Text size="sm">
                      {o.baseSalary !== null ? `${o.baseSalary.toFixed(2)} ${o.currency}` : '•••'} · {t('rec.startDate')} {fmt.date(o.startDate)}
                    </Text>
                    <Badge variant="light">{t(`rec.offerStatuses.${o.status}`)}</Badge>
                  </Group>
                  {can('recruitment.offers') && !closed && (
                    <Group gap="xs">
                      {o.status === 'draft' && (
                        <Button size="compact-xs" onClick={() => void act(`/recruitment/offers/${o.id}/submit`)}>
                          {t('rec.submitOffer')}
                        </Button>
                      )}
                      {o.status === 'approved' && (
                        <Button size="compact-xs" variant="light" onClick={() => void act(`/recruitment/offers/${o.id}/status`, { status: 'sent' })}>
                          {t('rec.markSent')}
                        </Button>
                      )}
                      {o.status === 'sent' && (
                        <>
                          <Button size="compact-xs" color="green" variant="light" onClick={() => void act(`/recruitment/offers/${o.id}/status`, { status: 'accepted' })}>
                            {t('rec.markAccepted')}
                          </Button>
                          <Button size="compact-xs" color="red" variant="light" onClick={() => void act(`/recruitment/offers/${o.id}/status`, { status: 'declined' })}>
                            {t('rec.markDeclined')}
                          </Button>
                        </>
                      )}
                      {['draft', 'approved', 'sent'].includes(o.status) && (
                        <Button size="compact-xs" variant="subtle" color="red" onClick={() => void act(`/recruitment/offers/${o.id}/status`, { status: 'withdrawn' })}>
                          {t('rec.withdraw')}
                        </Button>
                      )}
                    </Group>
                  )}
                </Stack>
              ))}
            </Card>
          )}
        </Stack>

        <Card withBorder>
          <Title order={4} size="h5" mb="sm">
            {t('rec.history')}
          </Title>
          {manage && (
            <Stack gap="xs" mb="md">
              <Textarea aria-label={t('rec.note')} placeholder={t('rec.note')} autosize minRows={2} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
              <Group justify="space-between">
                <Text size="xs" c="dimmed">
                  {t('rec.internalNote')}
                </Text>
                <Button
                  size="xs"
                  disabled={!note.trim()}
                  onClick={() => {
                    void act(`/recruitment/applications/${a.id}/notes`, { note }).then(() => setNote(''));
                  }}
                >
                  {t('rec.addNote')}
                </Button>
              </Group>
            </Stack>
          )}
          <Timeline bulletSize={12} lineWidth={2}>
            {[...a.events].reverse().map((e) => (
              <Timeline.Item key={e.id} title={<Text size="sm">{t(`rec.eventKinds.${e.kind}`)}{e.stage ? `: ${stageName(e.stage)}` : ''}</Text>}>
                {e.text && (
                  <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                    {e.text}
                  </Text>
                )}
                <Text size="xs" c="dimmed">
                  {e.byName ?? ''} · {fmt.dateTime(e.at)}
                </Text>
              </Timeline.Item>
            ))}
          </Timeline>
        </Card>
      </SimpleGrid>

      {dialog === 'interview' && <InterviewModal applicationId={a.id} onClose={() => setDialog(null)} />}
      {dialog === 'offer' && <OfferModal application={a} onClose={() => setDialog(null)} />}
      {dialog === 'hire' && <HireModal application={a} onClose={() => setDialog(null)} />}
      {dialog === 'file' && <FileModal candidateId={a.candidate.id} onClose={() => setDialog(null)} />}
      {dialog && typeof dialog === 'object' && <ResultModal interviewId={dialog.result} onClose={() => setDialog(null)} />}
    </>
  );
}

function InterviewModal({ applicationId, onClose }: { applicationId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['workflow', 'delegates'], queryFn: () => get<{ id: string; displayName: string }[]>('/workflow/delegates') });
  const [form, setForm] = useState({ when: '', durationMinutes: 45, mode: 'in_person', location: '', interviewerUserIds: [] as string[] });
  const save = useMutation({
    mutationFn: () =>
      post(`/recruitment/applications/${applicationId}/interviews`, {
        scheduledAt: new Date(form.when).toISOString(),
        durationMinutes: form.durationMinutes,
        mode: form.mode,
        location: form.location || undefined,
        interviewerUserIds: form.interviewerUserIds,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['recruitment'] });
      onClose();
      notifySaved(t);
    },
  });
  return (
    <Modal opened onClose={onClose} title={t('rec.schedule')}>
      <Stack>
        <ErrorAlert error={save.error} />
        <DateTimeField label={t('rec.when')} value={form.when} onChange={(v) => setForm({ ...form, when: v })} required />
        <Group grow>
          <NumberInput label={t('rec.duration')} min={10} max={480} value={form.durationMinutes} onChange={(v) => setForm({ ...form, durationMinutes: Number(v) || 45 })} />
          <Select label={t('rec.mode')} data={['in_person', 'phone', 'video'].map((m) => ({ value: m, label: t(`rec.modes.${m}`) }))} value={form.mode} onChange={(v) => setForm({ ...form, mode: v ?? 'in_person' })} allowDeselect={false} />
        </Group>
        <TextInput label={t('rec.location')} value={form.location} onChange={(e) => setForm({ ...form, location: e.currentTarget.value })} />
        <MultiSelect label={t('rec.interviewers')} searchable data={(users.data ?? []).map((u) => ({ value: u.id, label: u.displayName }))} value={form.interviewerUserIds} onChange={(v) => setForm({ ...form, interviewerUserIds: v })} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button disabled={!form.when || !form.interviewerUserIds.length} loading={save.isPending} onClick={() => save.mutate()}>
            {t('app.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function ResultModal({ interviewId, onClose }: { interviewId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [form, setForm] = useState({ result: 'pass', score: 3 as number | '', feedback: '' });
  const save = useMutation({
    mutationFn: () => post(`/recruitment/interviews/${interviewId}/result`, { result: form.result, score: form.score === '' ? null : form.score, feedback: form.feedback }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['recruitment'] });
      onClose();
      notifySaved(t);
    },
  });
  return (
    <Modal opened onClose={onClose} title={t('rec.recordResult')}>
      <Stack>
        <ErrorAlert error={save.error} />
        <Group grow>
          <Select label={t('rec.result')} data={['pass', 'fail', 'hold'].map((r) => ({ value: r, label: t(`rec.results.${r}`) }))} value={form.result} onChange={(v) => setForm({ ...form, result: v ?? 'pass' })} allowDeselect={false} />
          <NumberInput label={t('rec.score')} min={1} max={5} value={form.score} onChange={(v) => setForm({ ...form, score: v === '' ? '' : Number(v) })} />
        </Group>
        <Textarea label={t('rec.feedback')} autosize minRows={3} value={form.feedback} onChange={(e) => setForm({ ...form, feedback: e.currentTarget.value })} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button disabled={form.feedback.trim().length < 3} loading={save.isPending} onClick={() => save.mutate()}>
            {t('app.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function OfferModal({ application: a, onClose }: { application: ApplicationDto; onClose: () => void }) {
  const { t } = useTranslation();
  const { settings } = useAuth();
  const qc = useQueryClient();
  const lookups = useLookups();
  const [form, setForm] = useState({ baseSalary: 0, currency: 'EUR', startDate: '', jobTitleId: null as string | null, notes: '' });
  const save = useMutation({
    mutationFn: () => post(`/recruitment/applications/${a.id}/offers`, { ...form, baseSalary: form.baseSalary.toFixed(2), notes: form.notes || undefined }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['recruitment'] });
      onClose();
      notifySaved(t);
    },
  });
  return (
    <Modal opened onClose={onClose} title={t('rec.newOffer')}>
      <Stack>
        <ErrorAlert error={save.error} />
        <Group grow>
          <NumberInput label={t('rec.salary')} min={0} decimalScale={2} value={form.baseSalary} onChange={(v) => setForm({ ...form, baseSalary: Number(v) || 0 })} />
          <TextInput label={t('rec.currency')} maxLength={3} dir="ltr" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.currentTarget.value.toUpperCase() })} />
        </Group>
        <DateField label={t('rec.startDate')} value={form.startDate} onChange={(v) => setForm({ ...form, startDate: v })} />
        <Select label={t('rec.jobTitle')} clearable searchable data={lookupOptions(lookups.data, 'job_title', settings.language, a.companyId)} value={form.jobTitleId} onChange={(v) => setForm({ ...form, jobTitleId: v })} />
        <Textarea label={t('rec.notes')} autosize value={form.notes} onChange={(e) => setForm({ ...form, notes: e.currentTarget.value })} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button disabled={!form.startDate || !/^[A-Z]{3}$/.test(form.currency)} loading={save.isPending} onClick={() => save.mutate()}>
            {t('app.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function HireModal({ application: a, onClose }: { application: ApplicationDto; onClose: () => void }) {
  const { t } = useTranslation();
  const { settings } = useAuth();
  const qc = useQueryClient();
  const departments = useDepartments(a.companyId);
  const employees = useEmployeeOptions();
  const accepted = a.offers.find((o) => o.status === 'accepted');
  const [form, setForm] = useState({ hireDate: accepted?.startDate ?? '', probationEndDate: '', departmentId: undefined as string | null | undefined, managerEmployeeId: null as string | null });
  const save = useMutation({
    mutationFn: () =>
      post(`/recruitment/applications/${a.id}/convert`, {
        hireDate: form.hireDate,
        probationEndDate: form.probationEndDate || null,
        ...(form.departmentId !== undefined ? { departmentId: form.departmentId } : {}),
        managerEmployeeId: form.managerEmployeeId,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['recruitment'] });
      onClose();
      notifySaved(t);
    },
  });
  return (
    <Modal opened onClose={onClose} title={t('rec.hire')}>
      <Stack>
        <ErrorAlert error={save.error} />
        <Alert variant="light">{t('rec.hireHint')}</Alert>
        <Group grow>
          <DateField label={t('rec.hireDate')} value={form.hireDate} onChange={(v) => setForm({ ...form, hireDate: v })} />
          <DateField label={t('rec.probationEnd')} value={form.probationEndDate} onChange={(v) => setForm({ ...form, probationEndDate: v })} />
        </Group>
        <Select label={t('rec.department')} clearable data={(departments.data ?? []).map((d) => ({ value: d.id, label: localName(settings.language, d) }))} value={form.departmentId ?? null} onChange={(v) => setForm({ ...form, departmentId: v })} />
        <Select
          label={t('rec.manager')}
          clearable
          searchable
          data={(employees.data ?? []).map((e) => ({ value: e.id, label: `${e.employeeNo} · ${settings.language === 'ar' ? e.fullNameAr : e.fullNameEn}` }))}
          value={form.managerEmployeeId}
          onChange={(v) => setForm({ ...form, managerEmployeeId: v })}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button disabled={!form.hireDate} loading={save.isPending} onClick={() => save.mutate()}>
            {t('rec.hire')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function FileModal({ candidateId, onClose }: { candidateId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { settings } = useAuth();
  const qc = useQueryClient();
  const categories = useDocumentCategories();
  const [form, setForm] = useState({ categoryId: null as string | null, title: '', file: null as File | null });
  const save = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.set('categoryId', form.categoryId!);
      fd.set('title', form.title);
      fd.set('file', form.file!);
      return upload(`/recruitment/candidates/${candidateId}/files`, fd);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['recruitment'] });
      onClose();
      notifySaved(t);
    },
  });
  return (
    <Modal opened onClose={onClose} title={t('rec.uploadFile')}>
      <Stack>
        <ErrorAlert error={save.error} />
        <Select
          label={t('rec.fileCategory')}
          data={(categories.data ?? []).filter((c: DocumentCategoryDto) => c.sensitivity !== 'medical' && c.status === 'active').map((c: DocumentCategoryDto) => ({ value: c.id, label: localName(settings.language, c) }))}
          value={form.categoryId}
          onChange={(v) => setForm({ ...form, categoryId: v })}
        />
        <TextInput label={t('rec.fileTitle')} value={form.title} onChange={(e) => setForm({ ...form, title: e.currentTarget.value })} />
        <FileInput aria-label={t('rec.uploadFile')} value={form.file} onChange={(f) => setForm({ ...form, file: f, title: form.title || f?.name || '' })} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button disabled={!form.categoryId || !form.file || !form.title.trim()} loading={save.isPending} onClick={() => save.mutate()}>
            {t('app.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
