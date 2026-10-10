import type { ReactNode } from 'react';
import { Alert, Badge, Group, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ApiError } from '../lib/api';

/** Human-readable, translated error message (never shows raw server internals). */
export function errorMessage(t: TFunction, err: unknown): string {
  if (err instanceof ApiError) {
    const base = t(`errors.${err.code}`, { defaultValue: t('errors.INTERNAL') });
    const reasons = err.problem?.meta?.reasons as string[] | undefined;
    if (err.code === 'PASSWORD_POLICY' && reasons?.length) {
      return `${base} (${reasons.map((r) => t(`errors.reasons.${r}`, { defaultValue: r })).join('، ')})`;
    }
    if (err.code === 'VALIDATION_FAILED' && err.problem?.errors?.length) {
      return `${base} ${err.problem.errors.map((e) => `${e.path}: ${e.message}`).join(' · ')}`;
    }
    return base;
  }
  return t('errors.INTERNAL');
}

/** Field-level messages from a VALIDATION_FAILED problem, keyed by path. */
export function fieldErrors(err: unknown): Record<string, string> {
  if (err instanceof ApiError && err.problem?.errors) {
    return Object.fromEntries(err.problem.errors.map((e) => [e.path, e.message]));
  }
  return {};
}

export function ErrorAlert({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  return (
    <Alert color="red" icon={<IconAlertCircle size={18} />} variant="light">
      {errorMessage(t, error)}
    </Alert>
  );
}

export function notifyError(t: TFunction, err: unknown) {
  notifications.show({ color: 'red', message: errorMessage(t, err) });
}

export function notifySaved(t: TFunction, message?: string) {
  notifications.show({ color: 'green', message: message ?? t('app.saved') });
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <Group justify="space-between" align="flex-start" mb="lg" wrap="wrap" gap="sm">
      <Stack gap={2}>
        <Title order={2} size="h3">
          {title}
        </Title>
        {subtitle && (
          <Text c="dimmed" size="sm">
            {subtitle}
          </Text>
        )}
      </Stack>
      {actions && <Group gap="xs">{actions}</Group>}
    </Group>
  );
}

const STATUS_COLORS: Record<string, string> = {
  active: 'green',
  inactive: 'gray',
  disabled: 'gray',
  success: 'green',
  succeeded: 'green',
  denied: 'orange',
  failure: 'red',
  failed: 'red',
  requested: 'blue',
  running: 'blue',
};

/** Status is always shown as text + colour, never colour alone (UX-04). */
export function StatusBadge({ status, label }: { status: string; label: string }) {
  return (
    <Badge color={STATUS_COLORS[status] ?? 'gray'} variant="light" radius="sm">
      {label}
    </Badge>
  );
}

export function EmptyRow({ colSpan }: { colSpan: number }) {
  const { t } = useTranslation();
  return (
    <tr>
      <td colSpan={colSpan}>
        <Text c="dimmed" ta="center" py="lg" size="sm">
          {t('app.noData')}
        </Text>
      </td>
    </tr>
  );
}

/** Pick the name in the active UI language. */
export function localName(lang: string, row: { nameAr: string; nameEn: string }): string {
  return lang === 'ar' ? row.nameAr : row.nameEn;
}
