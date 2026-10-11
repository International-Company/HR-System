import { useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  FileButton,
  Group,
  Modal,
  Paper,
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
import { IconLock, IconPlus } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { EmployeeAttendanceTab } from '../attendance/EmployeeAttendanceTab';
import { EmployeeLeaveTab } from '../leave/LeavePages';
import { EmployeeContractsTab } from '../contracts/ContractPages';
import { EmployeeSeparationTab } from '../separation/SeparationPages';
import { useTranslation } from 'react-i18next';
import {
  ASSIGNMENT_EVENTS,
  QUALIFICATION_LEVELS,
  SETTABLE_STATUSES,
  type BankAccountDto,
  type EmployeeDto,
  type EmployeeHistoryDto,
  type QualificationDto,
  type UserDto,
} from '@hrms/shared';
import { del, get, patch, post, put, upload } from '../../lib/api';
import { useAuth } from '../../auth/AuthContext';
import { EmptyRow, ErrorAlert, PageHeader, fieldErrors, localName, notifyError, notifySaved } from '../../components/common';
import { employeeName, lookupName, useCompanies, useDepartments, useEmployeeOptions, useLocations, useLookups } from '../../lib/refdata';
import {
  AssignmentFields,
  CompensationFields,
  PersonalFields,
  assignmentPayload,
  compensationPayload,
  emptyCompensation,
  personalPayload,
  type AssignmentForm,
  type CompensationForm,
  type PersonalForm,
} from './forms';
import { EmployeeAvatar, EmployeeStatusBadge } from './EmployeesListPage';
import { DocumentsTab } from './DocumentsTab';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" component="div">
        {children ?? '—'}
      </Text>
    </Stack>
  );
}

function Ltr({ children }: { children: ReactNode }) {
  return (
    <span dir="ltr" style={{ unicodeBidi: 'isolate' }}>
      {children}
    </span>
  );
}

