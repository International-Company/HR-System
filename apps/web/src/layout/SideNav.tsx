import { Badge, Collapse, Divider, Indicator, NavLink, ScrollArea, Stack, Text, Tooltip, UnstyledButton, Group } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { IconChevronDown, IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import type { ComponentType } from 'react';
import { NavLink as RouterLink } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { WorkflowInstanceDto } from '@hrms/shared';
import { get } from '../lib/api';

export interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ size?: number; stroke?: number }>;
  /** Shows the number of pending approvals. */
  badge?: 'tasks';
}

export interface NavSection {
  key: string;
  /** No label: the opening items (home, approvals). */
  label?: string;
  /** Administration groups fold away; their open state is remembered per viewer. */
  collapsible?: boolean;
  items: NavItem[];
}

interface Props {
  sections: NavSection[];
  collapsed: boolean;
  rtl: boolean;
  isActive: (to: string) => boolean;
  onNavigate: () => void;
  onToggleCollapsed: () => void;
}

/** Grouped side navigation: section headings, foldable admin groups, active marker and pending-approvals badge. */
export function SideNav({ sections, collapsed, rtl, isActive, onNavigate, onToggleCollapsed }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useLocalStorage<Record<string, boolean>>({ key: 'hrms.nav.groups', defaultValue: {} });
  // Same cache as the approvals page, so deciding a task updates the badge at once.
  const tasks = useQuery({
    queryKey: ['tasks', 'pending'],
    queryFn: () => get<WorkflowInstanceDto[]>('/workflow/tasks'),
    refetchInterval: 60_000,
  });
  const pending = tasks.data?.length ?? 0;

  const visible = sections.filter((s) => s.items.length > 0);
  // Start edge of the active marker follows the reading direction.
  const marker = `inset ${rtl ? '-3px' : '3px'} 0 0 var(--mantine-color-brand-6)`;

  const renderItem = (item: NavItem) => {
    const Icon = item.icon;
    const active = isActive(item.to);
    const count = item.badge === 'tasks' ? pending : 0;
    const icon = <Icon size={20} stroke={active ? 2 : 1.6} />;
    const link = (
      <NavLink
        key={item.to}
        component={RouterLink}
        to={item.to}
        label={collapsed ? undefined : item.label}
        aria-label={count ? `${item.label} (${t('nav.pendingCount', { count })})` : item.label}
        leftSection={collapsed && count ? <Indicator size={8} color="red" offset={2} processing={false}>{icon}</Indicator> : icon}
        rightSection={!collapsed && count ? <Badge size="sm" color="red" variant="filled" circle={count < 10}>{count > 99 ? '99+' : count}</Badge> : undefined}
        active={active}
        onClick={onNavigate}
        variant="light"
        styles={{
          root: { borderRadius: 8, minHeight: 38, boxShadow: active ? marker : undefined, fontWeight: active ? 600 : 500 },
          label: { fontSize: 'var(--mantine-font-size-sm)' },
        }}
      />
    );
    return collapsed ? (
      <Tooltip key={item.to} label={count ? `${item.label} · ${count}` : item.label} position={rtl ? 'left' : 'right'} withArrow openDelay={150}>
        <div>{link}</div>
      </Tooltip>
    ) : (
      link
    );
  };

  const renderSection = (s: NavSection, index: number) => {
    const containsActive = s.items.some((i) => isActive(i.to));
    const isOpen = !s.collapsible || collapsed || containsActive || (open[s.key] ?? false);
    if (collapsed) {
      return (
        <Stack key={s.key} gap={2}>
          {index > 0 && <Divider my={6} mx="xs" />}
          {s.items.map(renderItem)}
        </Stack>
      );
    }
    return (
      <Stack key={s.key} gap={2} mt={s.label ? 'sm' : 0}>
        {s.label &&
          (s.collapsible ? (
            <UnstyledButton
              onClick={() => setOpen({ ...open, [s.key]: !isOpen })}
              aria-expanded={isOpen}
              disabled={containsActive}
              px="sm"
              py={4}
              style={{ borderRadius: 6 }}
            >
              <Group justify="space-between" wrap="nowrap">
                <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: '0.02em' }}>
                  {s.label}
                </Text>
                <IconChevronDown
                  size={14}
                  color="var(--mantine-color-dimmed)"
                  style={{ transform: isOpen ? 'none' : `rotate(${rtl ? 90 : -90}deg)`, transition: 'transform 150ms ease', opacity: containsActive ? 0.4 : 1 }}
                />
              </Group>
            </UnstyledButton>
          ) : (
            <Text size="xs" c="dimmed" fw={700} px="sm" py={4} style={{ letterSpacing: '0.02em' }}>
              {s.label}
            </Text>
          ))}
        <Collapse expanded={isOpen} transitionDuration={150}>
          <Stack gap={2}>{s.items.map(renderItem)}</Stack>
        </Collapse>
      </Stack>
    );
  };

  const CollapseIcon = (collapsed ? !rtl : rtl) ? IconChevronRight : IconChevronLeft;

  return (
    <>
      <ScrollArea type="scroll" scrollbarSize={6} offsetScrollbars style={{ flex: 1 }}>
        <Stack gap={0} pb="sm">
          {visible.map(renderSection)}
        </Stack>
      </ScrollArea>
      <Divider my={6} visibleFrom="sm" />
      <NavLink
        component="button"
        visibleFrom="sm"
        label={collapsed ? undefined : t('app.collapse')}
        aria-label={collapsed ? t('app.expand') : t('app.collapse')}
        leftSection={<CollapseIcon size={18} />}
        onClick={onToggleCollapsed}
        c="dimmed"
        styles={{ root: { borderRadius: 8 } }}
      />
    </>
  );
}
