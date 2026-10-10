import { Fragment, useState } from 'react';
import { ActionIcon, Alert, Button, Code, Group, Paper, Select, SimpleGrid, Stack, Table, Text, TextInput } from '@mantine/core';
import { IconChevronDown, IconChevronUp, IconShieldCheck } from '@tabler/icons-react';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { AuditEventDto, Page } from '@hrms/shared';
import { get, post } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { EmptyRow, ErrorAlert, PageHeader, StatusBadge } from '../components/common';

export function AuditPage() {
  const { t } = useTranslation();
  const { can, fmt } = useAuth();
  const [action, setAction] = useState('');
  const [outcome, setOutcome] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const events = useInfiniteQuery({
    queryKey: ['audit', action, outcome],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: '50' });
      if (action) p.set('action', action);
      if (outcome) p.set('outcome', outcome);
      if (pageParam) p.set('before', pageParam);
      return get<Page<AuditEventDto>>(`/audit-events?${p.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });
  const verify = useMutation({ mutationFn: () => post<{ ok: boolean; checked: number; firstBadId: number | null }>('/audit-events/verify') });
  const rows = events.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader
        title={t('audit.title')}
        actions={
          can('audit.verify') && (
            <Button variant="light" leftSection={<IconShieldCheck size={16} />} loading={verify.isPending} onClick={() => verify.mutate()}>
              {t('audit.verify')}
            </Button>
          )
        }
      />
      {verify.data && (
        <Alert mb="md" color={verify.data.ok ? 'green' : 'red'} variant="light">
          {verify.data.ok ? t('audit.verifyOk', { count: verify.data.checked }) : t('audit.verifyFail', { id: verify.data.firstBadId })}
        </Alert>
      )}
      <ErrorAlert error={events.error ?? verify.error} />
      <Group mb="md" align="flex-end">
        <TextInput label={t('audit.filterAction')} value={action} onChange={(e) => setAction(e.currentTarget.value)} dir="ltr" w={240} placeholder="org." />
        <Select
          label={t('audit.outcome')}
          clearable
          w={180}
          data={[
            { value: 'success', label: t('audit.success') },
            { value: 'denied', label: t('audit.denied') },
            { value: 'failure', label: t('audit.failure') },
          ]}
          value={outcome}
          onChange={setOutcome}
        />
      </Group>
      <Paper>
        <Table.ScrollContainer minWidth={760}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('audit.when')}</Table.Th>
                <Table.Th>{t('audit.who')}</Table.Th>
                <Table.Th>{t('audit.action')}</Table.Th>
                <Table.Th>{t('audit.entity')}</Table.Th>
                <Table.Th>{t('audit.outcome')}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {!events.isLoading && rows.length === 0 && <EmptyRow colSpan={6} />}
              {rows.map((e) => (
                <Fragment key={e.id}>
                  <Table.Tr>
                    <Table.Td>{fmt.dateTime(e.at)}</Table.Td>
                    <Table.Td dir="ltr" style={{ textAlign: 'start' }}>
                      {e.actorUsername ?? t('app.none')}
                    </Table.Td>
                    <Table.Td dir="ltr" style={{ textAlign: 'start' }}>
                      <Code>{e.action}</Code>
                    </Table.Td>
                    <Table.Td dir="ltr" style={{ textAlign: 'start' }}>
                      <Text size="xs" c="dimmed">
                        {e.entityType ?? ''} {e.entityId ? `#${e.entityId.slice(0, 8)}` : ''}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <StatusBadge status={e.outcome} label={t(`audit.${e.outcome}`)} />
                    </Table.Td>
                    <Table.Td>
                      <ActionIcon variant="subtle" onClick={() => setOpen(open === e.id ? null : e.id)} aria-label={t('audit.details')}>
                        {open === e.id ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
                      </ActionIcon>
                    </Table.Td>
                  </Table.Tr>
                  {open === e.id && (
                    <Table.Tr>
                      <Table.Td colSpan={6} bg="var(--mantine-color-gray-0)">
                        <SimpleGrid cols={{ base: 1, md: 3 }} dir="ltr">
                          {(['before', 'after', 'details'] as const).map((k) => (
                            <Stack key={k} gap={4}>
                              <Text size="xs" fw={600} c="dimmed">
                                {t(`audit.${k}`)}
                              </Text>
                              <Code block>{e[k] ? JSON.stringify(e[k], null, 2) : '—'}</Code>
                            </Stack>
                          ))}
                        </SimpleGrid>
                        <Text size="xs" c="dimmed" mt="xs" dir="ltr">
                          IP: {e.ip ?? '—'} · id {e.id}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  )}
                </Fragment>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Paper>
      {events.hasNextPage && (
        <Group justify="center" mt="md">
          <Button variant="default" loading={events.isFetchingNextPage} onClick={() => void events.fetchNextPage()}>
            {t('app.loadMore')}
          </Button>
        </Group>
      )}
    </>
  );
}
