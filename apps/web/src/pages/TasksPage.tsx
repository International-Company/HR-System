import { useState } from 'react';
import { Badge, Button, Card, Group, Modal, Paper, Select, Stack, Table, Tabs, Text, TextInput, Textarea, Timeline } from '@mantine/core';
import { IconCheck, IconX } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { DelegationDto, WorkflowInstanceDto } from '@hrms/shared';
import { get, post } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { EmptyRow, ErrorAlert, PageHeader, StatusBadge, notifyError, notifySaved } from '../components/common';

const statusColor: Record<string, string> = { pending: 'requested', approved: 'success', rejected: 'failed', cancelled: 'inactive', skipped: 'inactive' };

function SummaryLine({ summary }: { summary: Record<string, unknown> }) {
  const { t } = useTranslation();
  const { settings } = useAuth();
  const text = (v: unknown): string | null => {
    if (typeof v === 'string' || typeof v === 'number') return String(v);
    // Bilingual values such as a leave type name.
    if (v && typeof v === 'object' && 'ar' in v && 'en' in v) return String((v as Record<string, unknown>)[settings.language === 'ar' ? 'ar' : 'en']);
    return null;
  };
  const entries = Object.entries(summary)
    .map(([k, v]) => [k, text(v)] as const)
    .filter((e): e is readonly [string, string] => e[1] !== null);
  if (!entries.length) return null;
  return (
    <Text size="xs" c="dimmed">
      {entries.map(([k, v]) => `${t(`summary.${k}`, { defaultValue: k })}: ${v}`).join(' · ')}
    </Text>
  );
}

function InstanceCard({ inst, actions }: { inst: WorkflowInstanceDto; actions?: React.ReactNode }) {
  const { t } = useTranslation();
  const { settings, fmt } = useAuth();
  const ar = settings.language === 'ar';
  return (
    <Card withBorder padding="md">
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <Stack gap={2}>
          <Group gap="xs">
            <Text fw={600}>{ar ? inst.definitionNameAr : inst.definitionNameEn}</Text>
            <StatusBadge status={statusColor[inst.status] ?? 'inactive'} label={t(`tasks.statuses.${inst.status}`)} />
          </Group>
          <Text size="sm">
            {t('tasks.requester')}: {inst.requesterName}
            {inst.subjectEmployeeName && (
              <>
                {' · '}
                {t('tasks.employee')}:{' '}
                {inst.subjectEmployeeId ? (
                  <Link to={`/employees/${inst.subjectEmployeeId}`}>{ar ? inst.subjectEmployeeName.ar : inst.subjectEmployeeName.en}</Link>
                ) : null}
              </>
            )}
          </Text>
          <SummaryLine summary={inst.summary} />
          <Text size="xs" c="dimmed">
            {t('tasks.submitted')}: {fmt.dateTime(inst.createdAt)}
          </Text>
        </Stack>
        {actions}
      </Group>
      <Timeline mt="sm" bulletSize={12} lineWidth={2} active={inst.tasks.filter((x) => x.status !== 'pending').length - 1}>
        {inst.tasks.map((task) => (
          <Timeline.Item
            key={task.id}
            title={
              <Group gap={6}>
                <Text size="sm">{ar ? task.stepNameAr : task.stepNameEn}</Text>
                <Badge size="xs" variant="light" color={task.status === 'approved' ? 'green' : task.status === 'rejected' ? 'red' : 'gray'}>
                  {t(`tasks.statuses.${task.status}`)}
                </Badge>
              </Group>
            }
          >
            <Text size="xs" c="dimmed">
              {task.assigneeName ?? t('tasks.noApprover')}
              {task.delegatedFromUserId ? ` (${t('tasks.delegatedFrom')})` : ''}
              {task.decidedAt ? ` · ${fmt.dateTime(task.decidedAt)}` : ''}
            </Text>
            {task.comment && <Text size="xs">{task.comment}</Text>}
          </Timeline.Item>
        ))}
      </Timeline>
    </Card>
  );
}

