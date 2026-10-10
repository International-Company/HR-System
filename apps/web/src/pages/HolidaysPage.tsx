import { useState } from 'react';
import { Button, Group, Modal, NumberInput, Paper, Select, Stack, Table, Text, TextInput } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { HolidayDto } from '@hrms/shared';
import { del, get, post } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { useCompanies } from '../lib/refdata';
import { EmptyRow, ErrorAlert, PageHeader, localName, notifyError, notifySaved } from '../components/common';

export function HolidaysPage() {
  const { t } = useTranslation();
  const { can, settings, fmt } = useAuth();
  const lang = settings.language;
  const qc = useQueryClient();
  const companies = useCompanies();
  const [year, setYear] = useState(new Date().getFullYear());
  const list = useQuery({ queryKey: ['holidays', year], queryFn: () => get<HolidayDto[]>(`/holidays?year=${year}`) });
  const [form, setForm] = useState<{ companyId: string | null; date: string; nameAr: string; nameEn: string } | null>(null);
  const add = useMutation({
    mutationFn: () => post('/holidays', form),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['holidays'] });
      setForm(null);
      notifySaved(t);
    },
  });
  const remove = async (id: string) => {
    try {
      await del(`/holidays/${id}`);
      await qc.invalidateQueries({ queryKey: ['holidays'] });
    } catch (err) {
      notifyError(t, err);
    }
  };
  const companyName = (id: string | null) => {
    if (!id) return t('cal.groupWide');
    const c = companies.data?.find((x) => x.id === id);
    return c ? localName(lang, c) : '—';
  };

  return (
    <>
      <PageHeader
        title={t('cal.holidays')}
        subtitle={t('cal.scopeHint')}
        actions={
          can('holidays.manage') && (
            <Button leftSection={<IconPlus size={16} />} onClick={() => setForm({ companyId: null, date: `${year}-01-01`, nameAr: '', nameEn: '' })}>
              {t('cal.newHoliday')}
            </Button>
          )
        }
      />
      <NumberInput mb="md" w={140} label={t('cal.year')} value={year} min={2000} max={2100} onChange={(v) => setYear(Number(v) || year)} />
      <ErrorAlert error={list.error} />
      <Paper maw={820}>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('cal.date')}</Table.Th>
              <Table.Th>{t('app.name')}</Table.Th>
              <Table.Th>{t('lookups.scope')}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {list.data?.length === 0 && <EmptyRow colSpan={4} />}
            {list.data?.map((h) => (
              <Table.Tr key={h.id}>
                <Table.Td>{fmt.date(h.date)}</Table.Td>
                <Table.Td>{localName(lang, h)}</Table.Td>
                <Table.Td>
                  <Text size="sm">{companyName(h.companyId)}</Text>
                </Table.Td>
                <Table.Td>
                  {can('holidays.manage') && (
                    <Button size="xs" variant="subtle" color="red" onClick={() => void remove(h.id)}>
                      {t('emp.remove')}
                    </Button>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Paper>
      <Modal opened={!!form} onClose={() => setForm(null)} title={t('cal.newHoliday')}>
        {form && (
          <Stack>
            <ErrorAlert error={add.error} />
            <Select
              label={t('lookups.scope')}
              data={[{ value: '', label: t('cal.groupWide') }, ...(companies.data ?? []).map((c) => ({ value: c.id, label: localName(lang, c) }))]}
              value={form.companyId ?? ''}
              onChange={(v) => setForm({ ...form, companyId: v || null })}
              allowDeselect={false}
            />
            <TextInput type="date" label={t('cal.date')} value={form.date} onChange={(e) => setForm({ ...form, date: e.currentTarget.value })} required />
            <TextInput label={t('app.nameAr')} value={form.nameAr} onChange={(e) => setForm({ ...form, nameAr: e.currentTarget.value })} required dir="rtl" />
            <TextInput label={t('app.nameEn')} value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.currentTarget.value })} required dir="ltr" />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setForm(null)}>
                {t('app.cancel')}
              </Button>
              <Button disabled={!form.nameAr || !form.nameEn} loading={add.isPending} onClick={() => add.mutate()}>
                {t('app.save')}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}
