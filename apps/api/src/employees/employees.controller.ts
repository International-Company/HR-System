import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  assignmentChangeInput,
  bankAccountInput,
  compensationChangeInput,
  employeeCreateInput,
  employeeListQuery,
  linkUserInput,
  personalUpdateInput,
  qualificationInput,
  statusChangeInput,
} from '@hrms/shared';
import { assertUuid, parse } from '../common/errors.js';
import type { Principal } from '../access/principal.js';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators.js';
import { EmployeesService } from './employees.service.js';

const eid = (id: string) => assertUuid(id, 'Employee');

@Controller('employees')
export class EmployeesController {
  constructor(@Inject(EmployeesService) private readonly employees: EmployeesService) {}

  @Get()
  @RequirePermission('employee.profile.view')
  list(@CurrentPrincipal() p: Principal, @Query() query: unknown) {
    return this.employees.list(p, parse(employeeListQuery, query));
  }

  @Get(':id')
  @RequirePermission('employee.profile.view')
  get(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.employees.get(p, eid(id));
  }

  @Post()
  @RequirePermission('employee.profile.create')
  create(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.employees.create(p, parse(employeeCreateInput, body));
  }

  @Patch(':id')
  @RequirePermission('employee.profile.edit')
  updatePersonal(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.employees.updatePersonal(p, eid(id), parse(personalUpdateInput, body));
  }

  @Post(':id/assignments')
  @RequirePermission('employee.lifecycle.manage')
  changeAssignment(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.employees.changeAssignment(p, eid(id), parse(assignmentChangeInput, body));
  }

  @Post(':id/compensation')
  @RequirePermission('employee.financial.edit')
  changeCompensation(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.employees.changeCompensation(p, eid(id), parse(compensationChangeInput, body));
  }

  @Post(':id/status')
  @RequirePermission('employee.lifecycle.manage')
  changeStatus(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.employees.changeStatus(p, eid(id), parse(statusChangeInput, body));
  }

  @Get(':id/history')
  @RequirePermission('employee.profile.view')
  history(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.employees.history(p, eid(id));
  }

  @Get(':id/qualifications')
  @RequirePermission('employee.profile.view')
  qualifications(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.employees.listQualifications(p, eid(id));
  }

  @Post(':id/qualifications')
  @RequirePermission('employee.profile.edit')
  addQualification(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.employees.addQualification(p, eid(id), parse(qualificationInput, body));
  }

  @Delete(':id/qualifications/:qid')
  @HttpCode(204)
  @RequirePermission('employee.profile.edit')
  async removeQualification(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Param('qid') qid: string) {
    await this.employees.removeQualification(p, eid(id), assertUuid(qid, 'Qualification'));
  }

  @Get(':id/bank-accounts')
  @RequirePermission('employee.profile.view')
  bankAccounts(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.employees.listBankAccounts(p, eid(id));
  }

  @Post(':id/bank-accounts')
  @HttpCode(204)
  @RequirePermission('employee.financial.edit')
  async addBank(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    await this.employees.addBankAccount(p, eid(id), parse(bankAccountInput, body));
  }

  @Post(':id/bank-accounts/:bid/deactivate')
  @HttpCode(204)
  @RequirePermission('employee.financial.edit')
  async deactivateBank(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Param('bid') bid: string) {
    await this.employees.deactivateBankAccount(p, eid(id), assertUuid(bid, 'Bank account'));
  }

  @Put(':id/user')
  @HttpCode(204)
  @RequirePermission('employee.account.link')
  async linkUser(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    await this.employees.linkUser(p, eid(id), parse(linkUserInput, body).userId);
  }
}