export function EmployeeProfilePage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { settings, can } = useAuth();
  const lang = settings.language;
  const qc = useQueryClient();
  const emp = useQuery({ queryKey: ['employee', id], queryFn: () => get<EmployeeDto>(`/employees/${id}`) });
  const companies = useCompanies();
  const lookups = useLookups();
  const e = emp.data;
  const departments = useDepartments(e?.current?.companyId);
  const locations = useLocations(e?.current?.companyId);
  const contractsDisplay = useQuery({
    queryKey: ['contracts', 'display', id],
    queryFn: () => get<{ showInProfile: boolean }>(`/contracts/employee/${id}/display`),
    enabled: !!e && (can('contracts.view') || can('contracts.manage')),
  });
  const managers = useEmployeeOptions();
  const [photoKey, setPhotoKey] = useState(0);
  const resetRef = useRef<() => void>(null);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['employee', id] });
    await qc.invalidateQueries({ queryKey: ['employee-history', id] });
    await qc.invalidateQueries({ queryKey: ['employees'] });
  };

  if (emp.error) return <ErrorAlert error={emp.error} />;
  if (!e) return <Text c="dimmed">{t('app.loading')}</Text>;

  const companyName = (cid: string | null | undefined) => {
    const c = companies.data?.find((x) => x.id === cid);
    return c ? localName(lang, c) : '—';
  };
  const deptName = (did: string | null | undefined) => {
    const d = departments.data?.find((x) => x.id === did);
    return d ? localName(lang, d) : did ? '…' : '—';
  };
  const managerName = (mid: string | null | undefined) => {
    const m = managers.data?.find((x) => x.id === mid);
    return m ? employeeName(lang, m) : mid ? '…' : '—';
  };

  const uploadPhoto = async (file: File | null) => {
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    try {
      await upload(`/employees/${id}/photo`, form);
      setPhotoKey((k) => k + 1);
      await refresh();
      notifySaved(t);
    } catch (err) {
      notifyError(t, err);
    } finally {
      resetRef.current?.();
    }
  };

  return (
    <>
      <PageHeader
        title={employeeName(lang, e)}
        subtitle={`${e.employeeNo} · ${lang === 'ar' ? e.fullNameEn : e.fullNameAr}`}
        actions={
          can('employee.profile.view') && !e.access.self ? (
            <Button variant="default" component={Link} to="/employees">
              {t('app.back')}
            </Button>
          ) : undefined
        }
      />
      <Paper p="md" mb="lg">
        <Group align="center" wrap="wrap" gap="lg">
          <Stack align="center" gap={4}>
            <EmployeeAvatar key={photoKey} id={e.id} hasPhoto={e.hasPhoto} name={employeeName(lang, e)} size={72} />
            {e.access.editPersonal && can('documents.upload') && (
              <FileButton resetRef={resetRef} onChange={(f) => void uploadPhoto(f)} accept="image/png,image/jpeg,image/webp">
                {(props) => (
                  <Anchor component="button" type="button" size="xs" {...props}>
                    {t('emp.uploadPhoto')}
                  </Anchor>
                )}
              </FileButton>
            )}
          </Stack>
          <SimpleGrid cols={{ base: 2, sm: 4 }} style={{ flex: 1 }}>
            <Field label={t('emp.status')}>
              <EmployeeStatusBadge status={e.status} />
            </Field>
            <Field label={t('emp.company')}>{companyName(e.current?.companyId)}</Field>
            <Field label={t('emp.department')}>{deptName(e.current?.departmentId)}</Field>
            <Field label={t('emp.jobTitle')}>{lookupName(lookups.data, e.current?.jobTitleId, lang)}</Field>
          </SimpleGrid>
        </Group>
      </Paper>

      <Tabs defaultValue="personal" keepMounted={false}>
        <Tabs.List mb="md" style={{ flexWrap: 'wrap' }}>
          <Tabs.Tab value="personal">{t('emp.sections.personal')}</Tabs.Tab>
          <Tabs.Tab value="employment">{t('emp.sections.employment')}</Tabs.Tab>
          {(e.access.financial || e.access.self) && <Tabs.Tab value="compensation">{t('emp.sections.compensation')}</Tabs.Tab>}
          {(e.access.financial || e.access.self) && <Tabs.Tab value="bank">{t('emp.sections.bank')}</Tabs.Tab>}
          <Tabs.Tab value="qualifications">{t('emp.sections.qualifications')}</Tabs.Tab>
          {can('documents.view') && <Tabs.Tab value="documents">{t('emp.sections.documents')}</Tabs.Tab>}
          {(can('attendance.record.view') || e.access.self) && <Tabs.Tab value="attendance">{t('att.title')}</Tabs.Tab>}
          {(can('leave.request.view') || e.access.self) && <Tabs.Tab value="leave">{t('leave.title')}</Tabs.Tab>}
          {(can('contracts.view') || can('contracts.manage')) && contractsDisplay.data?.showInProfile && <Tabs.Tab value="contracts">{t('ctr.title')}</Tabs.Tab>}
          {(can('separation.view') || can('separation.request')) && <Tabs.Tab value="separation">{t('sep.tab')}</Tabs.Tab>}
          {can('employee.account.link') && <Tabs.Tab value="account">{t('emp.sections.account')}</Tabs.Tab>}
        </Tabs.List>

        <Tabs.Panel value="personal">
          <PersonalTab e={e} onSaved={refresh} />
        </Tabs.Panel>
        <Tabs.Panel value="employment">
          <EmploymentTab
            e={e}
            onSaved={refresh}
            names={{ companyName, deptName, managerName, locationName: (l) => {
              const x = locations.data?.find((y) => y.id === l);
              return x ? localName(lang, x) : '—';
            } }}
          />
        </Tabs.Panel>
        <Tabs.Panel value="compensation">
          <CompensationTab e={e} onSaved={refresh} />
        </Tabs.Panel>
        <Tabs.Panel value="bank">
          <BankTab e={e} />
        </Tabs.Panel>
        <Tabs.Panel value="qualifications">
          <QualificationsTab e={e} />
        </Tabs.Panel>
        <Tabs.Panel value="documents">
          <DocumentsTab employeeId={e.id} canManage={e.access.editPersonal} />
        </Tabs.Panel>
        <Tabs.Panel value="attendance">
          <EmployeeAttendanceTab employeeId={e.id} />
        </Tabs.Panel>
        <Tabs.Panel value="leave">
          <EmployeeLeaveTab employeeId={e.id} />
        </Tabs.Panel>
        <Tabs.Panel value="contracts">
          <EmployeeContractsTab employeeId={e.id} />
        </Tabs.Panel>
        <Tabs.Panel value="separation">
          <EmployeeSeparationTab employee={e} />
        </Tabs.Panel>
        <Tabs.Panel value="account">
          <AccountTab e={e} onSaved={refresh} />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}

