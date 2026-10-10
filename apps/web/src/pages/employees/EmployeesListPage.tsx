import { useState } from 'react';
import { Anchor, Avatar, Button, Group, Paper, Select, Table, Text, TextInput } from '@mantine/core';
import { IconPlus, IconSearch } from '@tabler/icons-react';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { EMPLOYEE_STATUSES, type EmployeeSummaryDto } from '@hrms/shared';
import { get } from '../../lib/api';
import { useAuth } from '../../auth/AuthContext';
import { employeeName, lookupName, useCompanies, useLookups } from '../../lib/refdata';
import { EmptyRow, ErrorAlert, PageHeader, StatusBadge, localName } from '../../components/common';

const STATUS_COLOR: Record<string, string> = {
  active: 'active',
  probation: 'requested',
  suspended: 'denied',
  long_leave: 'inactive',
  terminated: 'failed',
};

export function EmployeeStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  return <StatusBadge status={STATUS_COLOR[status] ?? 'inactive'} label={t(`emp.statuses.${status}`)} />;
}

export function EmployeeAvatar({ id, hasPhoto, name, size = 'md' }: { id: string; hasPhoto: boolean; name: string; size?: string | number }) {
  return (
    <Avatar src={hasPhoto ? `/api/v1/employees/${id}/photo` : null} radius="xl" size={size} color="brand" alt={name}>
      {name.slice(0, 1)}
    </Avatar>
  );
}

export function EmployeesListPage() {
  const { t } = useTranslation();
  const { can, settings, fmt } = useAuth();
  const lang = settings.language;
  const [q, setQ] = useState('');
  const [debounced] = useDebouncedValue(q, 300);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const companies = useCompanies();
  const lookups = useLookups();
  const params = new URLSearchParams();
  if (debounced) params.set('q', debounced);
  if (companyId) params.set('companyId', companyId);
  if (status) params.set('status', status);
  const list = useQuery({
    queryKey: ['employees', debounced, companyId, status],
    queryFn: () => get<EmployeeSummaryDto[]>(`/employees?${params.toString()}`),
  });
  const companyName = (id: string | null) => {
    const c = companies.data?.find((x) => x.id === id);
    return c ? localName(lang, c) : '—';
  };

  return (
    <>
      <PageHeader
        title={t('emp.title')}
        actions={
          can('employee.profile.create') && (
            <Button component={Link} to="/employees/new" leftSection={<IconPlus size={16} />}>
              {t('emp.newEmployee')}
            </Button>
          )
        }
      />
      <Group mb="md" align="flex-end" wrap="wrap">
        <TextInput
          w={280}
          leftSection={<IconSearch size={16} />}
          placeholder={`${t('app.search')} (${t('emp.name')} / ${t('emp.number')})`}
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          aria-label={t('app.search')}
        />
        {(companies.data?.length ?? 0) > 1 && (
          <Select
            w={220}
            placeholder={t('emp.allCompanies')}
            clearable
            data={(companies.data ?? []).map((c) => ({ value: c.id, label: localName(lang, c) }))}
            value={companyId}
            onChange={setCompanyId}
            aria-label={t('emp.company')}
          />
        )}
        <Select
          w={180}
          placeholder={t('emp.allStatuses')}
          clearable
          data={EMPLOYEE_STATUSES.map((s) => ({ value: s, label: t(`emp.statuses.${s}`) }))}
          value={status}
          onChange={setStatus}
          aria-label={t('emp.status')}
        />
      </Group>
      <ErrorAlert error={list.error} />
      <Paper>
        <Table.ScrollContainer minWidth={760}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('emp.number')}</Table.Th>
                <Table.Th>{t('emp.name')}</Table.Th>
                <Table.Th>{t('emp.company')}</Table.Th>
                <Table.Th>{t('emp.jobTitle')}</Table.Th>
                <Table.Th>{t('emp.hireDate')}</Table.Th>
                <Table.Th>{t('emp.status')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.data?.length === 0 && <EmptyRow colSpan={6} />}
              {list.data?.map((e) => (
                <Table.Tr key={e.id}>
                  <Table.Td dir="ltr" style={{ textAlign: 'start' }}>
                    {e.employeeNo}
                  </Table.Td>
                  <Table.Td>
                    <Group gap="sm" wrap="nowrap">
                      <EmployeeAvatar id={e.id} hasPhoto={e.hasPhoto} name={employeeName(lang, e)} size="sm" />
                      <Anchor component={Link} to={`/employees/${e.id}`}>
                        {employeeName(lang, e)}
                      </Anchor>
                    </Group>
                  </Table.Td>
                  <Table.Td>{companyName(e.companyId)}</Table.Td>
                  <Table.Td>
                    <Text size="sm">{lookupName(lookups.data, e.jobTitleId, lang)}</Text>
                  </Table.Td>
                  <Table.Td>{fmt.date(e.hireDate)}</Table.Td>
                  <Table.Td>
                    <EmployeeStatusBadge status={e.status} />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Paper>
    </>
  );
}
