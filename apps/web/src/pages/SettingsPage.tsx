import { useEffect, useState } from 'react';
import {
  Button,
  Group,
  MultiSelect,
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
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BUSINESS_MODULES, type SettingValue, type CompanyDto, type ModuleDto, type RoleDto, type SettingDto } from '@hrms/shared';
import { del, get, patch, put } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { ErrorAlert, PageHeader, localName, notifyError, notifySaved } from '../components/common';

const TIME_ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'Europe/Amsterdam', 'Europe/Berlin', 'Europe/Paris', 'Europe/Madrid', 'Europe/Rome', 'Europe/Athens', 'Europe/Lisbon'];
  }
})();

type AttendancePolicy = SettingValue<'attendance.policy'>;

function useSettingSaver(companyId: string | null) {
  const { t } = useTranslation();
  const { refresh } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) => put(`/settings/${key}`, { value, companyId }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['settings'] });
      await refresh();
      notifySaved(t);
    },
    onError: (err) => notifyError(t, err),
  });
}

/** One editable setting row; `render` builds the input for the draft value. */
function SettingRow<T>({
  setting,
  label,
  canEdit,
  render,
  onSave,
  onResetOverride,
  saving,
}: {
  setting: SettingDto | undefined;
  label: string;
  canEdit: boolean;
  render: (value: T, set: (v: T) => void) => React.ReactNode;
  onSave: (v: T) => void;
  onResetOverride?: (() => void) | undefined;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<T | undefined>(setting?.value as T | undefined);
  useEffect(() => setDraft(setting?.value as T | undefined), [setting?.value]);
  if (!setting || draft === undefined) return null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(setting.value);
  return (
    <Paper p="md">
      <Stack gap="xs">
        <Group justify="space-between">
          <Text fw={500}>{label}</Text>
          {setting.companyValue !== null && onResetOverride && (
            <Group gap="xs">
              <Text size="xs" c="brand.7">
                {t('settings.overridden')}
              </Text>
              <Button size="compact-xs" variant="subtle" onClick={onResetOverride}>
                {t('settings.resetOverride')}
              </Button>
            </Group>
          )}
        </Group>
        <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }}>
          {render(draft, setDraft)}
        </fieldset>
        {canEdit && (
          <Group justify="flex-end">
            <Button size="xs" disabled={!dirty} loading={saving} onClick={() => onSave(draft)}>
              {t('app.save')}
            </Button>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}

export function SettingsPage() {
  const { t } = useTranslation();
  const { can, settings: pub } = useAuth();
  const [companyId, setCompanyId] = useState<string | null>(null);
  const companies = useQuery({ queryKey: ['companies'], queryFn: () => get<CompanyDto[]>('/companies'), enabled: can('org.company.view') });
  const settings = useQuery({
    queryKey: ['settings', companyId],
    queryFn: () => get<SettingDto[]>(`/settings${companyId ? `?companyId=${companyId}` : ''}`),
  });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => get<RoleDto[]>('/roles'), enabled: can('access.role.view') });
  const saver = useSettingSaver(companyId);
  const qc = useQueryClient();
  const s = (key: string) => settings.data?.find((x) => x.key === key);
  const resetOverride = (key: string) => async () => {
    try {
      await del(`/settings/${key}?companyId=${companyId}`);
      await qc.invalidateQueries({ queryKey: ['settings'] });
      notifySaved(t);
    } catch (err) {
      notifyError(t, err);
    }
  };
  const row = <T,>(key: string, label: string, render: (v: T, set: (v: T) => void) => React.ReactNode) => {
    const setting = s(key);
    const canEdit = !!setting && can(setting.permission) && (!companyId || setting.companyOverride);
    return (
      <SettingRow<T>
        key={`${key}-${companyId}`}
        setting={setting}
        label={label}
        canEdit={canEdit}
        render={render}
        saving={saver.isPending}
        onSave={(value) => saver.mutate({ key, value })}
        onResetOverride={companyId && setting?.companyOverride ? resetOverride(key) : undefined}
      />
    );
  };

  return (
    <>
      <PageHeader title={t('settings.title')} />
      <ErrorAlert error={settings.error} />
      {can('org.company.view') && (
        <Select
          mb="lg"
          maw={360}
          label={t('settings.companyOverride')}
          placeholder={t('settings.selectCompany')}
          clearable
          data={(companies.data ?? []).map((c) => ({ value: c.id, label: localName(pub.language, c) }))}
          value={companyId}
          onChange={setCompanyId}
        />
      )}
      <Tabs defaultValue="general" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="general">{t('settings.general')}</Tabs.Tab>
          <Tabs.Tab value="security">{t('settings.security')}</Tabs.Tab>
          <Tabs.Tab value="modules">{t('settings.modules')}</Tabs.Tab>
          <Tabs.Tab value="attendance">{t('att.policy')}</Tabs.Tab>
          <Tabs.Tab value="leave">{t('leave.permissionPolicy')}</Tabs.Tab>
          <Tabs.Tab value="contracts">{t('ctr.policy')}</Tabs.Tab>
          <Tabs.Tab value="payroll">{t('pay.policy')}</Tabs.Tab>
          <Tabs.Tab value="separation">{t('sep.policy')}</Tabs.Tab>
          {can('system.backup.view') && <Tabs.Tab value="backup">{t('settings.backup')}</Tabs.Tab>}
        </Tabs.List>

        <Tabs.Panel value="general">
          <SimpleGrid cols={{ base: 1, md: 2 }}>
            {row<string>('general.language', t('settings.language'), (v, set) => (
              <Select data={[{ value: 'ar', label: 'العربية' }, { value: 'en', label: 'English' }]} value={v} onChange={(x) => set(x ?? v)} allowDeselect={false} />
            ))}
            {row<string>('general.timezone', t('settings.timezone'), (v, set) => (
              <Select data={TIME_ZONES} value={v} onChange={(x) => set(x ?? v)} searchable allowDeselect={false} dir="ltr" />
            ))}
            {row<string>('general.dateFormat', t('settings.dateFormat'), (v, set) => (
              <Select data={['DD/MM/YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY']} value={v} onChange={(x) => set(x ?? v)} allowDeselect={false} dir="ltr" />
            ))}
            {row<string>('general.timeFormat', t('settings.timeFormat'), (v, set) => (
              <Select data={['24h', '12h']} value={v} onChange={(x) => set(x ?? v)} allowDeselect={false} dir="ltr" />
            ))}
            {row<string>('general.numerals', t('settings.numerals'), (v, set) => (
              <Select
                data={[
                  { value: 'latn', label: t('settings.numeralsLatn') },
                  { value: 'arab', label: t('settings.numeralsArab') },
                ]}
                value={v}
                onChange={(x) => set(x ?? v)}
                allowDeselect={false}
              />
            ))}
            {row<{ prefix: string; padding: number }>('employee.numberFormat', t('emp.number'), (v, set) => (
              <Group grow>
                <TextInput label={t('emp.numberPrefix')} value={v.prefix} onChange={(e) => set({ ...v, prefix: e.currentTarget.value })} dir="ltr" maxLength={10} />
                <NumberInput label={t('emp.numberDigits')} min={1} max={10} value={v.padding} onChange={(x) => set({ ...v, padding: Number(x) || 1 })} />
              </Group>
            ))}
            {row<string>('general.defaultCurrency', t('settings.currency'), (v, set) => (
              <TextInput value={v} onChange={(e) => set(e.currentTarget.value.toUpperCase())} maxLength={3} dir="ltr" />
            ))}
          </SimpleGrid>
        </Tabs.Panel>

        <Tabs.Panel value="security">
          <SimpleGrid cols={{ base: 1, md: 2 }}>
            {row<{ minLength: number }>('security.passwordPolicy', t('settings.minLength'), (v, set) => (
              <NumberInput min={8} max={128} value={v.minLength} onChange={(x) => set({ minLength: Number(x) || 8 })} />
            ))}
            {row<{ maxFailures: number; lockMinutes: number }>('security.lockout', t('settings.maxFailures'), (v, set) => (
              <Group grow>
                <NumberInput label={t('settings.maxFailures')} min={3} max={20} value={v.maxFailures} onChange={(x) => set({ ...v, maxFailures: Number(x) || 3 })} />
                <NumberInput label={t('settings.lockMinutes')} min={1} max={1440} value={v.lockMinutes} onChange={(x) => set({ ...v, lockMinutes: Number(x) || 1 })} />
              </Group>
            ))}
            {row<{ idleMinutes: number; absoluteHours: number }>('security.session', t('settings.idleMinutes'), (v, set) => (
              <Group grow>
                <NumberInput label={t('settings.idleMinutes')} min={5} max={480} value={v.idleMinutes} onChange={(x) => set({ ...v, idleMinutes: Number(x) || 5 })} />
                <NumberInput label={t('settings.absoluteHours')} min={1} max={72} value={v.absoluteHours} onChange={(x) => set({ ...v, absoluteHours: Number(x) || 1 })} />
              </Group>
            ))}
            {row<{ requiredForRoles: string[] }>('security.mfa', t('settings.mfaRoles'), (v, set) => (
              <MultiSelect
                data={(roles.data ?? []).map((r) => ({ value: r.key, label: localName(pub.language, r) }))}
                value={v.requiredForRoles}
                onChange={(x) => set({ requiredForRoles: x })}
                searchable
              />
            ))}
          </SimpleGrid>
        </Tabs.Panel>

        <Tabs.Panel value="modules">
          <ModulesPanel companies={companies.data ?? []} />
        </Tabs.Panel>

        <Tabs.Panel value="attendance">
          {row<AttendancePolicy>('attendance.policy', t('att.policy'), (v, set) => {
            const f = (k: string) => t(`att.policyFields.${k}`);
            return (
              <SimpleGrid cols={{ base: 1, md: 2 }}>
                <Switch label={f('requireNetwork')} checked={v.requireNetwork} onChange={(e) => set({ ...v, requireNetwork: e.currentTarget.checked })} />
                <Switch label={f('deviceApproval')} checked={v.deviceApproval} onChange={(e) => set({ ...v, deviceApproval: e.currentTarget.checked })} />
                <Switch label={f('autoCheckout')} checked={v.autoCheckout} onChange={(e) => set({ ...v, autoCheckout: e.currentTarget.checked })} />
                <Select
                  label={f('verification')}
                  data={(['none', 'webauthn', 'pin', 'webauthn_or_pin'] as const).map((x) => ({ value: x, label: f(`verifications.${x}`) }))}
                  value={v.verification}
                  onChange={(x) => set({ ...v, verification: (x ?? v.verification) as AttendancePolicy['verification'] })}
                  allowDeselect={false}
                />
                <NumberInput label={f('overtimeMinMinutes')} min={0} max={240} value={v.overtimeMinMinutes} onChange={(x) => set({ ...v, overtimeMinMinutes: Number(x) || 0 })} />
                <NumberInput label={f('correctionWindowDays')} min={0} max={365} value={v.correctionWindowDays} onChange={(x) => set({ ...v, correctionWindowDays: Number(x) || 0 })} />
                <Select
                  label={f('earlyArrival')}
                  data={(['ignore', 'overtime'] as const).map((x) => ({ value: x, label: f(`earlyArrivals.${x}`) }))}
                  value={v.earlyArrival}
                  onChange={(x) => set({ ...v, earlyArrival: (x ?? v.earlyArrival) as AttendancePolicy['earlyArrival'] })}
                  allowDeselect={false}
                />
                <Select
                  label={f('restDayWork')}
                  data={(['flag', 'overtime'] as const).map((x) => ({ value: x, label: f(`restDayWorks.${x}`) }))}
                  value={v.restDayWork}
                  onChange={(x) => set({ ...v, restDayWork: (x ?? v.restDayWork) as AttendancePolicy['restDayWork'] })}
                  allowDeselect={false}
                />
              </SimpleGrid>
            );
          })}
        </Tabs.Panel>

        <Tabs.Panel value="leave">
          {row<SettingValue<'leave.permissions'>>('leave.permissions', t('leave.permissionPolicy'), (v, set) => {
            const f = (k: string) => t(`leave.permissionFields.${k}`);
            return (
              <SimpleGrid cols={{ base: 1, md: 2 }}>
                <Switch label={f('enabled')} checked={v.enabled} onChange={(e) => set({ ...v, enabled: e.currentTarget.checked })} />
                <Select
                  label={f('unit')}
                  data={(['hours', 'minutes', 'both'] as const).map((x) => ({ value: x, label: f(`units.${x}`) }))}
                  value={v.unit}
                  onChange={(x) => set({ ...v, unit: (x ?? v.unit) as typeof v.unit })}
                  allowDeselect={false}
                />
                <NumberInput label={f('maxMinutesPerDay')} min={15} max={720} value={v.maxMinutesPerDay} onChange={(x) => set({ ...v, maxMinutesPerDay: Number(x) || 15 })} />
                <NumberInput label={f('maxMinutesPerMonth')} min={0} max={10000} value={v.maxMinutesPerMonth} onChange={(x) => set({ ...v, maxMinutesPerMonth: Number(x) || 0 })} />
                <NumberInput label={f('retroactiveDays')} min={0} max={60} value={v.retroactiveDays} onChange={(x) => set({ ...v, retroactiveDays: Number(x) || 0 })} />
              </SimpleGrid>
            );
          })}
        </Tabs.Panel>

        <Tabs.Panel value="contracts">
          {row<SettingValue<'contracts.policy'>>('contracts.policy', t('ctr.policy'), (v, set) => {
            const f = (k: string) => t(`ctr.policyFields.${k}`);
            const days = (s: string) =>
              s
                .split(/[,،\s]+/)
                .map(Number)
                .filter((n) => Number.isInteger(n) && n > 0)
                .slice(0, 5);
            return (
              <SimpleGrid cols={{ base: 1, md: 2 }}>
                <TextInput label={f('numberPrefix')} value={v.numberPrefix} maxLength={10} dir="ltr" onChange={(e) => set({ ...v, numberPrefix: e.currentTarget.value })} />
                <Switch mt="xl" label={f('showInProfile')} checked={v.showInProfile} onChange={(e) => set({ ...v, showInProfile: e.currentTarget.checked })} />
                <TextInput label={f('expiryAlertDays')} defaultValue={v.expiryAlertDays.join(', ')} dir="ltr" onBlur={(e) => set({ ...v, expiryAlertDays: days(e.currentTarget.value) })} />
                <TextInput label={f('probationAlertDays')} defaultValue={v.probationAlertDays.join(', ')} dir="ltr" onBlur={(e) => set({ ...v, probationAlertDays: days(e.currentTarget.value) })} />
                <MultiSelect
                  label={f('alertRecipients')}
                  data={(['hr', 'direct_manager', 'employee'] as const).map((x) => ({ value: x, label: f(`recipients.${x}`) }))}
                  value={v.alertRecipients}
                  onChange={(x) => x.length && set({ ...v, alertRecipients: x as typeof v.alertRecipients })}
                />
                <Select
                  label={f('expiryDuringLeave')}
                  data={(['expire', 'hold_until_return'] as const).map((x) => ({ value: x, label: f(`expiryDuringLeaveModes.${x}`) }))}
                  value={v.expiryDuringLeave}
                  onChange={(x) => set({ ...v, expiryDuringLeave: (x ?? v.expiryDuringLeave) as typeof v.expiryDuringLeave })}
                  allowDeselect={false}
                />
              </SimpleGrid>
            );
          })}
        </Tabs.Panel>

        <Tabs.Panel value="payroll">
          <Stack>
            {row<SettingValue<'payroll.policy'>>('payroll.policy', t('pay.policy'), (v, set) => {
              const f = (k: string) => t(`pay.policyFields.${k}`);
              return (
                <SimpleGrid cols={{ base: 1, md: 2 }}>
                  <Select
                    label={f('dayRateBasis')}
                    data={(['fixed_30', 'calendar_days', 'working_days'] as const).map((x) => ({ value: x, label: f(`dayRateBases.${x}`) }))}
                    value={v.dayRateBasis}
                    onChange={(x) => set({ ...v, dayRateBasis: (x ?? v.dayRateBasis) as typeof v.dayRateBasis })}
                    allowDeselect={false}
                  />
                  <NumberInput label={f('hoursPerDay')} min={1} max={24} decimalScale={2} value={v.hoursPerDay} onChange={(x) => set({ ...v, hoursPerDay: Number(x) || 8 })} />
                  <NumberInput label={f('overtimeMultiplier')} min={0} max={5} decimalScale={2} step={0.25} value={v.overtimeMultiplier} onChange={(x) => set({ ...v, overtimeMultiplier: Number(x) || 0 })} />
                  <NumberInput label={f('holidayWorkMultiplier')} min={0} max={5} decimalScale={2} step={0.25} value={v.holidayWorkMultiplier} onChange={(x) => set({ ...v, holidayWorkMultiplier: Number(x) || 0 })} />
                  <Select
                    label={f('latenessDeduction')}
                    data={(['none', 'per_minute'] as const).map((x) => ({ value: x, label: f(`latenessDeductions.${x}`) }))}
                    value={v.latenessDeduction}
                    onChange={(x) => set({ ...v, latenessDeduction: (x ?? v.latenessDeduction) as typeof v.latenessDeduction })}
                    allowDeselect={false}
                  />
                  <NumberInput label={f('latenessToleranceMinutes')} min={0} max={10000} value={v.latenessToleranceMinutes} onChange={(x) => set({ ...v, latenessToleranceMinutes: Number(x) || 0 })} />
                  <Select
                    label={f('absenceDeduction')}
                    data={(['none', 'confirmed', 'confirmed_and_pending'] as const).map((x) => ({ value: x, label: f(`absenceDeductions.${x}`) }))}
                    value={v.absenceDeduction}
                    onChange={(x) => set({ ...v, absenceDeduction: (x ?? v.absenceDeduction) as typeof v.absenceDeduction })}
                    allowDeselect={false}
                  />
                  <NumberInput label={f('payDay')} min={1} max={31} value={v.payDay} onChange={(x) => set({ ...v, payDay: Number(x) || 28 })} />
                  <Switch label={f('unpaidLeaveDeduction')} checked={v.unpaidLeaveDeduction} onChange={(e) => set({ ...v, unpaidLeaveDeduction: e.currentTarget.checked })} />
                  <Switch label={f('notifyEmployees')} checked={v.notifyEmployees} onChange={(e) => set({ ...v, notifyEmployees: e.currentTarget.checked })} />
                </SimpleGrid>
              );
            })}
            {row<SettingValue<'payroll.endOfService'>>('payroll.endOfService', t('pay.eosPolicy'), (v, set) => {
              const f = (k: string) => t(`pay.eosFields.${k}`);
              return (
                <Stack>
                  <SimpleGrid cols={{ base: 1, md: 2 }}>
                    <Select
                      label={f('method')}
                      data={(['none', 'days_per_year', 'months_per_year'] as const).map((x) => ({ value: x, label: f(`methods.${x}`) }))}
                      value={v.method}
                      onChange={(x) => set({ ...v, method: (x ?? v.method) as typeof v.method })}
                      allowDeselect={false}
                    />
                    <NumberInput label={f('minYears')} min={0} max={10} decimalScale={2} value={v.minYears} onChange={(x) => set({ ...v, minYears: Number(x) || 0 })} />
                    {v.method === 'months_per_year' && <NumberInput label={f('monthsPerYear')} min={0} max={12} decimalScale={2} value={v.monthsPerYear} onChange={(x) => set({ ...v, monthsPerYear: Number(x) || 0 })} />}
                    <NumberInput label={f('capMonths')} min={0} max={120} value={v.capMonths ?? ''} onChange={(x) => set({ ...v, capMonths: x === '' ? null : Number(x) })} />
                  </SimpleGrid>
                  {v.method === 'days_per_year' && (
                    <Stack gap="xs">
                      <Group justify="space-between">
                        <Text size="sm" fw={500}>
                          {f('bands')}
                        </Text>
                        <Button size="compact-xs" variant="light" onClick={() => set({ ...v, bands: [...v.bands, { fromYears: v.bands.length ? 5 : 0, daysPerYear: 21 }] })}>
                          {f('addBand')}
                        </Button>
                      </Group>
                      {v.bands.map((b, i) => (
                        <Group key={i} gap="xs" align="flex-end">
                          <NumberInput w={140} label={f('fromYears')} min={0} max={60} value={b.fromYears} onChange={(x) => set({ ...v, bands: v.bands.map((y, n) => (n === i ? { ...y, fromYears: Number(x) || 0 } : y)) })} />
                          <NumberInput w={140} label={f('daysPerYear')} min={0} max={365} value={b.daysPerYear} onChange={(x) => set({ ...v, bands: v.bands.map((y, n) => (n === i ? { ...y, daysPerYear: Number(x) || 0 } : y)) })} />
                          <Button size="compact-xs" variant="subtle" color="red" mb={6} onClick={() => set({ ...v, bands: v.bands.filter((_, n) => n !== i) })}>
                            ✕
                          </Button>
                        </Group>
                      ))}
                    </Stack>
                  )}
                </Stack>
              );
            })}
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="separation">
          {row<SettingValue<'separation.policy'>>('separation.policy', t('sep.policy'), (v, set) => {
            const f = (k: string) => t(`sep.policyFields.${k}`);
            return (
              <SimpleGrid cols={{ base: 1, md: 2 }}>
                <Switch label={f('selfResignation')} checked={v.selfResignation} onChange={(e) => set({ ...v, selfResignation: e.currentTarget.checked })} />
                <NumberInput label={f('resignationNoticeDays')} min={0} max={365} value={v.resignationNoticeDays} onChange={(x) => set({ ...v, resignationNoticeDays: Number(x) || 0 })} />
                <Select
                  label={f('accountOnExit')}
                  data={(['disable', 'self_service_only'] as const).map((x) => ({ value: x, label: f(`accountModes.${x}`) }))}
                  value={v.accountOnExit}
                  onChange={(x) => set({ ...v, accountOnExit: (x ?? v.accountOnExit) as typeof v.accountOnExit })}
                  allowDeselect={false}
                />
                <Switch label={f('revokeDevices')} checked={v.revokeDevices} onChange={(e) => set({ ...v, revokeDevices: e.currentTarget.checked })} />
                <Switch label={f('cancelFutureLeave')} checked={v.cancelFutureLeave} onChange={(e) => set({ ...v, cancelFutureLeave: e.currentTarget.checked })} />
                <Switch label={f('endContract')} checked={v.endContract} onChange={(e) => set({ ...v, endContract: e.currentTarget.checked })} />
                <Switch label={f('settlement')} checked={v.settlement} onChange={(e) => set({ ...v, settlement: e.currentTarget.checked })} />
              </SimpleGrid>
            );
          })}
        </Tabs.Panel>

        <Tabs.Panel value="backup">
          <SimpleGrid cols={{ base: 1, md: 2 }}>
            {row<{ enabled: boolean; dailyAt: string }>('backup.policy', t('settings.backup'), (v, set) => (
              <Stack>
                <Switch label={t('settings.backupEnabled')} checked={v.enabled} onChange={(e) => set({ ...v, enabled: e.currentTarget.checked })} />
                <TextInput label={t('settings.backupAt')} type="time" value={v.dailyAt} onChange={(e) => set({ ...v, dailyAt: e.currentTarget.value })} dir="ltr" />
              </Stack>
            ))}
          </SimpleGrid>
        </Tabs.Panel>
      </Tabs>
    </>
  );
}