// --- Personal --------------------------------------------------------------------------

function PersonalTab({ e, onSaved }: { e: EmployeeDto; onSaved: () => Promise<void> }) {
  const { t } = useTranslation();
  const { fmt, can } = useAuth();
  const [edit, setEdit] = useState<PersonalForm | null>(null);
  const identityEditable = can('employee.identity.view') && !e.idNumberMasked;
  const save = useMutation({
    mutationFn: () => {
      const body = personalPayload(edit!, identityEditable);
      return patch(`/employees/${e.id}`, {
        ...body,
        ...(identityEditable && edit!.idNumber === (e.idNumber ?? '') ? { idType: undefined, idNumber: undefined } : {}),
        version: e.version,
      });
    },
    onSuccess: async () => {
      await onSaved();
      setEdit(null);
      notifySaved(t);
    },
  });

  return (
    <Paper p="lg">
      <Group justify="flex-end" mb="sm">
        {e.access.editPersonal && (
          <Button
            size="xs"
            variant="default"
            onClick={() =>
              setEdit({
                fullNameAr: e.fullNameAr,
                fullNameEn: e.fullNameEn,
                idType: e.idType,
                idNumber: e.idNumberMasked ? '' : (e.idNumber ?? ''),
                birthDate: e.birthDate ?? '',
                gender: e.gender,
                nationality: e.nationality ?? '',
                maritalStatus: e.maritalStatus,
                phone: e.phone ?? '',
                email: e.email ?? '',
              })
            }
          >
            {t('app.edit')}
          </Button>
        )}
      </Group>
      <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="lg">
        <Field label={t('emp.number')}>
          <Ltr>{e.employeeNo}</Ltr>
        </Field>
        <Field label={t('emp.fullNameAr')}>{e.fullNameAr}</Field>
        <Field label={t('emp.fullNameEn')}>
          <Ltr>{e.fullNameEn}</Ltr>
        </Field>
        <Field label={e.idType ? t(`emp.idTypes.${e.idType}`) : t('emp.idNumber')}>
          {e.idNumber ? (
            <Group gap={4}>
              <Ltr>{e.idNumber}</Ltr>
              {e.idNumberMasked && <IconLock size={12} />}
            </Group>
          ) : null}
        </Field>
        <Field label={t('emp.birthDate')}>{e.birthDate ? fmt.date(e.birthDate) : null}</Field>
        <Field label={t('emp.gender')}>{e.gender ? t(`emp.genders.${e.gender}`) : null}</Field>
        <Field label={t('emp.nationality')}>{e.nationality}</Field>
        <Field label={t('emp.maritalStatus')}>{e.maritalStatus ? t(`emp.maritalStatuses.${e.maritalStatus}`) : null}</Field>
        <Field label={t('emp.phone')}>{e.phone ? <Ltr>{e.phone}</Ltr> : null}</Field>
        <Field label={t('emp.email')}>{e.email ? <Ltr>{e.email}</Ltr> : null}</Field>
        <Field label={t('emp.hireDate')}>{fmt.date(e.hireDate)}</Field>
        <Field label={t('emp.actualStart')}>{e.actualStartDate ? fmt.date(e.actualStartDate) : null}</Field>
        <Field label={t('emp.probationEnd')}>{e.probationEndDate ? fmt.date(e.probationEndDate) : null}</Field>
      </SimpleGrid>

      <Modal opened={!!edit} onClose={() => setEdit(null)} title={t('emp.sections.personal')} size="lg">
        {edit && (
          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              save.mutate();
            }}
          >
            <Stack>
              <ErrorAlert error={save.error} />
              <PersonalFields value={edit} onChange={setEdit} errors={fieldErrors(save.error)} identityEditable={identityEditable} />
              <Group justify="flex-end">
                <Button variant="default" onClick={() => setEdit(null)}>
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
    </Paper>
  );
}

// --- Employment & history -----------------------------------------------------------------

