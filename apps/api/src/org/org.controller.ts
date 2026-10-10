import { Body, Controller, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import {
  companyCreateInput,
  companyUpdateInput,
  departmentCreateInput,
  departmentUpdateInput,
  groupUpdateInput,
  locationCreateInput,
  locationUpdateInput,
} from '@hrms/shared';
import { assertUuid, parse } from '../common/errors.js';
import type { Principal } from '../access/principal.js';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators.js';
import { OrgService } from './org.service.js';

@Controller()
export class OrgController {
  constructor(@Inject(OrgService) private readonly org: OrgService) {}

  @Get('group')
  getGroup(@CurrentPrincipal() p: Principal) {
    return this.org.getGroup(p);
  }

  @Patch('group')
  @RequirePermission('settings.manage.general')
  updateGroup(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.org.updateGroup(p, parse(groupUpdateInput, body));
  }

  @Get('companies')
  @RequirePermission('org.company.view')
  listCompanies(@CurrentPrincipal() p: Principal) {
    return this.org.listCompanies(p);
  }

  @Get('companies/:id')
  @RequirePermission('org.company.view')
  getCompany(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.org.getCompany(p, assertUuid(id, 'Company'));
  }

  @Post('companies')
  @RequirePermission('org.company.create')
  createCompany(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.org.createCompany(p, parse(companyCreateInput, body));
  }

  @Patch('companies/:id')
  @RequirePermission('org.company.edit')
  updateCompany(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.org.updateCompany(p, assertUuid(id, 'Company'), parse(companyUpdateInput, body));
  }

  @Get('companies/:id/departments')
  @RequirePermission('org.department.view')
  listDepartments(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.org.listDepartments(p, assertUuid(id, 'Company'));
  }

  @Post('companies/:id/departments')
  @RequirePermission('org.department.manage')
  createDepartment(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.org.createDepartment(p, assertUuid(id, 'Company'), parse(departmentCreateInput, body));
  }

  @Patch('departments/:id')
  @RequirePermission('org.department.manage')
  updateDepartment(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.org.updateDepartment(p, assertUuid(id, 'Department'), parse(departmentUpdateInput, body));
  }

  @Get('companies/:id/locations')
  @RequirePermission('org.location.view')
  listLocations(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.org.listLocations(p, assertUuid(id, 'Company'));
  }

  @Post('companies/:id/locations')
  @RequirePermission('org.location.manage')
  createLocation(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.org.createLocation(p, assertUuid(id, 'Company'), parse(locationCreateInput, body));
  }

  @Patch('locations/:id')
  @RequirePermission('org.location.manage')
  updateLocation(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.org.updateLocation(p, assertUuid(id, 'Work location'), parse(locationUpdateInput, body));
  }
}
