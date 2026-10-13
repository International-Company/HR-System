import { AppShell, Avatar, Burger, Group, Menu, Text, UnstyledButton } from '@mantine/core';
import { useDisclosure, useLocalStorage } from '@mantine/hooks';
import {
  IconBuildingSkyscraper,
  IconCalendarEvent,
  IconChecklist,
  IconClockHour4,
  IconFingerprint,
  IconBeach,
  IconFileCertificate,
  IconTemplate,
  IconCash,
  IconReceipt,
  IconDoorExit,
  IconUserSearch,
  IconGauge,
  IconReportAnalytics,
  IconCalendarStats,
  IconClipboardCheck,
  IconWifi,
  IconRoute,
  IconFiles,
  IconId,
  IconListTree,
  IconUserCircle,
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
import { Outlet, useLocation, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import { NotificationBell } from '../pages/NotificationsPages';
import { GlobalSearch } from '../components/GlobalSearch';
import { SideNav, type NavItem, type NavSection } from './SideNav';
import { useClipboardGuard } from './clipboardGuard';

export function AppLayout() {
  const { t } = useTranslation();
  const { session, can, logout, settings } = useAuth();
  const [mobileOpen, { toggle: toggleMobile, close: closeMobile }] = useDisclosure(false);
  useClipboardGuard();
  // Collapsed state is a per-viewer convenience only.
  const [collapsed, setCollapsed] = useLocalStorage({ key: 'hrms.nav.collapsed', defaultValue: false });
  const location = useLocation();
  const navigate = useNavigate();
  const rtl = settings.language === 'ar';

  const nonSelf = !!session?.roles.some((r) => r.scopeType !== 'SELF');
  const allowed = (items: (NavItem & { permission?: string; show?: boolean })[]): NavItem[] =>
    items.filter((i) => i.show !== false && (!i.permission || can(i.permission)));

  const sections: NavSection[] = [
    {
      key: 'start',
      items: allowed([
        { to: '/', label: t('nav.home'), icon: IconHome },
        { to: '/tasks', label: t('nav.tasks'), icon: IconChecklist, badge: 'tasks' },
      ]),
    },
    {
      // Self-service for anyone linked to an employee record.
      key: 'self',
      label: t('nav.groupSelf'),
      items: allowed([
        { to: `/employees/${session?.user.employeeId ?? ''}`, label: t('nav.myProfile'), icon: IconUserCircle, show: !!session?.user.employeeId },
        { to: '/attendance', label: t('nav.attendance'), icon: IconFingerprint, show: !!session?.user.employeeId && can('attendance.punch') },
        { to: '/leave', label: t('nav.leave'), icon: IconBeach, show: !!session?.user.employeeId && can('leave.request.create') },
        { to: '/payslips', label: t('nav.payslips'), icon: IconReceipt, show: !!session?.user.employeeId && can('payroll.payslip.view') },
      ]),
    },
    {
      key: 'people',
      label: t('nav.groupPeople'),
      items: allowed([
        {
          to: '/employees',
          label: t('nav.employees'),
          icon: IconId,
          permission: 'employee.profile.view',
          show: (can('employee.profile.view') && !!session?.permissions.some((p) => p === 'employee.profile.create' || p === 'employee.lifecycle.manage' || p === 'employee.financial.view')) || can('org.company.view'),
        },
        { to: '/attendance/review', label: t('nav.attendanceReview'), icon: IconClipboardCheck, permission: 'attendance.review' },
        // Managers see their scope's requests; plain employees only have their own page.
        { to: '/leave/manage', label: t('nav.leaveManage'), icon: IconCalendarStats, show: can('leave.request.manage') || can('leave.types.manage') || (can('leave.request.view') && nonSelf) },
        { to: '/contracts', label: t('nav.contracts'), icon: IconFileCertificate, show: can('contracts.view') || can('contracts.manage') || can('contracts.sign') },
        { to: '/separations', label: t('nav.separations'), icon: IconDoorExit, show: can('separation.view') && nonSelf },
        { to: '/recruitment', label: t('nav.recruitment'), icon: IconUserSearch, show: can('recruitment.view') || can('recruitment.manage') },
        { to: '/evaluation', label: t('nav.evaluation'), icon: IconGauge, show: can('evaluation.manage') || (can('evaluation.view') && nonSelf) },
      ]),
    },
    {
      key: 'finance',
      label: t('nav.groupFinance'),
      items: allowed([
        { to: '/payroll', label: t('nav.payroll'), icon: IconCash, show: can('payroll.view') || can('payroll.prepare') || can('payroll.summary.view') },
        { to: '/reports', label: t('nav.reports'), icon: IconReportAnalytics, permission: 'reports.run' },
      ]),
    },
    {
      key: 'org',
      label: t('nav.groupOrg'),
      collapsible: true,
      items: allowed([
        { to: '/companies', label: t('nav.companies'), icon: IconBuildingSkyscraper, permission: 'org.company.view' },
        { to: '/users', label: t('nav.users'), icon: IconUsers, permission: 'identity.user.view' },
        { to: '/roles', label: t('nav.roles'), icon: IconShieldCheck, permission: 'access.role.view' },
      ]),
    },
    {
      key: 'setup',
      label: t('nav.groupSetup'),
      collapsible: true,
      items: allowed([
        { to: '/lookups', label: t('nav.lookups'), icon: IconListTree, permission: 'lookups.manage' },
        { to: '/schedules', label: t('nav.schedules'), icon: IconClockHour4, permission: 'schedules.view' },
        { to: '/holidays', label: t('nav.holidays'), icon: IconCalendarEvent, permission: 'schedules.view' },
        { to: '/attendance/admin', label: t('nav.attendanceAdmin'), icon: IconWifi, show: can('attendance.network.manage') || can('attendance.device.manage') },
        { to: '/workflow-definitions', label: t('nav.workflows'), icon: IconRoute, permission: 'workflow.definitions.manage' },
        { to: '/contracts/setup', label: t('nav.contractSetup'), icon: IconTemplate, permission: 'contracts.templates.manage' },
        { to: '/document-categories', label: t('nav.documentCategories'), icon: IconFiles, permission: 'documents.categories.manage' },
      ]),
    },
    {
      key: 'system',
      label: t('nav.groupSystem'),
      collapsible: true,
      items: allowed([
        { to: '/settings', label: t('nav.settings'), icon: IconSettings, permission: 'settings.view' },
        { to: '/audit', label: t('nav.audit'), icon: IconListDetails, permission: 'audit.view' },
        { to: '/backups', label: t('nav.backups'), icon: IconDatabase, permission: 'system.backup.view' },
      ]),
    },
  ];

  const ownProfile = session?.user.employeeId ? `/employees/${session.user.employeeId}` : null;
  const isActive = (to: string) =>
    to === '/'
      ? location.pathname === '/'
      : to === '/employees' && location.pathname === ownProfile
        ? false
        : to === '/attendance' || to === '/leave' || to === '/contracts' ? location.pathname === to || (to === '/contracts' && /^\/contracts\/(?!setup)/.test(location.pathname)) : location.pathname.startsWith(to);
  const width = collapsed ? 72 : 260;

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
          <Group gap="xs" wrap="nowrap">
          <Group gap="xs" wrap="nowrap">
            <GlobalSearch />
            <NotificationBell />
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
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        <SideNav
          sections={sections}
          collapsed={collapsed}
          rtl={rtl}
          isActive={isActive}
          onNavigate={closeMobile}
          onToggleCollapsed={() => setCollapsed(!collapsed)}
        />
      </AppShell.Navbar>

      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
