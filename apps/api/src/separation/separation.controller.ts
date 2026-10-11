import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { SEPARATION_STATUSES, separationCancelInput, separationInput } from '@hrms/shared';
import { assertUuid, parse } from '../common/errors.js';
import type { Principal } from '../access/principal.js';
import { CurrentPrincipal } from '../auth/decorators.js';
import { SeparationService } from './separation.service.js';

const listQuery = z.object({ companyId: z.uuid(), status: z.enum(SEPARATION_STATUSES).optional() });
const eligibilityInput = z.object({ rehireEligible: z.boolean() });

@Controller('separations')
export class SeparationController {
  constructor(@Inject(SeparationService) private readonly separations: SeparationService) {}

  @Get()
  list(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    const { companyId, status } = parse(listQuery, q);
    return this.separations.list(p, companyId, status);
  }

  @Get('employee/:id')
  employee(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.separations.employeeSeparations(p, assertUuid(id, 'Employee'));
  }

  @Get(':id')
  get(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.separations.get(p, assertUuid(id, 'Separation'));
  }

  /** Own resignation (self-service) or a separation started by HR; checked in the service. */
  @Post()
  request(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.separations.request(p, parse(separationInput, body));
  }

  @Post(':id/cancel')
  cancel(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.separations.cancel(p, assertUuid(id, 'Separation'), parse(separationCancelInput, body).reason);
  }

  @Post(':id/eligibility')
  eligibility(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.separations.setEligibility(p, assertUuid(id, 'Separation'), parse(eligibilityInput, body).rehireEligible);
  }
}
