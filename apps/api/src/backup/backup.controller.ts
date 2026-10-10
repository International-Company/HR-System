import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { restoreRequestInput, restoreStepUpInput } from '@hrms/shared';
import { assertUuid, parse } from '../common/errors.js';
import { RestoreService } from './restore.service.js';
import type { Principal } from '../access/principal.js';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators.js';
import { BackupService } from './backup.service.js';

@Controller('backups')
export class BackupController {
  constructor(
    @Inject(BackupService) private readonly backups: BackupService,
    @Inject(RestoreService) private readonly restores: RestoreService,
  ) {}

  @Get()
  @RequirePermission('system.backup.view')
  status() {
    return this.backups.status();
  }

  @Post()
  @RequirePermission('system.backup.create')
  request(@CurrentPrincipal() p: Principal) {
    return this.backups.request(p, 'manual');
  }

  @Post('restore-tests')
  @RequirePermission('system.backup.create')
  restoreTest(@CurrentPrincipal() p: Principal) {
    return this.backups.request(p, 'restore_test');
  }

  // --- In-app restore (BKP-06) ------------------------------------------------------

  @Get('restores')
  @RequirePermission('system.backup.restore')
  async restoresList() {
    return { supported: this.restores.supported, requests: await this.restores.list() };
  }

  @Get(':id/restore-preview')
  @RequirePermission('system.backup.restore')
  preview(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.restores.preview(p, assertUuid(id, 'Backup'));
  }

  @Post('restores')
  @RequirePermission('system.backup.restore')
  requestRestore(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.restores.request(p, parse(restoreRequestInput, body));
  }

  @Post('restores/:id/approve')
  @RequirePermission('system.backup.restore')
  approve(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const s = parse(restoreStepUpInput, body);
    return this.restores.approve(p, assertUuid(id, 'Restore request'), s.password, s.code);
  }

  @Post('restores/:id/confirm')
  @RequirePermission('system.backup.restore')
  confirm(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const s = parse(restoreStepUpInput, body);
    return this.restores.confirmSwitch(p, assertUuid(id, 'Restore request'), s.password, s.code);
  }

  @Post('restores/:id/cancel')
  @RequirePermission('system.backup.restore')
  cancel(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.restores.cancel(p, assertUuid(id, 'Restore request'));
  }
}
