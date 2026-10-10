import { useRef, useState } from 'react';
import { Alert, Anchor, Button, FileInput, Group, Modal, Paper, Select, Stack, Table, Text, TextInput } from '@mantine/core';
import { IconDownload, IconUpload } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { DocumentDto } from '@hrms/shared';
import { get, post, upload } from '../../lib/api';
import { useAuth } from '../../auth/AuthContext';
import { useDocumentCategories } from '../../lib/refdata';
import { EmptyRow, ErrorAlert, StatusBadge, localName, notifyError, notifySaved } from '../../components/common';

export function DocumentsTab({ employeeId, canManage }: { employeeId: string; canManage: boolean }) {
  const { t } = useTranslation();
  const { settings, fmt, can } = useAuth();
  const lang = settings.language;
  const qc = useQueryClient();
  const docs = useQuery({ queryKey: ['documents', employeeId], queryFn: () => get<DocumentDto[]>(`/employees/${employeeId}/documents`) });
  const categories = useDocumentCategories();
  const [form, setForm] = useState<{ categoryId: string | null; title: string; expiryDate: string; file: File | null; replaceId?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fileRef = useRef<HTMLButtonElement>(null);

  const cat = (id: string | null | undefined) => categories.data?.find((c) => c.id === id);
  const selected = cat(form?.categoryId);
  const refresh = () => qc.invalidateQueries({ queryKey: ['documents', employeeId] });

  const submit = async () => {
    if (!form?.file) return;
    setBusy(true);
    setError(null);
    const data = new FormData();
    data.append('file', form.file);
    data.append('title', form.title);
    try {
      if (form.replaceId) {
        await upload(`/documents/${form.replaceId}/replace`, data);
      } else {
        data.append('categoryId', form.categoryId ?? '');
        if (form.expiryDate) data.append('expiryDate', form.expiryDate);
        await upload(`/employees/${employeeId}/documents`, data);
      }
      await refresh();
      setForm(null);
      notifySaved(t);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const act = async (path: string) => {
    try {
      await post(path);
      await refresh();
      notifySaved(t);
    } catch (err) {
      notifyError(t, err);
    }
  };

  const canUpload = canManage && can('documents.upload');

  return (
    <Paper p="lg">
      <Group justify="space-between" mb="sm">
        <Text size="xs" c="dimmed">
          {t('docs.noExpiryAlerts')}
        </Text>
        {canUpload && (
          <Button size="xs" leftSection={<IconUpload size={14} />} onClick={() => setForm({ categoryId: null, title: '', expiryDate: '', file: null })}>
            {t('docs.upload')}
          </Button>
        )}
      </Group>
      <ErrorAlert error={docs.error} />
      <Table.ScrollContainer minWidth={720}>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('docs.docTitle')}</Table.Th>
              <Table.Th>{t('docs.category')}</Table.Th>
              <Table.Th>{t('docs.uploaded')}</Table.Th>
              <Table.Th>{t('docs.expiry')}</Table.Th>
              <Table.Th>{t('docs.size')}</Table.Th>
              <Table.Th>{t('app.status')}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {docs.data?.length === 0 && <EmptyRow colSpan={7} />}
            {docs.data?.map((d) => {
              const c = cat(d.categoryId);
              return (
                <Table.Tr key={d.id} opacity={d.status === 'active' ? 1 : 0.6}>
                  <Table.Td>
                    <Stack gap={0}>
                      <Text size="sm">{d.title}</Text>
                      <Text size="xs" c="dimmed" dir="auto">
                        {d.originalName}
                      </Text>
                    </Stack>
                  </Table.Td>
                  <Table.Td>{c ? localName(lang, c) : '—'}</Table.Td>
                  <Table.Td>{fmt.date(d.createdAt)}</Table.Td>
                  <Table.Td>{d.expiryDate ? fmt.date(d.expiryDate) : '—'}</Table.Td>
                  <Table.Td>{fmt.bytes(d.sizeBytes)}</Table.Td>
                  <Table.Td>
                    <StatusBadge status={d.status === 'active' ? 'active' : d.status === 'deleted' ? 'failed' : 'inactive'} label={t(`docs.states.${d.status}`)} />
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4} wrap="nowrap">
                      {d.status !== 'deleted' && (
                        <Anchor href={`/api/v1/documents/${d.id}/content`} size="sm" aria-label={t('docs.download')}>
                          <IconDownload size={16} />
                        </Anchor>
                      )}
                      {canUpload && d.status === 'active' && c?.allowReplace && (
                        <Button size="compact-xs" variant="subtle" onClick={() => setForm({ categoryId: d.categoryId, title: d.title, expiryDate: '', file: null, replaceId: d.id })}>
                          {t('docs.replace')}
                        </Button>
                      )}
                      {can('documents.delete') && c?.allowDelete && d.status === 'active' && (
                        <Button size="compact-xs" variant="subtle" color="red" onClick={() => void act(`/documents/${d.id}/delete`)}>
                          {t('docs.delete')}
                        </Button>
                      )}
                      {can('documents.delete') && d.status === 'deleted' && (
                        <Button size="compact-xs" variant="subtle" onClick={() => void act(`/documents/${d.id}/restore`)}>
                          {t('docs.restore')}
                        </Button>
                      )}
                    </Group>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

      <Modal opened={!!form} onClose={() => setForm(null)} title={form?.replaceId ? t('docs.replace') : t('docs.upload')}>
        {form && (
          <Stack>
            <ErrorAlert error={error} />
            {!form.replaceId && (
              <Select
                label={t('docs.category')}
                required
                data={(categories.data ?? [])
                  .filter((c) => c.status === 'active' && c.code !== 'photo')
                  .map((c) => ({ value: c.id, label: localName(lang, c) }))}
                value={form.categoryId}
                onChange={(v) => setForm({ ...form, categoryId: v })}
              />
            )}
            {selected && (
              <Alert variant="light" color="gray" p="xs">
                <Text size="xs">{t('docs.allowed', { types: selected.allowedTypes.join(', '), mb: selected.maxSizeMb })}</Text>
              </Alert>
            )}
            <TextInput label={t('docs.docTitle')} value={form.title} onChange={(e) => setForm({ ...form, title: e.currentTarget.value })} required />
            {!form.replaceId && selected?.hasExpiry && (
              <TextInput type="date" label={t('docs.expiry')} value={form.expiryDate} onChange={(e) => setForm({ ...form, expiryDate: e.currentTarget.value })} />
            )}
            <FileInput ref={fileRef} label={t('docs.file')} value={form.file} onChange={(f) => setForm({ ...form, file: f })} required clearable />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setForm(null)}>
                {t('app.cancel')}
              </Button>
              <Button loading={busy} disabled={!form.file || !form.title || (!form.replaceId && !form.categoryId)} onClick={() => void submit()}>
                {t('app.save')}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Paper>
  );
}
