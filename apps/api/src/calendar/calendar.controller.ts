import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { holidayInput, scheduleAssignmentInput, scheduleInput, scheduleUpdateInput } from '@hrms/shared';
import { assertUuid, parse } from '../common/errors.js';
import type { Principal } from '../access/principal.js';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators.js';
import { CalendarService } from './calendar.service.js';

const rangeQuery = z.object({ from: z.iso.date(), to: z.iso.date() });

@Controller()
export class CalendarController {
  constructor(@Inject(CalendarService) private readonly calendar: CalendarService) {}

  @Get('schedules')
  @RequirePermission('schedules.view')
  schedules(@CurrentPrincipal() p: Principal) {
    return this.calendar.listSchedules(p);
  }

  @Post('schedules')
  @RequirePermission('schedules.manage')
  create(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.calendar.createSchedule(p, parse(scheduleInput, body));
  }

  @Patch('schedules/:id')
  @RequirePermission('schedules.manage')
  update(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.calendar.updateSchedule(p, assertUuid(id, 'Schedule'), parse(scheduleUpdateInput, body));
  }

  @Get('schedule-assignments')
  @RequirePermission('schedules.view')
  assignments(@CurrentPrincipal() p: Principal, @Query('companyId') companyId: string) {
    return this.calendar.listAssignments(p, assertUuid(companyId ?? '', 'Company'));
  }

  @Post('schedule-assignments')
  @RequirePermission('schedules.manage')
  assign(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.calendar.assign(p, parse(scheduleAssignmentInput, body));
  }

  /** Holidays are readable by every signed-in user (they appear in personal calendars). */
  @Get('holidays')
  holidays(@CurrentPrincipal() p: Principal, @Query('year') year: string, @Query('companyId') companyId?: string) {
    const y = Number(year) || new Date().getFullYear();
    return this.calendar.listHolidays(p, Math.min(Math.max(y, 2000), 2100), companyId ? assertUuid(companyId, 'Company') : undefined);
  }

  @Post('holidays')
  @RequirePermission('holidays.manage')
  addHoliday(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.calendar.addHoliday(p, parse(holidayInput, body));
  }

  @Delete('holidays/:id')
  @HttpCode(204)
  @RequirePermission('holidays.manage')
  async removeHoliday(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    await this.calendar.removeHoliday(p, assertUuid(id, 'Holiday'));
  }

  @Get('employees/:id/workdays')
  workdays(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Query() query: unknown) {
    const q = parse(rangeQuery, query);
    return this.calendar.workdays(p, assertUuid(id, 'Employee'), q.from, q.to);
  }
}
