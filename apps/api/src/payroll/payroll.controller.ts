import { Body, Controller, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { eosQuery, fxRatesInput, manualItemInput, paymentInput, reopenInput, runCreateInput } from '@hrms/shared';
import { assertUuid, parse } from '../common/errors.js';
import type { Principal } from '../access/principal.js';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators.js';
import { PayrollService } from './payroll.service.js';

const periodQuery = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) });
const companyQuery = z.object({ companyId: z.uuid() });

@Controller('payroll')
export class PayrollController {
  constructor(@Inject(PayrollService) private readonly payroll: PayrollService) {}

  @Get('runs')
  list(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    return this.payroll.list(p, parse(companyQuery, q).companyId);
  }

  @Post('runs')
  @RequirePermission('payroll.prepare')
  create(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    const input = parse(runCreateInput, body);
    return this.payroll.create(p, input.companyId, input.period);
  }

  @Get('runs/:id')
  get(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.payroll.get(p, assertUuid(id, 'Payroll run'));
  }

  @Post('runs/:id/calculate')
  @RequirePermission('payroll.prepare')
  calculate(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.payroll.calculate(p, assertUuid(id, 'Payroll run'));
  }

  @Post('runs/:id/employees/:employeeId/items')
  @RequirePermission('payroll.prepare')
  addManual(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Param('employeeId') employeeId: string, @Body() body: unknown) {
    return this.payroll.addManual(p, assertUuid(id, 'Payroll run'), assertUuid(employeeId, 'Employee'), parse(manualItemInput, body));
  }

  @Post('runs/:id/items/:itemId/remove')
  @RequirePermission('payroll.prepare')
  removeManual(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Param('itemId') itemId: string) {
    return this.payroll.removeManual(p, assertUuid(id, 'Payroll run'), assertUuid(itemId, 'Item'));
  }

  @Put('runs/:id/fx-rates')
  @RequirePermission('payroll.prepare')
  fxRates(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.payroll.setFxRates(p, assertUuid(id, 'Payroll run'), parse(fxRatesInput, body));
  }

  @Post('runs/:id/submit')
  @RequirePermission('payroll.prepare')
  submit(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.payroll.submit(p, assertUuid(id, 'Payroll run'));
  }

  @Post('runs/:id/reopen')
  @RequirePermission('payroll.reopen')
  reopen(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.payroll.reopen(p, assertUuid(id, 'Payroll run'), parse(reopenInput, body).reason);
  }

  @Post('lines/:id/payments')
  @RequirePermission('payroll.payments.manage')
  payment(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.payroll.addPayment(p, assertUuid(id, 'Payroll line'), parse(paymentInput, body));
  }

  @Get('payslips/mine')
  myPayslips(@CurrentPrincipal() p: Principal) {
    return this.payroll.myPayslips(p);
  }

  @Get('payslips/:lineId')
  payslip(@CurrentPrincipal() p: Principal, @Param('lineId') lineId: string) {
    return this.payroll.payslip(p, assertUuid(lineId, 'Payslip'));
  }

  @Get('summary')
  @RequirePermission('payroll.summary.view')
  summary(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    return this.payroll.summary(p, parse(periodQuery, q).period);
  }

  @Get('end-of-service/:employeeId')
  endOfService(@CurrentPrincipal() p: Principal, @Param('employeeId') employeeId: string, @Query() q: unknown) {
    return this.payroll.endOfService(p, assertUuid(employeeId, 'Employee'), parse(eosQuery, q).endDate);
  }
}
