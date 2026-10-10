import { useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Modal,
  Paper,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core';
import { IconPlus, IconSearch } from '@tabler/icons-react';
import { useDebouncedValue } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { AssignmentDto, CompanyDto, DepartmentDto, RoleDto, ScopeType, SessionDto, UserDto } from '@hrms/shared';
import { del, get, patch, post } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { EmptyRow, ErrorAlert, PageHeader, StatusBadge, fieldErrors, localName, notifyError, notifySaved } from '../components/common';

export function UsersPage() {
  const { t } = useTranslation();
  const { can, fmt } = useAuth();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [debounced] = useDebouncedValue(q, 300);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ username: '', displayName: '', email: '', temporaryPassword: '' });
  const users = useQuery({
    queryKey: ['users', debounced],
    queryFn: () => get<UserDto[]>(`/users${debounced ? `?q=${encodeURIComponent(debounced)}` : ''}`),
  });
  const create = useMutation({
    mutationFn: () =>
      post<UserDto>('/users', {
        username: form.username,
        displayName: form.displayName,
        temporaryPassword: form.temporaryPassword,
        ...(form.email ? { email: form.email } : {}),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['users'] });
      setOpen(false);
      setForm({ username: '', displayName: '', email: '', temporaryPassword: '' });
      notifySaved(t);
    },
  });
  const errs = fieldErrors(create.error);

  return (
    <>
      <PageHeader
        title={t('users.title')}
        actions={
          can('identity.user.create') && (
            <Button leftSection={<IconPlus size={16} />} onClick={() => setOpen(true)}>
              {t('users.newUser')}
            </Button>
          )
        }
      />
      <TextInput
        mb="md"
        maw={360}
        leftSection={<IconSearch size={16} />}
        placeholder={t('app.search')}
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
        aria-label={t('app.search')}
      />
      <ErrorAlert error={users.error} />
      <Paper>
        <Table.ScrollContainer minWidth={720}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('users.username')}</Table.Th>
                <Table.Th>{t('users.displayName')}</Table.Th>
                <Table.Th>{t('app.status')}</Table.Th>
                <Table.Th>{t('users.mfa')}</Table.Th>
                <Table.Th>{t('users.lastLogin')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {users.data?.length === 0 && <EmptyRow colSpan={5} />}
              {users.data?.map((u) => (
                <Table.Tr key={u.id}>
                  <Table.Td dir="ltr" style={{ textAlign: 'start' }}>
                    <Anchor component={Link} to={`/users/${u.id}`}>
                      {u.username}
                    </Anchor>
                  </Table.Td>
                  <Table.Td>{u.displayName}</Table.Td>
                  <Table.Td>
                    <Group gap={4}>
                      <StatusBadge status={u.status} label={t(`app.${u.status}`)} />
                      {u.locked && <StatusBadge status="failure" label={t('users.locked')} />}
                    </Group>
                  </Table.Td>
                  <Table.Td>{u.mfaEnabled ? t('app.yes') : t('app.no')}</Table.Td>
                  <Table.Td>{fmt.dateTime(u.lastLoginAt)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Paper>

      <Modal opened={open} onClose={() => setOpen(false)} title={t('users.newUser')}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Stack>
            <ErrorAlert error={create.error} />
            <TextInput label={t('users.username')} value={form.username} onChange={(e) => setForm({ ...form, username: e.currentTarget.value })} error={errs.username} required dir="ltr" autoComplete="off" />
            <TextInput label={t('users.displayName')} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.currentTarget.value })} error={errs.displayName} required />
            <TextInput label={t('users.email')} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.currentTarget.value })} error={errs.email} dir="ltr" />
            <PasswordInput
              label={t('users.tempPassword')}
              description={t('users.tempPasswordHint')}
              value={form.temporaryPassword}
              onChange={(e) => setForm({ ...form, temporaryPassword: e.currentTarget.value })}
              required
              autoComplete="new-password"
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setOpen(false)}>
                {t('app.cancel')}
              </Button>
              <Button type="submit" loading={create.isPending}>
                {t('app.create')}
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </>
  );
}