function ModulesPanel({ companies }: { companies: CompanyDto[] }) {
  const { t } = useTranslation();
  const { can, settings } = useAuth();
  const qc = useQueryClient();
  const modules = useQuery({ queryKey: ['modules'], queryFn: () => get<ModuleDto[]>('/modules') });
  const canManage = can('settings.manage.modules');
  const act = (fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['modules'] });
      notifySaved(t);
    } catch (err) {
      notifyError(t, err);
    }
  };

  return (
    <Stack>
      <Text size="sm" c="dimmed">
        {t('settings.modulesHint')}
      </Text>
      <ErrorAlert error={modules.error} />
      <Paper>
        <Table.ScrollContainer minWidth={720}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('app.name')}</Table.Th>
                <Table.Th>{t('settings.moduleEnabled')}</Table.Th>
                <Table.Th>{t('settings.disablePolicy')}</Table.Th>
                <Table.Th>{t('settings.perCompany')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {modules.data?.map((m) => {
                const def = BUSINESS_MODULES.find((x) => x.key === m.key);
                return (
                  <Table.Tr key={m.key}>
                    <Table.Td>{def ? def.name[settings.language] : m.key}</Table.Td>
                    <Table.Td>
                      <Switch
                        checked={m.groupEnabled}
                        disabled={!canManage}
                        onChange={(e) => void act(() => patch(`/modules/${m.key}`, { groupEnabled: e.currentTarget.checked }))()}
                        aria-label={t('settings.moduleEnabled')}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Select
                        size="xs"
                        w={220}
                        disabled={!canManage}
                        data={[
                          { value: 'read_only', label: t('settings.readOnly') },
                          { value: 'hidden', label: t('settings.hidden') },
                        ]}
                        value={m.disablePolicy}
                        onChange={(v) => v && void act(() => patch(`/modules/${m.key}`, { disablePolicy: v }))()}
                        allowDeselect={false}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs">
                        {companies.map((c) => {
                          const state = m.companies.find((x) => x.companyId === c.id);
                          const enabled = state ? state.enabled : true;
                          return (
                            <Switch
                              key={c.id}
                              size="xs"
                              label={c.code}
                              checked={enabled && m.groupEnabled}
                              disabled={!canManage || !m.groupEnabled}
                              onChange={(e) => void act(() => put(`/modules/${m.key}/companies/${c.id}`, { enabled: e.currentTarget.checked }))()}
                            />
                          );
                        })}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Paper>
    </Stack>
  );
}
