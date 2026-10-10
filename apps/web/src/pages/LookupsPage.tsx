import { useState } from 'react';
import { Button, Group, Modal, Paper, Select, Stack, Table, Tabs, TextInput } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { LOOKUP_KINDS, type LookupDto, type LookupKind } from '@hrms/shared';
import { patch, post } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { useCompanies, useLookups } from '../lib/refdata';
import { EmptyRow, ErrorAlert, PageHeader, StatusBadge, fieldErrors, localName, notifySaved } from '../components/common';

type Draft = { id?: string; version?: number; kind: LookupKind; companyId: string | null; code: string; nameAr: string; nameEn: string; status: string };

export function LookupsPage() {
  const { t } = useTranslation();
  const { can, settings } = useAuth();
  const lang = settings.language;
  const qc = useQueryClient();
  const lookups = useLookups();
  const companies = useCompanies();
  const [kind, setKind] = useState<LookupKind>('job_title');
  const [draft, setDraft] = useState<Draft | null>(null);
  const manage = can('lookups.manage');

  const save = useMutation({
    mutationFn: () =>
      draft!.id
        ? patch(`/lookups/${draft!.id}`, { nameAr: draft!.nameAr, nameEn: draft!.nameEn, status: draft!.status, version: draft!.version })
        : post('/lookups', { kind: draft!.kind, companyId: draft!.companyId, code: draft!.code, nameAr: draft!.nameAr, nameEn: draft!.nameEn }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['lookups'] });
      setDraft(null);
      notifySaved(t);
    },
  });
  const companyName = (id: string | null) => {
    if (!id) return t('lookups.groupWide');
    const c = companies.data?.find((x) => x.id === id);
    return c ? localName(lang, c) : '—';
  };
  const rows = (lookups.data ?? []).filter((l) => l.kind === kind);
  const errs = fieldErrors(save.error);

  return (
    <>
      <PageHeader
        title={t('lookups.title')}
        actions={
          manage && (
            <Button leftSection={<IconPlus size={16} />} onClick={() => setDraft({ kind, companyId: null, code: '', nameAr: '', nameEn: '', status: 'active' })}>
              {t('lookups.newValue')}
            </Button>
          )
        }
      />
      <ErrorAlert error={lookups.error} />
      <Tabs value={kind} onChange={(v) => setKind((v ?? 'job_title') as LookupKind)}>
        <Tabs.List mb="md" style={{ flexWrap: 'wrap' }}>
          {LOOKUP_KINDS.map((k) => (
            <Tabs.Tab key={k} value={k}>
              {t(`lookups.kinds.${k}`)}
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs>
      <Paper>
        <Table.ScrollContainer minWidth={600}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('app.code')}</Table.Th>
                <Table.Th>{t('app.name')}</Table.Th>
                <Table.Th>{t('lookups.scope')}</Table.Th>
                <Table.Th>{t('app.status')}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.length === 0 && <EmptyRow colSpan={5} />}
              {rows.map((l: LookupDto) => (
                <Table.Tr key={l.id}>
                  <Table.Td dir="ltr" style={{ textAlign: 'start' }}>
                    {l.code}
                  </Table.Td>
                  <Table.Td>{localName(lang, l)}</Table.Td>
                  <Table.Td>{companyName(l.companyId)}</Table.Td>
                  <Table.Td>
                    <StatusBadge status={l.status} label={t(`app.${l.status}`)} />
                  </Table.Td>
                  <Table.Td>
                    {manage && (
                      <Button size="xs" variant="subtle" onClick={() => setDraft({ ...l, status: l.status })}>
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

      <Modal opened={!!draft} onClose={() => setDraft(null)} title={draft?.id ? t('app.edit') : t('lookups.newValue')}>
        {draft && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <Stack>
              <ErrorAlert error={save.error} />
              {!draft.id && (
                <>
                  <Select
                    label={t('lookups.title')}
                    data={LOOKUP_KINDS.map((k) => ({ value: k, label: t(`lookups.kinds.${k}`) }))}
                    value={draft.kind}
                    onChange={(v) => setDraft({ ...draft, kind: (v ?? 'job_title') as LookupKind })}
                    allowDeselect={false}
                  />
                  <Select
                    label={t('lookups.scope')}
                    placeholder={t('lookups.groupWide')}
                    clearable
                    data={(companies.data ?? []).map((c) => ({ value: c.id, label: localName(lang, c) }))}
                    value={draft.companyId}
                    onChange={(v) => setDraft({ ...draft, companyId: v })}
                  />
                  <TextInput label={t('app.code')} value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.currentTarget.value })} required dir="ltr" error={errs.code} />
                </>
              )}
              <TextInput label={t('app.nameAr')} value={draft.nameAr} onChange={(e) => setDraft({ ...draft, nameAr: e.currentTarget.value })} required dir="rtl" />
              <TextInput label={t('app.nameEn')} value={draft.nameEn} onChange={(e) => setDraft({ ...draft, nameEn: e.currentTarget.value })} required dir="ltr" />
              {draft.id && (
                <Select
                  label={t('app.status')}
                  data={[
                    { value: 'active', label: t('app.active') },
                    { value: 'inactive', label: t('app.inactive') },
                  ]}
                  value={draft.status}
                  onChange={(v) => setDraft({ ...draft, status: v ?? 'active' })}
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
