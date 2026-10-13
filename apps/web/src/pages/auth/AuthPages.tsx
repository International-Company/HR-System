import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  Anchor,
  Box,
  Button,
  Center,
  Code,
  CopyButton,
  Group,
  List,
  Paper,
  PasswordInput,
  PinInput,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconShieldLock, IconUsersGroup } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { post } from '../../lib/api';
import { useAuth } from '../../auth/AuthContext';
import { ErrorAlert } from '../../components/common';

function AuthCard({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  const { t } = useTranslation();
  const { settings } = useAuth();
  const groupName = settings.groupName ? (settings.language === 'ar' ? settings.groupName.ar : settings.groupName.en) : null;
  return (
    <Center mih="100vh" p="md" bg="var(--mantine-color-gray-0)">
      <Paper w="100%" maw={420} p="xl" shadow="sm">
        <Stack gap="lg">
          <Group gap="sm">
            <IconUsersGroup size={32} color="var(--mantine-color-brand-6)" />
            <Stack gap={0}>
              <Text fw={600}>{t('app.title')}</Text>
              {groupName && (
                <Text size="sm" c="dimmed">
                  {groupName}
                </Text>
              )}
            </Stack>
          </Group>
          <Stack gap={4}>
            <Title order={1} size="h3">
              {title}
            </Title>
            {subtitle && (
              <Text size="sm" c="dimmed">
                {subtitle}
              </Text>
            )}
          </Stack>
          {children}
        </Stack>
      </Paper>
    </Center>
  );
}

export function LoginPage() {
  const { t } = useTranslation();
  const { refresh } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/login', { username, password });
      await refresh();
    } catch (err) {
      setError(err);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t('auth.title')}>
      <form onSubmit={submit}>
        <Stack>
          <ErrorAlert error={error} />
          <TextInput
            label={t('auth.username')}
            value={username}
            onChange={(e) => setUsername(e.currentTarget.value)}
            autoComplete="username"
            required
            autoFocus
            dir="ltr"
          />
          <PasswordInput
            label={t('auth.password')}
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            autoComplete="current-password"
            required
          />
          <Button type="submit" loading={busy} fullWidth>
            {t('auth.signIn')}
          </Button>
        </Stack>
      </form>
    </AuthCard>
  );
}

export function MfaVerifyPage() {
  const { t } = useTranslation();
  const { refresh, logout } = useAuth();
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (value = code) => {
    setBusy(true);
    setError(null);
    try {
      await post('/auth/mfa/verify', recovery ? { recoveryCode: value } : { code: value });
      await refresh();
    } catch (err) {
      setError(err);
      setCode('');
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t('auth.mfaTitle')} subtitle={recovery ? undefined : t('auth.mfaPrompt')}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Stack>
          <ErrorAlert error={error} />
          {recovery ? (
            <TextInput
              label={t('auth.recoveryCode')}
              description={t('auth.recoveryHint')}
              placeholder="XXXXX-XXXXX"
              value={code}
              onChange={(e) => setCode(e.currentTarget.value.toUpperCase())}
              dir="ltr"
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              autoFocus
              styles={{ input: { fontFamily: 'ui-monospace, Consolas, monospace', letterSpacing: '0.08em' } }}
            />
          ) : (
            <Center dir="ltr">
              <PinInput
                length={6}
                type="number"
                oneTimeCode
                value={code}
                onChange={setCode}
                onComplete={(v) => void submit(v)}
                autoFocus
                aria-label={t('auth.mfaPrompt')}
              />
            </Center>
          )}
          <Button type="submit" loading={busy} fullWidth disabled={!code}>
            {t('auth.verify')}
          </Button>
          <Group justify="space-between">
            <Anchor component="button" type="button" size="sm" onClick={() => { setRecovery(!recovery); setCode(''); }}>
              {recovery ? t('auth.useCode') : t('auth.useRecovery')}
            </Anchor>
            <Anchor component="button" type="button" size="sm" c="dimmed" onClick={() => void logout()}>
              {t('nav.logout')}
            </Anchor>
          </Group>
        </Stack>
      </form>
    </AuthCard>
  );
}

