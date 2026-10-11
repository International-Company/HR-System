import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DirectionProvider, Loader, Center, MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import '@fontsource-variable/cairo';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './i18n';
import { theme } from './theme';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { ApiError } from './lib/api';
import { AppLayout } from './layout/AppLayout';
import { ChangePasswordPage, LoginPage, MfaSetupPage, MfaVerifyPage } from './pages/auth/AuthPages';
import { DashboardPage } from './pages/DashboardPage';
import { CompaniesPage, CompanyDetailPage } from './pages/CompaniesPages';
import { UserDetailPage, UsersPage } from './pages/UsersPages';
import { RolesPage } from './pages/RolesPage';
import { SettingsPage } from './pages/SettingsPage';
import { AuditPage } from './pages/AuditPage';
import { BackupsPage } from './pages/BackupsPage';
import { AccountPage } from './pages/AccountPage';
import { EmployeesListPage } from './pages/employees/EmployeesListPage';
import { NewEmployeePage } from './pages/employees/NewEmployeePage';
import { EmployeeProfilePage } from './pages/employees/EmployeeProfilePage';
import { LookupsPage } from './pages/LookupsPage';
import { DocumentCategoriesPage } from './pages/DocumentCategoriesPage';
import { TasksPage } from './pages/TasksPage';
import { NotificationsPage } from './pages/NotificationsPages';
import { SchedulesPage } from './pages/SchedulesPage';
import { HolidaysPage } from './pages/HolidaysPage';
import { WorkflowDefinitionsPage } from './pages/WorkflowDefinitionsPage';
import { AttendancePage } from './pages/attendance/AttendancePage';
import { AttendanceAdminPage, AttendanceReviewPage } from './pages/attendance/AttendanceStaffPages';
import { LeaveManagePage, LeavePage } from './pages/leave/LeavePages';
import { registerServiceWorker } from './lib/push';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'companies', element: <CompaniesPage /> },
      { path: 'companies/:id', element: <CompanyDetailPage /> },
      { path: 'users', element: <UsersPage /> },
      { path: 'users/:id', element: <UserDetailPage /> },
      { path: 'roles', element: <RolesPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'audit', element: <AuditPage /> },
      { path: 'backups', element: <BackupsPage /> },
      { path: 'account', element: <AccountPage /> },
      { path: 'employees', element: <EmployeesListPage /> },
      { path: 'employees/new', element: <NewEmployeePage /> },
      { path: 'employees/:id', element: <EmployeeProfilePage /> },
      { path: 'lookups', element: <LookupsPage /> },
      { path: 'document-categories', element: <DocumentCategoriesPage /> },
      { path: 'tasks', element: <TasksPage /> },
      { path: 'notifications', element: <NotificationsPage /> },
      { path: 'schedules', element: <SchedulesPage /> },
      { path: 'holidays', element: <HolidaysPage /> },
      { path: 'workflow-definitions', element: <WorkflowDefinitionsPage /> },
      { path: 'attendance', element: <AttendancePage /> },
      { path: 'attendance/review', element: <AttendanceReviewPage /> },
      { path: 'attendance/admin', element: <AttendanceAdminPage /> },
      { path: 'leave', element: <LeavePage /> },
      { path: 'leave/manage', element: <LeaveManagePage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

/** Routes the user through the sign-in steps the server requires (session state). */
function Gate() {
  const { session, loading } = useAuth();
  if (loading) {
    return (
      <Center mih="100vh">
        <Loader />
      </Center>
    );
  }
  if (!session) return <LoginPage />;
  switch (session.state) {
    case 'mfa_required':
      return <MfaVerifyPage />;
    case 'password_change_required':
      return <ChangePasswordPage />;
    case 'mfa_setup_required':
      return <MfaSetupPage />;
    default:
      return <RouterProvider router={router} />;
  }
}

function Root() {
  const { settings } = useAuth();
  const dir = settings.language === 'ar' ? 'rtl' : 'ltr';
  return (
    <DirectionProvider initialDirection={dir} detectDirection key={dir}>
      <MantineProvider theme={theme} defaultColorScheme="light">
        <Notifications position={dir === 'rtl' ? 'top-left' : 'top-right'} />
        <Gate />
      </MantineProvider>
    </DirectionProvider>
  );
}

// Service worker for Web Push only (no offline caching of HR data).
void registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Root />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
