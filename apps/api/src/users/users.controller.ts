import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import {
  assignmentCreateInput,
  resetPasswordInput,
  userCreateInput,
  userStatusInput,
  userUpdateInput,
} from '@hrms/shared';
import { assertUuid, parse } from '../common/errors.js';
import type { Principal } from '../access/principal.js';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators.js';
import { UsersService } from './users.service.js';

@Controller('users')
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get()
  @RequirePermission('identity.user.view')
  list(@CurrentPrincipal() p: Principal, @Query('q') q?: string) {
    return this.users.list(p, typeof q === 'string' ? q.slice(0, 100) : undefined);
  }

  @Get(':id')
  @RequirePermission('identity.user.view')
  get(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.users.get(p, assertUuid(id, 'User'));
  }

  @Post()
  @RequirePermission('identity.user.create')
  create(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.users.create(p, parse(userCreateInput, body));
  }

  @Patch(':id')
  @RequirePermission('identity.user.edit')
  update(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.users.update(p, assertUuid(id, 'User'), parse(userUpdateInput, body));
  }

  @Post(':id/status')
  @RequirePermission('identity.user.disable')
  setStatus(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(userStatusInput, body);
    return this.users.setStatus(p, assertUuid(id, 'User'), input.status, input.reason);
  }

  @Post(':id/reset-password')
  @HttpCode(204)
  @RequirePermission('identity.user.reset_credentials')
  async resetPassword(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    await this.users.resetPassword(p, assertUuid(id, 'User'), parse(resetPasswordInput, body).temporaryPassword);
  }

  @Post(':id/reset-mfa')
  @HttpCode(204)
  @RequirePermission('identity.user.reset_credentials')
  async resetMfa(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    await this.users.resetMfa(p, assertUuid(id, 'User'));
  }

  @Post(':id/unlock')
  @HttpCode(204)
  @RequirePermission('identity.user.reset_credentials')
  async unlock(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    await this.users.unlock(p, assertUuid(id, 'User'));
  }

  @Get(':id/sessions')
  @RequirePermission('identity.session.view')
  sessions(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.users.listSessions(p, assertUuid(id, 'User'));
  }

  @Post(':id/sessions/revoke-all')
  @HttpCode(204)
  @RequirePermission('identity.session.revoke')
  async revokeAll(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    await this.users.revokeSession(p, assertUuid(id, 'User'), null);
  }

  @Delete(':id/sessions/:sid')
  @HttpCode(204)
  @RequirePermission('identity.session.revoke')
  async revokeOne(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Param('sid') sid: string) {
    await this.users.revokeSession(p, assertUuid(id, 'User'), assertUuid(sid, 'Session'));
  }

  @Get(':id/assignments')
  @RequirePermission('access.assignment.view')
  assignments(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.users.listAssignments(p, assertUuid(id, 'User'));
  }

  @Post(':id/assignments')
  @HttpCode(204)
  @RequirePermission('access.assignment.manage')
  async addAssignment(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    await this.users.addAssignment(p, assertUuid(id, 'User'), parse(assignmentCreateInput, body));
  }

  @Delete(':id/assignments/:aid')
  @HttpCode(204)
  @RequirePermission('access.assignment.manage')
  async endAssignment(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Param('aid') aid: string) {
    await this.users.endAssignment(p, assertUuid(id, 'User'), assertUuid(aid, 'Assignment'));
  }
}
