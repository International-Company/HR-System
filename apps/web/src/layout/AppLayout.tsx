import { AppShell, Avatar, Burger, Group, Menu, NavLink, ScrollArea, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { useDisclosure, useLocalStorage } from '@mantine/hooks';
import {
  IconBuildingSkyscraper,
  IconFiles,
  IconId,
  IconListTree,
  IconUserCircle,
  IconChevronLeft,
  IconChevronRight,
  IconDatabase,
  IconHome,
  IconListDetails,
  IconLogout,
  IconSettings,
  IconShieldCheck,
  IconUser,
  IconUsers,
  IconUsersGroup,
} from '@tabler/icons-react';
import { NavLink as RouterLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { ComponentType } from 'react';
import { useAuth } from '../auth/AuthContext';

interface Item {
  to: string;
  label: string;
  icon: ComponentType<{ size?: number; stroke?: number }>;
  permission?: string;
}

export function AppLayout() {
  const { t } = useTranslation();
  const { session, can, logout, settings } = useAuth();
  const [mobileOpen, { toggle: toggleMobile, close: closeMobile }] = useDisclosure(false);
  // Collapsed state is a per-viewer convenience only.
  const [collapsed, setCollapsed] = useLocalStorage({ key: 'hrms.nav.collapsed', defaultValue: false });
  const location = useLocation();
  const navigate = useNavigate();
  const rtl = settings.language === 'ar';

  const main: Item[] = [
    { to: '/', label: t('nav.home'), icon: IconHome },
    ...(session?.user.employeeId
      ? [{ to: `/employees/${session.user.employeeId}`, label: t('nav.myProfile'), icon: IconUserCircle }]
      : []),
    ...(can('employee.profile.view') && session?.permissions.some((p) => p === 'employee.profile.create' || p === 'employee.lifecycle.manage' || p === 'employee.financial.view') || can('org.company.view')
      ? [{ to: '/employees', label: t('nav.employees'), icon: IconId, permission: 'employee.profile.view' }]
      : []),
  ].filter((i) => !('permission' in i) || !i.permission || can(i.permission));
  const admin: Item[] = [
    { to: '/companies', label: t('nav.companies'), icon: IconBuildingSkyscraper, permission: 'org.company.view' },
    { to: '/users', label: t('nav.users'), icon: IconUsers, permission: 'identity.user.view' },
    { to: '/roles', label: t('nav.roles'), icon: IconShieldCheck, permission: 'access.role.view' },
    { to: '/lookups', label: t('nav.lookups'), icon: IconListTree, permission: 'lookups.manage' },
    { to: '/document-categories', label: t('nav.documentCategories'), icon: IconFiles, permission: 'documents.categories.manage' },
    { to: '/settings', label: t('nav.settings'), icon: IconSettings, permission: 'settings.view' },
    { to: '/audit', label: t('nav.audit'), icon: IconListDetails, permission: 'audit.view' },
    { to: '/backups', label: t('nav.backups'), icon: IconDatabase, permission: 'system.backup.view' },
  ].filter((i) => !i.permission || can(i.permission));

  const ownProfile = session?.user.employeeId ? `/employees/${session.user.employeeId}` : null;
  const isActive = (to: string) =>
    to === '/'
      ? location.pathname === '/'
      : to === '/employees' && location.pathname === ownProfile
        ? false
        : location.pathname.startsWith(to);
  const width = collapsed ? 72 : 260;

  const renderItem = (item: Item) => {
    const Icon = item.icon;
    const link = (
      <NavLink
        key={item.to}
        component={RouterLink}
        to={item.to}
        label={collapsed ? undefined : item.label}
        aria-label={item.label}
        leftSection={<Icon size={20} stroke={1.6} />}
        active={isActive(item.to)}
        onClick={closeMobile}
        variant="light"
        style={{ borderRadius: 8 }}
      />
    );
    return collapsed ? (
      <Tooltip key={item.to} label={item.label} position={rtl ? 'left' : 'right'} withArrow>
        <div>{link}</div>
      </Tooltip>
    ) : (
      link
    );
  };

  const CollapseIcon = (collapsed ? !rtl : rtl) ? IconChevronRight : IconChevronLeft;

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{ width, breakpoint: 'sm', collapsed: { mobile: !mobileOpen } }}
      padding="lg"
      bg="var(--mantine-color-gray-0)"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={mobileOpen} onClick={toggleMobile} hiddenFrom="sm" size="sm" aria-label={t('app.expand')} />
            <IconUsersGroup size={28} color="var(--mantine-color-brand-6)" />
            <Text fw={600} visibleFrom="xs" truncate>
              {t('app.title')}
            </Text>
          </Group>
          <Menu position="bottom-end" width={220} withArrow>
            <Menu.Target>
              <UnstyledButton aria-label={t('nav.account')}>
                <Group gap="xs" wrap="nowrap">
                  <Avatar color="brand" radius="xl" size="sm">
                    {session?.user.displayName.slice(0, 1)}
                  </Avatar>
                  <Text size="sm" visibleFrom="sm" truncate maw={180}>
                    {session?.user.displayName}
                  </Text>
                </Group>
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label dir="ltr">{session?.user.username}</Menu.Label>
              <Menu.Item leftSection={<IconUser size={16} />} onClick={() => navigate('/account')}>
                {t('nav.account')}
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item color="red" leftSection={<IconLogout size={16} />} onClick={() => void logout()}>
                {t('nav.logout')}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        <AppShell.Section grow component={ScrollArea}>
          {main.map(renderItem)}
          {admin.length > 0 && !collapsed && (
            <Text size="xs" c="dimmed" fw={600} mt="md" mb={4} px="sm" tt="uppercase">
              {t('nav.administration')}
            </Text>
          )}
          {admin.map(renderItem)}
        </AppShell.Section>
        <AppShell.Section visibleFrom="sm">
          <NavLink
            component="button"
            label={collapsed ? undefined : t('app.collapse')}
            aria-label={collapsed ? t('app.expand') : t('app.collapse')}
            leftSection={<CollapseIcon size={18} />}
            onClick={() => setCollapsed(!collapsed)}
            c="dimmed"
          />
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
