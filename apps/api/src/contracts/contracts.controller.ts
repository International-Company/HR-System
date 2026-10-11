import { Body, Controller, Get, Inject, Param, Patch, Post, Put, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import multer from 'multer';
import {
  addendumInput,
  contractClauseInput,
  contractClauseUpdateInput,
  contractCreateInput,
  contractDraftUpdateInput,
  contractSearchQuery,
  contractTemplateInput,
  contractTemplateUpdateInput,
  contractTypePolicySchema,
  endContractInput,
  probationOutcomeInput,
  renewInput,
  signInput,
} from '@hrms/shared';
import { assertUuid, parse } from '../common/errors.js';
import type { Principal } from '../access/principal.js';
import { CurrentPrincipal, RequirePermission, type AuthedRequest } from '../auth/decorators.js';
import type { UploadedFile as File } from '../documents/documents.service.js';
import { ContractsService } from './contracts.service.js';

const upload = FileInterceptor('file', {
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 10, fieldSize: 10_000 },
});

@Controller('contracts')
export class ContractsController {
  constructor(@Inject(ContractsService) private readonly contracts: ContractsService) {}

  // --- configuration ---------------------------------------------------------------------

  @Get('type-policies')
  typePolicies(@CurrentPrincipal() p: Principal) {
    return this.contracts.typePolicies(p);
  }

  @Put('type-policies/:id')
  @RequirePermission('contracts.templates.manage')
  async setTypePolicy(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    await this.contracts.setTypePolicy(p, assertUuid(id, 'Contract type'), parse(contractTypePolicySchema, body));
    return { ok: true };
  }

  @Get('templates')
  templates(@CurrentPrincipal() p: Principal) {
    return this.contracts.listTemplates(p);
  }

  @Post('templates')
  @RequirePermission('contracts.templates.manage')
  createTemplate(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.contracts.createTemplate(p, parse(contractTemplateInput, body));
  }

  @Patch('templates/:id')
  @RequirePermission('contracts.templates.manage')
  updateTemplate(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.contracts.updateTemplate(p, assertUuid(id, 'Template'), parse(contractTemplateUpdateInput, body));
  }

  @Get('clauses')
  clauses(@CurrentPrincipal() p: Principal) {
    return this.contracts.listClauses(p);
  }

  @Post('clauses')
  @RequirePermission('contracts.templates.manage')
  createClause(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.contracts.createClause(p, parse(contractClauseInput, body));
  }

  @Patch('clauses/:id')
  @RequirePermission('contracts.templates.manage')
  updateClause(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.contracts.updateClause(p, assertUuid(id, 'Clause'), parse(contractClauseUpdateInput, body));
  }

  // --- contracts ---------------------------------------------------------------------------

  @Get()
  search(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    return this.contracts.search(p, parse(contractSearchQuery, q));
  }

  @Get('to-sign')
  toSign(@CurrentPrincipal() p: Principal) {
    return this.contracts.toSign(p);
  }

  @Get('employee/:id')
  employeeContracts(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.contracts.employeeContracts(p, assertUuid(id, 'Employee'));
  }

  @Get(':id')
  get(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.contracts.get(p, assertUuid(id, 'Contract'));
  }

  @Post()
  @RequirePermission('contracts.manage')
  create(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.contracts.create(p, parse(contractCreateInput, body));
  }

  @Put(':id/draft')
  @RequirePermission('contracts.manage')
  updateDraft(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.contracts.updateDraft(p, assertUuid(id, 'Contract'), parse(contractDraftUpdateInput, body));
  }

  @Post(':id/versions/:vid/send')
  @RequirePermission('contracts.manage')
  send(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Param('vid') vid: string) {
    return this.contracts.send(p, assertUuid(id, 'Contract'), assertUuid(vid, 'Version'));
  }

  @Post(':id/versions/:vid/cancel')
  @RequirePermission('contracts.manage')
  cancelVersion(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Param('vid') vid: string) {
    return this.contracts.cancelVersion(p, assertUuid(id, 'Contract'), assertUuid(vid, 'Version'));
  }

  @Post(':id/versions/:vid/signed-copy')
  @RequirePermission('contracts.manage')
  @UseInterceptors(upload)
  signedCopy(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Param('vid') vid: string, @UploadedFile() file: File | undefined) {
    return this.contracts.uploadSignedCopy(p, assertUuid(id, 'Contract'), assertUuid(vid, 'Version'), file);
  }

  @Post('signatures/:sid/sign')
  sign(@CurrentPrincipal() p: Principal, @Param('sid') sid: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    return this.contracts.sign(p, assertUuid(sid, 'Signature'), parse(signInput, body), {
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @Post(':id/addenda')
  @RequirePermission('contracts.manage')
  addendum(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.contracts.addendum(p, assertUuid(id, 'Contract'), parse(addendumInput, body));
  }

  @Post(':id/renew')
  @RequirePermission('contracts.manage')
  renew(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.contracts.renew(p, assertUuid(id, 'Contract'), parse(renewInput, body));
  }

  @Post(':id/end')
  @RequirePermission('contracts.manage')
  end(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.contracts.end(p, assertUuid(id, 'Contract'), parse(endContractInput, body));
  }

  @Post(':id/probation')
  @RequirePermission('contracts.manage')
  probation(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.contracts.probation(p, assertUuid(id, 'Contract'), parse(probationOutcomeInput, body));
  }
}
