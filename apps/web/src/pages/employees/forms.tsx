import { ActionIcon, Button, Group, Select, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { GENDERS, ID_TYPES, MARITAL_STATUSES, PAYMENT_METHODS } from '@hrms/shared';
import { useAuth } from '../../auth/AuthContext';
import { employeeName, lookupOptions, useCompanies, useDepartments, useEmployeeOptions, useLocations, useLookups } from '../../lib/refdata';
import { localName } from '../../components/common';
import { DateField } from '../../components/DateFields';

export interface AssignmentForm {
  companyId: string | null;
  departmentId: string | null;
  jobTitleId: string | null;
  managerEmployeeId: string | null;
  workLocationId: string | null;
  employmentCategoryId: string | null;
  contractTypeId: string | null;
  contractStart: string;
  contractEnd: string;
}

export const emptyAssignment = (companyId: string | null = null): AssignmentForm => ({
  companyId,
  departmentId: null,
  jobTitleId: null,
  managerEmployeeId: null,
  workLocationId: null,
  employmentCategoryId: null,
  contractTypeId: null,
  contractStart: '',
  contractEnd: '',
});

export function assignmentPayload(a: AssignmentForm) {
  return {
    companyId: a.companyId,
    departmentId: a.departmentId,
    jobTitleId: a.jobTitleId,
    managerEmployeeId: a.managerEmployeeId,
    workLocationId: a.workLocationId,
    employmentCategoryId: a.employmentCategoryId,
    contractTypeId: a.contractTypeId,
    contractStart: a.contractStart || null,
    contractEnd: a.contractEnd || null,
  };
}

/** Company → department/location/job title/category/contract/manager selection. */
export function AssignmentFields({
  value,
  onChange,
  errors = {},
  companyFilter,
  excludeEmployeeId,
}: {
  value: AssignmentForm;
  onChange: (v: AssignmentForm) => void;
  errors?: Record<string, string>;
  companyFilter?: (companyId: string) => boolean;
  excludeEmployeeId?: string;
}) {
  const { t } = useTranslation();
  const { settings } = useAuth();
  const lang = settings.language;
  const companies = useCompanies();
  const departments = useDepartments(value.companyId);
  const locations = useLocations(value.companyId);
  const lookups = useLookups();
  const managers = useEmployeeOptions();
  const set = (patch: Partial<AssignmentForm>) => onChange({ ...value, ...patch });

  return (
    <SimpleGrid cols={{ base: 1, sm: 2 }}>
      <Select
        label={t('emp.company')}
        required
        data={(companies.data ?? [])
          .filter((c) => c.status === 'active' && (!companyFilter || companyFilter(c.id)))
          .map((c) => ({ value: c.id, label: localName(lang, c) }))}
        value={value.companyId}
        onChange={(v) => set({ companyId: v, departmentId: null, workLocationId: null, jobTitleId: null })}
        error={errors['assignment.companyId'] ?? errors.companyId}
        searchable
      />
      <Select
        label={t('emp.department')}
        clearable
        data={(departments.data ?? []).filter((d) => d.status === 'active').map((d) => ({ value: d.id, label: localName(lang, d) }))}
        value={value.departmentId}
        onChange={(v) => set({ departmentId: v })}
        disabled={!value.companyId}
      />
      <Select
        label={t('emp.jobTitle')}
        clearable
        searchable
        data={lookupOptions(lookups.data, 'job_title', lang, value.companyId, value.jobTitleId)}
        value={value.jobTitleId}
        onChange={(v) => set({ jobTitleId: v })}
        error={errors['assignment.jobTitleId'] ?? errors.jobTitleId}
      />
      <Select
        label={t('emp.manager')}
        clearable
        searchable
        data={(managers.data ?? [])
          .filter((e) => e.id !== excludeEmployeeId && e.status !== 'terminated')
          .map((e) => ({ value: e.id, label: `${employeeName(lang, e)} (${e.employeeNo})` }))}
        value={value.managerEmployeeId}
        onChange={(v) => set({ managerEmployeeId: v })}
        error={errors.managerEmployeeId}
      />
      <Select
        label={t('emp.location')}
        clearable
        data={(locations.data ?? []).filter((l) => l.status === 'active').map((l) => ({ value: l.id, label: localName(lang, l) }))}
        value={value.workLocationId}
        onChange={(v) => set({ workLocationId: v })}
        disabled={!value.companyId}
      />
      <Select
        label={t('emp.category')}
        clearable
        data={lookupOptions(lookups.data, 'employment_category', lang, value.companyId, value.employmentCategoryId)}
        value={value.employmentCategoryId}
        onChange={(v) => set({ employmentCategoryId: v })}
      />
      <Select
        label={t('emp.contractType')}
        clearable
        data={lookupOptions(lookups.data, 'contract_type', lang, value.companyId, value.contractTypeId)}
        value={value.contractTypeId}
        onChange={(v) => set({ contractTypeId: v })}
      />
      <Group grow>
        <DateField label={t('emp.contractStart')} value={value.contractStart} onChange={(v) => set({ contractStart: v })} />
        <DateField label={t('emp.contractEnd')} value={value.contractEnd} onChange={(v) => set({ contractEnd: v })} />
      </Group>
    </SimpleGrid>
  );
}

export interface CompensationForm {
  baseSalary: string;
  currency: string;
  paymentMethod: string;
  items: { kind: 'allowance' | 'deduction'; typeId: string | null; calc: 'fixed' | 'percent_of_base'; amount: string }[];
}

export const emptyCompensation = (currency = 'EUR'): CompensationForm => ({
  baseSalary: '',
  currency,
  paymentMethod: 'bank_transfer',
  items: [],
});

export function compensationPayload(c: CompensationForm) {
  return {
    baseSalary: c.baseSalary.trim(),
    currency: c.currency.trim().toUpperCase(),
    paymentMethod: c.paymentMethod,
    items: c.items.filter((i) => i.typeId && i.amount).map((i) => ({ ...i, amount: i.amount.trim() })),
  };
}

export function CompensationFields({
  value,
  onChange,
  companyId,
  errors = {},
}: {
  value: CompensationForm;
  onChange: (v: CompensationForm) => void;
  companyId: string | null;
  errors?: Record<string, string>;
}) {
  const { t } = useTranslation();
  const { settings } = useAuth();
  const lookups = useLookups();
  const set = (patch: Partial<CompensationForm>) => onChange({ ...value, ...patch });
  const setItem = (i: number, patch: Partial<CompensationForm['items'][number]>) =>
    set({ items: value.items.map((it, n) => (n === i ? { ...it, ...patch } : it)) });

  return (
    <Stack>
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <TextInput
          label={t('emp.baseSalary')}
          value={value.baseSalary}
          onChange={(e) => set({ baseSalary: e.currentTarget.value })}
          inputMode="decimal"
          dir="ltr"
          required
          error={errors.baseSalary ?? errors['compensation.baseSalary']}
        />
        <TextInput label={t('emp.currency')} value={value.currency} onChange={(e) => set({ currency: e.currentTarget.value.toUpperCase() })} maxLength={3} dir="ltr" required />
        <Select
          label={t('emp.paymentMethod')}
          data={PAYMENT_METHODS.map((m) => ({ value: m, label: t(`emp.paymentMethods.${m}`) }))}
          value={value.paymentMethod}
          onChange={(v) => set({ paymentMethod: v ?? 'bank_transfer' })}
          allowDeselect={false}
        />
      </SimpleGrid>
      {value.items.map((item, i) => (
        <Group key={i} align="flex-end" wrap="wrap" gap="xs">
          <Select
            w={150}
            label={t('emp.itemType')}
            data={[
              { value: 'allowance', label: t('emp.allowances') },
              { value: 'deduction', label: t('emp.deductions') },
            ]}
            value={item.kind}
            onChange={(v) => setItem(i, { kind: (v ?? 'allowance') as 'allowance' | 'deduction', typeId: null })}
            allowDeselect={false}
          />
          <Select
            w={200}
            label={t('app.name')}
            data={lookupOptions(lookups.data, item.kind === 'allowance' ? 'allowance_type' : 'deduction_type', settings.language, companyId, item.typeId)}
            value={item.typeId}
            onChange={(v) => setItem(i, { typeId: v })}
          />
          <Select
            w={170}
            label={t('emp.calc')}
            data={[
              { value: 'fixed', label: t('emp.calcs.fixed') },
              { value: 'percent_of_base', label: t('emp.calcs.percent_of_base') },
            ]}
            value={item.calc}
            onChange={(v) => setItem(i, { calc: (v ?? 'fixed') as 'fixed' | 'percent_of_base' })}
            allowDeselect={false}
          />
          <TextInput w={120} label={t('emp.amount')} value={item.amount} onChange={(e) => setItem(i, { amount: e.currentTarget.value })} dir="ltr" inputMode="decimal" />
          <ActionIcon variant="subtle" color="red" mb={4} onClick={() => set({ items: value.items.filter((_, n) => n !== i) })} aria-label={t('emp.remove')}>
            <IconTrash size={16} />
          </ActionIcon>
        </Group>
      ))}
      <Group>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={14} />}
          onClick={() => set({ items: [...value.items, { kind: 'allowance', typeId: null, calc: 'fixed', amount: '' }] })}
        >
          {t('emp.addItem')}
        </Button>
        {lookupOptions(lookups.data, 'allowance_type', settings.language, companyId).length === 0 && (
          <Text size="xs" c="dimmed">
            {t('lookups.kinds.allowance_type')}: {t('app.noData')}
          </Text>
        )}
      </Group>
    </Stack>
  );
}