export function ChangePasswordForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const mismatch = repeat.length > 0 && next !== repeat;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== repeat) return;
    setBusy(true);
    setError(null);
    try {
      await post('/auth/password/change', { currentPassword: current, newPassword: next });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <Stack>
        <ErrorAlert error={error} />
        <PasswordInput label={t('auth.currentPassword')} value={current} onChange={(e) => setCurrent(e.currentTarget.value)} autoComplete="current-password" required />
        <PasswordInput
          label={t('auth.newPassword')}
          description={t('auth.passwordHint', { min: 12 })}
          value={next}
          onChange={(e) => setNext(e.currentTarget.value)}
          autoComplete="new-password"
          required
        />
        <PasswordInput
          label={t('auth.confirmPassword')}
          value={repeat}
          onChange={(e) => setRepeat(e.currentTarget.value)}
          error={mismatch ? t('auth.mismatch') : undefined}
          autoComplete="new-password"
          required
        />
        <Button type="submit" loading={busy} disabled={mismatch || !next}>
          {t('app.save')}
        </Button>
      </Stack>
    </form>
  );
}

export function ChangePasswordPage() {
  const { t } = useTranslation();
  const { refresh, logout } = useAuth();
  return (
    <AuthCard title={t('auth.changeTitle')} subtitle={t('auth.changeRequired')}>
      <ChangePasswordForm onDone={() => void refresh()} />
      <Anchor component="button" type="button" size="sm" c="dimmed" onClick={() => void logout()}>
        {t('nav.logout')}
      </Anchor>
    </AuthCard>
  );
}

/** TOTP enrolment: QR code → confirm code → show recovery codes once. */
export function MfaSetupFlow({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [secret, setSecret] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    post<{ secret: string; otpauthUrl: string }>('/auth/mfa/totp/setup')
      .then(async (s) => {
        setSecret(s);
        setQr(await QRCode.toDataURL(s.otpauthUrl, { margin: 1, width: 200 }));
      })
      .catch(setError);
  }, []);

  const confirm = async (value = code) => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ recoveryCodes: string[] }>('/auth/mfa/totp/confirm', { code: value });
      setCodes(r.recoveryCodes);
    } catch (err) {
      setError(err);
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  if (codes) {
    return (
      <Stack>
        <Title order={3} size="h4">
          {t('auth.recoveryTitle')}
        </Title>
        <Text size="sm">{t('auth.recoveryHelp')}</Text>
        <SimpleGrid cols={2} dir="ltr">
          {codes.map((c) => (
            <Code key={c} fz="md" ta="center">
              {c}
            </Code>
          ))}
        </SimpleGrid>
        <CopyButton value={codes.join('\n')}>
          {({ copied, copy }) => (
            <Button variant="light" onClick={copy}>
              {copied ? t('auth.recoveryCopied') : t('auth.recoveryCopy')}
            </Button>
          )}
        </CopyButton>
        <Button onClick={onDone}>{t('auth.recoverySaved')}</Button>
      </Stack>
    );
  }

  return (
    <Stack>
      <ErrorAlert error={error} />
      <List size="sm" spacing="xs" listStyleType="none">
        <List.Item>{t('auth.setupStep1')}</List.Item>
      </List>
      <Center>{qr ? <img src={qr} alt="QR" width={200} height={200} /> : <Box h={200} />}</Center>
      {secret && (
        <Stack gap={2}>
          <Text size="xs" c="dimmed">
            {t('auth.manualKey')}
          </Text>
          <Code dir="ltr" style={{ wordBreak: 'break-all' }}>
            {secret.secret}
          </Code>
        </Stack>
      )}
      <Text size="sm">{t('auth.setupStep2')}</Text>
      <Center dir="ltr">
        <PinInput aria-label={t('auth.setupStep2')} length={6} type="number" oneTimeCode value={code} onChange={setCode} onComplete={(v) => void confirm(v)} />
      </Center>
      <Button loading={busy} disabled={code.length !== 6} onClick={() => void confirm()}>
        {t('auth.verify')}
      </Button>
    </Stack>
  );
}

export function MfaSetupPage() {
  const { t } = useTranslation();
  const { refresh, logout } = useAuth();
  return (
    <AuthCard title={t('auth.setupTitle')} subtitle={t('auth.setupRequired')}>
      <Group gap="xs" c="brand.7">
        <IconShieldLock size={18} />
      </Group>
      <MfaSetupFlow onDone={() => void refresh()} />
      <Anchor component="button" type="button" size="sm" c="dimmed" onClick={() => void logout()}>
        {t('nav.logout')}
      </Anchor>
    </AuthCard>
  );
}
