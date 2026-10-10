import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { delegationInput, taskDecisionInput, workflowStepsInput } from '@hrms/shared';
import { assertUuid, parse } from '../common/errors.js';
import type { Principal } from '../access/principal.js';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators.js';
import { WorkflowService } from './workflow.service.js';

@Controller('workflow')
export class WorkflowController {
  constructor(@Inject(WorkflowService) private readonly workflow: WorkflowService) {}

  /** Tasks assigned to me (pending) or decided by me. Personal: no permission needed. */
  @Get('tasks')
  tasks(@CurrentPrincipal() p: Principal, @Query('status') status?: string) {
    return this.workflow.myTasks(p, status === 'decided' ? 'decided' : 'pending');
  }

  @Post('tasks/:id/decision')
  decide(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(taskDecisionInput, body);
    return this.workflow.decide(p, assertUuid(id, 'Task'), input.decision, input.comment);
  }

  @Get('requests/mine')
  mine(@CurrentPrincipal() p: Principal) {
    return this.workflow.myRequests(p);
  }

  @Get('instances')
  @RequirePermission('workflow.instances.view')
  instances(@CurrentPrincipal() p: Principal, @Query('status') status?: string) {
    return this.workflow.companyInstances(p, { status: ['pending', 'approved', 'rejected', 'cancelled'].includes(status ?? '') ? status : undefined });
  }

  @Get('instances/:id')
  instance(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.workflow.getInstance(p, assertUuid(id, 'Request'));
  }

  @Post('instances/:id/cancel')
  cancel(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.workflow.cancel(p, assertUuid(id, 'Request'));
  }

  @Get('definitions')
  @RequirePermission('workflow.definitions.manage')
  definitions(@CurrentPrincipal() p: Principal) {
    return this.workflow.definitions(p);
  }

  @Put('definitions/:id/steps')
  @HttpCode(204)
  @RequirePermission('workflow.definitions.manage')
  async updateSteps(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    await this.workflow.updateSteps(p, assertUuid(id, 'Workflow'), parse(workflowStepsInput, body));
  }

  @Get('delegations')
  delegations(@CurrentPrincipal() p: Principal) {
    return this.workflow.myDelegations(p);
  }

  @Post('delegations')
  @HttpCode(204)
  async delegate(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    await this.workflow.delegate(p, parse(delegationInput, body));
  }

  @Post('delegations/:id/revoke')
  @HttpCode(204)
  async revoke(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    await this.workflow.revokeDelegation(p, assertUuid(id, 'Delegation'));
  }
}