export interface PersonalForm {
  fullNameAr: string;
  fullNameEn: string;
  idType: string | null;
  idNumber: string;
  birthDate: string;
  gender: string | null;
  nationality: string;
  maritalStatus: string | null;
  phone: string;
  email: string;
}

export const emptyPersonal = (): PersonalForm => ({
  fullNameAr: '',
  fullNameEn: '',
  idType: 'national_id',
  idNumber: '',
  birthDate: '',
  gender: null,
  nationality: '',
  maritalStatus: null,
  phone: '',
  email: '',
});

export function personalPayload(p: PersonalForm, includeIdentity = true) {
  return {
    fullNameAr: p.fullNameAr.trim(),
    fullNameEn: p.fullNameEn.trim(),
    ...(includeIdentity ? { idType: p.idNumber ? p.idType : null, idNumber: p.idNumber.trim() || null } : {}),
    birthDate: p.birthDate || null,
    gender: p.gender,
    nationality: p.nationality.trim().toUpperCase() || null,
    maritalStatus: p.maritalStatus,
    phone: p.phone.trim() || null,
    email: p.email.trim() || null,
  };
}

export function PersonalFields({
  value,
  onChange,
  errors = {},
  identityEditable = true,
}: {
  value: PersonalForm;
  onChange: (v: PersonalForm) => void;
  errors?: Record<string, string>;
  identityEditable?: boolean;
}) {
  const { t } = useTranslation();
  const set = (patch: Partial<PersonalForm>) => onChange({ ...value, ...patch });
  const e = (k: string) => errors[k] ?? errors[`personal.${k}`];
  return (
    <SimpleGrid cols={{ base: 1, sm: 2 }}>
      <TextInput label={t('emp.fullNameAr')} value={value.fullNameAr} onChange={(ev) => set({ fullNameAr: ev.currentTarget.value })} required dir="rtl" error={e('fullNameAr')} />
      <TextInput label={t('emp.fullNameEn')} value={value.fullNameEn} onChange={(ev) => set({ fullNameEn: ev.currentTarget.value })} required dir="ltr" error={e('fullNameEn')} />
      {identityEditable && (
        <>
          <Select
            label={t('emp.idType')}
            data={ID_TYPES.map((x) => ({ value: x, label: t(`emp.idTypes.${x}`) }))}
            value={value.idType}
            onChange={(v) => set({ idType: v })}
            clearable
          />
          <TextInput label={t('emp.idNumber')} value={value.idNumber} onChange={(ev) => set({ idNumber: ev.currentTarget.value })} dir="ltr" error={e('idNumber')} />
        </>
      )}
      <DateField label={t('emp.birthDate')} value={value.birthDate} onChange={(v) => set({ birthDate: v })} error={e('birthDate')} />
      <Select label={t('emp.gender')} data={GENDERS.map((g) => ({ value: g, label: t(`emp.genders.${g}`) }))} value={value.gender} onChange={(v) => set({ gender: v })} clearable />
      <TextInput label={t('emp.nationality')} value={value.nationality} onChange={(ev) => set({ nationality: ev.currentTarget.value.toUpperCase() })} maxLength={2} dir="ltr" placeholder="DE" error={e('nationality')} />
      <Select
        label={t('emp.maritalStatus')}
        data={MARITAL_STATUSES.map((m) => ({ value: m, label: t(`emp.maritalStatuses.${m}`) }))}
        value={value.maritalStatus}
        onChange={(v) => set({ maritalStatus: v })}
        clearable
      />
      <TextInput label={t('emp.phone')} value={value.phone} onChange={(ev) => set({ phone: ev.currentTarget.value })} dir="ltr" error={e('phone')} />
      <TextInput label={t('emp.email')} type="email" value={value.email} onChange={(ev) => set({ email: ev.currentTarget.value })} dir="ltr" error={e('email')} />
    </SimpleGrid>
  );
}
