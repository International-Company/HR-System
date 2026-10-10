import { useState } from 'react';
import {
  Anchor,
  Button,
  Group,
  Modal,
  Paper,
  Select,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { CompanyDto, DepartmentDto, LocationDto } from '@hrms/shared';
import { get, patch, post } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { EmptyRow, ErrorAlert, PageHeader, StatusBadge, fieldErrors, localName, notifySaved } from '../components/common';

interface NameFields {
  code: string;
  nameAr: string;
  nameEn: string;
}

function NameForm({
  value,
  onChange,
  errors,
  codeEditable = true,
}: {
  value: NameFields;
  onChange: (v: NameFields) => void;
  errors: Record<string, string>;
  codeEditable?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      <TextInput
        label={t('app.code')}
        value={value.code}
        onChange={(e) => onChange({ ...value, code: e.currentTarget.value })}
        disabled={!codeEditable}
        error={errors.code}
        required
        dir="ltr"
      />
      <TextInput label={t('app.nameAr')} value={value.nameAr} onChange={(e) => onChange({ ...value, nameAr: e.currentTarget.value })} error={errors.nameAr} required dir="rtl" />
      <TextInput label={t('app.nameEn')} value={value.nameEn} onChange={(e) => onChange({ ...value, nameEn: e.currentTarget.value })} error={errors.nameEn} required dir="ltr" />
    </>
  );
}

export function CompaniesPage() {
  const { t } = useTranslation();
  const { can, settings } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<NameFields>({ code: '', nameAr: '', nameEn: '' });
  const companies = useQuery({ queryKey: ['companies'], queryFn: () => get<CompanyDto[]>('/companies') });
  const create = useMutation({
    mutationFn: () => post<CompanyDto>('/companies', form),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['companies'] });
      setOpen(false);
      setForm({ code: '', nameAr: '', nameEn: '' });
      notifySaved(t);
    },
  });

  return (
    <>
      <PageHeader
        title={t('org.companies')}
        subtitle={t('org.deactivateHint')}
        actions={
          can('org.company.create') && (
            <Button leftSection={<IconPlus size={16} />} onClick={() => setOpen(true)}>
              {t('org.newCompany')}
            </Button>
          )
        }
      />
      <ErrorAlert error={companies.error} />
      <Paper>
        <Table.ScrollContainer minWidth={560}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('app.code')}</Table.Th>
                <Table.Th>{t('app.name')}</Table.Th>
                <Table.Th>{t('app.status')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {companies.data?.length === 0 && <EmptyRow colSpan={3} />}
              {companies.data?.map((c) => (
                <Table.Tr key={c.id}>
                  <Table.Td dir="ltr" style={{ textAlign: 'start' }}>
                    {c.code}
                  </Table.Td>
                  <Table.Td>
                    <Anchor component={Link} to={`/companies/${c.id}`}>
                      {localName(settings.language, c)}
                    </Anchor>
                  </Table.Td>
                  <Table.Td>
                    <StatusBadge status={c.status} label={t(`app.${c.status}`)} />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Paper>

      <Modal opened={open} onClose={() => setOpen(false)} title={t('org.newCompany')}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Stack>
            <ErrorAlert error={create.error} />
            <NameForm value={form} onChange={setForm} errors={fieldErrors(create.error)} />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setOpen(false)}>
                {t('app.cancel')}
              </Button>
              <Button type="submit" loading={create.isPending}>
                {t('app.create')}
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </>
  );
}

type Editing<T> = { mode: 'create' } | { mode: 'edit'; row: T } | null;

export function CompanyDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { can, settings } = useAuth();
  const qc = useQueryClient();
  const company = useQuery({ queryKey: ['company', id], queryFn: () => get<CompanyDto>(`/companies/${id}`) });
  const departments = useQuery({
    queryKey: ['departments', id],
    queryFn: () => get<DepartmentDto[]>(`/companies/${id}/departments`),
    enabled: can('org.department.view'),
  });
  const locations = useQuery({
    queryKey: ['locations', id],
    queryFn: () => get<LocationDto[]>(`/companies/${id}/locations`),
    enabled: can('org.location.view'),
  });

  const [editCompany, setEditCompany] = useState<CompanyDto | null>(null);
  const [dept, setDept] = useState<Editing<DepartmentDto>>(null);
  const [deptForm, setDeptForm] = useState<NameFields & { parentId: string | null; status: string }>({
    code: '',
    nameAr: '',
    nameEn: '',
    parentId: null,
    status: 'active',
  });
  const [loc, setLoc] = useState<Editing<LocationDto>>(null);
  const [locForm, setLocForm] = useState<NameFields & { address: string; status: string }>({
    code: '',
    nameAr: '',
    nameEn: '',
    address: '',
    status: 'active',
  });

  const saveCompany = useMutation({
    mutationFn: (c: CompanyDto) => patch<CompanyDto>(`/companies/${id}`, { nameAr: c.nameAr, nameEn: c.nameEn, status: c.status, version: c.version }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['company', id] });
      await qc.invalidateQueries({ queryKey: ['companies'] });
      setEditCompany(null);
      notifySaved(t);
    },
  });
  const saveDept = useMutation({
    mutationFn: () =>
      dept?.mode === 'edit'
        ? patch(`/departments/${dept.row.id}`, {
            nameAr: deptForm.nameAr,
            nameEn: deptForm.nameEn,
            parentId: deptForm.parentId,
            status: deptForm.status,
            version: dept.row.version,
          })
        : post(`/companies/${id}/departments`, {
            code: deptForm.code,
            nameAr: deptForm.nameAr,
            nameEn: deptForm.nameEn,
            parentId: deptForm.parentId,
          }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['departments', id] });
      setDept(null);
      notifySaved(t);
    },
  });
  const saveLoc = useMutation({
    mutationFn: () =>
      loc?.mode === 'edit'
        ? patch(`/locations/${loc.row.id}`, {
            nameAr: locForm.nameAr,
            nameEn: locForm.nameEn,
            address: locForm.address || null,
            status: locForm.status,
            version: loc.row.version,
          })
        : post(`/companies/${id}/locations`, {
            code: locForm.code,
            nameAr: locForm.nameAr,
            nameEn: locForm.nameEn,
            ...(locForm.address ? { address: locForm.address } : {}),
          }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['locations', id] });
      setLoc(null);
      notifySaved(t);
    },
  });

  const deptName = (deptId: string | null) => {
    const d = departments.data?.find((x) => x.id === deptId);
    return d ? localName(settings.language, d) : t('app.none');
  };
  const statusOptions = [
    { value: 'active', label: t('app.active') },
    { value: 'inactive', label: t('app.inactive') },
  ];

  if (company.error) return <ErrorAlert error={company.error} />;
  const c = company.data;

  return (
    <>
      <PageHeader
        title={c ? localName(settings.language, c) : t('app.loading')}
        subtitle={c ? `${c.code} · ${settings.language === 'ar' ? c.nameEn : c.nameAr}` : undefined}
        actions={
          <>
            <Button variant="default" component={Link} to="/companies">
              {t('app.back')}
            </Button>
            {c && can('org.company.edit') && <Button onClick={() => setEditCompany({ ...c })}>{t('app.edit')}</Button>}
          </>
        }
      />
      {c && (
        <Group mb="md">
          <StatusBadge status={c.status} label={t(`app.${c.status}`)} />
        </Group>
      )}

      <Tabs defaultValue="departments" keepMounted={false}>
        <Tabs.List mb="md">
          {can('org.department.view') && <Tabs.Tab value="departments">{t('org.departments')}</Tabs.Tab>}
          {can('org.location.view') && <Tabs.Tab value="locations">{t('org.locations')}</Tabs.Tab>}
        </Tabs.List>

        <Tabs.Panel value="departments">
          <Paper>
            <Group justify="flex-end" p="sm">
              {can('org.department.manage') && (
                <Button
                  size="xs"
                  leftSection={<IconPlus size={14} />}
                  onClick={() => {
                    setDeptForm({ code: '', nameAr: '', nameEn: '', parentId: null, status: 'active' });
                    setDept({ mode: 'create' });
                  }}
                >
                  {t('org.newDepartment')}
                </Button>
              )}
            </Group>
            <Table.ScrollContainer minWidth={600}>
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('app.code')}</Table.Th>
                    <Table.Th>{t('app.name')}</Table.Th>
                    <Table.Th>{t('org.parent')}</Table.Th>
                    <Table.Th>{t('app.status')}</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {departments.data?.length === 0 && <EmptyRow colSpan={5} />}
                  {departments.data?.map((d) => (
                    <Table.Tr key={d.id}>
                      <Table.Td dir="ltr" style={{ textAlign: 'start' }}>
                        {d.code}
                      </Table.Td>
                      <Table.Td>{localName(settings.language, d)}</Table.Td>
                      <Table.Td>{d.parentId ? deptName(d.parentId) : t('app.none')}</Table.Td>
                      <Table.Td>
                        <StatusBadge status={d.status} label={t(`app.${d.status}`)} />
                      </Table.Td>
                      <Table.Td>
                        {can('org.department.manage') && (
                          <Button
                            size="xs"
                            variant="subtle"
                            onClick={() => {
                              setDeptForm({ code: d.code, nameAr: d.nameAr, nameEn: d.nameEn, parentId: d.parentId, status: d.status });
                              setDept({ mode: 'edit', row: d });
                            }}
                          >
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

        <Tabs.Panel value="locations">
          <Paper>
            <Group justify="flex-end" p="sm">
              {can('org.location.manage') && (
                <Button
                  size="xs"
                  leftSection={<IconPlus size={14} />}
                  onClick={() => {
                    setLocForm({ code: '', nameAr: '', nameEn: '', address: '', status: 'active' });
                    setLoc({ mode: 'create' });
                  }}
                >
                  {t('org.newLocation')}
                </Button>
              )}
            </Group>
            <Table.ScrollContainer minWidth={600}>
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('app.code')}</Table.Th>
                    <Table.Th>{t('app.name')}</Table.Th>
                    <Table.Th>{t('org.address')}</Table.Th>
                    <Table.Th>{t('app.status')}</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {locations.data?.length === 0 && <EmptyRow colSpan={5} />}
                  {locations.data?.map((l) => (
                    <Table.Tr key={l.id}>
                      <Table.Td dir="ltr" style={{ textAlign: 'start' }}>
                        {l.code}
                      </Table.Td>
                      <Table.Td>{localName(settings.language, l)}</Table.Td>
                      <Table.Td>
                        <Text size="sm">{l.address ?? t('app.none')}</Text>
                      </Table.Td>
                      <Table.Td>
                        <StatusBadge status={l.status} label={t(`app.${l.status}`)} />
                      </Table.Td>
                      <Table.Td>
                        {can('org.location.manage') && (
                          <Button
                            size="xs"
                            variant="subtle"
                            onClick={() => {
                              setLocForm({ code: l.code, nameAr: l.nameAr, nameEn: l.nameEn, address: l.address ?? '', status: l.status });
                              setLoc({ mode: 'edit', row: l });
                            }}
                          >
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
      </Tabs>

      <Modal opened={!!editCompany} onClose={() => setEditCompany(null)} title={t('app.edit')}>
        {editCompany && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveCompany.mutate(editCompany);
            }}
          >
            <Stack>
              <ErrorAlert error={saveCompany.error} />
              <NameForm
                value={editCompany}
                onChange={(v) => setEditCompany({ ...editCompany, ...v })}
                errors={fieldErrors(saveCompany.error)}
                codeEditable={false}
              />
              <Select
                label={t('app.status')}
                data={statusOptions}
                value={editCompany.status}
                onChange={(v) => setEditCompany({ ...editCompany, status: (v ?? 'active') as CompanyDto['status'] })}
                allowDeselect={false}
              />
              <Group justify="flex-end">
                <Button variant="default" onClick={() => setEditCompany(null)}>
                  {t('app.cancel')}
                </Button>
                <Button type="submit" loading={saveCompany.isPending}>
                  {t('app.save')}
                </Button>
              </Group>
            </Stack>
          </form>
        )}
      </Modal>

      <Modal opened={!!dept} onClose={() => setDept(null)} title={dept?.mode === 'edit' ? t('app.edit') : t('org.newDepartment')}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            saveDept.mutate();
          }}
        >
          <Stack>
            <ErrorAlert error={saveDept.error} />
            <NameForm value={deptForm} onChange={(v) => setDeptForm({ ...deptForm, ...v })} errors={fieldErrors(saveDept.error)} codeEditable={dept?.mode !== 'edit'} />
            <Select
              label={t('org.parent')}
              placeholder={t('org.noParent')}
              clearable
              data={(departments.data ?? [])
                .filter((d) => dept?.mode !== 'edit' || d.id !== dept.row.id)
                .map((d) => ({ value: d.id, label: localName(settings.language, d) }))}
              value={deptForm.parentId}
              onChange={(v) => setDeptForm({ ...deptForm, parentId: v })}
              error={fieldErrors(saveDept.error).parentId}
            />
            {dept?.mode === 'edit' && (
              <Select
                label={t('app.status')}
                data={statusOptions}
                value={deptForm.status}
                onChange={(v) => setDeptForm({ ...deptForm, status: v ?? 'active' })}
                allowDeselect={false}
              />
            )}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setDept(null)}>
                {t('app.cancel')}
              </Button>
              <Button type="submit" loading={saveDept.isPending}>
                {t('app.save')}
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>

      <Modal opened={!!loc} onClose={() => setLoc(null)} title={loc?.mode === 'edit' ? t('app.edit') : t('org.newLocation')}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            saveLoc.mutate();
          }}
        >
          <Stack>
            <ErrorAlert error={saveLoc.error} />
            <NameForm value={locForm} onChange={(v) => setLocForm({ ...locForm, ...v })} errors={fieldErrors(saveLoc.error)} codeEditable={loc?.mode !== 'edit'} />
            <Textarea label={t('org.address')} value={locForm.address} onChange={(e) => setLocForm({ ...locForm, address: e.currentTarget.value })} autosize minRows={2} />
            {loc?.mode === 'edit' && (
              <Select
                label={t('app.status')}
                data={statusOptions}
                value={locForm.status}
                onChange={(v) => setLocForm({ ...locForm, status: v ?? 'active' })}
                allowDeselect={false}
              />
            )}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setLoc(null)}>
                {t('app.cancel')}
              </Button>
              <Button type="submit" loading={saveLoc.isPending}>
                {t('app.save')}
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </>
  );
}
