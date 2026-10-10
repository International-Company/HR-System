import { useState } from 'react';
import { Badge, Button, Group, Modal, Paper, PasswordInput, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { IconShieldCheck, IconShieldOff } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { SessionDto } from '@hrms/shared';
import { del, get, post } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { ErrorAlert, PageHeader, notifyError, notifySaved } from '../components/common';
import { ChangePasswordForm, MfaSetupFlow } from './auth/AuthPages';
import { SessionTable } from './UsersPages';

export function AccountPage() {
  const { t } = useTranslation();
  const { session, refresh } = useAuth();
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ['my-sessions'], queryFn: () => get<SessionDto[]>('/auth/sessions') });
  const [setupOpen, setSetupOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [disable, setDisable] = useState({ password: '', code: '' });
  const [disableError, setDisableError] = useState<unknown>(null);

  const revoke = async (id: string) => {
    try {
      await del(`/auth/sessions/${id}`);
      await qc.invalidateQueries({ queryKey: ['my-sessions'] });
      notifySaved(t);
    } catch (err) {
      notifyError(t, err);
    }
  };

  return (
    <>
      <PageHeader title={t('account.title')} subtitle={`${session?.user.displayName} · ${session?.user.username}`} />
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        <Paper p="lg">
          <Title order={3} size="h5" mb="md">
            {t('auth.changeTitle')}
          </Title>
          <ChangePasswordForm onDone={() => notifySaved(t, t('auth.changed'))} />
        </Paper>
        <Paper p="lg">
          <Stack>
            <Title order={3} size="h5">
              {t('account.security')}
            </Title>
            <Group>
              {session?.user.mfaEnabled ? (
                <Badge color="green" variant="light" leftSection={<IconShieldCheck size={14} />}>
                  {t('account.mfaOn')}
                </Badge>
              ) : (
                <Badge color="yellow" variant="light" leftSection={<IconShieldOff size={14} />}>
                  {t('account.mfaOffState')}
                </Badge>
              )}
            </Group>
            <Group>
              {session?.user.mfaEnabled ? (
                <Button variant="light" color="red" onClick={() => setDisableOpen(true)}>
                  {t('account.disableMfa')}
                </Button>
              ) : (
                <Button onClick={() => setSetupOpen(true)}>{t('account.setup')}</Button>
              )}
            </Group>
          </Stack>
        </Paper>
      </SimpleGrid>

      <Paper p="lg" mt="lg">
        <Title order={3} size="h5" mb="md">
          {t('account.sessions')}
        </Title>
        <SessionTable sessions={sessions.data ?? []} onRevoke={(id) => void revoke(id)} />
      </Paper>

      <Modal opened={setupOpen} onClose={() => setSetupOpen(false)} title={t('auth.setupTitle')}>
        {setupOpen && (
          <MfaSetupFlow
            onDone={() => {
              setSetupOpen(false);
              void refresh();
            }}
          />
        )}
      </Modal>

      <Modal opened={disableOpen} onClose={() => setDisableOpen(false)} title={t('account.disableMfa')}>
        <Stack>
          <ErrorAlert error={disableError} />
          <PasswordInput label={t('auth.currentPassword')} value={disable.password} onChange={(e) => setDisable({ ...disable, password: e.currentTarget.value })} />
          <TextInput label={t('auth.mfaPrompt')} value={disable.code} onChange={(e) => setDisable({ ...disable, code: e.currentTarget.value })} dir="ltr" maxLength={6} />
          <Text size="xs" c="dimmed">
            {t('errors.MFA_REQUIRED_BY_POLICY')}
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDisableOpen(false)}>
              {t('app.cancel')}
            </Button>
            <Button
              color="red"
              onClick={async () => {
                try {
                  await post('/auth/mfa/totp/disable', disable);
                  setDisableOpen(false);
                  await refresh();
                  notifySaved(t);
                } catch (err) {
                  setDisableError(err);
                }
              }}
            >
              {t('app.confirm')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
