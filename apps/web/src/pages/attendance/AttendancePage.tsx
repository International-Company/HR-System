import { useEffect, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Center,
  Group,
  Modal,
  Paper,
  PasswordInput,
  PinInput,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core';
import { IconFingerprint, IconLogin2, IconLogout2, IconPlayerPause, IconPlayerPlay, IconPlus, IconTrash, IconWifi, IconWifiOff } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { PUNCH_KINDS, type AttendanceDayDto, type AttendanceDeviceDto, type CorrectionDto, type PunchKind, type TodayDto } from '@hrms/shared';
import { get, post } from '../../lib/api';
import { useAuth } from '../../auth/AuthContext';
import { ErrorAlert, PageHeader, StatusBadge, errorMessage, notifyError, notifySaved } from '../../components/common';
import { AttendanceDaysTable } from './AttendanceDaysTable';

const TOKEN_KEY = 'hrms.attendance.deviceToken';
const KIND_ICON: Record<PunchKind, typeof IconLogin2> = { in: IconLogin2, out: IconLogout2, break_start: IconPlayerPause, break_end: IconPlayerPlay };

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function monthRange(offset = 0) {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 0));
  const today = new Date().toISOString().slice(0, 10);
  const to = last.toISOString().slice(0, 10);
  return { from: first.toISOString().slice(0, 10), to: to > today ? today : to };
}

