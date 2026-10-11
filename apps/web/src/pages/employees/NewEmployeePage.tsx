import { useState, type FormEvent } from 'react';
import { Button, Group, Paper, SimpleGrid, Stack, Switch, Text, TextInput, Title } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { EmployeeDto } from '@hrms/shared';
import { post } from '../../lib/api';
import { useAuth } from '../../auth/AuthContext';
import { ErrorAlert, PageHeader, fieldErrors, notifySaved } from '../../components/common';
import {
  AssignmentFields,
  CompensationFields,
  PersonalFields,
  assignmentPayload,
  compensationPayload,
  emptyAssignment,
  emptyCompensation,
  emptyPersonal,
  personalPayload,
} from './forms';
import { useCompanies } from '../../lib/refdata';
import { DateField } from '../../components/DateFields';

export function NewEmployeePage() {
  const { t } = useTranslation();
  const { session } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const companies = useCompanies();
  const perms = new Set(session?.permissions ?? []);
  const canFinancial = perms.has('employee.financial.edit');

  const [personal, setPersonal] = useState(emptyPersonal());
  const [assignment, setAssignment] = useState(emptyAssignment(companies.data?.length === 1 ? companies.data[0]!.id : null));
  const [hireDate, setHireDate] = useState(new Date().toISOString().slice(0, 10));
  const [actualStart, setActualStart] = useState('');
  const [probationEnd, setProbationEnd] = useState('');
  const [withSalary, setWithSalary] = useState(canFinancial);
  const [comp, setComp] = useState(emptyCompensation());
  const [withBank, setWithBank] = useState(false);
  const [bank, setBank] = useState({ bankName: '', accountNumber: '', iban: '' });

  const create = useMutation({
    mutationFn: () =>
      post<EmployeeDto>('/employees', {
        personal: personalPayload(personal),
        hireDate,
        actualStartDate: actualStart || null,
        probationEndDate: probationEnd || null,
        assignment: assignmentPayload(assignment),
        ...(canFinancial && withSalary ? { compensation: compensationPayload(comp) } : {}),
        ...(canFinancial && withBank
          ? { bankAccount: { bankName: bank.bankName, accountNumber: bank.accountNumber || null, iban: bank.iban || null, isPrimary: true } }
          : {}),
      }),
    onSuccess: async (e) => {
      await qc.invalidateQueries({ queryKey: ['employees'] });
      notifySaved(t, t('emp.created'));
      navigate(`/employees/${e.id}`);
    },
  });
  const errs = fieldErrors(create.error);

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    create.mutate();
  };

  return (
    <form onSubmit={submit}>
      <PageHeader
        title={t('emp.newEmployee')}
        subtitle={t('emp.numberHint')}
        actions={
          <>
            <Button variant="default" component={Link} to="/employees">
              {t('app.cancel')}
            </Button>
            <Button type="submit" loading={create.isPending}>
              {t('app.create')}
            </Button>
          </>
        }
      />
      <Stack gap="lg">
        <ErrorAlert error={create.error} />
        <Paper p="lg">
          <Title order={3} size="h5" mb="md">
            {t('emp.sections.personal')}
          </Title>
          <PersonalFields value={personal} onChange={setPersonal} errors={errs} />
        </Paper>

        <Paper p="lg">
          <Title order={3} size="h5" mb="md">
            {t('emp.sections.employment')}
          </Title>
          <Stack>
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <DateField label={t('emp.hireDate')} value={hireDate} onChange={(v) => setHireDate(v)} required error={errs.hireDate} />
              <DateField label={t('emp.actualStart')} value={actualStart} onChange={(v) => setActualStart(v)} />
              <DateField label={t('emp.probationEnd')} value={probationEnd} onChange={(v) => setProbationEnd(v)} />
            </SimpleGrid>
            <AssignmentFields value={assignment} onChange={setAssignment} errors={errs} />
          </Stack>
        </Paper>

        {canFinancial && (
          <Paper p="lg">
            <Group justify="space-between" mb="md">
              <Title order={3} size="h5">
                {t('emp.sections.compensation')}
              </Title>
              <Switch checked={withSalary} onChange={(e) => setWithSalary(e.currentTarget.checked)} aria-label={t('emp.sections.compensation')} />
            </Group>
            {withSalary && <CompensationFields value={comp} onChange={setComp} companyId={assignment.companyId} errors={errs} />}
          </Paper>
        )}

        {canFinancial && (
          <Paper p="lg">
            <Group justify="space-between" mb="md">
              <Title order={3} size="h5">
                {t('emp.sections.bank')}
              </Title>
              <Switch checked={withBank} onChange={(e) => setWithBank(e.currentTarget.checked)} aria-label={t('emp.sections.bank')} />
            </Group>
            {withBank && (
              <SimpleGrid cols={{ base: 1, sm: 3 }}>
                <TextInput label={t('emp.bankName')} value={bank.bankName} onChange={(e) => setBank({ ...bank, bankName: e.currentTarget.value })} required />
                <TextInput label={t('emp.accountNumber')} value={bank.accountNumber} onChange={(e) => setBank({ ...bank, accountNumber: e.currentTarget.value })} dir="ltr" />
                <TextInput label={t('emp.iban')} value={bank.iban} onChange={(e) => setBank({ ...bank, iban: e.currentTarget.value })} dir="ltr" error={errs['bankAccount.iban']} />
              </SimpleGrid>
            )}
          </Paper>
        )}
        {!canFinancial && (
          <Text size="sm" c="dimmed">
            {t('emp.restricted')} ({t('emp.sections.compensation')})
          </Text>
        )}
      </Stack>
    </form>
  );
}
