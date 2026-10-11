import { createHash } from 'node:crypto';

/**
 * Contract text rendering (CON-01, CON-02). Templates are plain text (no HTML: the browser
 * shows it escaped, so stored text can never inject markup). Placeholders:
 *   {{employee.nameAr}} …   values from the employee, company and contract
 *   {{field.key}}           values typed when preparing the contract (required or optional)
 *   {{clause.CODE}}         reusable clauses (which may use the placeholders above)
 */

const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9_.-]*)\s*\}\}/g;

export interface RenderInput {
  template: string;
  values: Record<string, string>;
  fields: Record<string, string>;
  /** Field definitions of the template, for required-field checks. */
  fieldDefs: { key: string; required: boolean }[];
  clauses: Record<string, string>;
}

export interface RenderResult {
  text: string;
  /** Placeholders that could not be filled (unknown names, missing required fields or clauses). */
  missing: string[];
}

/** Names used by a template, including those inside its clauses. */
export function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

export function renderContract(input: RenderInput): RenderResult {
  const missing = new Set<string>();
  for (const f of input.fieldDefs) if (f.required && !input.fields[f.key]?.trim()) missing.add(`field.${f.key}`);
  const fill = (text: string, allowClauses: boolean): string =>
    text.replace(PLACEHOLDER, (whole, name: string) => {
      if (name.startsWith('clause.')) {
        const body = allowClauses ? input.clauses[name.slice(7)] : undefined;
        if (body === undefined) {
          missing.add(name);
          return whole;
        }
        return fill(body, false); // clauses cannot nest clauses
      }
      if (name.startsWith('field.')) {
        const v = input.fields[name.slice(6)];
        if (v === undefined || v === '') {
          if (input.fieldDefs.some((f) => f.key === name.slice(6))) return '';
          missing.add(name);
          return whole;
        }
        return v;
      }
      const v = input.values[name];
      if (v === undefined) {
        missing.add(name);
        return whole;
      }
      return v;
    });
  const text = fill(input.template, true)
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, missing: [...missing].sort() };
}

/** Hex sha256 of the exact text shown to signers (UTF-8). */
export function textHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Standard text of an extension (CON-04), in the contract's language. */
export function extensionText(lang: 'ar' | 'en', no: string, from: string | null, to: string, automatic: boolean): string {
  if (lang === 'ar') {
    return [
      `# ${automatic ? 'تجديد تلقائي' : 'ملحق تمديد'} للعقد ${no}`,
      `يُمدَّد العقد رقم ${no}${from ? ` من تاريخ انتهائه ${from}` : ''} حتى ${to}.`,
      'تبقى جميع الشروط والأحكام الأخرى للعقد سارية دون تغيير.',
    ].join('\n\n');
  }
  return [
    `# ${automatic ? 'Automatic renewal' : 'Extension'} of contract ${no}`,
    `Contract ${no} is extended${from ? ` from its end date ${from}` : ''} until ${to}.`,
    'All other terms and conditions of the contract remain unchanged.',
  ].join('\n\n');
}
