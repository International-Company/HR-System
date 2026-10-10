import { Body, Controller, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { roleCreateInput, roleUpdateInput } from '@hrms/shared';
import { assertUuid, parse } from '../common/errors.js';
import type { Principal } from './principal.js';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators.js';
import { RolesService } from './roles.service.js';

const copyInput = roleCreateInput.pick({ key: true, nameAr: true, nameEn: true });

@Controller()
export class RolesController {
  constructor(@Inject(RolesService) private readonly roles: RolesService) {}

  @Get('permissions')
  @RequirePermission('access.role.view')
  catalogue() {
    return this.roles.catalogue();
  }

  @Get('roles')
  @RequirePermission('access.role.view')
  list(@CurrentPrincipal() p: Principal) {
    return this.roles.list(p);
  }

  @Post('roles')
  @RequirePermission('access.role.manage')
  create(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.roles.create(p, parse(roleCreateInput, body));
  }

  @Patch('roles/:id')
  @RequirePermission('access.role.manage')
  update(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.roles.update(p, assertUuid(id, 'Role'), parse(roleUpdateInput, body));
  }

  @Post('roles/:id/copy')
  @RequirePermission('access.role.manage')
  copy(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.roles.copy(p, assertUuid(id, 'Role'), parse(copyInput, body));
  }
}
