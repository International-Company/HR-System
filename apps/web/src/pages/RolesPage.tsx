import { useMemo, useState } from 'react';
import { Accordion, Badge, Button, Checkbox, Group, Modal, Paper, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { IconCopy, IconLock, IconPlus } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { RoleDto } from '@hrms/shared';
import { get, patch, post } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { ErrorAlert, PageHeader, fieldErrors, localName, notifySaved } from '../components/common';

interface PermissionInfo {
  key: string;
  module: string;
  sensitivity: 'normal' | 'security';
  groupOnly: boolean;
  label: { ar: string; en: string };
}

type Draft = { mode: 'create' | 'copy' | 'edit'; source?: RoleDto; key: string; nameAr: string; nameEn: string; description: string; permissions: string[] };

export function RolesPage() {
  const { t } = useTranslation();
  const { can, settings } = useAuth();
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => get<RoleDto[]>('/roles') });
  const catalogue = useQuery({ queryKey: ['permissions'], queryFn: () => get<PermissionInfo[]>('/permissions') });
  const [draft, setDraft] = useState<Draft | null>(null);
  const manage = can('access.role.manage');

  const byModule = useMemo(() => {
    const m = new Map<string, PermissionInfo[]>();
    for (const p of catalogue.data ?? []) m.set(p.module, [...(m.get(p.module) ?? []), p]);
    return [...m.entries()];
  }, [catalogue.data]);
  const label = (key: string) => {
    const p = catalogue.data?.find((x) => x.key === key);
    return p ? p.label[settings.language] : key;
  };

  const save = useMutation({
    mutationFn: async () => {
      const d = draft!;
      if (d.mode === 'edit') {
        return patch(`/roles/${d.source!.id}`, {
          nameAr: d.nameAr,
          nameEn: d.nameEn,
          description: d.description || null,
          permissions: d.permissions,
          version: d.source!.version,
        });
      }
      return post('/roles', {
        key: d.key,
        nameAr: d.nameAr,
        nameEn: d.nameEn,
        ...(d.description ? { description: d.description } : {}),
        permissions: d.permissions,
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['roles'] });
      setDraft(null);
      notifySaved(t);
    },
  });
  const errs = fieldErrors(save.error);

  return (
    <>
      <PageHeader
        title={t('roles.title')}
        subtitle={t('roles.systemLocked')}
        actions={
          manage && (
            <Button leftSection={<IconPlus size={16} />} onClick={() => setDraft({ mode: 'create', key: '', nameAr: '', nameEn: '', description: '', permissions: [] })}>
              {t('roles.newRole')}
            </Button>
          )
        }
      />
      <ErrorAlert error={roles.error ?? catalogue.error} />
      <Accordion variant="separated" multiple>
        {roles.data?.map((r) => (
          <Accordion.Item key={r.id} value={r.id}>
            <Accordion.Control icon={r.isSystem ? <IconLock size={16} /> : undefined}>
              <Group gap="xs">
                <Text fw={500}>{localName(settings.language, r)}</Text>
                <Badge variant="light" color={r.isSystem ? 'gray' : 'brand'} size="sm">
                  {r.isSystem ? t('roles.system') : t('roles.custom')}
                </Badge>
                <Text size="xs" c="dimmed" dir="ltr">
                  {r.key}
                </Text>
              </Group>
            </Accordion.Control>
            <Accordion.Panel>
              <Stack gap="xs">
                {r.description && <Text size="sm">{r.description}</Text>}
                <Group gap={6}>
                  {r.permissions.length === 0 && <Text size="sm" c="dimmed">{t('app.none')}</Text>}
                  {r.permissions.map((p) => (
                    <Badge key={p} variant="outline" color="gray" size="sm" tt="none">
                      {label(p)}
                    </Badge>
                  ))}
                </Group>
                {manage && (
                  <Group gap="xs" mt="xs">
                    {!r.isSystem && (
                      <Button
                        size="xs"
                        variant="default"
                        onClick={() =>
                          setDraft({ mode: 'edit', source: r, key: r.key, nameAr: r.nameAr, nameEn: r.nameEn, description: r.description ?? '', permissions: r.permissions })
                        }
                      >
                        {t('app.edit')}
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="light"
                      leftSection={<IconCopy size={14} />}
                      onClick={() =>
                        setDraft({ mode: 'copy', source: r, key: `${r.key}_custom`, nameAr: `${r.nameAr} (مخصص)`, nameEn: `${r.nameEn} (custom)`, description: '', permissions: r.permissions })
                      }
                    >
                      {t('roles.copy')}
                    </Button>
                  </Group>
                )}
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        ))}
      </Accordion>

      <Modal opened={!!draft} onClose={() => setDraft(null)} title={draft?.mode === 'edit' ? t('app.edit') : t('roles.newRole')} size="lg">
        {draft && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <Stack>
              <ErrorAlert error={save.error} />
              <TextInput label={t('roles.key')} value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.currentTarget.value })} disabled={draft.mode === 'edit'} error={errs.key} required dir="ltr" />
              <TextInput label={t('app.nameAr')} value={draft.nameAr} onChange={(e) => setDraft({ ...draft, nameAr: e.currentTarget.value })} required dir="rtl" />
              <TextInput label={t('app.nameEn')} value={draft.nameEn} onChange={(e) => setDraft({ ...draft, nameEn: e.currentTarget.value })} required dir="ltr" />
              <Textarea label={t('roles.description')} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.currentTarget.value })} autosize minRows={2} />
              <Text fw={500} size="sm">
                {t('roles.permissions')}
              </Text>
              <Paper p="sm">
                <Stack gap="md">
                  {byModule.map(([module, perms]) => (
                    <Stack key={module} gap={6}>
                      <Text size="xs" c="dimmed" fw={600} tt="uppercase" dir="ltr" style={{ textAlign: 'start' }}>
                        {module}
                      </Text>
                      {perms.map((p) => (
                        <Checkbox
                          key={p.key}
                          checked={draft.permissions.includes(p.key)}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              permissions: e.currentTarget.checked ? [...draft.permissions, p.key] : draft.permissions.filter((k) => k !== p.key),
                            })
                          }
                          label={
                            <Group gap={6}>
                              <span>{p.label[settings.language]}</span>
                              {p.groupOnly && <Badge size="xs" variant="light" color="gray">{t('roles.groupOnly')}</Badge>}
                              {p.sensitivity === 'security' && <Badge size="xs" variant="light" color="orange">{t('roles.security')}</Badge>}
                            </Group>
                          }
                        />
                      ))}
                    </Stack>
                  ))}
                </Stack>
              </Paper>
              <Group justify="flex-end">
                <Button variant="default" onClick={() => setDraft(null)}>
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
    </>
  );
}
