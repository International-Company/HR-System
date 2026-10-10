import type { DocumentType } from '@hrms/shared';

/**
 * Upload validation by content, not by the file name alone (security plan §4):
 * the extension must be allowed AND the leading bytes must match that type.
 */
const TYPES: Record<DocumentType, { ext: string[]; mime: string; sniff: (b: Buffer) => boolean }> = {
  pdf: { ext: ['pdf'], mime: 'application/pdf', sniff: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  png: {
    ext: ['png'],
    mime: 'image/png',
    sniff: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  jpg: { ext: ['jpg', 'jpeg'], mime: 'image/jpeg', sniff: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  webp: {
    ext: ['webp'],
    mime: 'image/webp',
    sniff: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  docx: {
    ext: ['docx'],
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sniff: isZip,
  },
  xlsx: {
    ext: ['xlsx'],
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    sniff: isZip,
  },
};

function isZip(b: Buffer): boolean {
  return b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

/** Returns the detected type, or null if the file is not one of the allowed types. */
export function detectType(fileName: string, content: Buffer, allowed: readonly string[]): { type: DocumentType; mime: string } | null {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  for (const t of allowed as DocumentType[]) {
    const def = TYPES[t];
    if (def && def.ext.includes(ext) && def.sniff(content)) return { type: t, mime: def.mime };
  }
  return null;
}

/** File name safe for Content-Disposition (keeps Arabic; strips control and path characters). */
export function safeFileName(name: string): string {
  const cleaned = [...name]
    .map((ch) => (ch.charCodeAt(0) < 32 ? '_' : ch))
    .join('')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
  return cleaned || 'file';
}
