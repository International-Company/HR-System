import { Body, Controller, Get, Inject, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import multer from 'multer';
import { z } from 'zod';
import {
  balanceAdjustInput,
  leaveCancelInput,
  leaveRequestInput,
  leaveTypeInput,
  leaveTypeUpdateInput,
  permissionRequestInput,
} from '@hrms/shared';
import { assertUuid, parse } from '../common/errors.js';
import type { Principal } from '../access/principal.js';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators.js';
import type { UploadedFile as File } from '../documents/documents.service.js';
import { LeaveService } from './leave.service.js';

const upload = FileInterceptor('file', { storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 10, fieldSize: 10_000 } });
const rangeQuery = z.object({ companyId: z.uuid(), from: z.iso.date(), to: z.iso.date() });
/** Multipart fields arrive as strings. */
const requestFields = leaveRequestInput.extend({ employeeId: z.uuid().optional().or(z.literal('').transform(() => undefined)) });

@Controller('leave')
export class LeaveController {
  constructor(@Inject(LeaveService) private readonly leave: LeaveService) {}

  @Get('types')
  types(@CurrentPrincipal() p: Principal) {
    return this.leave.listTypes(p);
  }

  @Post('types')
  @RequirePermission('leave.types.manage')
  createType(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.leave.createType(p, parse(leaveTypeInput, body));
  }

  @Patch('types/:id')
  @RequirePermission('leave.types.manage')
  updateType(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.leave.updateType(p, assertUuid(id, 'Leave type'), parse(leaveTypeUpdateInput, body));
  }

  @Get('employees/:id/balances')
  balances(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.leave.balances(p, assertUuid(id, 'Employee'));
  }

  @Get('employees/:id/ledger')
  ledger(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Query('leaveTypeId') typeId: string) {
    return this.leave.ledger(p, assertUuid(id, 'Employee'), assertUuid(typeId ?? '', 'Leave type'));
  }

  @Post('balances/adjust')
  @RequirePermission('leave.balance.adjust')
  async adjust(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    await this.leave.adjust(p, parse(balanceAdjustInput, body));
    return { ok: true };
  }

  @Get('employees/:id/requests')
  employeeRequests(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.leave.employeeRequests(p, assertUuid(id, 'Employee'));
  }

  @Get('requests')
  @RequirePermission('leave.request.view')
  companyRequests(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    const { companyId, from, to } = parse(rangeQuery, q);
    return this.leave.companyRequests(p, companyId, from, to);
  }

  @Get('requests/:id')
  getRequest(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.leave.getRequest(p, assertUuid(id, 'Leave request'));
  }

  @Post('requests')
  @UseInterceptors(upload)
  request(@CurrentPrincipal() p: Principal, @Body() body: unknown, @UploadedFile() file: File | undefined) {
    return this.leave.request(p, parse(requestFields, body), file);
  }

  @Post('requests/:id/cancel')
  cancel(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.leave.cancel(p, assertUuid(id, 'Leave request'), parse(leaveCancelInput, body).reason);
  }

  @Get('employees/:id/permissions')
  employeePermissions(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.leave.employeePermissions(p, assertUuid(id, 'Employee'));
  }

  @Post('permissions')
  requestPermission(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.leave.requestPermission(p, parse(permissionRequestInput, body));
  }

  @Post('permissions/:id/cancel')
  cancelPermission(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.leave.cancelPermission(p, assertUuid(id, 'Permission'));
  }
}