function EmploymentTab({
  e,
  onSaved,
  names,
}: {
  e: EmployeeDto;
  onSaved: () => Promise<void>;
  names: {
    companyName: (id: string | null | undefined) => string;
    deptName: (id: string | null | undefined) => string;
    managerName: (id: string | null | undefined) => string;
    locationName: (id: string | null | undefined) => string;
  };
}) {
  const { t } = useTranslation();
  const { settings, fmt } = useAuth();
  const lang = settings.language;
  const lookups = useLookups();
  const history = useQuery({ queryKey: ['employee-history', e.id], queryFn: () => get<EmployeeHistoryDto>(`/employees/${e.id}/history`) });
  const [change, setChange] = useState<(AssignmentForm & { event: string; effectiveDate: string; reason: string }) | null>(null);
  const [status, setStatus] = useState<{ status: string | null; effectiveDate: string; reason: string } | null>(null);
  const cur = e.current;

  const saveChange = useMutation({
    mutationFn: () =>
      post(`/employees/${e.id}/assignments`, {
        ...assignmentPayload(change!),
        event: change!.event,
        effectiveDate: change!.effectiveDate,
        reason: change!.reason,
      }),
    onSuccess: async () => {
      await onSaved();
      setChange(null);
      notifySaved(t);
    },
  });
  const saveStatus = useMutation({
    mutationFn: () => post(`/employees/${e.id}/status`, status),
    onSuccess: async () => {
      await onSaved();
      setStatus(null);
      notifySaved(t);
    },
  });

  return (
    <Stack>
      <Paper p="lg">
        <Group justify="space-between" mb="md">
          <Title order={3} size="h5">
            {t('emp.current')}
          </Title>
          {e.access.manageLifecycle && cur && e.status !== 'terminated' && (
            <Group gap="xs">
              <Button
                size="xs"
                variant="default"
                onClick={() =>
                  setChange({
                    companyId: cur.companyId,
                    departmentId: cur.departmentId,
                    jobTitleId: cur.jobTitleId,
                    managerEmployeeId: cur.managerEmployeeId,
                    workLocationId: cur.workLocationId,
                    employmentCategoryId: cur.employmentCategoryId,
                    contractTypeId: cur.contractTypeId,
                    contractStart: cur.contractStart ?? '',
                    contractEnd: cur.contractEnd ?? '',
                    event: 'job_change',
                    effectiveDate: '',
                    reason: '',
                  })
                }
              >
                {t('emp.changeAssignment')}
              </Button>
              <Button size="xs" variant="default" onClick={() => setStatus({ status: null, effectiveDate: new Date().toISOString().slice(0, 10), reason: '' })}>
                {t('emp.changeStatus')}
              </Button>
            </Group>
          )}
        </Group>
        {cur && (
          <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="lg">
            <Field label={t('emp.company')}>{names.companyName(cur.companyId)}</Field>
            <Field label={t('emp.department')}>{names.deptName(cur.departmentId)}</Field>
            <Field label={t('emp.jobTitle')}>{lookupName(lookups.data, cur.jobTitleId, lang)}</Field>
            <Field label={t('emp.manager')}>{names.managerName(cur.managerEmployeeId)}</Field>
            <Field label={t('emp.location')}>{names.locationName(cur.workLocationId)}</Field>
            <Field label={t('emp.category')}>{lookupName(lookups.data, cur.employmentCategoryId, lang)}</Field>
            <Field label={t('emp.contractType')}>{lookupName(lookups.data, cur.contractTypeId, lang)}</Field>
            <Field label={t('emp.contractStart')}>{cur.contractStart ? fmt.date(cur.contractStart) : null}</Field>
            <Field label={t('emp.contractEnd')}>{cur.contractEnd ? fmt.date(cur.contractEnd) : null}</Field>
            <Field label={t('emp.from')}>{fmt.date(cur.validFrom)}</Field>
          </SimpleGrid>
        )}
      </Paper>

      <Paper p="lg">
        <Title order={3} size="h5" mb="md">
          {t('emp.sections.history')}
        </Title>
        {history.data?.partial && (
          <Alert color="gray" variant="light" mb="sm">
            {t('emp.historyPartial')}
          </Alert>
        )}
        <Timeline bulletSize={14} lineWidth={2}>
          {history.data?.events.map((ev) => (
            <Timeline.Item key={ev.id} title={t(`emp.events.${ev.type}`, { defaultValue: ev.type })}>
              <Text size="xs" c="dimmed">
                {fmt.date(ev.effectiveDate)}
                {ev.companyId ? ` · ${names.companyName(ev.companyId)}` : ''}
              </Text>
              {typeof ev.details.reason === 'string' && <Text size="sm">{ev.details.reason}</Text>}
            </Timeline.Item>
          ))}
        </Timeline>
      </Paper>

      <Modal opened={!!change} onClose={() => setChange(null)} title={t('emp.changeAssignment')} size="lg">
        {change && cur && (
          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              saveChange.mutate();
            }}
          >
            <Stack>
              <ErrorAlert error={saveChange.error} />
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <Select
                  label={t('emp.event')}
                  data={ASSIGNMENT_EVENTS.map((x) => ({ value: x, label: t(`emp.events.${x}`) }))}
                  value={change.event}
                  onChange={(v) => setChange({ ...change, event: v ?? 'job_change', ...(v !== 'transfer' ? { companyId: cur.companyId } : {}) })}
                  allowDeselect={false}
                />
                <TextInput type="date" label={t('emp.effectiveDate')} value={change.effectiveDate} onChange={(ev) => setChange({ ...change, effectiveDate: ev.currentTarget.value })} required error={fieldErrors(saveChange.error).effectiveDate} />
              </SimpleGrid>
              <AssignmentFields
                value={change}
                onChange={(v) => setChange({ ...change, ...v })}
                errors={fieldErrors(saveChange.error)}
                excludeEmployeeId={e.id}
                companyFilter={(cid) => (change.event === 'transfer' ? cid !== cur.companyId : cid === cur.companyId)}
              />
              <Textarea label={t('emp.reason')} value={change.reason} onChange={(ev) => setChange({ ...change, reason: ev.currentTarget.value })} required autosize minRows={2} />
              <Group justify="flex-end">
                <Button variant="default" onClick={() => setChange(null)}>
                  {t('app.cancel')}
                </Button>
                <Button type="submit" loading={saveChange.isPending}>
                  {t('app.save')}
                </Button>
              </Group>
            </Stack>
          </form>
        )}
      </Modal>

      <Modal opened={!!status} onClose={() => setStatus(null)} title={t('emp.changeStatus')}>
        {status && (
          <Stack>
            <ErrorAlert error={saveStatus.error} />
            <Select
              label={t('emp.status')}
              data={SETTABLE_STATUSES.filter((s) => s !== e.status).map((s) => ({ value: s, label: t(`emp.statuses.${s}`) }))}
              value={status.status}
              onChange={(v) => setStatus({ ...status, status: v })}
              required
            />
            <TextInput type="date" label={t('emp.effectiveDate')} value={status.effectiveDate} onChange={(ev) => setStatus({ ...status, effectiveDate: ev.currentTarget.value })} />
            <Textarea label={t('emp.reason')} value={status.reason} onChange={(ev) => setStatus({ ...status, reason: ev.currentTarget.value })} required autosize minRows={2} />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setStatus(null)}>
                {t('app.cancel')}
              </Button>
              <Button disabled={!status.status || !status.reason.trim()} loading={saveStatus.isPending} onClick={() => saveStatus.mutate()}>
                {t('app.save')}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}

