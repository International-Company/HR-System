import { Inject, Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import type {
  DocumentCategoryDto,
  DocumentDto,
  DocumentType,
  documentCategoryInput,
  documentCategoryUpdateInput,
} from '@hrms/shared';
import { DATABASE, ENCRYPTOR, FILE_STORAGE } from '../common/tokens.js';
import type { Database, Tx } from '../db/database.js';
import { document, documentCategory, documentLink, employee, storedObject } from '../db/schema.js';
import { ApiError } from '../common/errors.js';
import { sha256, type Encryptor } from '../common/crypto.js';
import { uuidv7 } from '../common/ids.js';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { EmployeesService } from '../employees/employees.service.js';
import type { StoragePort } from '../backup/storage.js';
import { detectType, safeFileName } from './file-types.js';

type CategoryRow = typeof documentCategory.$inferSelect;
type DocumentRow = typeof document.$inferSelect;

export interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

const toCategoryDto = (c: CategoryRow): DocumentCategoryDto => ({
  id: c.id,
  code: c.code,
  nameAr: c.nameAr,
  nameEn: c.nameEn,
  allowedTypes: c.allowedTypes as DocumentType[],
  maxSizeMb: c.maxSizeMb,
  sensitivity: c.sensitivity,
  employeeVisible: c.employeeVisible,
  allowReplace: c.allowReplace,
  allowDelete: c.allowDelete,
  hasExpiry: c.hasExpiry,
  retentionYears: c.retentionYears,
  status: c.status,
  version: c.version,
});

/**
 * Document management (DOC-01..06). Metadata in PostgreSQL; contents encrypted per object
 * (D-06) in the configured object storage. No expiry notifications (DOC-04, CF-14).
 */
@Injectable()
export class DocumentsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(ENCRYPTOR) private readonly encryptor: Encryptor,
    @Inject(FILE_STORAGE) private readonly storage: StoragePort | null,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(EmployeesService) private readonly employees: EmployeesService,
  ) {}

  // --- categories ---------------------------------------------------------------------------

  async listCategories(principal: Principal): Promise<DocumentCategoryDto[]> {
    const rows = await this.database.tx(principal.rls(), (tx) =>
      tx.select().from(documentCategory).orderBy(asc(documentCategory.code)),
    );
    return rows.map(toCategoryDto);
  }

  async createCategory(principal: Principal, input: z.infer<typeof documentCategoryInput>) {
    return this.database.tx(principal.rls(), async (tx) => {
      const [row] = await tx
        .insert(documentCategory)
        .values({
          id: uuidv7(),
          code: input.code,
          nameAr: input.nameAr,
          nameEn: input.nameEn,
          allowedTypes: input.allowedTypes,
          maxSizeMb: input.maxSizeMb,
          sensitivity: input.sensitivity,
          employeeVisible: input.employeeVisible,
          allowReplace: input.allowReplace,
          allowDelete: input.allowDelete,
          hasExpiry: input.hasExpiry,
          retentionYears: input.retentionYears ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      const dto = toCategoryDto(row!);
      await this.audit.record(tx, { action: 'documents.category_created', entityType: 'document_category', entityId: dto.id, after: dto });
      return dto;
    });
  }

  async updateCategory(principal: Principal, id: string, input: z.infer<typeof documentCategoryUpdateInput>) {
    return this.database.tx(principal.rls(), async (tx) => {
      const [before] = await tx.select().from(documentCategory).where(eq(documentCategory.id, id));
      if (!before) throw ApiError.notFound('Category');
      const [after] = await tx
        .update(documentCategory)
        .set({
          nameAr: input.nameAr,
          nameEn: input.nameEn,
          allowedTypes: input.allowedTypes,
          maxSizeMb: input.maxSizeMb,
          sensitivity: input.sensitivity,
          employeeVisible: input.employeeVisible,
          allowReplace: input.allowReplace,
          allowDelete: input.allowDelete,
          hasExpiry: input.hasExpiry,
          retentionYears: input.retentionYears,
          status: input.status,
          updatedBy: principal.userId,
        })
        .where(and(eq(documentCategory.id, id), eq(documentCategory.version, input.version)))
        .returning();
      if (!after) throw ApiError.versionConflict();
      await this.audit.record(tx, {
        action: 'documents.category_updated',
        entityType: 'document_category',
        entityId: id,
        before: toCategoryDto(before),
        after: toCategoryDto(after),
      });
      return toCategoryDto(after);
    });
  }

  // --- access -------------------------------------------------------------------------------

  /** Can the principal see documents of this category for this employee? */
  private canSeeCategory(
    principal: Principal,
    cat: CategoryRow,
    ctx: { companyId: string | null; self: boolean; employeeId: string },
  ): boolean {
    const company = (perm: Parameters<Principal['canCompany']>[0]) =>
      !!ctx.companyId && principal.canCompany(perm, ctx.companyId);
    const staff =
      company('documents.view') &&
      (cat.sensitivity === 'normal' ||
        (cat.sensitivity === 'restricted' && company('documents.view.restricted')) ||
        (cat.sensitivity === 'medical' && company('documents.view.medical')));
    // C-12: employees see their own documents only in employee-visible, non-medical categories.
    const own =
      ctx.self &&
      principal.canSelf('documents.view', ctx.employeeId) &&
      cat.employeeVisible &&
      cat.sensitivity !== 'medical';
    return staff || own;
  }

  /** Which of these employee documents may the principal open? (C-12 for leave attachments.) */
  async visibleDocumentIds(tx: Tx, principal: Principal, docs: { documentId: string; employeeId: string; companyId: string }[]): Promise<Set<string>> {
    if (!docs.length) return new Set();
    const rows = await tx
      .select({ id: document.id, c: documentCategory })
      .from(document)
      .innerJoin(documentCategory, eq(documentCategory.id, document.categoryId))
      .where(inArray(document.id, docs.map((d) => d.documentId)));
    const out = new Set<string>();
    for (const d of docs) {
      const row = rows.find((r) => r.id === d.documentId);
      const self = !!principal.employeeId && principal.employeeId === d.employeeId;
      if (row && this.canSeeCategory(principal, row.c, { companyId: d.companyId, self, employeeId: d.employeeId })) out.add(d.documentId);
    }
    return out;
  }

  private async employeeContext(principal: Principal, employeeId: string) {
    const { current, access } = await this.employees.loadVisible(principal, employeeId);
    return { companyId: current?.companyId ?? null, self: access.self, employeeId };
  }

  // --- list & read ------------------------------------------------------------------------------

  async listForEmployee(principal: Principal, employeeId: string): Promise<DocumentDto[]> {
    const ctx = await this.employeeContext(principal, employeeId);
    const canDelete = !!ctx.companyId && principal.canCompany('documents.delete', ctx.companyId);
    return this.database.tx(principal.rls(), async (tx) => {
      const rows = await tx
        .select({ d: document, o: storedObject, c: documentCategory })
        .from(documentLink)
        .innerJoin(document, eq(document.id, documentLink.documentId))
        .innerJoin(storedObject, eq(storedObject.id, document.objectId))
        .innerJoin(documentCategory, eq(documentCategory.id, document.categoryId))
        .where(and(eq(documentLink.entityType, 'employee'), eq(documentLink.entityId, employeeId)))
        .orderBy(desc(document.createdAt));
      return rows
        .filter(({ d, c }) => this.canSeeCategory(principal, c, ctx) && (d.status !== 'deleted' || canDelete))
        .map(({ d, o }) => toDocumentDto(d, o));
    });
  }

  // --- linked entities other than employees (recruitment) ------------------------------------

  /** Files linked to a candidate; the caller has authorised access to the candidate. */
  async listForCandidate(tx: Tx, principal: Principal, candidateId: string): Promise<DocumentDto[]> {
    const rows = await tx
      .select({ d: document, o: storedObject, c: documentCategory })
      .from(documentLink)
      .innerJoin(document, eq(document.id, documentLink.documentId))
      .innerJoin(storedObject, eq(storedObject.id, document.objectId))
      .innerJoin(documentCategory, eq(documentCategory.id, document.categoryId))
      .where(and(eq(documentLink.entityType, 'candidate'), eq(documentLink.entityId, candidateId), eq(document.status, 'active')))
      .orderBy(desc(document.createdAt));
    return rows.filter(({ d, c }) => this.candidateCategoryVisible(principal, c, d.companyId)).map(({ d, o }) => toDocumentDto(d, o));
  }

  /** Candidate files of restricted categories (e.g. passports) need the restricted permission. */
  private candidateCategoryVisible(principal: Principal, c: CategoryRow, companyId: string): boolean {
    return c.sensitivity === 'normal' || (c.sensitivity === 'restricted' && principal.canCompany('documents.view.restricted', companyId));
  }

  /** Content of a candidate's file; the caller has authorised access to the candidate. */
  async candidateContent(principal: Principal, candidateId: string, documentId: string): Promise<{ body: Buffer; mime: string; fileName: string }> {
    const storage = this.requireStorage();
    const [row] = await this.database.tx(principal.rls(), (tx) =>
      tx
        .select({ d: document, o: storedObject, c: documentCategory })
        .from(documentLink)
        .innerJoin(document, eq(document.id, documentLink.documentId))
        .innerJoin(storedObject, eq(storedObject.id, document.objectId))
        .innerJoin(documentCategory, eq(documentCategory.id, document.categoryId))
        .where(and(eq(documentLink.entityType, 'candidate'), eq(documentLink.entityId, candidateId), eq(document.id, documentId))),
    );
    if (!row || row.d.status === 'deleted' || !this.candidateCategoryVisible(principal, row.c, row.d.companyId)) throw ApiError.notFound('Document');
    const chunks: Buffer[] = [];
    for await (const chunk of await storage.get(row.o.objectKey)) chunks.push(chunk as Buffer);
    const body = this.encryptor.decrypt(Buffer.concat(chunks), `doc:${row.o.id}`);
    if (!sha256(body).equals(row.o.sha256)) throw new Error(`Integrity check failed for object ${row.o.id}`);
    await this.audit.recordStandalone({ action: 'documents.downloaded', entityType: 'document', entityId: documentId, companyId: row.d.companyId, details: { candidateId } });
    return { body, mime: row.o.mime, fileName: safeFileName(row.d.originalName) };
  }

  /** On hiring (REC-06) the candidate's files also appear in the employee profile. */
  async linkCandidateFilesToEmployee(tx: Tx, candidateId: string, employeeId: string): Promise<number> {
    const docs = await tx.select({ id: documentLink.documentId }).from(documentLink).where(and(eq(documentLink.entityType, 'candidate'), eq(documentLink.entityId, candidateId)));
    if (docs.length) {
      await tx
        .insert(documentLink)
        .values(docs.map((d) => ({ documentId: d.id, entityType: 'employee' as const, entityId: employeeId })))
        .onConflictDoNothing();
    }
    return docs.length;
  }

  /** Decrypted content for download, after the same authorization as listing. */
  async content(principal: Principal, documentId: string): Promise<{ body: Buffer; mime: string; fileName: string }> {
    const storage = this.requireStorage();
    const found = await this.loadWithContext(principal, documentId);
    const { d, o, c, ctx } = found;
    if (d.status === 'deleted') throw ApiError.notFound('Document');
    const chunks: Buffer[] = [];
    for await (const chunk of await storage.get(o.objectKey)) chunks.push(chunk as Buffer);
    const body = this.encryptor.decrypt(Buffer.concat(chunks), `doc:${o.id}`);
    if (!sha256(body).equals(o.sha256)) throw new Error(`Integrity check failed for object ${o.id}`);
    if (c.sensitivity !== 'normal' || !ctx.self) {
      await this.audit.recordStandalone({
        action: 'documents.downloaded',
        entityType: 'document',
        entityId: d.id,
        companyId: d.companyId,
        details: { category: c.code, employeeId: ctx.employeeId },
      });
    }
    return { body, mime: o.mime, fileName: safeFileName(d.originalName) };
  }

  private async loadWithContext(principal: Principal, documentId: string) {
    const [row] = await this.database.tx(principal.rls(), (tx) =>
      tx
        .select({ d: document, o: storedObject, c: documentCategory, l: documentLink })
        .from(document)
        .innerJoin(storedObject, eq(storedObject.id, document.objectId))
        .innerJoin(documentCategory, eq(documentCategory.id, document.categoryId))
        .innerJoin(documentLink, eq(documentLink.documentId, document.id))
        .where(eq(document.id, documentId)),
    );
    if (!row || row.l.entityType !== 'employee') throw ApiError.notFound('Document');
    let ctx;
    try {
      ctx = await this.employeeContext(principal, row.l.entityId);
    } catch {
      throw ApiError.notFound('Document');
    }
    if (!this.canSeeCategory(principal, row.c, ctx)) throw ApiError.notFound('Document');
    return { ...row, ctx };
  }

  // --- upload / replace / delete -----------------------------------------------------------------------

  async upload(
    principal: Principal,
    employeeId: string,
    fields: { categoryId: string; title: string; expiryDate?: string | undefined },
    file: UploadedFile | undefined,
    /**
     * forLeave: attachment of a leave request. The leave module has already authorised the
     * submitter for this employee, and the category comes from the leave type (C-12).
     */
    opts: {
      supersedes?: DocumentRow;
      categoryCode?: string;
      forLeave?: boolean;
      /** A candidate's file (REC-02); the recruitment module has authorised the upload. */
      candidate?: { id: string; companyId: string };
    } = {},
  ): Promise<DocumentDto> {
    const storage = this.requireStorage();
    if (!file) throw ApiError.validation([{ path: 'file', message: 'A file is required' }]);
    const ctx = opts.candidate ? { companyId: opts.candidate.companyId, self: false, employeeId: '' } : await this.employeeContext(principal, employeeId);
    const trusted = opts.forLeave || !!opts.candidate;
    if (!ctx.companyId || (!trusted && !principal.canCompany('documents.upload', ctx.companyId))) throw ApiError.forbidden();

    const cat = await this.database.tx(principal.rls(), async (tx) => {
      const where = opts.categoryCode
        ? eq(documentCategory.code, opts.categoryCode)
        : eq(documentCategory.id, fields.categoryId);
      const [c] = await tx.select().from(documentCategory).where(where);
      return c;
    });
    if (!cat || cat.status !== 'active') throw ApiError.validation([{ path: 'categoryId', message: 'Unknown or inactive category' }]);
    if (opts.candidate) {
      // Candidates never get medical files; identity files need the restricted permission.
      if (cat.sensitivity === 'medical' || (cat.sensitivity === 'restricted' && !principal.canCompany('documents.view.restricted', ctx.companyId))) {
        throw ApiError.forbidden('You cannot manage documents of this category');
      }
    } else if (!opts.forLeave && !this.canSeeCategory(principal, cat, { ...ctx, self: false })) {
      throw ApiError.forbidden('You cannot manage documents of this category');
    }
    const limits = await this.settings.get('documents.limits');
    const maxBytes = Math.min(cat.maxSizeMb, limits.maxUploadMb) * 1024 * 1024;
    if (file.size > maxBytes || file.buffer.length > maxBytes) {
      throw ApiError.validation([{ path: 'file', message: `File exceeds ${Math.round(maxBytes / 1048576)} MB` }]);
    }
    if (file.buffer.length === 0) throw ApiError.validation([{ path: 'file', message: 'The file is empty' }]);
    const detected = detectType(file.originalname, file.buffer, cat.allowedTypes);
    if (!detected) {
      throw ApiError.validation([
        { path: 'file', message: `File type not allowed. Allowed: ${cat.allowedTypes.join(', ')}` },
      ]);
    }
    if (fields.expiryDate && !cat.hasExpiry) {
      throw ApiError.validation([{ path: 'expiryDate', message: 'This category has no expiry date' }]);
    }

    const objectId = uuidv7();
    const objectKey = `${ctx.companyId}/${objectId}`;
    const encrypted = this.encryptor.encrypt(file.buffer, `doc:${objectId}`);
    await storage.put(objectKey, Readable.from([encrypted]), 'application/octet-stream');

    const docId = uuidv7();
    // A leave attachment is written as a trusted system operation: the employee may not write
    // documents (RLS), but the leave module has authorised this upload (audited as the user).
    const write = <T>(fn: (tx: Tx) => Promise<T>) => (opts.forLeave ? this.database.system(fn) : this.database.tx(principal.rls(), fn));
    const result = await write(async (tx) => {
      await tx.insert(storedObject).values({
        id: objectId,
        provider: storage.description.split(':')[0] ?? 'storage',
        objectKey,
        mime: detected.mime,
        sizeBytes: file.buffer.length,
        sha256: sha256(file.buffer),
        encKeyId: this.encryptor.keyId,
        createdBy: principal.userId,
      });
      const [d] = await tx
        .insert(document)
        .values({
          id: docId,
          companyId: ctx.companyId!,
          categoryId: cat.id,
          objectId,
          title: fields.title,
          originalName: safeFileName(file.originalname),
          expiryDate: fields.expiryDate ?? null,
          supersedesId: opts.supersedes?.id ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      await tx.insert(documentLink).values(
        opts.candidate ? { documentId: docId, entityType: 'candidate', entityId: opts.candidate.id } : { documentId: docId, entityType: 'employee', entityId: employeeId },
      );
      if (opts.supersedes) {
        await tx
          .update(document)
          .set({ status: 'superseded', updatedBy: principal.userId })
          .where(eq(document.id, opts.supersedes.id));
      }
      if (cat.code === 'photo' && !opts.candidate) {
        await tx.update(employee).set({ photoDocumentId: docId, updatedBy: principal.userId }).where(eq(employee.id, employeeId));
      }
      await this.audit.record(tx, {
        action: opts.supersedes ? 'documents.replaced' : 'documents.uploaded',
        entityType: 'document',
        entityId: docId,
        companyId: ctx.companyId,
        after: {
          ...(opts.candidate ? { candidateId: opts.candidate.id } : { employeeId }),
          category: cat.code,
          title: fields.title,
          sizeBytes: file.buffer.length,
          mime: detected.mime,
          supersedes: opts.supersedes?.id ?? null,
        },
      });
      return d!;
    });
    return toDocumentDto(result, { mime: detected.mime, sizeBytes: file.buffer.length });
  }

  async replace(principal: Principal, documentId: string, file: UploadedFile | undefined, title?: string) {
    const { d, c, ctx } = await this.loadWithContext(principal, documentId);
    if (!c.allowReplace) throw ApiError.conflict('Documents of this category cannot be replaced');
    if (d.status !== 'active') throw ApiError.conflict('Only active documents can be replaced');
    return this.upload(
      principal,
      ctx.employeeId,
      { categoryId: c.id, title: title || d.title, expiryDate: d.expiryDate ?? undefined },
      file,
      { supersedes: d },
    );
  }

  async setDeleted(principal: Principal, documentId: string, deleted: boolean): Promise<void> {
    const { d, c, ctx } = await this.loadWithContext(principal, documentId);
    if (!ctx.companyId || !principal.canCompany('documents.delete', ctx.companyId)) throw ApiError.forbidden();
    if (!c.allowDelete) throw ApiError.conflict('Documents of this category cannot be deleted');
    if (deleted ? d.status !== 'active' : d.status !== 'deleted') {
      throw ApiError.conflict(deleted ? 'Only active documents can be deleted' : 'The document is not deleted');
    }
    await this.database.tx(principal.rls(), async (tx) => {
      await tx
        .update(document)
        .set(
          deleted
            ? { status: 'deleted', deletedAt: new Date(), deletedBy: principal.userId, updatedBy: principal.userId }
            : { status: 'active', deletedAt: null, deletedBy: null, updatedBy: principal.userId },
        )
        .where(eq(document.id, documentId));
      await this.audit.record(tx, {
        action: deleted ? 'documents.deleted' : 'documents.restored',
        entityType: 'document',
        entityId: documentId,
        companyId: d.companyId,
        details: { category: c.code, employeeId: ctx.employeeId },
      });
    });
  }

  /** The profile photo is visible to everyone who may see the employee. */
  async photo(principal: Principal, employeeId: string) {
    const storage = this.requireStorage();
    const { row } = await this.employees.loadVisible(principal, employeeId);
    if (!row.photoDocumentId) throw ApiError.notFound('Photo');
    const [found] = await this.database.system((tx) =>
      tx
        .select({ o: storedObject, d: document })
        .from(document)
        .innerJoin(storedObject, eq(storedObject.id, document.objectId))
        .where(eq(document.id, row.photoDocumentId!)),
    );
    if (!found || found.d.status === 'deleted') throw ApiError.notFound('Photo');
    const chunks: Buffer[] = [];
    for await (const chunk of await storage.get(found.o.objectKey)) chunks.push(chunk as Buffer);
    const body = this.encryptor.decrypt(Buffer.concat(chunks), `doc:${found.o.id}`);
    return { body, mime: found.o.mime, fileName: 'photo' };
  }

  /** Delete-protection helper for tests and future retention jobs. */
  async objectKeys(ids: string[], tx: Tx): Promise<string[]> {
    if (!ids.length) return [];
    const rows = await tx.select({ k: storedObject.objectKey }).from(storedObject).where(inArray(storedObject.id, ids));
    return rows.map((r) => r.k);
  }

  private requireStorage(): StoragePort {
    if (!this.storage) throw new ApiError(409, 'NOT_CONFIGURED', 'Document storage is not configured');
    return this.storage;
  }
}

function toDocumentDto(d: DocumentRow, o: { mime: string; sizeBytes: number }): DocumentDto {
  return {
    id: d.id,
    companyId: d.companyId,
    categoryId: d.categoryId,
    title: d.title,
    originalName: d.originalName,
    mime: o.mime,
    sizeBytes: o.sizeBytes,
    expiryDate: d.expiryDate,
    status: d.status,
    supersedesId: d.supersedesId,
    createdAt: d.createdAt.toISOString(),
    createdBy: d.createdBy,
  };
}