export function UserDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { can, fmt, session, settings } = useAuth();
  const qc = useQueryClient();
  const isSelf = session?.user.id === id;

  const user = useQuery({ queryKey: ['user', id], queryFn: () => get<UserDto>(`/users/${id}`) });
  const sessions = useQuery({
    queryKey: ['user-sessions', id],
    queryFn: () => get<SessionDto[]>(`/users/${id}/sessions`),
    enabled: can('identity.session.view'),
  });
  const assignments = useQuery({
    queryKey: ['assignments', id],
    queryFn: () => get<AssignmentDto[]>(`/users/${id}/assignments`),
    enabled: can('access.assignment.view'),
  });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => get<RoleDto[]>('/roles'), enabled: can('access.role.view') });
  const companies = useQuery({ queryKey: ['companies'], queryFn: () => get<CompanyDto[]>('/companies'), enabled: can('org.company.view') });

  const [edit, setEdit] = useState<{ displayName: string; email: string } | null>(null);
  const [statusReason, setStatusReason] = useState<string | null>(null);
  const [resetPw, setResetPw] = useState<string | null>(null);
  const [confirmMfa, setConfirmMfa] = useState(false);
  const [assign, setAssign] = useState<{ roleId: string | null; scopeType: ScopeType; companyId: string | null; departmentId: string | null } | null>(null);

  const departments = useQuery({
    queryKey: ['departments', assign?.companyId],
    queryFn: () => get<DepartmentDto[]>(`/companies/${assign!.companyId}/departments`),
    enabled: !!assign?.companyId && assign.scopeType === 'DEPARTMENT',
  });

  const invalidate = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['user', id] }),
      qc.invalidateQueries({ queryKey: ['user-sessions', id] }),
      qc.invalidateQueries({ queryKey: ['assignments', id] }),
      qc.invalidateQueries({ queryKey: ['users'] }),
    ]);
  };
  const run = (fn: () => Promise<unknown>, after?: () => void) => async () => {
    try {
      await fn();
      await invalidate();
      after?.();
      notifySaved(t);
    } catch (err) {
      notifyError(t, err);
    }
  };

  const saveProfile = useMutation({
    mutationFn: () => patch(`/users/${id}`, { displayName: edit!.displayName, email: edit!.email || null, version: user.data!.version }),
    onSuccess: async () => {
      await invalidate();
      setEdit(null);
      notifySaved(t);
    },
  });

  const u = user.data;
  if (user.error) return <ErrorAlert error={user.error} />;
  const companyName = (cid: string | null) => {
    const c = companies.data?.find((x) => x.id === cid);
    return c ? localName(settings.language, c) : (cid ?? '');
  };

  return (
    <>
      <PageHeader
        title={u?.displayName ?? t('app.loading')}
        subtitle={u?.username}
        actions={
          <Button variant="default" component={Link} to="/users">
            {t('app.back')}
          </Button>
        }
      />
      {isSelf && (
        <Alert mb="md" variant="light" color="blue">
          {t('users.selfNote')}
        </Alert>
      )}
      {u && (
        <Stack gap="lg">
          <Paper p="md">
            <Group justify="space-between" align="flex-start" wrap="wrap">
              <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="lg" style={{ flex: 1 }}>
                <Stack gap={2}>
                  <Text size="xs" c="dimmed">
                    {t('users.email')}
                  </Text>
                  <Text dir="ltr" style={{ textAlign: 'start' }}>
                    {u.email ?? t('app.none')}
                  </Text>
                </Stack>
                <Stack gap={2}>
                  <Text size="xs" c="dimmed">
                    {t('app.status')}
                  </Text>
                  <Group gap={4}>
                    <StatusBadge status={u.status} label={t(`app.${u.status}`)} />
                    {u.locked && <StatusBadge status="failure" label={t('users.locked')} />}
                    {u.mustChangePassword && <Badge variant="outline" color="gray">{t('users.mustChange')}</Badge>}
                  </Group>
                </Stack>
                <Stack gap={2}>
                  <Text size="xs" c="dimmed">
                    {t('users.lastLogin')}
                  </Text>
                  <Text>{fmt.dateTime(u.lastLoginAt)}</Text>
                </Stack>
              </SimpleGrid>
              <Group gap="xs">
                {can('identity.user.edit') && (
                  <Button size="xs" variant="default" onClick={() => setEdit({ displayName: u.displayName, email: u.email ?? '' })}>
                    {t('app.edit')}
                  </Button>
                )}
                {can('identity.user.disable') && !isSelf && (
                  <Button size="xs" variant="light" color={u.status === 'active' ? 'red' : 'green'} onClick={() => setStatusReason('')}>
                    {u.status === 'active' ? t('users.disable') : t('users.enable')}
                  </Button>
                )}
                {can('identity.user.reset_credentials') && (
                  <>
                    <Button size="xs" variant="light" onClick={() => setResetPw('')}>
                      {t('users.resetPassword')}
                    </Button>
                    {u.mfaEnabled && (
                      <Button size="xs" variant="light" onClick={() => setConfirmMfa(true)}>
                        {t('users.resetMfa')}
                      </Button>
                    )}
                    {u.locked && (
                      <Button size="xs" variant="light" onClick={run(() => post(`/users/${id}/unlock`))}>
                        {t('users.unlock')}
                      </Button>
                    )}
                  </>
                )}
              </Group>
            </Group>
          </Paper>

          {can('access.assignment.view') && (
            <Paper p="md">
              <Group justify="space-between" mb="sm">
                <Title order={3} size="h5">
                  {t('users.assignments')}
                </Title>
                {can('access.assignment.manage') && !isSelf && (
                  <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setAssign({ roleId: null, scopeType: 'COMPANY', companyId: null, departmentId: null })}>
                    {t('users.addAssignment')}
                  </Button>
                )}
              </Group>
              <Table.ScrollContainer minWidth={600}>
                <Table>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t('users.role')}</Table.Th>
                      <Table.Th>{t('users.scope')}</Table.Th>
                      <Table.Th>{t('users.validFrom')}</Table.Th>
                      <Table.Th>{t('app.status')}</Table.Th>
                      <Table.Th />
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {assignments.data?.length === 0 && <EmptyRow colSpan={5} />}
                    {assignments.data?.map((a) => {
                      const r = roles.data?.find((x) => x.id === a.roleId);
                      return (
                        <Table.Tr key={a.id} opacity={a.endedAt ? 0.55 : 1}>
                          <Table.Td>{r ? localName(settings.language, r) : a.roleKey}</Table.Td>
                          <Table.Td>
                            {t(`scope.${a.scopeType}`)}
                            {a.companyId && ` · ${companyName(a.companyId)}`}
                          </Table.Td>
                          <Table.Td>{fmt.date(a.validFrom)}</Table.Td>
                          <Table.Td>
                            {a.endedAt ? (
                              <StatusBadge status="inactive" label={`${t('users.ended')} ${fmt.date(a.endedAt)}`} />
                            ) : (
                              <StatusBadge status="active" label={t('app.active')} />
                            )}
                          </Table.Td>
                          <Table.Td>
                            {!a.endedAt && can('access.assignment.manage') && !isSelf && (
                              <Button size="xs" variant="subtle" color="red" onClick={run(() => del(`/users/${id}/assignments/${a.id}`))}>
                                {t('users.endAssignment')}
                              </Button>
                            )}
                          </Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            </Paper>
          )}

          {can('identity.session.view') && (
            <Paper p="md">
              <Group justify="space-between" mb="sm">
                <Title order={3} size="h5">
                  {t('users.sessions')}
                </Title>
                {can('identity.session.revoke') && (sessions.data?.length ?? 0) > 0 && (
                  <Button size="xs" variant="light" color="red" onClick={run(() => post(`/users/${id}/sessions/revoke-all`))}>
                    {t('users.revokeAll')}
                  </Button>
                )}
              </Group>
              <SessionTable sessions={sessions.data ?? []} onRevoke={can('identity.session.revoke') ? (sid) => run(() => del(`/users/${id}/sessions/${sid}`))() : undefined} />
            </Paper>
          )}
        </Stack>
      )}

      <Modal opened={!!edit} onClose={() => setEdit(null)} title={t('app.edit')}>
        {edit && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveProfile.mutate();
            }}
          >
            <Stack>
              <ErrorAlert error={saveProfile.error} />
              <TextInput label={t('users.displayName')} value={edit.displayName} onChange={(e) => setEdit({ ...edit, displayName: e.currentTarget.value })} required />
              <TextInput label={t('users.email')} type="email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.currentTarget.value })} dir="ltr" />
              <Group justify="flex-end">
                <Button variant="default" onClick={() => setEdit(null)}>
                  {t('app.cancel')}
                </Button>
                <Button type="submit" loading={saveProfile.isPending}>
                  {t('app.save')}
                </Button>
              </Group>
            </Stack>
          </form>
        )}
      </Modal>

      <Modal opened={statusReason !== null} onClose={() => setStatusReason(null)} title={u?.status === 'active' ? t('users.disable') : t('users.enable')}>
        <Stack>
          <Textarea label={t('users.reason')} value={statusReason ?? ''} onChange={(e) => setStatusReason(e.currentTarget.value)} required autosize minRows={2} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setStatusReason(null)}>
              {t('app.cancel')}
            </Button>
            <Button
              color={u?.status === 'active' ? 'red' : 'green'}
              disabled={!statusReason?.trim()}
              onClick={run(
                () => post(`/users/${id}/status`, { status: u?.status === 'active' ? 'disabled' : 'active', reason: statusReason }),
                () => setStatusReason(null),
              )}
            >
              {t('app.confirm')}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={resetPw !== null} onClose={() => setResetPw(null)} title={t('users.resetPassword')}>
        <Stack>
          <PasswordInput
            label={t('users.tempPassword')}
            description={t('users.tempPasswordHint')}
            value={resetPw ?? ''}
            onChange={(e) => setResetPw(e.currentTarget.value)}
            autoComplete="new-password"
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setResetPw(null)}>
              {t('app.cancel')}
            </Button>
            <Button disabled={!resetPw} onClick={run(() => post(`/users/${id}/reset-password`, { temporaryPassword: resetPw }), () => setResetPw(null))}>
              {t('app.confirm')}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={confirmMfa} onClose={() => setConfirmMfa(false)} title={t('users.resetMfa')}>
        <Stack>
          <Text size="sm">{t('users.resetMfaConfirm')}</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirmMfa(false)}>
              {t('app.cancel')}
            </Button>
            <Button color="red" onClick={run(() => post(`/users/${id}/reset-mfa`), () => setConfirmMfa(false))}>
              {t('app.confirm')}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={!!assign} onClose={() => setAssign(null)} title={t('users.addAssignment')}>
        {assign && (
          <Stack>
            <Select
              label={t('users.role')}
              data={(roles.data ?? []).map((r) => ({ value: r.id, label: localName(settings.language, r) }))}
              value={assign.roleId}
              onChange={(v) => setAssign({ ...assign, roleId: v })}
              searchable
              required
            />
            <Select
              label={t('users.scope')}
              data={(['GROUP', 'COMPANY', 'DEPARTMENT', 'SELF'] as const).map((s) => ({ value: s, label: t(`scope.${s}`) }))}
              value={assign.scopeType}
              onChange={(v) => setAssign({ ...assign, scopeType: (v ?? 'COMPANY') as ScopeType, companyId: null, departmentId: null })}
              allowDeselect={false}
            />
            {(assign.scopeType === 'COMPANY' || assign.scopeType === 'DEPARTMENT') && (
              <Select
                label={t('org.company')}
                data={(companies.data ?? []).map((c) => ({ value: c.id, label: localName(settings.language, c) }))}
                value={assign.companyId}
                onChange={(v) => setAssign({ ...assign, companyId: v, departmentId: null })}
                searchable
                required
              />
            )}
            {assign.scopeType === 'DEPARTMENT' && assign.companyId && (
              <Select
                label={t('users.department')}
                data={(departments.data ?? []).map((d) => ({ value: d.id, label: localName(settings.language, d) }))}
                value={assign.departmentId}
                onChange={(v) => setAssign({ ...assign, departmentId: v })}
                required
              />
            )}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setAssign(null)}>
                {t('app.cancel')}
              </Button>
              <Button
                disabled={!assign.roleId}
                onClick={run(
                  () =>
                    post(`/users/${id}/assignments`, {
                      roleId: assign.roleId,
                      scopeType: assign.scopeType,
                      companyId: assign.companyId,
                      departmentId: assign.departmentId,
                    }),
                  () => setAssign(null),
                )}
              >
                {t('app.save')}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}

