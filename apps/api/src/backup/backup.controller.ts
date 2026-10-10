import { Controller, Get, Inject, Post } from '@nestjs/common';
import type { Principal } from '../access/principal.js';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators.js';
import { BackupService } from './backup.service.js';

@Controller('backups')
export class BackupController {
  constructor(@Inject(BackupService) private readonly backups: BackupService) {}

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
}