export function TasksPage() {
  const { t } = useTranslation();
  const { can, session } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<string | null>(new URLSearchParams(location.search).get('tab') ?? 'pending');
  const pending = useQuery({ queryKey: ['tasks', 'pending'], queryFn: () => get<WorkflowInstanceDto[]>('/workflow/tasks'), enabled: tab === 'pending' });
  const decided = useQuery({ queryKey: ['tasks', 'decided'], queryFn: () => get<WorkflowInstanceDto[]>('/workflow/tasks?status=decided'), enabled: tab === 'decided' });
  const mine = useQuery({ queryKey: ['tasks', 'mine'], queryFn: () => get<WorkflowInstanceDto[]>('/workflow/requests/mine'), enabled: tab === 'mine' });
  const company = useQuery({
    queryKey: ['tasks', 'company'],
    queryFn: () => get<WorkflowInstanceDto[]>('/workflow/instances'),
    enabled: tab === 'company' && can('workflow.instances.view'),
  });
  const [decision, setDecision] = useState<{ taskId: string; kind: 'approve' | 'reject'; comment: string } | null>(null);

  const decide = useMutation({
    mutationFn: () => post(`/workflow/tasks/${decision!.taskId}/decision`, { decision: decision!.kind, comment: decision!.comment || undefined }),
    onSuccess: async () => {
      setDecision(null);
      await qc.invalidateQueries({ queryKey: ['tasks'] });
      await qc.invalidateQueries({ queryKey: ['notifications'] });
      notifySaved(t);
    },
  });
  const cancel = async (id: string) => {
    try {
      await post(`/workflow/instances/${id}/cancel`);
      await qc.invalidateQueries({ queryKey: ['tasks'] });
      notifySaved(t);
    } catch (err) {
      notifyError(t, err);
    }
  };

  const list = (q: { data?: WorkflowInstanceDto[]; error: unknown }, render: (i: WorkflowInstanceDto) => React.ReactNode) => (
    <Stack>
      <ErrorAlert error={q.error} />
      {q.data?.length === 0 && (
        <Text c="dimmed" size="sm">
          {t('tasks.nothing')}
        </Text>
      )}
      {q.data?.map(render)}
    </Stack>
  );

  return (
    <>
      <PageHeader title={t('tasks.title')} />
      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List mb="md" style={{ flexWrap: 'wrap' }}>
          <Tabs.Tab value="pending">{t('tasks.pending')}</Tabs.Tab>
          <Tabs.Tab value="decided">{t('tasks.decided')}</Tabs.Tab>
          <Tabs.Tab value="mine">{t('tasks.mine')}</Tabs.Tab>
          {can('workflow.instances.view') && <Tabs.Tab value="company">{t('tasks.company')}</Tabs.Tab>}
          <Tabs.Tab value="delegations">{t('tasks.delegations')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="pending">
          {list(pending, (inst) => {
            const myTask = inst.tasks.find((x) => x.status === 'pending' && x.assigneeUserId === session?.user.id);
            return (
              <InstanceCard
                key={inst.id}
                inst={inst}
                actions={
                  myTask && (
                    <Group gap="xs">
                      <Button size="xs" color="green" leftSection={<IconCheck size={14} />} onClick={() => setDecision({ taskId: myTask.id, kind: 'approve', comment: '' })}>
                        {t('tasks.approve')}
                      </Button>
                      <Button size="xs" color="red" variant="light" leftSection={<IconX size={14} />} onClick={() => setDecision({ taskId: myTask.id, kind: 'reject', comment: '' })}>
                        {t('tasks.reject')}
                      </Button>
                    </Group>
                  )
                }
              />
            );
          })}
        </Tabs.Panel>
        <Tabs.Panel value="decided">{list(decided, (inst) => <InstanceCard key={inst.id} inst={inst} />)}</Tabs.Panel>
        <Tabs.Panel value="mine">
          {list(mine, (inst) => (
            <InstanceCard
              key={inst.id}
              inst={inst}
              actions={
                inst.status === 'pending' && (
                  <Button size="xs" variant="subtle" color="red" onClick={() => void cancel(inst.id)}>
                    {t('tasks.cancelRequest')}
                  </Button>
                )
              }
            />
          ))}
        </Tabs.Panel>
        <Tabs.Panel value="company">{list(company, (inst) => <InstanceCard key={inst.id} inst={inst} />)}</Tabs.Panel>
        <Tabs.Panel value="delegations">
          <Delegations />
        </Tabs.Panel>
      </Tabs>

      <Modal opened={!!decision} onClose={() => setDecision(null)} title={decision?.kind === 'approve' ? t('tasks.approve') : t('tasks.reject')}>
        {decision && (
          <Stack>
            <ErrorAlert error={decide.error} />
            <Textarea
              label={decision.kind === 'reject' ? t('tasks.rejectReason') : t('tasks.comment')}
              value={decision.comment}
              onChange={(e) => setDecision({ ...decision, comment: e.currentTarget.value })}
              autosize
              minRows={2}
              required={decision.kind === 'reject'}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setDecision(null)}>
                {t('app.cancel')}
              </Button>
              <Button
                color={decision.kind === 'approve' ? 'green' : 'red'}
                disabled={decision.kind === 'reject' && !decision.comment.trim()}
                loading={decide.isPending}
                onClick={() => decide.mutate()}
              >
                {t('app.confirm')}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}

function Delegations() {
  const { t } = useTranslation();
  const { fmt } = useAuth();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['delegations'], queryFn: () => get<DelegationDto[]>('/workflow/delegations') });
  const users = useQuery({ queryKey: ['delegates'], queryFn: () => get<{ id: string; displayName: string }[]>('/workflow/delegates') });
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({ toUserId: '' as string | null, validFrom: today, validTo: today });
  const create = useMutation({
    mutationFn: () => post('/workflow/delegations', form),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['delegations'] });
      notifySaved(t);
    },
  });
  const revoke = async (id: string) => {
    try {
      await post(`/workflow/delegations/${id}/revoke`);
      await qc.invalidateQueries({ queryKey: ['delegations'] });
    } catch (err) {
      notifyError(t, err);
    }
  };
  return (
    <Stack maw={720}>
      <Paper p="md">
        <Text size="sm" c="dimmed" mb="sm">
          {t('tasks.delegationHint')}
        </Text>
        <ErrorAlert error={create.error} />
        <Group align="flex-end" wrap="wrap">
          <Select
            w={260}
            label={t('tasks.delegateTo')}
            searchable
            data={(users.data ?? []).map((u) => ({ value: u.id, label: u.displayName }))}
            value={form.toUserId}
            onChange={(v) => setForm({ ...form, toUserId: v })}
          />
          <TextInput type="date" label={t('tasks.from')} value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.currentTarget.value })} />
          <TextInput type="date" label={t('tasks.to')} value={form.validTo} onChange={(e) => setForm({ ...form, validTo: e.currentTarget.value })} />
          <Button disabled={!form.toUserId} loading={create.isPending} onClick={() => create.mutate()}>
            {t('tasks.newDelegation')}
          </Button>
        </Group>
      </Paper>
      <Paper>
        <Table>
          <Table.Tbody>
            {list.data?.length === 0 && <EmptyRow colSpan={3} />}
            {list.data?.map((d) => (
              <Table.Tr key={d.id} opacity={d.revokedAt ? 0.5 : 1}>
                <Table.Td>{d.toUserName}</Table.Td>
                <Table.Td>
                  {fmt.date(d.validFrom)} – {fmt.date(d.validTo)}
                </Table.Td>
                <Table.Td>
                  {!d.revokedAt && (
                    <Button size="xs" variant="subtle" color="red" onClick={() => void revoke(d.id)}>
                      {t('tasks.revoke')}
                    </Button>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Paper>
    </Stack>
  );
}