/** Employee self-service attendance (ATT-01..06, ATT-15). */
export function AttendancePage() {
  const { t } = useTranslation();
  const { fmt, session } = useAuth();
  const qc = useQueryClient();
  const today = useQuery({ queryKey: ['attendance', 'today'], queryFn: () => get<TodayDto>('/attendance/today'), refetchInterval: 60_000 });
  const [month, setMonth] = useState(0);
  const range = monthRange(month);
  const employeeId = session?.user.employeeId;
  const days = useQuery({
    queryKey: ['attendance', 'days', employeeId, range.from],
    queryFn: () => get<AttendanceDayDto[]>(`/attendance/employees/${employeeId}/days?from=${range.from}&to=${range.to}`),
    enabled: !!employeeId,
  });
  const [pinFor, setPinFor] = useState<PunchKind | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [clock, setClock] = useState(new Date());
  const [correction, setCorrection] = useState<AttendanceDayDto | null>(null);
  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 15_000);
    return () => clearInterval(id);
  }, []);

  const doPunch = useMutation({
    mutationFn: async ({ kind, pinValue }: { kind: PunchKind; pinValue?: string }) => {
      const tdy = today.data!;
      const body: Record<string, unknown> = { kind, idempotencyKey: crypto.randomUUID() };
      const v = tdy.verification;
      if ((v === 'webauthn' || v === 'webauthn_or_pin') && tdy.hasWebauthnDevice && !pinValue) {
        const options = await post<Parameters<typeof startAuthentication>[0]['optionsJSON']>('/attendance/punch-options');
        body.assertion = await startAuthentication({ optionsJSON: options });
      } else if (pinValue) {
        body.deviceToken = readToken();
        body.pin = pinValue;
      }
      return post<TodayDto>('/attendance/punch', body);
    },
    onSuccess: async (data) => {
      qc.setQueryData(['attendance', 'today'], data);
      setPinFor(null);
      setPin('');
      setError(null);
      await qc.invalidateQueries({ queryKey: ['attendance', 'days'] });
      notifySaved(t, t('att.recorded'));
    },
    onError: (err) => setError(err),
  });

  const start = (kind: PunchKind) => {
    const tdy = today.data!;
    const needsPin = tdy.verification === 'pin' || (tdy.verification === 'webauthn_or_pin' && !tdy.hasWebauthnDevice);
    if (needsPin) setPinFor(kind);
    else doPunch.mutate({ kind });
  };

  const d = today.data;
  if (!employeeId) {
    return (
      <>
        <PageHeader title={t('att.title')} />
        <Alert>{t('errors.FORBIDDEN')}</Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t('att.title')} />
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        <Card withBorder padding="lg">
          <Stack>
            <Group justify="space-between">
              <Title order={3} size="h4">
                {t('att.punchTitle')}
              </Title>
              {d && <Badge size="lg" variant="light" color={d.state === 'out' ? 'gray' : d.state === 'in' ? 'green' : 'yellow'}>{t(`att.states.${d.state}`)}</Badge>}
            </Group>
            <Text size="xl" fw={600} ta="center">
              {fmt.time(clock)}
            </Text>
            <Text size="xs" c="dimmed" ta="center">
              {t('att.serverTime')} · {fmt.date(clock)}
            </Text>
            {d && (
              <Alert
                variant="light"
                color={d.network.allowed ? 'green' : 'red'}
                icon={d.network.allowed ? <IconWifi size={18} /> : <IconWifiOff size={18} />}
              >
                <Text size="sm">{d.network.allowed ? t('att.networkOk') : d.network.configured ? t('att.networkNo') : t('att.networkNone')}</Text>
                {!d.network.allowed && d.network.ip && (
                  <Text size="xs" dir="ltr">
                    {t('att.yourIp', { ip: d.network.ip })}
                  </Text>
                )}
              </Alert>
            )}
            {d && d.verification !== 'none' && !d.hasWebauthnDevice && !d.hasPinDevice && <Alert color="yellow">{t('att.noDevice')}</Alert>}
            <ErrorAlert error={error ?? today.error} />
            <SimpleGrid cols={2}>
              {PUNCH_KINDS.map((k) => {
                const Icon = KIND_ICON[k];
                const allowed = !!d?.allowedKinds.includes(k) && d.moduleAccess === 'enabled';
                return (
                  <Button
                    key={k}
                    size="lg"
                    h={64}
                    variant={allowed ? (k === 'in' ? 'filled' : k === 'out' ? 'filled' : 'light') : 'default'}
                    color={k === 'out' ? 'red' : k === 'in' ? 'green' : 'brand'}
                    leftSection={<Icon size={22} />}
                    disabled={!allowed}
                    loading={doPunch.isPending && doPunch.variables?.kind === k}
                    onClick={() => start(k)}
                  >
                    {t(`att.kinds.${k}`)}
                  </Button>
                );
              })}
            </SimpleGrid>
            <Text size="xs" c="dimmed" ta="center">
              {t('att.ipNote')}
            </Text>
          </Stack>
        </Card>

        <Card withBorder padding="lg">
          <Title order={3} size="h5" mb="sm">
            {fmt.date(d?.workDate ?? clock)}
          </Title>
          {d?.day && (
            <Stack gap="xs">
              {d.day.scheduledStart && (
                <Text size="sm" c="dimmed">
                  {t(`att.classes.${d.day.dayClass}`)} · {d.day.scheduledStart}–{d.day.scheduledEnd}
                </Text>
              )}
              <Table>
                <Table.Tbody>
                  {d.day.punches.map((p) => (
                    <Table.Tr key={p.id} opacity={p.voided ? 0.4 : 1}>
                      <Table.Td>{t(`att.kinds.${p.kind}`)}</Table.Td>
                      <Table.Td dir="ltr">{p.localTime}</Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed">
                          {t(`att.methods.${p.method}`)}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
              <Group gap="lg">
                <Text size="sm">
                  {t('att.late')}: <b>{d.day.lateMinutes}</b>
                </Text>
                <Text size="sm">
                  {t('att.overtime')}: <b>{d.day.overtimeMinutes}</b>
                </Text>
              </Group>
            </Stack>
          )}
        </Card>
      </SimpleGrid>

      <Paper p="lg" mt="lg">
        <Group justify="space-between" mb="sm">
          <Title order={3} size="h5">
            {t('att.myDays')}
          </Title>
          <Group gap="xs">
            <Button size="xs" variant="default" onClick={() => setMonth(month - 1)}>
              ‹
            </Button>
            <Text size="sm" dir="ltr">{range.from.slice(0, 7)}</Text>
            <Button size="xs" variant="default" onClick={() => setMonth(Math.min(0, month + 1))} disabled={month >= 0}>
              ›
            </Button>
          </Group>
        </Group>
        <ErrorAlert error={days.error} />
        <AttendanceDaysTable days={[...(days.data ?? [])].reverse()} onSelect={(day) => setCorrection(day)} />
        <Text size="xs" c="dimmed" mt="xs">
          {t('att.correctionHint')}
        </Text>
      </Paper>

      <CorrectionsList employeeId={employeeId} />
      <DevicesPanel />

      <Modal opened={!!pinFor} onClose={() => setPinFor(null)} title={t('att.verifyPin')} size="sm">
        <Stack>
          <ErrorAlert error={error} />
          <Center dir="ltr">
            <PinInput length={4} type="number" mask value={pin} onChange={setPin} onComplete={(v) => pinFor && doPunch.mutate({ kind: pinFor, pinValue: v })} autoFocus />
          </Center>
          <Button loading={doPunch.isPending} disabled={pin.length !== 4} onClick={() => pinFor && doPunch.mutate({ kind: pinFor, pinValue: pin })}>
            {pinFor ? t(`att.kinds.${pinFor}`) : ''}
          </Button>
        </Stack>
      </Modal>

      <CorrectionModal day={correction} onClose={() => setCorrection(null)} />
    </>
  );
}

function CorrectionModal({ day, onClose }: { day: AttendanceDayDto | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [add, setAdd] = useState<{ kind: PunchKind; time: string }[]>([]);
  const [voidIds, setVoidIds] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  useEffect(() => {
    setAdd(day && !day.punches.length ? [{ kind: 'in', time: day.scheduledStart ?? '08:00' }, { kind: 'out', time: day.scheduledEnd ?? '16:00' }] : []);
    setVoidIds([]);
    setReason('');
  }, [day]);
  const submit = useMutation({
    mutationFn: () => post<CorrectionDto>('/attendance/corrections', { workDate: day!.workDate, add, voidPunchIds: voidIds, reason }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['attendance'] });
      onClose();
      notifySaved(t);
    },
  });
  return (
    <Modal opened={!!day} onClose={onClose} title={t('att.requestCorrection')}>
      {day && (
        <Stack>
          <ErrorAlert error={submit.error} />
          <Text size="sm">{day.workDate}</Text>
          {day.punches.filter((p) => !p.voided).map((p) => (
            <Group key={p.id} justify="space-between">
              <Text size="sm" td={voidIds.includes(p.id) ? 'line-through' : undefined}>
                {t(`att.kinds.${p.kind}`)} <span dir="ltr">{p.localTime}</span>
              </Text>
              <Button size="compact-xs" variant="subtle" color="red" onClick={() => setVoidIds(voidIds.includes(p.id) ? voidIds.filter((x) => x !== p.id) : [...voidIds, p.id])}>
                {t('att.removePunch')}
              </Button>
            </Group>
          ))}
          {add.map((a, i) => (
            <Group key={i} align="flex-end" gap="xs">
              <Select
                w={170}
                data={PUNCH_KINDS.map((k) => ({ value: k, label: t(`att.kinds.${k}`) }))}
                value={a.kind}
                onChange={(v) => setAdd(add.map((x, n) => (n === i ? { ...x, kind: (v ?? 'in') as PunchKind } : x)))}
                allowDeselect={false}
              />
              <TextInput w={110} type="time" value={a.time} onChange={(e) => setAdd(add.map((x, n) => (n === i ? { ...x, time: e.currentTarget.value } : x)))} />
              <ActionIcon variant="subtle" color="red" mb={4} onClick={() => setAdd(add.filter((_, n) => n !== i))} aria-label={t('emp.remove')}>
                <IconTrash size={14} />
              </ActionIcon>
            </Group>
          ))}
          <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setAdd([...add, { kind: 'out', time: '16:00' }])}>
            {t('att.addPunch')}
          </Button>
          <Textarea label={t('att.reason')} value={reason} onChange={(e) => setReason(e.currentTarget.value)} required autosize minRows={2} />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('app.cancel')}
            </Button>
            <Button disabled={reason.trim().length < 3 || (!add.length && !voidIds.length)} loading={submit.isPending} onClick={() => submit.mutate()}>
              {t('att.requestCorrection')}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

function CorrectionsList({ employeeId }: { employeeId: string }) {
  const { t } = useTranslation();
  const { fmt } = useAuth();
  const list = useQuery({ queryKey: ['attendance', 'corrections', employeeId], queryFn: () => get<CorrectionDto[]>(`/attendance/employees/${employeeId}/corrections`) });
  if (!list.data?.length) return null;
  return (
    <Paper p="lg" mt="lg">
      <Title order={3} size="h5" mb="sm">
        {t('att.corrections')}
      </Title>
      <Table>
        <Table.Tbody>
          {list.data.map((c) => (
            <Table.Tr key={c.id}>
              <Table.Td>{fmt.date(c.workDate)}</Table.Td>
              <Table.Td dir="ltr" style={{ textAlign: 'start' }}>
                {c.add.map((a) => `${a.kind} ${a.time}`).join(', ')}
              </Table.Td>
              <Table.Td>{c.reason}</Table.Td>
              <Table.Td>
                <StatusBadge status={c.status === 'approved' ? 'success' : c.status === 'rejected' ? 'failed' : 'requested'} label={t(`tasks.statuses.${c.status}`)} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Paper>
  );
}

function DevicesPanel() {
  const { t } = useTranslation();
  const { fmt } = useAuth();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['attendance', 'devices'], queryFn: () => get<AttendanceDeviceDto[]>('/attendance/devices/mine') });
  const [pinForm, setPinForm] = useState<{ label: string; pin: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['attendance'] });

  const registerBio = async () => {
    try {
      const options = await post<Parameters<typeof startRegistration>[0]['optionsJSON']>('/attendance/devices/webauthn/options');
      const response = await startRegistration({ optionsJSON: options });
      await post('/attendance/devices/webauthn/verify', { label: navigator.platform || 'Device', response });
      await refresh();
      notifySaved(t);
    } catch (err) {
      notifyError(t, err);
    }
  };
  const registerPin = useMutation({
    mutationFn: () => post<{ deviceToken: string }>('/attendance/devices/pin', pinForm),
    onSuccess: async (r) => {
      try {
        localStorage.setItem(TOKEN_KEY, r.deviceToken);
      } catch {
        /* storage unavailable: the PIN cannot be used on this browser */
      }
      setPinForm(null);
      await refresh();
      notifySaved(t);
    },
  });
  const revoke = async (id: string) => {
    try {
      await post(`/attendance/devices/${id}/revoke`);
      await refresh();
    } catch (err) {
      notifyError(t, err);
    }
  };

  return (
    <Paper p="lg" mt="lg">
      <Group justify="space-between" mb="sm">
        <Title order={3} size="h5">
          {t('att.devices')}
        </Title>
        <Group gap="xs">
          {browserSupportsWebAuthn() ? (
            <Button size="xs" variant="light" leftSection={<IconFingerprint size={14} />} onClick={() => void registerBio()}>
              {t('att.registerBio')}
            </Button>
          ) : (
            <Text size="xs" c="dimmed">
              {t('att.bioUnsupported')}
            </Text>
          )}
          <Button size="xs" variant="light" onClick={() => setPinForm({ label: '', pin: '' })}>
            {t('att.registerPin')}
          </Button>
        </Group>
      </Group>
      <Table>
        <Table.Tbody>
          {list.data?.map((dev) => (
            <Table.Tr key={dev.id}>
              <Table.Td>{dev.label}</Table.Td>
              <Table.Td>{dev.kind === 'webauthn' ? t('att.methods.webauthn') : t('att.methods.pin')}</Table.Td>
              <Table.Td>
                <StatusBadge status={dev.status === 'approved' ? 'success' : 'requested'} label={t(`att.${dev.status}`)} />
              </Table.Td>
              <Table.Td>{dev.lastUsedAt ? fmt.dateTime(dev.lastUsedAt) : '—'}</Table.Td>
              <Table.Td>
                <Button size="compact-xs" variant="subtle" color="red" onClick={() => void revoke(dev.id)}>
                  {t('att.revoke')}
                </Button>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Modal opened={!!pinForm} onClose={() => setPinForm(null)} title={t('att.registerPin')} size="sm">
        {pinForm && (
          <Stack>
            {registerPin.error ? <Alert color="red">{errorMessage(t, registerPin.error)}</Alert> : null}
            <TextInput label={t('att.deviceLabel')} value={pinForm.label} onChange={(e) => setPinForm({ ...pinForm, label: e.currentTarget.value })} />
            <PasswordInput label={t('att.pin')} value={pinForm.pin} onChange={(e) => setPinForm({ ...pinForm, pin: e.currentTarget.value.replace(/\D/g, '').slice(0, 4) })} inputMode="numeric" />
            <Button disabled={!pinForm.label || pinForm.pin.length !== 4} loading={registerPin.isPending} onClick={() => registerPin.mutate()}>
              {t('app.save')}
            </Button>
          </Stack>
        )}
      </Modal>
    </Paper>
  );
}
