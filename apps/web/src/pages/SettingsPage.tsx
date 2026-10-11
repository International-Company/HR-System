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
