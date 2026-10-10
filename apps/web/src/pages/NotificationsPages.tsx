import { useState } from 'react';
import { ActionIcon, Badge, Button, Divider, Group, Indicator, Paper, Popover, ScrollArea, SegmentedControl, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconBell } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { NotificationDto } from '@hrms/shared';
import { get, post } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { ErrorAlert, PageHeader } from '../components/common';

function useNotificationActions() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const read = useMutation({
    mutationFn: (body: { ids?: string[]; all?: boolean }) => post('/notifications/read', body),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
  // Opening a notification only navigates inside the app; the target page re-checks access.
  const open = (n: NotificationDto) => {
    if (!n.readAt) read.mutate({ ids: [n.id] });
    if (n.link?.startsWith('/')) navigate(n.link);
  };
  return { read, open };
}

function NotificationItem({ n, onOpen }: { n: NotificationDto; onOpen: (n: NotificationDto) => void }) {
  const { settings, fmt } = useAuth();
  return (
    <UnstyledButton onClick={() => onOpen(n)} p="sm" style={{ borderRadius: 8, width: '100%' }} bg={n.readAt ? undefined : 'var(--mantine-color-brand-0)'}>
      <Stack gap={2}>
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Text size="sm" fw={n.readAt ? 400 : 600} lineClamp={2}>
            {settings.language === 'ar' ? n.title.ar : n.title.en}
          </Text>
          {!n.readAt && <Badge size="xs" circle color="brand"> </Badge>}
        </Group>
        {(settings.language === 'ar' ? n.body.ar : n.body.en) && (
          <Text size="xs" c="dimmed" lineClamp={2}>
            {settings.language === 'ar' ? n.body.ar : n.body.en}
          </Text>
        )}
        <Text size="xs" c="dimmed">
          {fmt.dateTime(n.createdAt)}
        </Text>
      </Stack>
    </UnstyledButton>
  );
}

/** Header bell with unread count (polled every minute) and the latest items. */
export function NotificationBell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [opened, setOpened] = useState(false);
  const count = useQuery({
    queryKey: ['notifications', 'count'],
    queryFn: () => get<{ count: number }>('/notifications/unread-count'),
    refetchInterval: 60_000,
  });
  const latest = useQuery({
    queryKey: ['notifications', 'latest'],
    queryFn: () => get<NotificationDto[]>('/notifications'),
    enabled: opened,
  });
  const { read, open } = useNotificationActions();
  const unread = count.data?.count ?? 0;

  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-end" width={340} shadow="md" withArrow>
      <Popover.Target>
        <Indicator label={unread > 99 ? '99+' : unread} size={16} disabled={!unread} color="red" offset={4}>
          <ActionIcon variant="subtle" size="lg" onClick={() => setOpened((o) => !o)} aria-label={t('notif.title')}>
            <IconBell size={20} />
          </ActionIcon>
        </Indicator>
      </Popover.Target>
      <Popover.Dropdown p={0}>
        <Group justify="space-between" p="sm">
          <Text fw={600} size="sm">
            {t('notif.title')}
          </Text>
          {unread > 0 && (
            <Button size="compact-xs" variant="subtle" onClick={() => read.mutate({ all: true })}>
              {t('notif.markAll')}
            </Button>
          )}
        </Group>
        <Divider />
        <ScrollArea.Autosize mah={360}>
          {latest.data?.length === 0 && (
            <Text size="sm" c="dimmed" p="md" ta="center">
              {t('notif.empty')}
            </Text>
          )}
          {latest.data?.slice(0, 8).map((n) => (
            <NotificationItem
              key={n.id}
              n={n}
              onOpen={(x) => {
                setOpened(false);
                open(x);
              }}
            />
          ))}
        </ScrollArea.Autosize>
        <Divider />
        <Button
          variant="subtle"
          fullWidth
          radius={0}
          onClick={() => {
            setOpened(false);
            navigate('/notifications');
          }}
        >
          {t('notif.viewAll')}
        </Button>
      </Popover.Dropdown>
    </Popover>
  );
}

export function NotificationsPage() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('all');
  const list = useQuery({
    queryKey: ['notifications', 'page', filter],
    queryFn: () => get<NotificationDto[]>(`/notifications${filter === 'unread' ? '?unread=true' : ''}`),
  });
  const { read, open } = useNotificationActions();
  return (
    <>
      <PageHeader
        title={t('notif.title')}
        actions={
          <Button variant="light" onClick={() => read.mutate({ all: true })}>
            {t('notif.markAll')}
          </Button>
        }
      />
      <SegmentedControl
        mb="md"
        value={filter}
        onChange={setFilter}
        data={[
          { value: 'all', label: t('notif.all') },
          { value: 'unread', label: t('notif.unread') },
        ]}
      />
      <ErrorAlert error={list.error} />
      <Paper p="xs" maw={720}>
        {list.data?.length === 0 && (
          <Text c="dimmed" ta="center" p="lg" size="sm">
            {t('notif.empty')}
          </Text>
        )}
        <Stack gap={4}>
          {list.data?.map((n) => <NotificationItem key={n.id} n={n} onOpen={open} />)}
        </Stack>
      </Paper>
    </>
  );
}
