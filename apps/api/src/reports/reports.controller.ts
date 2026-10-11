import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { reportRunInput, savedReportInput } from '@hrms/shared';
import { assertUuid, parse } from '../common/errors.js';
import type { Principal } from '../access/principal.js';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators.js';
import { ReportsService, type ExportFile } from './reports.service.js';
import { DashboardService } from './dashboard.service.js';

const formatQuery = z.object({ format: z.enum(['xlsx', 'csv']).default('xlsx') });
const searchQuery = z.object({ q: z.string().max(100).default('') });
const datasetsQuery = z.object({ companyId: z.uuid().optional() });

function sendDownload(res: Response, file: ExportFile) {
  res.setHeader('Content-Type', file.mime);
  res.setHeader('Content-Length', String(file.body.length));
  res.setHeader('Content-Disposition', `attachment; filename="report"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(file.body);
}

@Controller()
export class ReportsController {
  constructor(
    @Inject(ReportsService) private readonly reports: ReportsService,
    @Inject(DashboardService) private readonly dashboard: DashboardService,
  ) {}

  @Get('reports/datasets')
  @RequirePermission('reports.run')
  datasets(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    return this.reports.catalogue(p, parse(datasetsQuery, q).companyId);
  }

  @Post('reports/run')
  @HttpCode(200)
  @RequirePermission('reports.run')
  run(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.reports.run(p, parse(reportRunInput, body));
  }

  @Post('reports/export')
  @RequirePermission('reports.export')
  async export(@CurrentPrincipal() p: Principal, @Body() body: unknown, @Query() q: unknown, @Res() res: Response) {
    sendDownload(res, await this.reports.export(p, parse(reportRunInput, body), parse(formatQuery, q).format));
  }

  @Get('reports/saved')
  saved(@CurrentPrincipal() p: Principal) {
    return this.reports.listSaved(p);
  }

  @Post('reports/saved')
  @RequirePermission('reports.run')
  create(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.reports.save(p, parse(savedReportInput, body));
  }

  @Put('reports/saved/:id')
  @RequirePermission('reports.run')
  update(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.reports.save(p, parse(savedReportInput, body), assertUuid(id, 'Report'));
  }

  @Delete('reports/saved/:id')
  @HttpCode(204)
  async remove(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    await this.reports.remove(p, assertUuid(id, 'Report'));
  }

  @Get('reports/outputs')
  outputs(@CurrentPrincipal() p: Principal) {
    return this.reports.outputs(p);
  }

  @Get('reports/outputs/:id')
  async output(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Res() res: Response) {
    sendDownload(res, await this.reports.output(p, assertUuid(id, 'Report file')));
  }

  @Get('search')
  search(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    return this.dashboard.search(p, parse(searchQuery, q).q);
  }

  @Get('dashboard')
  widgets(@CurrentPrincipal() p: Principal) {
    return this.dashboard.widgets(p);
  }
}
