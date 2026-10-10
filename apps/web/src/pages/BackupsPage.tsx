import { Alert, Button, Group, Paper, Table, Text } from '@mantine/core';
import { IconDatabaseExport, IconRestore } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { useTranslation } from 'react-i18next';
import type { BackupRunDto } from '@hrms/shared';
import { get, post } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { EmptyRow, ErrorAlert, PageHeader, StatusBadge, notifyError } from '../components/common';

interface BackupStatus {
  configured: boolean;
  destination: string | null;
  encrypted: boolean;
  policy: { enabled: boolean; dailyAt: string };
  lastBackup: BackupRunDto | null;
  lastRestoreTest: BackupRunDto | null;
  runs: BackupRunDto[];
}

export function BackupsPage() {
  const { t } = useTranslation();
  const { can, fmt } = useAuth();
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['backups'],
    queryFn: () => get<BackupStatus>('/backups'),
    refetchInterval: (q) => (q.state.data?.runs.some((r) => r.status === 'requested' || r.status === 'running') ? 5000 : false),
  });
  const request = useMutation({
    mutationFn: (kind: 'backup' | 'restore') => post(kind === 'backup' ? '/backups' : '/backups/restore-tests'),
    onSuccess: async () => {
      notifications.show({ color: 'blue', message: t('backups.requested') });
      await qc.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (err) => notifyError(t, err),
  });
  const d = status.data;

  return (
    <>
      <PageHeader
        title={t('backups.title')}
        subtitle={d?.destination ? `${t('backups.destination')}: ${d.destination}` : undefined}
        actions={
          can('system.backup.create') &&
          d?.configured && (
            <>
              <Button leftSection={<IconDatabaseExport size={16} />} loading={request.isPending && request.variables === 'backup'} onClick={() => request.mutate('backup')}>
                {t('backups.backupNow')}
              </Button>
              <Button variant="light" leftSection={<IconRestore size={16} />} loading={request.isPending && request.variables === 'restore'} onClick={() => request.mutate('restore')}>
                {t('backups.restoreTest')}
              </Button>
            </>
          )
        }
      />
      <ErrorAlert error={status.error} />
      {d && !d.configured && (
        <Alert color="yellow" variant="light" mb="md">
          {t('backups.notConfigured')}
        </Alert>
      )}
      <Alert color="blue" variant="light" mb="md">
        {t('backups.restoreNote')}
      </Alert>
      <Paper>
        <Table.ScrollContainer minWidth={760}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('backups.created')}</Table.Th>
                <Table.Th>{t('backups.kind')}</Table.Th>
                <Table.Th>{t('app.status')}</Table.Th>
                <Table.Th>{t('backups.size')}</Table.Th>
                <Table.Th>{t('backups.finished')}</Table.Th>
                <Table.Th>{t('backups.error')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {d?.runs.length === 0 && <EmptyRow colSpan={6} />}
              {d?.runs.map((r) => (
                <Table.Tr key={r.id}>
                  <Table.Td>{fmt.dateTime(r.createdAt)}</Table.Td>
                  <Table.Td>{t(`backups.kinds.${r.kind}`)}</Table.Td>
                  <Table.Td>
                    <StatusBadge status={r.status} label={t(`backups.states.${r.status}`)} />
                  </Table.Td>
                  <Table.Td>{fmt.bytes(r.sizeBytes)}</Table.Td>
                  <Table.Td>{fmt.dateTime(r.finishedAt)}</Table.Td>
                  <Table.Td>
                    <Text size="xs" c="red" lineClamp={2} dir="ltr" style={{ textAlign: 'start' }}>
                      {r.error ?? ''}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Paper>
      <Group mt="sm">
        <Text size="xs" c="dimmed">
          {d?.encrypted ? 'AES-256-GCM' : ''}
        </Text>
      </Group>
    </>
  );
}
