import { useState } from 'react';
import { Badge, Button, Checkbox, Group, Modal, MultiSelect, NumberInput, Paper, Select, SimpleGrid, Stack, Table, Text, TextInput } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { DOCUMENT_SENSITIVITIES, DOCUMENT_TYPES, type DocumentCategoryDto } from '@hrms/shared';
import { patch, post } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { useDocumentCategories } from '../lib/refdata';
import { EmptyRow, ErrorAlert, PageHeader, StatusBadge, fieldErrors, localName, notifySaved } from '../components/common';

type Draft = Omit<DocumentCategoryDto, 'id' | 'version'> & { id?: string; version?: number };

const blank = (): Draft => ({
  code: '',
  nameAr: '',
  nameEn: '',
  allowedTypes: ['pdf'],
  maxSizeMb: 20,
  sensitivity: 'normal',
  employeeVisible: false,
  allowReplace: true,
  allowDelete: true,
  hasExpiry: false,
  retentionYears: null,
  status: 'active',
});

export function DocumentCategoriesPage() {
  const { t } = useTranslation();
  const { can, settings } = useAuth();
  const qc = useQueryClient();
  const categories = useDocumentCategories();
  const [draft, setDraft] = useState<Draft | null>(null);
  const manage = can('documents.categories.manage');

  const save = useMutation({
    mutationFn: () => {
      const d = draft!;
      const body = {
        nameAr: d.nameAr,
        nameEn: d.nameEn,
        allowedTypes: d.allowedTypes,
        maxSizeMb: d.maxSizeMb,
        sensitivity: d.sensitivity,
        employeeVisible: d.employeeVisible,
        allowReplace: d.allowReplace,
        allowDelete: d.allowDelete,
        hasExpiry: d.hasExpiry,
        retentionYears: d.retentionYears,
      };
      return d.id
        ? patch(`/document-categories/${d.id}`, { ...body, status: d.status, version: d.version })
        : post('/document-categories', { ...body, code: d.code });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['document-categories'] });
      setDraft(null);
      notifySaved(t);
    },
  });

  return (
    <>
      <PageHeader
        title={t('docs.categories')}
        subtitle={t('docs.noExpiryAlerts')}
        actions={
          manage && (
            <Button leftSection={<IconPlus size={16} />} onClick={() => setDraft(blank())}>
              {t('docs.newCategory')}
            </Button>
          )
        }
      />
      <ErrorAlert error={categories.error} />
      <Paper>
        <Table.ScrollContainer minWidth={760}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('app.name')}</Table.Th>
                <Table.Th>{t('docs.allowedTypes')}</Table.Th>
                <Table.Th>{t('docs.maxSize')}</Table.Th>
                <Table.Th>{t('docs.sensitivity')}</Table.Th>
                <Table.Th>{t('docs.employeeVisible')}</Table.Th>
                <Table.Th>{t('app.status')}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {categories.data?.length === 0 && <EmptyRow colSpan={7} />}
              {categories.data?.map((c) => (
                <Table.Tr key={c.id}>
                  <Table.Td>
                    <Stack gap={0}>
                      <Text size="sm">{localName(settings.language, c)}</Text>
                      <Text size="xs" c="dimmed" dir="ltr">
                        {c.code}
                      </Text>
                    </Stack>
                  </Table.Td>
                  <Table.Td dir="ltr" style={{ textAlign: 'start' }}>
                    {c.allowedTypes.join(', ')}
                  </Table.Td>
                  <Table.Td>{c.maxSizeMb}</Table.Td>
                  <Table.Td>
                    <Badge variant="light" color={c.sensitivity === 'medical' ? 'red' : c.sensitivity === 'restricted' ? 'orange' : 'gray'}>
                      {t(`docs.sensitivities.${c.sensitivity}`)}
                    </Badge>
                  </Table.Td>
                  <Table.Td>{c.employeeVisible ? t('app.yes') : t('app.no')}</Table.Td>
                  <Table.Td>
                    <StatusBadge status={c.status} label={t(`app.${c.status}`)} />
                  </Table.Td>
                  <Table.Td>
                    {manage && (
                      <Button size="xs" variant="subtle" onClick={() => setDraft({ ...c })}>
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

      <Modal opened={!!draft} onClose={() => setDraft(null)} title={draft?.id ? t('app.edit') : t('docs.newCategory')} size="lg">
        {draft && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <Stack>
              <ErrorAlert error={save.error} />
              <SimpleGrid cols={{ base: 1, sm: 3 }}>
                <TextInput label={t('app.code')} value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.currentTarget.value })} disabled={!!draft.id} required dir="ltr" error={fieldErrors(save.error).code} />
                <TextInput label={t('app.nameAr')} value={draft.nameAr} onChange={(e) => setDraft({ ...draft, nameAr: e.currentTarget.value })} required dir="rtl" />
                <TextInput label={t('app.nameEn')} value={draft.nameEn} onChange={(e) => setDraft({ ...draft, nameEn: e.currentTarget.value })} required dir="ltr" />
              </SimpleGrid>
              <MultiSelect label={t('docs.allowedTypes')} data={[...DOCUMENT_TYPES]} value={draft.allowedTypes} onChange={(v) => setDraft({ ...draft, allowedTypes: v as Draft['allowedTypes'] })} required />
              <SimpleGrid cols={{ base: 1, sm: 3 }}>
                <NumberInput label={t('docs.maxSize')} min={1} max={50} value={draft.maxSizeMb} onChange={(v) => setDraft({ ...draft, maxSizeMb: Number(v) || 1 })} />
                <Select
                  label={t('docs.sensitivity')}
                  data={DOCUMENT_SENSITIVITIES.map((s) => ({ value: s, label: t(`docs.sensitivities.${s}`) }))}
                  value={draft.sensitivity}
                  onChange={(v) => setDraft({ ...draft, sensitivity: (v ?? 'normal') as Draft['sensitivity'] })}
                  allowDeselect={false}
                />
                <NumberInput label={t('docs.retention')} min={1} max={100} value={draft.retentionYears ?? ''} onChange={(v) => setDraft({ ...draft, retentionYears: v === '' ? null : Number(v) })} />
              </SimpleGrid>
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <Checkbox label={t('docs.employeeVisible')} checked={draft.employeeVisible} onChange={(e) => setDraft({ ...draft, employeeVisible: e.currentTarget.checked })} />
                <Checkbox label={t('docs.hasExpiry')} checked={draft.hasExpiry} onChange={(e) => setDraft({ ...draft, hasExpiry: e.currentTarget.checked })} />
                <Checkbox label={t('docs.allowReplace')} checked={draft.allowReplace} onChange={(e) => setDraft({ ...draft, allowReplace: e.currentTarget.checked })} />
                <Checkbox label={t('docs.allowDelete')} checked={draft.allowDelete} onChange={(e) => setDraft({ ...draft, allowDelete: e.currentTarget.checked })} />
              </SimpleGrid>
              {draft.id && (
                <Select
                  label={t('app.status')}
                  data={[
                    { value: 'active', label: t('app.active') },
                    { value: 'inactive', label: t('app.inactive') },
                  ]}
                  value={draft.status}
                  onChange={(v) => setDraft({ ...draft, status: (v ?? 'active') as Draft['status'] })}
                  allowDeselect={false}
                />
              )}
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
