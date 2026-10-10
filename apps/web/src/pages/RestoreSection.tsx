import { useState } from 'react';
import { Alert, Badge, Button, Group, List, Modal, Paper, PasswordInput, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { IconAlertTriangle, IconRestore } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { BackupRunDto, RestorePreviewDto, RestoreRequestDto } from '@hrms/shared';
import { get, post } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { ErrorAlert, StatusBadge, notifySaved } from '../components/common';

/** System Administrator restore (BKP-06): preview → step-up → (second approver) → verified copy → confirm switch. */
export function RestoreSection({ backups }: { backups: BackupRunDto[] }) {
  const { t } = useTranslation();
  const { fmt, session } = useAuth();
  const qc = useQueryClient();
  const restores = useQuery({
    queryKey: ['restores'],
    queryFn: () => get<{ supported: boolean; requests: RestoreRequestDto[] }>('/backups/restores'),
    refetchInterval: (q) =>
      q.state.data?.requests.some((r) => ['requested', 'preparing', 'switching'].includes(r.status)) ? 5000 : false,
  });
  const [target, setTarget] = useState<string | null>(null);
  const preview = useQuery({
    queryKey: ['restore-preview', target],
    queryFn: () => get<RestorePreviewDto>(`/backups/${target}/restore-preview`),
    enabled: !!target,
  });
  const [form, setForm] = useState({ password: '', code: '', confirmation: '' });
  const [stepUp, setStepUp] = useState<{ id: string; action: 'approve' | 'confirm' } | null>(null);

  const request = useMutation({
    mutationFn: () => post('/backups/restores', { backupRunId: target, ...form }),
    onSuccess: async () => {
      setTarget(null);
      setForm({ password: '', code: '', confirmation: '' });
      await qc.invalidateQueries({ queryKey: ['restores'] });
      notifySaved(t);
    },
  });
  const act = useMutation({
    mutationFn: () => post(`/backups/restores/${stepUp!.id}/${stepUp!.action}`, { password: form.password, code: form.code }),
    onSuccess: async () => {
      setStepUp(null);
      setForm({ password: '', code: '', confirmation: '' });
      await qc.invalidateQueries({ queryKey: ['restores'] });
    },
  });
  const cancel = useMutation({
    mutationFn: (id: string) => post(`/backups/restores/${id}/cancel`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['restores'] }),
  });

  const active = restores.data?.requests.find((r) => ['awaiting_approval', 'requested', 'preparing', 'ready', 'switching'].includes(r.status));
  const points = backups.filter((b) => b.status === 'succeeded' && b.kind !== 'restore_test');
  const p = preview.data;

  return (
    <Paper p="lg" mt="lg" withBorder style={{ borderColor: 'var(--mantine-color-red-3)' }}>
      <Group gap="xs" mb="xs">
        <IconRestore size={20} color="var(--mantine-color-red-7)" />
        <Title order={3} size="h5">
          {t('restore.title')}
        </Title>
      </Group>
      <Text size="sm" mb="md">
        {t('restore.intro')}
      </Text>
      <ErrorAlert error={restores.error} />
      {restores.data && !restores.data.supported && (
        <Alert color="gray" variant="light" mb="md">
          {t('restore.notSupported')}
        </Alert>
      )}

      {active && (
        <Alert color={active.status === 'ready' ? 'orange' : 'blue'} variant="light" mb="md" icon={<IconAlertTriangle size={18} />}>
          <Stack gap="xs">
            <Text fw={600}>{t(`restore.statuses.${active.status}`)}</Text>
            <Text size="sm">
              {t('restore.backupFrom')}: {fmt.dateTime(active.backupAt)} · {active.requestedByName}
            </Text>
            {active.status === 'ready' && <Text size="sm">{t('restore.readyHint')}</Text>}
            <Group gap="xs">
              {active.status === 'awaiting_approval' && active.requestedBy !== session?.user.id && (
                <Button size="xs" color="orange" onClick={() => setStepUp({ id: active.id, action: 'approve' })}>
                  {t('restore.approve')}
                </Button>
              )}
              {active.status === 'ready' && (
                <Button size="xs" color="red" onClick={() => setStepUp({ id: active.id, action: 'confirm' })}>
                  {t('restore.confirmSwitch')}
                </Button>
              )}
              {['awaiting_approval', 'requested', 'ready'].includes(active.status) && (
                <Button size="xs" variant="default" loading={cancel.isPending} onClick={() => cancel.mutate(active.id)}>
                  {t('restore.cancel')}
                </Button>
              )}
            </Group>
          </Stack>
        </Alert>
      )}

      {restores.data?.supported && !active && (
        <Table>
          <Table.Tbody>
            {points.slice(0, 10).map((b) => (
              <Table.Tr key={b.id}>
                <Table.Td>{fmt.dateTime(b.finishedAt)}</Table.Td>
                <Table.Td>
                  <Badge variant="light" color="gray">
                    {t(`backups.kinds.${b.kind}`)}
                  </Badge>
                </Table.Td>
                <Table.Td>{fmt.bytes(b.sizeBytes)}</Table.Td>
                <Table.Td>
                  <Button size="xs" color="red" variant="light" onClick={() => setTarget(b.id)}>
                    {t('restore.choose')}
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      {(restores.data?.requests.length ?? 0) > 0 && (
        <>
          <Text fw={600} size="sm" mt="md" mb="xs">
            {t('restore.history')}
          </Text>
          <Table>
            <Table.Tbody>
              {restores.data!.requests.map((r) => (
                <Table.Tr key={r.id}>
                  <Table.Td>{fmt.dateTime(r.createdAt)}</Table.Td>
                  <Table.Td>{fmt.dateTime(r.backupAt)}</Table.Td>
                  <Table.Td>
                    <StatusBadge status={r.status === 'completed' ? 'success' : r.status === 'failed' ? 'failed' : 'inactive'} label={t(`restore.statuses.${r.status}`)} />
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" c="red" lineClamp={2}>
                      {r.error ?? ''}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </>
      )}

      <Modal opened={!!target} onClose={() => setTarget(null)} title={t('restore.preview')} size="lg">
        <Stack>
          <ErrorAlert error={preview.error ?? request.error} />
          {p && (
            <>
              <Text size="sm">
                {t('restore.backupFrom')}: <b>{fmt.dateTime(p.backupAt)}</b>
              </Text>
              {!p.compatible && <Alert color="red">{t('restore.incompatible')}</Alert>}
              {p.changesSince.length > 0 && (
                <>
                  <Text fw={600} size="sm">
                    {t('restore.changesSince')}
                  </Text>
                  <Group gap="xs">
                    {p.changesSince.map((c) => (
                      <Badge key={c.module} color="red" variant="light">
                        {c.module}: {c.count}
                      </Badge>
                    ))}
                  </Group>
                </>
              )}
              <List size="sm" spacing={4}>
                {p.warnings.map((w) => (
                  <List.Item key={w}>{t(`restore.warnings.${w}`, { defaultValue: w })}</List.Item>
                ))}
              </List>
              {p.secondApproverRequired && <Alert color="orange">{t('restore.secondApprover')}</Alert>}
              <TextInput
                label={t('restore.typePhrase', { phrase: p.confirmationPhrase })}
                value={form.confirmation}
                onChange={(e) => setForm({ ...form, confirmation: e.currentTarget.value })}
                dir="ltr"
              />
              <PasswordInput label={t('restore.password')} value={form.password} onChange={(e) => setForm({ ...form, password: e.currentTarget.value })} autoComplete="current-password" />
              <TextInput label={t('restore.code')} value={form.code} onChange={(e) => setForm({ ...form, code: e.currentTarget.value })} maxLength={6} dir="ltr" inputMode="numeric" />
              <Group justify="flex-end">
                <Button variant="default" onClick={() => setTarget(null)}>
                  {t('app.cancel')}
                </Button>
                <Button
                  color="red"
                  disabled={!p.compatible || form.confirmation.trim() !== p.confirmationPhrase || !form.password || form.code.length !== 6}
                  loading={request.isPending}
                  onClick={() => request.mutate()}
                >
                  {t('restore.submit')}
                </Button>
              </Group>
            </>
          )}
        </Stack>
      </Modal>

      <Modal opened={!!stepUp} onClose={() => setStepUp(null)} title={stepUp?.action === 'approve' ? t('restore.approve') : t('restore.confirmSwitch')}>
        <Stack>
          <ErrorAlert error={act.error} />
          <PasswordInput label={t('restore.password')} value={form.password} onChange={(e) => setForm({ ...form, password: e.currentTarget.value })} autoComplete="current-password" />
          <TextInput label={t('restore.code')} value={form.code} onChange={(e) => setForm({ ...form, code: e.currentTarget.value })} maxLength={6} dir="ltr" inputMode="numeric" />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setStepUp(null)}>
              {t('app.cancel')}
            </Button>
            <Button color="red" disabled={!form.password || form.code.length !== 6} loading={act.isPending} onClick={() => act.mutate()}>
              {t('app.confirm')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Paper>
  );
}
