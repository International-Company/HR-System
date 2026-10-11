import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import multer from 'multer';
import type { Response } from 'express';
import { documentCategoryInput, documentCategoryUpdateInput, documentUploadFields } from '@hrms/shared';
import { z } from 'zod';
import { assertUuid, parse } from '../common/errors.js';
import type { Principal } from '../access/principal.js';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators.js';
import { DocumentsService, type UploadedFile as File } from './documents.service.js';

/** Hard cap for any upload; categories and settings impose stricter limits. */
const upload = FileInterceptor('file', {
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 10, fieldSize: 10_000 },
});

export function sendFile(res: Response, file: { body: Buffer; mime: string; fileName: string }, inline: boolean) {
  res.setHeader('Content-Type', file.mime);
  res.setHeader('Content-Length', String(file.body.length));
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="file"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  // Uploaded content can never run script in our origin.
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.end(file.body);
}

@Controller()
export class DocumentsController {
  constructor(@Inject(DocumentsService) private readonly documents: DocumentsService) {}

  @Get('document-categories')
  categories(@CurrentPrincipal() p: Principal) {
    return this.documents.listCategories(p);
  }

  @Post('document-categories')
  @RequirePermission('documents.categories.manage')
  createCategory(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.documents.createCategory(p, parse(documentCategoryInput, body));
  }

  @Patch('document-categories/:id')
  @RequirePermission('documents.categories.manage')
  updateCategory(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.documents.updateCategory(p, assertUuid(id, 'Category'), parse(documentCategoryUpdateInput, body));
  }

  @Get('employees/:id/documents')
  @RequirePermission('documents.view')
  list(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.documents.listForEmployee(p, assertUuid(id, 'Employee'));
  }

  @Post('employees/:id/documents')
  @RequirePermission('documents.upload')
  @UseInterceptors(upload)
  upload(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
    @UploadedFile() file: File | undefined,
  ) {
    return this.documents.upload(p, assertUuid(id, 'Employee'), parse(documentUploadFields, body), file);
  }

  @Post('employees/:id/photo')
  @RequirePermission('documents.upload')
  @UseInterceptors(upload)
  uploadPhoto(@CurrentPrincipal() p: Principal, @Param('id') id: string, @UploadedFile() file: File | undefined) {
    return this.documents.upload(
      p,
      assertUuid(id, 'Employee'),
      { categoryId: '00000000-0000-0000-0000-000000000000', title: 'Photo' },
      file,
      { categoryCode: 'photo' },
    );
  }

  @Get('employees/:id/photo')
  @RequirePermission('employee.profile.view')
  async photo(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Res() res: Response) {
    sendFile(res, await this.documents.photo(p, assertUuid(id, 'Employee')), true);
  }

  @Get('documents/:id/content')
  @RequirePermission('documents.view')
  async content(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Res() res: Response) {
    sendFile(res, await this.documents.content(p, assertUuid(id, 'Document')), false);
  }

  @Post('documents/:id/replace')
  @RequirePermission('documents.upload')
  @UseInterceptors(upload)
  replace(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
    @UploadedFile() file: File | undefined,
  ) {
    const fields = parse(z.object({ title: z.string().trim().max(200).optional() }), body);
    return this.documents.replace(p, assertUuid(id, 'Document'), file, fields.title);
  }

  @Post('documents/:id/delete')
  @HttpCode(204)
  @RequirePermission('documents.delete')
  async remove(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    await this.documents.setDeleted(p, assertUuid(id, 'Document'), true);
  }

  @Post('documents/:id/restore')
  @HttpCode(204)
  @RequirePermission('documents.delete')
  async restore(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    await this.documents.setDeleted(p, assertUuid(id, 'Document'), false);
  }
}
