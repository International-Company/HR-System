import { useRef, useState } from 'react';
import { ActionIcon, Badge, Button, Checkbox, Group, Modal, Paper, Select, SimpleGrid, Stack, Switch, Table, Tabs, Text, TextInput, Textarea } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { MERGE_FIELDS, type ContractClauseDto, type ContractTemplateDto } from '@hrms/shared';
import { get, patch, post } from '../../lib/api';
import { useAuth } from '../../auth/AuthContext';
import { useCompanies } from '../../lib/refdata';
import { EmptyRow, ErrorAlert, PageHeader, localName, notifySaved } from '../../components/common';
import { ContractTypeRules, useContractTypes } from './ContractPages';

const ph = (name: string) => `{{${name}}}`;

/** Templates, clauses and type rules (contracts.templates.manage). */
export function ContractSetupPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('ctr.setup')} />
      <Tabs defaultValue="templates" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="templates">{t('ctr.templates')}</Tabs.Tab>
          <Tabs.Tab value="clauses">{t('ctr.clauses')}</Tabs.Tab>
          <Tabs.Tab value="types">{t('ctr.typeRules')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="templates">
          <TemplatesPanel />
        </Tabs.Panel>
        <Tabs.Panel value="clauses">
          <ClausesPanel />
        </Tabs.Panel>
        <Tabs.Panel value="types">
          <ContractTypeRules />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}

function useClauses() {
  return useQuery({ queryKey: ['contracts', 'clauses'], queryFn: () => get<ContractClauseDto[]>('/contracts/clauses') });
}

