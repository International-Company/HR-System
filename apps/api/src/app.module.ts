import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import type { AppConfig } from './config.js';
import type { Database } from './db/database.js';
import { Encryptor } from './common/crypto.js';
import { BACKUP_STORAGE, CONFIG, DATABASE, ENCRYPTOR, FILE_STORAGE } from './common/tokens.js';
import { ProblemFilter } from './common/problem.filter.js';
import { AuditService } from './audit/audit.service.js';
import { AuditController } from './audit/audit.controller.js';
import { PolicyService } from './access/policy.service.js';
import { RolesService } from './access/roles.service.js';
import { RolesController } from './access/roles.controller.js';
import { SettingsService } from './settings/settings.service.js';
import { ModulesService } from './settings/modules.service.js';
import { SettingsController } from './settings/settings.controller.js';
import { PasswordService } from './auth/password.service.js';
import { SessionService } from './auth/session.service.js';
import { LockoutService } from './auth/lockout.service.js';
import { AuthService } from './auth/auth.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { OrgService } from './org/org.service.js';
import { OrgController } from './org/org.controller.js';
import { UsersService } from './users/users.service.js';
import { UsersController } from './users/users.controller.js';
import { HealthController } from './health/health.controller.js';
import { BackupService } from './backup/backup.service.js';
import { BackupController } from './backup/backup.controller.js';
import { filesStorageFromConfig, storageFromConfig, type StoragePort } from './backup/storage.js';
import { LookupsController, LookupsService } from './employees/lookups.service.js';
import { EmployeesService } from './employees/employees.service.js';
import { EmployeesController } from './employees/employees.controller.js';
import { DocumentsService } from './documents/documents.service.js';
import { DocumentsController } from './documents/documents.controller.js';
import { NotificationsService, PUSH_SENDER, WebPushSender, type PushSender } from './notifications/notifications.service.js';
import { NotificationsController } from './notifications/notifications.controller.js';
import { WorkflowService } from './workflow/workflow.service.js';
import { WorkflowController } from './workflow/workflow.controller.js';
import { CalendarService } from './calendar/calendar.service.js';
import { CalendarController } from './calendar/calendar.controller.js';
import { RestoreService } from './backup/restore.service.js';
import { AttendanceService } from './attendance/attendance.service.js';
import { DevicesService } from './attendance/devices.service.js';
import { AttendanceController } from './attendance/attendance.controller.js';
import { LeaveService } from './leave/leave.service.js';
import { LeaveController } from './leave/leave.controller.js';
import { ContractsService } from './contracts/contracts.service.js';
import { ContractsController } from './contracts/contracts.controller.js';
import { PayrollService } from './payroll/payroll.service.js';
import { PayrollController } from './payroll/payroll.controller.js';
import { SeparationService } from './separation/separation.service.js';
import { SeparationController } from './separation/separation.controller.js';
import { RecruitmentService } from './recruitment/recruitment.service.js';
import { RecruitmentController } from './recruitment/recruitment.controller.js';
import { EvaluationService } from './evaluation/evaluation.service.js';
import { EvaluationController } from './evaluation/evaluation.controller.js';
import { ReportsService } from './reports/reports.service.js';
import { DashboardService } from './reports/dashboard.service.js';
import { ReportsController } from './reports/reports.controller.js';

export interface AppDeps {
  config: AppConfig;
  database: Database;
  backupStorage?: StoragePort | null;
  fileStorage?: StoragePort | null;
  pushSender?: PushSender;
}

/** Shared providers (used by the web app and the worker). */
export function coreProviders(deps: AppDeps) {
  return [
    { provide: CONFIG, useValue: deps.config },
    { provide: DATABASE, useValue: deps.database },
    { provide: ENCRYPTOR, useValue: Encryptor.fromConfig(deps.config) },
    {
      provide: BACKUP_STORAGE,
      useValue: deps.backupStorage !== undefined ? deps.backupStorage : storageFromConfig(deps.config),
    },
    {
      provide: FILE_STORAGE,
      useValue: deps.fileStorage !== undefined ? deps.fileStorage : filesStorageFromConfig(deps.config),
    },
    { provide: PUSH_SENDER, useValue: deps.pushSender ?? new WebPushSender() },
    AuditService,
    PolicyService,
    SettingsService,
    ModulesService,
    PasswordService,
    SessionService,
    LockoutService,
    BackupService,
    NotificationsService,
    RestoreService,
    WorkflowService,
    EmployeesService,
    CalendarService,
    DevicesService,
    AttendanceService,
    DocumentsService,
    LeaveService,
    ContractsService,
    PayrollService,
    SeparationService,
    RecruitmentService,
    EvaluationService,
    ReportsService,
    DashboardService,
  ];
}

@Module({})
export class AppModule {
  static register(deps: AppDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        AuthController,
        OrgController,
        UsersController,
        RolesController,
        SettingsController,
        AuditController,
        BackupController,
        LookupsController,
        EmployeesController,
        DocumentsController,
        NotificationsController,
        WorkflowController,
        CalendarController,
        AttendanceController,
        LeaveController,
        ContractsController,
        PayrollController,
        SeparationController,
        RecruitmentController,
        EvaluationController,
        ReportsController,
      ],
      providers: [
        ...coreProviders(deps),
        AuthService,
        RolesService,
        OrgService,
        UsersService,
        LookupsService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
    };
  }
}

@Module({})
export class WorkerModule {
  static register(deps: AppDeps): DynamicModule {
    return { module: WorkerModule, providers: coreProviders(deps) };
  }
}
