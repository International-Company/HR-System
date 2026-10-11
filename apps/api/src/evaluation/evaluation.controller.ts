import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { evaluationPeriod, evaluationRecalcInput, evaluationRunInput } from '@hrms/shared';
import { assertUuid, parse } from '../common/errors.js';
import type { Principal } from '../access/principal.js';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators.js';
import { EvaluationService } from './evaluation.service.js';

const listQuery = z.object({ companyId: z.uuid(), period: evaluationPeriod });

@Controller('evaluation')
export class EvaluationController {
  constructor(@Inject(EvaluationService) private readonly evaluation: EvaluationService) {}

  @Get('results')
  list(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    const { companyId, period } = parse(listQuery, q);
    return this.evaluation.list(p, companyId, period);
  }

  @Get('employees/:id')
  employee(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.evaluation.forEmployee(p, assertUuid(id, 'Employee'));
  }

  @Post('calculate')
  @RequirePermission('evaluation.manage')
  calculate(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    const { companyId, period } = parse(evaluationRunInput, body);
    return this.evaluation.calculate(p, companyId, period);
  }

  /** CEV-02: finalised results are recalculated only with a reason (audited). */
  @Post('recalculate')
  @RequirePermission('evaluation.manage')
  recalculate(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    const { companyId, period, reason } = parse(evaluationRecalcInput, body);
    return this.evaluation.calculate(p, companyId, period, reason);
  }

  @Post('finalize')
  @RequirePermission('evaluation.manage')
  finalize(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    const { companyId, period } = parse(evaluationRunInput, body);
    return this.evaluation.finalize(p, companyId, period);
  }
}
