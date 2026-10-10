import { Alert, Anchor, Card, Group, SimpleGrid, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconBuildingSkyscraper, IconDatabase, IconShieldCheck, IconShieldExclamation, IconUsers } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { BackupRunDto, CompanyDto, UserDto } from '@hrms/shared';
import type { ReactNode } from 'react';
import { get } from '../lib/api';
import { useAuth } from '../auth/AuthContext';

function Stat({ icon, label, value, to }: { icon: ReactNode; label: string; value: ReactNode; to?: string }) {
  const body = (
    <Card padding="lg" withBorder>
      <Group wrap="nowrap">
        <ThemeIcon size={44} radius="md" variant="light">
          {icon}
        </ThemeIcon>
        <Stack gap={0}>
          <Text size="sm" c="dimmed">
            {label}
          </Text>
          <Text fw={600} size="lg">
            {value}
          </Text>
        </Stack>
      </Group>
    </Card>
  );
  return to ? (
    <Anchor component={Link} to={to} underline="never" c="inherit">
      {body}
    </Anchor>
  ) : (
    body
  );
}

/** Simple, role-aware home (DASH-01): only widgets the user may see. */
export function DashboardPage() {
  const { t } = useTranslation();
  const { session, can, fmt } = useAuth();
  const companies = useQuery({ queryKey: ['companies'], queryFn: () => get<CompanyDto[]>('/companies'), enabled: can('org.company.view') });
  const users = useQuery({ queryKey: ['users', ''], queryFn: () => get<UserDto[]>('/users'), enabled: can('identity.user.view') });
  const backups = useQuery({
    queryKey: ['backups'],
    queryFn: () => get<{ lastBackup: BackupRunDto | null; lastRestoreTest: BackupRunDto | null }>('/backups'),
    enabled: can('system.backup.view'),
  });

  return (
    <Stack gap="lg">
      <Stack gap={4}>
        <Title order={2} size="h3">
          {t('home.welcome', { name: session?.user.displayName })}
        </Title>
        <Text c="dimmed" size="sm">
          {t('home.intro')}
        </Text>
      </Stack>

      {!session?.user.mfaEnabled && (
        <Alert color="yellow" variant="light" icon={<IconShieldExclamation size={18} />}>
          {t('home.mfaOff')}{' '}
          <Anchor component={Link} to="/account" size="sm">
            {t('home.enableMfa')}
          </Anchor>
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
        {can('org.company.view') && (
          <Stat icon={<IconBuildingSkyscraper size={22} />} label={t('home.companies')} value={fmt.number(companies.data?.length)} to="/companies" />
        )}
        {can('identity.user.view') && (
          <Stat icon={<IconUsers size={22} />} label={t('home.users')} value={fmt.number(users.data?.length)} to="/users" />
        )}
        {can('system.backup.view') && (
          <>
            <Stat
              icon={<IconDatabase size={22} />}
              label={t('home.lastBackup')}
              value={backups.data?.lastBackup ? fmt.dateTime(backups.data.lastBackup.finishedAt) : t('home.never')}
              to="/backups"
            />
            <Stat
              icon={<IconShieldCheck size={22} />}
              label={t('home.lastRestoreTest')}
              value={
                backups.data?.lastRestoreTest
                  ? `${fmt.date(backups.data.lastRestoreTest.finishedAt)} · ${t(`backups.states.${backups.data.lastRestoreTest.status}`)}`
                  : t('home.never')
              }
              to="/backups"
            />
          </>
        )}
      </SimpleGrid>
    </Stack>
  );
}
