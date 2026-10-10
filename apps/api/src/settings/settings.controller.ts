import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Put, Query } from '@nestjs/common';
import { moduleCompanyInput, moduleUpdateInput, settingUpdateInput } from '@hrms/shared';
import { assertUuid, parse } from '../common/errors.js';
import type { Principal } from '../access/principal.js';
import { CurrentPrincipal, Public, RequirePermission } from '../auth/decorators.js';
import { SettingsService } from './settings.service.js';
import { ModulesService } from './modules.service.js';

@Controller()
export class SettingsController {
  constructor(
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ModulesService) private readonly modules: ModulesService,
  ) {}

  /** Language and formats for the login screen; contains no sensitive data. */
  @Public()
  @Get('settings/public')
  publicSettings() {
    return this.settings.publicSettings();
  }

  @Get('settings')
  @RequirePermission('settings.view')
  list(@CurrentPrincipal() p: Principal, @Query('companyId') companyId?: string) {
    return this.settings.list(p, companyId ? assertUuid(companyId, 'Company') : null);
  }

  @Put('settings/:key')
  @HttpCode(204)
  async update(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Body() body: unknown) {
    const input = parse(settingUpdateInput, body);
    await this.settings.update(p, key, input.value, input.companyId ?? null);
  }

  @Delete('settings/:key')
  @HttpCode(204)
  async resetOverride(
    @CurrentPrincipal() p: Principal,
    @Param('key') key: string,
    @Query('companyId') companyId: string,
  ) {
    await this.settings.resetOverride(p, key, assertUuid(companyId ?? '', 'Company'));
  }

  @Get('modules')
  @RequirePermission('settings.view')
  listModules(@CurrentPrincipal() p: Principal) {
    return this.modules.list(p);
  }

  @Patch('modules/:key')
  @HttpCode(204)
  @RequirePermission('settings.manage.modules')
  async updateModule(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Body() body: unknown) {
    await this.modules.updateGroup(p, key, parse(moduleUpdateInput, body));
  }

  @Put('modules/:key/companies/:companyId')
  @HttpCode(204)
  @RequirePermission('settings.manage.modules')
  async setCompany(
    @CurrentPrincipal() p: Principal,
    @Param('key') key: string,
    @Param('companyId') companyId: string,
    @Body() body: unknown,
  ) {
    const input = parse(moduleCompanyInput, body);
    await this.modules.setCompany(p, key, assertUuid(companyId, 'Company'), input.enabled);
  }
}