function TemplatesPanel() {
  const { t } = useTranslation();
  const { settings } = useAuth();
  const templates = useQuery({ queryKey: ['contracts', 'templates'], queryFn: () => get<ContractTemplateDto[]>('/contracts/templates') });
  const types = useContractTypes();
  const companies = useCompanies();
  const [edit, setEdit] = useState<ContractTemplateDto | 'new' | null>(null);
  return (
    <Paper>
      <Group justify="flex-end" p="sm">
        <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEdit('new')}>
          {t('ctr.newTemplate')}
        </Button>
      </Group>
      <Table highlightOnHover>
        <Table.Tbody>
          {templates.data?.length === 0 && <EmptyRow colSpan={5} />}
          {templates.data?.map((x) => {
            const type = types.find((y) => y.id === x.contractTypeId);
            return (
              <Table.Tr key={x.id} onClick={() => setEdit(x)} style={{ cursor: 'pointer' }} opacity={x.status === 'active' ? 1 : 0.5}>
                <Table.Td dir="ltr" style={{ textAlign: 'start' }}>
                  {x.code}
                </Table.Td>
                <Table.Td>{x.name}</Table.Td>
                <Table.Td>{type ? localName(settings.language, type) : '—'}</Table.Td>
                <Table.Td>
                  <Badge variant="light">{t(`ctr.languages.${x.language}`)}</Badge>
                </Table.Td>
                <Table.Td>{x.companyId ? localName(settings.language, companies.data?.find((c) => c.id === x.companyId) ?? { nameAr: '—', nameEn: '—' }) : t('ctr.groupWide')}</Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
      {edit && <TemplateModal value={edit} onClose={() => setEdit(null)} />}
    </Paper>
  );
}

function TemplateModal({ value, onClose }: { value: ContractTemplateDto | 'new'; onClose: () => void }) {
  const { t } = useTranslation();
  const { settings } = useAuth();
  const lang = settings.language;
  const qc = useQueryClient();
  const types = useContractTypes();
  const companies = useCompanies();
  const clauses = useClauses();
  const isNew = value === 'new';
  const init = isNew ? null : value;
  const [form, setForm] = useState({
    companyId: init?.companyId ?? null,
    contractTypeId: init?.contractTypeId ?? '',
    code: init?.code ?? '',
    name: init?.name ?? '',
    language: init?.language ?? lang,
    body: init?.body ?? '',
    fields: init?.fields ?? [],
    status: init?.status ?? 'active',
  });
  const area = useRef<HTMLTextAreaElement>(null);
  const insert = (text: string) => {
    const el = area.current;
    const at = el ? el.selectionStart : form.body.length;
    setForm({ ...form, body: form.body.slice(0, at) + text + form.body.slice(el ? el.selectionEnd : at) });
  };
  const save = useMutation({
    mutationFn: () =>
      isNew
        ? post('/contracts/templates', { companyId: form.companyId, contractTypeId: form.contractTypeId, code: form.code, name: form.name, language: form.language, body: form.body, fields: form.fields })
        : patch(`/contracts/templates/${init!.id}`, { contractTypeId: form.contractTypeId, name: form.name, language: form.language, body: form.body, fields: form.fields, status: form.status }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['contracts', 'templates'] });
      onClose();
      notifySaved(t);
    },
  });
  return (
    <Modal opened onClose={onClose} size="xl" title={isNew ? t('ctr.newTemplate') : form.name}>
      <Stack>
        <ErrorAlert error={save.error} />
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <TextInput label={t('ctr.code')} disabled={!isNew} value={form.code} onChange={(e) => setForm({ ...form, code: e.currentTarget.value.toUpperCase() })} dir="ltr" />
          <TextInput label={t('ctr.name')} value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} />
          <Select label={t('ctr.type')} data={types.map((x) => ({ value: x.id, label: localName(lang, x) }))} value={form.contractTypeId || null} onChange={(v) => setForm({ ...form, contractTypeId: v ?? '' })} allowDeselect={false} />
          <Select label={t('ctr.language')} data={(['ar', 'en'] as const).map((x) => ({ value: x, label: t(`ctr.languages.${x}`) }))} value={form.language} onChange={(v) => setForm({ ...form, language: (v ?? 'ar') as 'ar' | 'en' })} allowDeselect={false} />
          <Select
            label={t('ctr.company')}
            disabled={!isNew}
            data={[{ value: '', label: t('ctr.groupWide') }, ...(companies.data ?? []).map((c) => ({ value: c.id, label: localName(lang, c) }))]}
            value={form.companyId ?? ''}
            onChange={(v) => setForm({ ...form, companyId: v || null })}
            allowDeselect={false}
          />
          {!isNew && <Switch mt="xl" label={t('ctr.active')} checked={form.status === 'active'} onChange={(e) => setForm({ ...form, status: e.currentTarget.checked ? 'active' : 'inactive' })} />}
        </SimpleGrid>
        <Textarea ref={area} label={t('ctr.body')} description={t('ctr.bodyHelp')} autosize minRows={12} maxRows={24} value={form.body} onChange={(e) => setForm({ ...form, body: e.currentTarget.value })} dir={form.language === 'ar' ? 'rtl' : 'ltr'} />
        <Stack gap={4}>
          <Text size="xs" fw={600}>
            {t('ctr.placeholders')}
          </Text>
          <Group gap={4}>
            {[...MERGE_FIELDS.map(ph), ...form.fields.map((f) => ph(`field.${f.key}`)), ...(clauses.data ?? []).filter((c) => c.language === form.language && c.status === 'active').map((c) => ph(`clause.${c.code}`))].map((p) => (
              <Button key={p} size="compact-xs" variant="light" onClick={() => insert(p)} dir="ltr">
                {p}
              </Button>
            ))}
          </Group>
        </Stack>
        <Stack gap="xs">
          <Group justify="space-between">
            <Text size="sm" fw={500}>
              {t('ctr.templateFields')}
            </Text>
            <Button size="compact-xs" variant="light" onClick={() => setForm({ ...form, fields: [...form.fields, { key: `field${form.fields.length + 1}`, label: '', required: true }] })}>
              {t('ctr.addField')}
            </Button>
          </Group>
          {form.fields.map((f, i) => (
            <Group key={i} align="flex-end" gap="xs">
              <TextInput w={160} label={t('ctr.fieldKey')} value={f.key} dir="ltr" onChange={(e) => setForm({ ...form, fields: form.fields.map((x, n) => (n === i ? { ...x, key: e.currentTarget.value.replace(/[^a-zA-Z0-9_]/g, '') } : x)) })} />
              <TextInput style={{ flex: 1 }} label={t('ctr.fieldLabel')} value={f.label} onChange={(e) => setForm({ ...form, fields: form.fields.map((x, n) => (n === i ? { ...x, label: e.currentTarget.value } : x)) })} />
              <Checkbox mb={8} label={t('ctr.required')} checked={f.required} onChange={(e) => setForm({ ...form, fields: form.fields.map((x, n) => (n === i ? { ...x, required: e.currentTarget.checked } : x)) })} />
              <ActionIcon mb={4} variant="subtle" color="red" aria-label={t('emp.remove')} onClick={() => setForm({ ...form, fields: form.fields.filter((_, n) => n !== i) })}>
                <IconTrash size={14} />
              </ActionIcon>
            </Group>
          ))}
        </Stack>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button disabled={!form.code || !form.name || !form.contractTypeId || !form.body.trim() || form.fields.some((f) => !f.key || !f.label)} loading={save.isPending} onClick={() => save.mutate()}>
            {t('app.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function ClausesPanel() {
  const { t } = useTranslation();
  const clauses = useClauses();
  const [edit, setEdit] = useState<ContractClauseDto | 'new' | null>(null);
  return (
    <Paper>
      <Group justify="flex-end" p="sm">
        <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEdit('new')}>
          {t('ctr.newClause')}
        </Button>
      </Group>
      <Table highlightOnHover>
        <Table.Tbody>
          {clauses.data?.length === 0 && <EmptyRow colSpan={4} />}
          {clauses.data?.map((c) => (
            <Table.Tr key={c.id} onClick={() => setEdit(c)} style={{ cursor: 'pointer' }} opacity={c.status === 'active' ? 1 : 0.5}>
              <Table.Td dir="ltr" style={{ textAlign: 'start' }}>
                {c.code}
              </Table.Td>
              <Table.Td>{c.title}</Table.Td>
              <Table.Td>
                <Badge variant="light">{t(`ctr.languages.${c.language}`)}</Badge>
              </Table.Td>
              <Table.Td>
                <Text size="xs" c="dimmed" lineClamp={1}>
                  {c.body}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {edit && <ClauseModal value={edit} onClose={() => setEdit(null)} />}
    </Paper>
  );
}

function ClauseModal({ value, onClose }: { value: ContractClauseDto | 'new'; onClose: () => void }) {
  const { t } = useTranslation();
  const { settings } = useAuth();
  const qc = useQueryClient();
  const companies = useCompanies();
  const isNew = value === 'new';
  const init = isNew ? null : value;
  const [form, setForm] = useState({
    companyId: init?.companyId ?? null,
    code: init?.code ?? '',
    title: init?.title ?? '',
    language: init?.language ?? settings.language,
    body: init?.body ?? '',
    status: init?.status ?? 'active',
  });
  const save = useMutation({
    mutationFn: () =>
      isNew
        ? post('/contracts/clauses', { companyId: form.companyId, code: form.code, title: form.title, language: form.language, body: form.body })
        : patch(`/contracts/clauses/${init!.id}`, { title: form.title, body: form.body, status: form.status }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['contracts', 'clauses'] });
      onClose();
      notifySaved(t);
    },
  });
  return (
    <Modal opened onClose={onClose} size="lg" title={isNew ? t('ctr.newClause') : form.title}>
      <Stack>
        <ErrorAlert error={save.error} />
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label={t('ctr.code')} disabled={!isNew} value={form.code} onChange={(e) => setForm({ ...form, code: e.currentTarget.value.toUpperCase() })} dir="ltr" />
          <TextInput label={t('ctr.titleField')} value={form.title} onChange={(e) => setForm({ ...form, title: e.currentTarget.value })} />
          <Select label={t('ctr.language')} disabled={!isNew} data={(['ar', 'en'] as const).map((x) => ({ value: x, label: t(`ctr.languages.${x}`) }))} value={form.language} onChange={(v) => setForm({ ...form, language: (v ?? 'ar') as 'ar' | 'en' })} allowDeselect={false} />
          <Select
            label={t('ctr.company')}
            disabled={!isNew}
            data={[{ value: '', label: t('ctr.groupWide') }, ...(companies.data ?? []).map((c) => ({ value: c.id, label: localName(settings.language, c) }))]}
            value={form.companyId ?? ''}
            onChange={(v) => setForm({ ...form, companyId: v || null })}
            allowDeselect={false}
          />
        </SimpleGrid>
        <Textarea label={t('ctr.body')} autosize minRows={6} value={form.body} onChange={(e) => setForm({ ...form, body: e.currentTarget.value })} dir={form.language === 'ar' ? 'rtl' : 'ltr'} />
        <Group gap={4}>
          {MERGE_FIELDS.filter((f) => !f.startsWith('salary')).map((f) => (
            <Button key={f} size="compact-xs" variant="light" dir="ltr" onClick={() => setForm({ ...form, body: `${form.body}${ph(f)}` })}>
              {ph(f)}
            </Button>
          ))}
        </Group>
        {!isNew && <Switch label={t('ctr.active')} checked={form.status === 'active'} onChange={(e) => setForm({ ...form, status: e.currentTarget.checked ? 'active' : 'inactive' })} />}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button disabled={!form.code || !form.title || !form.body.trim()} loading={save.isPending} onClick={() => save.mutate()}>
            {t('app.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
