import { Anchor, Badge, Card, Group, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { WidgetDto } from '@hrms/shared';
import { get } from '../lib/api';
import { useAuth } from '../auth/AuthContext';

type Named = { nameAr: string; nameEn: string };

const LINKS: Partial<Record<WidgetDto['widget'], string>> = {
  my_attendance: '/attendance',
  my_leave: '/leave',
  my_tasks: '/tasks',
  headcount: '/employees',
  attendance_today: '/attendance/review',
  on_leave_today: '/leave/manage',
  pending_approvals: '/tasks',
  contracts_expiring: '/contracts',
  open_vacancies: '/recruitment',
  payroll_status: '/payroll',
  system_health: '/backups',
};

/** Role dashboards (DASH-01): the server decides which widgets and data the user gets. */
export function DashboardWidgets() {
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => get<WidgetDto[]>('/dashboard'), refetchInterval: 120_000 });
  if (!q.data?.length) return null;
  return (
    <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
      {q.data.map((w) => (
        <Card key={w.widget} withBorder padding="lg" style={w.size === 'large' ? { gridColumn: 'span 2' } : undefined}>
          <Widget w={w} />
        </Card>
      ))}
    </SimpleGrid>
  );
}

function Widget({ w }: { w: WidgetDto }) {
  const { t } = useTranslation();
  const { settings, fmt } = useAuth();
  const ar = settings.language === 'ar';
  const name = (x: Named) => (ar ? x.nameAr : x.nameEn);
  const d = w.data as Record<string, unknown>;
  const title = (
    <Group justify="space-between" mb="xs">
      <Title order={3} size="h6">
        {t(`widgets.${w.widget}`)}
      </Title>
      {LINKS[w.widget] && (
        <Anchor component={Link} to={LINKS[w.widget]!} size="xs">
          →
        </Anchor>
      )}
    </Group>
  );
  const big = (v: unknown) => (
    <Text size="xl" fw={700}>
      {fmt.number(Number(v ?? 0))}
    </Text>
  );
  switch (w.widget) {
    case 'my_attendance':
      return (
        <>
          {title}
          <Text>{d.status ? t(`att.statuses.${String(d.status)}`) : t('widgets.notIn')}</Text>
          {d.firstIn ? <Text size="sm" c="dimmed">{fmt.time(String(d.firstIn))}</Text> : null}
        </>
      );
    case 'my_leave':
      return (
        <>
          {title}
          {(d.balances as (Named & { available: number })[]).map((b) => (
            <Group key={b.nameEn} justify="space-between">
              <Text size="sm">{name(b)}</Text>
              <Text fw={600}>{fmt.number(b.available)}</Text>
            </Group>
          ))}
        </>
      );
    case 'my_tasks':
      return (
        <>
          {title}
          {big(d.pending)}
        </>
      );
    case 'pending_approvals':
      return (
        <>
          {title}
          {big(d.total)}
          {(d.byType as (Named & { count: number })[]).map((x) => (
            <Text key={x.nameEn} size="xs" c="dimmed">
              {name(x)}: {x.count}
            </Text>
          ))}
        </>
      );
    case 'headcount':
      return (
        <>
          {title}
          {(d.companies as (Named & { count: number })[]).map((c) => (
            <Group key={c.nameEn} justify="space-between">
              <Text size="sm">{name(c)}</Text>
              <Text fw={600}>{fmt.number(c.count)}</Text>
            </Group>
          ))}
        </>
      );
    case 'attendance_today':
      return (
        <>
          {title}
          {(d.companies as (Named & { present: number; late: number; absent: number })[]).map((c) => (
            <Group key={c.nameEn} justify="space-between" wrap="nowrap">
              <Text size="sm">{name(c)}</Text>
              <Group gap={4}>
                <Badge color="green" variant="light">
                  {t('widgets.present')} {c.present}
                </Badge>
                <Badge color="orange" variant="light">
                  {t('widgets.late')} {c.late}
                </Badge>
                <Badge color="red" variant="light">
                  {t('widgets.absent')} {c.absent}
                </Badge>
              </Group>
            </Group>
          ))}
        </>
      );
    case 'on_leave_today':
      return (
        <>
          {title}
          {big(d.count)}
          {(d.people as (Named & { until: string })[]).map((p, i) => (
            <Text key={i} size="xs" c="dimmed">
              {name(p)} · {t('widgets.until', { date: fmt.date(p.until) })}
            </Text>
          ))}
        </>
      );
    case 'contracts_expiring':
      return (
        <>
          {title}
          {(d.contracts as (Named & { id: string; no: string; endDate: string })[]).length === 0 && <Text c="dimmed">{t('widgets.none')}</Text>}
          <Table>
            <Table.Tbody>
              {(d.contracts as (Named & { id: string; no: string; endDate: string })[]).map((c) => (
                <Table.Tr key={c.id}>
                  <Table.Td>
                    <Anchor component={Link} to={`/contracts/${c.id}`} size="sm">
                      {c.no}
                    </Anchor>
                  </Table.Td>
                  <Table.Td>{name(c)}</Table.Td>
                  <Table.Td>{fmt.date(c.endDate)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </>
      );
    case 'open_vacancies':
      return (
        <>
          {title}
          {big(d.count)}
          {(d.vacancies as { id: string; title: string; openings: number }[]).map((v) => (
            <Text key={v.id} size="xs" c="dimmed">
              {v.title} ({v.openings})
            </Text>
          ))}
        </>
      );
    case 'payroll_status':
      return (
        <>
          {title}
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th />
                <Table.Th>{t('widgets.current')}</Table.Th>
                <Table.Th>{t('widgets.previous')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {(d.companies as (Named & { current: string | null; previous: string | null })[]).map((c) => (
                <Table.Tr key={c.nameEn}>
                  <Table.Td>{name(c)}</Table.Td>
                  <Table.Td>{c.current ? t(`pay.statuses.${c.current}`) : '—'}</Table.Td>
                  <Table.Td>{c.previous ? t(`pay.statuses.${c.previous}`) : '—'}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </>
      );
    case 'system_health': {
      const last = d.lastBackup as { at: string; status: string } | null;
      const test = d.lastRestoreTest as { at: string; status: string } | null;
      return (
        <>
          {title}
          <Stack gap={4}>
            {!d.configured && (
              <Text c="orange" size="sm">
                {t('widgets.notConfigured')}
              </Text>
            )}
            <Text size="sm">
              {t('widgets.lastBackup')}: {last ? fmt.dateTime(last.at) : '—'}
            </Text>
            <Text size="sm">
              {t('widgets.lastRestoreTest')}: {test ? `${fmt.dateTime(test.at)} · ${test.status}` : '—'}
            </Text>
          </Stack>
        </>
      );
    }
  }
}
