import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  applicationInput,
  candidateInput,
  candidateUpdateInput,
  convertInput,
  interviewInput,
  interviewResultInput,
  noteInput,
  offerInput,
  offerStatusInput,
  stageChangeInput,
  vacancyInput,
  vacancyUpdateInput,
} from '@hrms/shared';
import { assertUuid, parse } from '../common/errors.js';
import type { Principal } from '../access/principal.js';
import { CurrentPrincipal } from '../auth/decorators.js';
import type { UploadedFile as File } from '../documents/documents.service.js';
import { sendFile } from '../documents/documents.controller.js';
import { RecruitmentService } from './recruitment.service.js';

const upload = FileInterceptor('file', { storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 10, fieldSize: 10_000 } });
const companyQuery = z.object({ companyId: z.uuid(), q: z.string().trim().max(100).optional() });
const fileFields = z.object({ categoryId: z.uuid(), title: z.string().trim().min(1).max(200) });

/** Access is decided per company and per interview in the service (REC-*). */
@Controller('recruitment')
export class RecruitmentController {
  constructor(@Inject(RecruitmentService) private readonly recruitment: RecruitmentService) {}

  @Get('stages')
  stages() {
    return this.recruitment.stages();
  }

  // --- vacancies ---
  @Get('vacancies')
  vacancies(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    return this.recruitment.vacancies(p, parse(companyQuery, q).companyId);
  }

  @Post('vacancies')
  createVacancy(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.recruitment.createVacancy(p, parse(vacancyInput, body));
  }

  @Get('vacancies/:id')
  vacancy(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.recruitment.vacancy(p, assertUuid(id, 'Vacancy'));
  }

  @Patch('vacancies/:id')
  updateVacancy(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.recruitment.updateVacancy(p, assertUuid(id, 'Vacancy'), parse(vacancyUpdateInput, body));
  }

  @Get('vacancies/:id/applications')
  applications(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.recruitment.applications(p, assertUuid(id, 'Vacancy'));
  }

  // --- candidates ---
  @Get('candidates')
  candidates(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    const { companyId, q: text } = parse(companyQuery, q);
    return this.recruitment.candidates(p, companyId, text);
  }

  @Post('candidates')
  createCandidate(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.recruitment.createCandidate(p, parse(candidateInput, body));
  }

  @Get('candidates/:id')
  candidate(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.recruitment.candidate(p, assertUuid(id, 'Candidate'));
  }

  @Patch('candidates/:id')
  updateCandidate(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.recruitment.updateCandidate(p, assertUuid(id, 'Candidate'), parse(candidateUpdateInput, body));
  }

  @Post('candidates/:id/files')
  @UseInterceptors(upload)
  uploadFile(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown, @UploadedFile() file: File | undefined) {
    return this.recruitment.uploadFile(p, assertUuid(id, 'Candidate'), parse(fileFields, body), file);
  }

  @Get('candidates/:id/files/:docId')
  async file(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Param('docId') docId: string, @Res() res: Response) {
    sendFile(res, await this.recruitment.file(p, assertUuid(id, 'Candidate'), assertUuid(docId, 'Document')), false);
  }

  // --- applications ---
  @Post('applications')
  apply(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    const input = parse(applicationInput, body);
    return this.recruitment.apply(p, input.vacancyId, input.candidateId);
  }

  @Get('applications/:id')
  application(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.recruitment.application(p, assertUuid(id, 'Application'));
  }

  @Post('applications/:id/stage')
  stage(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(stageChangeInput, body);
    return this.recruitment.changeStage(p, assertUuid(id, 'Application'), input.stage, input.note);
  }

  @Post('applications/:id/notes')
  note(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.recruitment.addNote(p, assertUuid(id, 'Application'), parse(noteInput, body).note);
  }

  @Post('applications/:id/interviews')
  interview(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.recruitment.scheduleInterview(p, assertUuid(id, 'Application'), parse(interviewInput, body));
  }

  @Post('interviews/:id/result')
  result(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.recruitment.recordInterview(p, assertUuid(id, 'Interview'), parse(interviewResultInput, body));
  }

  @Post('interviews/:id/cancel')
  cancelInterview(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.recruitment.cancelInterview(p, assertUuid(id, 'Interview'));
  }

  @Post('applications/:id/offers')
  offer(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.recruitment.createOffer(p, assertUuid(id, 'Application'), parse(offerInput, body));
  }

  @Post('offers/:id/submit')
  submitOffer(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.recruitment.submitOffer(p, assertUuid(id, 'Offer'));
  }

  @Post('offers/:id/status')
  offerStatus(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.recruitment.setOfferStatus(p, assertUuid(id, 'Offer'), parse(offerStatusInput, body));
  }

  @Post('applications/:id/convert')
  convert(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.recruitment.convert(p, assertUuid(id, 'Application'), parse(convertInput, body));
  }
}