// --- Compensation ------------------------------------------------------------------------------

function CompensationTab({ e, onSaved }: { e: EmployeeDto; onSaved: () => Promise<void> }) {
  const { t } = useTranslation();
  const { settings, fmt } = useAuth();
  const lookups = useLookups();
  const history = useQuery({
    queryKey: ['employee-history', e.id],
    queryFn: () => get<EmployeeHistoryDto>(`/employees/${e.id}/history`),
    enabled: e.access.financial,
  });
  const [change, setChange] = useState<(CompensationForm & { effectiveDate: string; reason: string; event: string }) | null>(null);
  const save = useMutation({
    mutationFn: () =>
      post(`/employees/${e.id}/compensation`, {
        ...compensationPayload(change!),
        effectiveDate: change!.effectiveDate,
        reason: change!.reason,
        event: change!.event,
      }),
    onSuccess: async () => {
      await onSaved();
      setChange(null);
      notifySaved(t);
    },
  });
  const c = e.compensation;
  const fmtMoney = (amount: string, currency: string) => `${fmt.number(Number(amount))} ${currency}`;

  return (
    <Stack>
      <Paper p="lg">
        <Group justify="space-between" mb="md">
          <Title order={3} size="h5">
            {t('emp.current')}
          </Title>
          {e.access.editFinancial && (
            <Button
              size="xs"
              variant="default"
              onClick={() =>
                setChange({
                  ...(c
                    ? {
                        baseSalary: c.baseSalary,
                        currency: c.currency,
                        paymentMethod: c.paymentMethod,
                        items: c.items.map((i) => ({ ...i })),
                      }
                    : emptyCompensation()),
                  effectiveDate: '',
                  reason: '',
                  event: 'salary_change',
                })
              }
            >
              {t('emp.changeSalary')}
            </Button>
          )}
        </Group>
        {!c ? (
          <Text c="dimmed" size="sm">
            {t('emp.noSalary')}
          </Text>
        ) : (
          <Stack>
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <Field label={t('emp.baseSalary')}>
                <Text fw={600}>{fmtMoney(c.baseSalary, c.currency)}</Text>
              </Field>
              <Field label={t('emp.paymentMethod')}>{t(`emp.paymentMethods.${c.paymentMethod}`)}</Field>
              <Field label={t('emp.from')}>{fmt.date(c.validFrom)}</Field>
            </SimpleGrid>
            {c.items.length > 0 && (
              <Table>
                <Table.Tbody>
                  {c.items.map((i, n) => (
                    <Table.Tr key={n}>
                      <Table.Td>{i.kind === 'allowance' ? t('emp.allowances') : t('emp.deductions')}</Table.Td>
                      <Table.Td>{lookupName(lookups.data, i.typeId, settings.language)}</Table.Td>
                      <Table.Td dir="ltr" style={{ textAlign: 'end' }}>
                        {i.calc === 'percent_of_base' ? `${i.amount}%` : fmtMoney(i.amount, c.currency)}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </Stack>
        )}
      </Paper>

      {e.access.financial && (
        <Paper p="lg">
          <Title order={3} size="h5" mb="md">
            {t('emp.sections.history')}
          </Title>
          <Table.ScrollContainer minWidth={520}>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('emp.from')}</Table.Th>
                  <Table.Th>{t('emp.to')}</Table.Th>
                  <Table.Th>{t('emp.baseSalary')}</Table.Th>
                  <Table.Th>{t('emp.reason')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {history.data?.compensation?.length === 0 && <EmptyRow colSpan={4} />}
                {history.data?.compensation?.map((h) => (
                  <Table.Tr key={h.id}>
                    <Table.Td>{fmt.date(h.validFrom)}</Table.Td>
                    <Table.Td>{h.validTo ? fmt.date(h.validTo) : '—'}</Table.Td>
                    <Table.Td>{fmtMoney(h.baseSalary, h.currency)}</Table.Td>
                    <Table.Td>{h.changeReason}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Paper>
      )}

      <Modal opened={!!change} onClose={() => setChange(null)} title={t('emp.changeSalary')} size="lg">
        {change && (
          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              save.mutate();
            }}
          >
            <Stack>
              <ErrorAlert error={save.error} />
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <Select
                  label={t('emp.event')}
                  data={[
                    { value: 'salary_change', label: t('emp.events.salary_change') },
                    { value: 'promotion', label: t('emp.events.promotion') },
                  ]}
                  value={change.event}
                  onChange={(v) => setChange({ ...change, event: v ?? 'salary_change' })}
                  allowDeselect={false}
                />
                <TextInput type="date" label={t('emp.effectiveDate')} value={change.effectiveDate} onChange={(ev) => setChange({ ...change, effectiveDate: ev.currentTarget.value })} required error={fieldErrors(save.error).effectiveDate} />
              </SimpleGrid>
              <CompensationFields value={change} onChange={(v) => setChange({ ...change, ...v })} companyId={e.current?.companyId ?? null} errors={fieldErrors(save.error)} />
              <Textarea label={t('emp.reason')} value={change.reason} onChange={(ev) => setChange({ ...change, reason: ev.currentTarget.value })} required autosize minRows={2} />
              <Group justify="flex-end">
                <Button variant="default" onClick={() => setChange(null)}>
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
    </Stack>
  );
}

// --- Bank accounts --------------------------------------------------------------------------------

function BankTab({ e }: { e: EmployeeDto }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ['bank', e.id], queryFn: () => get<BankAccountDto[]>(`/employees/${e.id}/bank-accounts`) });
  const [form, setForm] = useState<{ bankName: string; accountNumber: string; iban: string } | null>(null);
  const add = useMutation({
    mutationFn: () =>
      post(`/employees/${e.id}/bank-accounts`, {
        bankName: form!.bankName,
        accountNumber: form!.accountNumber || null,
        iban: form!.iban || null,
        isPrimary: true,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['bank', e.id] });
      setForm(null);
      notifySaved(t);
    },
  });
  const deactivate = async (bid: string) => {
    try {
      await post(`/employees/${e.id}/bank-accounts/${bid}/deactivate`);
      await qc.invalidateQueries({ queryKey: ['bank', e.id] });
      notifySaved(t);
    } catch (err) {
      notifyError(t, err);
    }
  };

  return (
    <Paper p="lg">
      <Group justify="flex-end" mb="sm">
        {e.access.editFinancial && (
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setForm({ bankName: '', accountNumber: '', iban: '' })}>
            {t('emp.addBank')}
          </Button>
        )}
      </Group>
      <ErrorAlert error={accounts.error} />
      <Table.ScrollContainer minWidth={560}>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('emp.bankName')}</Table.Th>
              <Table.Th>{t('emp.iban')}</Table.Th>
              <Table.Th>{t('emp.accountNumber')}</Table.Th>
              <Table.Th>{t('app.status')}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {accounts.data?.length === 0 && <EmptyRow colSpan={5} />}
            {accounts.data?.map((b) => (
              <Table.Tr key={b.id} opacity={b.status === 'active' ? 1 : 0.5}>
                <Table.Td>
                  {b.bankName} {b.isPrimary && <Badge size="xs">{t('emp.primary')}</Badge>}
                </Table.Td>
                <Table.Td dir="ltr" style={{ textAlign: 'start' }}>
                  {b.iban ?? '—'}
                </Table.Td>
                <Table.Td dir="ltr" style={{ textAlign: 'start' }}>
                  {b.accountNumber ?? '—'}
                </Table.Td>
                <Table.Td>{b.status === 'active' ? t('app.active') : t('app.inactive')}</Table.Td>
                <Table.Td>
                  {e.access.editFinancial && b.status === 'active' && (
                    <Button size="xs" variant="subtle" color="red" onClick={() => void deactivate(b.id)}>
                      {t('emp.deactivate')}
                    </Button>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      <Modal opened={!!form} onClose={() => setForm(null)} title={t('emp.addBank')}>
        {form && (
          <Stack>
            <ErrorAlert error={add.error} />
            <TextInput label={t('emp.bankName')} value={form.bankName} onChange={(ev) => setForm({ ...form, bankName: ev.currentTarget.value })} required />
            <TextInput label={t('emp.iban')} value={form.iban} onChange={(ev) => setForm({ ...form, iban: ev.currentTarget.value })} dir="ltr" error={fieldErrors(add.error).iban} />
            <TextInput label={t('emp.accountNumber')} value={form.accountNumber} onChange={(ev) => setForm({ ...form, accountNumber: ev.currentTarget.value })} dir="ltr" />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setForm(null)}>
                {t('app.cancel')}
              </Button>
              <Button disabled={!form.bankName} loading={add.isPending} onClick={() => add.mutate()}>
                {t('app.save')}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Paper>
  );
}

// --- Qualifications ----------------------------------------------------------------------------

function QualificationsTab({ e }: { e: EmployeeDto }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['qualifications', e.id], queryFn: () => get<QualificationDto[]>(`/employees/${e.id}/qualifications`) });
  const [form, setForm] = useState<{ level: string | null; specialization: string; institution: string; country: string; graduationYear: string } | null>(null);
  const add = useMutation({
    mutationFn: () =>
      post(`/employees/${e.id}/qualifications`, {
        level: form!.level,
        specialization: form!.specialization || null,
        institution: form!.institution || null,
        country: form!.country.toUpperCase() || null,
        graduationYear: form!.graduationYear ? Number(form!.graduationYear) : null,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['qualifications', e.id] });
      setForm(null);
      notifySaved(t);
    },
  });
  const remove = async (qid: string) => {
    try {
      await del(`/employees/${e.id}/qualifications/${qid}`);
      await qc.invalidateQueries({ queryKey: ['qualifications', e.id] });
    } catch (err) {
      notifyError(t, err);
    }
  };

  return (
    <Paper p="lg">
      <Group justify="flex-end" mb="sm">
        {e.access.editPersonal && (
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setForm({ level: null, specialization: '', institution: '', country: '', graduationYear: '' })}>
            {t('emp.addQualification')}
          </Button>
        )}
      </Group>
      <Table.ScrollContainer minWidth={560}>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('emp.level')}</Table.Th>
              <Table.Th>{t('emp.specialization')}</Table.Th>
              <Table.Th>{t('emp.institution')}</Table.Th>
              <Table.Th>{t('emp.country')}</Table.Th>
              <Table.Th>{t('emp.graduationYear')}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {list.data?.length === 0 && <EmptyRow colSpan={6} />}
            {list.data?.map((q) => (
              <Table.Tr key={q.id}>
                <Table.Td>{t(`emp.levels.${q.level}`)}</Table.Td>
                <Table.Td>{q.specialization ?? '—'}</Table.Td>
                <Table.Td>{q.institution ?? '—'}</Table.Td>
                <Table.Td>{q.country ?? '—'}</Table.Td>
                <Table.Td>{q.graduationYear ?? '—'}</Table.Td>
                <Table.Td>
                  {e.access.editPersonal && (
                    <Button size="xs" variant="subtle" color="red" onClick={() => void remove(q.id)}>
                      {t('emp.remove')}
                    </Button>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      <Modal opened={!!form} onClose={() => setForm(null)} title={t('emp.addQualification')}>
        {form && (
          <Stack>
            <ErrorAlert error={add.error} />
            <Select label={t('emp.level')} data={QUALIFICATION_LEVELS.map((l) => ({ value: l, label: t(`emp.levels.${l}`) }))} value={form.level} onChange={(v) => setForm({ ...form, level: v })} required />
            <TextInput label={t('emp.specialization')} value={form.specialization} onChange={(ev) => setForm({ ...form, specialization: ev.currentTarget.value })} />
            <TextInput label={t('emp.institution')} value={form.institution} onChange={(ev) => setForm({ ...form, institution: ev.currentTarget.value })} />
            <Group grow>
              <TextInput label={t('emp.country')} value={form.country} onChange={(ev) => setForm({ ...form, country: ev.currentTarget.value })} maxLength={2} dir="ltr" />
              <TextInput label={t('emp.graduationYear')} value={form.graduationYear} onChange={(ev) => setForm({ ...form, graduationYear: ev.currentTarget.value })} inputMode="numeric" dir="ltr" />
            </Group>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setForm(null)}>
                {t('app.cancel')}
              </Button>
              <Button disabled={!form.level} loading={add.isPending} onClick={() => add.mutate()}>
                {t('app.save')}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Paper>
  );
}

// --- Account link -------------------------------------------------------------------------------

function AccountTab({ e, onSaved }: { e: EmployeeDto; onSaved: () => Promise<void> }) {
  const { t } = useTranslation();
  const users = useQuery({ queryKey: ['users', ''], queryFn: () => get<UserDto[]>('/users') });
  const [userId, setUserId] = useState<string | null>(e.linkedUserId);
  const save = useMutation({
    mutationFn: () => put(`/employees/${e.id}/user`, { userId }),
    onSuccess: async () => {
      await onSaved();
      notifySaved(t);
    },
  });
  return (
    <Paper p="lg" maw={520}>
      <Stack>
        <ErrorAlert error={save.error} />
        <Select
          label={t('emp.linkedUser')}
          placeholder={t('emp.noLinkedUser')}
          clearable
          searchable
          data={(users.data ?? []).map((u) => ({ value: u.id, label: `${u.displayName} (${u.username})` }))}
          value={userId}
          onChange={setUserId}
        />
        <Group justify="flex-end">
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            {t('emp.linkUser')}
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}
