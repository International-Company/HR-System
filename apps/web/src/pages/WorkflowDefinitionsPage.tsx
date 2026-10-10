import { useState } from 'react';
import { Alert, Badge, Button, Card, Checkbox, Group, Modal, Select, Stack, Text, TextInput } from '@mantine/core';
import { IconLock, IconPlus, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { APPROVER_RULES, type RoleDto, type WorkflowDefinitionDto, type WorkflowStepDto } from '@hrms/shared';
import { get, put } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { ErrorAlert, PageHeader, localName, notifySaved } from '../components/common';

export function WorkflowDefinitionsPage() {
  const { t } = useTranslation();
  const { settings } = useAuth();
  const lang = settings.language;
  const qc = useQueryClient();
  const defs = useQuery({ queryKey: ['workflow-definitions'], queryFn: () => get<WorkflowDefinitionDto[]>('/workflow/definitions') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => get<RoleDto[]>('/roles') });
  const [edit, setEdit] = useState<{ def: WorkflowDefinitionDto; steps: WorkflowStepDto[] } | null>(null);
  const save = useMutation({
    mutationFn: () => put(`/workflow/definitions/${edit!.def.id}/steps`, { version: edit!.def.version, steps: edit!.steps }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['workflow-definitions'] });
      setEdit(null);
      notifySaved(t);
    },
  });
  const roleName = (key: string | null) => {
    const r = roles.data?.find((x) => x.key === key);
    return r ? localName(lang, r) : (key ?? '');
  };
  const setStep = (i: number, p: Partial<WorkflowStepDto>) => edit && setEdit({ ...edit, steps: edit.steps.map((s, n) => (n === i ? { ...s, ...p } : s)) });

  return (
    <>
      <PageHeader title={t('tasks.definitions')} />
      <ErrorAlert error={defs.error} />
      <Stack maw={820}>
        {defs.data?.map((d) => (
          <Card key={d.id} withBorder>
            <Group justify="space-between">
              <Group gap="xs">
                <Text fw={600}>{lang === 'ar' ? d.nameAr : d.nameEn}</Text>
                {d.locked && (
                  <Badge leftSection={<IconLock size={12} />} variant="light" color="gray">
                    {t('tasks.locked')}
                  </Badge>
                )}
              </Group>
              {!d.locked && (
                <Button size="xs" variant="default" onClick={() => setEdit({ def: d, steps: d.steps.map((s) => ({ ...s })) })}>
                  {t('app.edit')}
                </Button>
              )}
            </Group>
            {d.locked && (
              <Text size="xs" c="dimmed" mt={4}>
                {t('tasks.lockedHint')}
              </Text>
            )}
            <Group gap="xs" mt="sm">
              {d.steps.map((s) => (
                <Badge key={s.seq} variant="outline" color="gray" tt="none" size="lg">
                  {s.seq}. {lang === 'ar' ? s.nameAr : s.nameEn} — {t(`tasks.rules.${s.approverRule}`)}
                  {s.roleKey ? ` (${roleName(s.roleKey)})` : ''}
                </Badge>
              ))}
            </Group>
          </Card>
        ))}
      </Stack>
      <Modal opened={!!edit} onClose={() => setEdit(null)} title={t('tasks.definitions')} size="lg">
        {edit && (
          <Stack>
            <ErrorAlert error={save.error} />
            {edit.steps.map((s, i) => (
              <Card key={i} withBorder p="sm">
                <Group align="flex-end" wrap="wrap" gap="xs">
                  <Select
                    w={180}
                    label={t('tasks.step')}
                    data={APPROVER_RULES.filter((r) => r !== 'specific_user').map((r) => ({ value: r, label: t(`tasks.rules.${r}`) }))}
                    value={s.approverRule}
                    onChange={(v) => setStep(i, { approverRule: (v ?? 'direct_manager') as WorkflowStepDto['approverRule'] })}
                    allowDeselect={false}
                  />
                  {s.approverRule === 'role_in_company' && (
                    <Select w={180} label={t('tasks.role')} data={(roles.data ?? []).map((r) => ({ value: r.key, label: localName(lang, r) }))} value={s.roleKey} onChange={(v) => setStep(i, { roleKey: v })} />
                  )}
                  <TextInput w={140} label={t('app.nameAr')} value={s.nameAr} onChange={(e) => setStep(i, { nameAr: e.currentTarget.value })} dir="rtl" />
                  <TextInput w={140} label={t('app.nameEn')} value={s.nameEn} onChange={(e) => setStep(i, { nameEn: e.currentTarget.value })} dir="ltr" />
                  <Checkbox mb={8} label={t('tasks.skippable')} checked={s.skipIfUnresolved} onChange={(e) => setStep(i, { skipIfUnresolved: e.currentTarget.checked })} />
                  <Button size="compact-xs" variant="subtle" color="red" mb={8} onClick={() => setEdit({ ...edit, steps: edit.steps.filter((_, n) => n !== i) })} aria-label={t('emp.remove')}>
                    <IconTrash size={14} />
                  </Button>
                </Group>
              </Card>
            ))}
            <Button
              variant="light"
              leftSection={<IconPlus size={14} />}
              onClick={() => setEdit({ ...edit, steps: [...edit.steps, { seq: edit.steps.length + 1, approverRule: 'role_in_company', roleKey: 'hr', userId: null, skipIfUnresolved: false, nameAr: 'الموارد البشرية', nameEn: 'HR' }] })}
            >
              {t('tasks.addStep')}
            </Button>
            {!edit.steps.some((s) => !s.skipIfUnresolved) && <Alert color="yellow">{t('errors.VALIDATION_FAILED')}</Alert>}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setEdit(null)}>
                {t('app.cancel')}
              </Button>
              <Button loading={save.isPending} disabled={!edit.steps.length} onClick={() => save.mutate()}>
                {t('app.save')}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}