export function SessionTable({ sessions, onRevoke }: { sessions: SessionDto[]; onRevoke?: ((id: string) => void) | undefined }) {
  const { t } = useTranslation();
  const { fmt } = useAuth();
  return (
    <Table.ScrollContainer minWidth={560}>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('account.lastSeen')}</Table.Th>
            <Table.Th>IP</Table.Th>
            <Table.Th>{t('app.name')}</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {sessions.length === 0 && <EmptyRow colSpan={4} />}
          {sessions.map((s) => (
            <Table.Tr key={s.id}>
              <Table.Td>
                {fmt.dateTime(s.lastSeenAt)} {s.current && <Badge size="xs">{t('account.thisDevice')}</Badge>}
              </Table.Td>
              <Table.Td dir="ltr" style={{ textAlign: 'start' }}>
                {s.ip ?? t('app.none')}
              </Table.Td>
              <Table.Td>
                <Text size="xs" c="dimmed" lineClamp={1} maw={320} dir="ltr" style={{ textAlign: 'start' }}>
                  {s.userAgent ?? ''}
                </Text>
              </Table.Td>
              <Table.Td>
                {onRevoke && !s.current && (
                  <Button size="xs" variant="subtle" color="red" onClick={() => onRevoke(s.id)}>
                    {t('users.revoke')}
                  </Button>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
